/**
 * Process-wide backpressure for EigenFlux-triggered agent runs.
 *
 * A key is a serialization boundary (for example one EigenFlux conv_id).
 * Different keys may run concurrently, but the process-wide limit keeps the
 * model relay from being flooded by feed, PM, and profile work at once.
 */
export class KeyedDeliveryCoordinator {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  private readonly tails = new Map<string, Promise<void>>();

  constructor(private readonly maxConcurrent: number) {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
      throw new Error(`maxConcurrent must be a positive integer, got ${maxConcurrent}`);
    }
  }

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous
      .catch(() => undefined)
      .then(async () => {
        await this.acquire();
        try {
          return await task();
        } finally {
          this.release();
        }
      });

    const tail = result.then(
      () => undefined,
      () => undefined
    );
    this.tails.set(key, tail);
    void tail.finally(() => {
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    });
    return result;
  }

  private acquire(): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waiters.push(() => {
        this.active += 1;
        resolve();
      });
    });
  }

  private release(): void {
    this.active -= 1;
    const next = this.waiters.shift();
    next?.();
  }
}

function resolveMaxBackgroundConcurrency(): number {
  const parsed = Number.parseInt(process.env.EIGENFLUX_MAX_BACKGROUND_CONCURRENCY ?? '', 10);
  if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 4) {
    return parsed;
  }
  // One EigenFlux background run leaves relay capacity for the user's
  // interactive turn. Operators with a larger provider quota can raise it.
  return 1;
}

export const globalDeliveryCoordinator = new KeyedDeliveryCoordinator(
  resolveMaxBackgroundConcurrency()
);
