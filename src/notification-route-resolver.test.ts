import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Logger } from './logger';

const readStoredNotificationRouteMock = jest.fn();
jest.mock('./session-route-memory', () => ({
  readStoredNotificationRoute: (...args: any[]) => readStoredNotificationRouteMock(...args),
  writeStoredNotificationRoute: jest.fn(),
}));

import { isInternalSessionKey, resolveNotificationRoute } from './notification-route-resolver';

const runtimeStoreMock = {
  get: jest.fn().mockResolvedValue(undefined),
  set: jest.fn().mockResolvedValue(undefined),
};

function createLogger(): Logger {
  return new Logger({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  });
}

describe('resolveNotificationRoute', () => {
  beforeEach(() => {
    readStoredNotificationRouteMock.mockReset();
    readStoredNotificationRouteMock.mockResolvedValue(undefined);
  });

  const sdkRoute = (to: string, updatedAt = 100) => ({
    updatedAt, chatType: 'direct',
    delivery: { kind: 'external', context: { channel: 'feishu', to, accountId: 'default' },
      origin: { provider: 'feishu', to, chatType: 'direct' } },
  });

  test('reads canonical host routes without requiring a legacy sessions.json file', async () => {
    const readSessionStore = jest.fn(() => ({ 'agent:main:main': sdkRoute('user:ou_main') }));
    const result = await resolveNotificationRoute({ sessionKey: 'main', agentId: 'main', sessionStorePath: '/missing/sessions.json' },
      createLogger(), { readSessionStore });
    expect(readSessionStore).toHaveBeenCalledWith('main', '/missing/sessions.json');
    expect(result.route).toMatchObject({ agentId: 'main', replyChannel: 'feishu', replyTo: 'user:ou_main' });
  });

  test('SDK discovery cannot adopt another agent route or remembered target', async () => {
    readStoredNotificationRouteMock.mockResolvedValue({ sessionKey: 'agent:other:main', agentId: 'other',
      replyChannel: 'feishu', replyTo: 'user:ou_other' });
    const result = await resolveNotificationRoute({ sessionKey: 'main', agentId: 'main', sessionStorePath: '/missing/sessions.json' },
      createLogger(), { readSessionStore: () => ({ 'agent:other:main': sdkRoute('user:ou_other', 999) }) });
    expect(result.source).toBe('default');
    expect(result.route.replyTo).toBeUndefined();
  });

  test('canonical route ignores stale legacy thread fields', async () => {
    const result = await resolveNotificationRoute({ sessionKey: 'main', agentId: 'main', sessionStorePath: '/missing/sessions.json' },
      createLogger(), { readSessionStore: () => ({ 'agent:main:main': { ...sdkRoute('user:ou_main'),
        lastThreadId: 'stale-thread', deliveryContext: { channel: 'feishu', to: 'user:ou_main', threadId: 'stale-thread' },
      } }) });
    expect(result.route.replyThread).toBeUndefined();
  });

  test.each(['replyChannel', 'replyTo', 'replyAccountId'] as const)('pinned %s cannot inherit another destination thread', async (field) => {
    const result = await resolveNotificationRoute({ sessionKey: 'agent:main:main', agentId: 'main',
      replyChannel: field === 'replyChannel' ? 'telegram' : 'feishu',
      replyTo: field === 'replyTo' ? 'user:ou_pinned' : 'user:ou_main',
      replyAccountId: field === 'replyAccountId' ? 'pinned-account' : 'default',
      sessionStorePath: '/missing/sessions.json', routeOverrides: {
        sessionKey: false, agentId: false, replyChannel: field === 'replyChannel',
        replyTo: field === 'replyTo', replyAccountId: field === 'replyAccountId',
      },
    }, createLogger(), { readSessionStore: () => ({ 'agent:main:main': {
      updatedAt: 100, delivery: { kind: 'external', context: {
        channel: 'feishu', to: 'user:ou_main', accountId: 'default', threadId: 42,
      } },
    } }) });
    expect(result.route.replyThread).toBeUndefined();
  });

  test('explicit route fields remain pinned when the SDK offers a different target', async () => {
    const result = await resolveNotificationRoute({ sessionKey: 'main', agentId: 'main', sessionStorePath: '/missing/sessions.json',
      replyChannel: 'feishu', replyTo: 'user:ou_pinned', routeOverrides: {
        sessionKey: false, agentId: false, replyChannel: true, replyTo: true, replyAccountId: false,
      } },
      createLogger(), { readSessionStore: () => ({ 'agent:main:main': sdkRoute('user:ou_other') }) });
    expect(result.source).toBe('config');
    expect(result.route.replyTo).toBe('user:ou_pinned');
  });

  test('same-agent remembered route stays ahead of a fresher SDK target', async () => {
    readStoredNotificationRouteMock.mockResolvedValue({ sessionKey: 'agent:main:saved', agentId: 'main',
      replyChannel: 'feishu', replyTo: 'user:ou_saved' });
    const result = await resolveNotificationRoute({ sessionKey: 'main', agentId: 'main', sessionStorePath: '/missing/sessions.json' },
      createLogger(), { readSessionStore: () => ({ 'agent:main:main': sdkRoute('user:ou_other', 999) }) });
    expect(result.source).toBe('remembered');
    expect(result.route.replyTo).toBe('user:ou_saved');
  });

  test('canonical non-delivery state does not revive stale legacy delivery fields', async () => {
    const result = await resolveNotificationRoute({ sessionKey: 'main', agentId: 'main', sessionStorePath: '/missing/sessions.json' },
      createLogger(), { readSessionStore: () => ({ 'agent:main:feishu:direct:ou_stale': { ...sdkRoute('user:ou_stale'),
        deliveryContext: { channel: 'feishu', to: 'user:ou_stale' }, delivery: { kind: 'none' } } }) });
    expect(result.route.replyTo).toBeUndefined();
  });

  test('prefers remembered session route over dynamically fresher session when config is automatic', async () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'eigenflux-route-memory-'));
    const sessionStorePath = path.join(workdir, 'sessions.json');

    fs.writeFileSync(
      sessionStorePath,
      JSON.stringify({
        'agent:main:main': {
          updatedAt: 100,
          deliveryContext: { channel: 'webchat' },
        },
        'agent:main:feishu:group:oc_newer': {
          updatedAt: 400,
          deliveryContext: {
            channel: 'feishu',
            to: 'chat:oc_newer',
            accountId: 'default',
          },
        },
        'agent:mengtian:feishu:direct:ou_saved': {
          updatedAt: 200,
          deliveryContext: {
            channel: 'feishu',
            to: 'user:ou_saved',
            accountId: 'default',
          },
        },
      }),
      'utf-8'
    );

    readStoredNotificationRouteMock.mockResolvedValue({
      sessionKey: 'agent:mengtian:feishu:direct:ou_saved',
      agentId: 'mengtian',
      replyChannel: 'feishu',
      replyTo: 'user:ou_saved',
      replyAccountId: 'default',
      updatedAt: 0,
    });

    const { route } = await resolveNotificationRoute(
      {
        sessionKey: 'main',
        agentId: 'main',
        sessionStorePath,
        store: runtimeStoreMock,
        eigenfluxBin: 'eigenflux',
        serverName: 'eigenflux',
        routeOverrides: {
          sessionKey: false,
          agentId: false,
          replyChannel: false,
          replyTo: false,
          replyAccountId: false,
        },
      },
      createLogger()
    );

    expect(route).toEqual({
      sessionKey: 'agent:mengtian:feishu:direct:ou_saved',
      agentId: 'mengtian',
      replyChannel: 'feishu',
      replyTo: 'user:ou_saved',
      replyAccountId: 'default',
    });

    fs.rmSync(workdir, { recursive: true, force: true });
  });

  test('respects explicit route overrides while still enriching exact session metadata', async () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'eigenflux-route-explicit-'));
    const sessionStorePath = path.join(workdir, 'sessions.json');

    fs.writeFileSync(
      sessionStorePath,
      JSON.stringify({
        'agent:main:feishu:direct:ou_explicit': {
          updatedAt: 300,
          deliveryContext: {
            channel: 'feishu',
            to: 'user:ou_explicit',
            accountId: 'default',
          },
        },
      }),
      'utf-8'
    );

    const { route } = await resolveNotificationRoute(
      {
        sessionKey: 'agent:main:feishu:direct:ou_explicit',
        agentId: 'main',
        replyChannel: 'feishu',
        sessionStorePath,
        store: runtimeStoreMock,
        eigenfluxBin: 'eigenflux',
        serverName: 'eigenflux',
        routeOverrides: {
          sessionKey: true,
          agentId: true,
          replyChannel: true,
          replyTo: false,
          replyAccountId: false,
        },
      },
      createLogger()
    );

    expect(route).toEqual({
      sessionKey: 'agent:main:feishu:direct:ou_explicit',
      agentId: 'main',
      replyChannel: 'feishu',
      replyTo: 'user:ou_explicit',
      replyAccountId: 'default',
    });

    fs.rmSync(workdir, { recursive: true, force: true });
  });

  test('normalizes remembered legacy feishu targets from session memory', async () => {
    readStoredNotificationRouteMock.mockResolvedValue({
      sessionKey: 'agent:mengtian:feishu:direct:ou_legacy',
      agentId: 'mengtian',
      replyChannel: 'feishu',
      replyTo: 'user:ou_legacy',
      replyAccountId: 'default',
      updatedAt: 0,
    });

    const { route } = await resolveNotificationRoute(
      {
        sessionKey: 'main',
        agentId: 'main',
        store: runtimeStoreMock,
        eigenfluxBin: 'eigenflux',
        serverName: 'eigenflux',
        routeOverrides: {
          sessionKey: false,
          agentId: false,
          replyChannel: false,
          replyTo: false,
          replyAccountId: false,
        },
      },
      createLogger()
    );

    expect(route).toEqual({
      sessionKey: 'agent:mengtian:feishu:direct:ou_legacy',
      agentId: 'mengtian',
      replyChannel: 'feishu',
      replyTo: 'user:ou_legacy',
      replyAccountId: 'default',
    });
  });

  test('prefers the session-store route whose peer shape matches the normalized target', async () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'eigenflux-route-peer-shape-'));
    const sessionStorePath = path.join(workdir, 'sessions.json');

    fs.writeFileSync(
      sessionStorePath,
      JSON.stringify({
        'agent:main:main': {
          updatedAt: 100,
          deliveryContext: { channel: 'webchat' },
        },
        'agent:main:feishu:group:oc_group_target': {
          updatedAt: 200,
          deliveryContext: {
            channel: 'feishu',
            to: 'chat:oc_group_target',
            accountId: 'default',
          },
        },
        'agent:mengtian:feishu:direct:oc_group_target': {
          updatedAt: 300,
          origin: {
            provider: 'feishu',
            to: 'oc_group_target',
            accountId: 'default',
          },
        },
      }),
      'utf-8'
    );

    readStoredNotificationRouteMock.mockResolvedValue({
      sessionKey: 'main',
      agentId: 'main',
      replyChannel: 'feishu',
      replyTo: 'chat:oc_group_target',
      replyAccountId: 'default',
      updatedAt: 0,
    });

    const { route } = await resolveNotificationRoute(
      {
        sessionKey: 'main',
        agentId: 'main',
        sessionStorePath,
        store: runtimeStoreMock,
        eigenfluxBin: 'eigenflux',
        serverName: 'eigenflux',
        routeOverrides: {
          sessionKey: false,
          agentId: false,
          replyChannel: false,
          replyTo: false,
          replyAccountId: false,
        },
      },
      createLogger()
    );

    expect(route).toEqual({
      sessionKey: 'agent:main:feishu:group:oc_group_target',
      agentId: 'main',
      replyChannel: 'feishu',
      replyTo: 'chat:oc_group_target',
      replyAccountId: 'default',
    });

    fs.rmSync(workdir, { recursive: true, force: true });
  });

  test('derives channel and target from sessionKey when entry metadata is sparse', async () => {
    // Real-world case: sessions.json has an external entry with only updatedAt
    // set (no deliveryContext.to), plus a webchat bookkeeping entry. The
    // external sessionKey shape alone must be enough to route to it.
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'eigenflux-route-sparse-'));
    const sessionStorePath = path.join(workdir, 'sessions.json');
    fs.writeFileSync(
      sessionStorePath,
      JSON.stringify({
        'agent:mengtian:main': {
          updatedAt: 9000,
          deliveryContext: { channel: 'webchat', to: 'heartbeat' },
        },
        'agent:mengtian:feishu:direct:ou_sparse': {
          updatedAt: 1000,
        },
      }),
      'utf-8'
    );

    const route = await resolveNotificationRoute(
      {
        sessionKey: 'main',
        agentId: 'main',
        sessionStorePath,
        store: runtimeStoreMock,
        eigenfluxBin: 'eigenflux',
        serverName: 'eigenflux',
      },
      createLogger()
    );

    expect(route.route.sessionKey).toBe('agent:mengtian:feishu:direct:ou_sparse');
    expect(route.route.replyChannel).toBe('feishu');
    expect(route.route.replyTo).toBe('user:ou_sparse');
    expect(route.source).toBe('session-store');

    fs.rmSync(workdir, { recursive: true, force: true });
  });
});

