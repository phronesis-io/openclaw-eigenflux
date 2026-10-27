import { Logger } from './logger';

export type FeedPushSchedulerDeps = {
  isBusy: () => Promise<boolean>;
  pushNow: (prompt: string) => Promise<void>;
  logger: Logger;
  serverName: string;
  recheckMs?: number;
  budgetMs?: number;
};

/**
 * Rejection from pushNow when the host run outcome could not be confirmed
 * terminal. The run may still deliver, so the payload is dropped without retry.
 */
export class UnconfirmedFeedDeliveryError extends Error {
  override name = 'UnconfirmedFeedDeliveryError';
}

/**
 * Busy-aware Feed delivery with a single retained payload. A busy target defers
 * delivery, rechecking every `recheckMs`, and delivers anyway once `budgetMs`
 * has elapsed. While a payload is held or in flight, hasPending() is true and
 * Feed polling is gated off; a second payload is not accepted. A failed
 * delivery whose run is confirmed terminal is retried once, then dropped; an
 * unconfirmed outcome (UnconfirmedFeedDeliveryError) is dropped without retry.
 */
export class FeedPushScheduler {
  private pendingPrompt: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private deferStartedAt = 0;
  private attempts = 0;
  private stopped = false;
  private attempting = false;
  private readonly recheckMs: number;
  private readonly budgetMs: number;

  constructor(private readonly deps: FeedPushSchedulerDeps) {
    this.recheckMs = deps.recheckMs ?? 30_000;
    this.budgetMs = deps.budgetMs ?? 10 * 60_000;
  }

  hasPending(): boolean { return this.pendingPrompt !== null; }

  schedule(prompt: string): void {
    if (this.stopped) return;
    if (this.hasPending()) {
      this.deps.logger.warn(`Feed delivery capacity occupied for server=${this.deps.serverName}`);
      return;
    }
    this.pendingPrompt = prompt;
    this.attempts = 0;
    this.deferStartedAt = Date.now();
    void this.attempt();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pendingPrompt = null;
  }

  private retryLater(): void {
    if (this.stopped || !this.hasPending()) return;
    this.timer = setTimeout(() => { this.timer = null; void this.attempt(); }, this.recheckMs);
    this.timer.unref?.();
  }

  private async attempt(): Promise<void> {
    if (this.stopped || this.attempting || this.pendingPrompt === null) return;
    this.attempting = true;
    try {
      let busy = false;
      try { busy = await this.deps.isBusy(); } catch { /* Host state unavailable: attempt delivery. */ }
      if (this.stopped || this.pendingPrompt === null) return;
      if (busy && Date.now() - this.deferStartedAt < this.budgetMs) {
        this.retryLater();
        return;
      }
      this.attempts++;
      try {
        await this.deps.pushNow(this.pendingPrompt);
        this.pendingPrompt = null;
      } catch (error) {
        if (error instanceof UnconfirmedFeedDeliveryError) {
          this.deps.logger.error(`Dropping Feed payload without retry for server=${this.deps.serverName}: ${error.message}`);
          this.pendingPrompt = null;
          return;
        }
        this.deps.logger.error(`Feed delivery attempt ${this.attempts}/2 failed for server=${this.deps.serverName}: ${String(error)}`);
        if (this.attempts >= 2) {
          this.deps.logger.error(`Dropping Feed payload after two failed deliveries for server=${this.deps.serverName}`);
          this.pendingPrompt = null;
        } else {
          this.retryLater();
        }
      }
    } finally {
      this.attempting = false;
    }
  }
}
