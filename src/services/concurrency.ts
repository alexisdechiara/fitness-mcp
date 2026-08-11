export interface ConcurrencyLimiter {
  run<T>(operation: () => Promise<T> | T): Promise<T>;
}

/**
 * Small dependency-free FIFO concurrency limiter.
 *
 * A limiter is created per aggregation request, so unrelated MCP requests do
 * not share state while every upstream call made by one aggregation observes
 * the configured ceiling.
 */
export function createConcurrencyLimiter(maxConcurrency: number): ConcurrencyLimiter {
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
    throw new RangeError("maxConcurrency must be a positive integer.");
  }

  let active = 0;
  const queue: Array<() => void> = [];

  const drain = (): void => {
    while (active < maxConcurrency) {
      const start = queue.shift();
      if (!start) return;
      active += 1;
      start();
    }
  };

  return {
    run<T>(operation: () => Promise<T> | T): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        queue.push(() => {
          Promise.resolve()
            .then(operation)
            .then(resolve, reject)
            .finally(() => {
              active -= 1;
              drain();
            });
        });
        drain();
      });
    },
  };
}
