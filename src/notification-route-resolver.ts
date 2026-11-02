import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { type NotificationRouteOverrides } from './config';
import { Logger } from './logger';
import { normalizeReplyTarget } from './reply-target';
import { readStoredNotificationRoute, type PluginRuntimeStore } from './session-route-memory';

const INTERNAL_CHANNELS = new Set(['webchat']);

function getDefaultOpenClawStateDir(): string {
  return path.join(os.homedir(), '.openclaw');
}

type DeliveryContextLike = {
  channel?: unknown;
  to?: unknown;
  accountId?: unknown;
  threadId?: unknown;
};

type SessionOriginLike = {
  provider?: unknown;
  to?: unknown;
  accountId?: unknown;
  chatType?: unknown;
  threadId?: unknown;
};

type ReplyThread = { id: string | number; kind?: string; source?: string };

type SessionStoreEntry = {
  updatedAt?: unknown;
  deliveryContext?: DeliveryContextLike;
  lastTo?: unknown;
  lastAccountId?: unknown;
  lastThreadId?: unknown;
  origin?: SessionOriginLike;
  chatType?: unknown;
  delivery?: { kind?: unknown; context?: DeliveryContextLike; origin?: SessionOriginLike;
    route?: { thread?: { id?: unknown; kind?: unknown; source?: unknown } } };
};

type SessionStoreSnapshot = {
  path: string;
  store: Record<string, SessionStoreEntry>;
};

export type NotificationRouteConfig = {
  sessionKey: string;
  agentId: string;
  replyChannel?: string;
  replyTo?: string;
  replyAccountId?: string;
  sessionStorePath?: string;
  store?: PluginRuntimeStore;
  eigenfluxBin?: string;
  serverName?: string;
  routeOverrides?: NotificationRouteOverrides;
};

export type ResolvedNotificationRoute = {
  sessionKey: string;
  agentId: string;
  replyChannel?: string;
  replyTo?: string;
  replyAccountId?: string;
  replyThread?: ReplyThread;
};

export type NotificationRouteSource = 'config' | 'remembered' | 'session-store' | 'default';

export type ResolvedNotificationRouteResult = {
  route: ResolvedNotificationRoute;
  source: NotificationRouteSource;
};

export type NotificationRouteResolveOptions = {
  ignoreRemembered?: boolean;
  readSessionStore?: (agentId: string, storePath: string) => Record<string, SessionStoreEntry>;
};

type PreferredRoute = {
  channel?: string;
  to?: string;
  accountId?: string;
};

type RouteSelection = {
  route: ResolvedNotificationRoute;
  updatedAt: number;
};

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeChannel(value: unknown): string | undefined {
  return readNonEmptyString(value)?.toLowerCase();
}

function readThreadId(value: unknown): string | number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : readNonEmptyString(value);
}

function normalizeUpdatedAt(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  return 0;
}

function createRouteOverrides(
  overrides: NotificationRouteConfig['routeOverrides']
): NotificationRouteOverrides {
  return {
    sessionKey: overrides?.sessionKey === true,
    agentId: overrides?.agentId === true,
    replyChannel: overrides?.replyChannel === true,
    replyTo: overrides?.replyTo === true,
    replyAccountId: overrides?.replyAccountId === true,
  };
}

function isAnyRouteOverrideEnabled(overrides: NotificationRouteOverrides): boolean {
  return Object.values(overrides).some(Boolean);
}

export function isInternalSessionKey(sessionKey: string): boolean {
  const trimmed = readNonEmptyString(sessionKey);
  if (!trimmed) {
    return true;
  }
  const lower = trimmed.toLowerCase();
  if (lower === 'main' || lower === 'heartbeat') {
    return true;
  }

  const parts = lower.split(':').filter((part) => part.length > 0);
  return parts[0] === 'agent' && parts[2] === 'heartbeat';
}

function isExternalChannel(channel: string | undefined): boolean {
  return Boolean(channel && !INTERNAL_CHANNELS.has(channel));
}

