import { execEigenflux } from './cli-executor';
import { Logger } from './logger';

export interface HeartbeatPlanRunnerConfig {
  eigenfluxBin: string;
  eigenfluxHome: string;
  serverName: string;
  logger: Logger;
  onAuthRequired?: (stderr?: string) => void | Promise<void>;
  onAuthUnavailable?: (error: Error) => void | Promise<void>;
}

export interface HeartbeatExecutionPlan {
  schema_version: 'eigenflux_heartbeat_plan.v1';
  cli_version?: string;
  cli_update?: {
    status: string;
    phase?: string;
    reason?: string;
    error_code?: string;
    next_check_at?: string;
    error?: string;
  };
  agent_prompt: string;
  wake_on_empty: boolean;
}

function isHeartbeatExecutionPlan(value: unknown): value is HeartbeatExecutionPlan {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const plan = value as Record<string, unknown>;
  return plan.schema_version === 'eigenflux_heartbeat_plan.v1' &&
    typeof plan.agent_prompt === 'string' && plan.agent_prompt.trim().length > 0 &&
    typeof plan.wake_on_empty === 'boolean';
}

export class EigenFluxHeartbeatPlanRunner {
  private inFlight = false;
  private lastUpdateDeferral?: string;

  constructor(private readonly config: HeartbeatPlanRunnerConfig) {}

  /** Fetch the current CLI instructions and delivery decision for this server. */
  async run(): Promise<HeartbeatExecutionPlan | null> {
    if (this.inFlight) {
      this.config.logger.debug('Heartbeat plan skipped because a run is already in flight');
      return null;
    }

    this.inFlight = true;
    try {
      const result = await execEigenflux<unknown>(
        this.config.eigenfluxBin,
        [
          '--homedir',
          this.config.eigenfluxHome,
          '--server',
          this.config.serverName,
          'heartbeat',
          'plan',
          '--format',
          'json',
        ],
        { logger: this.config.logger, timeout: 300_000 }
      );

      if (result.kind === 'success') {
        if (isHeartbeatExecutionPlan(result.data)) {
          this.logCLIUpdate(result.data.cli_update);
          return result.data;
        }
        this.config.logger.warn('Heartbeat plan returned an invalid execution contract; update the EigenFlux CLI');
        return null;
      }
      if (result.kind === 'auth_required') {
        this.config.logger.warn('Heartbeat plan requires EigenFlux authentication');
        await this.config.onAuthRequired?.(result.stderr);
        return null;
      }
      if (result.kind === 'not_installed') {
        this.config.logger.warn(`Heartbeat plan: eigenflux CLI not installed (bin=${result.bin})`);
        return null;
      }
      if (result.authenticationUnavailable) {
        this.config.logger.warn('Heartbeat plan authentication service is unavailable');
        await this.config.onAuthUnavailable?.(result.error);
        return null;
      }
      this.config.logger.warn(`Heartbeat plan failed: ${result.error.message}`);
      return null;
    } catch (error) {
      this.config.logger.warn(
        `Heartbeat plan crashed: ${error instanceof Error ? error.message : String(error)}`
      );
      return null;
    } finally {
      this.inFlight = false;
    }
  }

  private logCLIUpdate(update: HeartbeatExecutionPlan['cli_update']): void {
    if (!update || typeof update !== 'object' || typeof update.status !== 'string') return;
    const details = {
      server: this.config.serverName,
      status: update.status,
      ...(typeof update.phase === 'string' ? { phase: update.phase } : {}),
      ...(typeof update.reason === 'string' ? { reason: update.reason } : {}),
      ...(typeof update.next_check_at === 'string' ? { next_check_at: update.next_check_at } : {}),
      ...(typeof update.error_code === 'string' ? { error_code: update.error_code } : {}),
    };
    const summary = JSON.stringify(details);
    if (['deferred', 'skipped', 'busy'].includes(update.status)) {
      if (summary !== this.lastUpdateDeferral) this.config.logger.info(`CLI auto-update: ${summary}`);
      this.lastUpdateDeferral = summary;
      return;
    }
    this.lastUpdateDeferral = undefined;
    if (update.status === 'failed' || update.status === 'unconfigured') {
      this.config.logger.warn(`CLI auto-update: ${summary}`);
    }
  }
}
