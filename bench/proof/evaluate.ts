/**
 * Runs the three arms over a sample of gold cases for one repository.
 *
 * The universe is built once; every arm reads the same file texts and the same token costs. One Engine per repository,
 * started with a full snapshot so the cold-index time and the file count squeze reports are recorded before any query.
 */
import { Engine } from '../../src/engine.js';
import {
  fileCosts,
  grepFor,
  grepOutcome,
  squeezeOutcome,
  totalTokens,
  wholeOutcome,
  type ArmResult,
  type GrepResult,
  type SqueezeResult,
} from './arms.js';
import { buildGoldCases, sampleCases, type GoldCase } from './gold.js';
import { buildUniverse } from './universe.js';

export interface CaseRow {
  repo: string;
  name: string;
  goldFiles: string[];
  whole: ArmResult;
  grep: GrepResult;
  squeeze: SqueezeResult;
}

export interface RepoRun {
  repo: string;
  universe: {
    listed: number;
    files: number;
    excluded: Record<string, number>;
    tokens: number;
  };
  squeeze: {
    totalFiles: number | undefined;
    indexMode: string | undefined;
    coldIndexMs: number;
  };
  /** Labelled cases the universe supports before sampling. */
  availableCases: number;
  rows: CaseRow[];
}

export interface EvaluateOptions {
  repo: string;
  root: string;
  sample: number;
  seed: number;
  onProgress?: (done: number, total: number) => void;
}

export async function evaluateRepo(options: EvaluateOptions): Promise<RepoRun> {
  const universe = await buildUniverse(options.root);
  const cases = buildGoldCases(universe.files.map(({ path, text, language }) => ({ path, text, language })));
  const sampled: GoldCase[] = sampleCases(cases, options.sample, options.seed);
  const costs = fileCosts(universe.files);

  const engine = new Engine(options.root);
  const snapshot = await engine.snapshot();

  const rows: CaseRow[] = [];
  for (const [index, testCase] of sampled.entries()) {
    const gold = testCase.files;
    rows.push({
      repo: options.repo,
      name: testCase.name,
      goldFiles: gold,
      whole: wholeOutcome(gold, costs),
      grep: grepOutcome(grepFor(universe.files, testCase.name), gold, costs),
      squeeze: await squeezeOutcome(engine, testCase.name, gold),
    });
    options.onProgress?.(index + 1, sampled.length);
  }

  return {
    repo: options.repo,
    universe: {
      listed: universe.listed,
      files: universe.files.length,
      excluded: universe.excluded,
      tokens: totalTokens(costs),
    },
    squeeze: {
      totalFiles: snapshot.totalFiles,
      indexMode: snapshot.indexMode,
      coldIndexMs: snapshot.elapsedMs,
    },
    availableCases: cases.length,
    rows,
  };
}
