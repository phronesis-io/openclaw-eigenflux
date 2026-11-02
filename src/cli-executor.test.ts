import { execEigenflux } from './cli-executor';
import { Logger } from './logger';

const unavailableNotice = {
  schema_version: 'eigenflux_auth_unavailable.v1', status: 'auth_unavailable',
  code: 'AGENT_AUTH_UNAVAILABLE', home: '/stable/home', server: 'alpha',
  checks_blocked: true, login_required: false, retryable: true,
};

function failingCli(stderr: string, exitCode = 2) {
  return execEigenflux(process.execPath, [
    '-e', 'process.stderr.write(process.argv[1]); process.exit(Number(process.argv[2]))',
    stderr, String(exitCode),
  ]);
}

describe('execEigenflux', () => {
  test('preserves only maintenance diagnostics from a successful command', async () => {
    const logs = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const stderr = 'private unrelated stderr\r\n[eigenflux:maintenance] record_failed attempt=abc\r\n'
      + 'prefix [eigenflux:maintenance] not a diagnostic\n[eigenflux:maintenance] upload_pending attempt=abc\n';
    await expect(execEigenflux(process.execPath, [
      '-e', 'process.stderr.write(process.argv[1]); console.log(JSON.stringify({ok:true}))', stderr,
    ], { logger: new Logger(logs) })).resolves.toEqual({ kind: 'success', data: { ok: true } });
    expect(logs.warn.mock.calls).toEqual([
      ['[EigenFlux] [eigenflux:maintenance] record_failed attempt=abc'],
      ['[EigenFlux] [eigenflux:maintenance] upload_pending attempt=abc'],
    ]);
  });

  test.each(['AGENT_AUTH_UNAVAILABLE', 'AUTH_NETWORK_UNAVAILABLE'])(
    'classifies the final structured %s notice after multiline diagnostics', async (code) => {
      const stderr = `refresh request failed\r\nadditional diagnostic\r\n${JSON.stringify({ ...unavailableNotice, code })}\r\n\n`;
      await expect(failingCli(stderr)).resolves.toMatchObject({
        kind: 'error', exitCode: 2, stderr: stderr.trim(), authenticationUnavailable: true,
      });
    }
  );

  test.each([
    'HTTP 503 AGENT_AUTH_UNAVAILABLE',
    'settings PUT failed: HTTP 503',
    '{invalid JSON}',
    'null', '[]',
    JSON.stringify({ ...unavailableNotice, schema_version: 'unknown' }),
    JSON.stringify({ ...unavailableNotice, status: 'auth_required' }),
    JSON.stringify({ ...unavailableNotice, checks_blocked: 'true' }),
    JSON.stringify({ ...unavailableNotice, checks_blocked: false }),
    JSON.stringify({ ...unavailableNotice, login_required: true }),
    JSON.stringify({ ...unavailableNotice, login_required: 'false' }),
    JSON.stringify({ ...unavailableNotice, retryable: false }),
    JSON.stringify({ ...unavailableNotice, retryable: 'true' }),
    JSON.stringify({ ...unavailableNotice, code: '' }),
    JSON.stringify({ ...unavailableNotice, home: null }),
    JSON.stringify({ ...unavailableNotice, server: '' }),
    `${JSON.stringify(unavailableNotice)}\ntrailing diagnostic`,
  ])('leaves unstructured or invalid diagnostics as ordinary errors: %s', async (stderr) => {
    const result = await failingCli(stderr);
    expect(result.kind).toBe('error');
    expect(result).not.toHaveProperty('authenticationUnavailable');
  });

  test('the unavailable notice does not change non-usage exit or login-required handling', async () => {
    const stderr = JSON.stringify(unavailableNotice);
    expect(await failingCli(stderr, 1)).not.toHaveProperty('authenticationUnavailable');
    await expect(failingCli(stderr, 4)).resolves.toEqual({ kind: 'auth_required', stderr });
  });

  test('per-child model overrides preserve parent metadata without mutating the Gateway', async () => {
    const savedModel = process.env.EIGENFLUX_MODEL;
    const savedChannel = process.env.EIGENFLUX_CHANNEL;
    process.env.EIGENFLUX_MODEL = 'unrelated-model';
    process.env.EIGENFLUX_CHANNEL = 'openclaw';
    try {
      const script = 'console.log(JSON.stringify({model:process.env.EIGENFLUX_MODEL,channel:process.env.EIGENFLUX_CHANNEL}))';
      expect(await execEigenflux(process.execPath, ['-e', script]))
        .toEqual({ kind: 'success', data: { channel: 'openclaw' } });
      expect(await execEigenflux(process.execPath, ['-e', script], { env: { EIGENFLUX_CHANNEL: 'scoped-channel' } }))
        .toEqual({ kind: 'success', data: { channel: 'scoped-channel' } });
      expect(await execEigenflux(process.execPath, ['-e', script], { env: { EIGENFLUX_MODEL: 'owned-model' } }))
        .toEqual({ kind: 'success', data: { model: 'owned-model', channel: 'openclaw' } });
      expect(await execEigenflux(process.execPath, ['-e', script], { env: { EIGENFLUX_MODEL: undefined } }))
        .toEqual({ kind: 'success', data: { channel: 'openclaw' } });
      expect(process.env.EIGENFLUX_MODEL).toBe('unrelated-model');
    } finally {
      if (savedModel === undefined) delete process.env.EIGENFLUX_MODEL; else process.env.EIGENFLUX_MODEL = savedModel;
      if (savedChannel === undefined) delete process.env.EIGENFLUX_CHANNEL; else process.env.EIGENFLUX_CHANNEL = savedChannel;
    }
  });
  test('returns not_installed when the binary cannot be spawned (ENOENT)', async () => {
    const result = await execEigenflux(
      '/tmp/definitely-not-a-real-binary-eigenflux-xyz',
      ['server', 'list', '--format', 'json']
    );
    expect(result.kind).toBe('not_installed');
    if (result.kind === 'not_installed') {
      expect(result.bin).toBe('/tmp/definitely-not-a-real-binary-eigenflux-xyz');
    }
  });
});
