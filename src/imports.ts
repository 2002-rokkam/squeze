/**
 * Import extraction and resolution for the code graph.
 *
 * `extractImports` finds the import statements of one file with line-oriented / bounded regular expressions (no parser,
 * so a statement inside a string or a block comment can be a false positive; full-line comments are skipped).
 * `createResolver` turns an import into repository files using each language's own lookup rules. An import that cannot
 * be mapped to a file of the snapshot is reported as external (a package name), never invented as a file.
 */

export interface ImportRef {
  /** Module specifier as written: a path, a dotted name, an include or a use path. */
  spec: string;
  /** One-based line of the statement. */
  line: number;
  /** Names imported by a Python `from x import a, b` statement. */
  names?: string[];
  /** Java/Kotlin/Scala/C# import of a whole package or namespace. */
  wildcard?: boolean;
  /** C/C++ `#include <...>`. */
  angle?: boolean;
  /** Rust `mod name;` declaration (resolved relative to the declaring file). */
  declaration?: boolean;
  /** PHP/Ruby/Zig/Solidity file include, resolved relative to the importing file. */
  relative?: boolean;
}

export interface Resolution {
  /** Repository files the import points at (sorted). Empty when the import is external or unresolved. */
  files: string[];
  /** The import names a package or namespace (Go, Java wildcard, C#): the file list is every candidate, not one fact. */
  package?: boolean;
  /** Package name when the import leaves the repository. */
  external?: string;
}

export interface ResolverContext {
  paths: readonly string[];
  /** Text of a repository file (needed for go.mod, tsconfig.json, package declarations); undefined when unavailable. */
  textOf(path: string): string | undefined;
  /** Names of the top-level definitions of a file (used for Kotlin/Scala/Java package members). */
  definedNames?(path: string): readonly string[];
}

const MAX_TEXT = 512 * 1024;
const MAX_IMPORTS = 2000;
export const MAX_PACKAGE_FILES = 6;

// ---------------------------------------------------------------------------------------------------------------
// Extraction

/** Maps an ascending sequence of character offsets to one-based line numbers. */
function lineLocator(text: string): (offset: number) => number {
  let newlines: number[] | undefined;
  return offset => {
    if (!newlines) {
      newlines = [];
      for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) newlines.push(i);
    }
    let low = 0;
    let high = newlines.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (newlines[mid] < offset) low = mid + 1; else high = mid;
    }
    return low + 1;
  };
}

const lineBefore = (text: string, offset: number): string => text.slice(text.lastIndexOf('\n', offset - 1) + 1, offset);
const inLineComment = (text: string, offset: number, markers: RegExp): boolean => markers.test(lineBefore(text, offset));

const JS_IMPORT = /(?:^|[;{}\s])(?:import|export)\s+(?:type\s+)?(?:[\w$*{}\s,]{0,600}?\s)?from\s*(['"])([^'"\n]{1,300})\1|(?:^|[;{}\s])import\s*(['"])([^'"\n]{1,300})\3|\b(?:require|import)\s*\(\s*(['"])([^'"\n]{1,300})\5\s*\)/gm;

function extractJs(text: string): ImportRef[] {
  const out: ImportRef[] = [];
  const locate = lineLocator(text);
  for (const match of text.matchAll(JS_IMPORT)) {
    const spec = match[2] ?? match[4] ?? match[6];
    const offset = match.index! + match[0].search(/\S/);
    if (inLineComment(text, offset, /(?:\/\/|^\s*\*|\/\*)/)) continue;
    out.push({ spec, line: locate(offset) });
    if (out.length >= MAX_IMPORTS) break;
  }
  return out;
}

