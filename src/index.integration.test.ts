import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Shared variable so the os mock factory always returns the test-controlled homeDir
let __testHomeDir: string | undefined;

jest.mock('os', () => {
  const actual = jest.requireActual('os') as typeof import('os');
  return {
    ...actual,
    homedir: jest.fn(() => __testHomeDir ?? actual.homedir()),
  };
});

// Mock definePluginEntry from the SDK — the actual module is ESM-only and
// cannot be loaded by Jest's CJS transform pipeline.
jest.mock('openclaw/plugin-sdk/plugin-entry', () => ({
  definePluginEntry: (opts: any) => opts,
  buildJsonPluginConfigSchema: (schema: any) => schema,
}));

// Mock discoverServers and resolveEigenfluxHome
const discoverServersMock = jest.fn();
const resolveEigenfluxHomeMock = jest.fn();

jest.mock('./config', () => {
  const actual = jest.requireActual('./config');
  return {
    ...actual,
    discoverServers: (...args: any[]) => discoverServersMock(...args),
    resolveEigenfluxHome: () => resolveEigenfluxHomeMock(),
  };
});

// Mock execEigenflux for CLI calls
const execEigenfluxMock = jest.fn();
jest.mock('./cli-executor', () => ({
  execEigenflux: (...args: any[]) => execEigenfluxMock(...args),
}));

// Mock EigenFluxStreamClient
const streamClientStartMock = jest.fn().mockResolvedValue(undefined);
const streamClientStopMock = jest.fn().mockResolvedValue(undefined);
const streamClientIsRunningMock = jest.fn().mockReturnValue(false);
const streamClientGetLastCursorMock = jest.fn().mockReturnValue(null);

jest.mock('./stream-client', () => ({
  EigenFluxStreamClient: jest.fn().mockImplementation(() => ({
    start: streamClientStartMock,
    stop: streamClientStopMock,
    isRunning: streamClientIsRunningMock,
    getLastCursor: streamClientGetLastCursorMock,
  })),
}));

function waitFor(condition: () => boolean, timeoutMs = 8000): Promise<void> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (condition()) {
        clearInterval(timer);
        resolve();
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        clearInterval(timer);
        reject(new Error('condition wait timeout'));
      }
    }, 50);
  });
}

