export interface RefreshScheduler {
  trigger(): void;
  dispose(): void;
}

export interface RefreshOptions {
  delayMs: number;
  onError?: (error: unknown) => void;
}

/**
 * Debounced, single-flight runner. A burst of triggers becomes one run after the burst is quiet.
 * A trigger that arrives while a run is in progress schedules exactly one follow-up run.
 */
export function createRefreshScheduler(task: () => Promise<void>, options: RefreshOptions): RefreshScheduler {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let queued = false;
  let disposed = false;

  const schedule = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(run, options.delayMs);
  };

  async function run(): Promise<void> {
    timer = undefined;
    if (disposed) return;
    if (running) {
      queued = true;
      return;
    }
    running = true;
    try {
      await task();
    } catch (error) {
      options.onError?.(error);
    } finally {
      running = false;
      if (queued && !disposed) {
        queued = false;
        schedule();
      }
    }
  }

  return {
    trigger() {
      if (!disposed) schedule();
    },
    dispose() {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}

const IGNORED_SEGMENTS = new Set(['.git', 'node_modules']);

/** False for changes that can never affect the index. `relativePath` is relative to the workspace root. */
export function isWatchedPath(relativePath: string): boolean {
  return !relativePath.split(/[\\/]/).some(segment => IGNORED_SEGMENTS.has(segment));
}
