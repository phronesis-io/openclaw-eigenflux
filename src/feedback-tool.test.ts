import { Logger } from './logger';
import type { CliResult } from './cli-executor';

jest.mock('./cli-executor');
import { execEigenflux } from './cli-executor';
import { handleFollowup, FOLLOWUP_KINDS, FollowupDeps, FollowupResult } from './feedback-tool';

const execMock = execEigenflux as jest.MockedFunction<typeof execEigenflux>;

function createLogger(): Logger {
  return new Logger({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() });
}

function makeDeps(): FollowupDeps {
  return { eigenfluxBin: 'eigenflux', serverName: 'srv-a', logger: createLogger() };
}

function okResult(data: FollowupResult): CliResult<FollowupResult> {
  return { kind: 'success', data } as CliResult<FollowupResult>;
}

/** Extract argv from the single execEigenflux call. */
function calledArgs(): string[] {
  expect(execMock).toHaveBeenCalledTimes(1);
  return execMock.mock.calls[0][1];
}

describe('FOLLOWUP_KINDS', () => {
  test('exposes the four backend kinds', () => {
    expect([...FOLLOWUP_KINDS]).toEqual(['surface', 'question', 'discussion', 'task']);
  });
});

describe('handleFollowup thin shell', () => {
  beforeEach(() => {
    execMock.mockReset();
  });

  test('returns invalid_params without shelling out when no item_id/item_ids', async () => {
    const r = await handleFollowup(makeDeps(), { kind: 'surface' });
    expect(r).toEqual({ ok: false, error: 'invalid_params' });
    expect(execMock).not.toHaveBeenCalled();
  });

  test('scalar item_id builds `feed event record` with comma-joined --item-ids', async () => {
    execMock.mockResolvedValue(okResult({ ok: true, accepted: 1, results: [{ item_id: 'a1', ok: true, dedup_key: 'k' }] }));
    const r = await handleFollowup(makeDeps(), { item_id: ' a1 ', kind: 'task', brief: 'wrote up' });

    const args = calledArgs();
    expect(execMock.mock.calls[0][0]).toBe('eigenflux');
    expect(args.slice(0, 3)).toEqual(['feed', 'event', 'record']);
    expect(args).toEqual([
      'feed', 'event', 'record',
      '--item-ids', 'a1',
      '--kind', 'task',
      '-s', 'srv-a',
      '--brief', 'wrote up',
    ]);
    // CLI JSON passes straight through to the agent.
    expect(r).toEqual({ ok: true, accepted: 1, results: [{ item_id: 'a1', ok: true, dedup_key: 'k' }] });
  });

  test('item_ids array is comma-joined (dedup + trim only, no verification)', async () => {
    execMock.mockResolvedValue(okResult({ ok: true, accepted: 2, results: [] }));
    await handleFollowup(makeDeps(), { item_ids: ['a', 'a', ' b ', ''], kind: 'surface' });

    const args = calledArgs();
    const idx = args.indexOf('--item-ids');
    expect(args[idx + 1]).toBe('a,b');
    expect(args).toContain('--kind');
    expect(args[args.indexOf('--kind') + 1]).toBe('surface');
    // No brief supplied → no --brief flag.
    expect(args).not.toContain('--brief');
  });

  test('item_ids wins when both scalar and array are supplied', async () => {
    execMock.mockResolvedValue(okResult({ ok: true, accepted: 1, results: [] }));
    await handleFollowup(makeDeps(), { item_id: 'scalar', item_ids: ['a'], kind: 'surface' });
    const args = calledArgs();
    expect(args[args.indexOf('--item-ids') + 1]).toBe('a');
  });

  test('always targets the runtime server via -s', async () => {
    execMock.mockResolvedValue(okResult({ ok: true, accepted: 1, results: [] }));
    await handleFollowup({ ...makeDeps(), serverName: 'other' }, { item_id: 'a', kind: 'surface' });
    const args = calledArgs();
    expect(args[args.indexOf('-s') + 1]).toBe('other');
  });

  test('brief is truncated to 200 chars before passing to the CLI', async () => {
    execMock.mockResolvedValue(okResult({ ok: true, accepted: 1, results: [] }));
    await handleFollowup(makeDeps(), { item_id: 'a', kind: 'surface', brief: 'x'.repeat(500) });
    const args = calledArgs();
    expect(args[args.indexOf('--brief') + 1].length).toBe(200);
  });

  test('passes an unknown kind straight to the CLI (CLI owns validation)', async () => {
    execMock.mockResolvedValue(okResult({ ok: false, error: 'invalid_params' }));
    const r = await handleFollowup(makeDeps(), { item_id: 'a', kind: 'bogus' });
    const args = calledArgs();
    expect(args[args.indexOf('--kind') + 1]).toBe('bogus');
    // CLI's rejection is surfaced verbatim.
    expect(r).toEqual({ ok: false, error: 'invalid_params' });
  });

  test('surfaces cli_error when the CLI process fails', async () => {
    execMock.mockResolvedValue({ kind: 'error', error: new Error('boom'), exitCode: 1, stderr: 'boom' } as CliResult<FollowupResult>);
    const r = await handleFollowup(makeDeps(), { item_id: 'a', kind: 'surface' });
    expect(r).toEqual({ ok: false, error: 'cli_error' });
  });
});
