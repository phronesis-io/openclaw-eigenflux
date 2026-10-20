import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { AuthNotificationGate } from './auth-notification-gate';
import { EigenFluxNotifier } from './notifier';
import { Logger } from './logger';
import { resolveNotificationRoute } from './notification-route-resolver';
import { writeStoredNotificationRoute } from './session-route-memory';

jest.mock('./notification-route-resolver', () => ({
  isInternalSessionKey: (key: string) => key === 'main',
  resolveNotificationRoute: jest.fn(),
}));
jest.mock('./session-route-memory', () => ({ writeStoredNotificationRoute: jest.fn() }));

const resolveRoute = resolveNotificationRoute as jest.MockedFunction<typeof resolveNotificationRoute>;
const writeRoute = writeStoredNotificationRoute as jest.MockedFunction<typeof writeStoredNotificationRoute>;

beforeEach(() => {
  resolveRoute.mockReset().mockResolvedValue({ source: 'default', route: { sessionKey: 'main', agentId: 'main' } });
  writeRoute.mockReset().mockResolvedValue(true);
});

afterEach(() => jest.restoreAllMocks());

function setup(subagent: Record<string, unknown>, tasks?: unknown) {
  const system = {
    runCommandWithTimeout: jest.fn().mockResolvedValue({ code: 0 }),
    enqueueSystemEvent: jest.fn().mockReturnValue(true), requestHeartbeatNow: jest.fn(),
  };
  const logs = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const notifier = new EigenFluxNotifier({ config: {}, runtime: { subagent, system, tasks } } as unknown as OpenClawPluginApi,
    new Logger(logs),
    { sessionKey: 'main', agentId: 'main', openclawCliBin: 'openclaw' });
  const gate = new AuthNotificationGate();
  const notify = (message = 'AUTH_REQUIRED') => gate.deliver(() => notifier.deliver(message, { requireCompletion: true }));
  return { notifier, notify, system, logs };
}

function noQueuedFallback(system: ReturnType<typeof setup>['system']) {
  expect(system.runCommandWithTimeout).not.toHaveBeenCalled();
  expect(system.enqueueSystemEvent).not.toHaveBeenCalled();
  expect(system.requestHeartbeatNow).not.toHaveBeenCalled();
}

test('missing completion capability remains retryable without submitting or enqueuing', async () => {
  const run = jest.fn().mockResolvedValue({ runId: 'run-confirmed' });
  const subagent: Record<string, unknown> = { run };
  const { notify, system } = setup(subagent);
  await expect(notify()).resolves.toBe(false);
  await expect(notify()).resolves.toBe(false);
  expect(run).not.toHaveBeenCalled();
  noQueuedFallback(system);

  subagent.waitForRun = jest.fn().mockResolvedValue({ status: 'ok' });
  await expect(notify()).resolves.toBe(true);
  await expect(notify()).resolves.toBe(false);
  expect(run).toHaveBeenCalledTimes(1);
});

test('only confirmed completion starts the cooldown and coalesces concurrent sources', async () => {
  let finish!: (result: { status: string }) => void;
  let waiting!: () => void;
  const started = new Promise<void>((resolve) => { waiting = resolve; });
  const waitForRun = jest.fn().mockImplementation(() => {
    waiting();
    return new Promise((resolve) => { finish = resolve; });
  });
  const run = jest.fn().mockResolvedValue({ runId: 'run-pending' });
  const { notify, system } = setup({ run, waitForRun });
  const first = notify();
  await started;
  await expect(notify()).resolves.toBe(false);
  finish({ status: 'ok' });
  await expect(first).resolves.toBe(true);
  await expect(notify()).resolves.toBe(false);
  expect(run).toHaveBeenCalledTimes(1);
  expect(waitForRun).toHaveBeenCalledWith({ runId: 'run-pending', timeoutMs: 480_000 });
  noQueuedFallback(system);
});

