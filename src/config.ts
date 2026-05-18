/**
 * Configuration for the EigenFlux plugin.
 *
 * Server management is now handled by the eigenflux CLI.
 * The plugin config only holds plugin-level settings and
 * per-server notification routing overrides.
 */

import * as os from 'os';
import * as path from 'path';

import { Logger } from './logger';
import { normalizeReplyTarget } from './reply-target';
import { execEigenflux } from './cli-executor';

const PLUGIN_VERSION = '0.0.9';
const DEFAULT_EIGENFLUX_BIN = 'eigenflux';
const DEFAULT_SESSION_KEY = 'main';
const DEFAULT_AGENT_ID = 'main';
const DEFAULT_OPENCLAW_CLI_BIN = 'openclaw';
const HOST_KIND = 'openclaw';

// ─── Types ──────────────────────────────────────────────────────────────────

export type NotificationRouteOverrides = {
  sessionKey: boolean;
  agentId: boolean;
  replyChannel: boolean;
  replyTo: boolean;
  replyAccountId: boolean;
};

export type RoutingConfig = {
  sessionKey: string;
  agentId: string;
  replyChannel?: string;
  replyTo?: string;
  replyAccountId?: string;
  routeOverrides: NotificationRouteOverrides;
};

export type DiscoveredServer = {
  name: string;
  endpoint: string;
  stream_endpoint?: string;
  current: boolean;
};

export type EigenFluxPluginConfig = {
  eigenfluxBin?: string;
  skills?: string[];
  openclawCliBin?: string;
  serverRouting?: Record<string, {
    sessionKey?: string;
    agentId?: string;
    replyChannel?: string;
    replyTo?: string;
    replyAccountId?: string;
  }>;
};

export type ResolvedEigenFluxPluginConfig = {
  eigenfluxBin: string;
  skills: string[];
  openclawCliBin: string;
  serverRouting: Record<string, RoutingConfig>;
};

