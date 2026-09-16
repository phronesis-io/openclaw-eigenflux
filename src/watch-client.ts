/** Host lifecycle only. Business eligibility and retries remain in the CLI. */
import { spawn, ChildProcess } from 'child_process';
import { createInterface, Interface } from 'readline';
import { resolve } from 'path';
import { realpathSync } from 'fs';
import { cliEnvironment } from './cli-executor';
import { getInstalledCliVersion } from './config';
import { EigenFluxStreamClient, StreamClientConfig, PmStreamEvent } from './stream-client';

export interface WatchEvent extends PmStreamEvent {
  schema_version: 'eigenflux_watch.v1';
  event_id: string;
  state_scope: string;
}
export interface WatchClientConfig extends StreamClientConfig {
  eigenfluxHome: string;
  onWatchEvent: (event: WatchEvent) => Promise<void>;
  onIdentityChanged?: () => void | Promise<void>;
  version?: () => Promise<string | null>;
  stopGraceMs?: number;
  retryMs?: number;
}
function canonicalHome(home: string): string {
  try { return realpathSync(home); } catch { return resolve(home); }
}
export function supportsWatch(version: string | null): boolean {
  return !!version && /^v?(?:[1-9]\d*)\.\d+\.\d+(?:\+[^\s]+)?$/.test(version);
}

