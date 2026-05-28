import { randomUUID } from 'node:crypto';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { type NotificationRouteOverrides } from './config';
import { Logger } from './logger';
import {
  isInternalSessionKey,
  resolveNotificationRoute,
  type NotificationRouteConfig,
  type NotificationRouteSource,
  type ResolvedNotificationRoute,
  type ResolvedNotificationRouteResult,
} from './notification-route-resolver';
import { writeStoredNotificationRoute, type PluginRuntimeStore } from './session-route-memory';

/**
 * Typed subset of the OpenClaw runtime API used by the notifier.
 */
type EigenFluxRuntimeApi = {
  subagent?: {
    run?: (params: {
      sessionKey: string;
      message: string;
      deliver?: boolean;
      idempotencyKey?: string;
    }) => Promise<{ runId: string }>;
    waitForRun?: (params: {
      runId: string;
      timeoutMs?: number;
    }) => Promise<{ status: 'ok' | 'error' | 'timeout'; error?: string }>;
    deleteSession?: (params: {
      sessionKey: string;
      deleteTranscript?: boolean;
    }) => Promise<void>;
  };
  system?: {
    enqueueSystemEvent?: (
      text: string,
      options: {
        sessionKey: string;
        deliveryContext?: {
          channel?: string;
          to?: string;
          accountId?: string;
        };
      }
    ) => boolean;
    requestHeartbeatNow?: (options: {
      reason?: string;
      coalesceMs?: number;
      agentId?: string;
      sessionKey?: string;
    }) => void;
    runCommandWithTimeout?: CommandRunner;
  };
};

const COMMAND_TIMEOUT_MS = 15000;
// deliver: true runs the full agent loop (LLM + reply + channel send), which can
// take well over a minute on long feed payloads. 3 minutes gives agents plenty
// of room to complete while still bounding a genuinely stuck run.
const SUBAGENT_WAIT_TIMEOUT_MS = 180_000;
const HEARTBEAT_REASON = 'plugin:eigenflux';

export type EigenFluxNotifierConfig = {
  store?: PluginRuntimeStore;
  eigenfluxBin?: string;
  serverName?: string;
  sessionKey: string;
  agentId: string;
  replyChannel?: string;
  replyTo?: string;
  replyAccountId?: string;
  openclawCliBin: string;
  sessionStorePath?: string;
  routeOverrides?: NotificationRouteOverrides;
};

export type DeliverOptions = {
  /**
   * When set, deliver to a one-shot session derived from this prefix
   * (a random suffix is appended to prevent context accumulation).
   * The session is automatically deleted after delivery completes.
   * Skips route persistence and stale-route re-resolve fallback.
   * Typical use: `eigenflux:feed:<serverName>` for isolated feed processing.
   */
  targetSessionKey?: string;
};

type CommandRunner = (
  argv: string[],
  options: { timeoutMs: number }
) => Promise<{ code: number | null; stdout?: string; stderr?: string }>;

type NotifyAttemptResult =
  | {
      ok: true;
      mode: string;
      sessionKey?: string;
      runId?: string;
      detail?: string;
    }
  | {
      ok: false;
      mode: string;
      error: string;
    };

export class EigenFluxNotifier {
  private readonly api: OpenClawPluginApi;
  private readonly logger: Logger;
  private readonly config: EigenFluxNotifierConfig;
  private readonly pendingCleanups: Promise<void>[] = [];

  constructor(api: OpenClawPluginApi, logger: Logger, config: EigenFluxNotifierConfig) {
    this.api = api;
    this.logger = logger;
    this.config = config;
  }

  private get runtime(): EigenFluxRuntimeApi {
    return (this.api.runtime ?? {}) as EigenFluxRuntimeApi;
  }

