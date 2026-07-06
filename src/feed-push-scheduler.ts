import { Logger } from './logger';

/**
 * Busy-aware scheduler for the default main-session feed push.
 *
 * The main session is a serialization unit: a feed run holds its lock for
 * 30-60s, and a user message arriving in that window has to wait — perceived
 * as the bot stalling. Instead of relocating feed processing (one-shot lost
 * user context; system-event mode depends on the host heartbeat scheduler,
 * which has been observed to stall for hours), we keep the proven active-push
 * path and simply pick a quiet moment:
 *
 *   feed arrives → target session busy?
 *     idle → push now (plugin-initiated deliver:true subagent run)
 *     busy → hold the payload, recheck every `recheckMs`, push when quiet
 *     still busy after `budgetMs` → the user has been chatting the whole
 *       time, so piggyback instead: enqueue a system event under the
 *       canonical session key — their very next message drains it. This
 *       fallback is only taken in the one scenario where it is guaranteed
 *       to work (an actively chatting user), so it never strands.
 *
 * A newer poll's payload supersedes the held one — only the latest batch is
 * pushed, nothing queues up. Timers are plain setTimeout (same mechanism as
 * feedback-flush-loop and profile-refresher) and are cleared on stop().
 */
export type FeedPushSchedulerDeps = {
  /** True when the target session should not be interrupted right now. */
  isBusy: () => Promise<boolean>;
  /** Active push (guarded deliver:true subagent run on the main session). */
  pushNow: (prompt: string) => Promise<void>;
  /** Budget-exhausted fallback: enqueue so the live conversation drains it. */
  piggyback: (prompt: string) => Promise<void>;
  logger: Logger;
  serverName: string;
  /** Recheck cadence while busy. Default 30s. */
  recheckMs?: number;
  /** Max total wait before piggybacking. Default 10min. */
  budgetMs?: number;
};

const DEFAULT_RECHECK_MS = 30_000;
const DEFAULT_BUDGET_MS = 10 * 60_000;

export class FeedPushScheduler {
  private readonly deps: FeedPushSchedulerDeps;
  private readonly recheckMs: number;
  private readonly budgetMs: number;

  private pendingPrompt: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private deferStartedAt = 0;
  private stopped = false;

  constructor(deps: FeedPushSchedulerDeps) {
    this.deps = deps;
    this.recheckMs = deps.recheckMs ?? DEFAULT_RECHECK_MS;
    this.budgetMs = deps.budgetMs ?? DEFAULT_BUDGET_MS;
  }

  /**
   * Hold `prompt` for delivery at the next quiet moment. A prompt scheduled
   * while an earlier one is still waiting REPLACES it (latest batch wins).
   */
  schedule(prompt: string): void {
    if (this.stopped) return;
    const superseded = this.pendingPrompt !== null;
    this.pendingPrompt = prompt;
    if (this.timer) {
      // Recheck loop already armed; it will pick up the newer prompt.
      if (superseded) {
        this.deps.logger.info(
          `Feed push pending payload superseded by newer poll for server=${this.deps.serverName}`
        );
      }
      return;
    }
    this.deferStartedAt = Date.now();
    void this.attempt();
  }

  /** Cancel any pending push and recheck timer (service stop). */
  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pendingPrompt = null;
  }

  private async attempt(): Promise<void> {
    this.timer = null;
    if (this.stopped) return;
    const prompt = this.pendingPrompt;
    if (prompt === null) return;

    let busy = false;
    try {
      busy = await this.deps.isBusy();
    } catch {
      // Can't tell → behave like the pre-scheduler code and push immediately.
      busy = false;
    }
    if (this.stopped || this.pendingPrompt === null) return;

    if (busy) {
      const waited = Date.now() - this.deferStartedAt;
      if (waited >= this.budgetMs) {
        // User has been active for the whole budget — piggyback their live
        // conversation instead of waiting forever.
        const held = this.pendingPrompt;
        this.pendingPrompt = null;
        this.deps.logger.info(
          `Feed push budget exhausted after ${Math.round(waited / 1000)}s; ` +
          `piggybacking via system event for server=${this.deps.serverName}`
        );
        try {
          await this.deps.piggyback(held);
        } catch (error) {
          this.deps.logger.error(
            `Feed piggyback delivery failed for server=${this.deps.serverName}: ${String(error)}`
          );
        }
        return;
      }
      this.deps.logger.info(
        `Feed push deferred: main session busy (waited=${Math.round(waited / 1000)}s) ` +
        `for server=${this.deps.serverName}`
      );
      this.timer = setTimeout(() => {
        void this.attempt();
      }, this.recheckMs);
      this.timer.unref?.();
      return;
    }

    const held = this.pendingPrompt;
    this.pendingPrompt = null;
    this.deps.logger.info(
      `Feed push: main session idle; delivering now for server=${this.deps.serverName}`
    );
    try {
      await this.deps.pushNow(held);
    } catch (error) {
      this.deps.logger.error(
        `Feed push delivery failed for server=${this.deps.serverName}: ${String(error)}`
      );
    }
  }
}
