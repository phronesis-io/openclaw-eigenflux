/**
 * Smoke test for the feedback collection wiring: a poll-shaped item flow
 * populates the ledger so the tool's pure handler can record events into the
 * queue, and a flush drains them through the mocked CLI. This stays at the
 * component-composition level (no plugin registration harness) — for that
 * we'd need to spin up the OpenClawPluginApi, which the wider integration
 * test already exercises.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Logger } from './logger';
import type { CliResult } from './cli-executor';
import { LedgerStore } from './feedback-ledger';
import { FeedbackEventQueue } from './feedback-queue';
import { handleFollowup, FollowupDeps } from './feedback-tool';
import type { FeedItem } from './polling-client';

jest.mock('./cli-executor');
import { execEigenflux } from './cli-executor';
const execMock = execEigenflux as jest.MockedFunction<typeof execEigenflux>;

function createLogger(): Logger {
  return new Logger({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() });
}

function makeItem(id: string, summary: string): FeedItem {
  return {
    item_id: id,
    summary,
    broadcast_type: 'general',
    updated_at: 0,
  };
}

describe('feedback collection wiring', () => {
  let dir: string;
  let ledger: LedgerStore;
  let queue: FeedbackEventQueue;
  let deps: FollowupDeps;

  beforeEach(() => {
    execMock.mockReset();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fwiring-'));
    ledger = new LedgerStore(path.join(dir, 'broadcasts'), 'srv', createLogger());
    queue = new FeedbackEventQueue(
      { storageFile: path.join(dir, 'queue.json'), eigenfluxBin: 'eigenflux' },
      createLogger()
    );
    deps = {
      ledger,
      queue,
      resolveContext: () => ({ userId: 'agent-42', sessionKey: 'sess', channel: 'feed' }),
      now: () => 1_000_000,
      defaultServerId: 'srv',
      logger: createLogger(),
    };
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('poll → ledger → batch surface tool call → single follow-up → CLI flush drains', async () => {
    // Simulate the onFeedPolled ingestion: items come in from a poll.
    const items: FeedItem[] = [
      makeItem('item-a', 'Rust async deep dive'),
      makeItem('item-b', 'Apple unveils new pencil'),
      makeItem('item-c', 'Latency improvement in postgres'),
    ];
    ledger.record(items, 'srv', 1_000_000);

    // Delivery turn: agent calls the tool ONCE with all surfaced item_ids.
    const surfaceBatch = await handleFollowup(deps, {
      item_ids: ['item-a', 'item-b', 'item-c'],
      kind: 'surface',
    });
    expect(surfaceBatch.ok).toBe(true);
    expect(surfaceBatch.accepted).toBe(3);
    expect(surfaceBatch.results?.every((r) => r.ok)).toBe(true);

    // Later main session: user follows up on item-a; agent calls with kind='question'.
    const followup = await handleFollowup(deps, {
      item_id: 'item-a',
      kind: 'question',
      brief: 'user asked for clarification on rust async',
    });
    expect(followup.ok).toBe(true);
    expect(followup.accepted).toBe(1);
    expect(queue.size()).toBe(4);

    // Poll cycle ends: flush drains the queue via the CLI.
    execMock.mockResolvedValue({ kind: 'success', data: { accepted: 4, deduped: 0 } } as CliResult<unknown>);
    await queue.flushNow(1_100_000);
    expect(execMock).toHaveBeenCalledTimes(1);
    const [bin, args] = execMock.mock.calls[0];
    expect(bin).toBe('eigenflux');
    expect(args.slice(0, 4)).toEqual(['feed', 'event', 'push', '--batch']);
    expect(queue.size()).toBe(0);
  });

  test('unknown item_id in a batch is reported per-item but never reaches the queue', async () => {
    ledger.record([makeItem('item-a', 'real')], 'srv', 1_000_000);
    const result = await handleFollowup(deps, {
      item_ids: ['item-a', 'hallucinated'],
      kind: 'surface',
    });
    expect(result.ok).toBe(true);
    expect(result.accepted).toBe(1);
    expect(result.results).toEqual([
      { item_id: 'item-a', ok: true, dedup_key: expect.any(String) },
      { item_id: 'hallucinated', ok: false, error: 'unknown_item' },
    ]);
    expect(queue.size()).toBe(1);
  });

  test('queue persistence survives a restart between two polling cycles', async () => {
    ledger.record([makeItem('item-a', 'x')], 'srv', 1_000_000);
    await handleFollowup(deps, { item_id: 'item-a', kind: 'surface' });
    expect(queue.size()).toBe(1);

    // Simulate plugin restart: new queue loads from disk
    const queue2 = new FeedbackEventQueue(
      { storageFile: path.join(dir, 'queue.json'), eigenfluxBin: 'eigenflux' },
      createLogger()
    );
    expect(queue2.size()).toBe(1);

    execMock.mockResolvedValue({ kind: 'success', data: null } as CliResult<unknown>);
    await queue2.flushNow(2_000_000);
    expect(queue2.size()).toBe(0);
  });
});