  async deliver(message: string, options?: DeliverOptions): Promise<boolean> {
    const targetKey = options?.targetSessionKey;

    // When a target session prefix is provided, generate a one-shot session key
    // (random suffix ensures no context accumulation across heartbeat cycles),
    // skip full route resolution, and clean up the session after delivery.
    if (targetKey) {
      // Sweep any pending cleanups from previous deliveries before starting a new one.
      // This prevents orphan sessions from accumulating if deleteSession was slow.
      await this.drainPendingCleanups();

      // Resolve the delivery target (channel/to/accountId) from the standard route,
      // then override the sessionKey with a one-shot key to avoid context accumulation.
      // Without this, the one-shot session has no delivery context and OpenClaw can't
      // route the agent's reply to the correct channel (e.g. Feishu "requires target").
      const baseRoute = await this.resolveRoute();

      const sessionKey = `${targetKey}:${Date.now()}-${randomUUID().slice(0, 8)}`;
      const route: ResolvedNotificationRoute = {
        sessionKey,
        agentId: baseRoute.route.agentId,
        ...(baseRoute.route.replyChannel && { replyChannel: baseRoute.route.replyChannel }),
        ...(baseRoute.route.replyTo && { replyTo: baseRoute.route.replyTo }),
        ...(baseRoute.route.replyAccountId && { replyAccountId: baseRoute.route.replyAccountId }),
      };
      this.logger.info(
        `Delivery route resolved: source=targeted-oneshot, ${formatRouteForLog(route)}, message_preview=${previewMessage(message)}`
      );

      // Targeted delivery uses only subagent and command-agent transports.
      // Heartbeat fallbacks are excluded because they re-resolve to the main
      // DM session, which would break session isolation.
      const result = await this.attemptDelivery(message, route, { skipHeartbeat: true });
      if (result.result.ok) {
        this.logDispatch(result.result);
      } else {
        this.logger.error(`Failed to deliver notification to targeted session: ${result.errors.join(' | ')}`);
      }

      // Fire-and-forget: queue cleanup so it doesn't block the next delivery.
      // Pending cleanups are drained at the start of the next delivery and on stop().
      this.enqueueCleanup(sessionKey);

      return result.result.ok;
    }

    // Standard delivery: resolve route, attempt delivery, remember on success.
    const initial = await this.resolveRoute();
    this.logger.info(
      `Delivery route resolved: source=${initial.source}, ${formatRouteForLog(initial.route)}, message_preview=${previewMessage(message)}`
    );

    const firstAttempt = await this.attemptDelivery(message, initial.route);
    if (firstAttempt.result.ok) {
      await this.rememberRouteIfChanged(firstAttempt.finalRoute, initial.source);
      this.logDispatch(firstAttempt.result);
      return true;
    }

    // If every transport failed with a remembered route, it may be stale.
    // Re-resolve fresh (skipping remembered), then retry the transport chain once.
    if (initial.source === 'remembered') {
      this.logger.warn(
        `All transports failed with remembered route; re-resolving without remembered config.`
      );
      const fallback = await this.resolveRoute({ ignoreRemembered: true });
      if (
        fallback.route.sessionKey !== initial.route.sessionKey ||
        fallback.route.replyTo !== initial.route.replyTo ||
        fallback.route.replyChannel !== initial.route.replyChannel
      ) {
        this.logger.info(
          `Retrying delivery with fresh route: source=${fallback.source}, ${formatRouteForLog(fallback.route)}`
        );
        const retry = await this.attemptDelivery(message, fallback.route);
        if (retry.result.ok) {
          await this.rememberRouteIfChanged(retry.finalRoute, fallback.source);
          this.logDispatch(retry.result);
          return true;
        }
        this.logger.error(
          `Failed to deliver notification after fresh re-resolve: ${retry.errors.join(' | ')}`
        );
        return false;
      }
      this.logger.warn('Fresh re-resolve produced the same route; skipping retry.');
    }

    this.logger.error(`Failed to deliver notification: ${firstAttempt.errors.join(' | ')}`);
    return false;
  }

