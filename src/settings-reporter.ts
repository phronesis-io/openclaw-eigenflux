/**
 * Agent-side settings reporter for EigenFlux.
 *
 * Pushes the agent's local runtime mode to the backend on every heartbeat by
 * delegating to the eigenflux CLI:
 *
 *   eigenflux settings push --mode <plugin|skill> -s <server>
 *
 * The CLI owns everything else: it reads feed_delivery_preference from its
 * config, compares against the "last reported" marker it persists, only issues
 * the PUT /api/v1/agents/me/settings when something actually changed, and uses
 * its own credentials/base-URL. The plugin therefore stays thin — it only
 * supplies the runtime `mode` (which is only knowable at runtime) and triggers
 * the CLI once per poll cycle.
 *
 * Reporting is best-effort: any CLI failure is logged at warn/debug level and
 * never propagates, so it cannot interrupt the heartbeat/poll loop.
 */

import { execEigenflux } from './cli-executor';
import { Logger } from './logger';

export type AgentMode = 'plugin' | 'skill';

export interface SettingsReporterConfig {
  serverName: string;
  eigenfluxBin: string;
  logger: Logger;
  /** Injectable mode resolver for tests; defaults to env-based detection. */
  resolveMode?: () => AgentMode | undefined;
}

/**
 * Determine the agent runtime mode from environment signals set at plugin
 * startup (see index.ts):
 *   - EIGENFLUX_HOST  = "openclaw/<version>" for this OpenClaw plugin runtime.
 *   - EIGENFLUX_CHANNEL = replyChannel || "openclaw".
 *
 * This repository IS the OpenClaw plugin, so the host signal unambiguously
 * identifies it as "plugin" mode. We still inspect EIGENFLUX_CHANNEL first so a
 * future skill-hosted channel ("skill") maps correctly. When no usable signal
 * is available we return undefined and the caller omits the `--mode` flag
 * rather than guessing (the CLI then leaves mode untouched).
 */
export function resolveAgentMode(env: NodeJS.ProcessEnv = process.env): AgentMode | undefined {
  const channel = env.EIGENFLUX_CHANNEL?.trim().toLowerCase();
  if (channel === 'skill') {
    return 'skill';
  }
  if (channel === 'plugin') {
    return 'plugin';
  }

  const host = env.EIGENFLUX_HOST?.trim().toLowerCase();
  // host looks like "openclaw/0.0.14" — the OpenClaw plugin runtime.
  if (host && host.startsWith('openclaw')) {
    return 'plugin';
  }
  // A known plugin channel maps to plugin; unknown channels stay ambiguous.
  if (channel === 'openclaw') {
    return 'plugin';
  }

  return undefined;
}

/**
 * Triggers the eigenflux CLI to push the agent's settings to the backend.
 * Change-detection and dedup live in the CLI; this class just resolves the
 * runtime mode and spawns the command once per heartbeat, best-effort.
 */
export class EigenFluxSettingsReporter {
  private readonly config: SettingsReporterConfig;
  private readonly resolveMode: () => AgentMode | undefined;
  private inFlight = false;

  constructor(config: SettingsReporterConfig) {
    this.config = config;
    this.resolveMode = config.resolveMode ?? (() => resolveAgentMode());
  }

  /**
   * Invoke `eigenflux settings push` for the configured server. Returns true if
   * the CLI ran successfully, false if it was skipped (in flight) or failed.
   * Never throws.
   */
  async report(): Promise<boolean> {
    if (this.inFlight) {
      this.config.logger.debug(`Settings push skipped (in flight) for server=${this.config.serverName}`);
      return false;
    }

    this.inFlight = true;
    try {
      const args = ['settings', 'push', '-s', this.config.serverName];

      const mode = this.resolveMode();
      if (mode) {
        // Insert --mode <mode> after the subcommand.
        args.splice(2, 0, '--mode', mode);
      } else {
        this.config.logger.debug(
          `Settings push: mode signal unavailable for server=${this.config.serverName}; omitting --mode`
        );
      }

      const result = await execEigenflux<string>(this.config.eigenfluxBin, args, {
        logger: this.config.logger,
        parseJson: false,
      });

      if (result.kind === 'success') {
        this.config.logger.info(
          `Pushed agent settings for server=${this.config.serverName} (mode=${mode ?? 'omitted'})`
        );
        return true;
      }

      if (result.kind === 'auth_required') {
        this.config.logger.warn(`Settings push: auth required for server=${this.config.serverName}`);
        return false;
      }
      if (result.kind === 'not_installed') {
        this.config.logger.warn(`Settings push: eigenflux CLI not installed (bin=${result.bin})`);
        return false;
      }
      // kind === 'error'
      this.config.logger.warn(
        `Settings push failed for server=${this.config.serverName}: ${result.error.message}`
      );
      return false;
    } catch (err) {
      // Best-effort: never interrupt the heartbeat. Log and move on.
      this.config.logger.warn(
        `Settings push crashed for server=${this.config.serverName}: ${err instanceof Error ? err.message : String(err)}`
      );
      return false;
    } finally {
      this.inFlight = false;
    }
  }
}
