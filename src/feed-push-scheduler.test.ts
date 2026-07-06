import { FeedPushScheduler } from './feed-push-scheduler';
import { Logger } from './logger';

function createLogger(): Logger {
  return new Logger({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  });
}

describe('FeedPushScheduler', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function createScheduler(overrides: {
    isBusy?: jest.Mock;
    pushNow?: jest.Mock;
    recheckMs?: number;
    budgetMs?: number;
  } = {}) {
    const isBusy = overrides.isBusy ?? jest.fn().mockResolvedValue(false);
    const pushNow = overrides.pushNow ?? jest.fn().mockResolvedValue(undefined);
    const scheduler = new FeedPushScheduler({
      isBusy,
      pushNow,
      logger: createLogger(),
      serverName: 'eigenflux',
      recheckMs: overrides.recheckMs ?? 30_000,
      budgetMs: overrides.budgetMs ?? 600_000,
    });
    return { scheduler, isBusy, pushNow };
  }

  test('idle → pushes immediately, no timer involved', async () => {
    const { scheduler, pushNow } = createScheduler();

    scheduler.schedule('[FEED] batch-1');
    await jest.advanceTimersByTimeAsync(0); // flush the immediate attempt

    expect(pushNow).toHaveBeenCalledTimes(1);
    expect(pushNow).toHaveBeenCalledWith('[FEED] batch-1');
  });

  test('busy → defers on a recheck timer, pushes once idle', async () => {
    const isBusy = jest
      .fn()
      .mockResolvedValueOnce(true) // initial attempt: busy
      .mockResolvedValueOnce(true) // +30s: still busy
      .mockResolvedValue(false);   // +60s: idle
    const { scheduler, pushNow } = createScheduler({ isBusy });

    scheduler.schedule('[FEED] batch-1');
    await jest.advanceTimersByTimeAsync(0);
    expect(pushNow).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(30_000);
    expect(pushNow).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(30_000);
    expect(pushNow).toHaveBeenCalledTimes(1);
    expect(pushNow).toHaveBeenCalledWith('[FEED] batch-1');
  });

  test('newer poll supersedes the held payload — only the latest batch is pushed', async () => {
    const isBusy = jest
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValue(false);
    const { scheduler, pushNow } = createScheduler({ isBusy });

    scheduler.schedule('[FEED] batch-1');
    await jest.advanceTimersByTimeAsync(0); // busy → held
    scheduler.schedule('[FEED] batch-2');   // supersede while waiting

    await jest.advanceTimersByTimeAsync(30_000); // idle now
    expect(pushNow).toHaveBeenCalledTimes(1);
    expect(pushNow).toHaveBeenCalledWith('[FEED] batch-2');
  });

  test('budget exhausted while busy → pushes anyway (never strands)', async () => {
    const isBusy = jest.fn().mockResolvedValue(true); // busy forever
    const { scheduler, pushNow } = createScheduler({
      isBusy,
      budgetMs: 90_000, // 3 rechecks at 30s
    });

    scheduler.schedule('[FEED] batch-1');
    await jest.advanceTimersByTimeAsync(0);
    await jest.advanceTimersByTimeAsync(30_000);
    await jest.advanceTimersByTimeAsync(30_000);
    expect(pushNow).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(30_000); // waited >= budget

    expect(pushNow).toHaveBeenCalledTimes(1);
    expect(pushNow).toHaveBeenCalledWith('[FEED] batch-1');
  });

  test('isBusy throwing degrades to an immediate push (pre-scheduler behavior)', async () => {
    const isBusy = jest.fn().mockRejectedValue(new Error('api unavailable'));
    const { scheduler, pushNow } = createScheduler({ isBusy });

    scheduler.schedule('[FEED] batch-1');
    await jest.advanceTimersByTimeAsync(0);

    expect(pushNow).toHaveBeenCalledTimes(1);
  });

  test('stop() cancels the pending payload and recheck timer', async () => {
    const isBusy = jest.fn().mockResolvedValue(true);
    const { scheduler, pushNow } = createScheduler({ isBusy });

    scheduler.schedule('[FEED] batch-1');
    await jest.advanceTimersByTimeAsync(0); // busy → timer armed
    scheduler.stop();

    await jest.advanceTimersByTimeAsync(600_000);
    expect(pushNow).not.toHaveBeenCalled();
  });
});
