import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const expandHome = (path: string) => resolve(path.startsWith('~') ? join(homedir(), path.slice(1)) : path);

/** `--pack NAME=DIR:VARIANT`: pack rows of VARIANT in the bench/run.ts output DIR, reported as NAME. */
export function parsePackSource(argument: string): { name: string; dir: string; variant: string } {
  const equals = argument.indexOf('=');
  const colon = argument.lastIndexOf(':');
  if (equals <= 0 || colon <= equals + 1 || colon === argument.length - 1) throw new Error(`--pack expects NAME=DIR:VARIANT, got "${argument}"`);
  return { name: argument.slice(0, equals), dir: expandHome(argument.slice(equals + 1, colon)), variant: argument.slice(colon + 1) };
}
