/**
 * The file universe the proof harness measures against: the files a repository-aware agent could read.
 *
 * Git repositories only. Tracked and untracked files that are not ignored (`git ls-files --exclude-standard`), minus
 * tracked files that match an ignore rule (squeze drops those; git still lists them), then squeze's own path policy
 * (`allowedPath`), regular files of at most 2 MiB, and no NUL byte in the first 8 KiB.
 */
import { execFile } from 'node:child_process';
import type { Stats } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { languageFor } from '../../src/parser.js';
import { allowedPath } from '../../src/repository.js';

const run = promisify(execFile);
export const UNIVERSE_MAX_BYTES = 2 * 1024 * 1024;
const BINARY_PROBE_BYTES = 8192;
const GIT_OPTIONS = ['--no-pager', '--no-optional-locks', '--no-replace-objects', '-c', 'core.fsmonitor=false'];

export interface UniverseFile {
  path: string;
  text: string;
  size: number;
  language: string;
}

export interface Universe {
  files: UniverseFile[];
  /** Paths git listed before any exclusion. */
  listed: number;
  /** Count of listed paths removed, by reason. */
  excluded: Record<string, number>;
}

async function git(root: string, args: string[]): Promise<string[]> {
  const { stdout } = await run('git', ['-C', root, ...GIT_OPTIONS, ...args], { encoding: 'utf8', maxBuffer: 1 << 30 });
  return stdout.split('\0').filter(Boolean);
}

export async function buildUniverse(root: string): Promise<Universe> {
  const listed = [...new Set(await git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']))];
  const trackedIgnored = new Set(await git(root, ['ls-files', '-i', '-c', '--exclude-standard', '-z']));
  const excluded: Record<string, number> = {};
  const skip = (reason: string) => {
    excluded[reason] = (excluded[reason] ?? 0) + 1;
  };
  const files: UniverseFile[] = [];
  for (const path of listed) {
    if (trackedIgnored.has(path)) {
      skip('tracked-but-ignored');
      continue;
    }
    if (!allowedPath(path)) {
      skip('path-policy');
      continue;
    }
    const absolute = join(root, path);
    let info: Stats;
    try {
      info = await lstat(absolute);
    } catch {
      skip('missing');
      continue;
    }
    if (!info.isFile()) {
      skip('not-regular');
      continue;
    }
    if (info.size > UNIVERSE_MAX_BYTES) {
      skip('too-large');
      continue;
    }
    const bytes = await readFile(absolute);
    if (bytes.subarray(0, BINARY_PROBE_BYTES).includes(0)) {
      skip('binary');
      continue;
    }
    files.push({ path, text: bytes.toString('utf8'), size: bytes.length, language: languageFor(path) });
  }
  return { files, listed: listed.length, excluded };
}
