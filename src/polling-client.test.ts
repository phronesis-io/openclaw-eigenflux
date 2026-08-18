import {
  EigenFluxPollingClient,
  readPollIntervalSec,
  DEFAULT_POLL_INTERVAL_SEC,
  MIN_POLL_INTERVAL_SEC,
  MAX_POLL_INTERVAL_SEC,
} from './polling-client';
import { Logger } from './logger';
import type { CliResult } from './cli-executor';

jest.mock('./cli-executor');

import { execEigenflux } from './cli-executor';

const execEigenfluxMock = execEigenflux as jest.MockedFunction<typeof execEigenflux>;

function createLoggerSpies() {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };
}

function createLogger(spies = createLoggerSpies()): Logger {
  return new Logger(spies);
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('EigenFluxPollingClient', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('polls feed via CLI and forwards the full payload to callback', async () => {
    const onFeedPolled = jest.fn().mockResolvedValue(undefined);
    const onAuthRequired = jest.fn().mockResolvedValue(undefined);

    execEigenfluxMock.mockResolvedValue({
      kind: 'success',
      data: {
        items: [
          {
            item_id: 'item-101',
            group_id: 'group-101',
            summary: 'Important signal',
            broadcast_type: 'info',
            updated_at: 1760000000000,
          },
        ],
        has_more: false,
        notifications: [
          {
            notification_id: 'notif-1',
            type: 'system',
            content: 'Feed refreshed successfully',
            created_at: 1760000000100,
          },
        ],
      },
    } as CliResult<any>);

    const client = new EigenFluxPollingClient({
      serverName: 'eigenflux',
      eigenfluxBin: 'eigenflux',
      resolvePollIntervalSec: jest.fn().mockResolvedValue(60),
      logger: createLogger(),
      onFeedPolled,
      onAuthRequired,
    });

    const result = await client.pollOnce();

    expect(result).toEqual(
      expect.objectContaining({
        kind: 'success',
      })
    );
    expect(onFeedPolled).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 0,
        msg: 'success',
        data: expect.objectContaining({
          items: [
            expect.objectContaining({
              item_id: 'item-101',
              summary: 'Important signal',
            }),
          ],
          notifications: [
            expect.objectContaining({
              notification_id: 'notif-1',
            }),
          ],
        }),
      })
    );
    expect(onAuthRequired).not.toHaveBeenCalled();

    expect(execEigenfluxMock).toHaveBeenCalledWith(
      'eigenflux',
      ['feed', 'poll', '--limit', '20', '--action', 'refresh', '-s', 'eigenflux', '-f', 'json'],
      expect.objectContaining({ logger: expect.any(Logger) })
    );
  });

  test('recognizes a durable Feed V2 batch and forwards its control-context envelope', async () => {
    const onFeedPolled = jest.fn().mockResolvedValue(undefined);
    execEigenfluxMock.mockResolvedValue({
      kind: 'success',
      data: {
        schema_version: 'feed_batch.v2',
        batch_id: '42',
        items: [{ batch_item_id: '7', source_ref: { type: 'broadcast', id: '9' } }],
        has_more: false,
        personalization: {
          mode: 'intent_aligned',
          onboarding_state: 'completed',
          context_revision: 3,
        },
        control_context_snapshot: { network_goal: { text: 'Find collaborators' } },
      },
    } as CliResult<any>);

    const client = new EigenFluxPollingClient({
      serverName: 'eigenflux',
      eigenfluxBin: 'eigenflux',
      resolvePollIntervalSec: jest.fn().mockResolvedValue(600),
      logger: createLogger(),
      onFeedPolled,
      onAuthRequired: jest.fn().mockResolvedValue(undefined),
    });

    const result = await client.pollOnce();

    expect(result.kind).toBe('success');
    expect(onFeedPolled).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          schema_version: 'feed_batch.v2',
          batch_id: '42',
          control_context_snapshot: expect.objectContaining({
            network_goal: { text: 'Find collaborators' },
          }),
        }),
      })
    );
  });

  test('emits auth-required callback when CLI returns auth_required', async () => {
    const onFeedPolled = jest.fn().mockResolvedValue(undefined);
    const onAuthRequired = jest.fn().mockResolvedValue(undefined);

    execEigenfluxMock.mockResolvedValue({
      kind: 'auth_required',
      stderr: 'token expired',
    } as CliResult<any>);

    const client = new EigenFluxPollingClient({
      serverName: 'eigenflux',
      eigenfluxBin: 'eigenflux',
      resolvePollIntervalSec: jest.fn().mockResolvedValue(60),
      logger: createLogger(),
      onFeedPolled,
      onAuthRequired,
    });

    const result = await client.pollOnce();

    expect(result).toEqual({
      kind: 'auth_required',
      authEvent: {
        reason: 'auth_required',
      },
    });
    expect(onAuthRequired).toHaveBeenCalledWith({
      reason: 'auth_required',
    });
    expect(onFeedPolled).not.toHaveBeenCalled();
  });

  test('returns error result when CLI command fails', async () => {
    const loggerSpies = createLoggerSpies();

    execEigenfluxMock.mockResolvedValue({
      kind: 'error',
      error: new Error('connect ECONNREFUSED 127.0.0.1:8080'),
      exitCode: 1,
      stderr: 'connection failed',
    } as CliResult<any>);

    const client = new EigenFluxPollingClient({
      serverName: 'eigenflux',
      eigenfluxBin: 'eigenflux',
      resolvePollIntervalSec: jest.fn().mockResolvedValue(60),
      logger: createLogger(loggerSpies),
      onFeedPolled: jest.fn().mockResolvedValue(undefined),
      onAuthRequired: jest.fn().mockResolvedValue(undefined),
    });

    const result = await client.pollOnce();

    expect(result.kind).toBe('error');
  });

  test('does not re-enter feed polling while a previous poll is still running', async () => {
    const loggerSpies = createLoggerSpies();
    const cliDeferred = createDeferred<CliResult<any>>();

    execEigenfluxMock.mockReturnValue(cliDeferred.promise);

    const client = new EigenFluxPollingClient({
      serverName: 'eigenflux',
      eigenfluxBin: 'eigenflux',
      resolvePollIntervalSec: jest.fn().mockResolvedValue(60),
      logger: createLogger(loggerSpies),
      onFeedPolled: jest.fn().mockResolvedValue(undefined),
      onAuthRequired: jest.fn().mockResolvedValue(undefined),
    });

    const firstPoll = client.pollOnce();
    const secondPoll = client.pollOnce();

    expect(execEigenfluxMock).toHaveBeenCalledTimes(1);
    expect(loggerSpies.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'Skipping feed poll because a previous poll is still in progress'
      )
    );

    cliDeferred.resolve({
      kind: 'success',
      data: { items: [], has_more: false, notifications: [] },
    } as CliResult<any>);

    const [firstResult, secondResult] = await Promise.all([firstPoll, secondPoll]);
    expect(firstResult).toEqual(secondResult);
    expect(firstResult.kind).toBe('success');
  });

  test('does not notify feed callback when items and notifications are empty', async () => {
    const onFeedPolled = jest.fn().mockResolvedValue(undefined);

    execEigenfluxMock.mockResolvedValue({
      kind: 'success',
      data: { items: [], has_more: false, notifications: [] },
    } as CliResult<any>);

    const client = new EigenFluxPollingClient({
      serverName: 'eigenflux',
      eigenfluxBin: 'eigenflux',
      resolvePollIntervalSec: jest.fn().mockResolvedValue(60),
      logger: createLogger(),
      onFeedPolled,
      onAuthRequired: jest.fn().mockResolvedValue(undefined),
    });

    const result = await client.pollOnce();

    expect(result.kind).toBe('success');
    expect(onFeedPolled).not.toHaveBeenCalled();
  });

  test('always delivers an empty durable Feed V2 batch so it can be acknowledged', async () => {
    const onFeedPolled = jest.fn().mockResolvedValue(undefined);
    execEigenfluxMock.mockResolvedValue({
      kind: 'success',
      data: {
        schema_version: 'feed_batch.v2', batch_id: '42', items: [], notifications: [], has_more: false,
        personalization: { mode: 'baseline', context_revision: null },
        control_context_snapshot: null,
      },
    } as CliResult<any>);
    const client = new EigenFluxPollingClient({
      serverName: 'eigenflux', eigenfluxBin: 'eigenflux',
      resolvePollIntervalSec: jest.fn().mockResolvedValue(600), logger: createLogger(),
      onFeedPolled, onAuthRequired: jest.fn().mockResolvedValue(undefined),
    });
    await client.pollOnce();
    expect(onFeedPolled).toHaveBeenCalledTimes(1);
  });

  test('invokes onPollSuccess on every successful poll, even with empty feed', async () => {
    const onPollSuccess = jest.fn().mockResolvedValue(undefined);

    execEigenfluxMock.mockResolvedValue({
      kind: 'success',
      data: { items: [], has_more: false, notifications: [] },
    } as CliResult<any>);

    const client = new EigenFluxPollingClient({
      serverName: 'eigenflux',
      eigenfluxBin: 'eigenflux',
      resolvePollIntervalSec: jest.fn().mockResolvedValue(60),
      logger: createLogger(),
      onFeedPolled: jest.fn().mockResolvedValue(undefined),
      onAuthRequired: jest.fn().mockResolvedValue(undefined),
      onPollSuccess,
    });

    const result = await client.pollOnce();

    expect(result.kind).toBe('success');
    expect(onPollSuccess).toHaveBeenCalledTimes(1);
  });

  test('does not invoke onPollSuccess when CLI returns auth_required', async () => {
    const onPollSuccess = jest.fn().mockResolvedValue(undefined);

    execEigenfluxMock.mockResolvedValue({
      kind: 'auth_required',
      stderr: 'token expired',
    } as CliResult<any>);

    const client = new EigenFluxPollingClient({
      serverName: 'eigenflux',
      eigenfluxBin: 'eigenflux',
      resolvePollIntervalSec: jest.fn().mockResolvedValue(60),
      logger: createLogger(),
      onFeedPolled: jest.fn().mockResolvedValue(undefined),
      onAuthRequired: jest.fn().mockResolvedValue(undefined),
      onPollSuccess,
    });

    await client.pollOnce();
    expect(onPollSuccess).not.toHaveBeenCalled();
  });

  test('onPollSuccess rejection does not fail the poll', async () => {
    const loggerSpies = createLoggerSpies();
    const onPollSuccess = jest.fn().mockRejectedValue(new Error('report boom'));

    execEigenfluxMock.mockResolvedValue({
      kind: 'success',
      data: { items: [], has_more: false, notifications: [] },
    } as CliResult<any>);

    const client = new EigenFluxPollingClient({
      serverName: 'eigenflux',
      eigenfluxBin: 'eigenflux',
      resolvePollIntervalSec: jest.fn().mockResolvedValue(60),
      logger: createLogger(loggerSpies),
      onFeedPolled: jest.fn().mockResolvedValue(undefined),
      onAuthRequired: jest.fn().mockResolvedValue(undefined),
      onPollSuccess,
    });

    const result = await client.pollOnce();

    expect(result.kind).toBe('success');
    expect(loggerSpies.warn).toHaveBeenCalledWith(
      expect.stringContaining('onPollSuccess hook failed')
    );
  });

  test('re-resolves pollInterval after every poll and reschedules with the new value', async () => {
    jest.useFakeTimers();
    try {
      execEigenfluxMock.mockResolvedValue({
        kind: 'success',
        data: { items: [], has_more: false, notifications: [] },
      } as CliResult<any>);

      const resolvePollIntervalSec = jest
        .fn<Promise<number>, []>()
        .mockResolvedValueOnce(30)
        .mockResolvedValueOnce(90);

      const client = new EigenFluxPollingClient({
        serverName: 'eigenflux',
        eigenfluxBin: 'eigenflux',
        resolvePollIntervalSec,
        logger: createLogger(),
        onFeedPolled: jest.fn().mockResolvedValue(undefined),
        onAuthRequired: jest.fn().mockResolvedValue(undefined),
      });

      await client.start();
      // Initial poll + first scheduleNext should have consulted the resolver once.
      expect(resolvePollIntervalSec).toHaveBeenCalledTimes(1);
      expect(execEigenfluxMock).toHaveBeenCalledTimes(1);

      // Fire the first scheduled timer → triggers second poll, then resolver again.
      await jest.advanceTimersByTimeAsync(30_000);
      // flush pending microtasks after setTimeout callback so scheduleNext() runs
      await Promise.resolve();
      await Promise.resolve();

      expect(execEigenfluxMock).toHaveBeenCalledTimes(2);
      expect(resolvePollIntervalSec).toHaveBeenCalledTimes(2);

      client.stop();
    } finally {
      jest.useRealTimers();
    }
  });

  test('uses the stable server cadence phase to spread subsequent V2 polls', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-18T00:00:05Z'));
    try {
      execEigenfluxMock.mockResolvedValue({
        kind: 'success',
        data: {
          schema_version: 'feed_batch.v2', batch_id: '42', items: [], notifications: [], has_more: false,
          cadence: { poll_interval_seconds: 60, phase_seconds: 20 },
          personalization: { mode: 'baseline', context_revision: null }, control_context_snapshot: null,
        },
      } as CliResult<any>);
      const client = new EigenFluxPollingClient({
        serverName: 'eigenflux', eigenfluxBin: 'eigenflux',
        resolvePollIntervalSec: jest.fn().mockResolvedValue(60), logger: createLogger(),
        onFeedPolled: jest.fn().mockResolvedValue(undefined),
        onAuthRequired: jest.fn().mockResolvedValue(undefined),
      });
      await client.start();
      expect(execEigenfluxMock).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(14_000);
      expect(execEigenfluxMock).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1_000);
      expect(execEigenfluxMock).toHaveBeenCalledTimes(2);
      client.stop();
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('readPollIntervalSec', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('returns numeric value from CLI when within range', async () => {
    execEigenfluxMock.mockResolvedValue({ kind: 'success', data: 120 } as CliResult<any>);

    const interval = await readPollIntervalSec('eigenflux', 'eigenflux', createLogger());
    expect(interval).toBe(120);
    expect(execEigenfluxMock).toHaveBeenCalledWith(
      'eigenflux',
      ['config', 'get', '--key', 'feed_poll_interval', '--server', 'eigenflux', '--format', 'json'],
      expect.any(Object)
    );
  });

  test('parses numeric string values from CLI', async () => {
    execEigenfluxMock.mockResolvedValue({ kind: 'success', data: '45' } as CliResult<any>);
    const interval = await readPollIntervalSec('eigenflux', 'eigenflux', createLogger());
    expect(interval).toBe(45);
  });

  test('falls back to default when CLI returns no value', async () => {
    execEigenfluxMock.mockResolvedValue({ kind: 'success', data: undefined } as CliResult<any>);
    const interval = await readPollIntervalSec('eigenflux', 'eigenflux', createLogger());
    expect(interval).toBe(DEFAULT_POLL_INTERVAL_SEC);
  });

  test('falls back to default when CLI errors out', async () => {
    execEigenfluxMock.mockResolvedValue({
      kind: 'error',
      error: new Error('boom'),
      exitCode: 1,
      stderr: '',
    } as CliResult<any>);
    const interval = await readPollIntervalSec('eigenflux', 'eigenflux', createLogger());
    expect(interval).toBe(DEFAULT_POLL_INTERVAL_SEC);
  });

  test('falls back to default when value is below minimum', async () => {
    const spies = createLoggerSpies();
    execEigenfluxMock.mockResolvedValue({
      kind: 'success',
      data: MIN_POLL_INTERVAL_SEC - 1,
    } as CliResult<any>);
    const interval = await readPollIntervalSec('eigenflux', 'eigenflux', createLogger(spies));
    expect(interval).toBe(DEFAULT_POLL_INTERVAL_SEC);
    expect(spies.warn).toHaveBeenCalledWith(
      expect.stringContaining('outside')
    );
  });

  test('falls back to default when value is above maximum', async () => {
    execEigenfluxMock.mockResolvedValue({
      kind: 'success',
      data: MAX_POLL_INTERVAL_SEC + 1,
    } as CliResult<any>);
    const interval = await readPollIntervalSec('eigenflux', 'eigenflux', createLogger());
    expect(interval).toBe(DEFAULT_POLL_INTERVAL_SEC);
  });

  test('falls back to default when value is non-numeric', async () => {
    execEigenfluxMock.mockResolvedValue({ kind: 'success', data: 'not-a-number' } as CliResult<any>);
    const interval = await readPollIntervalSec('eigenflux', 'eigenflux', createLogger());
    expect(interval).toBe(DEFAULT_POLL_INTERVAL_SEC);
  });
});