describe('isInternalSessionKey', () => {
  test('bare "main" is internal', () => {
    expect(isInternalSessionKey('main')).toBe(true);
  });

  test('bare "heartbeat" is internal', () => {
    expect(isInternalSessionKey('heartbeat')).toBe(true);
  });

  test('empty / whitespace is internal', () => {
    expect(isInternalSessionKey('')).toBe(true);
    expect(isInternalSessionKey('   ')).toBe(true);
  });

  test('agent:<id>:heartbeat is internal', () => {
    expect(isInternalSessionKey('agent:main:heartbeat')).toBe(true);
    expect(isInternalSessionKey('agent:mengtian:heartbeat')).toBe(true);
  });

  test('agent:<id>:main is NOT internal (legacy DM scope)', () => {
    expect(isInternalSessionKey('agent:main:main')).toBe(false);
    expect(isInternalSessionKey('agent:mengtian:main')).toBe(false);
  });

  test('channel-scoped keys are not internal', () => {
    expect(isInternalSessionKey('agent:main:feishu:direct:ou_123')).toBe(false);
    expect(isInternalSessionKey('agent:main:feishu:group:oc_456')).toBe(false);
    expect(isInternalSessionKey('agent:main:discord:direct:user789')).toBe(false);
  });
});

import { isGroupEntry, isDirectSessionKey } from './notification-route-resolver';

