/**
 * Daily profile auto-refresh for EigenFlux.
 *
 * Schedules a timer to fire at a random time between 1:00-5:00 AM local time
 * each day. When triggered, fetches the user's current profile, gathers the
 * agent's own memory + recent session context, assembles a prompt, and
 * delivers it to the host AI to generate an updated bio.
 *
 * The bio is driven by who the user *is* and what they are working on (memory
 * + session) — NOT by network broadcasts.
 *
 * TODO: 未来将 feedPoller、streamClient、profileRefresher 统一为
 * 单个 `eigenflux heartbeat` 守护进程，减少插件端的管理开销。
 */

import { execEigenflux } from './cli-executor';
import { Logger } from './logger';
import { EMPTY_CONTEXT, type RefreshContext } from './openclaw-context';

const REFRESH_WINDOW_START = 1; // 1:00 AM
const REFRESH_WINDOW_END = 5;   // 5:00 AM (exclusive)

export interface ProfileRefresherConfig {
  serverName: string;
  eigenfluxBin: string;
  logger: Logger;
  /**
   * Deliver the refresh prompt to the host AI. Implementations should deliver
   * *silently* (no user-facing channel reply) so the daily bio refresh stays
   * imperceptible to the user — see index.ts wiring (`silent: true`).
   */
  onRefreshPrompt: (prompt: string) => Promise<void>;
  onAuthRequired: () => Promise<void>;
  /**
   * Resolve the host-specific inputs for the CLI refresh-prompt core: the memory
   * directories (the CLI reads the markdown) and recent session snippets (the
   * host extracts these from its own transcript format). This is the sole driver
   * of the bio. Optional; defaults to no context (every refresh is a no-op skip).
   * Best-effort — implementations should never throw.
   */
  collectContext?: () => RefreshContext | Promise<RefreshContext>;
}

/**
 * Layer-1 (plugin-side) telemetry for one refresh attempt. Emitted as a single
 * structured log line (`profile_refresh_telemetry <json>`) so it can be grepped
 * out of plugin logs to confirm the daily refresh actually fires and is
 * delivered silently. This layer proves the *pipeline ran*; whether the bio
 * actually changed (and which sources the agent drew on) is the agent's job to
 * self-report via `eigenflux profile update --source ...`, captured server-side
 * as layer-2 telemetry / bio history.
 */
interface RefreshTelemetry {
  server: string;
  /** delivered | skipped_no_context | auth_required | not_installed | error | delivery_failed */
  outcome: string;
  memory_dirs: number;
  session_snippets: number;
  prompt_bytes: number;
  delivered: boolean;
}

export class EigenFluxProfileRefresher {
  private config: ProfileRefresherConfig;
  private timeoutId: NodeJS.Timeout | null = null;
  private running = false;

  constructor(config: ProfileRefresherConfig) {
    this.config = config;
  }

  isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.config.logger.info(`Starting profile refresher for server=${this.config.serverName}`);
    this.scheduleNext();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
    this.config.logger.info(`Stopped profile refresher for server=${this.config.serverName}`);
  }

  /**
   * Run a refresh immediately, out of band from the daily timer. Intended for
   * manual verification (`/eigenflux refresh`) so the full silent loop can be
   * exercised on demand instead of waiting for the 1–5 AM window. Runs
   * independently of the timer state — the command path may hold a refresher
   * instance that was never start()ed, and a manual one-shot should still work.
   * The next scheduled refresh (if any) is left untouched.
   */
  async triggerNow(): Promise<void> {
    this.config.logger.info(`Manual profile refresh triggered for server=${this.config.serverName}`);
    await this.refresh({ manual: true });
  }

  private scheduleNext(): void {
    if (!this.running) return;
    const delay = msUntilNextRefresh(new Date());
    const targetTime = new Date(Date.now() + delay);
    this.config.logger.info(
      `Next profile refresh at ${targetTime.toLocaleTimeString()} (in ${Math.round(delay / 60_000)}min) for server=${this.config.serverName}`
    );
    this.timeoutId = setTimeout(async () => {
      this.timeoutId = null;
      try {
        await this.refresh();
      } catch (err) {
        this.config.logger.error(
          `Profile refresh crashed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
      this.scheduleNext();
    }, delay);
  }

  private async refresh(opts: { manual?: boolean } = {}): Promise<void> {
    this.config.logger.info(`Running profile refresh for server=${this.config.serverName}`);

    // 1. Resolve host-specific inputs: memory dirs + extracted session snippets.
    let context: RefreshContext = EMPTY_CONTEXT;
    if (this.config.collectContext) {
      try {
        context = (await this.config.collectContext()) ?? EMPTY_CONTEXT;
      } catch (err) {
        this.config.logger.warn(
          `Context collection failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    const memoryDirs = context.memoryDirs ?? [];
    const sessionSnippets = context.sessionSnippets ?? [];

    // Nothing to refresh from without memory/session — skip (don't even call out).
    if (memoryDirs.length === 0 && sessionSnippets.length === 0) {
      this.config.logger.info('Profile refresh skipped: no memory/session context');
      this.emitTelemetry({ outcome: 'skipped_no_context', memory_dirs: 0, session_snippets: 0, prompt_bytes: 0, delivered: false });
      return;
    }

    // Defensive: if stopped before delivery, abort — unless a manual trigger.
    if (!opts.manual && !this.running) return;

    // 2. Ask the host-agnostic CLI core to assemble the prompt (it fetches the
    // profile, reads the memory markdown, and builds the wording). stdout is the
    // prompt, empty when the CLI judged there's nothing to refresh from.
    const args = [
      'profile', 'refresh-prompt',
      '-s', this.config.serverName,
      ...memoryDirs.flatMap((d) => ['--memory-dir', d]),
      ...sessionSnippets.flatMap((s) => ['--session-snippet', s]),
    ];
    const result = await execEigenflux<string>(this.config.eigenfluxBin, args, {
      logger: this.config.logger,
      parseJson: false,
    });

    if (!opts.manual && !this.running) return;

    if (result.kind === 'auth_required') {
      this.config.logger.warn(`Profile refresh: auth required for server=${this.config.serverName}`);
      this.emitTelemetry({ outcome: 'auth_required', memory_dirs: memoryDirs.length, session_snippets: sessionSnippets.length, prompt_bytes: 0, delivered: false });
      await this.config.onAuthRequired();
      return;
    }
    if (result.kind === 'not_installed') {
      this.config.logger.error(`eigenflux CLI not found (bin=${this.config.eigenfluxBin})`);
      this.emitTelemetry({ outcome: 'not_installed', memory_dirs: memoryDirs.length, session_snippets: sessionSnippets.length, prompt_bytes: 0, delivered: false });
      return;
    }
    if (result.kind !== 'success') {
      this.config.logger.error(`refresh-prompt failed: ${result.error.message}`);
      this.emitTelemetry({ outcome: 'error', memory_dirs: memoryDirs.length, session_snippets: sessionSnippets.length, prompt_bytes: 0, delivered: false });
      return;
    }

    const prompt = (result.data ?? '').trim();
    if (!prompt) {
      this.config.logger.info('Profile refresh skipped: CLI produced no prompt');
      this.emitTelemetry({ outcome: 'skipped_no_context', memory_dirs: memoryDirs.length, session_snippets: sessionSnippets.length, prompt_bytes: 0, delivered: false });
      return;
    }
    this.config.logger.info(
      `Profile refresh context: memory_dirs=${memoryDirs.length}, session_snippets=${sessionSnippets.length}`
    );

    // 3. Deliver the prompt silently.
    try {
      if (!opts.manual && !this.running) return;
      await this.config.onRefreshPrompt(prompt);
      this.config.logger.info(`Profile refresh prompt delivered for server=${this.config.serverName}`);
      this.emitTelemetry({
        outcome: 'delivered',
        memory_dirs: memoryDirs.length,
        session_snippets: sessionSnippets.length,
        prompt_bytes: Buffer.byteLength(prompt, 'utf-8'),
        delivered: true,
      });
    } catch (err) {
      this.config.logger.error(
        `Profile refresh delivery failed: ${err instanceof Error ? err.message : String(err)}`
      );
      this.emitTelemetry({
        outcome: 'delivery_failed',
        memory_dirs: memoryDirs.length,
        session_snippets: sessionSnippets.length,
        prompt_bytes: Buffer.byteLength(prompt, 'utf-8'),
        delivered: false,
      });
    }
  }

  /**
   * Emit one structured layer-1 telemetry line. Grep `profile_refresh_telemetry`
   * in plugin logs to confirm the daily refresh fired and was handed off for
   * silent delivery. Best-effort: never throws.
   */
  private emitTelemetry(t: Omit<RefreshTelemetry, 'server'>): void {
    try {
      const payload: RefreshTelemetry = { server: this.config.serverName, ...t };
      this.config.logger.info(`profile_refresh_telemetry ${JSON.stringify(payload)}`);
    } catch {
      // Telemetry must never break the refresh loop.
    }
  }
}

/**
 * Calculate milliseconds until the next random time in [1:00, 5:00) AM local.
 */
export function msUntilNextRefresh(now: Date): number {
  const target = new Date(now);

  const hour = REFRESH_WINDOW_START + Math.floor(Math.random() * (REFRESH_WINDOW_END - REFRESH_WINDOW_START));
  const minute = Math.floor(Math.random() * 60);
  const second = Math.floor(Math.random() * 60);

  target.setHours(hour, minute, second, 0);

  // If target is in the past, move to tomorrow
  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1);
  }

  return target.getTime() - now.getTime();
}