export function isDirectSessionKey(sessionKey: string, entry: SessionStoreEntry): boolean {
  const parts = sessionKey.toLowerCase().split(':').filter(Boolean);
  if (parts.includes('direct') || parts.includes('dm')) {
    return true;
  }

  const chatType =
    readNonEmptyString(entry.chatType)?.toLowerCase() ??
    readNonEmptyString(entry.origin?.chatType as unknown)?.toLowerCase();
  if (chatType === 'direct' || chatType === 'dm') {
    return true;
  }

  const toCandidates = [entry.deliveryContext?.to, entry.lastTo, entry.origin?.to];
  return toCandidates.some((candidate) => {
    const trimmed = readNonEmptyString(candidate);
    if (!trimmed) {
      return false;
    }
    const colonAt = trimmed.indexOf(':');
    if (colonAt <= 0) {
      return false;
    }
    return trimmed.slice(0, colonAt).toLowerCase() === 'user';
  });
}

const GROUP_PEER_SHAPES = new Set(['group', 'channel', 'room']);
const GROUP_TARGET_PREFIXES = new Set(['chat', 'channel', 'room']);

function readChatTypeSignal(value: unknown): string | undefined {
  const normalized = readNonEmptyString(value)?.toLowerCase();
  return normalized && GROUP_PEER_SHAPES.has(normalized) ? normalized : undefined;
}

function readTargetPrefixSignal(value: unknown): string | undefined {
  const trimmed = readNonEmptyString(value);
  if (!trimmed) {
    return undefined;
  }
  const colonAt = trimmed.indexOf(':');
  if (colonAt <= 0) {
    return undefined;
  }
  const prefix = trimmed.slice(0, colonAt).toLowerCase();
  return GROUP_TARGET_PREFIXES.has(prefix) ? prefix : undefined;
}

export function isGroupEntry(sessionKey: string, entry: SessionStoreEntry): boolean {
  const parts = sessionKey.toLowerCase().split(':').filter(Boolean);
  if (parts.some((part) => GROUP_PEER_SHAPES.has(part))) {
    return true;
  }

  if (
    readChatTypeSignal(entry.chatType) ||
    readChatTypeSignal(entry.origin?.chatType as unknown)
  ) {
    return true;
  }

  const toCandidates = [entry.deliveryContext?.to, entry.lastTo, entry.origin?.to];
  if (toCandidates.some((candidate) => readTargetPrefixSignal(candidate))) {
    return true;
  }

  return false;
}

function isSessionPeerShape(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return (
    normalized === 'direct' ||
    normalized === 'dm' ||
    normalized === 'group' ||
    normalized === 'channel' ||
    normalized === 'room'
  );
}

function routeTargetMatches(actual: string | undefined, expected: string | undefined): boolean {
  if (!expected) {
    return true;
  }
  if (!actual) {
    return false;
  }
  return actual === expected || actual.endsWith(`:${expected}`) || expected.endsWith(`:${actual}`);
}

function routeMatchesPreferred(
  route: ResolvedNotificationRoute,
  preferred: PreferredRoute | undefined
): boolean {
  if (!preferred) {
    return true;
  }
  if (preferred.channel && route.replyChannel !== preferred.channel) {
    return false;
  }
  if (!routeTargetMatches(route.replyTo, preferred.to)) {
    return false;
  }
  if (preferred.accountId && route.replyAccountId !== preferred.accountId) {
    return false;
  }
  return true;
}

function deriveAgentIdFromSessionKey(sessionKey: string | undefined): string | undefined {
  const trimmed = readNonEmptyString(sessionKey);
  if (!trimmed) {
    return undefined;
  }
  const parts = trimmed.split(':').filter((part) => part.length > 0);
  if (parts[0]?.toLowerCase() !== 'agent') {
    return undefined;
  }
  return readNonEmptyString(parts[1]);
}

