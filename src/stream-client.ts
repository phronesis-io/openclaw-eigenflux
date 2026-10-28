/**
 * Stream client for EigenFlux private message updates.
 * Manages a long-running `eigenflux stream` child process that outputs NDJSON.
 */

import { spawn, ChildProcess } from 'child_process';
import { createInterface, Interface as ReadlineInterface } from 'readline';
import { StringDecoder } from 'node:string_decoder';
import { Logger } from './logger';
import { cliEnvironment } from './cli-executor';

const EXIT_AUTH_REQUIRED = 4;
const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;
const BACKOFF_MULTIPLIER = 2;
const STOP_GRACE_MS = 5_000;
const DELIVERY_DRAIN_MS = 30_000;
const CLOSE_AFTER_KILL_MS = 1_000;
const MAX_CONSECUTIVE_FAILURES = 20;

export interface PmStreamEvent {
  type: string;
  notification?: unknown;
  data: {
    messages?: Array<{
      msg_id: string;
      conv_id: string;
      sender_id?: string;
      sender_name?: string;
      content: string;
      created_at: number;
    }>;
    // Pending incoming friend requests, replayed on (re)connect by the server.
    friend_requests?: Array<{
      request_id: string;
      from_uid: string;
      from_name?: string;
      greeting?: string;
      created_at: number;
    }>;
    friend_requests_has_more?: boolean;
    // Missed friend-request responses (accepted/rejected), backfilled on
    // (re)connect from the server's durable pm:notify store.
    friend_responses?: Array<{
      notification_id: string;
      type: string;
      content: string;
      created_at: number;
    }>;
    // Present on `type: "friend_accepted"` push events.
    friend_uid?: string;
    next_cursor?: string;
    [key: string]: unknown;
  };
}

export interface StreamClientConfig {
  serverName: string;
  eigenfluxBin: string;
  eigenfluxHome?: string;
  logger: Logger;
  onPmEvent: (event: PmStreamEvent) => Promise<void>;
  onAuthRequired: (stderr?: string) => Promise<void>;
  onStreamError?: (error: Error) => void;
}

export class EigenFluxStreamClient {
  private config: StreamClientConfig;
  private child: ChildProcess | null = null;
  private readline: ReadlineInterface | null = null;
  private stopping = false;
  private running = false;
  private lastCursor: string | null = null;
  private backoffMs = INITIAL_BACKOFF_MS;
  private consecutiveFailures = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private childClosed: Promise<void> | null = null;
  private pendingDeliveries = new Set<Promise<void>>();
  private cliVersion: string | undefined;
  private adoption: Promise<void> | null = null;
  private adopting = false;
  private generation = 0;

  constructor(config: StreamClientConfig) {
    this.config = config;
  }

  isRunning(): boolean {
    return this.running;
  }

  getLastCursor(): string | null {
    return this.lastCursor;
  }

  async start(): Promise<void> {
    if (this.running) {
      this.config.logger.warn('Stream client already running');
      return;
    }

    if (this.child) {
      this.config.logger.warn('Previous stream has not closed; deferring start');
      return;
    }
    this.running = true;
    this.stopping = false;
    this.generation += 1;
    this.adopting = false;
    this.config.logger.info(`Starting stream client for server=${this.config.serverName}`);
    this.spawnStreamProcess();
  }

  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

