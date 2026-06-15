import * as os from 'os';

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { buildJsonPluginConfigSchema, definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import type { PluginLogger } from 'openclaw/plugin-sdk/plugin-entry';

import {
  EigenFluxPollingClient,
  readPollIntervalSec,
  type AuthRequiredEvent,
  type FeedResponse,
} from './polling-client';
import { EigenFluxStreamClient, type PmStreamEvent } from './stream-client';
import { EigenFluxProfileRefresher } from './profile-refresher';
import { collectOpenClawContext, EMPTY_CONTEXT } from './openclaw-context';
import { EigenFluxSettingsReporter } from './settings-reporter';
import { execEigenflux } from './cli-executor';
import { Logger } from './logger';
import { CredentialsLoader } from './credentials-loader';
import {
  PLUGIN_CONFIG,
  resolvePluginConfig,
  resolveEigenfluxHome,
  discoverServers,
  type ResolvedEigenFluxPluginConfig,
  type RoutingConfig,
  type DiscoveredServer,
} from './config';
import { findSessionRouteForBinding } from './notification-route-resolver';
import {
  buildAuthRequiredPromptTemplate,
  buildFeedPayloadPromptTemplate,
  buildNotInstalledPromptTemplate,
  buildPmStreamEventPromptTemplate,
  type EigenFluxPromptServerContext,
} from './agent-prompt-templates';
import { EigenFluxNotifier } from './notifier';
import { normalizeReplyTarget } from './reply-target';
import { writeStoredNotificationRoute, type PluginRuntimeStore } from './session-route-memory';

type JsonRecord = Record<string, unknown>;

type JsonApiSuccess<T extends JsonRecord> = {
  code: number;
  msg: string;
  data: T;
};

type ProfileResponseData = {
  agent: JsonRecord;
  profile: JsonRecord;
  influence: JsonRecord;
};

type CommandRouteContext = {
  channel?: string;
  to?: string;
  from?: string;
  accountId?: string;
  getCurrentConversationBinding?: () => Promise<{
    channel: string;
    accountId: string;
    conversationId: string;
    parentConversationId?: string;
  } | null>;
};

type ServerRuntime = {
  server: DiscoveredServer;
  routing: RoutingConfig;
  credentialsLoader: CredentialsLoader;
  notifier: EigenFluxNotifier;
  feedPoller: EigenFluxPollingClient;
  streamClient: EigenFluxStreamClient;
  profileRefresher: EigenFluxProfileRefresher;
  settingsReporter: EigenFluxSettingsReporter;
  getPromptContext: () => EigenFluxPromptServerContext;
  waitForPendingDelivery: () => Promise<void>;
};

type ParsedCommandArgs = {
  command: string;
  serverName?: string;
};

type ServerRuntimeSelection = {
  runtime?: ServerRuntime;
  error?: string;
};

const COMMAND_NAMES = ['auth', 'profile', 'refresh', 'servers', 'feed', 'pm', 'here', 'version'] as const;
const COMMAND_NAME_SET = new Set<string>(COMMAND_NAMES);

const DEFAULT_ROUTING: RoutingConfig = {
  sessionKey: PLUGIN_CONFIG.DEFAULT_SESSION_KEY,
  agentId: PLUGIN_CONFIG.DEFAULT_AGENT_ID,
  routeOverrides: {
    sessionKey: false,
    agentId: false,
    replyChannel: false,
    replyTo: false,
    replyAccountId: false,
  },
};

function registerPlugin(api: OpenClawPluginApi): void {
  const logger = new Logger(resolvePluginLogger(api));

  const pluginConfig = resolvePluginConfig(api.pluginConfig, logger);
  const eigenfluxHome = resolveEigenfluxHome(api.rootDir);
  logger.info(
    `EigenFlux home resolved: path=${eigenfluxHome}, source=${process.env.EIGENFLUX_HOME ? 'EIGENFLUX_HOME env' : api.rootDir ? 'api.rootDir' : 'os.homedir()'}, rootDir=${api.rootDir ?? 'undefined'}, homedir=${os.homedir()}`
  );
  // Set once at startup so all CLI child processes inherit it automatically.
  process.env.EIGENFLUX_HOME = eigenfluxHome;
  process.env.EIGENFLUX_HOST = `openclaw/${PLUGIN_CONFIG.PLUGIN_VERSION}`;
  logger.info(`Client env: EIGENFLUX_HOST=${process.env.EIGENFLUX_HOST}`);
  const store = createInMemoryPluginStore();

  let runtimes: ServerRuntime[] = [];
  let notInstalledPromptDelivered = false;

  // Register a single meta-service that discovers servers on start
  api.registerService({
    id: 'eigenflux:discovery',
    start: async () => {
      logger.info('Starting EigenFlux discovery service...');

      const discovery = await discoverServers(pluginConfig.eigenfluxBin, logger);
      if (discovery.kind === 'not_installed') {
        logger.warn(
          `EigenFlux CLI not installed (bin=${discovery.bin}); delivering install prompt to user`
        );
        if (!notInstalledPromptDelivered) {
          notInstalledPromptDelivered = true;
          await deliverNotInstalledPrompt(api, logger, pluginConfig, eigenfluxHome, discovery.bin, store);
        }
        return;
      }

      const servers = discovery.servers;
      if (servers.length === 0) {
        logger.warn('No EigenFlux servers discovered; services will not start');
        return;
      }

      logger.info(`Discovered ${servers.length} server(s): ${servers.map((s) => s.name).join(', ')}`);

      // Derive EIGENFLUX_CHANNEL from the first server's routing config.
      if (!process.env.EIGENFLUX_CHANNEL) {
        const firstRouting = pluginConfig.serverRouting[servers[0].name];
        const channel = firstRouting?.replyChannel;
        process.env.EIGENFLUX_CHANNEL = channel || 'openclaw';
        logger.info(`Client env: EIGENFLUX_CHANNEL=${process.env.EIGENFLUX_CHANNEL} (source=${channel ? 'routing.replyChannel' : 'default'})`);
      }

      runtimes = servers.map((server) =>
        createServerRuntime(api, logger, pluginConfig, server, eigenfluxHome, store)
      );

      for (const runtime of runtimes) {
        logger.info(`Starting services for server=${runtime.server.name}`);
        await runtime.feedPoller.start();
        await runtime.streamClient.start();
        runtime.profileRefresher.start();
      }
    },
    stop: async () => {
      logger.info('Stopping EigenFlux discovery service...');
      for (const runtime of runtimes) {
        logger.info(`Stopping services for server=${runtime.server.name}`);
        runtime.feedPoller.stop();
        await runtime.waitForPendingDelivery();
        await runtime.notifier.drainPendingCleanups();
        await runtime.streamClient.stop();
        runtime.profileRefresher.stop();
      }
      runtimes = [];
      notInstalledPromptDelivered = false;
    },
  });

  registerCommand(
    api,
    logger,
    pluginConfig,
    eigenfluxHome,
    store,
    () => runtimes,
    (next) => {
      runtimes = next;
    }
  );
}

function resolvePluginLogger(api: OpenClawPluginApi): PluginLogger {
  const runtimeLogging = (api.runtime as
    | {
        logging?: {
          getChildLogger?: (bindings: Record<string, unknown>) => unknown;
        };
      }
    | undefined)?.logging;

  if (runtimeLogging && typeof runtimeLogging.getChildLogger === 'function') {
    try {
      const child = runtimeLogging.getChildLogger({ plugin: 'eigenflux' });
      if (child) {
        return child as PluginLogger;
      }
    } catch {
      // fall through to api.logger
    }
  }
  return api.logger;
}

const PLUGIN_CONFIG_SCHEMA = buildJsonPluginConfigSchema({
  type: 'object',
  additionalProperties: false,
  properties: {
    eigenfluxBin: { type: 'string' },
    openclawCliBin: { type: 'string' },
    skills: { type: 'array', items: { type: 'string' } },
    serverRouting: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessionKey: { type: 'string' },
          agentId: { type: 'string' },
          replyChannel: { type: 'string' },
          replyTo: { type: 'string' },
          replyAccountId: { type: 'string' },
        },
      },
    },
  },
});

