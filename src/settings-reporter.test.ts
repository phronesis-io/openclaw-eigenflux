import { EigenFluxSettingsReporter, resolveAgentMode } from './settings-reporter';
import { Logger } from './logger';
import type { CliResult } from './cli-executor';

jest.mock('./cli-executor');

import { execEigenflux } from './cli-executor';

const execMock = execEigenflux as jest.MockedFunction<typeof execEigenflux>;

function createLoggerSpies() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

function createLogger(spies = createLoggerSpies()): Logger {
  return new Logger(spies);
}

describe('resolveAgentMode', () => {
  test('maps explicit EIGENFLUX_CHANNEL=skill to skill', () => {
    expect(resolveAgentMode({ EIGENFLUX_CHANNEL: 'skill' })).toBe('skill');
  });

  test('maps explicit EIGENFLUX_CHANNEL=plugin to plugin', () => {
    expect(resolveAgentMode({ EIGENFLUX_CHANNEL: 'plugin' })).toBe('plugin');
  });

  test('maps openclaw host signal to plugin', () => {
    expect(resolveAgentMode({ EIGENFLUX_HOST: 'openclaw/0.0.14' })).toBe('plugin');
  });

  test('maps openclaw channel to plugin', () => {
    expect(resolveAgentMode({ EIGENFLUX_CHANNEL: 'openclaw' })).toBe('plugin');
  });

  test('channel takes precedence over host', () => {
    expect(
      resolveAgentMode({ EIGENFLUX_CHANNEL: 'skill', EIGENFLUX_HOST: 'openclaw/1.0' })
    ).toBe('skill');
  });

  test('returns undefined when no usable signal', () => {
    expect(resolveAgentMode({})).toBeUndefined();
    expect(resolveAgentMode({ EIGENFLUX_CHANNEL: 'discord' })).toBeUndefined();
  });
});