  private async attemptDelivery(
    message: string,
    route: ResolvedNotificationRoute,
    options: { skipHeartbeat?: boolean } = {}
  ): Promise<{
    result: NotifyAttemptResult;
    finalRoute: ResolvedNotificationRoute;
    errors: string[];
  }> {
    const attempts: Array<() => Promise<NotifyAttemptResult>> = [
      () => this.tryNotifyViaRuntimeSubagent(message, route),
      () => this.tryNotifyViaRuntimeCommandAgent(message, route),
    ];

    if (!options.skipHeartbeat) {
      attempts.push(
        () => this.tryNotifyViaRuntimeHeartbeat(message, route),
        () => this.tryNotifyViaRuntimeCommandHeartbeat(message),
      );
    }

    const errors: string[] = [];
    for (const attempt of attempts) {
      const result = await attempt();
      if (result.ok) {
        const finalRoute: ResolvedNotificationRoute = {
          sessionKey: result.sessionKey ?? route.sessionKey,
          agentId: route.agentId,
          replyChannel: route.replyChannel,
          replyTo: route.replyTo,
          replyAccountId: route.replyAccountId,
        };
        return { result, finalRoute, errors };
      }
      this.logger.warn(
        `Notification attempt failed: mode=${result.mode}, ${formatRouteForLog(route)}, error=${result.error}`
      );
      errors.push(`${result.mode}: ${result.error}`);
    }
    return {
      result: { ok: false, mode: 'all', error: errors.join(' | ') },
      finalRoute: route,
      errors,
    };
  }

  private async tryNotifyViaRuntimeSubagent(
    message: string,
    route: ResolvedNotificationRoute
  ): Promise<NotifyAttemptResult> {
    const runtimeSubagent = this.runtime.subagent;

    if (!runtimeSubagent || typeof runtimeSubagent.run !== 'function') {
      return {
        ok: false,
        mode: 'runtime.subagent',
        error: 'runtime.subagent.run is unavailable',
      };
    }

    try {
      this.logger.info(
        `Attempting runtime.subagent delivery: ${formatRouteForLog(route)}, deliver=true`
      );
      const { runId } = await runtimeSubagent.run({
        sessionKey: route.sessionKey,
        message,
        deliver: true,
        idempotencyKey: randomUUID(),
      });

      // run() only enqueues; wait long enough for the full agent loop (LLM +
      // reply + channel send) to complete so we can surface real errors. A
      // waitForRun timeout here means "still running" — treat it as success
      // and let the subagent finish asynchronously, since retrying via CLI
      // would re-run the same agent loop and cause duplicate deliveries.
      if (typeof runtimeSubagent.waitForRun === 'function') {
        const waited = await runtimeSubagent.waitForRun({
          runId,
          timeoutMs: SUBAGENT_WAIT_TIMEOUT_MS,
        });
        if (waited.status === 'error') {
          return {
            ok: false,
            mode: 'runtime.subagent',
            error: `subagent run error${waited.error ? `: ${waited.error}` : ''}`,
          };
        }
      }

      return {
        ok: true,
        mode: 'runtime.subagent',
        sessionKey: route.sessionKey,
        runId,
      };
    } catch (error) {
      return {
        ok: false,
        mode: 'runtime.subagent',
        error: formatError(error),
      };
    }
  }

  private async tryNotifyViaRuntimeCommandAgent(
    message: string,
    route: ResolvedNotificationRoute
  ): Promise<NotifyAttemptResult> {
    return this.runRuntimeCommand(
      'runtime.command.agent',
      this.buildAgentCliArgs(message, route),
      route
    );
  }

  private async tryNotifyViaRuntimeHeartbeat(
    message: string,
    route: ResolvedNotificationRoute
  ): Promise<NotifyAttemptResult> {
    const runtimeSystem = this.runtime.system;

    if (
      !runtimeSystem ||
      typeof runtimeSystem.enqueueSystemEvent !== 'function' ||
      typeof runtimeSystem.requestHeartbeatNow !== 'function'
    ) {
      return {
        ok: false,
        mode: 'runtime.system.heartbeat',
        error: 'runtime.system heartbeat APIs are unavailable',
      };
    }

    try {
      const deliveryContext = this.resolveHeartbeatDeliveryContext(route);
      this.logger.info(
        `Attempting runtime.system.heartbeat delivery: ${formatRouteForLog(route)}, delivery_context=${formatDeliveryContextForLog(deliveryContext)}`
      );
      const enqueued = runtimeSystem.enqueueSystemEvent(message, {
        sessionKey: route.sessionKey,
        ...(deliveryContext ? { deliveryContext } : {}),
      });
      runtimeSystem.requestHeartbeatNow({
        reason: HEARTBEAT_REASON,
        coalesceMs: 0,
        agentId: route.agentId,
        sessionKey: route.sessionKey,
      });

      return {
        ok: true,
        mode: 'runtime.system.heartbeat',
        sessionKey: route.sessionKey,
        detail: enqueued ? 'enqueued' : 'duplicate-enqueued',
      };
    } catch (error) {
      return {
        ok: false,
        mode: 'runtime.system.heartbeat',
        error: formatError(error),
      };
    }
  }

