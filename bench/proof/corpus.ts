/**
 * Pinned public corpus for the proof harness. Each repository is fetched at an exact commit so a rerun measures the same
 * code. Clones live under bench/.scratch/ (git-ignored) and are replaced when HEAD does not match the pin.
 */
import { execFile } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface CorpusRepo {
  name: string;
  github: string;
  sha: string;
}

export const PUBLIC_CORPUS: readonly CorpusRepo[] = [
  { name: 'flask', github: 'pallets/flask', sha: '49943b5a94413a530761350f04e896f76e8d620e' },
  { name: 'requests', github: 'psf/requests', sha: '3c7baaa05ab4aa49cc819ce3a819d260de19c157' },
  { name: 'gin', github: 'gin-gonic/gin', sha: '0f09c3a9b4626d9fe9979cf4d0521d6ae32ab646' },
  { name: 'ripgrep', github: 'BurntSushi/ripgrep', sha: '178cc027e283fd965cb72d0a7395b219eada170c' },
  { name: 'express', github: 'expressjs/express', sha: '43fca52d28a422c8be48fd489cbd4f2d6152bab6' },
  { name: 'gson', github: 'google/gson', sha: 'd938a10f7564f596603dd4e958bc9249fb2225b5' },
  { name: 'bat', github: 'sharkdp/bat', sha: '8cf33bdde9a6e4c11d0f866415b1fc867df0cd40' },
  { name: 'preact', github: 'preactjs/preact', sha: 'a2e03dbc6a4a239552d43edb6580ecf86886cc39' },
  { name: 'django', github: 'django/django', sha: 'f24f38c6b2825f15628c07bf2892f1664eed9361' },
];

export const SCRATCH_DIR = fileURLToPath(new URL('../.scratch/proof/', import.meta.url));

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-C', cwd, ...args], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout.trim();
}

/** Returns the directory holding the repository checked out at the pinned commit. */
export async function ensureClone(repo: CorpusRepo): Promise<string> {
  const dir = join(SCRATCH_DIR, repo.name);
  const head = await git(dir, ['rev-parse', 'HEAD']).catch(() => '');
  if (head === repo.sha) return dir;

  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await git(dir, ['init', '-q']);
  await git(dir, ['remote', 'add', 'origin', `https://github.com/${repo.github}.git`]);
  await git(dir, ['fetch', '-q', '--depth', '1', 'origin', repo.sha]);
  await git(dir, ['checkout', '-q', '--detach', 'FETCH_HEAD']);
  const checked = await git(dir, ['rev-parse', 'HEAD']);
  if (checked !== repo.sha) throw new Error(`${repo.name}: checked out ${checked}, expected ${repo.sha}`);
  return dir;
}
