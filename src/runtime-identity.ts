/** Product metadata supplied by the running OpenClaw SDK, independent of this plugin. */
export function resolveRuntimeHost(runtimeVersion?: string, override?: string): string {
  const explicit = override?.trim().toLowerCase();
  if (explicit) {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}(\/[a-z0-9][a-z0-9._-]{0,63})?$/.test(explicit) || ['terminal', 'plugin', 'skill', 'skills', 'cli', 'cli-direct', 'unknown'].includes(explicit.split('/')[0])) {
      throw new Error('EIGENFLUX_HOST_OVERRIDE must be a product name with an optional product version');
    }
    return explicit;
  }
  const version = runtimeVersion?.trim().toLowerCase();
  return version && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(version) ? `openclaw/${version}` : 'openclaw';
}