describe('register integration', () => {
  let homeDir: string;
  let eigenfluxHome: string;

  let feedItems: Array<{
    item_id: string;
    group_id?: string;
    broadcast_type: string;
    updated_at: number;
  }>;

  beforeEach(async () => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eigenflux-openclaw-home-'));
    eigenfluxHome = path.join(homeDir, '.eigenflux');
    __testHomeDir = homeDir;
    resolveEigenfluxHomeMock.mockReturnValue(eigenfluxHome);

    // Create server credentials
    const serverDir = path.join(eigenfluxHome, 'servers', 'eigenflux');
    fs.mkdirSync(serverDir, { recursive: true });
    fs.writeFileSync(
      path.join(serverDir, 'credentials.json'),
      JSON.stringify({ access_token: 'at_integration_token' }),
      'utf-8'
    );

    feedItems = [
      {
        item_id: '501',
        group_id: 'group-int-1',
        broadcast_type: 'info',
        updated_at: 1760000000000,
      },
    ];

    // Set up execEigenflux to return feed data
    execEigenfluxMock.mockImplementation(async (bin: string, args: string[]) => {
      if (args[0] === 'feed' && args[1] === 'poll') {
        return {
          kind: 'success',
          data: {
            items: feedItems,
            has_more: false,
            notifications: [],
          },
        };
      }
      if (args[0] === 'config' && args[1] === 'get') {
        return { kind: 'success', data: undefined };
      }
      return { kind: 'error', error: new Error('unknown command'), exitCode: 1, stderr: '' };
    });

    discoverServersMock.mockResolvedValue({ kind: 'ok', servers: [
      { name: 'eigenflux', endpoint: 'http://127.0.0.1:18080', current: true },
    ] });
  });

  afterEach(async () => {
    __testHomeDir = undefined;
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  test('routes feed notifications via runtime.subagent when available', async () => {
    jest.resetModules();
    const { default: plugin } = await import('./index');
    const services: any[] = [];
    const subagentRun = jest.fn().mockResolvedValue({ runId: 'run-subagent-feed' });

    plugin.register({
      registrationMode: 'full',
      config: {},
      pluginConfig: {},
      runtime: {
        subagent: {
          run: subagentRun,
        },
      },
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      registerService: (service: any) => {
        services.push(service);
      },
    } as any);

    expect(services).toHaveLength(1);
    await services[0].start();
    await waitFor(() => subagentRun.mock.calls.length === 1);

    expect(subagentRun).toHaveBeenCalledWith({
      sessionKey: expect.stringMatching(/^eigenflux:feed:eigenflux:\d+-[a-f0-9]{8}$/),
      message: expect.stringContaining('[EIGENFLUX_FEED_PAYLOAD]'),
      deliver: true,
      idempotencyKey: expect.any(String),
    });
    const message = String(subagentRun.mock.calls[0]?.[0]?.message);
    expect(message).toContain('"item_id": "501"');
    expect(message).toContain('"group_id": "group-int-1"');
    expect(message).toContain('server=eigenflux');
    expect(message).toContain(`homedir=${eigenfluxHome}`);
    expect(message).toContain('ef-broadcast skill');
    // The output contract must ride along the real delivery path, ahead of the payload.
    expect(message).toContain('OUTPUT CONTRACT');
    expect(message).toContain('📡 Powered by EigenFlux');

    await services[0].stop();
  });

  test('dispatches the entire feed payload in a single runtime.subagent message', async () => {
    feedItems = [
      {
        item_id: '601',
        group_id: 'group-dup-1',
        broadcast_type: 'info',
        updated_at: 1760000000100,
      },
      {
        item_id: '602',
        group_id: 'group-dup-1',
        broadcast_type: 'info',
        updated_at: 1760000000200,
      },
    ];

    jest.resetModules();
    const { default: plugin } = await import('./index');
    const services: any[] = [];
    const subagentRun = jest.fn().mockResolvedValue({ runId: 'run-dup-1' });

    plugin.register({
      registrationMode: 'full',
      config: {},
      pluginConfig: {},
      runtime: {
        subagent: { run: subagentRun },
      },
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      registerService: (service: any) => {
        services.push(service);
      },
    } as any);

    expect(services).toHaveLength(1);
    await services[0].start();
    await waitFor(() => subagentRun.mock.calls.length === 1);

    expect(subagentRun).toHaveBeenCalledTimes(1);
    const message = String(subagentRun.mock.calls[0]?.[0]?.message);
    expect(message).toContain('"item_id": "601"');
    expect(message).toContain('"item_id": "602"');
    expect(message).toContain('"group_id": "group-dup-1"');

    await services[0].stop();
  });

  test('delivers feed to dedicated session, not main DM session', async () => {
    jest.resetModules();
    const { default: plugin } = await import('./index');
    const services: any[] = [];
    const subagentRun = jest.fn().mockResolvedValue({ runId: 'run-feed-session' });

    plugin.register({
      registrationMode: 'full',
      config: {},
      pluginConfig: {},
      runtime: {
        subagent: { run: subagentRun },
      },
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      registerService: (service: any) => {
        services.push(service);
      },
    } as any);

    expect(services).toHaveLength(1);
    await services[0].start();
    await waitFor(() => subagentRun.mock.calls.length === 1);

    // Feed should be delivered to eigenflux:feed:eigenflux, not main
    const feedCall = subagentRun.mock.calls[0]?.[0];
    expect(feedCall.sessionKey).toMatch(/^eigenflux:feed:eigenflux:\d+-[a-f0-9]{8}$/);
    expect(feedCall.message).toContain('[EIGENFLUX_FEED_PAYLOAD]');

    await services[0].stop();
  });
});