describe('isGroupEntry', () => {
  test('sessionKey with :group: is a group', () => {
    expect(isGroupEntry('agent:main:feishu:group:oc_123', {})).toBe(true);
  });

  test('sessionKey with :channel: is a group', () => {
    expect(isGroupEntry('agent:main:discord:channel:c_123', {})).toBe(true);
  });

  test('sessionKey with :room: is a group', () => {
    expect(isGroupEntry('agent:main:matrix:room:r_123', {})).toBe(true);
  });

  test('entry.chatType=group overrides DM-shaped key', () => {
    expect(
      isGroupEntry('agent:main:main', {
        deliveryContext: { channel: 'feishu', to: 'user:ou_1' },
        chatType: 'group' as any,
      } as any)
    ).toBe(true);
  });

  test('entry.origin.chatType=group', () => {
    expect(
      isGroupEntry('agent:main:main', {
        origin: { provider: 'feishu', chatType: 'group' as any },
      } as any)
    ).toBe(true);
  });

  test('deliveryContext.to with chat: prefix is a group', () => {
    expect(
      isGroupEntry('agent:main:main', {
        deliveryContext: { channel: 'feishu', to: 'chat:oc_123' },
      } as any)
    ).toBe(true);
  });

  test('lastTo with channel: prefix is a group', () => {
    expect(
      isGroupEntry('agent:main:main', { lastTo: 'channel:c_123' } as any)
    ).toBe(true);
  });

  test('origin.to with room: prefix is a group', () => {
    expect(
      isGroupEntry('agent:main:main', { origin: { to: 'room:r_123' } } as any)
    ).toBe(true);
  });

  test('DM session is NOT a group', () => {
    expect(
      isGroupEntry('agent:main:main', {
        deliveryContext: { channel: 'feishu', to: 'user:ou_1' },
      } as any)
    ).toBe(false);
  });

  test('channel-scoped DM is NOT a group', () => {
    expect(
      isGroupEntry('agent:main:feishu:direct:ou_1', {
        deliveryContext: { channel: 'feishu', to: 'user:ou_1' },
      } as any)
    ).toBe(false);
  });

  test('empty entry with plain DM-shaped key is NOT a group', () => {
    expect(isGroupEntry('agent:main:main', {})).toBe(false);
  });
});

