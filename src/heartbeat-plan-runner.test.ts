import { execEigenflux } from './cli-executor';
import { EigenFluxHeartbeatPlanRunner } from './heartbeat-plan-runner';
import { Logger } from './logger';

jest.mock('./cli-executor');
const execMock = execEigenflux as jest.MockedFunction<typeof execEigenflux>;
const logs = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
const logger = new Logger(logs);
const config = { eigenfluxBin: '/opt/eigenflux', eigenfluxHome: '/stable/home', serverName: 'alpha', logger };
const plan = { schema_version: 'eigenflux_heartbeat_plan.v1', agent_prompt: 'CENTRAL PLAN', wake_on_empty: false };

beforeEach(() => { execMock.mockReset(); jest.clearAllMocks(); });

test('loads the structured plan for the stable Home and explicit server', async () => {
  execMock.mockResolvedValue({ kind: 'success', data: plan });
  await expect(new EigenFluxHeartbeatPlanRunner(config).run()).resolves.toEqual(plan);
  expect(execMock).toHaveBeenCalledWith('/opt/eigenflux', [
    '--homedir', '/stable/home', '--server', 'alpha', 'heartbeat', 'plan', '--format', 'json',
  ], { logger, timeout: 300_000 });
});

test.each([
  'free-form old plan', null, {},
  { ...plan, schema_version: 'unknown' },
  { ...plan, agent_prompt: '' },
  { ...plan, agent_prompt: 42 },
  { ...plan, wake_on_empty: undefined },
  { ...plan, wake_on_empty: 'false' },
])('rejects an invalid central execution contract: %j', async (data) => {
  execMock.mockResolvedValue({ kind: 'success', data });
  await expect(new EigenFluxHeartbeatPlanRunner(config).run()).resolves.toBeNull();
});

test('accepts the central completed-mode delivery choice without inspecting prompt wording', async () => {
  const completed = { ...plan, wake_on_empty: true, agent_prompt: 'baseline mentioned as historical context' };
  execMock.mockResolvedValue({ kind: 'success', data: completed });
  await expect(new EigenFluxHeartbeatPlanRunner(config).run()).resolves.toEqual(completed);
});

test('plan failure returns no replacement business instructions', async () => {
  execMock.mockResolvedValue({ kind: 'error', error: new Error('offline'), exitCode: 2, stderr: 'offline' });
  await expect(new EigenFluxHeartbeatPlanRunner(config).run()).resolves.toBeNull();
});

test('preserves the replacement CLI version without requiring it from legacy plans', async () => {
  const modern = { ...plan, cli_version: '0.6.7' };
  execMock.mockResolvedValue({ kind: 'success', data: modern });
  await expect(new EigenFluxHeartbeatPlanRunner(config).run()).resolves.toEqual(modern);
});

test('routes plan authentication failure to the host notification callback', async () => {
  const onAuthRequired = jest.fn().mockResolvedValue(undefined);
  execMock.mockResolvedValue({ kind: 'auth_required', stderr: 'authentication required' });
  await expect(new EigenFluxHeartbeatPlanRunner({ ...config, onAuthRequired }).run()).resolves.toBeNull();
  expect(onAuthRequired).toHaveBeenCalledTimes(1);
  expect(onAuthRequired).toHaveBeenCalledWith('authentication required');
});

test('operational plan failure does not ask the owner to authenticate', async () => {
  const onAuthRequired = jest.fn();
  const onAuthUnavailable = jest.fn();
  execMock.mockResolvedValue({ kind: 'error', error: new Error('503 unavailable'), exitCode: 2, stderr: '' });
  await expect(new EigenFluxHeartbeatPlanRunner({ ...config, onAuthRequired, onAuthUnavailable }).run()).resolves.toBeNull();
  expect(onAuthRequired).not.toHaveBeenCalled();
  expect(onAuthUnavailable).not.toHaveBeenCalled();
});

