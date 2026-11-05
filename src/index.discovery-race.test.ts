import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

jest.mock('openclaw/plugin-sdk/plugin-entry', () => ({
  definePluginEntry: (entry: unknown) => entry,
  buildJsonPluginConfigSchema: (schema: unknown) => schema,
}));
jest.mock('openclaw/plugin-sdk/skills-runtime', () => ({ bumpSkillsSnapshotVersion: jest.fn() }));

const discoverServersMock = jest.fn();
jest.mock('./config', () => ({
  ...jest.requireActual('./config'),
  discoverServers: (...args: unknown[]) => discoverServersMock(...args),
  resolveEigenfluxHome: () => '/tmp/eigenflux-discovery-race-tests/.eigenflux',
}));
jest.mock('./cli-executor', () => ({
  ...jest.requireActual('./cli-executor'),
  execEigenflux: jest.fn().mockResolvedValue({ kind: 'success' }),
}));

// Keep the real polling, stream and notifier lifecycles; isolate CLI processes.
const spawnMock = jest.fn();
jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

import plugin from './index';
import { EigenFluxPollingClient } from './polling-client';
import { EigenFluxStreamClient } from './stream-client';

const configured = {
  kind: 'ok', servers: [{ name: 'eigenflux', endpoint: 'https://example.invalid', current: true }],
};
const retryable = { kind: 'error', error: 'temporary discovery failure', retryable: true };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function register() {
  const services: any[] = [];
  const commands: any[] = [];
  plugin.register({
    registrationMode: 'full', config: {}, pluginConfig: {}, runtime: {},
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    registerService: (service: unknown) => services.push(service),
    registerCommand: (command: unknown) => commands.push(command),
  } as any);
  return { service: services[0], command: commands[0] };
}

describe('discovery runtime ownership with real clients', () => {
  let pollStart: jest.SpyInstance;
  let pollStop: jest.SpyInstance;
  let streamStart: jest.SpyInstance;
  let streamStatus: jest.SpyInstance;
  const originalChannel = process.env.EIGENFLUX_CHANNEL;

  beforeEach(() => {
    jest.useFakeTimers();
    discoverServersMock.mockReset().mockResolvedValue(configured);
    spawnMock.mockReset().mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(), stderr: new PassThrough(),
        kill: jest.fn(() => { child.emit('close', 0, null); return true; }),
      });
      return child;
    });
    pollStart = jest.spyOn(EigenFluxPollingClient.prototype, 'start');
    pollStop = jest.spyOn(EigenFluxPollingClient.prototype, 'stop');
    streamStart = jest.spyOn(EigenFluxStreamClient.prototype, 'start');
    streamStatus = jest.spyOn(EigenFluxStreamClient.prototype, 'isRunning');
  });

  afterEach(async () => {
    for (const poller of pollStart.mock.instances as EigenFluxPollingClient[]) poller.stop();
    await Promise.all((streamStart.mock.instances as EigenFluxStreamClient[]).map(stream => stream.stop()));
    jest.restoreAllMocks();
    jest.useRealTimers();
    if (originalChannel === undefined) delete process.env.EIGENFLUX_CHANNEL;
    else process.env.EIGENFLUX_CHANNEL = originalChannel;
  });

  test.each(['retry', 'command'])('%s finishing first preserves one runtime group through stop', async (first) => {
    const commandDiscovery = deferred<unknown>();
    discoverServersMock.mockResolvedValueOnce(retryable).mockReturnValueOnce(commandDiscovery.promise);
    const { service, command } = register();
    await service.start();
    const commandReply = command.handler({ args: 'servers' });
    let commandStream: EigenFluxStreamClient;
    if (first === 'command') {
      commandDiscovery.resolve(configured);
      await commandReply;
      commandStream = streamStatus.mock.instances[0];
    }
    await jest.advanceTimersByTimeAsync(5_000);
    expect(pollStart).toHaveBeenCalledTimes(1);
    expect(streamStart).toHaveBeenCalledTimes(1);
    if (first === 'retry') {
      commandDiscovery.resolve(configured);
      const reply = await commandReply;
      commandStream = streamStatus.mock.instances[0];
      expect(reply.text).toContain('streaming');
    }
    const runningStream = streamStart.mock.instances[0] as EigenFluxStreamClient;
    const runningPoller = pollStart.mock.instances[0] as EigenFluxPollingClient;
    expect(commandStream!).toBe(runningStream);
    await service.stop();
    expect(pollStop.mock.instances).toContain(runningPoller);
    expect(runningStream.isRunning()).toBe(false);
    expect(spawnMock.mock.results[0].value.kill).toHaveBeenCalledWith('SIGTERM');
    const pollsBefore = (require('./cli-executor').execEigenflux as jest.Mock).mock.calls.length;
    await jest.advanceTimersByTimeAsync(600_000);
    expect((require('./cli-executor').execEigenflux as jest.Mock).mock.calls.length).toBe(pollsBefore);
  });

  test('a command result from before stop cannot replace the restarted runtime', async () => {
    const commandDiscovery = deferred<unknown>();
    const restarted = { kind: 'ok', servers: [{ ...configured.servers[0], name: 'restarted' }] };
    discoverServersMock.mockResolvedValueOnce(retryable)
      .mockReturnValueOnce(commandDiscovery.promise).mockResolvedValueOnce(restarted);
    const { service, command } = register();
    await service.start();
    const commandReply = command.handler({ args: 'servers' });
    await service.stop();
    await service.start();
    commandDiscovery.resolve(configured);
    const reply = await commandReply;
    expect(reply.text).toContain('restarted');
    expect(reply.text).toContain('streaming');
    expect(reply.text).not.toContain('- eigenflux:');
    await service.stop();
    expect(spawnMock.mock.results[0].value.kill).toHaveBeenCalledWith('SIGTERM');
  });

  test('a command begun during cleanup cannot repopulate the stopped runtime', async () => {
    const commandDiscovery = deferred<unknown>();
    discoverServersMock.mockResolvedValueOnce(configured).mockReturnValueOnce(commandDiscovery.promise);
    const { service, command } = register();
    await service.start();
    const child = spawnMock.mock.results[0].value;
    child.kill.mockImplementation(() => true);
    const stopping = service.stop();
    const commandReply = command.handler({ args: 'servers' });
    child.emit('close', 0, null);
    await stopping;
    commandDiscovery.resolve(configured);
    expect((await commandReply).text).toBe('No EigenFlux servers discovered.');
  });
});