describe('isDirectSessionKey', () => {
  test('sessionKey parts contain "direct"', () => {
    expect(isDirectSessionKey('agent:main:feishu:direct:ou_1', {})).toBe(true);
  });

  test('sessionKey parts contain "dm"', () => {
    expect(isDirectSessionKey('agent:main:discord:dm:user1', {})).toBe(true);
  });

  test('entry.chatType=direct marks key as direct even without "direct" in sessionKey', () => {
    expect(
      isDirectSessionKey('agent:main:main', { chatType: 'direct' } as any)
    ).toBe(true);
  });

  test('entry.origin.chatType=direct is recognized', () => {
    expect(
      isDirectSessionKey('agent:main:main', { origin: { chatType: 'direct' } } as any)
    ).toBe(true);
  });

  test('deliveryContext.to with user: prefix is direct', () => {
    expect(
      isDirectSessionKey('agent:main:main', {
        deliveryContext: { to: 'user:ou_1' },
      } as any)
    ).toBe(true);
  });

  test('lastTo with user: prefix is direct', () => {
    expect(
      isDirectSessionKey('agent:main:main', { lastTo: 'user:ou_1' } as any)
    ).toBe(true);
  });

  test('group key is not direct', () => {
    expect(isDirectSessionKey('agent:main:feishu:group:oc_1', {})).toBe(false);
  });

  test('empty entry with plain key is not direct', () => {
    expect(isDirectSessionKey('agent:main:main', {})).toBe(false);
  });
});

