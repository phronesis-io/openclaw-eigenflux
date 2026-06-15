import { EigenFluxProfileRefresher, msUntilNextRefresh } from './profile-refresher';
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

// CLI `-f json` outputs unwrapped data directly (no {code,msg,data} envelope)
const PROFILE_RESPONSE = {
  profile: { agent_name: 'TestBot', bio: 'AI research assistant' },
  influence: { total_items: 10, total_consumed: 50, total_scored_1: 5, total_scored_2: 3 },
};

const ITEMS_RESPONSE = {
  items: [
    { broadcast_type: 'info', summary: 'New ML paper', keywords: 'ml,transformers', total_score: 5 },
    { broadcast_type: 'demand', summary: 'Looking for GPU', keywords: 'gpu', total_score: 0 },
  ],
};

describe('msUntilNextRefresh', () => {
  test('targets 1:00-4:59 AM window', () => {
    for (let i = 0; i < 50; i++) {
      const now = new Date(2026, 4, 27, 10, 0, 0); // 10:00 AM
      const delay = msUntilNextRefresh(now);
      const target = new Date(now.getTime() + delay);
      expect(target.getHours()).toBeGreaterThanOrEqual(1);
      expect(target.getHours()).toBeLessThan(5);
      expect(delay).toBeGreaterThan(0);
    }
  });

  test('targets tomorrow when past 5:00 AM', () => {
    const now = new Date(2026, 4, 27, 10, 0, 0);
    const delay = msUntilNextRefresh(now);
    const target = new Date(now.getTime() + delay);
    expect(target.getDate()).toBe(28);
  });

  test('targets today when before 1:00 AM', () => {
    const now = new Date(2026, 4, 27, 0, 15, 0);
    const delay = msUntilNextRefresh(now);
    const target = new Date(now.getTime() + delay);
    expect(target.getDate()).toBe(27);
    expect(target.getHours()).toBeGreaterThanOrEqual(1);
  });
});