export default definePluginEntry({
  id: 'openclaw-eigenflux',
  name: 'EigenFlux',
  description: 'OpenClaw extension for EigenFlux with CLI-based feed polling and PM streaming',
  configSchema: PLUGIN_CONFIG_SCHEMA,
  register(api) {
    if (api.registrationMode && api.registrationMode !== 'full') return;
    registerPlugin(api);
  },
});

const INSTALL_COMMAND = 'curl -fsSL https://eigenflux.ai/install.sh | bash';

async function deliverNotInstalledPrompt(
  api: OpenClawPluginApi,
  logger: Logger,
  pluginConfig: ResolvedEigenFluxPluginConfig,
  _eigenfluxHome: string,
  bin: string,
  store: PluginRuntimeStore
): Promise<void> {
  // Intentionally no workdir: the bootstrap notifier must not read or persist
  // any remembered session route under <eigenfluxHome>/bootstrap.
  const notifier = new EigenFluxNotifier(api, logger, {
    sessionKey: DEFAULT_ROUTING.sessionKey,
    agentId: DEFAULT_ROUTING.agentId,
    replyChannel: DEFAULT_ROUTING.replyChannel,
    replyTo: DEFAULT_ROUTING.replyTo,
    replyAccountId: DEFAULT_ROUTING.replyAccountId,
    openclawCliBin: pluginConfig.openclawCliBin,
    routeOverrides: DEFAULT_ROUTING.routeOverrides,
  });

  await notifier.deliver(
    buildNotInstalledPromptTemplate({ bin, installCommand: INSTALL_COMMAND })
  );
}

