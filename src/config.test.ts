import * as os from 'os';

const execEigenfluxMock = jest.fn();
jest.mock('./cli-executor', () => ({
  execEigenflux: (...args: any[]) => execEigenfluxMock(...args),
}));

import {
  PLUGIN_CONFIG,
  resolvePluginConfig,
  resolveEigenfluxHome,
  discoverServers,
} from './config';

const packageManifest = require('../package.json') as { version: string };
const pluginManifest = require('../openclaw.plugin.json') as { version: string };

describe('resolvePluginConfig', () => {
  test('returns defaults when config is empty', () => {
    const config = resolvePluginConfig({});

    expect(config.eigenfluxBin).toBe(PLUGIN_CONFIG.DEFAULT_EIGENFLUX_BIN);
    expect(config.skills).toEqual(['ef-broadcast', 'ef-communication']);
    expect(config.openclawCliBin).toBe(PLUGIN_CONFIG.DEFAULT_OPENCLAW_CLI_BIN);
    expect(config.serverRouting).toEqual({});
  });

  test('resolves custom eigenfluxBin and openclawCliBin', () => {
    const config = resolvePluginConfig({
      eigenfluxBin: '/opt/bin/eigenflux',
      openclawCliBin: '/opt/bin/openclaw',
    });

    expect(config.eigenfluxBin).toBe('/opt/bin/eigenflux');
    expect(config.openclawCliBin).toBe('/opt/bin/openclaw');
  });

  test('resolves custom skills array', () => {
    const config = resolvePluginConfig({
      skills: ['ef-broadcast', 'ef-profile', 'custom-skill'],
    });

    expect(config.skills).toEqual(['ef-broadcast', 'ef-profile', 'custom-skill']);
  });

  test('filters out non-string and empty skills entries', () => {
    const config = resolvePluginConfig({
      skills: ['ef-broadcast', '', 42, null, 'ef-communication'] as any,
    });

    expect(config.skills).toEqual(['ef-broadcast', 'ef-communication']);
  });

  test('resolves serverRouting with defaults for missing fields', () => {
    const config = resolvePluginConfig({
      serverRouting: {
        alpha: {
          sessionKey: 'agent:ops:feishu:direct:ou_alpha',
        },
      },
    });

    const routing = config.serverRouting['alpha'];
    expect(routing).toBeDefined();
    expect(routing.sessionKey).toBe('agent:ops:feishu:direct:ou_alpha');
    expect(routing.agentId).toBe('ops');
    expect(routing.replyChannel).toBe('feishu');
    expect(routing.replyTo).toBe('user:ou_alpha');
  });

  test('ignores schema-defaulted main session fields so route discovery stays automatic', () => {
    const config = resolvePluginConfig({
      serverRouting: {
        eigenflux: {
          sessionKey: 'main',
          agentId: 'main',
        },
      },
    });

    const routing = config.serverRouting['eigenflux'];
    expect(routing).toBeDefined();
    expect(routing.routeOverrides).toEqual({
      sessionKey: false,
      agentId: false,
      replyChannel: false,
      replyTo: false,
      replyAccountId: false,
    });
  });

});

describe('resolveEigenfluxHome', () => {
  const originalEnv = process.env.EIGENFLUX_HOME;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.EIGENFLUX_HOME;
    } else {
      process.env.EIGENFLUX_HOME = originalEnv;
    }
  });

  test('defaults to ~/.eigenflux when EIGENFLUX_HOME is not set', () => {
    delete process.env.EIGENFLUX_HOME;

    const home = resolveEigenfluxHome();
    expect(home).toBe(`${os.homedir()}/.eigenflux`);
  });

  test('uses EIGENFLUX_HOME env var with .eigenflux suffix appended', () => {
    process.env.EIGENFLUX_HOME = '/custom/path';

    const home = resolveEigenfluxHome();
    expect(home).toBe('/custom/path/.eigenflux');
  });

  test('does not double-append .eigenflux if already present', () => {
    process.env.EIGENFLUX_HOME = '/custom/path/.eigenflux';

    const home = resolveEigenfluxHome();
    expect(home).toBe('/custom/path/.eigenflux');
  });

  test('uses baseDir when EIGENFLUX_HOME is not set', () => {
    delete process.env.EIGENFLUX_HOME;

    const home = resolveEigenfluxHome('/opt/openclaw/plugins/eigenflux');
    expect(home).toBe('/opt/openclaw/plugins/eigenflux/.eigenflux');
  });

  test('EIGENFLUX_HOME takes precedence over baseDir', () => {
    process.env.EIGENFLUX_HOME = '/explicit/override';

    const home = resolveEigenfluxHome('/opt/openclaw/plugins/eigenflux');
    expect(home).toBe('/explicit/override/.eigenflux');
  });
});

describe('discoverServers', () => {
  beforeEach(() => {
    execEigenfluxMock.mockReset();
  });

  test('calls eigenflux with server list --format json', async () => {
    execEigenfluxMock.mockResolvedValue({ kind: 'success', data: [] });
    await discoverServers('eigenflux');
    expect(execEigenfluxMock).toHaveBeenCalledWith(
      'eigenflux',
      ['server', 'list', '--format', 'json'],
      expect.any(Object)
    );
  });

  test('returns ok with parsed servers on success', async () => {
    execEigenfluxMock.mockResolvedValue({
      kind: 'success',
      data: [{ name: 'eigenflux', endpoint: 'https://x', current: true }],
    });
    const result = await discoverServers('eigenflux');
    expect(result).toEqual({
      kind: 'ok',
      servers: [{ name: 'eigenflux', endpoint: 'https://x', current: true }],
    });
  });

  test('surfaces not_installed when the executor reports it', async () => {
    execEigenfluxMock.mockResolvedValue({ kind: 'not_installed', bin: 'eigenflux' });
    const result = await discoverServers('eigenflux');
    expect(result).toEqual({ kind: 'not_installed', bin: 'eigenflux' });
  });
});

describe('PLUGIN_CONFIG metadata', () => {
  test('keeps runtime metadata aligned with manifests', () => {
    expect(PLUGIN_CONFIG.PLUGIN_VERSION).toBe(packageManifest.version);
    expect(PLUGIN_CONFIG.PLUGIN_VERSION).toBe(pluginManifest.version);
    expect(PLUGIN_CONFIG.HOST_KIND).toBe('openclaw');
  });

  test('exports expected constant keys', () => {
    expect(PLUGIN_CONFIG.DEFAULT_EIGENFLUX_BIN).toBe('eigenflux');
    expect(PLUGIN_CONFIG.DEFAULT_SESSION_KEY).toBe('main');
    expect(PLUGIN_CONFIG.DEFAULT_AGENT_ID).toBe('main');
  });
});
