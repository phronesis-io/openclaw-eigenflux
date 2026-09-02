import { execEigenflux } from './cli-executor';
import { EigenFluxHeartbeatPlanRunner } from './heartbeat-plan-runner';
import { Logger } from './logger';

jest.mock('./cli-executor');

const execMock = execEigenflux as jest.MockedFunction<typeof execEigenflux>;
const loggerSpies = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};
const logger = new Logger(loggerSpies);

describe('EigenFluxHeartbeatPlanRunner', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('runs the thin plan with the stable home', async () => {
    execMock.mockResolvedValue({ kind: 'success', data: 'plan' });
    const runner = new EigenFluxHeartbeatPlanRunner({
      eigenfluxBin: '/opt/eigenflux',
      eigenfluxHome: '/stable/openclaw/.eigenflux',
      logger,
    });

    await expect(runner.run()).resolves.toBe('plan');
    expect(execMock).toHaveBeenCalledWith(
      '/opt/eigenflux',
      [
        '--homedir',
        '/stable/openclaw/.eigenflux',
        'heartbeat',
        'plan',
        '--format',
        'agent',
      ],
      { logger, parseJson: false }
    );
  });

  test('keeps the existing heartbeat alive when the plan fails', async () => {
    execMock.mockResolvedValue({
      kind: 'error',
      error: new Error('offline'),
      exitCode: 1,
      stderr: 'offline',
    });
    const runner = new EigenFluxHeartbeatPlanRunner({
      eigenfluxBin: 'eigenflux',
      eigenfluxHome: '/stable/home',
      logger,
    });

    await expect(runner.run()).resolves.toBeNull();
    expect(loggerSpies.warn).toHaveBeenCalledWith(
      expect.stringContaining('Heartbeat plan failed: offline')
    );
  });
});