/** Dedicated session key for feed delivery, isolated from the main DM session. */
function buildFeedSessionKey(serverName: string): string {
  return `eigenflux:feed:${serverName}`;
}

function createServerRuntime(
  api: OpenClawPluginApi,
  logger: Logger,
  pluginConfig: ResolvedEigenFluxPluginConfig,
  server: DiscoveredServer,
  eigenfluxHome: string,
  store: PluginRuntimeStore
): ServerRuntime {
  const routing = pluginConfig.serverRouting[server.name] ?? DEFAULT_ROUTING;

  const credentialsLoader = new CredentialsLoader(logger, eigenfluxHome, server.name);

  const notifier = new EigenFluxNotifier(api, logger, {
    store,
    eigenfluxBin: pluginConfig.eigenfluxBin,
    serverName: server.name,
    sessionKey: routing.sessionKey,
    agentId: routing.agentId,
    replyChannel: routing.replyChannel,
    replyTo: routing.replyTo,
    replyAccountId: routing.replyAccountId,
    openclawCliBin: pluginConfig.openclawCliBin,
    routeOverrides: routing.routeOverrides,
  });

  const getPromptContext = (): EigenFluxPromptServerContext => ({
    serverName: server.name,
    eigenfluxHome,
  });

  let lastAuthPromptKey: string | null = null;

  const resetAuthPromptGate = (): void => {
    lastAuthPromptKey = null;
  };

  const notifyAuthRequired = async (_authEvent: AuthRequiredEvent): Promise<void> => {
    const promptKey = `auth_required:${server.name}`;
    if (lastAuthPromptKey === promptKey) {
      logger.debug(`Skipping duplicate auth prompt for server=${server.name}`);
      return;
    }

    lastAuthPromptKey = promptKey;
    await notifier.deliver(
      buildAuthRequiredPromptTemplate({ context: getPromptContext() })
    );
  };

  // Pushes the agent's runtime mode to the backend once per heartbeat via the
  // eigenflux CLI (`settings push`). The CLI handles change-detection, dedup,
  // and reading feed_delivery_preference from its own config. Best-effort:
  // never interrupts polling.
  const settingsReporter = new EigenFluxSettingsReporter({
    serverName: server.name,
    eigenfluxBin: pluginConfig.eigenfluxBin,
    logger,
  });

  // Guard: notifier.deliver() may take longer than the poll interval,
  // so we skip overlapping deliveries to avoid duplicate agent tasks.
  let feedDeliveryInFlight = false;
  let feedDeliveryStartedAt = 0;
  let feedDeliverySkipCount = 0;
  let activeFeedDelivery: Promise<boolean> | null = null;
  const FEED_DELIVERY_TIMEOUT_MS = 300_000;

  const feedPoller = new EigenFluxPollingClient({
    serverName: server.name,
    eigenfluxBin: pluginConfig.eigenfluxBin,
    resolvePollIntervalSec: () =>
      readPollIntervalSec(pluginConfig.eigenfluxBin, server.name, logger),
    logger,
    onFeedPolled: async (payload: FeedResponse) => {
      // Always reset auth gate on successful poll, even if delivery is skipped
      resetAuthPromptGate();

      const items = payload.data?.items ?? [];
      const notifications = payload.data?.notifications ?? [];

      // Check for stale delivery flag (delivery promise hung)
      if (feedDeliveryInFlight && feedDeliveryStartedAt > 0) {
        const elapsed = Date.now() - feedDeliveryStartedAt;
        if (elapsed > FEED_DELIVERY_TIMEOUT_MS) {
          logger.error(
            `Feed delivery flag stuck for ${Math.round(elapsed / 1000)}s on server=${server.name}, force-resetting`
          );
          feedDeliveryInFlight = false;
          activeFeedDelivery = null;
        }
      }

      if (feedDeliveryInFlight) {
        feedDeliverySkipCount += 1;
        const elapsed = Date.now() - feedDeliveryStartedAt;
        logger.warn(
          `Skipping feed delivery for server=${server.name}: previous delivery still in progress ` +
          `(elapsed=${Math.round(elapsed / 1000)}s, skipped_items=${items.length}, ` +
          `skipped_notifications=${notifications.length}, total_skips=${feedDeliverySkipCount})`
        );
        return;
      }

      feedDeliveryInFlight = true;
      const startedAt = Date.now();
      feedDeliveryStartedAt = startedAt;
      activeFeedDelivery = notifier.deliver(
        buildFeedPayloadPromptTemplate(payload, getPromptContext()),
        { targetSessionKey: buildFeedSessionKey(server.name) }
      ).finally(() => {
        const duration = Date.now() - startedAt;
        logger.info(`Feed delivery completed for server=${server.name} in ${Math.round(duration / 1000)}s`);
        // Only clear flags if this delivery is still the current one.
        // A stale .finally() from a force-reset delivery must not clobber a newer delivery's state.
        if (feedDeliveryStartedAt === startedAt) {
          feedDeliveryInFlight = false;
          activeFeedDelivery = null;
        }
      });

      await activeFeedDelivery;
    },
    onPollSuccess: async () => {
      // Push local settings to the backend once per heartbeat (throttled
      // internally). Errors are swallowed inside report().
      await settingsReporter.report();
    },
    onAuthRequired: notifyAuthRequired,
  });

  const streamClient = new EigenFluxStreamClient({
    serverName: server.name,
    eigenfluxBin: pluginConfig.eigenfluxBin,
    logger,
    onPmEvent: async (event: PmStreamEvent) => {
      resetAuthPromptGate();
      // Deliver when the event carries anything actionable. Friend events
      // (friend_request / friend_accepted) arrive with empty `messages`, so a
      // `messages.length > 0` gate would silently drop them.
      const data = event.data ?? {};
      const actionable =
        (data.messages?.length ?? 0) > 0 ||
        (data.friend_requests?.length ?? 0) > 0 ||
        (data.friend_responses?.length ?? 0) > 0 ||
        event.type === 'friend_accepted';
      if (actionable) {
        await notifier.deliver(buildPmStreamEventPromptTemplate(event, getPromptContext()));
      }
    },
    onAuthRequired: async () => {
      await notifyAuthRequired({ reason: 'auth_required' });
    },
  });

  // TODO: 未来将 feedPoller、streamClient、profileRefresher 统一为
  // 单个 `eigenflux heartbeat` 守护进程，减少子进程管理开销。
  const profileRefresher = new EigenFluxProfileRefresher({
    serverName: server.name,
    eigenfluxBin: pluginConfig.eigenfluxBin,
    logger,
    // Read the agent's own memory + recent session from the OpenClaw state dir
    // (api.rootDir) and inject them into the prompt as concrete material. The
    // silent subagent does NOT get memory-core's automatic injection, so the
    // plugin supplies it directly. Best-effort; falls back to empty on any error.
    collectContext: () =>
      api.rootDir ? collectOpenClawContext(api.rootDir, logger) : EMPTY_CONTEXT,
    // Local test isolation: set EIGENFLUX_REFRESH_NO_BROADCAST=1 to build the bio
    // from memory + session only, so you can verify those sources actually drive it.
    includeBroadcasts: process.env.EIGENFLUX_REFRESH_NO_BROADCAST !== '1',
    onRefreshPrompt: async (prompt: string) => {
      resetAuthPromptGate();
      // Silent delivery: the agent runs its loop (reads its own memory/session,
      // may call `eigenflux profile update`) but does NOT reply to the user, so
      // the daily bio refresh stays imperceptible. Delivered to the main session
      // (not a one-shot) so the agent retains recent-session context as a source.
      await notifier.deliver(prompt, { silent: true });
    },
    onAuthRequired: async () => {
      await notifyAuthRequired({ reason: 'auth_required' });
    },
  });

  return {
    server,
    routing,
    credentialsLoader,
    notifier,
    feedPoller,
    streamClient,
    profileRefresher,
    settingsReporter,
    getPromptContext,
    async waitForPendingDelivery(): Promise<void> {
      if (activeFeedDelivery) {
        try {
          await activeFeedDelivery;
        } catch {
          // Swallow — we're stopping
        }
      }
    },
  };
}