test.each(['wait error', 'timeout', 'unknown status'])('%s retains the same unconfirmed run for the next attempt', async (outcome) => {
  const run = jest.fn().mockResolvedValue({ runId: 'run-pending' });
  const waitForRun = jest.fn();
  if (outcome === 'wait error') waitForRun.mockRejectedValueOnce(new Error('host unavailable'));
  else waitForRun.mockResolvedValueOnce({ status: outcome === 'timeout' ? 'timeout' : 'pending' });
  waitForRun.mockResolvedValueOnce({ status: 'ok' });
  const { notify, system } = setup({ run, waitForRun });
  await expect(notify()).resolves.toBe(false);
  await expect(notify()).resolves.toBe(true);
  await expect(notify()).resolves.toBe(false);
  expect(run).toHaveBeenCalledTimes(1);
  expect(waitForRun).toHaveBeenNthCalledWith(2, { runId: 'run-pending', timeoutMs: 480_000 });
  noQueuedFallback(system);
});

test('a completed failure permits a new attempt without a fallback run', async () => {
  const run = jest.fn().mockResolvedValueOnce({ runId: 'run-failed' }).mockResolvedValueOnce({ runId: 'run-retry' });
  const waitForRun = jest.fn().mockResolvedValueOnce({ status: 'error', error: 'delivery failed' })
    .mockResolvedValueOnce({ status: 'ok' });
  const { notify, system } = setup({ run, waitForRun });
  await expect(notify()).resolves.toBe(false);
  await expect(notify()).resolves.toBe(true);
  expect(run).toHaveBeenCalledTimes(2);
  expect(run.mock.calls[1][0].idempotencyKey).not.toBe(run.mock.calls[0][0].idempotencyKey);
  noQueuedFallback(system);
});

test('confirmed cancellation permits a later retry and cancels only the matching task', async () => {
  const run = jest.fn().mockResolvedValueOnce({ runId: 'run-cancelled' }).mockResolvedValueOnce({ runId: 'run-retry' });
  const waitForRun = jest.fn().mockResolvedValueOnce({ status: 'timeout' }).mockResolvedValueOnce({ status: 'ok' });
  const cancel = jest.fn().mockResolvedValue({ found: true, cancelled: true });
  const tasks = { runs: { bindSession: jest.fn().mockReturnValue({
    list: () => [{ id: 'task-cancelled', runId: 'run-cancelled' }], cancel,
  }) } };
  const { notify, system } = setup({ run, waitForRun }, tasks);
  await expect(notify()).resolves.toBe(false);
  await expect(notify()).resolves.toBe(true);
  expect(run).toHaveBeenCalledTimes(2);
  expect(cancel).toHaveBeenCalledWith({ taskId: 'task-cancelled', cfg: expect.anything() });
  noQueuedFallback(system);
});

test('ambiguous acceptance reuses its idempotency key instead of creating a second run', async () => {
  const run = jest.fn().mockRejectedValueOnce(new Error('acceptance response lost'))
    .mockResolvedValueOnce({ runId: 'run-accepted' });
  const waitForRun = jest.fn().mockResolvedValue({ status: 'ok' });
  const { notify, system } = setup({ run, waitForRun });
  await expect(notify()).resolves.toBe(false);
  await expect(notify()).resolves.toBe(true);
  expect(run).toHaveBeenCalledTimes(2);
  expect(run.mock.calls[1][0]).toEqual(run.mock.calls[0][0]);
  noQueuedFallback(system);
});

test('route persistence failure cannot discard a confirmed completion', async () => {
  resolveRoute.mockResolvedValue({ source: 'config', route: {
    sessionKey: 'agent:main:feishu:direct:ou_123', agentId: 'main', replyChannel: 'feishu', replyTo: 'user:ou_123',
  } });
  writeRoute.mockRejectedValue(new Error('local route store unavailable'));
  const run = jest.fn().mockResolvedValue({ runId: 'run-delivered' });
  const { notify } = setup({ run, waitForRun: jest.fn().mockResolvedValue({ status: 'ok' }) });
  await expect(notify()).resolves.toBe(true);
  await expect(notify()).resolves.toBe(false);
  expect(writeRoute).toHaveBeenCalledTimes(1);
  expect(run).toHaveBeenCalledTimes(1);
});