function deriveReplyTargetKindFromSessionKey(
  sessionKey: string | undefined
): 'user' | 'chat' | 'channel' | 'room' | undefined {
  const trimmed = readNonEmptyString(sessionKey);
  if (!trimmed) {
    return undefined;
  }

  const parts = trimmed.split(':').filter((part) => part.length > 0);
  if (parts[0]?.toLowerCase() !== 'agent') {
    return undefined;
  }

  const channel = readNonEmptyString(parts[2])?.toLowerCase();
  const peerShape =
    parts.length >= 6 && isSessionPeerShape(parts[4])
      ? parts[4].toLowerCase()
      : parts.length >= 5 && isSessionPeerShape(parts[3])
        ? parts[3].toLowerCase()
        : undefined;

  switch (channel) {
    case 'feishu':
      if (peerShape === 'direct' || peerShape === 'dm') {
        return 'user';
      }
      if (peerShape === 'group') {
        return 'chat';
      }
      return undefined;
    case 'discord':
      if (peerShape === 'direct' || peerShape === 'dm') {
        return 'user';
      }
      if (peerShape === 'channel') {
        return 'channel';
      }
      return undefined;
    default:
      return undefined;
  }
}

function normalizeSessionStoreTarget(
  value: unknown,
  channel: string | undefined,
  sessionKey: string
): string | undefined {
  const trimmed = readNonEmptyString(value);
  if (!trimmed) {
    return undefined;
  }

  const derivedKind = deriveReplyTargetKindFromSessionKey(sessionKey);
  if (derivedKind && !/^(user|chat|channel|room):/u.test(trimmed)) {
    return `${derivedKind}:${trimmed}`;
  }

  return normalizeReplyTarget(trimmed, {
    channel,
    sessionKey,
  });
}

function deriveChannelFromSessionKey(sessionKey: string): string | undefined {
  const parts = sessionKey.split(':').filter(Boolean);
  if (parts[0]?.toLowerCase() !== 'agent') {
    return undefined;
  }
  return normalizeChannel(parts[2]);
}

function deriveTargetFromSessionKey(
  sessionKey: string,
  channel: string | undefined
): string | undefined {
  const parts = sessionKey.split(':').filter(Boolean);
  if (parts[0]?.toLowerCase() !== 'agent') {
    return undefined;
  }
  // Layout: agent:<agentId>:<channel>:<peerShape>:<target>[:<extra>]
  //     or: agent:<agentId>:<channel>:<peerShape>:<accountId>:<target>
  if (parts.length < 5 || !isSessionPeerShape(parts[3])) {
    return undefined;
  }
  const rawTarget = parts.length >= 6 ? parts[5] : parts[4];
  if (!readNonEmptyString(rawTarget)) {
    return undefined;
  }
  return normalizeSessionStoreTarget(rawTarget, channel, sessionKey);
}

function extractRouteFromEntry(
  sessionKey: string,
  entry: SessionStoreEntry | undefined
): ResolvedNotificationRoute | undefined {
  if (!entry) {
    return undefined;
  }

  const replyChannel =
    normalizeChannel(entry.deliveryContext?.channel) ??
    normalizeChannel(entry.origin?.provider) ??
    deriveChannelFromSessionKey(sessionKey);
  const replyTo =
    normalizeSessionStoreTarget(entry.deliveryContext?.to, replyChannel, sessionKey) ??
    normalizeSessionStoreTarget(entry.lastTo, replyChannel, sessionKey) ??
    normalizeSessionStoreTarget(entry.origin?.to, replyChannel, sessionKey) ??
    deriveTargetFromSessionKey(sessionKey, replyChannel);
  const replyAccountId =
    readNonEmptyString(entry.deliveryContext?.accountId) ??
    readNonEmptyString(entry.lastAccountId) ??
    readNonEmptyString(entry.origin?.accountId);
  const thread = entry.delivery?.route?.thread;
  const threadId = readThreadId(entry.deliveryContext?.threadId) ?? readThreadId(entry.lastThreadId)
    ?? readThreadId(entry.origin?.threadId) ?? readThreadId(thread?.id);

  if (!replyChannel || !replyTo) {
    return undefined;
  }

  return {
    sessionKey,
    agentId: deriveAgentIdFromSessionKey(sessionKey) ?? 'main',
    replyChannel,
    replyTo,
    replyAccountId,
    ...(threadId !== undefined ? { replyThread: { id: threadId,
      ...(readNonEmptyString(thread?.kind) ? { kind: readNonEmptyString(thread?.kind) } : {}),
      ...(readNonEmptyString(thread?.source) ? { source: readNonEmptyString(thread?.source) } : {}),
    } } : {}),
  };
}

