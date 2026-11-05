jest.mock('openclaw/plugin-sdk/plugin-entry', () => ({
  definePluginEntry: (entry: unknown) => entry,
  buildJsonPluginConfigSchema: (schema: unknown) => schema,
}));

const discoverServersMock = jest.fn();
const getInstalledCliVersionMock = jest.fn();
jest.mock('./config', () => ({
  ...jest.requireActual('./config'),
  discoverServers: (...args: unknown[]) => discoverServersMock(...args),
  getInstalledCliVersion: (...args: unknown[]) => getInstalledCliVersionMock(...args),
  resolveEigenfluxHome: () => '/tmp/eigenflux-discovery-tests/.eigenflux',
}));
jest.mock('./cli-executor', () => ({ execEigenflux: jest.fn().mockResolvedValue({ kind: 'success' }) }));

const pollStart = jest.fn();
const pollStop = jest.fn();
jest.mock('./polling-client', () => ({
  EigenFluxPollingClient: jest.fn().mockImplementation(() => ({ start: pollStart, stop: pollStop })),
}));
const streamStart = jest.fn();
const streamStop = jest.fn();
jest.mock('./stream-client', () => ({
  EigenFluxStreamClient: jest.fn().mockImplementation(() => ({ start: streamStart, stop: streamStop })),
}));
const profileStart = jest.fn();
const profileStop = jest.fn();
jest.mock('./profile-refresher', () => ({
  EigenFluxProfileRefresher: jest.fn().mockImplementation(() => ({ start: profileStart, stop: profileStop })),
}));
const orderStart = jest.fn();
const orderStop = jest.fn();
jest.mock('./order-notifications', () => ({
  OrderNotifications: jest.fn().mockImplementation(() => ({ start: orderStart, stop: orderStop })),
}));
const flushStart = jest.fn();
const flushStop = jest.fn();
jest.mock('./feedback-flush-loop', () => ({
  FeedbackFlushLoop: jest.fn().mockImplementation(() => ({ start: flushStart, stop: flushStop })),
}));
const deliver = jest.fn();
jest.mock('./notifier', () => ({
  EigenFluxNotifier: jest.fn().mockImplementation(() => ({
    deliver, stopFeedObservation: jest.fn(), drainPendingCleanups: jest.fn().mockResolvedValue(undefined),
  })),
}));

import plugin from './index';

const configured = { kind: 'ok', servers: [{ name: 'eigenflux', endpoint: 'https://example.invalid', current: true }] };
const retryable = { kind: 'error', error: 'CLI timed out', retryable: true };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function register() {
  const services: any[] = [];
  const commands: any[] = [];
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  plugin.register({
    registrationMode: 'full', config: {}, pluginConfig: {}, runtime: {}, logger,
    registerService: (service: unknown) => services.push(service),
    registerCommand: (command: unknown) => commands.push(command),
  } as any);
  return { service: services[0], command: commands[0], logger };
}

async function settle() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

