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

// Host-specific inputs the OpenClaw adapter hands to the CLI core.
const CTX = {
  memoryDirs: ['/state/workspace/memory'],
  sessionSnippets: ['Working on operator fusion memory peaks in Halcyon'],
};

// The prompt the CLI core (`profile refresh-prompt`) prints to stdout.
const CLI_PROMPT = 'ASSEMBLED PROMPT for TestBot\n## From your memory\n...';

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

function makeRefresher(overrides: Record<string, unknown> = {}) {
  return new EigenFluxProfileRefresher({
    serverName: 'eigenflux',
    eigenfluxBin: 'eigenflux',
    logger: createLogger(),
    onRefreshPrompt: jest.fn().mockResolvedValue(undefined),
    onAuthRequired: jest.fn().mockResolvedValue(undefined),
    collectContext: () => CTX,
    ...overrides,
  } as any);
}

const telemetry = (spies: ReturnType<typeof createLoggerSpies>) => {
  const marker = 'profile_refresh_telemetry ';
  const line = spies.info.mock.calls.map((c) => String(c[0])).find((m) => m.includes(marker));
  return line ? JSON.parse(line.slice(line.indexOf(marker) + marker.length)) : undefined;
};

const statusTelemetry = (spies: ReturnType<typeof createLoggerSpies>) => {
  const marker = 'status_broadcast_telemetry ';
  const line = spies.info.mock.calls.map((c) => String(c[0])).find((m) => m.includes(marker));
  return line ? JSON.parse(line.slice(line.indexOf(marker) + marker.length)) : undefined;
};

describe('EigenFluxProfileRefresher', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    execMock.mockReset();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test('calls `profile refresh-prompt` with memory-dir + session-snippet and delivers stdout', async () => {
    const onRefreshPrompt = jest.fn().mockResolvedValue(undefined);
    execMock.mockResolvedValueOnce({ kind: 'success', data: CLI_PROMPT } as CliResult<any>);

    const refresher = makeRefresher({ eigenfluxBin: '/usr/bin/eigenflux', onRefreshPrompt });
    refresher.start();
    jest.advanceTimersByTime(24 * 60 * 60 * 1000);
    for (let i = 0; i < 12; i++) await Promise.resolve();

    expect(execMock).toHaveBeenCalledWith(
      '/usr/bin/eigenflux',
      [
        'profile', 'refresh-prompt', '-s', 'eigenflux',
        '--memory-dir', '/state/workspace/memory',
        '--session-snippet', 'Working on operator fusion memory peaks in Halcyon',
      ],
      expect.objectContaining({ parseJson: false }),
    );
    expect(onRefreshPrompt).toHaveBeenCalledTimes(1);
    expect(onRefreshPrompt.mock.calls[0][0]).toBe(CLI_PROMPT);

    refresher.stop();
  });

  test('fires onTick (daily side task, e.g. skills sync) once per daily cadence', async () => {
    const onTick = jest.fn().mockResolvedValue(undefined);
    execMock.mockResolvedValueOnce({ kind: 'success', data: CLI_PROMPT } as CliResult<any>);

    const refresher = makeRefresher({ onTick });
    refresher.start();
    jest.advanceTimersByTime(24 * 60 * 60 * 1000);
    for (let i = 0; i < 12; i++) await Promise.resolve();

    expect(onTick).toHaveBeenCalledTimes(1);
    refresher.stop();
  });

  test('a throwing onTick never breaks the refresh loop (best-effort, keeps rescheduling)', async () => {
    const onTick = jest.fn().mockRejectedValue(new Error('boom'));
    execMock.mockResolvedValue({ kind: 'success', data: CLI_PROMPT } as CliResult<any>);

    const refresher = makeRefresher({ onTick });
    refresher.start();
    jest.advanceTimersByTime(24 * 60 * 60 * 1000);
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(onTick).toHaveBeenCalledTimes(1);

    // The loop must have rescheduled despite onTick throwing.
    jest.advanceTimersByTime(24 * 60 * 60 * 1000);
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(onTick).toHaveBeenCalledTimes(2);

    refresher.stop();
  });

  test('emits delivered telemetry with memory_dirs/session counts', async () => {
    const spies = createLoggerSpies();
    execMock.mockResolvedValueOnce({ kind: 'success', data: CLI_PROMPT } as CliResult<any>);

    const refresher = makeRefresher({ logger: createLogger(spies) });
    refresher.start();
    jest.advanceTimersByTime(24 * 60 * 60 * 1000);
    for (let i = 0; i < 12; i++) await Promise.resolve();

    expect(telemetry(spies)).toMatchObject({
      server: 'eigenflux',
      outcome: 'delivered',
      memory_dirs: 1,
      session_snippets: 1,
      delivered: true,
    });

    refresher.stop();
  });

  test('skips with skipped_no_context and does NOT call the CLI when there is no context', async () => {
    const onRefreshPrompt = jest.fn().mockResolvedValue(undefined);
    const spies = createLoggerSpies();

    const refresher = makeRefresher({
      logger: createLogger(spies),
      onRefreshPrompt,
      collectContext: () => ({ memoryDirs: [], sessionSnippets: [] }),
    });
    refresher.start();
    jest.advanceTimersByTime(24 * 60 * 60 * 1000);
    for (let i = 0; i < 12; i++) await Promise.resolve();

    expect(execMock).not.toHaveBeenCalled();
    expect(onRefreshPrompt).not.toHaveBeenCalled();
    expect(telemetry(spies)).toMatchObject({ outcome: 'skipped_no_context' });

    refresher.stop();
  });

  test('skips when the CLI prints an empty prompt', async () => {
    const onRefreshPrompt = jest.fn().mockResolvedValue(undefined);
    const spies = createLoggerSpies();
    execMock.mockResolvedValueOnce({ kind: 'success', data: '   ' } as CliResult<any>);

    const refresher = makeRefresher({ logger: createLogger(spies), onRefreshPrompt });
    refresher.start();
    jest.advanceTimersByTime(24 * 60 * 60 * 1000);
    for (let i = 0; i < 12; i++) await Promise.resolve();

    expect(onRefreshPrompt).not.toHaveBeenCalled();
    expect(telemetry(spies)).toMatchObject({ outcome: 'skipped_no_context' });

    refresher.stop();
  });

  test('triggers onAuthRequired when the CLI reports auth_required', async () => {
    const onAuthRequired = jest.fn().mockResolvedValue(undefined);
    execMock.mockResolvedValueOnce({ kind: 'auth_required', stderr: '' } as CliResult<any>);

    const refresher = makeRefresher({ onAuthRequired });
    refresher.start();
    jest.advanceTimersByTime(24 * 60 * 60 * 1000);
    for (let i = 0; i < 12; i++) await Promise.resolve();

    expect(onAuthRequired).toHaveBeenCalled();
    refresher.stop();
  });

  test('triggerNow delivers immediately, even when never started', async () => {
    const onRefreshPrompt = jest.fn().mockResolvedValue(undefined);
    execMock.mockResolvedValueOnce({ kind: 'success', data: CLI_PROMPT } as CliResult<any>);

    const refresher = makeRefresher({ onRefreshPrompt });
    // No start() — running stays false.
    await refresher.triggerNow();

    expect(refresher.isRunning()).toBe(false);
    expect(onRefreshPrompt).toHaveBeenCalledTimes(1);
    expect(onRefreshPrompt.mock.calls[0][0]).toBe(CLI_PROMPT);
  });

  test('isRunning returns false after stop', () => {
    const refresher = makeRefresher();
    expect(refresher.isRunning()).toBe(false);
    refresher.start();
    expect(refresher.isRunning()).toBe(true);
    refresher.stop();
    expect(refresher.isRunning()).toBe(false);
  });

  test('stop clears pending timer', () => {
    const refresher = makeRefresher();
    refresher.start();
    refresher.stop();
    jest.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(execMock).not.toHaveBeenCalled();
  });
});