describe('auto-scan group exclusion', () => {
  function writeStore(entries: Record<string, unknown>): string {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'eigenflux-group-exclusion-'));
    const sessionStorePath = path.join(workdir, 'sessions.json');
    fs.writeFileSync(sessionStorePath, JSON.stringify(entries), 'utf-8');
    return sessionStorePath;
  }

  test('legacy agent:<id>:main DM wins over a more recent group', async () => {
    const sessionStorePath = writeStore({
      'agent:main:main': {
        updatedAt: 1000,
        chatType: 'direct',
        deliveryContext: {
          channel: 'feishu',
          to: 'user:ou_dm',
          accountId: 'default',
        },
        origin: { provider: 'feishu', chatType: 'direct' },
        lastTo: 'user:ou_dm',
      },
      'agent:main:feishu:group:oc_group': {
        updatedAt: 9999,
        chatType: 'group',
        deliveryContext: {
          channel: 'feishu',
          to: 'chat:oc_group',
          accountId: 'default',
        },
      },
    });

    const { route, source } = await resolveNotificationRoute(
      {
        sessionKey: 'main',
        agentId: 'main',
        sessionStorePath,
        store: runtimeStoreMock,
        eigenfluxBin: 'eigenflux',
        serverName: 'eigenflux',
      },
      createLogger()
    );

    expect(source).toBe('session-store');
    expect(route.sessionKey).toBe('agent:main:main');
    expect(route.replyTo).toBe('user:ou_dm');
  });

  test('when the only external entry is a group, auto-scan returns default', async () => {
    const sessionStorePath = writeStore({
      'agent:main:feishu:group:oc_group': {
        updatedAt: 9999,
        chatType: 'group',
        deliveryContext: {
          channel: 'feishu',
          to: 'chat:oc_group',
          accountId: 'default',
        },
      },
    });

    const { route, source } = await resolveNotificationRoute(
      {
        sessionKey: 'main',
        agentId: 'main',
        sessionStorePath,
        store: runtimeStoreMock,
        eigenfluxBin: 'eigenflux',
        serverName: 'eigenflux',
      },
      createLogger()
    );

    expect(source).toBe('default');
    expect(route.sessionKey).toBe('main');
  });

  test('heartbeat entries with external deliveryContext are ignored', async () => {
    const sessionStorePath = writeStore({
      'agent:main:heartbeat': {
        updatedAt: 9999,
        deliveryContext: {
          channel: 'feishu',
          to: 'user:ou_dm',
          accountId: 'default',
        },
      },
    });

    const { source } = await resolveNotificationRoute(
      {
        sessionKey: 'main',
        agentId: 'main',
        sessionStorePath,
        store: runtimeStoreMock,
        eigenfluxBin: 'eigenflux',
        serverName: 'eigenflux',
      },
      createLogger()
    );

    expect(source).toBe('default');
  });
});