function extractPython(text: string): ImportRef[] {
  const out: ImportRef[] = [];
  const lines = text.split('\n');
  let inDocstring = false;
  for (let i = 0; i < lines.length && out.length < MAX_IMPORTS; i++) {
    const raw = lines[i].replace(/\r$/, '');
    const quotes = (raw.match(/"""|'''/g) ?? []).length;
    if (inDocstring) { if (quotes % 2 === 1) inDocstring = false; continue; }
    if (quotes % 2 === 1) { inDocstring = true; continue; }
    if (raw.length > 2000) continue;
    const from = /^[ \t]*from[ \t]+(\.*[\w.]*)[ \t]+import[ \t]+(.*)$/.exec(raw);
    if (from) {
      let rest = from[2].replace(/#.*$/, '');
      for (let j = i + 1; rest.includes('(') && !rest.includes(')') && j < Math.min(lines.length, i + 200); j++) rest += ` ${lines[j].replace(/#.*$/, '')}`;
      const names = rest.replace(/[()\\]/g, ' ').split(',').map(part => part.trim().split(/\s+/)[0]).filter(name => /^(?:\w+|\*)$/.test(name));
      out.push({ spec: from[1], line: i + 1, names });
      continue;
    }
    const plain = /^[ \t]*import[ \t]+([\w.]+(?:[ \t]+as[ \t]+\w+)?(?:[ \t]*,[ \t]*[\w.]+(?:[ \t]+as[ \t]+\w+)?)*)/.exec(raw);
    if (plain) for (const part of plain[1].split(',')) out.push({ spec: part.trim().split(/\s+/)[0], line: i + 1 });
  }
  return out;
}

function extractGo(text: string): ImportRef[] {
  const out: ImportRef[] = [];
  const locate = lineLocator(text);
  for (const block of text.matchAll(/^import\s*\(([^)]{0,20000})\)|^import\s+(?:[\w.]+\s+)?"([^"\n]+)"/gm)) {
    if (block[2]) { out.push({ spec: block[2], line: locate(block.index!) }); continue; }
    const start = block.index! + block[0].indexOf('(') + 1;
    for (const item of block[1].matchAll(/^[ \t]*(?:[\w.]+[ \t]+)?"([^"\n]+)"/gm)) out.push({ spec: item[1], line: locate(start + item.index!) });
  }
  return out.slice(0, MAX_IMPORTS);
}

/** Java, Kotlin and Scala: one `import` statement per line; Scala may list several names in braces. */
function extractJvm(text: string, language: string): ImportRef[] {
  const out: ImportRef[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length && out.length < MAX_IMPORTS; i++) {
    const match = /^[ \t]*import[ \t]+(?:static[ \t]+)?([\w.${},=> _*]+?)[ \t]*;?[ \t]*(?:\/\/.*)?\r?$/.exec(lines[i]);
    if (!match) continue;
    const spec = match[1].replace(/\s+as\s+\w+$/, '');
    const braces = /^([\w.]+)\.\{(.*)\}$/.exec(spec);
    if (braces && language === 'scala') {
      for (const item of braces[2].split(',')) {
        const name = item.split('=>')[0].trim();
        if (/^\w+$/.test(name)) out.push({ spec: `${braces[1]}.${name}`, line: i + 1 });
        else if (name === '_') out.push({ spec: braces[1], line: i + 1, wildcard: true });
      }
    } else if (/\.(?:\*|_)$/.test(spec)) out.push({ spec: spec.slice(0, -2), line: i + 1, wildcard: true });
    else if (/^[\w.]+$/.test(spec)) out.push({ spec, line: i + 1 });
  }
  return out;
}

function extractRust(text: string): ImportRef[] {
  const out: ImportRef[] = [];
  const locate = lineLocator(text);
  for (const match of text.matchAll(/^[ \t]*(?:pub(?:\([\w: ]+\))?[ \t]+)?(?:mod[ \t]+(\w+)[ \t]*;|use[ \t]+([^;]{1,2000});)/gm)) {
    const line = locate(match.index!);
    if (match[1]) { out.push({ spec: match[1], line, declaration: true }); continue; }
    const path = match[2].replace(/\s+/g, '');
    const brace = path.indexOf('{');
    if (brace < 0) { out.push({ spec: path.replace(/::\*$/, '').replace(/as\w+$/, ''), line }); continue; }
    const prefix = path.slice(0, brace).replace(/::$/, '');
    let depth = 0;
    let item = '';
    const items: string[] = [];
    for (const ch of path.slice(brace + 1, path.lastIndexOf('}'))) {
      if (ch === '{') depth++;
      if (ch === '}') depth--;
      if (ch === ',' && depth === 0) { items.push(item); item = ''; } else item += ch;
    }
    items.push(item);
    out.push({ spec: prefix, line });
    for (const entry of items) {
      const name = entry.split('{')[0].replace(/::$/, '').replace(/as\w+$/, '');
      if (/^\w+(?:::\w+)*$/.test(name) && name !== 'self') out.push({ spec: `${prefix}::${name}`, line });
    }
  }
  return out.slice(0, MAX_IMPORTS);
}

function extractInclude(text: string): ImportRef[] {
  const out: ImportRef[] = [];
  const locate = lineLocator(text);
  for (const match of text.matchAll(/^[ \t]*#[ \t]*(?:include|import)[ \t]*(?:"([^"\n]+)"|<([^>\n]+)>)/gm)) {
    out.push({ spec: match[1] ?? match[2], line: locate(match.index!), angle: match[2] !== undefined });
    if (out.length >= MAX_IMPORTS) break;
  }
  return out;
}

function extractCSharp(text: string): ImportRef[] {
  const out: ImportRef[] = [];
  const locate = lineLocator(text);
  for (const match of text.matchAll(/^[ \t]*(?:global[ \t]+)?using[ \t]+(?:static[ \t]+)?(?:\w+[ \t]*=[ \t]*)?([A-Za-z_][\w.]*)[ \t]*;/gm)) {
    out.push({ spec: match[1], line: locate(match.index!), wildcard: true });
    if (out.length >= MAX_IMPORTS) break;
  }
  return out;
}

function extractRuby(text: string): ImportRef[] {
  const out: ImportRef[] = [];
  const locate = lineLocator(text);
  for (const match of text.matchAll(/^[ \t]*(require_relative|require|load|autoload[ \t]+:\w+,)[ \t(]*['"]([^'"\n]+)['"]/gm)) {
    out.push({ spec: match[2], line: locate(match.index!), relative: match[1] === 'require_relative' || (match[1] === 'load' && match[2].startsWith('.')) });
    if (out.length >= MAX_IMPORTS) break;
  }
  return out;
}

function extractPhp(text: string): ImportRef[] {
  const out: ImportRef[] = [];
  const locate = lineLocator(text);
  for (const match of text.matchAll(/^[ \t]*use[ \t]+(?:function[ \t]+|const[ \t]+)?\\?([\w\\]+?)(?:\\\{([^}]{1,2000})\})?(?:[ \t]+as[ \t]+\w+)?[ \t]*;/gm)) {
    const line = locate(match.index!);
    if (match[2]) for (const item of match[2].split(',')) out.push({ spec: `${match[1]}\\${item.trim().split(/\s+/)[0]}`, line });
    else out.push({ spec: match[1], line });
  }
  for (const match of text.matchAll(/\b(?:require|include)(?:_once)?[ \t(]*(?:__DIR__[ \t]*\.[ \t]*)?['"]([^'"\n]+\.php)['"]/g)) out.push({ spec: match[1], line: locate(match.index!), relative: true });
  return out.slice(0, MAX_IMPORTS);
}

function extractRelativeOnly(text: string, pattern: RegExp): ImportRef[] {
  const out: ImportRef[] = [];
  const locate = lineLocator(text);
  for (const match of text.matchAll(pattern)) {
    out.push({ spec: match[1], line: locate(match.index!), relative: true });
    if (out.length >= MAX_IMPORTS) break;
  }
  return out;
}

/** Import statements of one file, in source order. Languages without import support return an empty list. */
export function extractImports(language: string, text: string): ImportRef[] {
  if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT);
  switch (language) {
    case 'javascript': case 'typescript': case 'tsx': return extractJs(text);
    case 'python': return extractPython(text);
    case 'go': return extractGo(text);
    case 'java': case 'kotlin': case 'scala': return extractJvm(text, language);
    case 'rust': return extractRust(text);
    case 'c': case 'cpp': case 'objc': return extractInclude(text);
    case 'c_sharp': return extractCSharp(text);
    case 'ruby': return extractRuby(text);
    case 'php': return extractPhp(text);
    case 'solidity': return extractRelativeOnly(text, /^[ \t]*import[ \t]+(?:[^'"\n;]*?from[ \t]+)?['"]([^'"\n]+)['"]/gm);
    case 'zig': return extractRelativeOnly(text, /@import\("([^"\n]+\.zig)"\)/g);
    default: return [];
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Resolution

const dirOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/')));
const baseOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const stemOf = (path: string) => baseOf(path).replace(/\.[^.]*$/, '');
const joinDir = (dir: string, rest: string) => (dir ? `${dir}/${rest}` : rest);

/** Joins and normalises a relative specifier; undefined when it leaves the repository root. */
function normalizeFrom(dir: string, spec: string): string | undefined {
  const parts = dir ? dir.split('/') : [];
  for (const part of spec.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') { if (!parts.length) return undefined; parts.pop(); } else parts.push(part);
  }
  return parts.join('/');
}

const commonPrefix = (a: string, b: string): number => {
  const left = a.split('/');
  const right = b.split('/');
  let n = 0;
  while (n < left.length - 1 && n < right.length - 1 && left[n] === right[n]) n++;
  return n;
};

/** The candidate closest to the importing file (longest shared directory prefix, then shortest, then alphabetical). */
function nearest(from: string, candidates: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestShared = -1;
  for (const candidate of candidates) {
    const shared = commonPrefix(from, candidate);
    if (shared > bestShared || (shared === bestShared && (candidate.length < best!.length || (candidate.length === best!.length && candidate < best!)))) {
      best = candidate;
      bestShared = shared;
    }
  }
  return best;
}

const unique = (files: readonly string[]) => [...new Set(files)].sort();
const ancestors = (dir: string): string[] => {
  const out: string[] = [];
  for (let current = dir; ; current = dirOf(current)) {
    out.push(current);
    if (!current) break;
  }
  return out;
};

/** Strips comments and trailing commas so that tsconfig.json (JSON with comments) can be parsed. */
export function parseJsonLoose(text: string): unknown {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 1;
    } else out += ch;
  }
  try { return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1')); } catch { return undefined; }
}

interface TsConfig { dir: string; baseUrl?: string; paths: { prefix: string; suffix: string; wildcard: boolean; targets: string[] }[] }

const JS_EXTENSIONS = ['.ts', '.tsx', '.d.ts', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.json'];
const JS_SWAP: Record<string, string[]> = { '.js': ['.ts', '.tsx', '.d.ts'], '.jsx': ['.tsx'], '.mjs': ['.mts', '.d.mts'], '.cjs': ['.cts', '.d.cts'] };
const NODE_BUILTINS = new Set('assert async_hooks buffer child_process cluster console constants crypto dgram diagnostics_channel dns domain events fs http http2 https inspector module net os path perf_hooks process punycode querystring readline repl stream string_decoder sys timers tls trace_events tty url util v8 vm wasi worker_threads zlib'.split(' '));

export function createResolver(context: ResolverContext): (from: string, language: string, ref: ImportRef) => Resolution {
  const pathSet = new Set(context.paths);
  const has = (path: string | undefined): path is string => path !== undefined && pathSet.has(path);
  const directories = new Map<string, string[]>();
  const byBase = new Map<string, string[]>();
  for (const path of context.paths) {
    const dir = dirOf(path);
    const files = directories.get(dir);
    if (files) files.push(path); else directories.set(dir, [path]);
    const base = baseOf(path);
    const same = byBase.get(base);
    if (same) same.push(path); else byBase.set(base, [path]);
  }
  const lazy = <T>(make: () => T): (() => T) => { let value: T | undefined; return () => (value ??= make()); };
  const pathsNamed = (name: string) => context.paths.filter(path => baseOf(path) === name);

  // ---- JavaScript / TypeScript
  const tsconfigs = lazy(() => {
    const configs = new Map<string, TsConfig>();
    for (const path of [...pathsNamed('tsconfig.json'), ...pathsNamed('jsconfig.json')]) {
      const text = context.textOf(path);
      const json = text ? parseJsonLoose(text) as { compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } } | undefined : undefined;
      const options = json?.compilerOptions;
      if (!options) continue;
      const dir = dirOf(path);
      const baseUrl = options.baseUrl ? normalizeFrom(dir, options.baseUrl) : undefined;
      const paths = Object.entries(options.paths ?? {}).filter(([, targets]) => Array.isArray(targets)).map(([pattern, targets]) => {
        const star = pattern.indexOf('*');
        return { prefix: star < 0 ? pattern : pattern.slice(0, star), suffix: star < 0 ? '' : pattern.slice(star + 1), wildcard: star >= 0, targets };
      });
      if (!configs.has(dir) || baseOf(path) === 'tsconfig.json') configs.set(dir, { dir, baseUrl, paths });
    }
    return configs;
  });
  const workspacePackages = lazy(() => {
    const packages = new Map<string, string>();
    for (const path of pathsNamed('package.json')) {
      const name = /"name"\s*:\s*"([^"]+)"/.exec(context.textOf(path) ?? '')?.[1];
      if (name && !packages.has(name)) packages.set(name, dirOf(path));
    }
    return packages;
  });
  const jsFile = (base: string | undefined): string | undefined => {
    if (base === undefined) return undefined;
    const ext = /\.(?:jsx?|mjs|cjs)$/.exec(base)?.[0];
    if (ext) for (const swap of JS_SWAP[ext]) if (has(base.slice(0, -ext.length) + swap)) return base.slice(0, -ext.length) + swap;
    if (has(base) && /\.\w+$/.test(baseOf(base))) return base;
    for (const extension of JS_EXTENSIONS) if (has(base + extension)) return base + extension;
    for (const extension of JS_EXTENSIONS) if (has(`${base}/index${extension}`)) return `${base}/index${extension}`;
    return undefined;
  };
  const jsExternal = (spec: string): string => {
    if (spec.startsWith('node:')) return spec;
    const parts = spec.split('/');
    return spec.startsWith('@') ? parts.slice(0, 2).join('/') : NODE_BUILTINS.has(parts[0]) ? `node:${parts[0]}` : parts[0];
  };
  const resolveJs = (from: string, spec: string): Resolution => {
    if (spec.startsWith('.')) {
      const target = jsFile(normalizeFrom(dirOf(from), spec));
      return target ? { files: [target] } : { files: [] };
    }
    for (const dir of ancestors(dirOf(from))) {
      const config = tsconfigs().get(dir);
      if (!config) continue;
      for (const entry of config.paths) {
        if (!spec.startsWith(entry.prefix) || !spec.endsWith(entry.suffix) || (!entry.wildcard && spec !== entry.prefix)) continue;
        const middle = entry.wildcard ? spec.slice(entry.prefix.length, spec.length - entry.suffix.length) : '';
        for (const target of entry.targets) {
          const found = jsFile(normalizeFrom(config.baseUrl ?? config.dir, target.replace('*', middle)));
          if (found) return { files: [found] };
        }
      }
      if (config.baseUrl !== undefined) {
        const found = jsFile(normalizeFrom(config.baseUrl, spec));
        if (found) return { files: [found] };
      }
      break;
    }
    const parts = spec.split('/');
    const scoped = spec.startsWith('@');
    const name = parts.slice(0, scoped ? 2 : 1).join('/');
    const workspace = workspacePackages().get(name);
    if (workspace !== undefined) {
      const sub = parts.slice(scoped ? 2 : 1).join('/');
      const found = sub
        ? jsFile(joinDir(workspace, sub)) ?? jsFile(joinDir(workspace, `src/${sub}`))
        : jsFile(joinDir(workspace, 'src/index')) ?? jsFile(joinDir(workspace, 'index')) ?? jsFile(joinDir(workspace, 'lib/index'));
      if (found) return { files: [found] };
    }
    return { files: [], external: jsExternal(spec) };
  };

  // ---- Python
  const resolvePython = (from: string, ref: ImportRef): Resolution => {
    const dots = /^\.*/.exec(ref.spec)![0].length;
    const dotted = ref.spec.slice(dots).replace(/\./g, '/');
    const bases: string[] = [];
    if (dots > 0) {
      let dir = dirOf(from);
      for (let i = 1; i < dots; i++) dir = dirOf(dir);
      bases.push(dir);
    } else {
      bases.push(...ancestors(dirOf(from)), 'src', 'lib');
    }
    for (const base of unique(bases)) {
      const modulePath = dotted ? joinDir(base, dotted) : base;
      const moduleFile = dotted
        ? [`${modulePath}.py`, `${modulePath}/__init__.py`, `${modulePath}.pyi`].find(has)
        : has(joinDir(base, '__init__.py')) ? joinDir(base, '__init__.py') : undefined;
      const submodules: string[] = [];
      for (const name of ref.names ?? []) {
        if (name === '*') continue;
        const sub = [`${joinDir(modulePath, name)}.py`, `${joinDir(modulePath, name)}/__init__.py`].find(has);
        if (sub) submodules.push(sub);
      }
      if (submodules.length) return { files: unique(submodules) };
      if (moduleFile) return { files: [moduleFile] };
      if (dots > 0 && !dotted && has(`${base}/__init__.py`)) return { files: [`${base}/__init__.py`] };
    }
    return dots > 0 ? { files: [] } : { files: [], external: ref.spec.split('.')[0] };
  };

  // ---- Go
  const goModules = lazy(() => {
    const modules: { dir: string; module: string }[] = [];
    for (const path of pathsNamed('go.mod')) {
      const module = /^module\s+("?)([^\s"]+)\1/m.exec(context.textOf(path) ?? '')?.[2];
      if (module) modules.push({ dir: dirOf(path), module });
    }
    return modules.sort((a, b) => b.module.length - a.module.length);
  });
  const resolveGo = (spec: string): Resolution => {
    for (const { dir, module } of goModules()) {
      if (spec !== module && !spec.startsWith(`${module}/`)) continue;
      const target = joinDir(dir, spec.slice(module.length + 1));
      const files = (directories.get(target) ?? []).filter(file => file.endsWith('.go') && !file.endsWith('_test.go'));
      return files.length ? { files: unique(files), package: true } : { files: [] };
    }
    const parts = spec.split('/');
    return { files: [], external: parts[0].includes('.') ? parts.slice(0, 3).join('/') : spec };
  };

  // ---- Java / Kotlin / Scala: fully qualified names
  const jvmIndex = lazy(() => {
    const byName = new Map<string, string[]>();
    const byPackage = new Map<string, string[]>();
    const add = (map: Map<string, string[]>, key: string, path: string) => {
      const list = map.get(key);
      if (list) { if (!list.includes(path)) list.push(path); } else map.set(key, [path]);
    };
    for (const path of context.paths) {
      if (!/\.(?:java|kt|kts|scala|sc)$/.test(path)) continue;
      const text = context.textOf(path);
      const pkg = text ? /^[ \t]*package[ \t]+([\w.]+)/m.exec(text)?.[1] : undefined;
      if (pkg === undefined) continue;
      add(byPackage, pkg, path);
      add(byName, `${pkg}.${stemOf(path)}`, path);
      for (const name of context.definedNames?.(path) ?? []) add(byName, `${pkg}.${name}`, path);
    }
    return { byName, byPackage };
  });
  const resolveJvm = (from: string, ref: ImportRef): Resolution => {
    const { byName, byPackage } = jvmIndex();
    if (ref.wildcard) {
      const files = byPackage.get(ref.spec) ?? byName.get(ref.spec);
      if (files?.length) return { files: unique(files), package: true };
    } else {
      const parts = ref.spec.split('.');
      for (let n = parts.length; n >= 2; n--) {
        const files = byName.get(parts.slice(0, n).join('.'));
        if (files?.length) return { files: [nearest(from, files)!] };
      }
    }
    return { files: [], external: ref.spec.split('.').slice(0, 2).join('.') };
  };

  // ---- Rust
  const crates = lazy(() => {
    const map = new Map<string, string>();
    for (const path of pathsNamed('Cargo.toml')) {
      const name = /^\[package\][^[]*?^name\s*=\s*"([^"]+)"/ms.exec(context.textOf(path) ?? '')?.[1];
      if (name) map.set(name.replace(/-/g, '_'), dirOf(path));
    }
    return map;
  });
  const rustModuleDir = (file: string): string => (/^(?:mod|lib|main)\.rs$/.test(baseOf(file)) ? dirOf(file) : joinDir(dirOf(file), stemOf(file)));
  const rustCrateRoot = (file: string): string | undefined => ancestors(dirOf(file)).find(dir => has(joinDir(dir, 'lib.rs')) || has(joinDir(dir, 'main.rs')));
  const rustWalk = (start: string, segments: readonly string[]): string | undefined => {
    let dir = start;
    let last: string | undefined;
    for (const segment of segments) {
      const file = [`${joinDir(dir, segment)}.rs`, `${joinDir(dir, segment)}/mod.rs`].find(has);
      if (file) last = file;
      else if (!directories.has(joinDir(dir, segment))) break;
      dir = joinDir(dir, segment);
    }
    return last;
  };
  const resolveRust = (from: string, ref: ImportRef): Resolution => {
    if (ref.declaration) {
      const dir = rustModuleDir(from);
      const file = [`${joinDir(dir, ref.spec)}.rs`, `${joinDir(dir, ref.spec)}/mod.rs`].find(has);
      return { files: file ? [file] : [] };
    }
    const segments = ref.spec.split('::').filter(Boolean);
    const [first, ...rest] = segments;
    const moduleDir = rustModuleDir(from);
    let found: string | undefined;
    if (first === 'crate') {
      const root = rustCrateRoot(from);
      found = root === undefined ? undefined : rustWalk(root, rest) ?? [joinDir(root, 'lib.rs'), joinDir(root, 'main.rs')].find(has);
    } else if (first === 'self') found = rustWalk(moduleDir, rest);
    else if (first === 'super') {
      let dir = dirOf(moduleDir);
      let tail = rest;
      while (tail[0] === 'super') { dir = dirOf(dir); tail = tail.slice(1); }
      found = rustWalk(dir, tail) ?? [`${dir}.rs`, joinDir(dir, 'mod.rs')].find(has);
    } else {
      const crate = crates().get(first);
      if (crate !== undefined) found = rustWalk(joinDir(crate, 'src'), rest) ?? [joinDir(crate, 'src/lib.rs')].find(has);
      else {
        const root = rustCrateRoot(from);
        found = rustWalk(moduleDir, segments) ?? (root === undefined ? undefined : rustWalk(root, segments));
      }
    }
    if (found && found !== from) return { files: [found] };
    return found || first === 'crate' || first === 'self' || first === 'super' ? { files: [] } : { files: [], external: first };
  };

  // ---- C / C++ / Objective-C
  const resolveInclude = (from: string, ref: ImportRef): Resolution => {
    if (!ref.angle) {
      const local = normalizeFrom(dirOf(from), ref.spec);
      if (has(local)) return { files: [local] };
    }
    const base = baseOf(ref.spec);
    const matches = (byBase.get(base) ?? []).filter(path => path === ref.spec || path.endsWith(`/${ref.spec.replace(/^(?:\.\.?\/)+/, '')}`));
    const chosen = nearest(from, matches);
    return chosen ? { files: [chosen] } : { files: [], external: ref.spec };
  };

  // ---- C#
  const namespaces = lazy(() => {
    const map = new Map<string, string[]>();
    for (const path of context.paths) {
      if (!path.endsWith('.cs')) continue;
      for (const match of (context.textOf(path) ?? '').matchAll(/^[ \t]*namespace[ \t]+([A-Za-z_][\w.]*)/gm)) {
        const list = map.get(match[1]);
        if (list) { if (!list.includes(path)) list.push(path); } else map.set(match[1], [path]);
      }
    }
    return map;
  });
  const resolveCSharp = (ref: ImportRef): Resolution => {
    const parts = ref.spec.split('.');
    for (let n = parts.length; n >= 1; n--) {
      const files = namespaces().get(parts.slice(0, n).join('.'));
      if (files?.length) return { files: unique(files), package: true };
    }
    return { files: [], external: parts[0] };
  };

  // ---- Ruby, PHP, Solidity, Zig
  const resolveRuby = (from: string, ref: ImportRef): Resolution => {
    const spec = ref.spec.replace(/\.rb$/, '');
    if (ref.relative) {
      const target = normalizeFrom(dirOf(from), spec);
      return { files: has(target && `${target}.rb`) ? [`${target}.rb`] : [] };
    }
    const wanted = `${spec}.rb`;
    const matches = (byBase.get(baseOf(wanted)) ?? []).filter(path => path === wanted || path.endsWith(`/${wanted}`));
    const chosen = nearest(from, matches);
    return chosen ? { files: [chosen] } : { files: [], external: spec.split('/')[0] };
  };
  const resolvePhp = (from: string, ref: ImportRef): Resolution => {
    if (ref.relative) {
      const target = normalizeFrom(dirOf(from), ref.spec.replace(/^\.?\//, ''));
      return { files: has(target) ? [target] : [] };
    }
    const segments = ref.spec.split('\\').filter(Boolean);
    for (let skip = 0; skip < segments.length; skip++) {
      const wanted = `${segments.slice(skip).join('/')}.php`;
      const matches = (byBase.get(baseOf(wanted)) ?? []).filter(path => path === wanted || path.endsWith(`/${wanted}`));
      const chosen = nearest(from, matches);
      if (chosen) return { files: [chosen] };
    }
    return { files: [], external: segments[0] ?? ref.spec };
  };
  const resolveRelativeFile = (from: string, ref: ImportRef): Resolution => {
    const target = normalizeFrom(dirOf(from), ref.spec);
    return has(target) ? { files: [target] } : { files: [] };
  };

  return (from, language, ref) => {
    switch (language) {
      case 'javascript': case 'typescript': case 'tsx': return resolveJs(from, ref.spec);
      case 'python': return resolvePython(from, ref);
      case 'go': return resolveGo(ref.spec);
      case 'java': case 'kotlin': case 'scala': return resolveJvm(from, ref);
      case 'rust': return resolveRust(from, ref);
      case 'c': case 'cpp': case 'objc': return resolveInclude(from, ref);
      case 'c_sharp': return resolveCSharp(ref);
      case 'ruby': return resolveRuby(from, ref);
      case 'php': return resolvePhp(from, ref);
      case 'solidity': return ref.spec.startsWith('.') ? resolveRelativeFile(from, ref) : { files: [], external: ref.spec.split('/')[0] };
      case 'zig': return resolveRelativeFile(from, ref);
      default: return { files: [] };
    }
  };
}
