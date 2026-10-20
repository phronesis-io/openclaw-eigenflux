import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { AuthNotificationGate } from './auth-notification-gate';
import { EigenFluxNotifier } from './notifier';
import { Logger } from './logger';
import { sendAuthReminder } from './auth-reminder-transport';
import { resolveNotificationRoute } from './notification-route-resolver';
import { writeStoredNotificationRoute } from './session-route-memory';

jest.mock('./auth-reminder-transport', () => ({ sendAuthReminder: jest.fn() }));
jest.mock('./notification-route-resolver', () => ({
  isInternalSessionKey: (key: string) => key === 'main',
  resolveNotificationRoute: jest.fn(),
}));
jest.mock('./session-route-memory', () => ({ writeStoredNotificationRoute: jest.fn() }));

const send = sendAuthReminder as jest.MockedFunction<typeof sendAuthReminder>;
const resolveRoute = resolveNotificationRoute as jest.MockedFunction<typeof resolveNotificationRoute>;
const writeRoute = writeStoredNotificationRoute as jest.MockedFunction<typeof writeStoredNotificationRoute>;
const sent = (params: { idempotencyKey: string }) => ({
  runId: params.idempotencyKey, status: 'ok', result: { deliverySucceeded: true },
});

beforeEach(() => {
  send.mockReset().mockImplementation(async params => sent(params));
  resolveRoute.mockReset().mockResolvedValue({ source: 'default', route: { sessionKey: 'main', agentId: 'main' } });
  writeRoute.mockReset().mockResolvedValue(true);
});
afterEach(() => jest.restoreAllMocks());

function setup(tasks?: unknown) {
  const system = {
    runCommandWithTimeout: jest.fn(), enqueueSystemEvent: jest.fn(), requestHeartbeatNow: jest.fn(),
  };
  const subagent = { run: jest.fn(), waitForRun: jest.fn().mockResolvedValue({ status: 'ok' }) };
  const logs = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const notifier = new EigenFluxNotifier({ config: {}, runtime: { subagent, system, tasks } } as unknown as OpenClawPluginApi,
    new Logger(logs), { sessionKey: 'main', agentId: 'main', openclawCliBin: 'openclaw' });
  const gate = new AuthNotificationGate();
  const notify = (message = 'AUTH_REQUIRED') => gate.deliver(() => notifier.deliver(message, { requireCompletion: true }));
  return { notifier, notify, system, subagent, logs };
}

function noOtherTransport({ system, subagent }: ReturnType<typeof setup>) {
  expect(subagent.run).not.toHaveBeenCalled();
  expect(subagent.waitForRun).not.toHaveBeenCalled();
  expect(system.runCommandWithTimeout).not.toHaveBeenCalled();
  expect(system.enqueueSystemEvent).not.toHaveBeenCalled();
  expect(system.requestHeartbeatNow).not.toHaveBeenCalled();
}

test('only the final matching channel-send result starts cooldown', async () => {
  const context = setup();
  await expect(context.notify()).resolves.toBe(true);
  await expect(context.notify()).resolves.toBe(false);
  expect(send).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledWith({ sessionKey: 'main', message: 'AUTH_REQUIRED',
    deliver: true, lane: 'eigenflux-bg', idempotencyKey: expect.any(String) }, 480_000);
  noOtherTransport(context);
});

test('an early lifecycle success cannot start cooldown before the final channel send', async () => {
  let finish!: (response: Record<string, unknown>) => void;
  let started!: () => void;
  const waiting = new Promise<void>(resolve => { started = resolve; });
  send.mockImplementation(() => { started(); return new Promise(resolve => { finish = resolve; }); });
  const context = setup();
  let settled = false;
  const first = context.notify().then(result => { settled = true; return result; });
  await waiting;
  await Promise.resolve();
  expect(settled).toBe(false);
  await expect(context.notify()).resolves.toBe(false);
  finish(sent(send.mock.calls[0][0]));
  await expect(first).resolves.toBe(true);
  await expect(context.notify()).resolves.toBe(false);
  expect(send).toHaveBeenCalledTimes(1);
  noOtherTransport(context);
});

test.each([
  ['accepted', { status: 'accepted' }],
  ['lifecycle only', { status: 'ok' }],
  ['empty result', { status: 'ok', result: {} }],
  ['non-boolean receipt', { status: 'ok', result: { deliverySucceeded: 'true' } }],
  ['timeout', { status: 'timeout' }],
  ['missing status', { result: { deliverySucceeded: true } }],
  ['unknown status', { status: 'pending', result: { deliverySucceeded: true } }],
])('%s remains unknown without resubmission or cooldown before the deadline', async (_name, response) => {
  const clock = jest.spyOn(Date, 'now').mockReturnValue(1_000);
  send.mockImplementationOnce(async params => ({ runId: params.idempotencyKey, ...response }));
  const context = setup();
  await expect(context.notify()).resolves.toBe(false);
  await expect(context.notify()).resolves.toBe(false);
  expect(send).toHaveBeenCalledTimes(1);
  clock.mockReturnValue(16 * 60 * 1_000);
  await expect(context.notify()).resolves.toBe(true);
  expect(send.mock.calls[1][0].idempotencyKey).not.toBe(send.mock.calls[0][0].idempotencyKey);
  noOtherTransport(context);
});