test('credential service failure stops through its own callback without requesting login', async () => {
  const onAuthRequired = jest.fn();
  const onAuthUnavailable = jest.fn();
  const error = new Error('503 AGENT_AUTH_UNAVAILABLE');
  execMock.mockResolvedValue({
    kind: 'error', error, exitCode: 2, stderr: error.message, authenticationUnavailable: true,
  });
  await expect(new EigenFluxHeartbeatPlanRunner({ ...config, onAuthRequired, onAuthUnavailable }).run()).resolves.toBeNull();
  expect(onAuthUnavailable).toHaveBeenCalledWith(error);
  expect(onAuthRequired).not.toHaveBeenCalled();
});

test('notification failure releases plan single-flight state for a later retry', async () => {
  const onAuthRequired = jest.fn().mockRejectedValueOnce(new Error('host unavailable')).mockResolvedValue(undefined);
  execMock.mockResolvedValue({ kind: 'auth_required', stderr: 'authentication required' });
  const runner = new EigenFluxHeartbeatPlanRunner({ ...config, onAuthRequired });
  await expect(runner.run()).resolves.toBeNull();
  await expect(runner.run()).resolves.toBeNull();
  expect(onAuthRequired).toHaveBeenCalledTimes(2);
});

test.each(['deferred', 'skipped', 'busy'])('logs unchanged %s decisions only once', async (status) => {
  const cli_update = { status, phase: 'check', reason: 'check_interval', next_check_at: '2026-10-30T12:34:00+08:00' };
  execMock.mockResolvedValue({ kind: 'success', data: { ...plan, cli_update } });
  const runner = new EigenFluxHeartbeatPlanRunner(config);
  await runner.run();
  await runner.run();
  expect(logs.info).toHaveBeenCalledTimes(1);
  expect(logs.info).toHaveBeenCalledWith(expect.stringContaining(JSON.stringify({ server: 'alpha', ...cli_update })));
  expect(logs.warn).not.toHaveBeenCalled();
});

test('logs a changed decision and allows the same deferral after a completed check', async () => {
  const deferred = { status: 'deferred', reason: 'check_interval', next_check_at: '2026-10-30T12:34:00+08:00' };
  execMock.mockResolvedValueOnce({ kind: 'success', data: { ...plan, cli_update: deferred } })
    .mockResolvedValueOnce({ kind: 'success', data: { ...plan, cli_update: { ...deferred, next_check_at: '2026-10-31T12:34:00+08:00' } } })
    .mockResolvedValueOnce({ kind: 'success', data: { ...plan, cli_update: { status: 'current' } } })
    .mockResolvedValueOnce({ kind: 'success', data: { ...plan, cli_update: deferred } });
  const runner = new EigenFluxHeartbeatPlanRunner(config);
  for (let i = 0; i < 4; i++) await runner.run();
  expect(logs.info).toHaveBeenCalledTimes(3);
});

test.each(['failed', 'unconfigured'])('warns on %s even when the plan succeeded', async (status) => {
  const cli_update = { status, phase: 'verify', reason: 'invalid_signature', error: 'untrusted private diagnostic' };
  execMock.mockResolvedValue({ kind: 'success', data: { ...plan, cli_update } });
  await expect(new EigenFluxHeartbeatPlanRunner(config).run()).resolves.toEqual({ ...plan, cli_update });
  expect(logs.warn).toHaveBeenCalledWith(expect.stringContaining(JSON.stringify({ server: 'alpha', status, phase: 'verify', reason: 'invalid_signature' })));
  expect(JSON.stringify(logs.warn.mock.calls)).not.toContain('untrusted private diagnostic');
});

test.each([undefined, null, 'legacy', {}, { status: 12 }])('ignores absent or malformed optional update diagnostics: %j', async (cli_update) => {
  execMock.mockResolvedValue({ kind: 'success', data: { ...plan, cli_update } });
  await expect(new EigenFluxHeartbeatPlanRunner(config).run()).resolves.toEqual({ ...plan, cli_update });
  expect(logs.warn).not.toHaveBeenCalled();
  expect(logs.info).not.toHaveBeenCalled();
});