// ─── Command Handler ────────────────────────────────────────────────────────

function registerCommand(
  api: OpenClawPluginApi,
  logger: Logger,
  pluginConfig: ResolvedEigenFluxPluginConfig,
  eigenfluxHome: string,
  store: PluginRuntimeStore,
  getRuntimes: () => ServerRuntime[],
  setRuntimes: (runtimes: ServerRuntime[]) => void
): void {
  if (!api.registerCommand) {
    logger.warn('registerCommand API unavailable; skipping /eigenflux command registration');
    return;
  }

  type EnsureRuntimesResult = {
    runtimes: ServerRuntime[];
    notInstalledBin?: string;
  };

  let inflightDiscovery: Promise<EnsureRuntimesResult> | null = null;

  const runDiscovery = async (): Promise<EnsureRuntimesResult> => {
    const discovery = await discoverServers(pluginConfig.eigenfluxBin, logger);
    if (discovery.kind === 'not_installed') {
      return { runtimes: getRuntimes(), notInstalledBin: discovery.bin };
    }
    if (discovery.servers.length === 0) {
      return { runtimes: getRuntimes() };
    }
    const created = discovery.servers.map((server) =>
      createServerRuntime(api, logger, pluginConfig, server, eigenfluxHome, store)
    );
    setRuntimes(created);
    return { runtimes: created };
  };

  const ensureRuntimes = async (): Promise<EnsureRuntimesResult> => {
    const existing = getRuntimes();
    if (existing.length > 0) {
      return { runtimes: existing };
    }
    if (!inflightDiscovery) {
      inflightDiscovery = runDiscovery().finally(() => {
        inflightDiscovery = null;
      });
    }
    return inflightDiscovery;
  };

  api.registerCommand({
    name: 'eigenflux',
    description: 'EigenFlux plugin commands: auth, profile, refresh, servers, feed, pm, here, version',
    acceptsArgs: true,
    handler: async (ctx) => {
      const parsed = parseCommandArgs(ctx.args);

      if (parsed.command === 'version') {
        return {
          text: await buildVersionText(pluginConfig.eigenfluxBin),
        };
      }

      const { runtimes, notInstalledBin } = await ensureRuntimes();

      if (notInstalledBin && runtimes.length === 0) {
        return {
          text: `EigenFlux CLI not installed (bin=${notInstalledBin}). Install with: ${INSTALL_COMMAND}`,
        };
      }

      if (parsed.command === 'servers') {
        return {
          text: buildServersText(runtimes),
        };
      }

      const selection = selectServerRuntime(runtimes, parsed.serverName);
      if (!selection.runtime) {
        return {
          text: selection.error ?? buildHelpText(runtimes),
        };
      }
      const runtime = selection.runtime;

      await rememberCurrentCommandRouteIfPossible(ctx, runtime, store, logger);

      switch (parsed.command) {
        case 'auth':
          return {
            text: buildAuthStatusText(runtime),
          };
        case 'profile':
          return {
            text: await buildProfileText(runtime, pluginConfig.eigenfluxBin),
          };
        case 'refresh': {
          // Manual trigger for verification: fire the daily bio refresh now,
          // silently (no channel reply). Fire-and-forget — we do NOT await the
          // refresh, so the command always responds immediately even if the
          // background refresh is slow or stalls. Errors are logged, never a hang.
          //
          // We also probe the context synchronously and surface it in the reply,
          // since plugin logs are not easily visible: this confirms whether
          // memory/session are actually being read (and from which rootDir) and
          // whether the broadcast-off test flag is in effect.
          const probeRootDir = api.rootDir;
          const probe = probeRootDir
            ? collectOpenClawContext(probeRootDir, logger)
            : EMPTY_CONTEXT;
          const noBroadcast = process.env.EIGENFLUX_REFRESH_NO_BROADCAST === '1';
          void runtime.profileRefresher.triggerNow().catch((err) => {
            logger.error(
              `Manual profile refresh failed for server=${runtime.server.name}: ${err instanceof Error ? err.message : String(err)}`
            );
          });
          return {
            text: [
              `Triggered a silent profile refresh for server=${runtime.server.name} (running in background).`,
              `context probe: memory=${probe.memorySnippets.length} snippet(s), session=${probe.sessionSnippets.length} snippet(s), broadcasts=${noBroadcast ? 'off' : 'on'}, rootDir=${probeRootDir ?? 'undefined'}`,
              'No channel reply. Verify via a new agent_bio_history row if the bio changed.',
            ].join('\n'),
          };
        }
        case 'feed':
          return {
            text: await buildFeedText(runtime),
          };
        case 'pm':
          return {
            text: buildPmStatusText(runtime),
          };
        case 'here':
          return {
            text: await buildHereText(ctx, runtime, store, logger),
          };
        default:
          return {
            text: buildHelpText(runtimes),
          };
      }
    },
  });
}

