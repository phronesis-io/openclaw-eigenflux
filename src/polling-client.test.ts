import {
  EigenFluxPollingClient,
  readPollIntervalSec,
  DEFAULT_POLL_INTERVAL_SEC,
  MIN_POLL_INTERVAL_SEC,
  MAX_POLL_INTERVAL_SEC,
} from './polling-client';
import { Logger } from './logger';
import type { CliResult } from './cli-executor';

jest.mock('./cli-executor');

import { execEigenflux } from './cli-executor';

const execEigenfluxMock = execEigenflux as jest.MockedFunction<typeof execEigenflux>;

function createLoggerSpies() {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };
}

function createLogger(spies = createLoggerSpies()): Logger {
  return new Logger(spies);
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('EigenFluxPollingClient', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('polls feed via CLI and forwards the full payload to callback', async () => {
    const onFeedPolled = jest.fn().mockResolvedValue(undefined);
    const onAuthRequired = jest.fn().mockResolvedValue(undefined);

    execEigenfluxMock.mockResolvedValue({
      kind: 'success',
      data: {
        items: [
          {
            item_id: 'item-101',
            group_id: 'group-101',
            summary: 'Important signal',
            broadcast_type: 'info',
            updated_at: 1760000000000,
          },
        ],
        has_more: false,
        notifications: [
          {
            notification_id: 'notif-1',
            type: 'system',
            content: 'Feed refreshed successfully',
            created_at: 1760000000100,
          },
        ],
      },
    } as CliResult<any>);

    const client = new EigenFluxPollingClient({
      serverName: 'eigenflux',
      eigenfluxBin: 'eigenflux',
      resolvePollIntervalSec: jest.fn().mockResolvedValue(60),
      logger: createLogger(),
      onFeedPolled,
      onAuthRequired,
    });

    const result = await client.pollOnce();

    expect(result).toEqual(
      expect.objectContaining({
        kind: 'success',
      })
    );
    expect(onFeedPolled).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 0,
        msg: 'success',
        data: expect.objectContaining({
          items: [
            expect.objectContaining({
              item_id: 'item-101',
              summary: 'Important signal',
            }),
          ],
          notifications: [
            expect.objectContaining({
              notification_id: 'notif-1',
            }),
          ],
        }),
      })
    );
    expect(onAuthRequired).not.toHaveBeenCalled();

    expect(execEigenfluxMock).toHaveBeenCalledWith(
      'eigenflux',
      ['feed', 'poll', '--limit', '20', '--action', 'refresh', '-s', 'eigenflux', '-f', 'json'],
      expect.objectContaining({ logger: expect.any(Logger) })
    );
  });

  test('reports a successful poll even when content delivery throws', async () => {
    execEigenfluxMock.mockResolvedValue({ kind: 'success', data: {
      items: [{ item_id: 'delivery-error-item' }], has_more: false, notifications: [],
    } } as CliResult<any>);
    const onPollSuccess = jest.fn().mockResolvedValue(undefined);
    const onFeedPolled = jest.fn().mockRejectedValue(new Error('delivery unavailable'));
    const client = new EigenFluxPollingClient({
      serverName: 'eigenflux', eigenfluxBin: 'eigenflux',
      resolvePollIntervalSec: jest.fn().mockResolvedValue(60), logger: createLogger(),
      onPollSuccess, onFeedPolled, onAuthRequired: jest.fn().mockResolvedValue(undefined),
    });
    await client.pollOnce();
    expect(onPollSuccess).toHaveBeenCalledTimes(1);
    expect(onFeedPolled).toHaveBeenCalledTimes(1);
    expect(onFeedPolled.mock.invocationCallOrder[0]).toBeLessThan(onPollSuccess.mock.invocationCallOrder[0]);
  });

  test('runs the Heartbeat plan hook before polling the feed', async () => {
    const onHeartbeatStart = jest.fn().mockResolvedValue(undefined);
    execEigenfluxMock.mockResolvedValue({
      kind: 'success',
      data: { items: [], has_more: false, notifications: [] },
    } as CliResult<any>);

    const client = new EigenFluxPollingClient({
      serverName: 'eigenflux',
      eigenfluxBin: 'eigenflux',
      resolvePollIntervalSec: jest.fn().mockResolvedValue(60),
      logger: createLogger(),
      onHeartbeatStart,
      onFeedPolled: jest.fn().mockResolvedValue(undefined),
      onAuthRequired: jest.fn().mockResolvedValue(undefined),
    });

    await expect(client.pollOnce()).resolves.toEqual(
      expect.objectContaining({ kind: 'success' })
    );
    expect(onHeartbeatStart).toHaveBeenCalledTimes(1);
    expect(onHeartbeatStart.mock.invocationCallOrder[0]).toBeLessThan(
      execEigenfluxMock.mock.invocationCallOrder[0]
    );
  });

  test('skips polling when the Heartbeat plan hook fails', async () => {
    const loggerSpies = createLoggerSpies();
    execEigenfluxMock.mockResolvedValue({
      kind: 'success',
      data: { items: [], has_more: false, notifications: [] },
    } as CliResult<any>);

    const client = new EigenFluxPollingClient({
      serverName: 'eigenflux',
      eigenfluxBin: 'eigenflux',
      resolvePollIntervalSec: jest.fn().mockResolvedValue(60),
      logger: createLogger(loggerSpies),
      onHeartbeatStart: jest.fn().mockRejectedValue(new Error('plan unavailable')),
      onFeedPolled: jest.fn().mockResolvedValue(undefined),
      onAuthRequired: jest.fn().mockResolvedValue(undefined),
    });

    await expect(client.pollOnce()).resolves.toEqual(
      expect.objectContaining({ kind: 'skipped', reason: 'plan_unavailable' })
    );
    expect(loggerSpies.warn).toHaveBeenCalledWith(
      expect.stringContaining('onHeartbeatStart hook failed')
    );
  });

  test.each([true, false])('plan authentication failure skips Feed and respects notifyAuthRequired=%s', async (notifyAuthRequired) => {
    execEigenfluxMock.mockClear();
    const onAuthRequired = jest.fn().mockResolvedValue(undefined);
    const client = new EigenFluxPollingClient({
      serverName: 'alpha', eigenfluxBin: 'eigenflux',
      resolvePollIntervalSec: jest.fn().mockResolvedValue(60), logger: createLogger(),
      onHeartbeatStart: jest.fn().mockResolvedValue(false),
      onFeedPolled: jest.fn(), onAuthRequired,
    });
    await expect(client.pollOnce({ notifyAuthRequired })).resolves.toEqual({
      kind: 'auth_required', authEvent: { reason: 'auth_required' },
    });
    expect(execEigenfluxMock).not.toHaveBeenCalled();
    expect(onAuthRequired).toHaveBeenCalledTimes(notifyAuthRequired ? 1 : 0);
  });

  test('failed auth notification does not retry authentication through Feed', async () => {
    execEigenfluxMock.mockClear();
    const client = new EigenFluxPollingClient({
      serverName: 'alpha', eigenfluxBin: 'eigenflux',
      resolvePollIntervalSec: jest.fn().mockResolvedValue(60), logger: createLogger(),
      onHeartbeatStart: jest.fn().mockResolvedValue(false),
      onFeedPolled: jest.fn(), onAuthRequired: jest.fn().mockRejectedValue(new Error('host unavailable')),
    });
    await expect(client.pollOnce()).resolves.toMatchObject({ kind: 'error' });
    expect(execEigenfluxMock).not.toHaveBeenCalled();
  });

  test('keeps the plan CLI owner action when stopping before Feed', async () => {
    execEigenfluxMock.mockClear();
    const stderr = JSON.stringify({ code: 'IDENTITY_UNAVAILABLE', owner_action: 'Restore the original installation files.' });
    const onAuthRequired = jest.fn().mockResolvedValue(undefined);
    const client = new EigenFluxPollingClient({
      serverName: 'alpha', eigenfluxBin: 'eigenflux',
      resolvePollIntervalSec: jest.fn().mockResolvedValue(60), logger: createLogger(),
      onHeartbeatStart: jest.fn().mockResolvedValue({ kind: 'auth_required', stderr }),
      onFeedPolled: jest.fn(), onAuthRequired,
    });
    await expect(client.pollOnce()).resolves.toEqual({ kind: 'auth_required',
      authEvent: { reason: 'auth_required', stderr } });
    expect(onAuthRequired).toHaveBeenCalledWith({ reason: 'auth_required', stderr });
    expect(execEigenfluxMock).not.toHaveBeenCalled();
  });

  test('unavailable credential service stops Feed without a login notification', async () => {
    execEigenfluxMock.mockClear();
    const error = new Error('503 AGENT_AUTH_UNAVAILABLE');
    const onAuthRequired = jest.fn();
    const client = new EigenFluxPollingClient({
      serverName: 'alpha', eigenfluxBin: 'eigenflux',
      resolvePollIntervalSec: jest.fn().mockResolvedValue(60), logger: createLogger(),
      onHeartbeatStart: jest.fn().mockResolvedValue({ kind: 'auth_unavailable', error }),
      onFeedPolled: jest.fn(), onAuthRequired,
    });
    await expect(client.pollOnce()).resolves.toEqual({ kind: 'error', error });
    expect(execEigenfluxMock).not.toHaveBeenCalled();
    expect(onAuthRequired).not.toHaveBeenCalled();
  });

  test('emits auth-required callback when CLI returns auth_required', async () => {
    const onFeedPolled = jest.fn().mockResolvedValue(undefined);
    const onAuthRequired = jest.fn().mockResolvedValue(undefined);

    execEigenfluxMock.mockResolvedValue({
      kind: 'auth_required',
      stderr: 'token expired',
    } as CliResult<any>);

    const client = new EigenFluxPollingClient({
      serverName: 'eigenflux',
      eigenfluxBin: 'eigenflux',
      resolvePollIntervalSec: jest.fn().mockResolvedValue(60),
      logger: createLogger(),
      onFeedPolled,
      onAuthRequired,
    });

    const result = await client.pollOnce();

    expect(result).toEqual({
      kind: 'auth_required',
      authEvent: {
        reason: 'auth_required',
        stderr: 'token expired',
      },
    });
    expect(onAuthRequired).toHaveBeenCalledWith({
      reason: 'auth_required',
      stderr: 'token expired',
    });
    expect(onFeedPolled).not.toHaveBeenCalled();
  });

  test('returns error result when CLI command fails', async () => {
    const loggerSpies = createLoggerSpies();

    execEigenfluxMock.mockResolvedValue({
      kind: 'error',
      error: new Error('connect ECONNREFUSED 127.0.0.1:8080'),
      exitCode: 1,
      stderr: 'connection failed',
    } as CliResult<any>);

    const client = new EigenFluxPollingClient({
      serverName: 'eigenflux',
      eigenfluxBin: 'eigenflux',
      resolvePollIntervalSec: jest.fn().mockResolvedValue(60),
      logger: createLogger(loggerSpies),
      onFeedPolled: jest.fn().mockResolvedValue(undefined),
      onAuthRequired: jest.fn().mockResolvedValue(undefined),
    });

    const result = await client.pollOnce();

    expect(result.kind).toBe('error');
  });

  test('does not re-enter feed polling while a previous poll is still running', async () => {
    const loggerSpies = createLoggerSpies();
    const cliDeferred = createDeferred<CliResult<any>>();

    execEigenfluxMock.mockReturnValue(cliDeferred.promise);

    const client = new EigenFluxPollingClient({
      serverName: 'eigenflux',
      eigenfluxBin: 'eigenflux',
      resolvePollIntervalSec: jest.fn().mockResolvedValue(60),
      logger: createLogger(loggerSpies),
      onFeedPolled: jest.fn().mockResolvedValue(undefined),
      onAuthRequired: jest.fn().mockResolvedValue(undefined),
    });

    const firstPoll = client.pollOnce();
    const secondPoll = client.pollOnce();

    expect(execEigenfluxMock).toHaveBeenCalledTimes(1);
    expect(loggerSpies.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'Skipping feed poll because a previous poll is still in progress'
      )
    );

    cliDeferred.resolve({
      kind: 'success',
      data: { items: [], has_more: false, notifications: [] },
    } as CliResult<any>);

    const [firstResult, secondResult] = await Promise.all([firstPoll, secondPoll]);
    expect(firstResult).toEqual(secondResult);
    expect(firstResult.kind).toBe('success');
  });

  test('does not notify feed callback when items and notifications are empty', async () => {
    const onFeedPolled = jest.fn().mockResolvedValue(undefined);

    execEigenfluxMock.mockResolvedValue({
      kind: 'success',
      data: { items: [], has_more: false, notifications: [] },
    } as CliResult<any>);

    const client = new EigenFluxPollingClient({
      serverName: 'eigenflux',
      eigenfluxBin: 'eigenflux',
      resolvePollIntervalSec: jest.fn().mockResolvedValue(60),
      logger: createLogger(),
      onFeedPolled,
      onAuthRequired: jest.fn().mockResolvedValue(undefined),
    });

    const result = await client.pollOnce();

    expect(result.kind).toBe('success');
    expect(onFeedPolled).not.toHaveBeenCalled();
  });

  test('invokes onPollSuccess on every successful poll, even with empty feed', async () => {
    const onPollSuccess = jest.fn().mockResolvedValue(undefined);

    execEigenfluxMock.mockResolvedValue({
      kind: 'success',
      data: { items: [], has_more: false, notifications: [] },
    } as CliResult<any>);

    const client = new EigenFluxPollingClient({
      serverName: 'eigenflux',
      eigenfluxBin: 'eigenflux',
      resolvePollIntervalSec: jest.fn().mockResolvedValue(60),
      logger: createLogger(),
      onFeedPolled: jest.fn().mockResolvedValue(undefined),
      onAuthRequired: jest.fn().mockResolvedValue(undefined),
      onPollSuccess,
    });

    const result = await client.pollOnce();

    expect(result.kind).toBe('success');
    expect(onPollSuccess).toHaveBeenCalledTimes(1);
  });

  test('does not invoke onPollSuccess when CLI returns auth_required', async () => {
    const onPollSuccess = jest.fn().mockResolvedValue(undefined);

    execEigenfluxMock.mockResolvedValue({
      kind: 'auth_required',
      stderr: 'token expired',
    } as CliResult<any>);

    const client = new EigenFluxPollingClient({
      serverName: 'eigenflux',
      eigenfluxBin: 'eigenflux',
      resolvePollIntervalSec: jest.fn().mockResolvedValue(60),
      logger: createLogger(),
      onFeedPolled: jest.fn().mockResolvedValue(undefined),
      onAuthRequired: jest.fn().mockResolvedValue(undefined),
      onPollSuccess,
    });

    await client.pollOnce();
    expect(onPollSuccess).not.toHaveBeenCalled();
  });

  test('onPollSuccess rejection does not fail the poll', async () => {
    const loggerSpies = createLoggerSpies();
    const onPollSuccess = jest.fn().mockRejectedValue(new Error('report boom'));

    execEigenfluxMock.mockResolvedValue({
      kind: 'success',
      data: { items: [], has_more: false, notifications: [] },
    } as CliResult<any>);

    const client = new EigenFluxPollingClient({
      serverName: 'eigenflux',
      eigenfluxBin: 'eigenflux',
      resolvePollIntervalSec: jest.fn().mockResolvedValue(60),
      logger: createLogger(loggerSpies),
      onFeedPolled: jest.fn().mockResolvedValue(undefined),
      onAuthRequired: jest.fn().mockResolvedValue(undefined),
      onPollSuccess,
    });

    const result = await client.pollOnce();

    expect(result.kind).toBe('success');
    expect(loggerSpies.warn).toHaveBeenCalledWith(
      expect.stringContaining('onPollSuccess hook failed')
    );
  });

  test('re-resolves pollInterval after every poll and reschedules with the new value', async () => {
    jest.useFakeTimers();
    try {
      execEigenfluxMock.mockResolvedValue({
        kind: 'success',
        data: { items: [], has_more: false, notifications: [] },
      } as CliResult<any>);

      const resolvePollIntervalSec = jest
        .fn<Promise<number>, []>()
        .mockResolvedValueOnce(30)
        .mockResolvedValueOnce(90);

      const client = new EigenFluxPollingClient({
        serverName: 'eigenflux',
        eigenfluxBin: 'eigenflux',
        resolvePollIntervalSec,
        logger: createLogger(),
        onFeedPolled: jest.fn().mockResolvedValue(undefined),
        onAuthRequired: jest.fn().mockResolvedValue(undefined),
      });

      await client.start();
      // Initial poll + first scheduleNext should have consulted the resolver once.
      // Each poll cycle reads the CLI version, then polls.
      expect(resolvePollIntervalSec).toHaveBeenCalledTimes(1);
      expect(execEigenfluxMock).toHaveBeenCalledTimes(2);

      // Fire the first scheduled timer → triggers second poll, then resolver again.
      await jest.advanceTimersByTimeAsync(30_000);
      // flush pending microtasks after setTimeout callback so scheduleNext() runs
      await Promise.resolve();
      await Promise.resolve();

      expect(execEigenfluxMock).toHaveBeenCalledTimes(4);
      expect(resolvePollIntervalSec).toHaveBeenCalledTimes(2);

      client.stop();
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('readPollIntervalSec', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('returns numeric value from CLI when within range', async () => {
    execEigenfluxMock.mockResolvedValue({ kind: 'success', data: 120 } as CliResult<any>);

    const interval = await readPollIntervalSec('eigenflux', 'eigenflux', createLogger());
    expect(interval).toBe(120);
    expect(execEigenfluxMock).toHaveBeenCalledWith(
      'eigenflux',
      ['config', 'get', '--key', 'feed_poll_interval', '--server', 'eigenflux', '--format', 'json'],
      expect.any(Object)
    );
  });

  test('parses numeric string values from CLI', async () => {
    execEigenfluxMock.mockResolvedValue({ kind: 'success', data: '45' } as CliResult<any>);
    const interval = await readPollIntervalSec('eigenflux', 'eigenflux', createLogger());
    expect(interval).toBe(45);
  });

  test('falls back to default when CLI returns no value', async () => {
    execEigenfluxMock.mockResolvedValue({ kind: 'success', data: undefined } as CliResult<any>);
    const interval = await readPollIntervalSec('eigenflux', 'eigenflux', createLogger());
    expect(interval).toBe(DEFAULT_POLL_INTERVAL_SEC);
  });

  test('falls back to default when CLI errors out', async () => {
    execEigenfluxMock.mockResolvedValue({
      kind: 'error',
      error: new Error('boom'),
      exitCode: 1,
      stderr: '',
    } as CliResult<any>);
    const interval = await readPollIntervalSec('eigenflux', 'eigenflux', createLogger());
    expect(interval).toBe(DEFAULT_POLL_INTERVAL_SEC);
  });

  test('falls back to default when value is below minimum', async () => {
    const spies = createLoggerSpies();
    execEigenfluxMock.mockResolvedValue({
      kind: 'success',
      data: MIN_POLL_INTERVAL_SEC - 1,
    } as CliResult<any>);
    const interval = await readPollIntervalSec('eigenflux', 'eigenflux', createLogger(spies));
    expect(interval).toBe(DEFAULT_POLL_INTERVAL_SEC);
    expect(spies.warn).toHaveBeenCalledWith(
      expect.stringContaining('outside')
    );
  });

  test('falls back to default when value is above maximum', async () => {
    execEigenfluxMock.mockResolvedValue({
      kind: 'success',
      data: MAX_POLL_INTERVAL_SEC + 1,
    } as CliResult<any>);
    const interval = await readPollIntervalSec('eigenflux', 'eigenflux', createLogger());
    expect(interval).toBe(DEFAULT_POLL_INTERVAL_SEC);
  });

  test('falls back to default when value is non-numeric', async () => {
    execEigenfluxMock.mockResolvedValue({ kind: 'success', data: 'not-a-number' } as CliResult<any>);
    const interval = await readPollIntervalSec('eigenflux', 'eigenflux', createLogger());
    expect(interval).toBe(DEFAULT_POLL_INTERVAL_SEC);
  });
});

describe('scheduled Feed gates', () => {
  test.each(['plan_unavailable', 'capacity'] as const)('%s skips Feed and keeps maintenance', async reason => {
    execEigenfluxMock.mockClear();
    const maintenance=jest.fn().mockResolvedValue(undefined);
    const client=new EigenFluxPollingClient({serverName:'test',eigenfluxBin:'eigenflux',logger:createLogger(),
      resolvePollIntervalSec:async()=>60,onFeedPolled:async()=>{},onAuthRequired:async()=>{},
      onHeartbeatStart:async()=>reason==='plan_unavailable'?{kind:'plan_unavailable'}:true,
      shouldPoll:()=>reason!=='capacity',onPollSkipped:maintenance});
    expect(await client.pollOnce()).toEqual({kind:'skipped',reason});
    expect(execEigenfluxMock).not.toHaveBeenCalled();expect(maintenance).toHaveBeenCalledTimes(1);
  });
  test.each(['0.6.10','0.7.0','0.7.1','0.8.1','unknown','0.7.1-rc.1'])('gates origin for CLI %s and reads the version each cycle', async version => {
    execEigenfluxMock.mockReset().mockImplementation(async (_bin,args)=>({kind:'success',data:args[0]==='version'?{cli_version:version}:{items:[],notifications:[],has_more:false}}));
    const client=new EigenFluxPollingClient({serverName:'test',eigenfluxBin:'eigenflux',logger:createLogger(),
      resolvePollIntervalSec:async()=>60,onFeedPolled:async()=>{},onAuthRequired:async()=>{}});
    await client.start();client.stop();await client.pollOnce();
    const polls=execEigenfluxMock.mock.calls.filter(call=>call[1].includes('poll'));
    expect(polls).toHaveLength(2);
    expect(execEigenfluxMock.mock.calls.filter(call=>call[1][0]==='version')).toHaveLength(2);
    for (const [,argv] of polls) {expect(argv.includes('--batch')).toBe(version==='0.7.1'||version==='0.8.1'); if(argv.includes('--batch'))expect(argv[argv.indexOf('--batch')+1]).toBe('5');expect(argv.includes('--origin')).toBe(version==='0.7.0'||version==='0.7.1'||version==='0.8.1');if(argv.includes('--origin'))expect(argv.slice(-2)).toEqual(['--origin','heartbeat']);}
  });

  test('a CLI upgrade or downgrade between cycles flips --origin without restart', async () => {
    let version='0.6.10';
    execEigenfluxMock.mockReset().mockImplementation(async (_bin,args)=>({kind:'success',data:args[0]==='version'?{cli_version:version}:{items:[],notifications:[],has_more:false}}));
    const client=new EigenFluxPollingClient({serverName:'test',eigenfluxBin:'eigenflux',logger:createLogger(),
      resolvePollIntervalSec:async()=>60,onFeedPolled:async()=>{},onAuthRequired:async()=>{}});
    const originOf=async (options?:{origin:'owner'})=>{
      execEigenfluxMock.mockClear();
      await client.pollOnce(options);
      const argv=execEigenfluxMock.mock.calls.find(call=>call[1].includes('poll'))![1];
      expect(argv.includes('--batch')).toBe(version==='0.7.1');
      return argv.includes('--origin')?argv[argv.indexOf('--origin')+1]:null;
    };
    expect(await originOf()).toBeNull();
    version='0.7.1';
    expect(await originOf()).toBe('heartbeat');
    expect(await originOf({origin:'owner'})).toBe('owner');
    version='0.6.10';
    expect(await originOf()).toBeNull();
    expect(await originOf({origin:'owner'})).toBeNull();
  });

  test.each([
    ['an error result', async () => ({kind:'error',error:new Error('version failed')})],
    ['a missing cli_version', async () => ({kind:'success',data:{}})],
    ['a thrown call', async () => { throw new Error('spawn failed'); }],
  ] as const)('omits --origin when the version read returns %s', async (_label, readVersion) => {
    execEigenfluxMock.mockReset().mockImplementation(async (_bin,args)=>args[0]==='version'
      ? (readVersion as () => Promise<any>)()
      : ({kind:'success',data:{items:[],notifications:[],has_more:false}}));
    const client=new EigenFluxPollingClient({serverName:'test',eigenfluxBin:'eigenflux',logger:createLogger(),
      resolvePollIntervalSec:async()=>60,onFeedPolled:async()=>{},onAuthRequired:async()=>{}});
    for (const options of [undefined,{origin:'owner' as const}]) {
      execEigenfluxMock.mockClear();
      expect((await client.pollOnce(options)).kind).toBe('success');
      const argv=execEigenfluxMock.mock.calls.find(call=>call[1].includes('poll'))![1];
      expect(argv).not.toContain('--origin');
    }
  });

  test('warns once after consecutive plan_unavailable skips and logs recovery once', async () => {
    const spies=createLoggerSpies();
    let planAvailable=false;
    execEigenfluxMock.mockReset().mockResolvedValue({kind:'success',data:{items:[],notifications:[],has_more:false}});
    const client=new EigenFluxPollingClient({serverName:'test',eigenfluxBin:'eigenflux',logger:createLogger(spies),
      resolvePollIntervalSec:async()=>60,onFeedPolled:async()=>{},onAuthRequired:async()=>{},
      onHeartbeatStart:async()=>planAvailable?true:{kind:'plan_unavailable'}});
    const pausedWarnings=()=>spies.warn.mock.calls.filter(([message])=>String(message).includes('Feed polling is paused')).length;
    const recoveries=()=>spies.info.mock.calls.filter(([message])=>String(message).includes('Feed polling resumed')).length;

    await client.pollOnce();await client.pollOnce();
    expect(pausedWarnings()).toBe(0);
    await client.pollOnce();
    expect(pausedWarnings()).toBe(1);
    expect(spies.warn.mock.calls.find(([message])=>String(message).includes('Feed polling is paused'))![0])
      .toMatch(/heartbeat plan is unavailable.*update the EigenFlux CLI/);
    await client.pollOnce();await client.pollOnce();
    expect(pausedWarnings()).toBe(1);

    planAvailable=true;
    expect((await client.pollOnce()).kind).toBe('success');
    await client.pollOnce();
    expect(recoveries()).toBe(1);

    planAvailable=false;
    await client.pollOnce();await client.pollOnce();
    expect(pausedWarnings()).toBe(1);
    await client.pollOnce();
    expect(pausedWarnings()).toBe(2);
  });

  test('a short plan_unavailable streak neither warns nor logs recovery', async () => {
    const spies=createLoggerSpies();
    const starts=[{kind:'plan_unavailable'},{kind:'plan_unavailable'},true,{kind:'plan_unavailable'},{kind:'plan_unavailable'}] as const;
    let index=0;
    execEigenfluxMock.mockReset().mockResolvedValue({kind:'success',data:{items:[],notifications:[],has_more:false}});
    const client=new EigenFluxPollingClient({serverName:'test',eigenfluxBin:'eigenflux',logger:createLogger(spies),
      resolvePollIntervalSec:async()=>60,onFeedPolled:async()=>{},onAuthRequired:async()=>{},
      onHeartbeatStart:async()=>starts[index++] as any});
    for (let cycle=0; cycle<starts.length; cycle++) await client.pollOnce();
    expect(spies.warn.mock.calls.some(([message])=>String(message).includes('Feed polling is paused'))).toBe(false);
    expect(spies.info.mock.calls.some(([message])=>String(message).includes('Feed polling resumed'))).toBe(false);
  });
});


test('an owner poll waits for scheduled maintenance then fetches independently', async () => {
  let release!:()=>void;
  const maintenance=new Promise<void>(resolve=>{release=resolve;});
  execEigenfluxMock.mockReset().mockResolvedValue({kind:'success',data:{items:[],notifications:[],has_more:false}});
  const client=new EigenFluxPollingClient({serverName:'test',eigenfluxBin:'eigenflux',logger:createLogger(),
    resolvePollIntervalSec:async()=>60,onFeedPolled:async()=>{},onAuthRequired:async()=>{},
    shouldPoll:()=>false,onPollSkipped:()=>maintenance});
  const scheduled=client.pollOnce();
  const owner=client.pollOnce({origin:'owner',notifyFeed:false});
  expect(execEigenfluxMock).not.toHaveBeenCalled();
  release();
  expect(await scheduled).toEqual({kind:'skipped',reason:'capacity'});
  expect((await owner).kind).toBe('success');
  expect(execEigenfluxMock.mock.calls.filter(call=>call[1].includes('poll'))).toHaveLength(1);
});