function tryDeriveAgentIdFromStorePath(sessionStorePath: string): string | undefined {
  const normalized = path.normalize(sessionStorePath);
  const parts = normalized.split(path.sep).filter(Boolean);
  const agentsIndex = parts.lastIndexOf('agents');
  if (agentsIndex === -1) {
    return undefined;
  }
  return readNonEmptyString(parts[agentsIndex + 1]);
}

function listSessionStorePaths(explicitPath: string | undefined, baseAgentId: string): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();

  const addPath = (candidate: string | undefined) => {
    const trimmed = readNonEmptyString(candidate);
    if (!trimmed) {
      return;
    }
    const normalized = path.normalize(trimmed);
    if (seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    candidates.push(normalized);
  };

  addPath(explicitPath);
  if (candidates.length > 0) {
    return candidates;
  }

  const defaultOpenClawStateDir = getDefaultOpenClawStateDir();
  addPath(path.join(defaultOpenClawStateDir, 'agents', baseAgentId, 'sessions', 'sessions.json'));

  const agentsRoot = path.join(defaultOpenClawStateDir, 'agents');
  try {
    if (fs.existsSync(agentsRoot)) {
      for (const entry of fs.readdirSync(agentsRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) {
          continue;
        }
        addPath(path.join(agentsRoot, entry.name, 'sessions', 'sessions.json'));
      }
    }
  } catch {
    // Ignore directory scan failures; we will still try explicit/default paths.
  }

  return candidates;
}

function readSessionStore(
  sessionStorePath: string,
  logger: Logger
): Record<string, SessionStoreEntry> | undefined {
  try {
    if (!fs.existsSync(sessionStorePath)) {
      return undefined;
    }
    const raw = fs.readFileSync(sessionStorePath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return undefined;
    }
    return parsed as Record<string, SessionStoreEntry>;
  } catch (error) {
    logger.debug(
      `Failed to read session store ${sessionStorePath}: ${error instanceof Error ? error.message : String(error)}`
    );
    return undefined;
  }
}

function readSessionStores(
  sessionStorePath: string | undefined,
  baseAgentId: string,
  logger: Logger,
  reader?: NotificationRouteResolveOptions['readSessionStore']
): SessionStoreSnapshot[] {
  const snapshots: SessionStoreSnapshot[] = [];
  const candidates = listSessionStorePaths(sessionStorePath, baseAgentId);
  logger.info(
    `Session store scan candidates: base_agent_id=${baseAgentId}, explicit_path=${sessionStorePath ?? 'n/a'}, candidates=${JSON.stringify(candidates)}`
  );
  for (const candidate of candidates) {
    if (reader && (tryDeriveAgentIdFromStorePath(candidate) ?? baseAgentId) !== baseAgentId) continue;
    let store: Record<string, SessionStoreEntry> | undefined;
    try {
      store = reader ? reader(baseAgentId, candidate) : readSessionStore(candidate, logger);
    } catch {
      logger.warn('Host session route snapshot unavailable');
    }
    if (store) {
      store = Object.fromEntries(Object.entries(store)
        .filter(([key, entry]) => (!reader || (deriveAgentIdFromSessionKey(key) ?? baseAgentId) === baseAgentId)
          && (!entry?.delivery || entry.delivery.kind === 'external'))
        .map(([key, entry]) => [key, entry?.delivery ? {
          ...entry,
          deliveryContext: entry.delivery.kind === 'external' ? entry.delivery.context : undefined,
          origin: entry.delivery.kind === 'external' ? entry.delivery.origin : undefined,
          lastTo: undefined,
          lastAccountId: undefined,
          lastThreadId: undefined,
        } : entry]));
      const keys = Object.keys(store);
      logger.info(
        `Session store loaded: source=${reader ? 'host-sdk' : 'legacy-json'}, entries=${keys.length}`
      );
      snapshots.push({ path: candidate, store });
    }
  }
  return snapshots;
}

function buildPreferredRoute(route: ResolvedNotificationRoute): PreferredRoute | undefined {
  if (!route.replyChannel && !route.replyTo && !route.replyAccountId) {
    return undefined;
  }
  return {
    channel: route.replyChannel,
    to: route.replyTo,
    accountId: route.replyAccountId,
  };
}

