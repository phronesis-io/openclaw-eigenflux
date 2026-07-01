import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Logger } from './logger';
import { LedgerStore } from './feedback-ledger';
import { FeedbackEventQueue } from './feedback-queue';
import {
  handleFollowup,
  validateInput,
  computeDedupKey,
  FOLLOWUP_KINDS,
  FollowupDeps,
} from './feedback-tool';

function createLogger(): Logger {
  return new Logger({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() });
}

describe('validateInput', () => {
  test('rejects missing item_id and item_ids', () => {
    expect(validateInput({ kind: 'surface' })).toMatchObject({ error: 'invalid_params' });
  });
  test('rejects empty/whitespace item_id', () => {
    expect(validateInput({ item_id: '   ', kind: 'surface' })).toMatchObject({ error: 'invalid_params' });
  });
  test('rejects unknown kind', () => {
    expect(validateInput({ item_id: 'a', kind: 'bogus' })).toMatchObject({ error: 'invalid_params' });
  });
  test('accepts scalar item_id and normalizes to item_ids', () => {
    const r = validateInput({ item_id: ' a1 ', kind: 'surface' });
    expect(r).toMatchObject({ item_ids: ['a1'], kind: 'surface' });
  });
  test('accepts item_ids array', () => {
    const r = validateInput({ item_ids: ['a', 'b', ' c '], kind: 'surface' });
    expect(r).toMatchObject({ item_ids: ['a', 'b', 'c'], kind: 'surface' });
  });
  test('item_ids deduplicates within a single call', () => {
    const r = validateInput({ item_ids: ['a', 'a', 'b'], kind: 'surface' }) as { item_ids: string[] };
    expect(r.item_ids).toEqual(['a', 'b']);
  });
  test('item_ids drops blank entries', () => {
    const r = validateInput({ item_ids: ['a', '', '  ', 'b'], kind: 'surface' }) as { item_ids: string[] };
    expect(r.item_ids).toEqual(['a', 'b']);
  });
  test('item_ids wins when both scalar and array are supplied', () => {
    const r = validateInput({ item_id: 'scalar', item_ids: ['a'], kind: 'surface' });
    expect(r).toMatchObject({ item_ids: ['a'] });
  });
  test('rejects non-string entries in item_ids', () => {
    expect(validateInput({ item_ids: ['a', 42, 'b'], kind: 'surface' })).toMatchObject({ error: 'invalid_params' });
  });
  test('rejects empty item_ids array', () => {
    expect(validateInput({ item_ids: [], kind: 'surface' })).toMatchObject({ error: 'invalid_params' });
  });
  test('rejects item_ids exceeding batch limit', () => {
    const big = Array.from({ length: 60 }, (_, i) => `i${i}`);
    expect(validateInput({ item_ids: big, kind: 'surface' })).toMatchObject({ error: 'invalid_params' });
  });
  test('truncates brief to 200 chars', () => {
    const long = 'x'.repeat(500);
    const r = validateInput({ item_id: 'a', kind: 'surface', brief: long }) as { brief: string };
    expect(r.brief.length).toBe(200);
  });
  test('all four FOLLOWUP_KINDS pass validation', () => {
    for (const k of FOLLOWUP_KINDS) {
      expect(validateInput({ item_id: 'a', kind: k })).toMatchObject({ kind: k });
    }
  });
});

describe('computeDedupKey', () => {
  test('same hour bucket yields same key', () => {
    const t1 = 1_700_000_000_000;
    const t2 = t1 + 60_000;
    expect(computeDedupKey('u', 'a', 'surface', t1)).toBe(computeDedupKey('u', 'a', 'surface', t2));
  });
  test('different hour bucket yields different key', () => {
    const t1 = 1_700_000_000_000;
    const t2 = t1 + 2 * 60 * 60 * 1000;
    expect(computeDedupKey('u', 'a', 'surface', t1)).not.toBe(computeDedupKey('u', 'a', 'surface', t2));
  });
  test('different kind yields different key', () => {
    const t = 1_700_000_000_000;
    expect(computeDedupKey('u', 'a', 'surface', t)).not.toBe(computeDedupKey('u', 'a', 'task', t));
  });
  test('different user yields different key', () => {
    const t = 1_700_000_000_000;
    expect(computeDedupKey('u1', 'a', 'surface', t)).not.toBe(computeDedupKey('u2', 'a', 'surface', t));
  });
});

