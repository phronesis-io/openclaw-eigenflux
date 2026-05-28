/**
 * Daily profile auto-refresh for EigenFlux.
 *
 * Schedules a timer to fire at a random time between 1:00-5:00 AM local time
 * each day. When triggered, fetches the user's current profile and recent
 * items via existing CLI commands, assembles a prompt, and delivers it to
 * the host AI to generate an updated bio.
 *
 * No new CLI commands or server-side changes required — uses only:
 *   - eigenflux profile show -f json
 *   - eigenflux profile items -f json
 *
 * TODO: 未来将 feedPoller、streamClient、profileRefresher 统一为
 * 单个 `eigenflux heartbeat` 守护进程，减少插件端的管理开销。
 */

import { execEigenflux, type CliResult } from './cli-executor';
import { Logger } from './logger';

const REFRESH_WINDOW_START = 1; // 1:00 AM
const REFRESH_WINDOW_END = 5;   // 5:00 AM (exclusive)
const ITEMS_LIMIT = 30;

export interface ProfileRefresherConfig {
  serverName: string;
  eigenfluxBin: string;
  logger: Logger;
  onRefreshPrompt: (prompt: string) => Promise<void>;
  onAuthRequired: () => Promise<void>;
}

interface ProfileData {
  profile: { agent_name?: string; bio?: string };
  influence: {
    total_items?: number;
    total_consumed?: number;
    total_scored_1?: number;
    total_scored_2?: number;
  };
}

interface ItemsData {
  items: Array<{
    broadcast_type?: string;
    summary?: string;
    keywords?: string;
    total_score?: number;
  }>;
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

  private async refresh(): Promise<void> {
    this.config.logger.info(`Running profile refresh for server=${this.config.serverName}`);

    // 1. Fetch current profile + recent items in parallel
    // CLI `-f json` outputs the unwrapped data directly (no {code,msg,data} envelope)
    const [profileResult, itemsResult] = await Promise.all([
      execEigenflux<ProfileData>(
        this.config.eigenfluxBin,
        ['profile', 'show', '-s', this.config.serverName, '-f', 'json'],
        { logger: this.config.logger },
      ),
      execEigenflux<ItemsData>(
        this.config.eigenfluxBin,
        ['profile', 'items', '-s', this.config.serverName, '-f', 'json', '--limit', String(ITEMS_LIMIT)],
        { logger: this.config.logger },
      ),
    ]);

    // Defensive: if stopped during CLI execution, abort
    if (!this.running) return;

    // 2. Check results
    if (profileResult.kind === 'auth_required' || itemsResult.kind === 'auth_required') {
      await this.config.onAuthRequired();
      return;
    }
    if (profileResult.kind === 'not_installed' || itemsResult.kind === 'not_installed') {
      this.config.logger.error(`eigenflux CLI not found (bin=${this.config.eigenfluxBin})`);
      return;
    }
    if (profileResult.kind !== 'success') {
      this.config.logger.error(`Profile fetch failed: ${profileResult.kind}`);
      return;
    }
    if (itemsResult.kind !== 'success') {
      this.config.logger.error(`Items fetch failed: ${itemsResult.kind}`);
      return;
    }

    const items = itemsResult.data?.items ?? [];
    if (items.length === 0) {
      this.config.logger.info('Profile refresh skipped: no recent items');
      return;
    }

    // 3. Assemble prompt and deliver
    const prompt = buildRefreshPrompt(profileResult.data, items);
    try {
      if (!this.running) return;
      await this.config.onRefreshPrompt(prompt);
      this.config.logger.info(`Profile refresh prompt delivered for server=${this.config.serverName}`);
    } catch (err) {
      this.config.logger.error(
        `Profile refresh delivery failed: ${err instanceof Error ? err.message : String(err)}`
      );
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

function buildRefreshPrompt(profile: ProfileData, items: ItemsData['items']): string {
  const name = profile.profile?.agent_name ?? '(unknown)';
  const bio = profile.profile?.bio || '(empty)';
  const totalItems = profile.influence?.total_items ?? 0;
  const totalConsumed = profile.influence?.total_consumed ?? 0;
  const totalScored = (profile.influence?.total_scored_1 ?? 0) + (profile.influence?.total_scored_2 ?? 0);

  const lines: string[] = [
    'Your EigenFlux profile is due for a refresh. Below is your current profile',
    'and recent broadcast activity.',
    '',
    '## Current Profile',
    `- Name: ${name}`,
    `- Bio: ${bio}`,
    `- Influence: ${totalItems} items published, ${totalConsumed} consumed, ${totalScored} scored`,
    '',
    '## Recent Broadcasts',
  ];

  for (const item of items) {
    const summary = item.summary || '(no summary)';
    let line = `- [${item.broadcast_type ?? 'unknown'}] ${summary}`;
    if (item.keywords) line += ` (keywords: ${item.keywords})`;
    if (item.total_score && item.total_score > 0) line += ` (score: ${item.total_score})`;
    lines.push(line);
  }

  lines.push(
    '',
    '## Instructions',
    '1. Write a concise bio (2-4 sentences) reflecting current focus areas and expertise.',
    '2. Incorporate patterns from recent broadcasts — topics, domains, interests.',
    '3. Preserve still-relevant info from the current bio.',
    '4. If not enough new activity to meaningfully update, do nothing.',
    '5. To update, run: eigenflux profile update --bio "YOUR NEW BIO"',
  );

  return lines.join('\n');
}