function mergeRoute(
  base: ResolvedNotificationRoute,
  resolved: ResolvedNotificationRoute,
  overrides: NotificationRouteOverrides,
  allowSessionOverride: boolean
): ResolvedNotificationRoute {
  const nextSessionKey =
    allowSessionOverride && !overrides.sessionKey ? resolved.sessionKey : base.sessionKey;

  return {
    sessionKey: nextSessionKey,
    agentId:
      overrides.agentId === true
        ? base.agentId
        : resolved.agentId ?? deriveAgentIdFromSessionKey(nextSessionKey) ?? base.agentId,
    replyChannel:
      overrides.replyChannel === true ? base.replyChannel : resolved.replyChannel ?? base.replyChannel,
    replyTo: overrides.replyTo === true ? base.replyTo : resolved.replyTo ?? base.replyTo,
    replyAccountId:
      overrides.replyAccountId === true
        ? base.replyAccountId
        : resolved.replyAccountId ?? base.replyAccountId,
    replyThread: (!overrides.replyChannel || base.replyChannel === resolved.replyChannel)
      && (!overrides.replyTo || base.replyTo === resolved.replyTo)
      && (!overrides.replyAccountId || base.replyAccountId === resolved.replyAccountId)
      ? resolved.replyThread : undefined,
  };
}

function selectExactRoute(
  snapshots: SessionStoreSnapshot[],
  sessionKey: string
): RouteSelection | undefined {
  let best: RouteSelection | undefined;

  for (const snapshot of snapshots) {
    const entry = snapshot.store[sessionKey];
    const route = extractRouteFromEntry(sessionKey, entry);
    if (!route || !isExternalChannel(route.replyChannel)) {
      continue;
    }
    const updatedAt = normalizeUpdatedAt(entry?.updatedAt);
    if (!best || updatedAt > best.updatedAt) {
      best = { route, updatedAt };
    }
  }

  return best;
}

type RouteCandidate = {
  route: ResolvedNotificationRoute;
  updatedAt: number;
  isExternal: boolean;
  isDirect: boolean;
};

/**
 * Picks the best session route from recent conversation history.
 *
 * Preference order (each tier only falls back if the prior tier is empty):
 *   1. External channel (not in INTERNAL_CHANNELS) over internal channel.
 *   2. Direct/DM session over non-direct.
 *   3. Most recent `updatedAt`.
 *
 * Always skips OpenClaw-internal sessions (bare `main`, `heartbeat`,
 * `agent:*:heartbeat`). When called in auto-scan mode (no `preferred`),
 * also skips group/channel/room entries so we never auto-post to a group —
 * only an explicit binding (via `preferred`) can route there.
 */
function selectBestRoute(
  snapshots: SessionStoreSnapshot[],
  preferred: PreferredRoute | undefined,
  preferredAgentId?: string,
  logger?: Logger
): RouteSelection | undefined {
  const candidates: RouteCandidate[] = [];
  const autoScan = preferred === undefined;

  for (const snapshot of snapshots) {
    const pathAgentId = tryDeriveAgentIdFromStorePath(snapshot.path);
    for (const [sessionKey, entry] of Object.entries(snapshot.store)) {
      if (sessionKey.includes(':subagent:')) {
        continue;
      }
      if (isInternalSessionKey(sessionKey)) {
        logger?.debug(`Skipping ${sessionKey}: internal session`);
        continue;
      }
      if (autoScan && isGroupEntry(sessionKey, entry)) {
        logger?.debug(`Skipping ${sessionKey}: group entry in auto-scan`);
        continue;
      }

      const route = extractRouteFromEntry(sessionKey, entry);
      if (!route || !routeMatchesPreferred(route, preferred)) {
        continue;
      }

      if (preferredAgentId && route.agentId !== preferredAgentId && pathAgentId !== preferredAgentId) {
        continue;
      }

      candidates.push({
        route,
        updatedAt: normalizeUpdatedAt(entry.updatedAt),
        isExternal: isExternalChannel(route.replyChannel),
        isDirect: isDirectSessionKey(sessionKey, entry),
      });
    }
  }

  if (candidates.length === 0) {
    return undefined;
  }

  const externalPool = candidates.filter((c) => c.isExternal);
  const channelPool = externalPool.length > 0 ? externalPool : candidates;

  const directPool = channelPool.filter((c) => c.isDirect);
  const finalPool = directPool.length > 0 ? directPool : channelPool;

  const chosen = finalPool.reduce((best, c) => (c.updatedAt > best.updatedAt ? c : best));
  return { route: chosen.route, updatedAt: chosen.updatedAt };
}

