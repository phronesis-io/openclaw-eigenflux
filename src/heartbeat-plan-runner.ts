import { execEigenflux } from './cli-executor';
import { Logger } from './logger';

export interface HeartbeatPlanRunnerConfig {
  eigenfluxBin: string;
  eigenfluxHome: string;
  logger: Logger;
}

export class EigenFluxHeartbeatPlanRunner {
  private inFlight = false;

  constructor(private readonly config: HeartbeatPlanRunnerConfig) {}

  /**
   * Return the verified plan for delivery to the Agent. Running the command for
   * its compatibility side effect alone is insufficient: the Agent must read
   * the plan to execute Commands → Feed → Attention → Communication → Publish
   * → Settings.
   */
  async run(): Promise<string | null> {
    if (this.inFlight) {
      this.config.logger.debug('Heartbeat plan skipped because a run is already in flight');
      return null;
    }

    this.inFlight = true;
    try {
      const result = await execEigenflux<string>(
        this.config.eigenfluxBin,
        [
          '--homedir',
          this.config.eigenfluxHome,
          'heartbeat',
          'plan',
          '--format',
          'agent',
        ],
        { logger: this.config.logger, parseJson: false }
      );

      if (result.kind === 'success') {
        if (typeof result.data === 'string' && result.data.trim()) {
          return result.data;
        }
        this.config.logger.warn('Heartbeat plan returned no Agent instructions');
        return null;
      }
      if (result.kind === 'auth_required') {
        this.config.logger.warn('Heartbeat plan requires EigenFlux authentication');
        return null;
      }
      if (result.kind === 'not_installed') {
        this.config.logger.warn(`Heartbeat plan: eigenflux CLI not installed (bin=${result.bin})`);
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
}
