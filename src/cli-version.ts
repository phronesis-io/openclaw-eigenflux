export function supportsHeartbeatOrigin(version: unknown): boolean {
  if (typeof version !== 'string') return false;
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:\+[^ ]+)?$/.exec(version.trim());
  if (!match) return false;
  const [major, minor] = match.slice(1).map(Number);
  return major > 0 || minor >= 7;
}

export function supportsFeedBatches(version: unknown): boolean {
  if (typeof version !== 'string') return false;
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:\+[^ ]+)?$/.exec(version.trim());
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  return major > 0 || minor > 7 || (minor === 7 && patch >= 1);
}
