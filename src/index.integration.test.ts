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
let streamClientConfig: any;

jest.mock('./stream-client', () => ({
  EigenFluxStreamClient: jest.fn().mockImplementation((config: any) => {
    streamClientConfig = config;
    return {
      start: streamClientStartMock,
      stop: streamClientStopMock,
      isRunning: streamClientIsRunningMock,
      getLastCursor: streamClientGetLastCursorMock,
    };
  }),
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
  let wakeOnEmpty: boolean;
  let profileTask: string;

  let feedItems: Array<{
    item_id: string;
    group_id?: string;
    broadcast_type: string;
    updated_at: number;
  }>;

  beforeEach(async () => {
    streamClientConfig = undefined;
    wakeOnEmpty = true;
    profileTask = '';
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
      if (args[0] === '--homedir' && args[4] === 'heartbeat' && args[5] === 'plan') {
        return { kind: 'success', data: { schema_version: 'eigenflux_heartbeat_plan.v1', agent_prompt: 'EIGENFLUX HEARTBEAT PLAN\nCommands → Feed → Attention', wake_on_empty: wakeOnEmpty } };
      }
      if (args[0] === 'feed' && args[1] === 'poll') {
        return {
          kind: 'success',
          data: {
            items: feedItems,
            has_more: false,
            notifications: [],
            output_contract: 'OUTPUT CONTRACT supplied by CLI: follow the current Skills. 📡 Powered by EigenFlux',
          },
        };
      }
      if (args[0] === 'profile' && args[1] === 'refresh-task') {
        return { kind: 'success', data: profileTask };
      }
      if (args[0] === 'config' && args[1] === 'get') {
        return { kind: 'success', data: undefined };
      }
      return { kind: 'error', error: new Error('unknown command'), exitCode: 1, stderr: '' };
    });

    discoverServersMock.mockResolvedValue({ kind: 'ok', servers: [
      { name: 'eigenflux', endpoint: 'http://127.0.0.1:18080', current: true },
    ] });

    // These integration tests assert the legacy one-shot subagent feed path;
    // opt into it explicitly (default is now main-session 2a).
    process.env.EIGENFLUX_FEED_DELIVERY = 'oneshot';
  });

  afterEach(async () => {
    __testHomeDir = undefined;
    delete process.env.EIGENFLUX_FEED_DELIVERY;
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  test.each([false, true])('empty Feed follows CLI wake_on_empty=%s while background adapters continue', async (wake) => {
    wakeOnEmpty = wake;
    feedItems = [];
    jest.resetModules();
    const { default: plugin } = await import('./index');
    const services: any[] = [];
    const subagentRun = jest.fn().mockResolvedValue({ runId: 'empty-feed-run' });
    plugin.register({
      registrationMode: 'full', config: {}, pluginConfig: {},
      runtime: { subagent: { run: subagentRun } },
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      registerService: (service: any) => services.push(service),
    } as any);
    await services[0].start();
    expect(subagentRun).toHaveBeenCalledTimes(wake ? 1 : 0);
    expect(execEigenfluxMock.mock.calls.some(([, args]) => args[0] === 'profile' && args[1] === 'refresh-task')).toBe(true);
    await services[0].stop();
  });

  test('central profile tasks keep the host reply route available for Skill-selected drafts', async () => {
    wakeOnEmpty = false;
    feedItems = [];
    profileTask = 'EIGENFLUX PROFILE REVIEW TASK\nFollow the current Skills.';
    jest.resetModules();
    const { default: plugin } = await import('./index');
    const services: any[] = [];
    const subagentRun = jest.fn().mockResolvedValue({ runId: 'profile-task-run' });
    plugin.register({
      registrationMode: 'full', config: {}, pluginConfig: {},
      runtime: { subagent: { run: subagentRun } },
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      registerService: (service: any) => services.push(service),
    } as any);
    await services[0].start();
    expect(subagentRun).toHaveBeenCalledTimes(1);
    expect(subagentRun.mock.calls[0][0]).toMatchObject({ message: profileTask, deliver: true });
    await services[0].stop();
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
      message: expect.stringContaining('[EIGENFLUX_HEARTBEAT]'),
      deliver: true,
      idempotencyKey: expect.any(String),
      lane: 'eigenflux-bg',
    });
    const message = String(subagentRun.mock.calls[0]?.[0]?.message);
    expect(message).toContain('Commands → Feed → Attention');
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

  test('default mode: active push — runs the subagent on the main session, not a one-shot key', async () => {
    delete process.env.EIGENFLUX_FEED_DELIVERY; // default = classic main-session push
    jest.resetModules();
    const { default: plugin } = await import('./index');
    const services: any[] = [];
    const subagentRun = jest.fn().mockResolvedValue({ runId: 'run-main-session-feed' });
    const enqueueSystemEvent = jest.fn().mockReturnValue(true);
    const requestHeartbeatNow = jest.fn();

    plugin.register({
      registrationMode: 'full',
      config: {},
      pluginConfig: {},
      runtime: {
        subagent: { run: subagentRun },
        system: { enqueueSystemEvent, requestHeartbeatNow },
      },
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      registerService: (service: any) => {
        services.push(service);
      },
    } as any);

    await services[0].start();
    await waitFor(() => subagentRun.mock.calls.length === 1);

    // The plugin itself initiates the run (active push) on a persistent main
    // session — NOT a throwaway one-shot key, and NOT via system-event enqueue.
    const params = subagentRun.mock.calls[0][0];
    expect(params.deliver).toBe(true);
    expect(params.lane).toBe('eigenflux-bg');
    expect(params.sessionKey).not.toMatch(/^eigenflux:feed:/);
    expect(String(params.message)).toContain('[EIGENFLUX_FEED_PAYLOAD]');
    expect(enqueueSystemEvent).not.toHaveBeenCalled();

    await services[0].stop();
  });

  test('mode 2a (opt-in): injects feed into the main session via system event + heartbeat (no subagent)', async () => {
    process.env.EIGENFLUX_FEED_DELIVERY = 'system-event';
    jest.resetModules();
    const { default: plugin } = await import('./index');
    const services: any[] = [];
    const subagentRun = jest.fn().mockResolvedValue({ runId: 'run-should-not-be-used' });
    const enqueueSystemEvent = jest.fn().mockReturnValue(true);
    const requestHeartbeatNow = jest.fn();

    plugin.register({
      registrationMode: 'full',
      config: {},
      pluginConfig: {},
      runtime: {
        subagent: { run: subagentRun },
        system: { enqueueSystemEvent, requestHeartbeatNow },
      },
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      registerService: (service: any) => {
        services.push(service);
      },
    } as any);

    await services[0].start();
    await waitFor(() => enqueueSystemEvent.mock.calls.length === 1);

    const [message, opts] = enqueueSystemEvent.mock.calls[0];
    expect(String(message)).toContain('[EIGENFLUX_FEED_PAYLOAD]');
    expect(String(message)).toContain('OUTPUT CONTRACT');
    expect(String(message)).toContain('"item_id": "501"');
    // Injected into a persistent main session, NOT a throwaway one-shot key.
    expect(opts.sessionKey).toEqual(expect.any(String));
    expect(opts.sessionKey).not.toMatch(/^eigenflux:feed:/);
    expect(requestHeartbeatNow).toHaveBeenCalled();
    // The feed must NOT go through the deliver:true subagent path in 2a.
    expect(subagentRun).not.toHaveBeenCalled();

    await services[0].stop();
  });

  test('routes PMs to a stable session and lane derived from peer + conv_id, outside main', async () => {
    feedItems = [];
    jest.resetModules();
    const { default: plugin } = await import('./index');
    const services: any[] = [];
    const subagentRun = jest.fn().mockResolvedValue({ runId: 'run-pm' });

    plugin.register({
      registrationMode: 'full',
      config: {},
      pluginConfig: {},
      runtime: { subagent: { run: subagentRun } },
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      registerService: (service: any) => services.push(service),
    } as any);

    await services[0].start();
    await waitFor(() => subagentRun.mock.calls.length === 1);
    // The idle heartbeat is intentionally delivered at startup. Isolate the
    // PM assertion from that independent background task.
    subagentRun.mockClear();
    await streamClientConfig.onPmEvent({
      type: 'pm_push',
      data: {
        messages: [
          {
            msg_id: 'pm-1',
            conv_id: 'conv-341466745984253952',
            sender_id: 'agent-kyrie',
            content: 'compact 运行正常吗？',
            created_at: 1786605839498,
          },
        ],
      },
    });

    expect(subagentRun).toHaveBeenCalledTimes(1);
    const params = subagentRun.mock.calls[0][0];
    expect(params.sessionKey).toMatch(/^eigenflux:pm:[a-f0-9]{16}:[a-f0-9]{16}:[a-f0-9]{16}:[a-f0-9]{16}$/);
    expect(params.sessionKey).not.toBe('agent:main:main');
    expect(params.lane).toMatch(/^eigenflux-pm:[a-f0-9]{16}:[a-f0-9]{16}:[a-f0-9]{16}:[a-f0-9]{16}$/);
    expect(params.message).toContain('"conv_id": "conv-341466745984253952"');
    expect(params.message).toContain('ef-communication skill');
    expect(params.message).not.toContain('eigenflux msg history');
    expect(params.message).toContain('stable isolated session');

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
  test.each(['control_pending', 'maintenance_due'])('watch %s invokes the real Agent seam independently of Feed', async type => {
    feedItems = [];
    wakeOnEmpty = false;
    profileTask = '';
    jest.resetModules();
    const { default: plugin } = await import('./index');
    const services: any[] = [];
    const subagentRun = jest.fn().mockResolvedValue({ runId: 'run-watch' });
    const waitForRun = jest.fn().mockResolvedValue({ status: 'ok' });
    plugin.register({ registrationMode: 'full', config: {}, pluginConfig: {},
      runtime: { subagent: { run: subagentRun, waitForRun } },
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      registerService: (service: any) => services.push(service),
    } as any);
    try {
      await services[0].start();
      // Feed is now unavailable; event maintenance must not depend on its result.
      const implementation = execEigenfluxMock.getMockImplementation();
      execEigenfluxMock.mockImplementation(async (...args: any[]) => {
        if (args[1][0] === 'feed' && args[1][1] === 'poll') return {kind:'error',error:new Error('offline'),exitCode:1,stderr:''};
        return implementation!(...args);
      });
      await streamClientConfig.onWatchEvent({schema_version:'eigenflux_watch.v1', type, event_id:'watch-1', state_scope:'owned-account', data:{}});
      expect(subagentRun).toHaveBeenCalledTimes(1);
      expect(waitForRun).toHaveBeenCalledWith(expect.objectContaining({runId:'run-watch'}));
      const mode = type === 'control_pending' ? 'control-only' : 'maintenance-only';
      expect(execEigenfluxMock.mock.calls.some(([,args]) => args.includes(`--${mode}`))).toBe(true);
      expect(subagentRun.mock.calls[0][0].sessionKey).toContain(`owned-account:${mode}`);
      expect(subagentRun.mock.calls[0][0].message).toContain('EIGENFLUX HEARTBEAT PLAN');
    } finally { await services[0].stop(); }
  });

  test('PM reports failed Agent delivery and isolates the same conversation across account scopes', async () => {
    feedItems = []; wakeOnEmpty = false; profileTask = '';
    jest.resetModules();
    const { default: plugin } = await import('./index');
    const services: any[] = [];
    const subagentRun = jest.fn().mockResolvedValue({runId:'pm'});
    const waitForRun = jest.fn().mockResolvedValue({status:'ok'});
    plugin.register({registrationMode:'full', config:{}, pluginConfig:{},
      runtime:{subagent:{run:subagentRun,waitForRun}},
      logger:{info:jest.fn(),warn:jest.fn(),error:jest.fn(),debug:jest.fn()},
      registerService:(service:any)=>services.push(service),
    } as any);
    const event = {type:'pm_push',data:{messages:[{msg_id:'one',conv_id:'same',sender_id:'peer',content:'hello',created_at:1}]}};
    try {
      await services[0].start();
      await streamClientConfig.onPmEvent({...event,state_scope:'account-a'});
      await streamClientConfig.onPmEvent({...event,state_scope:'account-b'});
      expect(subagentRun.mock.calls[0][0].sessionKey).not.toEqual(subagentRun.mock.calls[1][0].sessionKey);
      expect(subagentRun.mock.calls[0][0].lane).not.toEqual(subagentRun.mock.calls[1][0].lane);
      waitForRun.mockResolvedValue({status:'error',error:'Agent failed'});
      await expect(streamClientConfig.onPmEvent({...event,state_scope:'account-a'})).rejects.toThrow('PM Agent delivery failed');
    } finally {await services[0].stop();}
  });

  test('watch takes over automatic Card ticks while retaining the existing context and Agent adapter', async () => {
    feedItems = []; wakeOnEmpty = false; profileTask = 'CARD FROM CENTRAL CLI';
    jest.resetModules();
    const { EigenFluxWatchClient } = await import('./watch-client');
    const enabled = jest.spyOn(EigenFluxWatchClient.prototype, 'isWatchEnabled').mockReturnValue(true);
    const { default: plugin } = await import('./index');
    const services:any[]=[];
    const subagentRun=jest.fn().mockResolvedValue({runId:'card'});
    const waitForRun=jest.fn().mockResolvedValue({status:'ok'});
    plugin.register({registrationMode:'full',config:{},pluginConfig:{},runtime:{subagent:{run:subagentRun,waitForRun}},
      logger:{info:jest.fn(),warn:jest.fn(),error:jest.fn(),debug:jest.fn()}, registerService:(s:any)=>services.push(s),
    } as any);
    try {
      await services[0].start();
      expect(execEigenfluxMock.mock.calls.some(([,args])=>args[0]==='profile')).toBe(false);
      expect(execEigenfluxMock.mock.calls.some(([,args])=>args.includes('--watch-managed'))).toBe(true);
      await streamClientConfig.onWatchEvent({type:'profile_review_due',state_scope:'account',data:{}});
      const call=execEigenfluxMock.mock.calls.find(([,args])=>args[0]==='profile');
      expect(call?.[1]).toEqual(expect.arrayContaining(['refresh-task','--homedir',eigenfluxHome,'-s','eigenflux']));
      expect(subagentRun.mock.calls[0][0].message).toBe('CARD FROM CENTRAL CLI');
      expect(waitForRun).toHaveBeenCalledWith(expect.objectContaining({runId:'card'}));
    } finally {enabled.mockRestore();await services[0].stop();}
  });

  test.each(['onIdentityChanged', 'onFatal'])('delayed watch plan cannot deliver after %s', async stopHook => {
    feedItems = []; wakeOnEmpty = false; profileTask = '';
    jest.resetModules();
    const { default: plugin } = await import('./index');
    const services: any[] = [];
    const subagentRun = jest.fn().mockResolvedValue({ runId: 'should-not-run' });
    plugin.register({ registrationMode: 'full', config: {}, pluginConfig: {},
      runtime: { subagent: { run: subagentRun } },
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      registerService: (service: any) => services.push(service),
    } as any);
    let release!: () => void;
    const delayed = new Promise<void>(resolve => { release = resolve; });
    try {
      await services[0].start();
      const implementation = execEigenfluxMock.getMockImplementation();
      execEigenfluxMock.mockImplementation(async (...args: any[]) => {
        if (args[1].includes('--control-only')) await delayed;
        return implementation!(...args);
      });
      const delivery = streamClientConfig.onWatchEvent({ type: 'control_pending', state_scope: 'old-account', data: {} });
      await streamClientConfig[stopHook]();
      release();
      await delivery;
      expect(subagentRun).not.toHaveBeenCalled();
    } finally { release(); await services[0].stop(); }
  });

  test.each(['stream', 'plan', 'feed'])('identity stop during startup %s does not restart later services', async phase => {
    feedItems = []; wakeOnEmpty = false; profileTask = '';
    jest.resetModules();
    const { FeedbackFlushLoop } = await import('./feedback-flush-loop');
    const flushStart = jest.spyOn(FeedbackFlushLoop.prototype, 'start');
    const { default: plugin } = await import('./index');
    const services: any[] = [];
    const subagentRun = jest.fn().mockResolvedValue({ runId: 'should-not-run' });
    plugin.register({ registrationMode: 'full', config: {}, pluginConfig: {},
      runtime: { subagent: { run: subagentRun } },
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      registerService: (service: any) => services.push(service),
    } as any);
    const implementation = execEigenfluxMock.getMockImplementation();
    if (phase === 'stream') streamClientStartMock.mockImplementationOnce(async () => { await streamClientConfig.onIdentityChanged(); });
    execEigenfluxMock.mockImplementation(async (...args: any[]) => {
      if ((phase === 'plan' && args[1].includes('plan')) || (phase === 'feed' && args[1][0] === 'feed')) {
        await streamClientConfig.onIdentityChanged();
      }
      return implementation!(...args);
    });
    try {
      await services[0].start();
      expect(flushStart).not.toHaveBeenCalled();
      expect(subagentRun).not.toHaveBeenCalled();
      if (phase !== 'feed') expect(execEigenfluxMock.mock.calls.some(([, args]) => args[0] === 'feed')).toBe(false);
    } finally { await services[0].stop(); flushStart.mockRestore(); }
  });

});
