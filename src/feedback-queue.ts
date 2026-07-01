/**
 * Outbound queue for feedback events. Buffers in memory and on disk, then
 * flushes via the eigenflux CLI (`feed event push --batch <jsonPath>`),
 * mirroring the settings-reporter delegation pattern. Failures are retried
 * with exponential back-off and dropped after maxAge.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Logger } from './logger';
import { execEigenflux } from './cli-executor';

export type FeedbackEventKind = 'surface' | 'question' | 'discussion' | 'task';

export interface FeedbackEvent {
  item_id: string;
  server_id: string;
  kind: FeedbackEventKind;
  brief?: string;
  ts: number;
  session_key?: string;
  channel?: string;
  dedup_key: string;
  // Impression that served this item, carried from the ledger so the backend
  // can join the event back to its impression. Absent for older ledger entries.
  impression_id?: string;
}

export interface QueueOptions {
  storageFile: string;
  eigenfluxBin: string;
  batchSize?: number;
  maxAgeMs?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
}

export const DEFAULT_BATCH = 10;
export const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_BASE_BACKOFF_MS = 5_000;
export const DEFAULT_MAX_BACKOFF_MS = 5 * 60_000;

interface QueueFile {
  version: 1;
  events: FeedbackEvent[];
}

function emptyFile(): QueueFile {
  return { version: 1, events: [] };
}

export class FeedbackEventQueue {
  private readonly options: Required<QueueOptions>;
  private readonly logger: Logger;
  private data: QueueFile;
  private backoffUntil = 0;
  private currentBackoff: number;

  constructor(options: QueueOptions, logger: Logger) {
    this.options = {
      batchSize: DEFAULT_BATCH,
      maxAgeMs: DEFAULT_MAX_AGE_MS,
      baseBackoffMs: DEFAULT_BASE_BACKOFF_MS,
      maxBackoffMs: DEFAULT_MAX_BACKOFF_MS,
      ...options,
    } as Required<QueueOptions>;
    this.logger = logger;
    this.currentBackoff = this.options.baseBackoffMs;
    this.data = this.load();
  }

  private load(): QueueFile {
    try {
      if (!fs.existsSync(this.options.storageFile)) return emptyFile();
      const parsed = JSON.parse(fs.readFileSync(this.options.storageFile, 'utf-8')) as QueueFile;
      if (parsed && Array.isArray(parsed.events)) return parsed;
      return emptyFile();
    } catch (err) {
      this.logger.warn(
        `FeedbackEventQueue: failed to load ${this.options.storageFile}, starting fresh: ${err instanceof Error ? err.message : String(err)}`
      );
      return emptyFile();
    }
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.options.storageFile), { recursive: true });
      const tmp = `${this.options.storageFile}.tmp.${process.pid}.${Date.now()}`;
      fs.writeFileSync(tmp, JSON.stringify(this.data), { encoding: 'utf-8', mode: 0o600 });
      fs.renameSync(tmp, this.options.storageFile);
    } catch (err) {
      this.logger.warn(
        `FeedbackEventQueue: failed to persist ${this.options.storageFile}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  enqueue(event: FeedbackEvent): void {
    this.data.events.push(event);
    this.persist();
  }

  size(): number {
    return this.data.events.length;
  }

  async flushNow(now: number): Promise<void> {
    if (now < this.backoffUntil) return;
    if (this.data.events.length === 0) return;

    const fresh = this.data.events.filter((e) => now - e.ts <= this.options.maxAgeMs);
    if (fresh.length !== this.data.events.length) {
      this.logger.warn(
        `FeedbackEventQueue: dropped ${this.data.events.length - fresh.length} expired events`
      );
      this.data.events = fresh;
      this.persist();
    }
    if (this.data.events.length === 0) return;

    const byKey = new Map<string, FeedbackEvent>();
    for (const e of this.data.events) {
      const prev = byKey.get(e.dedup_key);
      if (!prev || e.ts > prev.ts) byKey.set(e.dedup_key, e);
    }
    const collapsed = Array.from(byKey.values());
    const batch = collapsed.slice(0, this.options.batchSize);
    const remaining = collapsed.slice(this.options.batchSize);

    const batchPath = path.join(
      path.dirname(this.options.storageFile),
      `batch-${now}-${process.pid}.json`
    );
    try {
      fs.writeFileSync(batchPath, JSON.stringify({ events: batch }), { encoding: 'utf-8', mode: 0o600 });
    } catch (err) {
      this.logger.warn(
        `FeedbackEventQueue: failed to write batch file ${batchPath}: ${err instanceof Error ? err.message : String(err)}`
      );
      return;
    }

    let result;
    try {
      result = await execEigenflux<unknown>(
        this.options.eigenfluxBin,
        ['feed', 'event', 'push', '--batch', batchPath],
        { logger: this.logger, parseJson: false }
      );
    } finally {
      try { fs.unlinkSync(batchPath); } catch { /* ignore */ }
    }

    if (result.kind === 'success') {
      this.data.events = remaining;
      this.persist();
      this.currentBackoff = this.options.baseBackoffMs;
      this.backoffUntil = 0;
    } else {
      this.logger.warn(
        `FeedbackEventQueue: push failed (kind=${result.kind}); retrying after ${this.currentBackoff}ms`
      );
      this.backoffUntil = now + this.currentBackoff;
      this.currentBackoff = Math.min(this.currentBackoff * 2, this.options.maxBackoffMs);
    }
  }
}
