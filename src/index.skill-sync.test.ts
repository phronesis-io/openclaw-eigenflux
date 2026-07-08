// The SDK plugin-entry module is ESM-only and cannot load under Jest's CJS
// transform; mock it so importing ./index (for the exported syncPluginSkills)
// succeeds. Mirrors the mock in index.test.ts.
jest.mock('openclaw/plugin-sdk/plugin-entry', () => ({
  definePluginEntry: (opts: any) => opts,
  buildJsonPluginConfigSchema: (schema: any) => schema,
}));

// Intercept the CLI subprocess so no real `eigenflux` is spawned.
const execEigenfluxMock = jest.fn();
jest.mock('./cli-executor', () => ({
  execEigenflux: (...args: any[]) => execEigenfluxMock(...args),
}));

import { syncPluginSkills } from './index';
import type { Logger } from './logger';

function makeLogger(): Logger {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  } as unknown as Logger;
}

describe('syncPluginSkills (startup skill auto-update)', () => {
  beforeEach(() => execEigenfluxMock.mockReset());

  it('syncs from R2 into the plugin bundle skills dir (offline-safe flags)', async () => {
    execEigenfluxMock.mockResolvedValue({ kind: 'success', data: undefined });
    const logger = makeLogger();

    await syncPluginSkills('eigenflux', logger);

    expect(execEigenfluxMock).toHaveBeenCalledTimes(1);
    const [bin, args, opts] = execEigenfluxMock.mock.calls[0];
    expect(bin).toBe('eigenflux');
    // Exact command + offline-safe flags; targets the bundle via --into, never
    // ~/.agents/skills (OpenClaw loads our skills from the bundle only).
    expect(args.slice(0, 5)).toEqual(['skills', 'sync', '--if-stale', '--quiet', '--into']);
    expect(args[5]).toMatch(/[\\/]skills$/);
    expect(args).not.toContain('--host');
    expect(opts).toMatchObject({ parseJson: false });
    expect((logger.info as jest.Mock)).toHaveBeenCalled();
  });

  it('never throws and logs a warning when the CLI returns a non-success kind', async () => {
    execEigenfluxMock.mockResolvedValue({
      kind: 'error',
      error: new Error('boom'),
      exitCode: 1,
      stderr: 'boom',
    });
    const logger = makeLogger();

    await expect(syncPluginSkills('eigenflux', logger)).resolves.toBeUndefined();
    expect((logger.warn as jest.Mock)).toHaveBeenCalled();
  });

  it('never throws when execEigenflux itself rejects', async () => {
    execEigenfluxMock.mockRejectedValue(new Error('spawn failed'));
    const logger = makeLogger();

    await expect(syncPluginSkills('eigenflux', logger)).resolves.toBeUndefined();
    expect((logger.warn as jest.Mock)).toHaveBeenCalled();
  });
});
