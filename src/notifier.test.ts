import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { Logger } from './logger';

const readStoredNotificationRouteMock = jest.fn();
const writeStoredNotificationRouteMock = jest.fn();
jest.mock('./session-route-memory', () => ({
  readStoredNotificationRoute: (...args: any[]) => readStoredNotificationRouteMock(...args),
  writeStoredNotificationRoute: (...args: any[]) => writeStoredNotificationRouteMock(...args),
}));

import { EigenFluxNotifier } from './notifier';

function createLogger(): Logger {
  return new Logger({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  });
}

function createApi(overrides: Partial<OpenClawPluginApi> = {}): OpenClawPluginApi {
  return {
    id: 'eigenflux',
    name: 'EigenFlux',
    source: '/tmp/eigenflux',
    config: {},
    pluginConfig: {},
    runtime: {} as unknown as OpenClawPluginApi['runtime'],
    logger: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    },
    registerService: jest.fn(),
    ...overrides,
  } as unknown as OpenClawPluginApi;
}

function createConfig() {
  return {
    sessionKey: 'agent:main:feishu:direct:ou_123',
    agentId: 'main',
    replyChannel: 'feishu',
    replyTo: 'user:ou_123',
    openclawCliBin: 'openclaw',
  };
}

describe('EigenFluxNotifier', () => {
  beforeEach(() => {
    readStoredNotificationRouteMock.mockReset();
    writeStoredNotificationRouteMock.mockReset();
    readStoredNotificationRouteMock.mockResolvedValue(undefined);
    writeStoredNotificationRouteMock.mockResolvedValue(true);
  });

  test('prefers runtime.subagent delivery when available', async () => {
    const run = jest.fn().mockResolvedValue({ runId: 'run-subagent' });

    const notifier = new EigenFluxNotifier(
      createApi({
        runtime: {
          subagent: { run },
        } as unknown as OpenClawPluginApi['runtime'],
      }),
      createLogger(),
      createConfig()
    );

    await expect(notifier.deliver('[EIGENFLUX_TEST] payload')).resolves.toBe(true);
    expect(run).toHaveBeenCalledWith({
      sessionKey: 'agent:main:feishu:direct:ou_123',
      message: '[EIGENFLUX_TEST] payload',
      deliver: true,
      idempotencyKey: expect.any(String),
      lane: 'eigenflux-bg',
    });
  });

  test('silent delivery runs the subagent with deliver:false and skips heartbeat', async () => {
    const run = jest.fn().mockResolvedValue({ runId: 'run-silent' });
    const enqueueSystemEvent = jest.fn().mockReturnValue(true);
    const requestHeartbeatNow = jest.fn();

    const notifier = new EigenFluxNotifier(
      createApi({
        runtime: {
          subagent: { run },
          system: { enqueueSystemEvent, requestHeartbeatNow },
        } as unknown as OpenClawPluginApi['runtime'],
      }),
      createLogger(),
      createConfig()
    );

    await expect(
      notifier.deliver('[EIGENFLUX_TEST] silent', { silent: true })
    ).resolves.toBe(true);

    // Agent loop still runs (so it can call the CLI) — but with delivery off.
    expect(run).toHaveBeenCalledWith({
      sessionKey: 'agent:main:feishu:direct:ou_123',
      message: '[EIGENFLUX_TEST] silent',
      deliver: false,
      idempotencyKey: expect.any(String),
      lane: 'eigenflux-bg',
    });
    // Heartbeat fallback surfaces in the user's main session: must NOT fire.
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(requestHeartbeatNow).not.toHaveBeenCalled();
  });

  test('on waitForRun timeout: reports ok without fallback (older host, no tasks API)', async () => {
    const run = jest.fn().mockResolvedValue({ runId: 'run-subagent-pending' });
    const waitForRun = jest.fn().mockResolvedValue({ status: 'timeout' });
    const runCommandWithTimeout = jest.fn();

    const notifier = new EigenFluxNotifier(
      createApi({
        runtime: {
          subagent: { run, waitForRun },
          system: { runCommandWithTimeout },
        } as unknown as OpenClawPluginApi['runtime'],
      }),
      createLogger(),
      createConfig()
    );

    await expect(notifier.deliver('[EIGENFLUX_TEST] payload')).resolves.toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    expect(waitForRun).toHaveBeenCalledTimes(1);
    // Fallbacks must not run — retrying via CLI would re-run the loop and dup-deliver.
    expect(runCommandWithTimeout).not.toHaveBeenCalled();
  });

  test('on waitForRun timeout: cancels the orphaned run via tasks.runs', async () => {
    const run = jest.fn().mockResolvedValue({ runId: 'run-stuck' });
    const waitForRun = jest.fn().mockResolvedValue({ status: 'timeout' });
    const cancel = jest.fn().mockResolvedValue({ found: true, cancelled: true });
    // list() returns the run keyed by runId; its `id` is the taskId cancel needs.
    const list = jest.fn().mockReturnValue([
      { id: 'task-other', runId: 'run-unrelated' },
      { id: 'task-stuck', runId: 'run-stuck' },
    ]);
    const bindSession = jest.fn().mockReturnValue({ list, cancel });
    const runCommandWithTimeout = jest.fn();

    const notifier = new EigenFluxNotifier(
      createApi({
        runtime: {
          subagent: { run, waitForRun },
          tasks: { runs: { bindSession } },
          system: { runCommandWithTimeout },
        } as unknown as OpenClawPluginApi['runtime'],
      }),
      createLogger(),
      createConfig()
    );

    await expect(notifier.deliver('[EIGENFLUX_TEST] payload')).resolves.toBe(true);
    expect(bindSession).toHaveBeenCalledWith({ sessionKey: 'agent:main:feishu:direct:ou_123' });
    // Cancels the matching run by its taskId — not the unrelated one.
    expect(cancel).toHaveBeenCalledWith({ taskId: 'task-stuck', cfg: expect.anything() });
    // Still no CLI fallback (would dup-deliver).
    expect(runCommandWithTimeout).not.toHaveBeenCalled();
  });

  test('falls back to runtime command agent when waitForRun reports error', async () => {
    const run = jest.fn().mockResolvedValue({ runId: 'run-subagent-fail' });
    const waitForRun = jest
      .fn()
      .mockResolvedValue({ status: 'error', error: 'channel delivery failed' });
    const runCommandWithTimeout = jest.fn().mockResolvedValue({
      code: 0,
      stdout: 'ok',
      stderr: '',
    });

    const notifier = new EigenFluxNotifier(
      createApi({
        runtime: {
          subagent: { run, waitForRun },
          system: { runCommandWithTimeout },
        } as unknown as OpenClawPluginApi['runtime'],
      }),
      createLogger(),
      createConfig()
    );

    await expect(notifier.deliver('[EIGENFLUX_TEST] payload')).resolves.toBe(true);
    expect(runCommandWithTimeout).toHaveBeenCalledWith(
      expect.arrayContaining(['openclaw', 'agent', '--deliver']),
      { timeoutMs: 15000 }
    );
  });

  test('falls back to runtime command agent when runtime.subagent is unavailable', async () => {
    const runCommandWithTimeout = jest.fn().mockResolvedValue({
      code: 0,
      stdout: 'ok',
      stderr: '',
    });

    const notifier = new EigenFluxNotifier(
      createApi({
        runtime: {
          system: { runCommandWithTimeout },
        } as unknown as OpenClawPluginApi['runtime'],
      }),
      createLogger(),
      createConfig()
    );

    await expect(notifier.deliver('[EIGENFLUX_TEST] payload')).resolves.toBe(true);
    expect(runCommandWithTimeout).toHaveBeenCalledWith(
      [
        'openclaw',
        'agent',
        '--message',
        '[EIGENFLUX_TEST] payload',
        '--agent',
        'main',
        '--deliver',
        '--reply-channel',
        'feishu',
        '--reply-to',
        'user:ou_123',
      ],
      { timeoutMs: 15000 }
    );
  });

  test('falls back to runtime heartbeat when command path is unavailable', async () => {
    const enqueueSystemEvent = jest.fn().mockReturnValue(true);
    const requestHeartbeatNow = jest.fn();
    const notifier = new EigenFluxNotifier(
      createApi({
        runtime: {
          system: {
            enqueueSystemEvent,
            requestHeartbeatNow,
          },
        } as unknown as OpenClawPluginApi['runtime'],
      }),
      createLogger(),
      createConfig()
    );

    await expect(notifier.deliver('[EIGENFLUX_TEST] payload')).resolves.toBe(true);
    expect(enqueueSystemEvent).toHaveBeenCalledWith('[EIGENFLUX_TEST] payload', {
      sessionKey: 'agent:main:feishu:direct:ou_123',
      deliveryContext: {
        channel: 'feishu',
        to: 'user:ou_123',
      },
    });
    expect(requestHeartbeatNow).toHaveBeenCalledWith({
      reason: 'plugin:eigenflux',
      coalesceMs: 0,
      agentId: 'main',
      sessionKey: 'agent:main:feishu:direct:ou_123',
    });
  });

  test('prefers direct session over newer group session when scanning session store', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eigenflux-session-store-'));
    const sessionStorePath = path.join(stateDir, 'sessions.json');
    fs.writeFileSync(
      sessionStorePath,
      JSON.stringify({
        'agent:main:main': {
          updatedAt: 100,
          deliveryContext: { channel: 'webchat' },
        },
        'agent:main:feishu:direct:ou_older': {
          updatedAt: 200,
          deliveryContext: {
            channel: 'feishu',
            to: 'user:ou_older',
            accountId: 'default',
          },
        },
        'agent:main:feishu:group:oc_latest': {
          updatedAt: 300,
          deliveryContext: {
            channel: 'feishu',
            to: 'chat:oc_latest',
            accountId: 'default',
          },
        },
      }),
      'utf-8'
    );

    const run = jest.fn().mockResolvedValue({ runId: 'run-external-session' });
    const notifier = new EigenFluxNotifier(
      createApi({
        runtime: {
          subagent: { run },
        } as unknown as OpenClawPluginApi['runtime'],
      }),
      createLogger(),
      {
        ...createConfig(),
        sessionKey: 'main',
        replyChannel: undefined,
        replyTo: undefined,
        replyAccountId: undefined,
        sessionStorePath,
      }
    );

    await expect(notifier.deliver('[EIGENFLUX_TEST] payload')).resolves.toBe(true);
    expect(run).toHaveBeenCalledWith({
      sessionKey: 'agent:main:feishu:direct:ou_older',
      message: '[EIGENFLUX_TEST] payload',
      deliver: true,
      idempotencyKey: expect.any(String),
      lane: 'eigenflux-bg',
    });

    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  test('normalizes explicit reply targets from session store before CLI fallback', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eigenflux-session-store-'));
    const sessionStorePath = path.join(stateDir, 'sessions.json');
    fs.writeFileSync(
      sessionStorePath,
      JSON.stringify({
        'agent:main:feishu:direct:ou_123': {
          updatedAt: 300,
          deliveryContext: {
            channel: 'feishu',
            to: 'user:ou_123',
            accountId: 'default',
          },
        },
      }),
      'utf-8'
    );

    const runCommandWithTimeout = jest.fn().mockResolvedValue({
      code: 0,
      stdout: 'ok',
      stderr: '',
    });

    const notifier = new EigenFluxNotifier(
      createApi({
        runtime: {
          system: { runCommandWithTimeout },
        } as unknown as OpenClawPluginApi['runtime'],
      }),
      createLogger(),
      {
        ...createConfig(),
        sessionKey: 'main',
        replyChannel: 'feishu',
        replyTo: 'user:ou_123',
        sessionStorePath,
      }
    );

    await expect(notifier.deliver('[EIGENFLUX_TEST] payload')).resolves.toBe(true);
    expect(runCommandWithTimeout).toHaveBeenCalledWith(
      [
        'openclaw',
        'agent',
        '--message',
        '[EIGENFLUX_TEST] payload',
        '--agent',
        'main',
        '--deliver',
        '--reply-channel',
        'feishu',
        '--reply-to',
        'user:ou_123',
        '--reply-account',
        'default',
      ],
      { timeoutMs: 15000 }
    );

    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  test('remembers the resolved route after a successful delivery', async () => {
    const runtimeStoreMock = { get: jest.fn(), set: jest.fn() };
    const run = jest.fn().mockResolvedValue({ runId: 'run-subagent-memory' });
    const notifier = new EigenFluxNotifier(
      createApi({
        runtime: {
          subagent: { run },
        } as unknown as OpenClawPluginApi['runtime'],
      }),
      createLogger(),
      {
        ...createConfig(),
        store: runtimeStoreMock,
        serverName: 'eigenflux',
      }
    );

    await expect(notifier.deliver('[EIGENFLUX_TEST] payload')).resolves.toBe(true);

    expect(writeStoredNotificationRouteMock).toHaveBeenCalledTimes(1);
    const [store, server, route] = writeStoredNotificationRouteMock.mock.calls[0];
    expect(store).toBe(runtimeStoreMock);
    expect(server).toBe('eigenflux');
    expect(route).toMatchObject({
      sessionKey: 'agent:main:feishu:direct:ou_123',
      agentId: 'main',
      replyChannel: 'feishu',
      replyTo: 'user:ou_123',
    });
  });

  test('re-resolves fresh route and retries delivery when remembered route fails', async () => {
    readStoredNotificationRouteMock.mockResolvedValue({
      sessionKey: 'agent:main:feishu:direct:ou_stale',
      agentId: 'main',
      replyChannel: 'feishu',
      replyTo: 'user:ou_stale',
      replyAccountId: 'default',
      updatedAt: 1,
    });

    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eigenflux-retry-'));
    const sessionStorePath = path.join(stateDir, 'sessions.json');
    fs.writeFileSync(
      sessionStorePath,
      JSON.stringify({
        'agent:main:feishu:direct:ou_fresh': {
          updatedAt: 500,
          deliveryContext: {
            channel: 'feishu',
            to: 'user:ou_fresh',
            accountId: 'default',
          },
        },
      }),
      'utf-8'
    );

    const run = jest
      .fn()
      .mockRejectedValueOnce(new Error('session expired'))
      .mockResolvedValueOnce({ runId: 'run-fresh' });

    const notifier = new EigenFluxNotifier(
      createApi({
        runtime: {
          subagent: { run },
        } as unknown as OpenClawPluginApi['runtime'],
      }),
      createLogger(),
      {
        ...createConfig(),
        eigenfluxBin: 'eigenflux',
        serverName: 'eigenflux',
        sessionKey: 'main',
        replyChannel: undefined,
        replyTo: undefined,
        replyAccountId: undefined,
        sessionStorePath,
      }
    );

    await expect(notifier.deliver('[EIGENFLUX_TEST] payload')).resolves.toBe(true);

    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0][0].sessionKey).toBe('agent:main:feishu:direct:ou_stale');
    expect(run.mock.calls[1][0].sessionKey).toBe('agent:main:feishu:direct:ou_fresh');

    expect(writeStoredNotificationRouteMock).toHaveBeenCalledTimes(1);
    const [, , savedRoute] = writeStoredNotificationRouteMock.mock.calls[0];
    expect(savedRoute.sessionKey).toBe('agent:main:feishu:direct:ou_fresh');

    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  test('does not overwrite remembered external routes with an internal main fallback', async () => {
    readStoredNotificationRouteMock.mockResolvedValue({
      sessionKey: 'agent:main:feishu:group:oc_saved',
      agentId: 'main',
      replyChannel: 'feishu',
      replyTo: 'chat:oc_saved',
      replyAccountId: 'default',
      updatedAt: 1,
    });

    const run = jest.fn().mockResolvedValue({ runId: 'run-subagent-main' });
    const notifier = new EigenFluxNotifier(
      createApi({
        runtime: {
          subagent: { run },
        } as unknown as OpenClawPluginApi['runtime'],
      }),
      createLogger(),
      {
        ...createConfig(),
        eigenfluxBin: 'eigenflux',
        serverName: 'eigenflux',
        sessionKey: 'main',
        agentId: 'main',
        replyChannel: undefined,
        replyTo: undefined,
        replyAccountId: undefined,
      }
    );

    await expect(notifier.deliver('[EIGENFLUX_TEST] payload')).resolves.toBe(true);

    expect(writeStoredNotificationRouteMock).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: 'agent:main:feishu:group:oc_saved' })
    );
  });

  test('persists a legacy agent:<id>:main DM route after delivery', async () => {
    const runSpy = jest.fn().mockResolvedValue({ runId: 'run-1' });
    const waitSpy = jest.fn().mockResolvedValue({ status: 'ok' });
    const api = createApi({
      runtime: {
        subagent: { run: runSpy, waitForRun: waitSpy },
      } as any,
    });

    const notifier = new EigenFluxNotifier(api, createLogger(), {
      ...createConfig(),
      sessionKey: 'agent:main:main',
      replyChannel: 'feishu',
      replyTo: 'user:ou_legacy',
      replyAccountId: 'default',
      openclawCliBin: 'openclaw',
      routeOverrides: {
        sessionKey: true,
        agentId: true,
        replyChannel: true,
        replyTo: true,
        replyAccountId: true,
      },
    } as any);

    const ok = await notifier.deliver('hello');
    expect(ok).toBe(true);
    expect(writeStoredNotificationRouteMock).toHaveBeenCalled();
    const savedRoute = writeStoredNotificationRouteMock.mock.calls[0][2];
    expect(savedRoute.sessionKey).toBe('agent:main:main');
    expect(savedRoute.replyTo).toBe('user:ou_legacy');
  });

  test('does NOT persist a route with an internal sessionKey (heartbeat)', async () => {
    const runSpy = jest.fn().mockResolvedValue({ runId: 'run-2' });
    const waitSpy = jest.fn().mockResolvedValue({ status: 'ok' });
    const api = createApi({
      runtime: {
        subagent: { run: runSpy, waitForRun: waitSpy },
      } as any,
    });

    const notifier = new EigenFluxNotifier(api, createLogger(), {
      ...createConfig(),
      sessionKey: 'agent:main:heartbeat',
      replyChannel: 'feishu',
      replyTo: 'user:ou_x',
      replyAccountId: 'default',
      openclawCliBin: 'openclaw',
      routeOverrides: {
        sessionKey: true,
        agentId: true,
        replyChannel: true,
        replyTo: true,
        replyAccountId: true,
      },
    } as any);

    await notifier.deliver('hello');
    expect(writeStoredNotificationRouteMock).not.toHaveBeenCalled();
  });

  test('does NOT persist a route missing replyChannel', async () => {
    const runSpy = jest.fn().mockResolvedValue({ runId: 'run-3' });
    const waitSpy = jest.fn().mockResolvedValue({ status: 'ok' });
    const api = createApi({
      runtime: {
        subagent: { run: runSpy, waitForRun: waitSpy },
      } as any,
    });

    const notifier = new EigenFluxNotifier(api, createLogger(), {
      ...createConfig(),
      sessionKey: 'agent:main:main',
      replyChannel: undefined,
      replyTo: undefined,
      replyAccountId: undefined,
      openclawCliBin: 'openclaw',
      routeOverrides: {
        sessionKey: true,
        agentId: true,
        replyChannel: true,
        replyTo: true,
        replyAccountId: true,
      },
    } as any);

    await notifier.deliver('hello');
    expect(writeStoredNotificationRouteMock).not.toHaveBeenCalled();
  });

  test('uses one-shot session derived from targetSessionKey prefix', async () => {
    const run = jest.fn().mockResolvedValue({ runId: 'run-oneshot' });
    const deleteSession = jest.fn().mockResolvedValue(undefined);

    const notifier = new EigenFluxNotifier(
      createApi({
        runtime: {
          subagent: { run, deleteSession },
        } as unknown as OpenClawPluginApi['runtime'],
      }),
      createLogger(),
      createConfig()
    );

    await expect(
      notifier.deliver('[EIGENFLUX_FEED_PAYLOAD] test', {
        targetSessionKey: 'eigenflux:feed:eigenflux',
      })
    ).resolves.toBe(true);

    // sessionKey should start with the prefix but have a random suffix
    const callArgs = run.mock.calls[0]?.[0];
    expect(callArgs.sessionKey).toMatch(/^eigenflux:feed:eigenflux:\d+-[a-f0-9]{8}$/);
    expect(callArgs.message).toBe('[EIGENFLUX_FEED_PAYLOAD] test');
    expect(callArgs.deliver).toBe(true);
  });

  test('deletes one-shot session after successful delivery', async () => {
    const run = jest.fn().mockResolvedValue({ runId: 'run-cleanup' });
    const deleteSession = jest.fn().mockResolvedValue(undefined);

    const notifier = new EigenFluxNotifier(
      createApi({
        runtime: {
          subagent: { run, deleteSession },
        } as unknown as OpenClawPluginApi['runtime'],
      }),
      createLogger(),
      createConfig()
    );

    await notifier.deliver('[EIGENFLUX_FEED_PAYLOAD] test', {
      targetSessionKey: 'eigenflux:feed:eigenflux',
    });

    expect(deleteSession).toHaveBeenCalledTimes(1);
    const deletedKey = deleteSession.mock.calls[0]?.[0]?.sessionKey;
    expect(deletedKey).toMatch(/^eigenflux:feed:eigenflux:\d+-[a-f0-9]{8}$/);
    expect(deleteSession.mock.calls[0]?.[0]?.deleteTranscript).toBe(true);
  });

  test('deletes one-shot session even when delivery fails', async () => {
    // No subagent available — delivery fails
    const deleteSession = jest.fn().mockResolvedValue(undefined);

    const notifier = new EigenFluxNotifier(
      createApi({
        runtime: {
          subagent: { deleteSession },
        } as unknown as OpenClawPluginApi['runtime'],
      }),
      createLogger(),
      createConfig()
    );

    const result = await notifier.deliver('[EIGENFLUX_FEED_PAYLOAD] test', {
      targetSessionKey: 'eigenflux:feed:eigenflux',
    });

    expect(result).toBe(false);
    // Session should still be cleaned up
    expect(deleteSession).toHaveBeenCalledTimes(1);
  });

  test('does NOT remember route when targetSessionKey is used', async () => {
    const run = jest.fn().mockResolvedValue({ runId: 'run-no-remember' });
    const deleteSession = jest.fn().mockResolvedValue(undefined);

    const notifier = new EigenFluxNotifier(
      createApi({
        runtime: {
          subagent: { run, deleteSession },
        } as unknown as OpenClawPluginApi['runtime'],
      }),
      createLogger(),
      createConfig()
    );

    await notifier.deliver('[EIGENFLUX_FEED_PAYLOAD] test', {
      targetSessionKey: 'eigenflux:feed:eigenflux',
    });

    expect(writeStoredNotificationRouteMock).not.toHaveBeenCalled();
  });

  test('skips heartbeat fallbacks when targetSessionKey is provided', async () => {
    const runtimeCommand = jest.fn().mockResolvedValue({ code: 1, stderr: 'fail' });
    const enqueueSystemEvent = jest.fn().mockReturnValue(true);
    const requestHeartbeatNow = jest.fn();
    const deleteSession = jest.fn().mockResolvedValue(undefined);

    const notifier = new EigenFluxNotifier(
      createApi({
        runtime: {
          subagent: { deleteSession },
          system: {
            runCommandWithTimeout: runtimeCommand,
            enqueueSystemEvent,
            requestHeartbeatNow,
          },
        } as unknown as OpenClawPluginApi['runtime'],
      }),
      createLogger(),
      createConfig()
    );

    await notifier.deliver('[EIGENFLUX_FEED_PAYLOAD] test', {
      targetSessionKey: 'eigenflux:feed:eigenflux',
    });

    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(requestHeartbeatNow).not.toHaveBeenCalled();
  });

  test('gracefully degrades when deleteSession is not available on runtime', async () => {
    const run = jest.fn().mockResolvedValue({ runId: 'run-no-delete' });
    // subagent has run but NO deleteSession
    const notifier = new EigenFluxNotifier(
      createApi({
        runtime: {
          subagent: { run },
        } as unknown as OpenClawPluginApi['runtime'],
      }),
      createLogger(),
      createConfig()
    );

    const result = await notifier.deliver('[EIGENFLUX_FEED_PAYLOAD] test', {
      targetSessionKey: 'eigenflux:feed:eigenflux',
    });

    // Delivery should succeed even without deleteSession
    expect(result).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });

  test('deliver returns original result when deleteSession throws', async () => {
    const run = jest.fn().mockResolvedValue({ runId: 'run-delete-throws' });
    const deleteSession = jest.fn().mockRejectedValue(new Error('delete RPC failed'));

    const notifier = new EigenFluxNotifier(
      createApi({
        runtime: {
          subagent: { run, deleteSession },
        } as unknown as OpenClawPluginApi['runtime'],
      }),
      createLogger(),
      createConfig()
    );

    // Delivery should still return true — deleteSession failure is swallowed
    const result = await notifier.deliver('[EIGENFLUX_FEED_PAYLOAD] test', {
      targetSessionKey: 'eigenflux:feed:eigenflux',
    });

    expect(result).toBe(true);
    expect(deleteSession).toHaveBeenCalledTimes(1);
  });
});