/** Keeps the old stream transport intact for CLI versions before 1.0.0. */
export class EigenFluxWatchClient {
  private readonly legacy: EigenFluxStreamClient;
  private running = false;
  private watch = false;
  private blocked = false;
  private child: ChildProcess | null = null;
  private lines: Interface | null = null;
  private retry: NodeJS.Timeout | null = null;
  private failures = 0;
  private scope: string | null = null;
  private identity: string | null = null;
  private started = false;
  private version: string | null = null;
  private ready = false;
  private active = new Map<string, Promise<void>>();
  private pmQueue: Promise<void> = Promise.resolve();
  private queued = 0;
  private handoff: Promise<void> | null = null;
  private upgradeTo: string | null = null;
  private rejecting = false;
  constructor(private readonly config: WatchClientConfig) {
    this.legacy = new EigenFluxStreamClient(config);
  }
  isRunning(): boolean { return this.running && (this.watch ? !!this.child : this.legacy.isRunning()); }
  isWatchEnabled(): boolean { return this.watch; }
  isReady(): boolean { return this.ready; }
  getLastCursor(): string | null { return this.watch ? null : this.legacy.getLastCursor(); }
  async start(): Promise<void> {
    if (this.running || this.blocked) return;
    this.running = true;
    const version = await (this.config.version?.() ?? getInstalledCliVersion(this.config.eigenfluxBin, this.config.logger, this.config.eigenfluxHome));
    if (!this.running) return;
    this.watch = supportsWatch(version);
    if (this.watch) this.launch(); else await this.legacy.start();
  }
  async stop(): Promise<void> {
    this.running = false;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    await this.legacy.stop();
    await this.terminate();
    await this.handoff;
  }
  /** Called after the existing maintenance runner; upgrades the compatibility transport once. */
  async refreshVersion(): Promise<void> {
    if (!this.running || this.blocked) return;
    const version = await (this.config.version?.() ?? getInstalledCliVersion(this.config.eigenfluxBin, this.config.logger, this.config.eigenfluxHome));
    if (!this.running || !supportsWatch(version)) return;
    if (!this.watch) {
      await this.legacy.stop();
      if (!this.running) return;
      this.watch = true;
      this.launch();
    } else if (this.version && this.version !== version) await this.restart(version!);
  }
  private launch(): void {
    if (!this.running || this.child || this.blocked) return;
    this.started = false;
    this.ready = false;
    this.rejecting = false;
    const args = ['--homedir', this.config.eigenfluxHome, '--server', this.config.serverName, 'watch'];
    const child = spawn(this.config.eigenfluxBin, args, { stdio: ['ignore', 'pipe', 'pipe'],
      env: cliEnvironment({ EIGENFLUX_HOME: this.config.eigenfluxHome, EIGENFLUX_UPDATE_REEXEC: undefined }) });
    this.child = child;
    const lines = createInterface({ input: child.stdout! });
    this.lines = lines;
    lines.on('line', line => { if (this.child === child) this.receive(line); });
    child.stderr?.on('data', data => this.config.logger.debug(`[watch] ${String(data).trim()}`));
    child.once('error', error => { this.config.logger.error(`watch process failed: ${error.message}`); });
    child.once('close', (code) => {
      lines.close();
      if (this.child !== child) return;
      this.child = null;
      this.lines = null;
      this.ready = false;
      if (code === 78) { this.blockIdentity(); return; }
      if (code === 4) void this.config.onAuthRequired().catch(error => this.config.logger.warn(String(error)));
      this.scheduleRestart();
    });
  }
  private receive(line: string): void {
    if (this.rejecting || !this.running) return;
    let event: WatchEvent;
    try { event = JSON.parse(line); } catch { this.config.logger.warn('Invalid watch JSON'); return; }
    if (event.schema_version !== 'eigenflux_watch.v1' || typeof event.event_id !== 'string' || !event.event_id || typeof event.type !== 'string' || typeof event.state_scope !== 'string' || !event.state_scope || !event.data || typeof event.data !== 'object' || Array.isArray(event.data)) {
      this.config.logger.warn('Invalid watch event contract'); return;
    }
    if (event.type === 'started') {
      const { home, server, agent_id, cli_version } = event.data;
      if (typeof home !== 'string' || canonicalHome(home) !== canonicalHome(this.config.eigenfluxHome) || server !== this.config.serverName ||
          typeof agent_id !== 'string' || !agent_id || typeof cli_version !== 'string' || !supportsWatch(cli_version) ||
          (this.scope !== null && this.scope !== event.state_scope) || (this.identity !== null && this.identity !== agent_id)) {
        this.blockIdentity(); return;
      }
      if (this.upgradeTo) {
        const installed = cli_version.replace(/^v/, '').split('.').map(Number);
        const wanted = this.upgradeTo.replace(/^v/, '').split('.').map(Number);
        const difference = installed.map((n, i) => n - wanted[i]).find(n => n !== 0) ?? 0;
        if (difference < 0) {
          this.rejecting = true;
          this.config.logger.error('watch replacement did not adopt installed version');
          void this.terminate().catch(error => { this.blocked = true; this.config.logger.error(String(error)); });
          return;
        }
      }
      this.started = true;
      this.scope = event.state_scope;
      this.identity = agent_id;
      this.version = cli_version;
      return;
    }
    if (!this.started || event.state_scope !== this.scope) { this.blockIdentity(); return; }
    if (event.type === 'diagnostic') {
      this.config.logger.warn(`watch diagnostic: ${String(event.data.code ?? 'unknown')}`);
      if (['identity_changed', 'configuration_changed', 'owner_replaced'].includes(String(event.data.code))) this.blockIdentity();
      return;
    }
    if (event.type === 'runtime_ready') {
      if (event.data.cli_version !== this.version || event.data.agent_id !== this.identity || event.data.server !== this.config.serverName ||
          typeof event.data.home !== 'string' || canonicalHome(event.data.home) !== canonicalHome(this.config.eigenfluxHome)) { this.blockIdentity(); return; }
      this.ready = true;
      this.failures = 0;
      this.config.logger.info(`watch runtime_ready version=${this.version} scope=${this.scope}`);
      return;
    }
    if (event.type === 'restart_required') {
      const next = event.data.cli_version;
      if (typeof next === 'string' && supportsWatch(next) && next !== this.version) void this.restart(next);
      return;
    }
    if (['pm_push', 'friend_accepted', 'friend_rejected'].includes(event.type)) {
      if (this.queued >= 64) { this.config.logger.error('watch PM delivery queue full; stopping consumer'); void this.stop(); return; }
      this.queued++;
      this.pmQueue = this.pmQueue.then(async () => { if (this.running && !this.blocked) await this.config.onPmEvent(event); }).catch(error => {
        this.config.logger.error(`watch PM delivery failed: ${String(error)}`);
      }).finally(() => { this.queued--; });
      return;
    }
    if (['profile_review_due', 'control_pending', 'maintenance_due'].includes(event.type)) {
      if (this.active.has(event.type)) return;
      const task = Promise.resolve().then(async () => { if (this.running && !this.blocked) await this.config.onWatchEvent(event); }).catch(error => {
        this.config.logger.error(`watch ${event.type} failed: ${String(error)}`);
      }).finally(() => { if (this.active.get(event.type) === task) this.active.delete(event.type); });
      this.active.set(event.type, task);
    }
  }
  private blockIdentity(): void {
    if (this.blocked) return;
    this.blocked = true;
    void Promise.resolve().then(() => this.config.onIdentityChanged?.()).catch(error => this.config.logger.error(String(error)));
    this.config.logger.error('watch identity mismatch; explicit account restart required');
    void this.stop().catch(error => this.config.logger.error(String(error)));
  }
  private scheduleRestart(): void {
    if (!this.running || this.blocked || this.handoff || this.retry) return;
    if (++this.failures > 20) { this.running = false; this.config.logger.error('watch restart budget exhausted'); return; }
    this.retry = setTimeout(() => { this.retry = null; this.launch(); }, this.config.retryMs ?? Math.min(1000 * 2 ** (this.failures - 1), 60_000));
  }
  private async terminate(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.lines?.close();
    this.ready = false;
    await new Promise<void>((resolveStop, reject) => {
      const timer = setTimeout(() => child.kill('SIGKILL'), this.config.stopGraceMs ?? 5000);
      const deadline = setTimeout(() => reject(new Error('watch child did not exit; replacement suppressed')), (this.config.stopGraceMs ?? 5000) + 5000);
      child.once('close', () => { clearTimeout(timer); clearTimeout(deadline); resolveStop(); });
      child.kill('SIGTERM');
    });
  }
  private async restart(next: string): Promise<void> {
    if (this.handoff || !this.running || this.upgradeTo === next) return;
    this.upgradeTo = next;
    this.lines?.pause();
    this.handoff = (async () => {
      // Existing Agent turns remain owned by the host and are never replayed.
      await this.terminate();
      if (this.running) this.launch();
    })().catch(error => { this.blocked = true; this.config.logger.error(String(error)); }).finally(() => { this.handoff = null; });
    await this.handoff;
  }
}
