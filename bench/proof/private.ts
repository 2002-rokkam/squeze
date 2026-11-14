/**
 * Guards for the private repository run. The harness must leave the repository exactly as it found it, and an aggregate
 * report must not contain paths, folder names, or the repository root.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Read-only git flags: never take optional locks, never refresh the index, never run fsmonitor hooks. */
const READ_ONLY = ['--no-pager', '--no-optional-locks', '--no-replace-objects', '-c', 'core.fsmonitor=false'];

async function git(root: string, args: string[]): Promise<Buffer> {
  const { stdout } = await run('git', [...READ_ONLY, '-C', root, ...args], {
    encoding: 'buffer',
    maxBuffer: 256 * 1024 * 1024,
  });
  return stdout;
}

export async function listedPaths(root: string): Promise<string[]> {
  return (await git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']))
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .sort();
}

/** Hashes HEAD, status, the listed files' stat stamps, and the index stamp. Equal before and after means nothing changed. */
export async function fingerprint(root: string): Promise<string> {
  const hash = createHash('sha256');
  hash.update(await git(root, ['rev-parse', 'HEAD']));
  hash.update(await git(root, ['status', '--porcelain=v1', '-z', '--ignored']));
  for (const path of await listedPaths(root)) {
    const stat = await lstat(join(root, path)).catch(() => null);
    const stamp = stat ? [stat.size, stat.mode, stat.mtimeMs, stat.ctimeMs, stat.ino].join(':') : 'missing';
    hash.update(`${path}\0${stamp}\n`);
  }
  const index = await lstat(join(root, '.git', 'index')).catch(() => null);
  hash.update(index ? `index:${index.size}:${index.mtimeMs}:${index.ino}` : 'index:none');
  return hash.digest('hex');
}

/** Terms that identify a private repository: its root, its folder name, top-level folders, and long relative paths. */
export function sensitiveTerms(root: string, paths: string[]): string[] {
  const terms = new Set<string>([root, basename(root)]);
  for (const path of paths) {
    const top = path.split('/')[0];
    if (path.includes('/')) {
      terms.add(top);
      if (path.length >= 8) terms.add(path);
    }
  }
  return [...terms].filter(term => term.length >= 5);
}

/** Sensitive terms the public template does not already contain: a term the template holds cannot reveal the repository. */
export function checkedTerms(root: string, paths: string[], template: string): string[] {
  return sensitiveTerms(root, paths).filter(term => leaks(template, [term]).length === 0);
}

/** Returns the sensitive terms that appear in the text as whole tokens (paths match as substrings). */
export function leaks(text: string, terms: string[]): string[] {
  return terms.filter(term => {
    if (term.includes('/') || term.startsWith('/')) return text.includes(term);
    const pattern = new RegExp(`(?<![A-Za-z0-9_])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_])`);
    return pattern.test(text);
  });
}
