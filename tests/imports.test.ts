import test from 'node:test';
import assert from 'node:assert/strict';
import { createResolver, extractImports, parseJsonLoose, type ImportRef } from '../src/imports.js';
import { languageFor } from '../src/parser.js';

/** Resolves every import of every file of an in-memory project: `from -> [targets or external:name]`. */
function resolveAll(files: Record<string, string>, definedNames: Record<string, string[]> = {}): Record<string, string[]> {
  const paths = Object.keys(files).sort();
  const resolve = createResolver({ paths, textOf: path => files[path], definedNames: path => definedNames[path] ?? [] });
  const result: Record<string, string[]> = {};
  for (const path of paths) {
    const language = languageFor(path);
    const out: string[] = [];
    for (const ref of extractImports(language, files[path])) {
      const resolution = resolve(path, language, ref);
      if (resolution.external !== undefined) out.push(`external:${resolution.external}`);
      else out.push(...resolution.files);
    }
    if (out.length) result[path] = out;
  }
  return result;
}

const specs = (language: string, text: string): string[] => extractImports(language, text).map((ref: ImportRef) => ref.spec);

test('JavaScript/TypeScript: relative paths, index files, .js specifiers for .ts sources, externals', () => {
  const edges = resolveAll({
    'src/a.ts': "import { b } from './b.js';\nimport c from './lib';\nimport * as fs from 'node:fs';\nimport x from '@scope/pkg/sub/deep';\nexport * from '../top';\nimport type { T } from './types';",
    'src/b.ts': 'export const b = 1;',
    'src/lib/index.ts': 'export default 1;',
    'src/types.d.ts': 'export type T = 1;',
    'top.js': "const z = require('./src/b');\nconst lazy = () => import('./src/lib/index.js');",
  });
  assert.deepEqual(edges['src/a.ts'], ['src/b.ts', 'src/lib/index.ts', 'external:node:fs', 'external:@scope/pkg', 'top.js', 'src/types.d.ts']);
  assert.deepEqual(edges['top.js'], ['src/b.ts', 'src/lib/index.ts']);
});

test('JavaScript/TypeScript: multi-line imports, comments are ignored, side-effect imports', () => {
  const text = "import {\n  one,\n  two as deux,\n} from './m';\n// import ghost from './ghost';\n * import star from './star';\nimport './side';\n";
  assert.deepEqual(extractImports('typescript', text).map(ref => [ref.spec, ref.line]), [['./m', 1], ['./side', 7]]);
});

test('JavaScript/TypeScript: tsconfig paths, baseUrl and workspace packages', () => {
  const edges = resolveAll({
    'tsconfig.json': '// comment\n{ "compilerOptions": { "baseUrl": ".", "paths": { "@app/*": ["src/app/*",], "~util": ["src/util/index.ts"] } } /* trailing */ }',
    'src/app/button.ts': 'export {}',
    'src/util/index.ts': 'export {}',
    'src/shared/log.ts': 'export {}',
    'src/main.ts': "import b from '@app/button';\nimport u from '~util';\nimport l from 'src/shared/log';\nimport w from '@acme/core';\nimport w2 from '@acme/core/helpers';\nimport e from 'react';",
    'packages/core/package.json': '{ "name": "@acme/core" }',
    'packages/core/src/index.ts': 'export {}',
    'packages/core/src/helpers.ts': 'export {}',
  });
  assert.deepEqual(edges['src/main.ts'], ['src/app/button.ts', 'src/util/index.ts', 'src/shared/log.ts', 'packages/core/src/index.ts', 'packages/core/src/helpers.ts', 'external:react']);
});

test('parseJsonLoose accepts comments and trailing commas but not garbage', () => {
  assert.deepEqual(parseJsonLoose('{ "a": "x//y", /* c */ "b": [1,2,], }'), { a: 'x//y', b: [1, 2] });
  assert.equal(parseJsonLoose('{ nope'), undefined);
});

test('Python: absolute, relative, package and src-layout imports', () => {
  const edges = resolveAll({
    'pkg/__init__.py': '',
    'pkg/core.py': 'import os\nfrom . import helpers\nfrom .util import tool, other\nfrom .. import top_level\nimport pkg.sub.leaf as leaf, json',
    'pkg/helpers.py': '',
    'pkg/util.py': '',
    'pkg/sub/__init__.py': '',
    'pkg/sub/leaf.py': 'from pkg.core import thing\nfrom pkg import sub',
    'top_level.py': '"""\nimport docstring_ghost\n"""\nfrom pkg.util import (\n    tool,\n    other,\n)\n',
    'src/lib/mod.py': 'x = 1',
    'tests/test_mod.py': 'import lib.mod\nimport numpy',
  });
  assert.deepEqual(edges['pkg/core.py'], ['external:os', 'pkg/helpers.py', 'pkg/util.py', 'top_level.py', 'pkg/sub/leaf.py', 'external:json']);
  assert.deepEqual(edges['pkg/sub/leaf.py'], ['pkg/core.py', 'pkg/sub/__init__.py']);
  assert.deepEqual(edges['top_level.py'], ['pkg/util.py']);
  assert.deepEqual(edges['tests/test_mod.py'], ['src/lib/mod.py', 'external:numpy']);
});