type DerivedNotificationRoute = {
  agentId?: string;
  replyChannel?: string;
  replyTo?: string;
  replyAccountId?: string;
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isSessionPeerShape(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return (
    normalized === 'direct' ||
    normalized === 'dm' ||
    normalized === 'group' ||
    normalized === 'channel'
  );
}

function deriveNotificationRoute(sessionKey: string | undefined): DerivedNotificationRoute {
  const trimmed = readNonEmptyString(sessionKey);
  if (!trimmed) {
    return {};
  }

  const parts = trimmed.split(':').filter((part) => part.length > 0);
  if (parts.length < 3 || parts[0]?.toLowerCase() !== 'agent') {
    return {};
  }

  const agentId = readNonEmptyString(parts[1]);
  if (parts.length >= 6 && isSessionPeerShape(parts[4])) {
    return {
      agentId,
      replyChannel: readNonEmptyString(parts[2]),
      replyAccountId: readNonEmptyString(parts[3]),
      replyTo: normalizeReplyTarget(parts.slice(5).join(':'), {
        channel: readNonEmptyString(parts[2]),
        sessionKey: trimmed,
      }),
    };
  }

  if (parts.length >= 5 && isSessionPeerShape(parts[3])) {
    return {
      agentId,
      replyChannel: readNonEmptyString(parts[2]),
      replyTo: normalizeReplyTarget(parts.slice(4).join(':'), {
        channel: readNonEmptyString(parts[2]),
        sessionKey: trimmed,
      }),
    };
  }

  return { agentId };
}

function createRouteOverrides(
  normalized: Record<string, unknown>
): NotificationRouteOverrides {
  const sessionKey = readNonEmptyString(normalized.sessionKey);
  const agentId = readNonEmptyString(normalized.agentId);
  const replyChannel = readNonEmptyString(normalized.replyChannel);
  const replyTo = readNonEmptyString(normalized.replyTo);
  const replyAccountId = readNonEmptyString(normalized.replyAccountId);

  return {
    sessionKey: sessionKey !== undefined && sessionKey !== DEFAULT_SESSION_KEY,
    agentId:
      agentId !== undefined &&
      agentId !== DEFAULT_AGENT_ID &&
      !(sessionKey && deriveNotificationRoute(sessionKey).agentId === agentId),
    replyChannel: replyChannel !== undefined,
    replyTo: replyTo !== undefined,
    replyAccountId: replyAccountId !== undefined,
  };
}

// ─── Server Discovery ───────────────────────────────────────────────────────

export type DiscoveryResult =
  | { kind: 'ok'; servers: DiscoveredServer[] }
  | { kind: 'not_installed'; bin: string };

export async function discoverServers(
  eigenfluxBin: string,
  logger?: Logger
): Promise<DiscoveryResult> {
  const result = await execEigenflux<DiscoveredServer[]>(
    eigenfluxBin,
    ['server', 'list', '--format', 'json'],
    { logger }
  );

  if (result.kind === 'success') {
    if (Array.isArray(result.data)) {
      return { kind: 'ok', servers: result.data };
    }
    logger?.warn('eigenflux server list returned non-array data');
    return { kind: 'ok', servers: [] };
  }

  if (result.kind === 'not_installed') {
    return { kind: 'not_installed', bin: result.bin };
  }

  if (result.kind === 'auth_required') {
    logger?.warn('eigenflux server list: auth required (unexpected)');
    return { kind: 'ok', servers: [] };
  }

  logger?.error(`eigenflux server list failed: ${result.error.message}`);
  return { kind: 'ok', servers: [] };
}

// ─── EigenFlux Home ─────────────────────────────────────────────────────────

export function resolveEigenfluxHome(): string {
  const envHome = process.env.EIGENFLUX_HOME;
  if (envHome) {
    const expanded = expandHomeDir(envHome);
    if (!expanded.endsWith('.eigenflux')) {
      return path.join(expanded, '.eigenflux');
    }
    return expanded;
  }
  return path.join(os.homedir(), '.eigenflux');
}

// ─── Config Resolution ──────────────────────────────────────────────────────

function resolveRoutingConfig(
  raw: Record<string, unknown> | undefined,
  logger?: Logger
): RoutingConfig {
  const normalized = isRecord(raw) ? raw : {};
  const sessionKey = readNonEmptyString(normalized.sessionKey) ?? DEFAULT_SESSION_KEY;
  const derivedRoute = deriveNotificationRoute(sessionKey);
  const replyChannel = readNonEmptyString(normalized.replyChannel) ?? derivedRoute.replyChannel;
  const replyTo =
    normalizeReplyTarget(readNonEmptyString(normalized.replyTo), {
      channel: replyChannel,
      sessionKey,
    }) ?? derivedRoute.replyTo;

  return {
    sessionKey,
    agentId: readNonEmptyString(normalized.agentId) ?? derivedRoute.agentId ?? DEFAULT_AGENT_ID,
    replyChannel,
    replyTo,
    replyAccountId:
      readNonEmptyString(normalized.replyAccountId) ?? derivedRoute.replyAccountId,
    routeOverrides: createRouteOverrides(normalized),
  };
}

export function resolvePluginConfig(
  pluginConfig: unknown,
  logger?: Logger
): ResolvedEigenFluxPluginConfig {
  const normalized = isRecord(pluginConfig) ? pluginConfig : {};

  const rawRouting = isRecord(normalized.serverRouting) ? normalized.serverRouting : {};
  const serverRouting: Record<string, RoutingConfig> = {};
  for (const [serverName, rawConfig] of Object.entries(rawRouting)) {
    serverRouting[serverName] = resolveRoutingConfig(
      isRecord(rawConfig) ? rawConfig : undefined,
      logger
    );
  }

  const rawSkills = Array.isArray(normalized.skills)
    ? normalized.skills.filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
    : ['ef-broadcast', 'ef-communication'];

  return {
    eigenfluxBin: readNonEmptyString(normalized.eigenfluxBin) ?? DEFAULT_EIGENFLUX_BIN,
    skills: rawSkills,
    openclawCliBin:
      readNonEmptyString(normalized.openclawCliBin) ?? DEFAULT_OPENCLAW_CLI_BIN,
    serverRouting,
  };
}

// ─── Exports ────────────────────────────────────────────────────────────────

export function expandHomeDir(input: string): string {
  if (input === '~') {
    return os.homedir();
  }
  if (input.startsWith('~/')) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

export const PLUGIN_CONFIG = {
  DEFAULT_EIGENFLUX_BIN,
  DEFAULT_SESSION_KEY,
  DEFAULT_AGENT_ID,
  DEFAULT_OPENCLAW_CLI_BIN,
  HOST_KIND,
  PLUGIN_VERSION,
} as const;

// ─── Client Meta ───────────────────────────────────────────────────────────

export interface ClientMeta {
  plugin: string;
  host: string;
  host_version?: string;
  cli_version?: string;
  platform: string;
}

export async function collectClientMeta(
  eigenfluxBin: string,
  openclawCliBin: string,
  logger: Logger,
): Promise<ClientMeta> {
  const meta: ClientMeta = {
    plugin: PLUGIN_VERSION,
    host: HOST_KIND,
    platform: `${os.platform()}/${os.arch()}`,
  };

  try {
    const oc = await execEigenflux<string>(openclawCliBin, ['--version'], {
      parseJson: false,
      logger,
    });
    if (oc.kind === 'success' && typeof oc.data === 'string') {
      const match = oc.data.match(/OpenClaw\s+([\d.]+)/);
      if (match) meta.host_version = match[1];
    }
  } catch {
    logger.debug('Failed to detect OpenClaw version');
  }

  try {
    const ef = await execEigenflux<{ cli_version?: string }>(eigenfluxBin, ['version'], { logger });
    if (ef.kind === 'success' && ef.data?.cli_version) {
      meta.cli_version = ef.data.cli_version;
    }
  } catch {
    logger.debug('Failed to detect EigenFlux CLI version');
  }

  return meta;
}