describe('discovery service lifecycle', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    discoverServersMock.mockReset().mockResolvedValue(configured);
    getInstalledCliVersionMock.mockReset().mockResolvedValue('0.6.7');
    pollStart.mockReset().mockResolvedValue(undefined);
    streamStart.mockReset().mockResolvedValue(undefined);
    streamStop.mockReset().mockResolvedValue(undefined);
    deliver.mockReset().mockResolvedValue(true);
  });
  afterEach(() => { jest.useRealTimers(); });

  test('recovers once after a temporary discovery failure without duplicate starts or prompts', async () => {
    discoverServersMock.mockResolvedValueOnce(retryable);
    const { service, logger } = register();
    await Promise.all([service.start(), service.start()]);
    expect(discoverServersMock).toHaveBeenCalledTimes(1);
    expect(pollStart).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(5_000);
    expect(discoverServersMock).toHaveBeenCalledTimes(2);
    expect(pollStart).toHaveBeenCalledTimes(1);
    expect(streamStart).toHaveBeenCalledTimes(1);
    expect(deliver).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('discovery ready'));
    await service.start();
    await jest.advanceTimersByTimeAsync(120_000);
    expect(discoverServersMock).toHaveBeenCalledTimes(2);
    await Promise.all([service.stop(), service.stop()]);
    expect(pollStop).toHaveBeenCalledTimes(1);
    expect(streamStop).toHaveBeenCalledTimes(1);
  });

  test('caps retries, leaves loops stopped, and resets the budget only after stop/start', async () => {
    discoverServersMock.mockResolvedValue(retryable);
    const { service, logger } = register();
    await service.start();
    await jest.advanceTimersByTimeAsync(5_000);
    await jest.advanceTimersByTimeAsync(15_000);
    await jest.advanceTimersByTimeAsync(30_000);
    await service.start();
    await jest.advanceTimersByTimeAsync(3_600_000);
    expect(discoverServersMock).toHaveBeenCalledTimes(4);
    expect(pollStart).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('automatic retries exhausted'));
    await service.stop();
    discoverServersMock.mockResolvedValue(configured);
    await service.start();
    expect(pollStart).toHaveBeenCalledTimes(1);
    await service.stop();
  });

  test.each([
    ['empty configuration', { kind: 'ok', servers: [] }],
    ['missing CLI', { kind: 'not_installed', bin: '/missing/eigenflux' }],
    ['authentication required', { kind: 'error', error: 'requires authentication', retryable: false }],
  ])('does not automatically scan or repeatedly notify for %s', async (_, discovery) => {
    discoverServersMock.mockResolvedValue(discovery);
    const { service } = register();
    await service.start();
    await service.start();
    await jest.advanceTimersByTimeAsync(3_600_000);
    expect(discoverServersMock).toHaveBeenCalledTimes(1);
    expect(pollStart).not.toHaveBeenCalled();
    expect(deliver).toHaveBeenCalledTimes(discovery.kind === 'not_installed' ? 1 : 0);
    await service.stop();
  });

  test('stop cancels a pending retry and restart owns a fresh discovery cycle', async () => {
    discoverServersMock.mockResolvedValueOnce(retryable);
    const { service } = register();
    await service.start();
    await service.stop();
    await jest.advanceTimersByTimeAsync(120_000);
    expect(discoverServersMock).toHaveBeenCalledTimes(1);
    await service.start();
    expect(pollStart).toHaveBeenCalledTimes(1);
    await service.stop();
  });

  test('a stopped discovery result cannot replace or start another lifecycle', async () => {
    const oldDiscovery = deferred<unknown>();
    discoverServersMock.mockReturnValueOnce(oldDiscovery.promise);
    const { service } = register();
    const oldStart = service.start();
    await service.stop();
    await service.start();
    oldDiscovery.resolve(configured);
    await oldStart;
    expect(pollStart).toHaveBeenCalledTimes(1);
    expect(streamStart).toHaveBeenCalledTimes(1);
    await service.stop();
  });

  test.each(['Feed', 'stream'])('stopping during %s startup prevents later loops from starting', async (phase) => {
    const pending = deferred<void>();
    if (phase === 'Feed') pollStart.mockReturnValueOnce(pending.promise);
    else streamStart.mockReturnValueOnce(pending.promise);
    const { service } = register();
    const starting = service.start();
    await settle();
    expect(pollStart).toHaveBeenCalledTimes(1);
    await service.stop();
    pending.resolve();
    await starting;
    expect(streamStart).toHaveBeenCalledTimes(phase === 'Feed' ? 0 : 1);
    expect(orderStart).not.toHaveBeenCalled();
    expect(flushStart).not.toHaveBeenCalled();
  });

  test('stopping during the version probe suppresses a stale upgrade prompt', async () => {
    const version = deferred<string>();
    getInstalledCliVersionMock.mockReturnValueOnce(version.promise);
    const { service } = register();
    const starting = service.start();
    await settle();
    await service.stop();
    version.resolve('0.0.1');
    await starting;
    expect(deliver).not.toHaveBeenCalled();
  });

  test('a later stop cancels a restart waiting for previous cleanup', async () => {
    const { service } = register();
    await service.start();
    const cleanup = deferred<void>();
    const notifier = (require('./notifier').EigenFluxNotifier as jest.Mock).mock.results[0].value;
    notifier.drainPendingCleanups.mockReturnValueOnce(cleanup.promise);
    const stopping = service.stop();
    const restarting = service.start();
    const finalStop = service.stop();
    cleanup.resolve();
    await Promise.all([stopping, restarting, finalStop]);
    expect(discoverServersMock).toHaveBeenCalledTimes(1);
    expect(pollStart).toHaveBeenCalledTimes(1);
    await service.start();
    expect(pollStart).toHaveBeenCalledTimes(2);
    await service.stop();
  });

  test('a rejected discovery request is retried without starting loops early', async () => {
    discoverServersMock.mockRejectedValueOnce(new Error('temporary spawn failure'));
    const { service } = register();
    await service.start();
    expect(pollStart).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(5_000);
    expect(pollStart).toHaveBeenCalledTimes(1);
    await service.stop();
  });

  test('manual commands expose discovery errors instead of claiming no configured servers', async () => {
    discoverServersMock.mockResolvedValue(retryable);
    const { command } = register();
    const reply = await command.handler({ args: 'servers' });
    expect(reply.text).toContain('discovery failed: CLI timed out');
    expect(pollStart).not.toHaveBeenCalled();
  });
});