describe('direct tiebreaker', () => {
  test('most-recent DM wins regardless of key shape', async () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'eigenflux-direct-tiebreaker-'));
    const sessionStorePath = path.join(workdir, 'sessions.json');
    fs.writeFileSync(
      sessionStorePath,
      JSON.stringify({
        'agent:main:main': {
          updatedAt: 100,
          chatType: 'direct',
          deliveryContext: { channel: 'feishu', to: 'user:ou_older', accountId: 'default' },
        },
        'agent:main:feishu:direct:ou_newer': {
          updatedAt: 500,
          chatType: 'direct',
          deliveryContext: { channel: 'feishu', to: 'user:ou_newer', accountId: 'default' },
        },
      }),
      'utf-8'
    );

    const { route } = await resolveNotificationRoute(
      {
        sessionKey: 'main',
        agentId: 'main',
        sessionStorePath,
        store: runtimeStoreMock,
        eigenfluxBin: 'eigenflux',
        serverName: 'eigenflux',
      },
      createLogger()
    );

    expect(route.replyTo).toBe('user:ou_newer');
  });

  test('channel-scoped DM beats legacy main DM when fresher', async () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'eigenflux-direct-tiebreaker-'));
    const sessionStorePath = path.join(workdir, 'sessions.json');
    fs.writeFileSync(
      sessionStorePath,
      JSON.stringify({
        'agent:main:main': {
          updatedAt: 500,
          chatType: 'direct',
          deliveryContext: { channel: 'feishu', to: 'user:ou_older', accountId: 'default' },
        },
        'agent:main:feishu:direct:ou_newer': {
          updatedAt: 100,
          chatType: 'direct',
          deliveryContext: { channel: 'feishu', to: 'user:ou_newer', accountId: 'default' },
        },
      }),
      'utf-8'
    );

    const { route } = await resolveNotificationRoute(
      {
        sessionKey: 'main',
        agentId: 'main',
        sessionStorePath,
        store: runtimeStoreMock,
        eigenfluxBin: 'eigenflux',
        serverName: 'eigenflux',
      },
      createLogger()
    );

    expect(route.replyTo).toBe('user:ou_older');
    expect(route.sessionKey).toBe('agent:main:main');
  });
});

describe('CLI-overwritten main session fall-through', () => {
  test('auto-scan returns default when main is non-external and only groups remain', async () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'eigenflux-cli-overwrite-'));
    const sessionStorePath = path.join(workdir, 'sessions.json');
    fs.writeFileSync(
      sessionStorePath,
      JSON.stringify({
        'agent:main:main': {
          updatedAt: 9000,
          // CLI overwrote deliveryContext — no external channel anymore
          deliveryContext: { channel: 'webchat' },
        },
        'agent:main:feishu:group:oc_group': {
          updatedAt: 500,
          chatType: 'group',
          deliveryContext: {
            channel: 'feishu',
            to: 'chat:oc_group',
            accountId: 'default',
          },
        },
      }),
      'utf-8'
    );

    const { source, route } = await resolveNotificationRoute(
      {
        sessionKey: 'main',
        agentId: 'main',
        sessionStorePath,
        store: runtimeStoreMock,
        eigenfluxBin: 'eigenflux',
        serverName: 'eigenflux',
      },
      createLogger()
    );

    expect(source).toBe('default');
    expect(route.sessionKey).toBe('main');
  });

  test('remembered DM route survives a main-session overwrite', async () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'eigenflux-cli-overwrite-'));
    const sessionStorePath = path.join(workdir, 'sessions.json');
    fs.writeFileSync(
      sessionStorePath,
      JSON.stringify({
        'agent:main:main': {
          updatedAt: 9000,
          deliveryContext: { channel: 'webchat' },
        },
        'agent:main:feishu:group:oc_group': {
          updatedAt: 500,
          chatType: 'group',
          deliveryContext: {
            channel: 'feishu',
            to: 'chat:oc_group',
            accountId: 'default',
          },
        },
      }),
      'utf-8'
    );

    readStoredNotificationRouteMock.mockResolvedValue({
      sessionKey: 'agent:main:main',
      agentId: 'main',
      replyChannel: 'feishu',
      replyTo: 'user:ou_dm',
      replyAccountId: 'default',
      updatedAt: 0,
    });

    const { source, route } = await resolveNotificationRoute(
      {
        sessionKey: 'main',
        agentId: 'main',
        sessionStorePath,
        store: runtimeStoreMock,
        eigenfluxBin: 'eigenflux',
        serverName: 'eigenflux',
      },
      createLogger()
    );

    expect(source).toBe('remembered');
    expect(route.sessionKey).toBe('agent:main:main');
    expect(route.replyTo).toBe('user:ou_dm');
  });
});
