/**
 * In-memory ledger of recently-polled feed items. Used by the
 * eigenflux__followup tool to validate item_ids supplied by the agent and to
 * enrich outbound events with server / timestamp metadata. NEVER exposed to
 * the agent — the agent maintains its own ## FEED_INDEX section in memory per
 * contract for the cross-session item_id carry.
 *
 * Persistence: NONE on the plugin side. The eigenflux CLI already caches every
 * feed response to `<workdir>/servers/<server>/data/broadcasts/<YYYYMMDD>/
 * feeds-<ts>.json` (8-day retention). On the first cache miss after process
 * start, this store lazy-scans that directory to seed itself — single source
 * of truth lives with the CLI, not with the plugin.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Logger } from './logger';

export interface LedgerEntry {
  item_id: string;
  server_id: string;
  short_title: string;
  fetched_at: number;
  expires_at: number;
  // Impression that most recently served this item. Stamped onto outbound
  // followup events so the backend can join an event back to its impression.
  impression_id?: string;
}

export interface LedgerLookupResult {
  status: 'hit' | 'expired' | 'missing';
  entry?: LedgerEntry;
}

export interface FeedItemLike {
  item_id: string;
  summary?: string;
}

/**
 * 8 days — aligned with the CLI's broadcast cache retention so a bootstrap
 * scan and a freshly-recorded item share the same effective window.
 */
export const LEDGER_TTL_MS = 8 * 24 * 60 * 60 * 1000;
export const SHORT_TITLE_MAX = 80;

export function makeShortTitle(item: FeedItemLike): string {
  const raw = (item.summary ?? '').replace(/\s+/g, ' ').trim();
  if (raw.length <= SHORT_TITLE_MAX) return raw;
  return `${raw.slice(0, SHORT_TITLE_MAX - 1)}…`;
}

export class LedgerStore {
  private readonly entries = new Map<string, LedgerEntry>();
  private readonly broadcastsDir: string;
  private readonly serverId: string;
  private readonly logger: Logger;
  private bootstrapped = false;

  /**
   * @param broadcastsDir Absolute path to `<workdir>/servers/<server>/data/broadcasts`.
   *                      Used for lazy seeding on first lookup miss.
   * @param serverId      Server name; stamped on bootstrapped entries (the
   *                      cache file itself does not carry it — the directory does).
   */
  constructor(broadcastsDir: string, serverId: string, logger: Logger) {
    this.broadcastsDir = broadcastsDir;
    this.serverId = serverId;
    this.logger = logger;
  }

  record(items: FeedItemLike[], serverId: string, now: number, impressionId?: string): void {
    for (const item of items) {
      if (!item || !item.item_id) continue;
      this.entries.set(item.item_id, {
        item_id: item.item_id,
        server_id: serverId,
        short_title: makeShortTitle(item),
        fetched_at: now,
        expires_at: now + LEDGER_TTL_MS,
        impression_id: impressionId,
      });
    }
    // Live polling has replaced any need to scan the cache: from here on we
    // trust the in-memory map and skip the bootstrap path entirely.
    this.bootstrapped = true;
  }

  lookup(itemId: string, now: number): LedgerLookupResult {
    let entry = this.entries.get(itemId);
    if (!entry && !this.bootstrapped) {
      this.bootstrap(now);
      entry = this.entries.get(itemId);
    }
    if (!entry) return { status: 'missing' };
    if (entry.expires_at < now) return { status: 'expired', entry };
    return { status: 'hit', entry };
  }

  prune(now: number): void {
    for (const [id, entry] of this.entries) {
      if (entry.expires_at < now) this.entries.delete(id);
    }
  }

  /** Test/diagnostic hook. */
  size(): number {
    return this.entries.size;
  }

  /**
   * Lazy bootstrap — scan the CLI's broadcast cache once and seed the in-memory
   * map. Only invoked when the first `lookup` returns missing before any
   * `record` has happened. Subsequent calls short-circuit via `bootstrapped`.
   */
  private bootstrap(now: number): void {
    this.bootstrapped = true;
    if (!fs.existsSync(this.broadcastsDir)) {
      this.logger.debug(`LedgerStore: bootstrap skipped, broadcasts dir absent: ${this.broadcastsDir}`);
      return;
    }
    const cutoff = now - LEDGER_TTL_MS;
    let loaded = 0;
    try {
      const dateDirs = fs.readdirSync(this.broadcastsDir).filter((d) => /^\d{8}$/.test(d));
      for (const dateDir of dateDirs) {
        const dirPath = path.join(this.broadcastsDir, dateDir);
        let files: string[];
        try {
          files = fs.readdirSync(dirPath);
        } catch {
          continue;
        }
        for (const file of files) {
          if (!file.startsWith('feeds-') || !file.endsWith('.json')) continue;
          const filePath = path.join(dirPath, file);
          try {
            const stat = fs.statSync(filePath);
            if (stat.mtimeMs < cutoff) continue;
            const raw = fs.readFileSync(filePath, 'utf-8');
            const parsed = JSON.parse(raw) as
              | { items?: unknown; impression_id?: unknown; data?: { items?: unknown; impression_id?: unknown } };
            // The cache file is the inner FeedResponseData shape; older
            // formats may wrap it in `data:`. Accept both.
            const items: unknown =
              (parsed && Array.isArray((parsed as { items?: unknown }).items) && (parsed as { items: unknown }).items) ||
              (parsed && parsed.data && Array.isArray((parsed.data as { items?: unknown }).items) && (parsed.data as { items: unknown }).items) ||
              undefined;
            if (!Array.isArray(items)) continue;
            const rawImpression =
              (parsed as { impression_id?: unknown }).impression_id ??
              (parsed.data as { impression_id?: unknown } | undefined)?.impression_id;
            const impressionId = typeof rawImpression === 'string' ? rawImpression : undefined;
            for (const item of items as FeedItemLike[]) {
              if (!item || typeof item.item_id !== 'string' || !item.item_id) continue;
              // Use file mtime as fetched_at proxy. expires_at follows TTL.
              const fetchedAt = Math.floor(stat.mtimeMs);
              const existing = this.entries.get(item.item_id);
              // Prefer the freshest known fetch time for an id.
              if (existing && existing.fetched_at >= fetchedAt) continue;
              this.entries.set(item.item_id, {
                item_id: item.item_id,
                server_id: this.serverId,
                short_title: makeShortTitle(item),
                fetched_at: fetchedAt,
                expires_at: fetchedAt + LEDGER_TTL_MS,
                impression_id: impressionId,
              });
              loaded += 1;
            }
          } catch (err) {
            this.logger.debug(
              `LedgerStore: bootstrap skipping ${filePath}: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }
      }
    } catch (err) {
      this.logger.warn(
        `LedgerStore: bootstrap scan failed in ${this.broadcastsDir}: ${err instanceof Error ? err.message : String(err)}`
      );
      return;
    }
    if (loaded > 0) {
      this.logger.info(`LedgerStore: bootstrapped ${loaded} entries from CLI broadcast cache`);
    }
  }
}
