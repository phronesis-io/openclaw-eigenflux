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
};

// Memory/session context is the sole driver of the bio now (no broadcasts).
const CTX = {
  memorySnippets: ['Kyrie builds Project Halcyon, a Rust edge-inference runtime'],
  sessionSnippets: ['Working on operator fusion memory peaks in Halcyon'],
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

  test('delivers prompt with profile and injected memory/session context', async () => {
    const onRefreshPrompt = jest.fn().mockResolvedValue(undefined);
    execMock.mockResolvedValueOnce({ kind: 'success', data: PROFILE_RESPONSE } as CliResult<any>);

    const refresher = new EigenFluxProfileRefresher({
      serverName: 'eigenflux',
      eigenfluxBin: 'eigenflux',
      logger: createLogger(),
      onRefreshPrompt,
      onAuthRequired: jest.fn(),
      collectContext: () => CTX,
    });

    refresher.start();
    expect(refresher.isRunning()).toBe(true);

    jest.advanceTimersByTime(24 * 60 * 60 * 1000);
    for (let i = 0; i < 12; i++) await Promise.resolve();

    expect(onRefreshPrompt).toHaveBeenCalledTimes(1);
    const prompt = onRefreshPrompt.mock.calls[0][0];
    expect(prompt).toContain('TestBot');
    expect(prompt).toContain('AI research assistant');
    expect(prompt).toContain('Project Halcyon');
    expect(prompt).toContain('eigenflux profile update --bio');

    refresher.stop();
  });

  test('injects memory/session context, privacy guard, silent mode, and source flags', async () => {
    const onRefreshPrompt = jest.fn().mockResolvedValue(undefined);
    execMock.mockResolvedValueOnce({ kind: 'success', data: PROFILE_RESPONSE } as CliResult<any>);

    const refresher = new EigenFluxProfileRefresher({
      serverName: 'eigenflux',
      eigenfluxBin: 'eigenflux',
      logger: createLogger(),
      onRefreshPrompt,
      onAuthRequired: jest.fn(),
      collectContext: () => CTX,
    });

    refresher.start();
    jest.advanceTimersByTime(24 * 60 * 60 * 1000);
    for (let i = 0; i < 12; i++) await Promise.resolve();

    const prompt = onRefreshPrompt.mock.calls[0][0] as string;
    // Concrete memory + session content is injected verbatim, not just referenced
    expect(prompt).toMatch(/From your memory/i);
    expect(prompt).toContain('Project Halcyon');
    expect(prompt).toMatch(/Recent session context/i);
    expect(prompt).toContain('operator fusion');
    // No broadcasts in the prompt at all
    expect(prompt).not.toMatch(/broadcast/i);
    // Privacy hard rule
    expect(prompt).toMatch(/Privacy/i);
    expect(prompt).toContain('NEVER');
    // Silent, but must actively engage — not a feed item, no reflexive NO_REPLY
    expect(prompt).toMatch(/silent/i);
    expect(prompt).toContain('NO_REPLY');
    expect(prompt).toMatch(/NOT an EigenFlux feed/i);
    expect(prompt).toMatch(/do not narrate to the user/i);
    // Self-report source flags that power layer-2 telemetry
    expect(prompt).toContain('--source');
    expect(prompt).toContain('--note');

    refresher.stop();
  });

  test('emits delivered telemetry with memory/session counts', async () => {
    const onRefreshPrompt = jest.fn().mockResolvedValue(undefined);
    const logSpies = createLoggerSpies();
    execMock.mockResolvedValueOnce({ kind: 'success', data: PROFILE_RESPONSE } as CliResult<any>);

    const refresher = new EigenFluxProfileRefresher({
      serverName: 'eigenflux',
      eigenfluxBin: 'eigenflux',
      logger: createLogger(logSpies),
      onRefreshPrompt,
      onAuthRequired: jest.fn(),
      collectContext: () => CTX,
    });

    refresher.start();
    jest.advanceTimersByTime(24 * 60 * 60 * 1000);
    for (let i = 0; i < 12; i++) await Promise.resolve();

    const marker = 'profile_refresh_telemetry ';
    const telemetryLine = logSpies.info.mock.calls
      .map((c) => String(c[0]))
      .find((m) => m.includes(marker));
    expect(telemetryLine).toBeDefined();
    const payload = JSON.parse(telemetryLine!.slice(telemetryLine!.indexOf(marker) + marker.length));
    expect(payload).toMatchObject({
      server: 'eigenflux',
      outcome: 'delivered',
      memory_snippets: 1,
      session_snippets: 1,
      delivered: true,
    });
    expect(payload.prompt_bytes).toBeGreaterThan(0);

    refresher.stop();
  });

  test('skips with skipped_no_context when there is no memory/session', async () => {
    const onRefreshPrompt = jest.fn().mockResolvedValue(undefined);
    const logSpies = createLoggerSpies();
    execMock.mockResolvedValueOnce({ kind: 'success', data: PROFILE_RESPONSE } as CliResult<any>);

    const refresher = new EigenFluxProfileRefresher({
      serverName: 'eigenflux',
      eigenfluxBin: 'eigenflux',
      logger: createLogger(logSpies),
      onRefreshPrompt,
      onAuthRequired: jest.fn(),
      collectContext: () => ({ memorySnippets: [], sessionSnippets: [] }),
    });

    refresher.start();
    jest.advanceTimersByTime(24 * 60 * 60 * 1000);
    for (let i = 0; i < 12; i++) await Promise.resolve();

    expect(onRefreshPrompt).not.toHaveBeenCalled();
    const line = logSpies.info.mock.calls.map((c) => String(c[0])).find((m) => m.includes('profile_refresh_telemetry'));
    expect(line).toBeDefined();
    expect(JSON.parse(line!.slice(line!.indexOf('{')))).toMatchObject({ outcome: 'skipped_no_context' });

    refresher.stop();
  });

  test('skips when collectContext is not configured', async () => {
    const onRefreshPrompt = jest.fn().mockResolvedValue(undefined);
    const logSpies = createLoggerSpies();
    execMock.mockResolvedValueOnce({ kind: 'success', data: PROFILE_RESPONSE } as CliResult<any>);

    const refresher = new EigenFluxProfileRefresher({
      serverName: 'eigenflux',
      eigenfluxBin: 'eigenflux',
      logger: createLogger(logSpies),
      onRefreshPrompt,
      onAuthRequired: jest.fn(),
    });

    refresher.start();
    jest.advanceTimersByTime(24 * 60 * 60 * 1000);
    for (let i = 0; i < 12; i++) await Promise.resolve();

    expect(onRefreshPrompt).not.toHaveBeenCalled();
    expect(logSpies.info).toHaveBeenCalledWith(
      expect.stringContaining('no memory/session context')
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
    for (let i = 0; i < 12; i++) await Promise.resolve();

    expect(onAuthRequired).toHaveBeenCalled();
    refresher.stop();
  });

  test('calls profile show with correct arguments and no items fetch', async () => {
    execMock.mockResolvedValueOnce({ kind: 'success', data: PROFILE_RESPONSE } as CliResult<any>);

    const refresher = new EigenFluxProfileRefresher({
      serverName: 'my-server',
      eigenfluxBin: '/usr/bin/eigenflux',
      logger: createLogger(),
      onRefreshPrompt: jest.fn().mockResolvedValue(undefined),
      onAuthRequired: jest.fn(),
      collectContext: () => CTX,
    });

    refresher.start();
    jest.advanceTimersByTime(24 * 60 * 60 * 1000);
    for (let i = 0; i < 12; i++) await Promise.resolve();

    expect(execMock).toHaveBeenCalledWith(
      '/usr/bin/eigenflux',
      ['profile', 'show', '-s', 'my-server', '-f', 'json'],
      expect.any(Object),
    );
    // No broadcast items fetch anymore.
    expect(execMock).not.toHaveBeenCalledWith(
      '/usr/bin/eigenflux',
      expect.arrayContaining(['items']),
      expect.any(Object),
    );

    refresher.stop();
  });

  test('triggerNow runs a refresh immediately when running', async () => {
    const onRefreshPrompt = jest.fn().mockResolvedValue(undefined);
    execMock.mockResolvedValueOnce({ kind: 'success', data: PROFILE_RESPONSE } as CliResult<any>);

    const refresher = new EigenFluxProfileRefresher({
      serverName: 'eigenflux',
      eigenfluxBin: 'eigenflux',
      logger: createLogger(),
      onRefreshPrompt,
      onAuthRequired: jest.fn(),
      collectContext: () => CTX,
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
    execMock.mockResolvedValueOnce({ kind: 'success', data: PROFILE_RESPONSE } as CliResult<any>);

    const refresher = new EigenFluxProfileRefresher({
      serverName: 'eigenflux',
      eigenfluxBin: 'eigenflux',
      logger: createLogger(),
      onRefreshPrompt,
      onAuthRequired: jest.fn(),
      collectContext: () => CTX,
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