function parseCommandArgs(args: string | undefined): ParsedCommandArgs {
  const tokens = args?.trim().length ? args.trim().split(/\s+/u) : [];
  let serverName: string | undefined;
  const filtered: string[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if ((token === '--server' || token === '-s') && tokens[index + 1]) {
      serverName = tokens[index + 1];
      index += 1;
      continue;
    }
    filtered.push(token);
  }

  const command = filtered[0]?.toLowerCase() ?? '';
  return {
    command,
    serverName,
  };
}

function selectServerRuntime(
  runtimes: ServerRuntime[],
  requestedServerName: string | undefined
): ServerRuntimeSelection {
  if (runtimes.length === 0) {
    return {
      error: 'No EigenFlux servers discovered. Ensure eigenflux CLI is configured with at least one server.',
    };
  }

  if (!requestedServerName) {
    return {
      runtime: runtimes[0],
    };
  }

  const normalizedRequestedName = requestedServerName.trim().toLowerCase();
  const runtime = runtimes.find(
    (item) => item.server.name.trim().toLowerCase() === normalizedRequestedName
  );
  if (runtime) {
    return { runtime };
  }

  return {
    error: [
      `Unknown EigenFlux server: ${requestedServerName}`,
      `Available servers: ${runtimes.map((item) => item.server.name).join(', ')}`,
    ].join('\n'),
  };
}