/**
 * Find a session route that matches the given binding (channel + to + optional
 * account). Used by `/eigenflux here` to pin delivery to the current conversation.
 * Falls back through the same external-first / direct-first tiers as startup
 * discovery.
 */
export function findSessionRouteForBinding(
  options: {
    sessionStorePath?: string;
    agentId: string;
    channel: string;
    to: string;
    accountId?: string;
  },
  logger: Logger
): ResolvedNotificationRoute | undefined {
  const channel = normalizeChannel(options.channel);
  const to = normalizeReplyTarget(options.to, { channel });
  const accountId = readNonEmptyString(options.accountId);
  const agentId = readNonEmptyString(options.agentId) ?? 'main';
  if (!channel || !to) {
    return undefined;
  }

  const snapshots = readSessionStores(options.sessionStorePath, agentId, logger);
  const best = selectBestRoute(snapshots, { channel, to, accountId }, agentId, logger);
  if (best) {
    return best.route;
  }

  // Fallback: synthesize a sessionKey from agentId + channel + peer shape + target
  // so `/eigenflux here` can pin the conversation even without a session-store hit.
  const peerShape = inferPeerShape(channel, to);
  const targetLocal = stripTargetPrefix(to);
  if (!peerShape || !targetLocal) {
    return undefined;
  }
  return {
    sessionKey: `agent:${agentId}:${channel}:${peerShape}:${targetLocal}`,
    agentId,
    replyChannel: channel,
    replyTo: to,
    replyAccountId: accountId,
  };
}

function inferPeerShape(channel: string, to: string): 'direct' | 'group' | 'channel' | undefined {
  const kind = to.split(':', 1)[0]?.toLowerCase();
  switch (kind) {
    case 'user':
      return 'direct';
    case 'chat':
      return channel === 'feishu' ? 'group' : 'direct';
    case 'channel':
      return 'channel';
    case 'room':
      return 'group';
    default:
      return undefined;
  }
}

function stripTargetPrefix(to: string): string | undefined {
  const idx = to.indexOf(':');
  if (idx === -1) {
    return readNonEmptyString(to);
  }
  return readNonEmptyString(to.slice(idx + 1));
}