test('Python: parenthesised from-imports keep their statement line and names', () => {
  const [ref] = extractImports('python', 'x = 1\nfrom a.b import (\n    c,\n    d as e,\n)\n');
  assert.deepEqual({ spec: ref.spec, line: ref.line, names: ref.names }, { spec: 'a.b', line: 2, names: ['c', 'd'] });
});

test('Go: module path from go.mod, import blocks, aliases, test files and externals', () => {
  const files = {
    'go.mod': 'module example.com/app\n\ngo 1.21\n',
    'main.go': 'package main\n\nimport (\n\t"fmt"\n\tutil "example.com/app/internal/util"\n\t_ "github.com/lib/pq/driver"\n\t"example.com/app/missing"\n)\nimport "example.com/app/internal/util"\n',
    'internal/util/a.go': 'package util',
    'internal/util/b.go': 'package util',
    'internal/util/b_test.go': 'package util',
  };
  const resolve = createResolver({ paths: Object.keys(files), textOf: path => (files as Record<string, string>)[path] });
  const refs = extractImports('go', files['main.go']);
  assert.deepEqual(refs.map(ref => ref.spec), ['fmt', 'example.com/app/internal/util', 'github.com/lib/pq/driver', 'example.com/app/missing', 'example.com/app/internal/util']);
  const resolved = refs.map(ref => resolve('main.go', 'go', ref));
  assert.deepEqual(resolved[0], { files: [], external: 'fmt' });
  assert.deepEqual(resolved[1], { files: ['internal/util/a.go', 'internal/util/b.go'], package: true });
  assert.deepEqual(resolved[2], { files: [], external: 'github.com/lib/pq' });
  assert.deepEqual(resolved[3], { files: [] });
});

test('Java, Kotlin and Scala: package declarations, static, wildcard and brace imports', () => {
  const edges = resolveAll({
    'src/main/java/com/acme/App.java': 'package com.acme;\nimport com.acme.util.Strings;\nimport static com.acme.util.Strings.join;\nimport com.acme.model.*;\nimport java.util.List;\nimport com.acme.util.Strings.Inner;',
    'src/main/java/com/acme/util/Strings.java': 'package com.acme.util;',
    'src/main/java/com/acme/model/User.java': 'package com.acme.model;',
    'src/main/java/com/acme/model/Role.java': 'package com.acme.model;',
    'k/Main.kt': 'package k\nimport com.acme.util.Strings as S\nimport k.helpers.tools\nimport org.junit.Test',
    'k/helpers/Tools.kt': 'package k.helpers\nfun tools() {}',
    's/Main.scala': 'package s\nimport com.acme.model.{User, Role => R}\nimport scala.collection._',
  }, { 'k/helpers/Tools.kt': ['tools'] });
  assert.deepEqual(edges['src/main/java/com/acme/App.java'], [
    'src/main/java/com/acme/util/Strings.java', 'src/main/java/com/acme/util/Strings.java',
    'src/main/java/com/acme/model/Role.java', 'src/main/java/com/acme/model/User.java', 'external:java.util', 'src/main/java/com/acme/util/Strings.java',
  ]);
  assert.deepEqual(edges['k/Main.kt'], ['src/main/java/com/acme/util/Strings.java', 'k/helpers/Tools.kt', 'external:org.junit']);
  assert.deepEqual(edges['s/Main.scala'], ['src/main/java/com/acme/model/User.java', 'src/main/java/com/acme/model/Role.java', 'external:scala.collection']);
});

test('Rust: mod declarations, crate/self/super paths and workspace crates', () => {
  const edges = resolveAll({
    'Cargo.toml': '[workspace]\nmembers = ["core"]',
    'core/Cargo.toml': '[package]\nname = "app-core"\nversion = "0.1.0"',
    'core/src/lib.rs': 'pub mod net;\nmod util;\n',
    'core/src/net/mod.rs': 'use crate::util::helper;\nuse super::util;\nmod client;\nuse self::client::Client;\nuse std::io::{self, Read};',
    'core/src/net/client.rs': 'use crate::net::mod_item::Thing;',
    'core/src/util.rs': 'pub fn helper() {}',
    'cli/Cargo.toml': '[package]\nname = "cli"',
    'cli/src/main.rs': 'use app_core::util::helper;\nuse serde::Serialize;\nuse crate::missing;',
  });
  assert.deepEqual(edges['core/src/lib.rs'], ['core/src/net/mod.rs', 'core/src/util.rs']);
  assert.deepEqual(edges['core/src/net/mod.rs'], ['core/src/util.rs', 'core/src/util.rs', 'core/src/net/client.rs', 'core/src/net/client.rs', 'external:std', 'external:std']);
  assert.deepEqual(edges['core/src/net/client.rs'], ['core/src/net/mod.rs']);
  assert.deepEqual(edges['cli/src/main.rs'], ['core/src/util.rs', 'external:serde', 'cli/src/main.rs']);
});

