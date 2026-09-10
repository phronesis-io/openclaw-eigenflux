import { resolveRuntimeHost } from './runtime-identity';

describe('OpenClaw product identity', () => {
  test('uses the SDK host version and keeps unknown versions absent', () => {
    expect(resolveRuntimeHost('2026.7.1-2')).toBe('openclaw/2026.7.1-2');
    expect(resolveRuntimeHost()).toBe('openclaw');
    expect(resolveRuntimeHost('invalid/version')).toBe('openclaw');
  });

  test('honors only a separately declared product override', () => {
    expect(resolveRuntimeHost('2026.7.1', 'hermes/0.17.0')).toBe('hermes/0.17.0');
    expect(() => resolveRuntimeHost('2026.7.1', 'terminal')).toThrow('EIGENFLUX_HOST_OVERRIDE');
    expect(() => resolveRuntimeHost('2026.7.1', 'bad host')).toThrow('EIGENFLUX_HOST_OVERRIDE');
  });
});

test.each(['plugin', 'skill/1', 'skills', 'unknown', 'terminal/1'])('rejects mode sentinel %s as a product', (host) => {
  expect(() => resolveRuntimeHost(undefined, host)).toThrow('EIGENFLUX_HOST_OVERRIDE');
});