test('a success for another run is never accepted as this reminder', async () => {
  const clock = jest.spyOn(Date, 'now').mockReturnValue(1_000);
  send.mockResolvedValueOnce({ runId: 'unrelated-run', status: 'ok', result: { deliverySucceeded: true } });
  const context = setup();
  await expect(context.notify()).resolves.toBe(false);
  await expect(context.notify()).resolves.toBe(false);
  expect(send).toHaveBeenCalledTimes(1);
  clock.mockReturnValue(16 * 60 * 1_000);
  await expect(context.notify()).resolves.toBe(true);
  expect(send.mock.calls[1][0].idempotencyKey).not.toBe(send.mock.calls[0][0].idempotencyKey);
});

test.each([
  { status: 'ok', result: { deliverySucceeded: false } },
  { status: 'error' },
])('a matching final failure permits a new reminder without cooldown: %j', async response => {
  send.mockImplementationOnce(async params => ({ runId: params.idempotencyKey, ...response }));
  const context = setup();
  await expect(context.notify()).resolves.toBe(false);
  await expect(context.notify()).resolves.toBe(true);
  expect(send.mock.calls[1][0].idempotencyKey).not.toBe(send.mock.calls[0][0].idempotencyKey);
  noOtherTransport(context);
});

test.each(['response lost', 'gateway unavailable', 'completion timeout'])(
  '%s preserves pending state without resubmitting through any transport', async message => {
    const clock = jest.spyOn(Date, 'now').mockReturnValue(1_000);
    send.mockRejectedValueOnce(new Error(message));
    const context = setup();
    await expect(context.notify()).resolves.toBe(false);
    clock.mockReturnValue(6 * 60 * 1_000);
    await expect(context.notify()).resolves.toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
    clock.mockReturnValue(16 * 60 * 1_000);
    await expect(context.notify()).resolves.toBe(true);
    expect(send.mock.calls[1][0].idempotencyKey).not.toBe(send.mock.calls[0][0].idempotencyKey);
    noOtherTransport(context);
  }
);

test('route persistence failure does not discard a confirmed channel send', async () => {
  resolveRoute.mockResolvedValue({ source: 'config', route: {
    sessionKey: 'agent:main:feishu:direct:ou_123', agentId: 'main', replyChannel: 'feishu', replyTo: 'user:ou_123',
  } });
  writeRoute.mockRejectedValue(new Error('local route store unavailable'));
  const context = setup();
  await expect(context.notify()).resolves.toBe(true);
  await expect(context.notify()).resolves.toBe(false);
  expect(writeRoute).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledWith({ sessionKey: 'agent:main:feishu:direct:ou_123',
    message: 'AUTH_REQUIRED', deliver: true, lane: 'eigenflux-bg', idempotencyKey: expect.any(String) }, 480_000);
});

test.each(['missing API', 'missing record', 'succeeded', 'failed', 'query failure'])(
  'an expired unknown result permits another reminder when task inspection has %s', async taskState => {
    const clock = jest.spyOn(Date, 'now').mockReturnValue(1_000);
    send.mockRejectedValueOnce(new Error('completion response lost'))
      .mockImplementationOnce(async params => ({ runId: params.idempotencyKey, status: 'accepted' }));
    const list = jest.fn().mockImplementation(() => {
      if (taskState === 'query failure') throw new Error('task registry unavailable');
      return taskState === 'missing record' ? [] : [{
        id: 'old-task', runId: send.mock.calls[0][0].idempotencyKey, status: taskState,
      }];
    });
    const tasks = taskState === 'missing API' ? undefined : { runs: { bindSession: jest.fn().mockReturnValue({ list }) } };
    const context = setup(tasks);
    await expect(context.notify('old instruction')).resolves.toBe(false);
    clock.mockReturnValue(16 * 60 * 1_000);
    await expect(context.notify('current instruction')).resolves.toBe(false);
    expect(send.mock.calls[1][0].message).toBe('current instruction');
    expect(send.mock.calls[1][0].idempotencyKey).not.toBe(send.mock.calls[0][0].idempotencyKey);
    expect(context.logs.warn).toHaveBeenCalledWith(expect.stringContaining('outcome remains unknown and may arrive late'));
    await expect(context.notify('current instruction')).resolves.toBe(false);
    expect(send).toHaveBeenCalledTimes(2);
    clock.mockReturnValue(32 * 60 * 1_000);
    await expect(context.notify('current instruction')).resolves.toBe(true);
    expect(send.mock.calls[2][0].idempotencyKey).not.toBe(send.mock.calls[1][0].idempotencyKey);
    await expect(context.notify()).resolves.toBe(false);
    noOtherTransport(context);
  }
);

test.each(['queued', 'running'])('a known %s run retains its key after the retry deadline', async status => {
  const clock = jest.spyOn(Date, 'now').mockReturnValue(1_000);
  send.mockRejectedValueOnce(new Error('response lost'));
  const task = { id: 'active-task', runId: '', status };
  const list = jest.fn().mockImplementation(() => [{ ...task, runId: send.mock.calls[0][0].idempotencyKey }]);
  const context = setup({ runs: { bindSession: jest.fn().mockReturnValue({ list }) } });
  await expect(context.notify()).resolves.toBe(false);
  clock.mockReturnValue(16 * 60 * 1_000);
  await expect(context.notify()).resolves.toBe(false);
  expect(send).toHaveBeenCalledTimes(1);
  task.status = 'failed';
  await expect(context.notify()).resolves.toBe(true);
  expect(send.mock.calls[1][0].idempotencyKey).not.toBe(send.mock.calls[0][0].idempotencyKey);
  noOtherTransport(context);
});