  private async tryNotifyViaRuntimeCommandHeartbeat(message: string): Promise<NotifyAttemptResult> {
    const { route } = await this.resolveRoute();
    return this.runRuntimeCommand(
      'runtime.command.heartbeat',
      this.buildHeartbeatCliArgs(message),
      route
    );
  }

  private async runRuntimeCommand(
    mode: string,
    argv: string[],
    route: ResolvedNotificationRoute
  ): Promise<NotifyAttemptResult> {
    const runtimeCommand = this.runtime.system?.runCommandWithTimeout;

    if (typeof runtimeCommand !== 'function') {
      return {
        ok: false,
        mode,
        error: 'runtime.system.runCommandWithTimeout is unavailable',
      };
    }

    try {
      this.logger.info(
        `Attempting ${mode} delivery: ${formatRouteForLog(route)}, argv=${formatCommandArgsForLog(argv)}`
      );
      const result = await runtimeCommand(argv, { timeoutMs: COMMAND_TIMEOUT_MS });
      if (result.code === 0) {
        return {
          ok: true,
          mode,
          sessionKey: route.sessionKey,
        };
      }

      return {
        ok: false,
        mode,
        error: `${formatCommandFailure(result)} (argv=${formatCommandArgsForLog(argv)})`,
      };
    } catch (error) {
      return {
        ok: false,
        mode,
        error: formatError(error),
      };
    }
  }

  private buildAgentCliArgs(message: string, route: ResolvedNotificationRoute): string[] {
    const args = [
      this.config.openclawCliBin,
      'agent',
      '--message',
      message,
      '--agent',
      route.agentId,
      '--deliver',
    ];

    if (route.replyChannel) {
      args.push('--reply-channel', route.replyChannel);
    }
    if (route.replyTo) {
      args.push('--reply-to', route.replyTo);
    }
    if (route.replyAccountId) {
      args.push('--reply-account', route.replyAccountId);
    }

    return args;
  }

  private buildHeartbeatCliArgs(message: string): string[] {
    return [
      this.config.openclawCliBin,
      'system',
      'event',
      '--text',
      message,
      '--mode',
      'now',
    ];
  }

  private resolveHeartbeatDeliveryContext(
    route: ResolvedNotificationRoute
  ):
    | {
        channel?: string;
        to?: string;
        accountId?: string;
      }
    | undefined {
    if (!route.replyChannel && !route.replyTo && !route.replyAccountId) {
      return undefined;
    }

    return {
      ...(route.replyChannel ? { channel: route.replyChannel } : {}),
      ...(route.replyTo ? { to: route.replyTo } : {}),
      ...(route.replyAccountId ? { accountId: route.replyAccountId } : {}),
    };
  }

  private async resolveRoute(
    options: { ignoreRemembered?: boolean } = {}
  ): Promise<ResolvedNotificationRouteResult> {
    return resolveNotificationRoute(
      this.config as NotificationRouteConfig,
      this.logger,
      options
    );
  }

  /**
   * Persist the successful route to the eigenflux CLI config unless it came from
   * the remembered config already (no-op when unchanged).
   */
  private async rememberRouteIfChanged(
    route: ResolvedNotificationRoute,
    source: NotificationRouteSource
  ): Promise<void> {
    if (!route.sessionKey || !route.agentId) {
      return;
    }
    if (isInternalSessionKey(route.sessionKey)) {
      return;
    }
    if (!route.replyChannel || !route.replyTo) {
      return;
    }
    if (source === 'remembered') {
      this.logger.debug(
        `Skipping remembered-route write; route came from config (session_key=${route.sessionKey})`
      );
      return;
    }
    await writeStoredNotificationRoute(
      this.config.store,
      this.config.serverName,
      route,
      this.logger
    );
  }