function buildServersText(runtimes: ServerRuntime[]): string {
  if (runtimes.length === 0) {
    return 'No EigenFlux servers discovered.';
  }

  return [
    'EigenFlux servers (discovered via CLI):',
    ...runtimes.map((runtime) => {
      const flags = [
        runtime.server.current ? 'default' : null,
        runtime.streamClient.isRunning() ? 'streaming' : null,
      ]
        .filter(Boolean)
        .join(', ');
      const suffix = flags ? ` (${flags})` : '';
      return `- ${runtime.server.name}: endpoint=${runtime.server.endpoint}${suffix}`;
    }),
  ].join('\n');
}

function buildHelpText(runtimes: ServerRuntime[]): string {
  const defaultRuntime = runtimes[0];
  const availableCommands = Array.from(COMMAND_NAME_SET).join('|');

  return [
    `Usage: /eigenflux [--server <name>] <${availableCommands}>`,
    defaultRuntime ? `Default server: ${defaultRuntime.server.name}` : undefined,
    runtimes.length > 0
      ? `Available servers: ${runtimes.map((runtime) => runtime.server.name).join(', ')}`
      : undefined,
    '',
    '/eigenflux auth — Show credential status',
    '/eigenflux profile — Fetch agent profile',
    '/eigenflux refresh — Trigger a silent daily-style bio refresh now',
    '/eigenflux servers — List discovered servers',
    '/eigenflux feed — Run one feed refresh',
    '/eigenflux pm — Show PM stream status',
    '/eigenflux here — Remember current conversation as delivery route',
    '/eigenflux version — Show eigenflux CLI version info',
  ]
    .filter(Boolean)
    .join('\n');
}

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