export async function resolveNotificationRoute(
  config: NotificationRouteConfig,
  logger: Logger,
  options: NotificationRouteResolveOptions = {}
): Promise<ResolvedNotificationRouteResult> {
  const overrides = createRouteOverrides(config.routeOverrides);

  const configRoute: ResolvedNotificationRoute = {
    sessionKey: readNonEmptyString(config.sessionKey) ?? 'main',
    agentId:
      readNonEmptyString(config.agentId) ??
      deriveAgentIdFromSessionKey(config.sessionKey) ??
      'main',
    replyChannel: normalizeChannel(config.replyChannel),
    replyTo: normalizeReplyTarget(config.replyTo, {
      channel: normalizeChannel(config.replyChannel),
      sessionKey: config.sessionKey,
    }),
    replyAccountId: readNonEmptyString(config.replyAccountId),
  };
  logger.info(
    `Route resolve start: session_key=${configRoute.sessionKey}, agent_id=${configRoute.agentId}, channel=${configRoute.replyChannel ?? 'n/a'}, to=${configRoute.replyTo ?? 'n/a'}, account=${configRoute.replyAccountId ?? 'n/a'}, overrides=${JSON.stringify(overrides)}, ignore_remembered=${options.ignoreRemembered === true}`
  );

  // 1. Explicit config values win.
  //    Triggered by any of:
  //      - routeOverrides flag set on a field (plugin config marks user-provided fields)
  //      - non-internal sessionKey provided directly
  //      - both replyChannel and replyTo provided directly
  const hasExplicitConfig =
    isAnyRouteOverrideEnabled(overrides) ||
    !isInternalSessionKey(configRoute.sessionKey) ||
    Boolean(configRoute.replyChannel && configRoute.replyTo);
  if (hasExplicitConfig) {
    const snapshots = readSessionStores(config.sessionStorePath, configRoute.agentId, logger, options.readSessionStore);
    // Try exact sessionKey match first. If config sessionKey is internal but
    // channel+to are pinned, fall back to peer-shape match to enrich accountId
    // (and pick up the real sessionKey) from the session store.
    let enriched = selectExactRoute(snapshots, configRoute.sessionKey)?.route;
    if (!enriched && configRoute.replyChannel && configRoute.replyTo) {
      enriched = selectBestRoute(
        snapshots,
        {
          channel: configRoute.replyChannel,
          to: configRoute.replyTo,
          accountId: configRoute.replyAccountId,
        },
        undefined,
        logger
      )?.route;
    }
    const resolved = enriched
      ? mergeRoute(configRoute, enriched, overrides, isInternalSessionKey(configRoute.sessionKey))
      : configRoute;
    logger.info(
      `Route resolve final (config): session_key=${resolved.sessionKey}, agent_id=${resolved.agentId}, channel=${resolved.replyChannel ?? 'n/a'}, to=${resolved.replyTo ?? 'n/a'}, account=${resolved.replyAccountId ?? 'n/a'}`
    );
    return { route: resolved, source: 'config' };
  }

  const snapshots = readSessionStores(config.sessionStorePath, configRoute.agentId, logger, options.readSessionStore);

  // 2. Remembered route (openclaw_deliver_session CLI config).
  if (options.ignoreRemembered !== true) {
    const remembered = await readStoredNotificationRoute(
      config.store,
      config.serverName,
      logger
    );
    if (remembered && (!options.readSessionStore || remembered.agentId === configRoute.agentId)) {
      logger.info(
        `Route resolve remembered: session_key=${remembered.sessionKey}, agent_id=${remembered.agentId}, channel=${remembered.replyChannel ?? 'n/a'}, to=${remembered.replyTo ?? 'n/a'}, account=${remembered.replyAccountId ?? 'n/a'}`
      );
      // Use remembered replyChannel+replyTo as a peer-shape anchor against
      // session stores so we resolve the real sessionKey even if remembered
      // was stored with a stale/internal key.
      const preferred: PreferredRoute | undefined =
        remembered.replyChannel && remembered.replyTo
          ? {
              channel: remembered.replyChannel,
              to: remembered.replyTo,
              accountId: remembered.replyAccountId,
            }
          : undefined;
      const peerMatch = selectBestRoute(snapshots, preferred, undefined, logger);
      if (peerMatch) {
        return { route: peerMatch.route, source: 'remembered' };
      }
      if (!isInternalSessionKey(remembered.sessionKey)) {
        return {
          route: {
            sessionKey: remembered.sessionKey,
            agentId: remembered.agentId,
            replyChannel: remembered.replyChannel,
            replyTo: remembered.replyTo,
            replyAccountId: remembered.replyAccountId,
          },
          source: 'remembered',
        };
      }
      logger.warn(
        `Remembered route has internal session_key=${remembered.sessionKey} and no peer match; falling through to session-store scan.`
      );
    }
  }

  // 3. Scan recent conversation history.
  const best = selectBestRoute(snapshots, undefined, undefined, logger);
  if (best) {
    logger.info(
      `Route resolve from session store: session_key=${best.route.sessionKey}, agent_id=${best.route.agentId}, channel=${best.route.replyChannel ?? 'n/a'}, to=${best.route.replyTo ?? 'n/a'}, account=${best.route.replyAccountId ?? 'n/a'}, updated_at=${best.updatedAt}`
    );
    return { route: best.route, source: 'session-store' };
  }

  logger.warn(
    `Route resolve fell back to config default: session_key=${configRoute.sessionKey}, agent_id=${configRoute.agentId}`
  );
  return { route: configRoute, source: 'default' };
}
