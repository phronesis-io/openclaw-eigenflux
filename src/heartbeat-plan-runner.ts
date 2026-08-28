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

  async run(): Promise<boolean> {
    if (this.inFlight) {
      this.config.logger.debug('Heartbeat plan skipped because a run is already in flight');
      return false;
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
        return true;
      }
      if (result.kind === 'auth_required') {
        this.config.logger.warn('Heartbeat plan requires EigenFlux authentication');
        return false;
      }
      if (result.kind === 'not_installed') {
        this.config.logger.warn(`Heartbeat plan: eigenflux CLI not installed (bin=${result.bin})`);
        return false;
      }
      this.config.logger.warn(`Heartbeat plan failed: ${result.error.message}`);
      return false;
    } catch (error) {
      this.config.logger.warn(
        `Heartbeat plan crashed: ${error instanceof Error ? error.message : String(error)}`
      );
      return false;
    } finally {
      this.inFlight = false;
    }
  }
}