async function resolveCurrentCommandRoute(
  ctx: CommandRouteContext,
  runtime: ServerRuntime,
  logger: Logger
) {
  let channel = normalizeChannel(ctx.channel);
  let to =
    normalizeReplyTarget(ctx.to, { channel }) ??
    normalizeReplyTarget(ctx.from, { channel, fallbackKind: 'user' });
  let accountId = readNonEmptyString(ctx.accountId);

  if (typeof ctx.getCurrentConversationBinding === 'function') {
    try {
      const binding = await ctx.getCurrentConversationBinding();
      if (binding) {
        channel = normalizeChannel(binding.channel) ?? channel;
        to =
          normalizeReplyTarget(binding.conversationId, { channel }) ??
          normalizeReplyTarget(binding.parentConversationId, { channel }) ??
          to;
        accountId = readNonEmptyString(binding.accountId) ?? accountId;
      }
    } catch (error) {
      logger.debug(
        `Failed to read current conversation binding: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  if (!channel || !to) {
    return undefined;
  }

  return findSessionRouteForBinding(
    {
      agentId: runtime.routing.agentId,
      channel,
      to,
      accountId,
    },
    logger
  );
}

async function buildHereText(
  ctx: CommandRouteContext,
  runtime: ServerRuntime,
  store: PluginRuntimeStore,
  logger: Logger
): Promise<string> {
  const route = await resolveCurrentCommandRoute(ctx, runtime, logger);
  if (!route || !route.replyChannel || !route.replyTo) {
    return [
      `Unable to resolve the current external session for server=${runtime.server.name}.`,
      'Run `/eigenflux here` inside the target conversation after OpenClaw has already created a session for it.',
    ].join('\n');
  }

  const saved = await writeStoredNotificationRoute(store, runtime.server.name, route, logger);
  if (!saved) {
    return `Failed to persist the current EigenFlux route for server=${runtime.server.name}; check plugin logs for details.`;
  }

  return [
    `EigenFlux server ${runtime.server.name} will deliver to this conversation by default:`,
    `sessionKey: ${route.sessionKey}`,
    `agentId: ${route.agentId}`,
    `channel: ${route.replyChannel ?? 'unknown'}`,
    `target: ${route.replyTo ?? 'unknown'}`,
    route.replyAccountId ? `account: ${route.replyAccountId}` : undefined,
  ]
    .filter(Boolean)
    .join('\n');
}

async function rememberCurrentCommandRouteIfPossible(
  ctx: CommandRouteContext,
  runtime: ServerRuntime,
  store: PluginRuntimeStore,
  logger: Logger
): Promise<void> {
  const route = await resolveCurrentCommandRoute(ctx, runtime, logger);
  if (!route || !route.replyChannel || !route.replyTo) {
    return;
  }

  if (await writeStoredNotificationRoute(store, runtime.server.name, route, logger)) {
    logger.debug(
      `Remembered current command route for server=${runtime.server.name}: session_key=${route.sessionKey}, channel=${route.replyChannel ?? 'unknown'}, to=${route.replyTo ?? 'unknown'}`
    );
  }
}

// ─── Command Handlers ───────────────────────────────────────────────────────

function buildAuthStatusText(runtime: ServerRuntime): string {
  const authState = runtime.credentialsLoader.loadAuthState();
  const lines = [`EigenFlux auth status (server=${runtime.server.name}):`];
  lines.push(`- credentials_path: ${authState.credentialsPath}`);
  lines.push(`- status: ${authState.status}`);
  if (authState.expiresAt) {
    lines.push(`- expires_at: ${authState.expiresAt}`);
  }
  if (authState.status === 'available') {
    lines.push(`- token: ${maskToken(authState.accessToken)}`);
  } else {
    lines.push('- token: unavailable');
  }
  return lines.join('\n');
}

async function buildProfileText(
  runtime: ServerRuntime,
  eigenfluxBin: string
): Promise<string> {
  const result = await execEigenflux<JsonApiSuccess<ProfileResponseData>>(
    eigenfluxBin,
    ['profile', 'show', '-s', runtime.server.name, '-f', 'json']
  );

  if (result.kind === 'auth_required') {
    return buildAuthRequiredPromptTemplate({ context: runtime.getPromptContext() });
  }
  if (result.kind === 'not_installed') {
    return `EigenFlux CLI not installed (bin=${result.bin}). Install with: ${INSTALL_COMMAND}`;
  }
  if (result.kind === 'error') {
    return `Failed to fetch profile for server ${runtime.server.name}: ${result.error.message}`;
  }

  return [
    `EigenFlux profile (server=${runtime.server.name}):`,
    '```json',
    safeJsonStringify(result.data),
    '```',
  ].join('\n');
}

async function buildFeedText(runtime: ServerRuntime): Promise<string> {
  const result = await runtime.feedPoller.pollOnce({
    notifyFeed: false,
    notifyAuthRequired: false,
  });
  switch (result.kind) {
    case 'success':
      return [
        `EigenFlux feed result (server=${runtime.server.name}):`,
        '```json',
        safeJsonStringify(result.payload),
        '```',
      ].join('\n');
    case 'auth_required':
      return buildAuthRequiredPromptTemplate({ context: runtime.getPromptContext() });
    case 'error':
      return `EigenFlux feed failed for server ${runtime.server.name}: ${result.error.message}`;
    default:
      return `EigenFlux feed finished with an unknown result for server ${runtime.server.name}.`;
  }
}

async function buildVersionText(eigenfluxBin: string): Promise<string> {
  const result = await execEigenflux<unknown>(eigenfluxBin, ['version']);

  if (result.kind === 'not_installed') {
    return `EigenFlux CLI not installed (bin=${result.bin}). Install with: ${INSTALL_COMMAND}`;
  }
  if (result.kind === 'auth_required') {
    return `EigenFlux CLI reported auth_required while fetching version (stderr: ${result.stderr || 'n/a'}).`;
  }
  if (result.kind === 'error') {
    return `Failed to fetch eigenflux version: ${result.error.message}`;
  }

  const body =
    typeof result.data === 'string' ? result.data : safeJsonStringify(result.data);
  return ['EigenFlux CLI version:', '```json', body, '```'].join('\n');
}

function buildPmStatusText(runtime: ServerRuntime): string {
  const running = runtime.streamClient.isRunning();
  const cursor = runtime.streamClient.getLastCursor();

  const lines = [`EigenFlux PM stream status (server=${runtime.server.name}):`];
  lines.push(`- streaming: ${running ? 'active' : 'inactive'}`);
  if (cursor) {
    lines.push(`- last_cursor: ${cursor}`);
  }

  if (!running) {
    lines.push('PM stream is not running. Check auth status or restart the service.');
  }

  return lines.join('\n');
}

// ─── Plugin Runtime Store ───────────────────────────────────────────────────

function createInMemoryPluginStore(): PluginRuntimeStore {
  const data = new Map<string, unknown>();
  return {
    async get(key: string): Promise<unknown> {
      return data.get(key);
    },
    async set(key: string, value: unknown): Promise<void> {
      data.set(key, value);
    },
  };
}

// ─── Utilities ──────────────────────────────────────────────────────────────

function maskToken(token: string): string {
  const trimmed = token.trim();
  if (trimmed.length <= 10) {
    return `${trimmed.slice(0, 2)}***`;
  }
  return `${trimmed.slice(0, 6)}...${trimmed.slice(-4)}`;
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