    this.config.logger.info(`Stopping stream client for server=${this.config.serverName}`);
    this.stopping = true;
    this.running = false;
    this.generation += 1;

    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    await this.terminateStreamProcess();
    await this.waitForDeliveries();
    this.cliVersion = undefined;
  }

  /** Reconcile the existing stream after a successful heartbeat ran a newer CLI. */
  async adoptCLIVersion(version?: string): Promise<void> {
    if (!version || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version) || !this.running || this.stopping) return;
    if (this.adoption) {
      await this.adoption;
      return this.adoptCLIVersion(version);
    }
    if (version === this.cliVersion) return;
    this.adopting = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const generation = this.generation;
    this.adoption = (async () => {
      // Finish deliveries already handed to the host before interrupting intake.
      if (!await this.waitForDeliveries()) {
        // Intake was not interrupted; preserve the old stream's reconnect path.
        if (this.generation === generation && this.child) this.adopting = false;
        return;
      }
      if (this.stopping || !this.running || this.generation !== generation) return;
      if (!await this.terminateStreamProcess()) return;
      // close means all trailing stdout was read; wait for those deliveries too.
      if (!await this.waitForDeliveries()) return;
      if (this.stopping || !this.running || this.generation !== generation) return;
      this.config.logger.info(`Adopting CLI ${version} for stream server=${this.config.serverName}`);
      this.cliVersion = version;
      this.adopting = false;
      this.spawnStreamProcess();
    })();
    try {
      await this.adoption;
    } catch (error) {
      this.config.logger.warn(`CLI stream adoption deferred: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.adoption = null;
    }
  }

  private async waitFor(promise: Promise<unknown>, timeout: number): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise.then(() => true),
        new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), timeout); }),
      ]);
    } finally { clearTimeout(timer); }
  }

  private async waitForDeliveries(): Promise<boolean> {
    const completed = await this.waitFor(Promise.all([...this.pendingDeliveries]), DELIVERY_DRAIN_MS);
    if (!completed) this.config.logger.warn('Stream delivery is still pending; deferring CLI replacement');
    return completed;
  }

  private async terminateStreamProcess(): Promise<boolean> {
    const child = this.child;
    const closed = this.childClosed;
    if (!child || !closed) return true;
    child.kill('SIGTERM');
    const forceKillTimer = setTimeout(() => {
      this.config.logger.warn(`Stream did not stop within ${STOP_GRACE_MS}ms; killing it`);
      child.kill('SIGKILL');
    }, STOP_GRACE_MS);
    try {
      // Never overlap the replacement with a child whose stdio is still open.
      const completed = await this.waitFor(closed, STOP_GRACE_MS + CLOSE_AFTER_KILL_MS);
      if (!completed) this.config.logger.warn('Stream stdio has not closed; deferring CLI replacement');
      return completed;
    } finally {
      clearTimeout(forceKillTimer);
    }
  }

  private spawnStreamProcess(): void {
    if (this.stopping || !this.running || this.child) {
      return;
    }
    const generation = this.generation;

    const args = ['stream', '-s', this.config.serverName, '-f', 'json'];
    if (this.config.eigenfluxHome) args.push('--homedir', this.config.eigenfluxHome);
    if (this.lastCursor) {
      args.push('--cursor', this.lastCursor);
    }

    this.config.logger.info(
      `Spawning: ${this.config.eigenfluxBin} ${args.join(' ')}`
    );

    const child = spawn(this.config.eigenfluxBin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: cliEnvironment(this.config.eigenfluxHome ? { EIGENFLUX_HOME: this.config.eigenfluxHome } : undefined),
    });
    this.child = child;
    this.childClosed = new Promise(resolve => { child.once('close', () => resolve()); });

    const rl = createInterface({ input: child.stdout! });
    this.readline = rl;

    rl.on('line', (line) => {
      if (generation === this.generation) this.handleLine(line);
    });

    let stderrTail = '';
    const stderrDecoder = new StringDecoder('utf8');
    child.stderr?.on('data', (chunk: Buffer) => {
      const decoded = stderrDecoder.write(chunk);
      stderrTail = (stderrTail + decoded).slice(-16_384);
      const text = decoded.trim();
      if (text) {
        this.config.logger.debug(`[stream stderr] ${text}`);
      }
    });

    child.on('error', (err) => {
      if (generation !== this.generation) return;
      this.config.logger.error(`Stream process error: ${err.message}`);
      this.config.onStreamError?.(err);
    });

    // close follows stderr drainage, including the CLI's final owner action.
    child.on('close', (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      this.childClosed = null;
      if (this.readline === rl) this.readline = null;
      if (generation !== this.generation) return;
      stderrTail = (stderrTail + stderrDecoder.end()).slice(-16_384);
      this.config.logger.info(
        `Stream process exited (code=${code}, signal=${signal})`
      );
      if (this.stopping || !this.running || this.adopting) return;

      if (code === EXIT_AUTH_REQUIRED) {
        this.config.logger.warn('Stream auth required');
        this.config.onAuthRequired(stderrTail.trim()).then(() => {
          this.scheduleRestart(generation);
        }).catch((err) => {
          this.config.logger.error(`Auth required handler error: ${err instanceof Error ? err.message : String(err)}`);
          this.scheduleRestart(generation);
        });
        return;
      }

      this.scheduleRestart(generation);
    });
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    try {
      const event = JSON.parse(trimmed) as PmStreamEvent;

      // Update cursor for reconnect resume
      if (event.type !== 'notification_push' && event.type !== 'commission_order_notification' && event.data?.next_cursor) {
        this.lastCursor = event.data.next_cursor;
      }

      // Reset backoff on successful message
      this.backoffMs = INITIAL_BACKOFF_MS;
      this.consecutiveFailures = 0;

      const delivery = this.config.onPmEvent(event).catch((err) => {
        this.config.logger.error(
          `PM event handler error: ${err instanceof Error ? err.message : String(err)}`
        );
      });
      this.pendingDeliveries.add(delivery);
      void delivery.finally(() => this.pendingDeliveries.delete(delivery));
    } catch (err) {
      this.config.logger.warn(
        `Failed to parse stream line: ${(err as Error).message}`
      );
    }
  }

  private scheduleRestart(generation: number): void {
    if (generation !== this.generation || this.stopping || !this.running || this.adopting || this.child) {
      return;
    }

    this.consecutiveFailures += 1;

    if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      this.config.logger.error(
        `Stream client giving up after ${MAX_CONSECUTIVE_FAILURES} consecutive failures for server=${this.config.serverName}`
      );
      this.running = false;
      return;
    }

    this.config.logger.info(
      `Stream reconnecting in ${this.backoffMs}ms (failure #${this.consecutiveFailures}) for server=${this.config.serverName}`
    );

    this.restartTimer = setTimeout(() => {
      if (generation !== this.generation || this.stopping || !this.running) return;
      this.restartTimer = null;
      this.spawnStreamProcess();
    }, this.backoffMs);

    this.backoffMs = Math.min(
      this.backoffMs * BACKOFF_MULTIPLIER,
      MAX_BACKOFF_MS
    );
  }
}
