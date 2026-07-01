/**
 * Pure handler for the eigenflux__followup tool. The OpenClaw tool object is
 * registered in index.ts and delegates here so the validation/dedup/lookup
 * logic stays unit-testable independent of the plugin runtime.
 */

import * as crypto from 'crypto';
import { Logger } from './logger';
import { LedgerStore } from './feedback-ledger';
import { FeedbackEventQueue, FeedbackEvent, FeedbackEventKind } from './feedback-queue';

export const FOLLOWUP_KINDS: ReadonlyArray<FeedbackEventKind> = [
  'surface',
  'question',
  'discussion',
  'task',
];

export interface FollowupInput {
  item_id?: unknown;
  item_ids?: unknown;
  kind?: unknown;
  brief?: unknown;
  server_id?: unknown;
}

export interface FollowupNormalized {
  item_ids: string[];
  kind: FeedbackEventKind;
  brief?: string;
  server_id?: string;
}

export type FollowupItemError = 'unknown_item' | 'expired';

export interface FollowupItemResult {
  item_id: string;
  ok: boolean;
  dedup_key?: string;
  error?: FollowupItemError;
}

export interface FollowupResult {
  ok: boolean;
  error?: 'invalid_params' | 'no_runtime';
  accepted?: number;
  results?: FollowupItemResult[];
}

export interface FollowupContext {
  userId: string;
  sessionKey?: string;
  channel?: string;
}

export type ValidationFailure = { error: 'invalid_params'; reason: string };

export const BATCH_LIMIT = 50;

function normalizeItemIds(raw: FollowupInput): string[] | ValidationFailure {
  // Accept either item_id (string) or item_ids (string[]); item_ids wins when both supplied.
  if (Array.isArray(raw.item_ids)) {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const v of raw.item_ids) {
      if (typeof v !== 'string') {
        return { error: 'invalid_params', reason: 'item_ids must contain only strings' };
      }
      const trimmed = v.trim();
      if (!trimmed) continue;
      if (seen.has(trimmed)) continue;
      seen.add(trimmed);
      out.push(trimmed);
    }
    if (out.length === 0) {
      return { error: 'invalid_params', reason: 'item_ids must contain at least one non-empty string' };
    }
    if (out.length > BATCH_LIMIT) {
      return { error: 'invalid_params', reason: `item_ids exceeds batch limit of ${BATCH_LIMIT}` };
    }
    return out;
  }
  if (typeof raw.item_id === 'string' && raw.item_id.trim() !== '') {
    return [raw.item_id.trim()];
  }
  return { error: 'invalid_params', reason: 'item_id or item_ids required' };
}

export function validateInput(raw: FollowupInput): FollowupNormalized | ValidationFailure {
  const ids = normalizeItemIds(raw);
  if (!Array.isArray(ids)) return ids;
  if (typeof raw.kind !== 'string' || !FOLLOWUP_KINDS.includes(raw.kind as FeedbackEventKind)) {
    return { error: 'invalid_params', reason: `kind must be one of ${FOLLOWUP_KINDS.join('|')}` };
  }
  const brief = typeof raw.brief === 'string' ? raw.brief.slice(0, 200) : undefined;
  const server_id = typeof raw.server_id === 'string' && raw.server_id.length > 0 ? raw.server_id : undefined;
  return {
    item_ids: ids,
    kind: raw.kind as FeedbackEventKind,
    brief,
    server_id,
  };
}

export function computeDedupKey(
  userId: string,
  itemId: string,
  kind: FeedbackEventKind,
  ts: number
): string {
  const hourBucket = Math.floor(ts / (60 * 60 * 1000));
  return crypto
    .createHash('sha1')
    .update(`${userId}|${itemId}|${kind}|${hourBucket}`)
    .digest('hex')
    .slice(0, 16);
}

export interface FollowupDeps {
  ledger: LedgerStore;
  queue: FeedbackEventQueue;
  resolveContext: () => FollowupContext;
  now: () => number;
  defaultServerId: string;
  logger: Logger;
}

export async function handleFollowup(deps: FollowupDeps, raw: FollowupInput): Promise<FollowupResult> {
  const validated = validateInput(raw);
  if ('error' in validated) {
    deps.logger.debug(`followup tool: invalid params (${validated.reason})`);
    return { ok: false, error: 'invalid_params' };
  }
  const now = deps.now();
  const ctx = deps.resolveContext();
  const results: FollowupItemResult[] = [];
  let accepted = 0;

  for (const itemId of validated.item_ids) {
    const lookup = deps.ledger.lookup(itemId, now);
    if (lookup.status === 'missing') {
      results.push({ item_id: itemId, ok: false, error: 'unknown_item' });
      continue;
    }
    if (lookup.status === 'expired') {
      results.push({ item_id: itemId, ok: false, error: 'expired' });
      continue;
    }
    const serverId = validated.server_id ?? lookup.entry?.server_id ?? deps.defaultServerId;
    const dedupKey = computeDedupKey(ctx.userId, itemId, validated.kind, now);
    const event: FeedbackEvent = {
      item_id: itemId,
      server_id: serverId,
      kind: validated.kind,
      brief: validated.brief,
      ts: now,
      session_key: ctx.sessionKey,
      channel: ctx.channel,
      dedup_key: dedupKey,
      impression_id: lookup.entry?.impression_id,
    };
    deps.queue.enqueue(event);
    accepted += 1;
    results.push({ item_id: itemId, ok: true, dedup_key: dedupKey });
  }

  return { ok: true, accepted, results };
}
