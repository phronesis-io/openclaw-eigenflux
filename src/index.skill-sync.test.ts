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

  it('keeps the Console V2 preview skill bundle pinned', async () => {
    execEigenfluxMock.mockResolvedValue({ kind: 'success', data: undefined });
    const logger = makeLogger();

    await syncPluginSkills('eigenflux', logger);

    expect(execEigenfluxMock).not.toHaveBeenCalled();
    expect((logger.info as jest.Mock)).toHaveBeenCalledWith(expect.stringContaining('pinned Console V2 preview'));
  });

  it('does not invoke the remote sync path even when its mock would fail', async () => {
    execEigenfluxMock.mockResolvedValue({
      kind: 'error',
      error: new Error('boom'),
      exitCode: 1,
      stderr: 'boom',
    });
    const logger = makeLogger();

    await expect(syncPluginSkills('eigenflux', logger)).resolves.toBeUndefined();
    expect(execEigenfluxMock).not.toHaveBeenCalled();
    expect((logger.info as jest.Mock)).toHaveBeenCalled();
  });

  it('does not observe a rejected remote sync in the preview build', async () => {
    execEigenfluxMock.mockRejectedValue(new Error('spawn failed'));
    const logger = makeLogger();

    await expect(syncPluginSkills('eigenflux', logger)).resolves.toBeUndefined();
    expect(execEigenfluxMock).not.toHaveBeenCalled();
    expect((logger.info as jest.Mock)).toHaveBeenCalled();
  });
});
