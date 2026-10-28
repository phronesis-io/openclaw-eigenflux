import { callGatewayFromCli } from 'openclaw/plugin-sdk/gateway-runtime';
import { sendAuthReminder } from './auth-reminder-transport';

jest.mock('openclaw/plugin-sdk/gateway-runtime', () => ({ callGatewayFromCli: jest.fn() }));

const callGateway = callGatewayFromCli as jest.MockedFunction<typeof callGatewayFromCli>;
const params = {
  sessionKey: 'agent:main:main',
  message: 'Authentication reminder with the current owner action',
  deliver: true as const,
  lane: 'eigenflux-bg',
  idempotencyKey: 'auth-reminder-existing-key',
};

beforeEach(() => callGateway.mockReset());

test('waits for the final response using the existing run identity and host connection configuration', async () => {
  const final = { runId: params.idempotencyKey, status: 'ok', result: { deliverySucceeded: true } };
  callGateway.mockResolvedValue(final);

  await expect(sendAuthReminder(params, 480_000)).resolves.toBe(final);
  expect(callGateway).toHaveBeenCalledTimes(1);
  expect(callGateway).toHaveBeenCalledWith('agent', { timeout: '480000', json: true }, params, {
    expectFinal: true, progress: false,
  });
});

test.each([
  { runId: params.idempotencyKey, status: 'ok', result: { deliverySucceeded: false } },
  { runId: params.idempotencyKey, status: 'ok', result: {} },
  { runId: params.idempotencyKey, status: 'ok' },
  { runId: params.idempotencyKey, status: 'accepted' },
])('preserves an unconfirmed response without manufacturing delivery success: %j', async (response) => {
  callGateway.mockResolvedValue(response);

  await expect(sendAuthReminder(params, 123_456)).resolves.toBe(response);
  expect(callGateway).toHaveBeenCalledTimes(1);
});

test('propagates a rejected request without submitting a fallback or another run', async () => {
  const error = new Error('Final response unavailable');
  callGateway.mockRejectedValue(error);

  await expect(sendAuthReminder(params, 480_000)).rejects.toBe(error);
  expect(callGateway).toHaveBeenCalledTimes(1);
  expect(callGateway.mock.calls[0][2]).toBe(params);
});