  /**
   * Best-effort cleanup of a one-shot session. Failures are logged but do not
   * propagate — the session may already have been cleaned up by the runtime.
   */
  private async tryDeleteSession(sessionKey: string): Promise<void> {
    const deleteSession = this.runtime.subagent?.deleteSession;
    if (typeof deleteSession !== 'function') {
      this.logger.debug(`deleteSession unavailable; skipping cleanup for session_key=${sessionKey}`);
      return;
    }
    try {
      await deleteSession({ sessionKey, deleteTranscript: true });
      this.logger.info(`One-shot session cleaned up: session_key=${sessionKey}`);
    } catch (error) {
      this.logger.warn(`Failed to clean up one-shot session session_key=${sessionKey}: ${formatError(error)}`);
    }
  }

  /** Queue a session cleanup as fire-and-forget (non-blocking). */
  private enqueueCleanup(sessionKey: string): void {
    const cleanup = this.tryDeleteSession(sessionKey);
    this.pendingCleanups.push(cleanup);
    cleanup.finally(() => {
      const idx = this.pendingCleanups.indexOf(cleanup);
      if (idx >= 0) this.pendingCleanups.splice(idx, 1);
    });
  }

  /** Await all pending session cleanups. Called before new delivery and on stop(). */
  async drainPendingCleanups(): Promise<void> {
    if (this.pendingCleanups.length === 0) return;
    this.logger.debug(`Draining ${this.pendingCleanups.length} pending session cleanup(s)`);
    await Promise.allSettled([...this.pendingCleanups]);
  }

  private logDispatch(result: Extract<NotifyAttemptResult, { ok: true }>): void {
    const details = [
      `mode=${result.mode}`,
      result.sessionKey ? `session_key=${result.sessionKey}` : null,
      result.runId ? `run_id=${result.runId}` : null,
      result.detail ? `detail=${result.detail}` : null,
    ]
      .filter(Boolean)
      .join(', ');
    this.logger.info(`Notification dispatched: ${details}`);
  }
}

function formatCommandFailure(result: {
  code: number | null;
  stdout?: string;
  stderr?: string;
}): string {
  return (
    result.stderr?.trim() ||
    result.stdout?.trim() ||
    `command exited with ${result.code ?? 'unknown'}`
  );
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}

function formatRouteForLog(route: ResolvedNotificationRoute): string {
  return [
    `session_key=${route.sessionKey}`,
    `agent_id=${route.agentId}`,
    `channel=${route.replyChannel ?? 'n/a'}`,
    `to=${route.replyTo ?? 'n/a'}`,
    `account=${route.replyAccountId ?? 'n/a'}`,
  ].join(', ');
}

function formatDeliveryContextForLog(
  deliveryContext:
    | {
        channel?: string;
        to?: string;
        accountId?: string;
      }
    | undefined
): string {
  if (!deliveryContext) {
    return 'none';
  }
  return [
    `channel=${deliveryContext.channel ?? 'n/a'}`,
    `to=${deliveryContext.to ?? 'n/a'}`,
    `account=${deliveryContext.accountId ?? 'n/a'}`,
  ].join(', ');
}

function previewMessage(message: string, maxLength = 120): string {
  const singleLine = message.replace(/\s+/gu, ' ').trim();
  if (singleLine.length <= maxLength) {
    return JSON.stringify(singleLine);
  }
  return JSON.stringify(`${singleLine.slice(0, maxLength - 3)}...`);
}

function formatCommandArgsForLog(argv: string[]): string {
  const sanitized = [...argv];
  for (let index = 0; index < sanitized.length; index += 1) {
    if (sanitized[index] === '--message' || sanitized[index] === '--text') {
      if (typeof sanitized[index + 1] === 'string') {
        sanitized[index + 1] = `<len:${sanitized[index + 1].length}>`;
      }
    }
  }
  return JSON.stringify(sanitized);
}
