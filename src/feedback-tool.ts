/**
 * Thin shell for the eigenflux__followup tool. All validation, item_id
 * verification, impression/server enrichment, dedup_key computation, queueing
 * and opportunistic flushing now live in the CLI (`eigenflux feed event
 * record`). This module only parses the tool params into CLI args, shells out
 * via execEigenflux, and hands the CLI's JSON result straight back to the
 * agent. The OpenClaw tool object is registered in index.ts and delegates here
 * so the arg-building stays unit-testable independent of the plugin runtime.
 */

import { Logger } from './logger';
import { execEigenflux } from './cli-executor';

export type FeedbackEventKind = 'surface' | 'question' | 'discussion' | 'task';

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

export type FollowupItemError = 'unknown_item' | 'expired';

export interface FollowupItemResult {
  item_id: string;
  ok: boolean;
  dedup_key?: string;
  error?: FollowupItemError;
}

/**
 * Mirrors the CLI's `feed event record` stdout JSON. `error` is only present on
 * top-level failures (invalid params / no runtime); per-item outcomes live in
 * `results`.
 */
export interface FollowupResult {
  ok: boolean;
  error?: 'invalid_params' | 'no_runtime' | 'cli_error';
  accepted?: number;
  results?: FollowupItemResult[];
}

export const BATCH_LIMIT = 50;

/**
 * Collect the item_ids from the tool params. Accepts either item_id (scalar) or
 * item_ids (array); item_ids wins when both are supplied. This is the only
 * client-side normalization we keep — the CLI still re-validates and owns all
 * verification/dedup, so this is purely to build the `--item-ids` arg.
 */
function collectItemIds(raw: FollowupInput): string[] {
  if (Array.isArray(raw.item_ids)) {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const v of raw.item_ids) {
      if (typeof v !== 'string') continue;
      const trimmed = v.trim();
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
      out.push(trimmed);
    }
    return out;
  }
  if (typeof raw.item_id === 'string' && raw.item_id.trim() !== '') {
    return [raw.item_id.trim()];
  }
  return [];
}

export interface FollowupDeps {
  eigenfluxBin: string;
  serverName: string;
  logger: Logger;
}

/**
 * Build the CLI args and shell out to `eigenflux feed event record`. Returns the
 * CLI's parsed JSON `{ ok, accepted, results }`. Verification, enrichment and
 * dedup all happen inside the CLI — the CLI returns an error for illegal
 * params, which we surface as `invalid_params`.
 */
export async function handleFollowup(deps: FollowupDeps, raw: FollowupInput): Promise<FollowupResult> {
  const itemIds = collectItemIds(raw);
  if (itemIds.length === 0) {
    deps.logger.debug('followup tool: no item_id/item_ids supplied');
    return { ok: false, error: 'invalid_params' };
  }
  const kind = typeof raw.kind === 'string' ? raw.kind : '';

  const args = [
    'feed', 'event', 'record',
    '--item-ids', itemIds.join(','),
    '--kind', kind,
    '-s', deps.serverName,
  ];
  if (typeof raw.brief === 'string' && raw.brief.trim() !== '') {
    args.push('--brief', raw.brief.slice(0, 200));
  }

  const result = await execEigenflux<FollowupResult>(deps.eigenfluxBin, args, {
    logger: deps.logger,
  });

  if (result.kind === 'success') {
    // The CLI owns the shape; pass it straight through to the agent.
    return (result.data ?? { ok: true }) as FollowupResult;
  }
  deps.logger.debug(`followup tool: CLI record failed (kind=${result.kind})`);
  return { ok: false, error: 'cli_error' };
}
