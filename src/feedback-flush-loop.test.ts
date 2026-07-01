import { Logger } from './logger';
import type { CliResult } from './cli-executor';

jest.mock('./cli-executor');
import { execEigenflux } from './cli-executor';
import {
  FeedbackFlushLoop,
  DEFAULT_BASE_BACKOFF_MS,
  DEFAULT_MAX_BACKOFF_MS,
} from './feedback-flush-loop';

const execMock = execEigenflux as jest.MockedFunction<typeof execEigenflux>;

function createLogger(): Logger {
  return new Logger({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() });
}

function flushResult(data: { flushed?: number; remaining?: number; ok?: boolean }): CliResult<unknown> {
  return { kind: 'success', data } as CliResult<unknown>;
}

/** Drain the promise chain a self-scheduling tick creates. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

function makeLoop(): FeedbackFlushLoop {
  return new FeedbackFlushLoop({ serverName: 'srv', eigenfluxBin: 'eigenflux', logger: createLogger() });
}

describe('FeedbackFlushLoop', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    execMock.mockReset();
  });
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  test('start() flushes once immediately with the right argv', async () => {
    execMock.mockResolvedValue(flushResult({ flushed: 0, remaining: 0, ok: true }));
    const loop = makeLoop();
    loop.start();
    await settle();

    expect(execMock).toHaveBeenCalledTimes(1);
    expect(execMock.mock.calls[0][1]).toEqual(['feed', 'event', 'flush', '-s', 'srv']);
    loop.stop();
  });

  test('a clean flush (remaining=0) does not schedule a retry', async () => {
    execMock.mockResolvedValue(flushResult({ flushed: 3, remaining: 0, ok: true }));
    const loop = makeLoop();
    loop.start();
    await settle();
    expect(execMock).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(DEFAULT_MAX_BACKOFF_MS);
    await settle();
    expect(execMock).toHaveBeenCalledTimes(1);
    loop.stop();
  });

  test('remaining>0 with ok=false retries after exponential back-off (5s → 10s), capped at 5min', async () => {
    execMock.mockResolvedValue(flushResult({ flushed: 0, remaining: 2, ok: false }));
    const loop = makeLoop();
    loop.start();
    await settle();
    expect(execMock).toHaveBeenCalledTimes(1); // immediate tick

    // First retry after base back-off (5s).
    jest.advanceTimersByTime(DEFAULT_BASE_BACKOFF_MS);
    await settle();
    expect(execMock).toHaveBeenCalledTimes(2);

    // Second retry after doubled back-off (10s), not yet at 5s.
    jest.advanceTimersByTime(DEFAULT_BASE_BACKOFF_MS);
    await settle();
    expect(execMock).toHaveBeenCalledTimes(2);
    jest.advanceTimersByTime(DEFAULT_BASE_BACKOFF_MS);
    await settle();
    expect(execMock).toHaveBeenCalledTimes(3);

    loop.stop();
  });

  test('back-off does not exceed the 5min cap', async () => {
    execMock.mockResolvedValue(flushResult({ flushed: 0, remaining: 1, ok: false }));
    const loop = makeLoop();
    loop.start();
    await settle();

    // Advance through many failed retries; each doubles until capped.
    for (let i = 0; i < 12; i += 1) {
      jest.advanceTimersByTime(DEFAULT_MAX_BACKOFF_MS);
      await settle();
    }
    // After capping, one advance of exactly the cap triggers exactly one retry.
    const before = execMock.mock.calls.length;
    jest.advanceTimersByTime(DEFAULT_MAX_BACKOFF_MS);
    await settle();
    expect(execMock.mock.calls.length).toBe(before + 1);
    loop.stop();
  });

  test('a successful flush after failures resets the back-off', async () => {
    execMock.mockResolvedValueOnce(flushResult({ flushed: 0, remaining: 2, ok: false }));
    const loop = makeLoop();
    loop.start();
    await settle();
    expect(execMock).toHaveBeenCalledTimes(1);

    // Next scheduled tick succeeds cleanly → no further retries armed.
    execMock.mockResolvedValue(flushResult({ flushed: 2, remaining: 0, ok: true }));
    jest.advanceTimersByTime(DEFAULT_BASE_BACKOFF_MS);
    await settle();
    expect(execMock).toHaveBeenCalledTimes(2);

    jest.advanceTimersByTime(DEFAULT_MAX_BACKOFF_MS);
    await settle();
    expect(execMock).toHaveBeenCalledTimes(2);
    loop.stop();
  });

  test('stop() cancels a pending retry timer', async () => {
    execMock.mockResolvedValue(flushResult({ flushed: 0, remaining: 1, ok: false }));
    const loop = makeLoop();
    loop.start();
    await settle();
    expect(execMock).toHaveBeenCalledTimes(1);

    loop.stop();
    jest.advanceTimersByTime(DEFAULT_MAX_BACKOFF_MS * 2);
    await settle();
    expect(execMock).toHaveBeenCalledTimes(1);
  });

  test('kick() triggers an immediate flush and coalesces a pending retry', async () => {
    execMock.mockResolvedValue(flushResult({ flushed: 0, remaining: 1, ok: false }));
    const loop = makeLoop();
    loop.start();
    await settle();
    expect(execMock).toHaveBeenCalledTimes(1);

    loop.kick();
    await settle();
    expect(execMock).toHaveBeenCalledTimes(2);
    loop.stop();
  });

  test('kick() on a stopped loop is a no-op', async () => {
    const loop = makeLoop();
    loop.kick();
    await settle();
    expect(execMock).not.toHaveBeenCalled();
  });
});
