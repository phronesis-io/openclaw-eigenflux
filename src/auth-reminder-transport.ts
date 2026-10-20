/** Wait for the host's final Agent response without loading its ESM SDK at startup. */
export async function sendAuthReminder(
  params: {
    sessionKey: string;
    message: string;
    deliver: true;
    lane: string;
    idempotencyKey: string;
  },
  timeoutMs: number
): Promise<Record<string, unknown>> {
  const { callGatewayFromCli } = await import('openclaw/plugin-sdk/gateway-runtime');
  return callGatewayFromCli('agent', { timeout: String(timeoutMs), json: true }, params, {
    expectFinal: true,
    progress: false,
  });
}
