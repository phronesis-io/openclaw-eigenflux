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

  it('syncs from R2 into the OpenClaw host skills dir and refreshes the snapshot', async () => {
    execEigenfluxMock.mockResolvedValue({ kind: 'success', data: undefined });
    const logger = makeLogger();
    const refreshSnapshot = jest.fn();

    await syncPluginSkills('eigenflux', logger, refreshSnapshot);

    expect(execEigenfluxMock).toHaveBeenCalledTimes(1);
    const [bin, args, opts] = execEigenfluxMock.mock.calls[0];
    expect(bin).toBe('eigenflux');
    expect(args).toEqual(['skills', 'sync', '--if-stale', '--quiet', '--host', 'openclaw']);
    expect(args).not.toContain('--into');
    expect(opts).toMatchObject({ parseJson: false });
    expect(refreshSnapshot).toHaveBeenCalledTimes(1);
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
    const refreshSnapshot = jest.fn();

    await expect(syncPluginSkills('eigenflux', logger, refreshSnapshot)).resolves.toBeUndefined();
    expect(refreshSnapshot).not.toHaveBeenCalled();
    expect((logger.warn as jest.Mock)).toHaveBeenCalled();
  });

  it('never throws when execEigenflux itself rejects', async () => {
    execEigenfluxMock.mockRejectedValue(new Error('spawn failed'));
    const logger = makeLogger();
    const refreshSnapshot = jest.fn();

    await expect(syncPluginSkills('eigenflux', logger, refreshSnapshot)).resolves.toBeUndefined();
    expect(refreshSnapshot).not.toHaveBeenCalled();
    expect((logger.warn as jest.Mock)).toHaveBeenCalled();
  });
});