test('Rust: `use` extraction keeps names that contain "as" and drops aliases', () => {
  assert.deepEqual(specs('rust', 'use a::class as k;\nuse b::{self, has_it as h, c::{d, e}};\nuse {x, y};\nuse std::io::*;\n'), ['a::class', 'b', 'b::has_it', 'b::c', 'x', 'y', 'std::io']);
});

test('C and C++: quoted includes relative to the file, then by path suffix; angle includes stay external', () => {
  const edges = resolveAll({
    'src/engine.c': '#include "engine.h"\n#include "util/log.h"\n#include <stdio.h>\n#include <proj/api.h>\n#  include "../include/shared.h"\n',
    'src/engine.h': '',
    'src/util/log.h': '',
    'include/proj/api.h': '',
    'include/shared.h': '',
    'lib/other/log.h': '',
  });
  assert.deepEqual(edges['src/engine.c'], ['src/engine.h', 'src/util/log.h', 'external:stdio.h', 'include/proj/api.h', 'include/shared.h']);
});

test('C#: using directives resolve to the files that declare the namespace', () => {
  const edges = resolveAll({
    'App/Program.cs': 'using System;\nusing Acme.Models;\nusing static Acme.Util.Strings;\nusing Alias = Acme.Models;\nusing (var x = new Y()) { }',
    'Models/User.cs': 'namespace Acme.Models\n{ class User {} }',
    'Util/Strings.cs': 'namespace Acme.Util;\nstatic class Strings {}',
  });
  assert.deepEqual(edges['App/Program.cs'], ['external:System', 'Models/User.cs', 'Util/Strings.cs', 'Models/User.cs']);
});

test('Ruby and PHP: require_relative, require by load path, namespaced use', () => {
  const edges = resolveAll({
    'lib/app.rb': "require_relative 'app/version'\nrequire 'app/helper'\nrequire 'json'\nload './tasks.rb'",
    'lib/app/version.rb': '',
    'lib/app/helper.rb': '',
    'lib/tasks.rb': '',
    'src/Controller/Home.php': "<?php\nuse App\\Models\\User;\nuse App\\Models\\{Post, Tag as T};\nuse Vendor\\Lib\\Thing;\nrequire_once __DIR__ . '/../boot.php';",
    'src/Models/User.php': '',
    'src/Models/Post.php': '',
    'src/Models/Tag.php': '',
    'src/boot.php': '',
  });
  assert.deepEqual(edges['lib/app.rb'], ['lib/app/version.rb', 'lib/app/helper.rb', 'external:json', 'lib/tasks.rb']);
  assert.deepEqual(edges['src/Controller/Home.php'], ['src/Models/User.php', 'src/Models/Post.php', 'src/Models/Tag.php', 'external:Vendor', 'src/boot.php']);
});

test('adversarial input: CRLF, unicode paths, huge lines and ReDoS-style strings stay fast and bounded', () => {
  assert.deepEqual(specs('typescript', "import a from './a';\r\nimport b from './b';\r\n"), ['./a', './b']);
  assert.deepEqual(specs('python', 'import os\r\nfrom .x import y\r\n'), ['os', '.x']);
  assert.deepEqual(specs('java', 'import a.b.C;\r\nimport d.E;\r\n'), ['a.b.C', 'd.E']);
  const unicode = resolveAll({ 'src/データ.ts': "import './ünï.js'", 'src/ünï.ts': '' });
  assert.deepEqual(unicode['src/データ.ts'], ['src/ünï.ts']);

  const attacks = [
    'import ' + 'a '.repeat(200_000),
    'export ' + 'x, '.repeat(100_000) + 'from',
    "import {" + 'a,'.repeat(100_000),
    'from ' + '.'.repeat(100_000) + ' import x',
    'import ' + 'a.'.repeat(100_000),
    '#include "' + 'x'.repeat(300_000),
    'x'.repeat(2_000_000),
    ('import x from "y"; ').repeat(50_000),
  ];
  for (const language of ['typescript', 'python', 'java', 'c', 'rust', 'go', 'php', 'ruby', 'c_sharp']) {
    for (const attack of attacks) {
      const started = performance.now();
      const refs = extractImports(language, attack);
      assert(refs.length <= 4000, `${language}: ${refs.length} refs`);
      assert(performance.now() - started < 2000, `${language} took ${performance.now() - started} ms`);
    }
  }
  const binary = String.fromCharCode(...Array.from({ length: 4000 }, (_, i) => (i * 37) % 256));
  assert.doesNotThrow(() => extractImports('typescript', binary));
});

test('imports that leave the repository root are never resolved to a file', () => {
  const edges = resolveAll({ 'a.ts': "import x from '../../outside';\nimport y from './sub/../../../x'" });
  assert.deepEqual(edges, {});
});