describe('EigenFluxProfileRefresher', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    execMock.mockReset();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test('delivers prompt with profile and items data', async () => {
    const onRefreshPrompt = jest.fn().mockResolvedValue(undefined);
    execMock
      .mockResolvedValueOnce({ kind: 'success', data: PROFILE_RESPONSE } as CliResult<any>)
      .mockResolvedValueOnce({ kind: 'success', data: ITEMS_RESPONSE } as CliResult<any>);

    const refresher = new EigenFluxProfileRefresher({
      serverName: 'eigenflux',
      eigenfluxBin: 'eigenflux',
      logger: createLogger(),
      onRefreshPrompt,
      onAuthRequired: jest.fn(),
    });

    refresher.start();
    expect(refresher.isRunning()).toBe(true);

    // Advance timer to trigger refresh
    jest.advanceTimersByTime(24 * 60 * 60 * 1000);
    await Promise.resolve(); // flush microtasks
    await Promise.resolve();

    expect(onRefreshPrompt).toHaveBeenCalledTimes(1);
    const prompt = onRefreshPrompt.mock.calls[0][0];
    expect(prompt).toContain('TestBot');
    expect(prompt).toContain('AI research assistant');
    expect(prompt).toContain('New ML paper');
    expect(prompt).toContain('eigenflux profile update --bio');

    refresher.stop();
  });

  test('prompt instructs use of memory/session, privacy guard, silent mode, and source flags', async () => {
    const onRefreshPrompt = jest.fn().mockResolvedValue(undefined);
    execMock
      .mockResolvedValueOnce({ kind: 'success', data: PROFILE_RESPONSE } as CliResult<any>)
      .mockResolvedValueOnce({ kind: 'success', data: ITEMS_RESPONSE } as CliResult<any>);

    const refresher = new EigenFluxProfileRefresher({
      serverName: 'eigenflux',
      eigenfluxBin: 'eigenflux',
      logger: createLogger(),
      onRefreshPrompt,
      onAuthRequired: jest.fn(),
    });

    refresher.start();
    jest.advanceTimersByTime(24 * 60 * 60 * 1000);
    await Promise.resolve();
    await Promise.resolve();

    const prompt = onRefreshPrompt.mock.calls[0][0] as string;
    // New memory + session sources
    expect(prompt).toContain('Your memory');
    expect(prompt).toContain('Recent sessions');
    // Privacy hard rule
    expect(prompt).toMatch(/Privacy/i);
    expect(prompt).toContain('NEVER');
    // Silent / no user-facing reply
    expect(prompt).toMatch(/SILENT/);
    expect(prompt).toMatch(/do NOT reply/i);
    // Self-report source flags that power layer-2 telemetry
    expect(prompt).toContain('--source');
    expect(prompt).toContain('--note');

    refresher.stop();
  });

  test('emits layer-1 telemetry line on delivery', async () => {
    const onRefreshPrompt = jest.fn().mockResolvedValue(undefined);
    const logSpies = createLoggerSpies();
    execMock
      .mockResolvedValueOnce({ kind: 'success', data: PROFILE_RESPONSE } as CliResult<any>)
      .mockResolvedValueOnce({ kind: 'success', data: ITEMS_RESPONSE } as CliResult<any>);

    const refresher = new EigenFluxProfileRefresher({
      serverName: 'eigenflux',
      eigenfluxBin: 'eigenflux',
      logger: createLogger(logSpies),
      onRefreshPrompt,
      onAuthRequired: jest.fn(),
    });

    refresher.start();
    jest.advanceTimersByTime(24 * 60 * 60 * 1000);
    // Delivered telemetry is emitted *after* the awaited onRefreshPrompt, so
    // flush several microtask turns to let the async refresh() chain settle.
    for (let i = 0; i < 10; i++) await Promise.resolve();

    const marker = 'profile_refresh_telemetry ';
    const telemetryLine = logSpies.info.mock.calls
      .map((c) => String(c[0]))
      .find((m) => m.includes(marker));
    expect(telemetryLine).toBeDefined();
    const payload = JSON.parse(telemetryLine!.slice(telemetryLine!.indexOf(marker) + marker.length));
    expect(payload).toMatchObject({
      server: 'eigenflux',
      outcome: 'delivered',
      broadcast_items: 2,
      delivered: true,
    });
    expect(payload.prompt_bytes).toBeGreaterThan(0);

    refresher.stop();
  });

  test('emits skipped_no_items telemetry when there are no items', async () => {
    const logSpies = createLoggerSpies();
    execMock
      .mockResolvedValueOnce({ kind: 'success', data: PROFILE_RESPONSE } as CliResult<any>)
      .mockResolvedValueOnce({ kind: 'success', data: { items: [] } } as CliResult<any>);

    const refresher = new EigenFluxProfileRefresher({
      serverName: 'eigenflux',
      eigenfluxBin: 'eigenflux',
      logger: createLogger(logSpies),
      onRefreshPrompt: jest.fn().mockResolvedValue(undefined),
      onAuthRequired: jest.fn(),
    });

    refresher.start();
    jest.advanceTimersByTime(24 * 60 * 60 * 1000);
    await Promise.resolve();
    await Promise.resolve();

    const marker = 'profile_refresh_telemetry ';
    const telemetryLine = logSpies.info.mock.calls
      .map((c) => String(c[0]))
      .find((m) => m.includes(marker));
    expect(telemetryLine).toBeDefined();
    const payload = JSON.parse(telemetryLine!.slice(telemetryLine!.indexOf(marker) + marker.length));
    expect(payload.outcome).toBe('skipped_no_items');
    expect(payload.delivered).toBe(false);

    refresher.stop();
  });

  test('skips when no recent items', async () => {
    const onRefreshPrompt = jest.fn().mockResolvedValue(undefined);
    const logSpies = createLoggerSpies();
    execMock
      .mockResolvedValueOnce({ kind: 'success', data: PROFILE_RESPONSE } as CliResult<any>)
      .mockResolvedValueOnce({ kind: 'success', data: { items: [] } } as CliResult<any>);

    const refresher = new EigenFluxProfileRefresher({
      serverName: 'eigenflux',
      eigenfluxBin: 'eigenflux',
      logger: createLogger(logSpies),
      onRefreshPrompt,
      onAuthRequired: jest.fn(),
    });

    refresher.start();
    jest.advanceTimersByTime(24 * 60 * 60 * 1000);
    await Promise.resolve();
    await Promise.resolve();

    expect(onRefreshPrompt).not.toHaveBeenCalled();
    expect(logSpies.info).toHaveBeenCalledWith(
      expect.stringContaining('no recent items')
    );

    refresher.stop();
  });

  test('triggers onAuthRequired when profile fetch returns auth_required', async () => {
    const onAuthRequired = jest.fn().mockResolvedValue(undefined);
    execMock.mockResolvedValueOnce({ kind: 'auth_required', stderr: '' } as CliResult<any>);

    const refresher = new EigenFluxProfileRefresher({
      serverName: 'eigenflux',
      eigenfluxBin: 'eigenflux',
      logger: createLogger(),
      onRefreshPrompt: jest.fn(),
      onAuthRequired,
    });

    refresher.start();
    jest.advanceTimersByTime(24 * 60 * 60 * 1000);
    await Promise.resolve();
    await Promise.resolve();

    expect(onAuthRequired).toHaveBeenCalled();
    refresher.stop();
  });

  test('calls CLI with correct arguments', async () => {
    execMock
      .mockResolvedValueOnce({ kind: 'success', data: PROFILE_RESPONSE } as CliResult<any>)
      .mockResolvedValueOnce({ kind: 'success', data: ITEMS_RESPONSE } as CliResult<any>);

    const refresher = new EigenFluxProfileRefresher({
      serverName: 'my-server',
      eigenfluxBin: '/usr/bin/eigenflux',
      logger: createLogger(),
      onRefreshPrompt: jest.fn().mockResolvedValue(undefined),
      onAuthRequired: jest.fn(),
    });

    refresher.start();
    jest.advanceTimersByTime(24 * 60 * 60 * 1000);
    await Promise.resolve();
    await Promise.resolve();

    expect(execMock).toHaveBeenCalledWith(
      '/usr/bin/eigenflux',
      ['profile', 'show', '-s', 'my-server', '-f', 'json'],
      expect.any(Object),
    );
    expect(execMock).toHaveBeenCalledWith(
      '/usr/bin/eigenflux',
      ['profile', 'items', '-s', 'my-server', '-f', 'json', '--limit', '30'],
      expect.any(Object),
    );

    refresher.stop();
  });

  test('triggerNow runs a refresh immediately when running', async () => {
    const onRefreshPrompt = jest.fn().mockResolvedValue(undefined);
    execMock
      .mockResolvedValueOnce({ kind: 'success', data: PROFILE_RESPONSE } as CliResult<any>)
      .mockResolvedValueOnce({ kind: 'success', data: ITEMS_RESPONSE } as CliResult<any>);

    const refresher = new EigenFluxProfileRefresher({
      serverName: 'eigenflux',
      eigenfluxBin: 'eigenflux',
      logger: createLogger(),
      onRefreshPrompt,
      onAuthRequired: jest.fn(),
    });

    refresher.start();
    await refresher.triggerNow();

    expect(onRefreshPrompt).toHaveBeenCalledTimes(1);
    expect(onRefreshPrompt.mock.calls[0][0]).toContain('TestBot');

    refresher.stop();
  });

  test('triggerNow runs even when the refresher was never started', async () => {
    // The command path may hold an unstarted refresher instance; a manual
    // trigger must still deliver, independent of the daily timer state.
    const onRefreshPrompt = jest.fn().mockResolvedValue(undefined);
    execMock
      .mockResolvedValueOnce({ kind: 'success', data: PROFILE_RESPONSE } as CliResult<any>)
      .mockResolvedValueOnce({ kind: 'success', data: ITEMS_RESPONSE } as CliResult<any>);

    const refresher = new EigenFluxProfileRefresher({
      serverName: 'eigenflux',
      eigenfluxBin: 'eigenflux',
      logger: createLogger(),
      onRefreshPrompt,
      onAuthRequired: jest.fn(),
    });

    // Note: no start() call — running stays false.
    await refresher.triggerNow();

    expect(refresher.isRunning()).toBe(false);
    expect(onRefreshPrompt).toHaveBeenCalledTimes(1);
    expect(onRefreshPrompt.mock.calls[0][0]).toContain('TestBot');
  });

  test('isRunning returns false after stop', () => {
    const refresher = new EigenFluxProfileRefresher({
      serverName: 'eigenflux',
      eigenfluxBin: 'eigenflux',
      logger: createLogger(),
      onRefreshPrompt: jest.fn(),
      onAuthRequired: jest.fn(),
    });

    expect(refresher.isRunning()).toBe(false);
    refresher.start();
    expect(refresher.isRunning()).toBe(true);
    refresher.stop();
    expect(refresher.isRunning()).toBe(false);
  });

  test('stop clears pending timer', () => {
    const refresher = new EigenFluxProfileRefresher({
      serverName: 'eigenflux',
      eigenfluxBin: 'eigenflux',
      logger: createLogger(),
      onRefreshPrompt: jest.fn(),
      onAuthRequired: jest.fn(),
    });

    refresher.start();
    refresher.stop();

    // Advancing should not trigger any CLI calls
    jest.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(execMock).not.toHaveBeenCalled();
  });
});
