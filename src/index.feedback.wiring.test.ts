/**
 * Smoke test for the downsunk feedback wiring: the followup tool shells out to
 * `eigenflux feed event record`, and the resident flush loop drives `eigenflux
 * feed event flush`. Both delegate all queue/dedup logic to the CLI — this test
 * asserts the plugin builds the right argv and passes the CLI's JSON through,
 * without any in-plugin ledger/queue.
 */

import { Logger } from './logger';
import type { CliResult } from './cli-executor';

jest.mock('./cli-executor');
import { execEigenflux } from './cli-executor';
import { handleFollowup, FollowupDeps, FollowupResult } from './feedback-tool';
import { FeedbackFlushLoop } from './feedback-flush-loop';

const execMock = execEigenflux as jest.MockedFunction<typeof execEigenflux>;

function createLogger(): Logger {
  return new Logger({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() });
}

/** Await the microtasks a self-scheduling flush tick chains through. */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('feedback collection wiring (downsunk to CLI)', () => {
  let deps: FollowupDeps;

  beforeEach(() => {
    execMock.mockReset();
    deps = { eigenfluxBin: 'eigenflux', serverName: 'srv', logger: createLogger() };
  });

  test('batch surface then single follow-up each shell out to `feed event record`', async () => {
    execMock.mockResolvedValue({ kind: 'success', data: { ok: true, accepted: 3, results: [] } } as CliResult<FollowupResult>);

    // Delivery turn: agent calls the tool ONCE with all surfaced item_ids.
    const surfaceBatch = await handleFollowup(deps, {
      item_ids: ['item-a', 'item-b', 'item-c'],
      kind: 'surface',
    });
    expect(surfaceBatch.ok).toBe(true);
    expect(surfaceBatch.accepted).toBe(3);

    const surfaceArgs = execMock.mock.calls[0][1];
    expect(surfaceArgs.slice(0, 3)).toEqual(['feed', 'event', 'record']);
    expect(surfaceArgs[surfaceArgs.indexOf('--item-ids') + 1]).toBe('item-a,item-b,item-c');
    expect(surfaceArgs[surfaceArgs.indexOf('--kind') + 1]).toBe('surface');

    // Later main session: user follows up on item-a with kind=question.
    execMock.mockResolvedValue({ kind: 'success', data: { ok: true, accepted: 1, results: [] } } as CliResult<FollowupResult>);
    const followup = await handleFollowup(deps, {
      item_id: 'item-a',
      kind: 'question',
      brief: 'user asked for clarification on rust async',
    });
    expect(followup.accepted).toBe(1);

    const followupArgs = execMock.mock.calls[1][1];
    expect(followupArgs[followupArgs.indexOf('--item-ids') + 1]).toBe('item-a');
    expect(followupArgs[followupArgs.indexOf('--kind') + 1]).toBe('question');
    expect(followupArgs).toContain('--brief');
  });

  test('an unknown item_id per-item error from the CLI is surfaced verbatim', async () => {
    execMock.mockResolvedValue({
      kind: 'success',
      data: {
        ok: true,
        accepted: 1,
        results: [
          { item_id: 'item-a', ok: true, dedup_key: 'k' },
          { item_id: 'hallucinated', ok: false, error: 'unknown_item' },
        ],
      },
    } as CliResult<FollowupResult>);

    const result = await handleFollowup(deps, {
      item_ids: ['item-a', 'hallucinated'],
      kind: 'surface',
    });
    expect(result.ok).toBe(true);
    expect(result.accepted).toBe(1);
    expect(result.results).toEqual([
      { item_id: 'item-a', ok: true, dedup_key: 'k' },
      { item_id: 'hallucinated', ok: false, error: 'unknown_item' },
    ]);
  });

  test('flush loop drives `feed event flush` for the server on start', async () => {
    execMock.mockResolvedValue({ kind: 'success', data: { flushed: 4, remaining: 0, ok: true } } as CliResult<unknown>);
    const loop = new FeedbackFlushLoop({ serverName: 'srv', eigenfluxBin: 'eigenflux', logger: createLogger() });

    loop.start();
    await flushMicrotasks();
    loop.stop();

    expect(execMock).toHaveBeenCalledTimes(1);
    const [bin, args] = execMock.mock.calls[0];
    expect(bin).toBe('eigenflux');
    expect(args).toEqual(['feed', 'event', 'flush', '-s', 'srv']);
  });
});