describe('EigenFluxSettingsReporter', () => {
  beforeEach(() => {
    execMock.mockReset();
  });

  test('invokes `settings push --mode <mode>` once on a successful poll', async () => {
    execMock.mockResolvedValue({ kind: 'success', data: '' } as CliResult<any>);

    const reporter = new EigenFluxSettingsReporter({
      serverName: 'srv',
      eigenfluxBin: '/usr/bin/eigenflux',
      logger: createLogger(),
      resolveMode: () => 'plugin',
    });

    const ok = await reporter.report();

    expect(ok).toBe(true);
    expect(execMock).toHaveBeenCalledTimes(1);
    expect(execMock).toHaveBeenCalledWith(
      '/usr/bin/eigenflux',
      ['settings', 'push', '--mode', 'plugin', '-s', 'srv'],
      expect.objectContaining({ parseJson: false })
    );
  });

  test('passes through skill mode', async () => {
    execMock.mockResolvedValue({ kind: 'success', data: '' } as CliResult<any>);

    const reporter = new EigenFluxSettingsReporter({
      serverName: 'srv',
      eigenfluxBin: 'eigenflux',
      logger: createLogger(),
      resolveMode: () => 'skill',
    });

    await reporter.report();
    expect(execMock).toHaveBeenCalledWith(
      'eigenflux',
      ['settings', 'push', '--mode', 'skill', '-s', 'srv'],
      expect.any(Object)
    );
  });

  test('omits --mode when mode cannot be determined', async () => {
    execMock.mockResolvedValue({ kind: 'success', data: '' } as CliResult<any>);

    const reporter = new EigenFluxSettingsReporter({
      serverName: 'srv',
      eigenfluxBin: 'eigenflux',
      logger: createLogger(),
      resolveMode: () => undefined,
    });

    const ok = await reporter.report();

    expect(ok).toBe(true);
    expect(execMock).toHaveBeenCalledWith(
      'eigenflux',
      ['settings', 'push', '-s', 'srv'],
      expect.any(Object)
    );
  });

  test('default resolveMode uses env (openclaw host -> plugin)', async () => {
    const prev = { ...process.env };
    process.env.EIGENFLUX_HOST = 'openclaw/0.0.14';
    delete process.env.EIGENFLUX_CHANNEL;
    execMock.mockResolvedValue({ kind: 'success', data: '' } as CliResult<any>);

    try {
      const reporter = new EigenFluxSettingsReporter({
        serverName: 'srv',
        eigenfluxBin: 'eigenflux',
        logger: createLogger(),
      });
      await reporter.report();
      expect(execMock).toHaveBeenCalledWith(
        'eigenflux',
        ['settings', 'push', '--mode', 'plugin', '-s', 'srv'],
        expect.any(Object)
      );
    } finally {
      process.env = prev;
    }
  });

  test('does not throw when CLI returns an error (best-effort)', async () => {
    const spies = createLoggerSpies();
    execMock.mockResolvedValue({
      kind: 'error',
      error: new Error('connection refused'),
      exitCode: 1,
      stderr: 'boom',
    } as CliResult<any>);

    const reporter = new EigenFluxSettingsReporter({
      serverName: 'srv',
      eigenfluxBin: 'eigenflux',
      logger: createLogger(spies),
      resolveMode: () => 'plugin',
    });

    const ok = await reporter.report();
    expect(ok).toBe(false);
    expect(spies.warn).toHaveBeenCalledWith(expect.stringContaining('Settings push failed'));
  });

  test('does not throw when CLI returns auth_required', async () => {
    const spies = createLoggerSpies();
    execMock.mockResolvedValue({ kind: 'auth_required', stderr: '' } as CliResult<any>);

    const reporter = new EigenFluxSettingsReporter({
      serverName: 'srv',
      eigenfluxBin: 'eigenflux',
      logger: createLogger(spies),
      resolveMode: () => 'plugin',
    });

    expect(await reporter.report()).toBe(false);
    expect(spies.warn).toHaveBeenCalledWith(expect.stringContaining('auth required'));
  });

  test('does not throw when CLI is not installed', async () => {
    const spies = createLoggerSpies();
    execMock.mockResolvedValue({ kind: 'not_installed', bin: 'eigenflux' } as CliResult<any>);

    const reporter = new EigenFluxSettingsReporter({
      serverName: 'srv',
      eigenfluxBin: 'eigenflux',
      logger: createLogger(spies),
      resolveMode: () => 'plugin',
    });

    expect(await reporter.report()).toBe(false);
    expect(spies.warn).toHaveBeenCalledWith(expect.stringContaining('not installed'));
  });

  test('swallows a thrown exec error', async () => {
    const spies = createLoggerSpies();
    execMock.mockRejectedValue(new Error('spawn failure'));

    const reporter = new EigenFluxSettingsReporter({
      serverName: 'srv',
      eigenfluxBin: 'eigenflux',
      logger: createLogger(spies),
      resolveMode: () => 'plugin',
    });

    await expect(reporter.report()).resolves.toBe(false);
    expect(spies.warn).toHaveBeenCalledWith(expect.stringContaining('Settings push crashed'));
  });

  test('skips concurrent report while one is in flight (no duplicate spawn)', async () => {
    let resolveExec!: (v: CliResult<any>) => void;
    execMock.mockImplementation(
      () =>
        new Promise<CliResult<any>>((res) => {
          resolveExec = res;
        })
    );

    const reporter = new EigenFluxSettingsReporter({
      serverName: 'srv',
      eigenfluxBin: 'eigenflux',
      logger: createLogger(),
      resolveMode: () => 'plugin',
    });

    const first = reporter.report();
    const second = await reporter.report(); // in-flight → skipped
    expect(second).toBe(false);
    expect(execMock).toHaveBeenCalledTimes(1);

    resolveExec({ kind: 'success', data: '' } as CliResult<any>);
    expect(await first).toBe(true);
  });
});