// The status-broadcast prompt the CLI core (`profile status-prompt`) prints.
const STATUS_PROMPT = 'STATUS BROADCAST PROMPT\n## What to broadcast\n...';

describe('EigenFluxProfileRefresher daily status broadcast', () => {
  beforeEach(() => {
    execMock.mockReset();
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  // triggerNow avoids fake timers: a deterministic bio-refresh → status chain.
  function primeBioThenStatus() {
    execMock
      .mockResolvedValueOnce({ kind: 'success', data: CLI_PROMPT } as CliResult<any>) // refresh-prompt
      .mockResolvedValueOnce({ kind: 'success', data: STATUS_PROMPT } as CliResult<any>); // status-prompt
  }

  test('auto branch: recurring_publish on → status-prompt --auto-publish true, delivered silently', async () => {
    primeBioThenStatus();
    const onStatusPrompt = jest.fn().mockResolvedValue(undefined);
    const refresher = makeRefresher({
      readRecurringPublish: jest.fn().mockResolvedValue(true),
      onStatusPrompt,
    });

    await refresher.triggerNow();

    expect(execMock).toHaveBeenNthCalledWith(
      2,
      'eigenflux',
      [
        'profile', 'status-prompt', '-s', 'eigenflux', '--auto-publish=true',
        '--memory-dir', '/state/workspace/memory',
        '--session-snippet', 'Working on operator fusion memory peaks in Halcyon',
      ],
      expect.objectContaining({ parseJson: false }),
    );
    expect(onStatusPrompt).toHaveBeenCalledWith(STATUS_PROMPT, { silent: true });
  });

  test('confirm branch: recurring_publish off → --auto-publish false, delivered non-silent', async () => {
    primeBioThenStatus();
    const onStatusPrompt = jest.fn().mockResolvedValue(undefined);
    const refresher = makeRefresher({
      readRecurringPublish: jest.fn().mockResolvedValue(false),
      onStatusPrompt,
    });

    await refresher.triggerNow();

    // Single-arg equals form — never `'--auto-publish', 'false'` (space form
    // would be coerced to true by cobra, flipping OFF into auto-publish).
    expect(execMock.mock.calls[1][1]).toContain('--auto-publish=false');
    expect(execMock.mock.calls[1][1]).not.toContain('--auto-publish');
    expect(onStatusPrompt).toHaveBeenCalledWith(STATUS_PROMPT, { silent: false });
  });

  test('empty status-prompt stdout → skip, no delivery', async () => {
    execMock
      .mockResolvedValueOnce({ kind: 'success', data: CLI_PROMPT } as CliResult<any>)
      .mockResolvedValueOnce({ kind: 'success', data: '   ' } as CliResult<any>);
    const onStatusPrompt = jest.fn().mockResolvedValue(undefined);
    const refresher = makeRefresher({
      readRecurringPublish: jest.fn().mockResolvedValue(true),
      onStatusPrompt,
    });

    await refresher.triggerNow();
    expect(onStatusPrompt).not.toHaveBeenCalled();
  });

  test('status step is skipped when callbacks are unwired (no second exec)', async () => {
    execMock.mockResolvedValueOnce({ kind: 'success', data: CLI_PROMPT } as CliResult<any>);
    const refresher = makeRefresher(); // no readRecurringPublish/onStatusPrompt

    await refresher.triggerNow();
    expect(execMock).toHaveBeenCalledTimes(1);
  });

  test('a failing status step never throws and never blocks the bio result', async () => {
    execMock
      .mockResolvedValueOnce({ kind: 'success', data: CLI_PROMPT } as CliResult<any>)
      .mockResolvedValueOnce({ kind: 'error', error: new Error('boom'), exitCode: 1, stderr: '' } as CliResult<any>);
    const onRefreshPrompt = jest.fn().mockResolvedValue(undefined);
    const onStatusPrompt = jest.fn().mockResolvedValue(undefined);
    const refresher = makeRefresher({
      onRefreshPrompt,
      readRecurringPublish: jest.fn().mockResolvedValue(true),
      onStatusPrompt,
    });

    await expect(refresher.triggerNow()).resolves.toBeUndefined();
    expect(onRefreshPrompt).toHaveBeenCalledTimes(1); // bio still delivered
    expect(onStatusPrompt).not.toHaveBeenCalled();
  });

  test('status broadcast is not attempted when the bio delivery fails', async () => {
    execMock.mockResolvedValueOnce({ kind: 'success', data: CLI_PROMPT } as CliResult<any>);
    const onStatusPrompt = jest.fn().mockResolvedValue(undefined);
    const readRecurringPublish = jest.fn().mockResolvedValue(true);
    const refresher = makeRefresher({
      onRefreshPrompt: jest.fn().mockRejectedValue(new Error('deliver failed')),
      readRecurringPublish,
      onStatusPrompt,
    });

    await refresher.triggerNow();
    expect(readRecurringPublish).not.toHaveBeenCalled();
    expect(onStatusPrompt).not.toHaveBeenCalled();
    expect(execMock).toHaveBeenCalledTimes(1); // no status-prompt call
  });

  test('status-prompt auth_required → onAuthRequired + telemetry, no delivery', async () => {
    const spies = createLoggerSpies();
    execMock
      .mockResolvedValueOnce({ kind: 'success', data: CLI_PROMPT } as CliResult<any>)
      .mockResolvedValueOnce({ kind: 'auth_required', stderr: '' } as CliResult<any>);
    const onStatusPrompt = jest.fn().mockResolvedValue(undefined);
    const onAuthRequired = jest.fn().mockResolvedValue(undefined);
    const refresher = makeRefresher({
      logger: createLogger(spies),
      readRecurringPublish: jest.fn().mockResolvedValue(true),
      onStatusPrompt,
      onAuthRequired,
    });

    await refresher.triggerNow();
    expect(onAuthRequired).toHaveBeenCalledTimes(1);
    expect(onStatusPrompt).not.toHaveBeenCalled();
    expect(statusTelemetry(spies)?.outcome).toBe('auth_required');
  });

  test('fail-closed: readRecurringPublish throwing defaults to draft-and-confirm (auto=false)', async () => {
    primeBioThenStatus();
    const onStatusPrompt = jest.fn().mockResolvedValue(undefined);
    const refresher = makeRefresher({
      readRecurringPublish: jest.fn().mockRejectedValue(new Error('config unreadable')),
      onStatusPrompt,
    });

    await refresher.triggerNow();
    // Unreadable setting must NOT auto-publish: falls back to non-silent confirm.
    expect(execMock.mock.calls[1][1]).toContain('--auto-publish=false');
    expect(onStatusPrompt).toHaveBeenCalledWith(STATUS_PROMPT, { silent: false });
  });

  test('onStatusPrompt failure is observable: emits delivery_failed telemetry, never throws', async () => {
    const spies = createLoggerSpies();
    primeBioThenStatus();
    const refresher = makeRefresher({
      logger: createLogger(spies),
      readRecurringPublish: jest.fn().mockResolvedValue(true),
      onStatusPrompt: jest.fn().mockRejectedValue(new Error('channel down')),
    });

    await expect(refresher.triggerNow()).resolves.toBeUndefined();
    const t = statusTelemetry(spies);
    expect(t?.outcome).toBe('delivery_failed');
    expect(t?.delivered).toBe(false);
  });
});