describe('handleFollowup', () => {
  let tmp: string;
  let ledger: LedgerStore;
  let queue: FeedbackEventQueue;
  let deps: FollowupDeps;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ftool-'));
    ledger = new LedgerStore(path.join(tmp, 'broadcasts'), 'srv-a', createLogger());
    queue = new FeedbackEventQueue(
      { storageFile: path.join(tmp, 'q.json'), eigenfluxBin: 'eigenflux' },
      createLogger()
    );
    deps = {
      ledger,
      queue,
      resolveContext: () => ({ userId: 'u1', sessionKey: 'sess', channel: 'feed' }),
      now: () => 1_000_000,
      defaultServerId: 'srv-default',
      logger: createLogger(),
    };
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('returns invalid_params on bad input', async () => {
    const r = await handleFollowup(deps, { kind: 'surface' });
    expect(r).toEqual({ ok: false, error: 'invalid_params' });
    expect(queue.size()).toBe(0);
  });

  test('per-item unknown_item when ledger has no match (scalar input)', async () => {
    const r = await handleFollowup(deps, { item_id: 'nope', kind: 'surface' });
    expect(r.ok).toBe(true);
    expect(r.accepted).toBe(0);
    expect(r.results).toEqual([{ item_id: 'nope', ok: false, error: 'unknown_item' }]);
    expect(queue.size()).toBe(0);
  });

  test('per-item expired when ledger entry has aged past TTL', async () => {
    ledger.record([{ item_id: 'a1' }], 'srv-a', 1_000_000);
    const future = 1_000_000 + 30 * 24 * 60 * 60 * 1000;
    const futureDeps = { ...deps, now: () => future };
    const r = await futureDeps && (await handleFollowup(futureDeps, { item_id: 'a1', kind: 'surface' }));
    expect(r.ok).toBe(true);
    expect(r.accepted).toBe(0);
    expect(r.results).toEqual([{ item_id: 'a1', ok: false, error: 'expired' }]);
    expect(queue.size()).toBe(0);
  });

  test('scalar input enqueues a single event with dedup_key', async () => {
    ledger.record([{ item_id: 'a1' }], 'srv-a', 1_000_000);
    const r = await handleFollowup(deps, { item_id: 'a1', kind: 'task', brief: 'wrote up' });
    expect(r.ok).toBe(true);
    expect(r.accepted).toBe(1);
    expect(r.results?.length).toBe(1);
    expect(r.results?.[0]).toMatchObject({ item_id: 'a1', ok: true });
    expect(typeof r.results?.[0].dedup_key).toBe('string');
    expect(queue.size()).toBe(1);
  });

  test('batch input enqueues one event per known item, skips unknowns', async () => {
    ledger.record([{ item_id: 'a1' }, { item_id: 'a2' }], 'srv-a', 1_000_000);
    const r = await handleFollowup(deps, {
      item_ids: ['a1', 'a2', 'ghost'],
      kind: 'surface',
    });
    expect(r.ok).toBe(true);
    expect(r.accepted).toBe(2);
    expect(r.results).toEqual([
      { item_id: 'a1', ok: true, dedup_key: expect.any(String) },
      { item_id: 'a2', ok: true, dedup_key: expect.any(String) },
      { item_id: 'ghost', ok: false, error: 'unknown_item' },
    ]);
    expect(queue.size()).toBe(2);
  });

  test('batch input yields distinct dedup_keys per item under the same kind/hour', async () => {
    ledger.record([{ item_id: 'a1' }, { item_id: 'a2' }], 'srv-a', 1_000_000);
    const r = await handleFollowup(deps, { item_ids: ['a1', 'a2'], kind: 'surface' });
    expect(r.results?.[0].dedup_key).not.toBe(r.results?.[1].dedup_key);
  });

  test('uses ledger server_id when not supplied by agent', async () => {
    ledger.record([{ item_id: 'a1' }], 'srv-a', 1_000_000);
    await handleFollowup(deps, { item_id: 'a1', kind: 'surface' });
    const persisted = JSON.parse(fs.readFileSync(path.join(tmp, 'q.json'), 'utf-8'));
    expect(persisted.events[0].server_id).toBe('srv-a');
  });

  test('respects explicit server_id override across the whole batch', async () => {
    ledger.record([{ item_id: 'a1' }, { item_id: 'a2' }], 'srv-a', 1_000_000);
    await handleFollowup(deps, { item_ids: ['a1', 'a2'], kind: 'surface', server_id: 'srv-override' });
    const persisted = JSON.parse(fs.readFileSync(path.join(tmp, 'q.json'), 'utf-8'));
    expect(persisted.events.map((e: { server_id: string }) => e.server_id)).toEqual([
      'srv-override',
      'srv-override',
    ]);
  });

  test('propagates session_key and channel from context to every queued event', async () => {
    ledger.record([{ item_id: 'a1' }, { item_id: 'a2' }], 'srv-a', 1_000_000);
    await handleFollowup(deps, { item_ids: ['a1', 'a2'], kind: 'surface' });
    const persisted = JSON.parse(fs.readFileSync(path.join(tmp, 'q.json'), 'utf-8'));
    expect(persisted.events.every((e: { session_key: string }) => e.session_key === 'sess')).toBe(true);
    expect(persisted.events.every((e: { channel: string }) => e.channel === 'feed')).toBe(true);
  });

  test('carries impression_id from the ledger onto every queued event', async () => {
    ledger.record([{ item_id: 'a1' }, { item_id: 'a2' }], 'srv-a', 1_000_000, 'imp-42');
    await handleFollowup(deps, { item_ids: ['a1', 'a2'], kind: 'surface' });
    const persisted = JSON.parse(fs.readFileSync(path.join(tmp, 'q.json'), 'utf-8'));
    expect(persisted.events.map((e: { impression_id?: string }) => e.impression_id)).toEqual([
      'imp-42',
      'imp-42',
    ]);
  });

  test('omits impression_id when the ledger entry has none', async () => {
    ledger.record([{ item_id: 'a1' }], 'srv-a', 1_000_000);
    await handleFollowup(deps, { item_id: 'a1', kind: 'surface' });
    const persisted = JSON.parse(fs.readFileSync(path.join(tmp, 'q.json'), 'utf-8'));
    expect(persisted.events[0].impression_id).toBeUndefined();
  });
});
