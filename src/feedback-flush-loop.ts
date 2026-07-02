/**
 * The sole resident piece of feedback collection left in the plugin: a retry
 * cadence that drives `eigenflux feed event flush`. The CLI owns the queue,
 * batching, and dedup; it flushes a batch and reports `{ flushed, remaining,
 * ok }` WITHOUT any back-off of its own. Deciding *when* to retry is the
 * caller's job — that back-off lives here.
 *
 * Behaviour: on tick, call flush. If the CLI reports remaining > 0 and ok
 * false (the push failed and pending events are left), schedule the next flush
 * after an exponential back-off (5s base, 5min cap). Otherwise reset back-off;
 * with nothing pending we simply wait for the next opportunistic kick (a tool
 * `record` already flushes once inside the CLI, so idle servers rarely tick).
 *
 * Constants mirror the retired FeedbackEventQueue (baseBackoff 5s, maxBackoff
 * 5min) so the retry behaviour is unchanged from the pre-downsink plugin.
 */

import { execEigenflux } from './cli-executor';
import { Logger } from './logger';

export const DEFAULT_BASE_BACKOFF_MS = 5_000;
export const DEFAULT_MAX_BACKOFF_MS = 5 * 60_000;

export interface FlushLoopConfig {
  serverName: string;
  eigenfluxBin: string;
  logger: Logger;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
}

interface FlushResult {
  flushed?: number;
  remaining?: number;
  ok?: boolean;
}

/**
 * A tiny self-rescheduling back-off driver around `feed event flush`. Not a
 * fixed-interval timer: each flush that leaves pending-and-failed events arms
 * the next attempt with a growing delay; a clean flush disarms it. `kick()`
 * lets the tool path nudge an immediate flush after a `record`.
 */
export class FeedbackFlushLoop {
  private readonly config: Required<FlushLoopConfig>;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private inFlight = false;
  private currentBackoff: number;

  constructor(config: FlushLoopConfig) {
    this.config = {
      baseBackoffMs: DEFAULT_BASE_BACKOFF_MS,
      maxBackoffMs: DEFAULT_MAX_BACKOFF_MS,
      ...config,
    };
    this.currentBackoff = this.config.baseBackoffMs;
  }

  isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.config.logger.info(`Starting feedback flush loop for server=${this.config.serverName}`);
    // Kick once on start to drain anything a previous run left on disk.
    void this.tick();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.currentBackoff = this.config.baseBackoffMs;
    this.config.logger.info(`Stopped feedback flush loop for server=${this.config.serverName}`);
  }

  /**
   * Nudge an immediate flush (e.g. right after a tool `record`). Coalesces with
   * any in-flight flush; if stopped it is a no-op.
   */
  kick(): void {
    if (!this.running) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    void this.tick();
  }

  private schedule(delayMs: number): void {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, delayMs);
  }

  /**
   * Run one flush and decide whether to arm a retry. Best-effort: any error is
   * logged and treated as "leave it for the next kick".
   */
  private async tick(): Promise<void> {
    if (!this.running || this.inFlight) return;
    this.inFlight = true;
    try {
      const result = await execEigenflux<FlushResult>(
        this.config.eigenfluxBin,
        ['feed', 'event', 'flush', '-s', this.config.serverName],
        { logger: this.config.logger }
      );

      if (!this.running) return;

      const data = result.kind === 'success' ? (result.data ?? {}) : {};
      const remaining = typeof data.remaining === 'number' ? data.remaining : 0;
      const ok = data.ok !== false;

      // Retry only when the push failed AND events are still pending. A clean
      // flush (or an empty queue) resets the back-off and stops the loop.
      if (result.kind === 'success' && remaining > 0 && !ok) {
        this.config.logger.debug(
          `feedback flush left ${remaining} pending (server=${this.config.serverName}); retrying in ${this.currentBackoff}ms`
        );
        const delay = this.currentBackoff;
        this.currentBackoff = Math.min(this.currentBackoff * 2, this.config.maxBackoffMs);
        this.schedule(delay);
      } else {
        this.currentBackoff = this.config.baseBackoffMs;
      }
    } catch (err) {
      this.config.logger.debug(
        `feedback flush loop tick failed for server=${this.config.serverName}: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      this.inFlight = false;
    }
  }
}