test.each(['missing API', 'missing record', 'succeeded', 'failed', 'query failure'])(
  'an expired unknown outcome permits another reminder when task inspection has %s', async (taskState) => {
    const clock = jest.spyOn(Date, 'now').mockReturnValue(1_000);
    const run = jest.fn().mockResolvedValueOnce({ runId: 'run-expired' }).mockResolvedValueOnce({ runId: 'run-current' });
    const waitForRun = jest.fn().mockRejectedValueOnce(new Error('completion response lost'))
      .mockResolvedValueOnce({ status: 'pending' }).mockResolvedValueOnce({ status: 'ok' });
    const list = jest.fn().mockImplementation(() => {
      if (taskState === 'query failure') throw new Error('task registry unavailable');
      return taskState === 'missing record' ? [] : [{ id: 'old-task', runId: 'run-expired', status: taskState }];
    });
    const tasks = taskState === 'missing API' ? undefined : { runs: { bindSession: jest.fn().mockReturnValue({ list }) } };
    const { notify, system, logs } = setup({ run, waitForRun }, tasks);

    await expect(notify('old instruction')).resolves.toBe(false);
    clock.mockReturnValue(16 * 60 * 1_000);
    await expect(notify('current instruction')).resolves.toBe(false);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1][0].message).toBe('current instruction');
    expect(run.mock.calls[1][0].idempotencyKey).not.toBe(run.mock.calls[0][0].idempotencyKey);
    expect(waitForRun).toHaveBeenNthCalledWith(2, { runId: 'run-current', timeoutMs: 480_000 });
    expect(logs.warn).toHaveBeenCalledWith(expect.stringContaining('outcome remains unknown and may arrive late'));

    // Abandoning the unknown result is not a delivery and cannot start cooldown.
    await expect(notify('current instruction')).resolves.toBe(true);
    await expect(notify('current instruction')).resolves.toBe(false);
    expect(run).toHaveBeenCalledTimes(2);
    expect(waitForRun).toHaveBeenNthCalledWith(3, { runId: 'run-current', timeoutMs: 480_000 });
    noQueuedFallback(system);
  }
);

test.each(['queued', 'running'])('a known %s run is not replaced after the retry deadline', async (status) => {
  const clock = jest.spyOn(Date, 'now').mockReturnValue(1_000);
  const run = jest.fn().mockResolvedValueOnce({ runId: 'run-active' }).mockResolvedValueOnce({ runId: 'run-retry' });
  const waitForRun = jest.fn().mockRejectedValueOnce(new Error('host unavailable'))
    .mockRejectedValueOnce(new Error('host still unavailable')).mockResolvedValueOnce({ status: 'ok' });
  const task = { id: 'active-task', runId: 'run-active', status };
  const list = jest.fn().mockReturnValue([task]);
  const { notify, system } = setup({ run, waitForRun }, { runs: { bindSession: jest.fn().mockReturnValue({ list }) } });

  await expect(notify()).resolves.toBe(false);
  clock.mockReturnValue(16 * 60 * 1_000);
  await expect(notify()).resolves.toBe(false);
  expect(run).toHaveBeenCalledTimes(1);
  expect(waitForRun).toHaveBeenNthCalledWith(2, { runId: 'run-active', timeoutMs: 480_000 });

  task.status = 'failed';
  await expect(notify()).resolves.toBe(true);
  expect(run).toHaveBeenCalledTimes(2);
  expect(waitForRun).toHaveBeenNthCalledWith(3, { runId: 'run-retry', timeoutMs: 480_000 });
  noQueuedFallback(system);
});

test('an active submission with a lost acceptance response keeps its idempotency key after the deadline', async () => {
  const clock = jest.spyOn(Date, 'now').mockReturnValue(1_000);
  const run = jest.fn().mockRejectedValueOnce(new Error('acceptance response lost'))
    .mockImplementationOnce(async (params) => ({ runId: params.idempotencyKey }));
  const waitForRun = jest.fn().mockResolvedValue({ status: 'ok' });
  const list = jest.fn().mockImplementation(() => [{
    id: 'accepted-task', runId: run.mock.calls[0][0].idempotencyKey, status: 'running',
  }]);
  const { notify, system } = setup({ run, waitForRun }, { runs: { bindSession: jest.fn().mockReturnValue({ list }) } });

  await expect(notify()).resolves.toBe(false);
  clock.mockReturnValue(16 * 60 * 1_000);
  await expect(notify()).resolves.toBe(true);
  expect(run).toHaveBeenCalledTimes(2);
  expect(run.mock.calls[1][0]).toEqual(run.mock.calls[0][0]);
  noQueuedFallback(system);
});
