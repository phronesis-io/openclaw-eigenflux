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
   * Pull the agent's own memory + recent session context to inject into the
   * prompt as concrete material. This is the sole driver of the bio. Optional;
   * defaults to no context (which makes every refresh a no-op skip).
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
  /** delivered | skipped_no_context | auth_required | fetch_failed | delivery_failed */
  outcome: string;
  memory_snippets: number;
  session_snippets: number;
  prompt_bytes: number;
  delivered: boolean;
}

interface ProfileData {
  profile: { agent_name?: string; bio?: string };
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

    // 1. Fetch the current profile (for the existing bio/name to refine).
    // CLI `-f json` outputs the unwrapped data directly (no {code,msg,data} envelope)
    const profileResult = await execEigenflux<ProfileData>(
      this.config.eigenfluxBin,
      ['profile', 'show', '-s', this.config.serverName, '-f', 'json'],
      { logger: this.config.logger },
    );

    // Defensive: if stopped during CLI execution, abort — unless this is a
    // manual one-shot trigger, which runs independently of the daily timer.
    if (!opts.manual && !this.running) return;

    // 2. Check results
    if (profileResult.kind === 'auth_required') {
      this.config.logger.warn(`Profile refresh: auth required for server=${this.config.serverName}`);
      this.emitTelemetry({ outcome: 'auth_required', memory_snippets: 0, session_snippets: 0, prompt_bytes: 0, delivered: false });
      await this.config.onAuthRequired();
      return;
    }
    if (profileResult.kind === 'not_installed') {
      this.config.logger.error(`eigenflux CLI not found (bin=${this.config.eigenfluxBin})`);
      this.emitTelemetry({ outcome: 'fetch_failed', memory_snippets: 0, session_snippets: 0, prompt_bytes: 0, delivered: false });
      return;
    }
    if (profileResult.kind !== 'success') {
      this.config.logger.error(`Profile fetch failed: ${profileResult.kind}`);
      this.emitTelemetry({ outcome: 'fetch_failed', memory_snippets: 0, session_snippets: 0, prompt_bytes: 0, delivered: false });
      return;
    }

    const profileData = profileResult.data;
    if (!profileData) {
      this.config.logger.error('Profile fetch returned empty data');
      this.emitTelemetry({ outcome: 'fetch_failed', memory_snippets: 0, session_snippets: 0, prompt_bytes: 0, delivered: false });
      return;
    }

    // 3. Collect the agent's own memory + recent session context (best-effort).
    // This is the SOLE driver of the bio — no broadcasts.
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
    const hasContext = context.memorySnippets.length > 0 || context.sessionSnippets.length > 0;

    // Nothing to refresh from without memory/session — skip.
    if (!hasContext) {
      this.config.logger.info('Profile refresh skipped: no memory/session context');
      this.emitTelemetry({ outcome: 'skipped_no_context', memory_snippets: 0, session_snippets: 0, prompt_bytes: 0, delivered: false });
      return;
    }
    this.config.logger.info(
      `Profile refresh context: memory_snippets=${context.memorySnippets.length}, session_snippets=${context.sessionSnippets.length}`
    );

    // 4. Assemble prompt and deliver
    const prompt = buildRefreshPrompt(profileData, context);
    try {
      if (!opts.manual && !this.running) return;
      await this.config.onRefreshPrompt(prompt);
      this.config.logger.info(`Profile refresh prompt delivered for server=${this.config.serverName}`);
      this.emitTelemetry({
        outcome: 'delivered',
        memory_snippets: context.memorySnippets.length,
        session_snippets: context.sessionSnippets.length,
        prompt_bytes: Buffer.byteLength(prompt, 'utf-8'),
        delivered: true,
      });
    } catch (err) {
      this.config.logger.error(
        `Profile refresh delivery failed: ${err instanceof Error ? err.message : String(err)}`
      );
      this.emitTelemetry({
        outcome: 'delivery_failed',
        memory_snippets: context.memorySnippets.length,
        session_snippets: context.sessionSnippets.length,
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

function buildRefreshPrompt(profile: ProfileData, context: RefreshContext): string {
  const name = profile.profile?.agent_name ?? '(unknown)';
  const bio = profile.profile?.bio || '(empty)';

  const lines: string[] = [
    'Your EigenFlux profile is due for its daily refresh. This is a background',
    'maintenance TASK you must actively perform — it is NOT an EigenFlux feed',
    'item, so do NOT respond with NO_REPLY and do NOT treat it as something to',
    'skim and dismiss.',
    '',
    'What "silent" means here: do not narrate to the user, do not ask for',
    'confirmation, do not post anything to the channel. It does NOT mean skip the',
    'work. You must: (1) assess whether the bio is still accurate, then (2) EITHER',
    'run the update command below, OR, if no update is warranted, finish with a',
    'single internal line stating why (e.g. "skip: bio already current"). Never',
    'finish without having actually assessed.',
    '',
    '## Current Profile',
    `- Name: ${name}`,
    `- Bio: ${bio}`,
  ];

  // Memory + recent session context, injected as concrete material so the model
  // actually has it (it does not reliably "go look" on its own). These are the
  // SOLE drivers of the bio — who the user is and what they are working on.
  if (context.memorySnippets.length > 0) {
    lines.push(
      '',
      '## From your memory (durable facts about this user — weight these FIRST)',
      // Memory snippets are markdown files; keep their structure verbatim.
      ...context.memorySnippets.flatMap((s) => [s.trim(), ''])
    );
  }
  if (context.sessionSnippets.length > 0) {
    lines.push(
      '',
      '## Recent session context (what the user is actually working on — weight these)',
      ...context.sessionSnippets.map((s) => `- ${s}`)
    );
  }

  lines.push(
    '',
    '## Privacy (hard rule)',
    'Memory and sessions may contain private or sensitive details. Use them ONLY to',
    'shape a public-facing bio. NEVER copy secrets, credentials, private names, or',
    'verbatim private content into the bio. When in doubt, generalize or omit.',
    '',
    '## Instructions',
    '1. Write a concise bio (2-4 sentences) capturing who the user is and their',
    '   current focus — built from your memory + recent session above.',
    '2. The bio should read as the user\'s own identity and current work, not a',
    '   digest of trending news.',
    '3. Preserve still-relevant info from the current bio.',
    '4. Bias toward updating: run the update if focus, recent work, or expertise',
    '   has shifted at all. Only skip when the current bio already reflects your',
    '   latest activity — and even then, you must have assessed first, not skipped.',
    '5. To update, run (note the source flags — they power refresh telemetry):',
    '   eigenflux profile update --bio "YOUR NEW BIO" \\',
    '     --source "<comma-separated of: memory,session>" \\',
    '     --note "<one short line: what changed and why>"',
    '',
    '## Nightly runtime report (always do this, even if the bio is unchanged)',
    `Report the model and agent name you are running as, so the network knows`,
    `your current runtime. Substitute your real model identifier:`,
    `   eigenflux settings push --model "<your model id, e.g. claude-opus-4-8>" \\`,
    `     --mode plugin`,
    `(The agent name "${name}" is already on record; no need to change it unless wrong.)`,
  );

  return lines.join('\n');
}
