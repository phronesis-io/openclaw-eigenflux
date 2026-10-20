import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { realpathSync, statSync } from 'node:fs';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';

export const MAIN_NOTICE_CAPABILITY = Object.freeze({
  version: 1, host: 'openclaw', existingSession: true, hiddenInput: true, resultOnly: true,
});
const RUNTIME_TRIGGER = 'Continue the OpenClaw runtime event.';
const MAX_PROMPT_BYTES = 256 * 1024;
const MAX_RESULT_BYTES = 32 * 1024;
const MAX_RECEIPTS = 1024;

type Entry = { sessionId?: string; archived?: boolean; archivedAt?: number };
type RuntimeResult = {
  payloads?: Array<{ text?: string; isError?: boolean; isReasoning?: boolean; isCommentary?: boolean }>;
  meta?: { aborted?: boolean; error?: unknown; yielded?: boolean; continuationPending?: boolean; timeoutPhase?: string; stopReason?: string; finalAssistantVisibleText?: string };
  asyncWorkStarted?: boolean;
  requesterContinuationSettled?: boolean;
};
type SessionParams = { agentId: string; sessionKey: string; storePath: string };
type NativeRuntime = {
  version?: string;
  config: { current: () => Record<string, any> };
  agent: {
    resolveAgentWorkspaceDir: (cfg: Record<string, any>, agentId: string) => string;
    resolveAgentDir: (cfg: Record<string, any>, agentId: string) => string;
    session: {
      resolveStorePath: (store: string | undefined, params: { agentId: string }) => string;
      getSessionEntry: (params: SessionParams) => Entry | undefined;
      runWithWorkAdmission: <T>(params: { storePath: string; sessionKey: string; signal?: AbortSignal }, run: (signal: AbortSignal) => Promise<T>) => Promise<T>;
    };
    runEmbeddedAgent: (params: Record<string, unknown>) => Promise<RuntimeResult>;
  };
  tasks: { runs: { bindSession: (params: { sessionKey: string }) => { list: () => Array<{ status?: string; endedAt?: number | null }> } } };
};
type Receipt = { existingSession: true; hiddenInput: true; resultOnly: true } & { sessionId: string; requestId: string; runId: string; stopReason: 'end_turn'; text: string };
type GatewayHandler = (call: { params: Record<string, unknown>; respond: (ok: boolean, payload?: unknown, error?: { code: string; message: string }) => void }) => Promise<void> | void;
type GatewayApi = { registerGatewayMethod?: (name: string, handler: GatewayHandler, options?: { scope: string }) => void };
type TranscriptPublisher = (params: Record<string, unknown>) => Promise<unknown>;
type TranscriptRuntime = { appendAssistantMirrorMessageByIdentity: TranscriptPublisher; publishSessionTranscriptUpdateByIdentity: TranscriptPublisher };
type HarnessRuntime = { resolveActiveEmbeddedRunSessionId: (sessionKey: string) => string | undefined };
let harnessRuntime: Promise<HarnessRuntime> | undefined;
async function loadHarnessRuntime(): Promise<HarnessRuntime> {
  if (!harnessRuntime) harnessRuntime = (async () => {
    const moduleName = 'openclaw/plugin-sdk/agent-harness';
    const module = await import(moduleName) as Partial<HarnessRuntime>;
    if (typeof module.resolveActiveEmbeddedRunSessionId !== 'function') fail('main_notice_runtime_unavailable');
    return module as HarnessRuntime;
  })();
  return harnessRuntime;
}
let transcriptRuntime: Promise<TranscriptRuntime> | undefined;
async function loadTranscriptRuntime(): Promise<TranscriptRuntime> {
  if (!transcriptRuntime) transcriptRuntime = (async () => {
    const moduleName = 'openclaw/plugin-sdk/session-transcript-runtime';
    const module = await import(moduleName) as Partial<TranscriptRuntime>;
    if (typeof module.appendAssistantMirrorMessageByIdentity !== 'function' || typeof module.publishSessionTranscriptUpdateByIdentity !== 'function') fail('main_notice_runtime_unavailable');
    return module as TranscriptRuntime;
  })();
  return transcriptRuntime;
}

function fail(code: string): never { throw new Error(code); }
function safeString(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value && value.length <= maximum && !/[\x00-\x1f\x7f]/u.test(value);
}
function supported(runtime: NativeRuntime): boolean {
  const version = /^(\d+)\.(\d+)\.(\d+)$/.exec(runtime?.version ?? '');
  if (!version || Number(version[1]) < 2026 || Number(version[1]) === 2026 && (Number(version[2]) < 9 || Number(version[2]) === 9 && Number(version[3]) < 4)) return false;
  return typeof runtime.config?.current === 'function' && typeof runtime.agent?.resolveAgentWorkspaceDir === 'function' && typeof runtime.agent?.resolveAgentDir === 'function' && typeof runtime.agent?.session?.resolveStorePath === 'function' && typeof runtime.agent?.runEmbeddedAgent === 'function' && typeof runtime.agent.session?.runWithWorkAdmission === 'function' && typeof runtime.agent.session.getSessionEntry === 'function' && typeof runtime.tasks?.runs?.bindSession === 'function';
}
function samePath(a: string, b: string): boolean {
  const normalize = (value: string) => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value);
  return isAbsolute(a) && isAbsolute(b) && normalize(a) === normalize(b);
}
async function publishTranscript(params: Record<string, unknown>): Promise<unknown> {
  const module = await loadTranscriptRuntime();
  // The host deduplicates against its latest equivalent native assistant turn.
  // If a runtime did not mirror its final, persist that final through the same
  // exact-identity API instead of publishing an empty UI refresh as delivery.
  const receipt = await module.appendAssistantMirrorMessageByIdentity(params) as { ok?: boolean; messageId?: string } | undefined;
  if (!receipt?.ok || !receipt.messageId) fail('main_notice_result_unconfirmed');
  const { text: _text, signal: _signal, ...identity } = params;
  await module.publishSessionTranscriptUpdateByIdentity({ ...identity, update: { messageId: receipt.messageId } });
  return receipt;
}

export function createMainNoticeHost(api: Pick<OpenClawPluginApi, 'runtime'>, publish: TranscriptPublisher = publishTranscript) {
  const runtime = api.runtime as unknown as NativeRuntime;
  const active = new Set<string>();
  const receipts = new Map<string, { hash: string; receipt?: Receipt; failed?: boolean }>();
  async function available(): Promise<boolean> {
    if (!supported(runtime)) return false;
    try {
      await loadHarnessRuntime();
      if (publish === publishTranscript) await loadTranscriptRuntime();
      return true;
    } catch { return false; }
  }
  function target(params: Record<string, unknown>) {
    if (!supported(runtime)) fail('main_notice_runtime_unavailable');
    if (!safeString(params.sessionId, 512) || !/^agent:[a-z0-9][a-z0-9_-]*:.+$/u.test(params.sessionId) || !safeString(params.cwd, 4096) || !isAbsolute(params.cwd)) fail('main_notice_target_invalid');
    const sessionKey = params.sessionId;
    const agentId = sessionKey.split(':')[1];
    const cfg = runtime.config.current();
    let cwd: string;
    try {
      cwd = realpathSync(runtime.agent.resolveAgentWorkspaceDir(cfg, agentId));
      if (!statSync(cwd).isDirectory()) fail('main_notice_target_invalid');
    } catch { fail('main_notice_target_invalid'); }
    if (!samePath(params.cwd, cwd)) fail('main_notice_target_mismatch');
    const storePath = runtime.agent.session.resolveStorePath(cfg.session?.store, { agentId });
    const identity = { agentId, sessionKey, storePath };
    const entry = runtime.agent.session.getSessionEntry(identity);
    if (!entry?.sessionId || entry.archived || entry.archivedAt) fail('main_notice_existing_session_unavailable');
    return { identity, entry, cfg, cwd };
  }
  async function isBusy(sessionKey: string): Promise<boolean> {
    const harness = await loadHarnessRuntime();
    return active.has(sessionKey) || !!harness.resolveActiveEmbeddedRunSessionId(sessionKey) || runtime.tasks.runs.bindSession({ sessionKey }).list().some((run) => !run.endedAt && !['succeeded', 'failed', 'cancelled', 'timed_out', 'completed'].includes(run.status ?? ''));
  }
  return {
    async capabilities() {
      return await available() ? MAIN_NOTICE_CAPABILITY : { supported: false, code: 'main_notice_runtime_unavailable' };
    },
    async inspect(params: Record<string, unknown>) {
      if (!await available()) fail('main_notice_runtime_unavailable');
      const t = target(params);
      return { host: 'openclaw', existingSession: true, hiddenInput: true, resultOnly: true, sessionId: t.identity.sessionKey, cwd: t.cwd, state: await isBusy(t.identity.sessionKey) ? 'busy' : 'idle' };
    },
    async notify(params: Record<string, unknown>): Promise<Receipt> {
      if (!await available()) fail('main_notice_runtime_unavailable');
      const t = target(params);
      if (!safeString(params.requestId, 128) || !/^[A-Za-z0-9._:-]+$/u.test(params.requestId) || typeof params.prompt !== 'string' || Buffer.byteLength(params.prompt) > MAX_PROMPT_BYTES) fail('main_notice_request_invalid');
      const split = params.prompt.indexOf('\n\nUNTRUSTED COMMISSION EVENT:\n');
      if (split <= 0) fail('main_notice_envelope_invalid');
      const application = params.prompt.slice(0, split);
      const eventText = params.prompt.slice(split + '\n\nUNTRUSTED COMMISSION EVENT:\n'.length);
      let event: unknown;
      try { event = JSON.parse(eventText); } catch { fail('main_notice_envelope_invalid'); }
      if (!event || typeof event !== 'object' || Array.isArray(event)) fail('main_notice_envelope_invalid');
      const requestId = params.requestId;
      const key = `${t.identity.sessionKey}:${requestId}`;
      const hash = createHash('sha256').update(JSON.stringify([t.identity.sessionKey, t.entry.sessionId, t.cwd, params.prompt])).digest('hex');
      const previousReceipt = (): Receipt | undefined => {
        const previous = receipts.get(key);
        if (!previous) return;
        if (previous.hash !== hash) fail('main_notice_request_mismatch');
        if (previous.receipt) return previous.receipt;
        fail(previous.failed ? 'main_notice_unconfirmed' : 'main_notice_target_busy');
      };
      const previous = previousReceipt();
      if (previous) return previous;
      const busy = await isBusy(t.identity.sessionKey);
      // The native projection is async. Claim synchronously after it resolves so
      // two fresh requests cannot both pass the same preflight snapshot.
      const raced = previousReceipt();
      if (raced) return raced;
      if (busy || active.has(t.identity.sessionKey)) fail('main_notice_target_busy');
      if (receipts.size >= MAX_RECEIPTS) fail('main_notice_receipt_capacity');
      const record: { hash: string; receipt?: Receipt; failed?: boolean } = { hash };
      receipts.set(key, record);
      active.add(t.identity.sessionKey);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error('main_notice_timeout')), 120_000);
      timer.unref?.();
      try {
        return await runtime.agent.session.runWithWorkAdmission({ storePath: t.identity.storePath, sessionKey: t.identity.sessionKey, signal: controller.signal }, async (signal) => {
          const current = target(params);
          if (current.entry.sessionId !== t.entry.sessionId) fail('main_notice_target_replaced');
          const runId = randomUUID();
          const result = await runtime.agent.runEmbeddedAgent({
            sessionId: t.entry.sessionId, sessionKey: t.identity.sessionKey,
            sessionTarget: { ...t.identity, sessionId: t.entry.sessionId }, sessionPersistence: 'durable',
            agentId: t.identity.agentId, workspaceDir: t.cwd,
            agentDir: runtime.agent.resolveAgentDir(t.cfg, t.identity.agentId), config: t.cfg,
            runId, timeoutMs: 120_000, abortSignal: signal,
            onLaneWait: (info: { waiting?: boolean; queuedAhead: number }) => {
              if (info.waiting || info.queuedAhead > 0) controller.abort(new Error('main_notice_target_busy'));
            },
            // A nonempty fixed carrier avoids the builtin blank-prompt skip.
            // User persistence remains suppressed; business text stays in hidden fragments.
            prompt: RUNTIME_TRIGGER, transcriptPrompt: '',
            runtimeContextFragments: [
              { kind: 'runtime-instruction', text: application },
              { kind: 'conversation-data', text: eventText },
            ],
            suppressNextUserMessagePersistence: true,
            inputProvenance: { kind: 'internal_system', sourceTool: 'eigenflux.main.notice' },
            trigger: 'manual',
          });
          if (signal.aborted || controller.signal.aborted || result.meta?.error || result.meta?.aborted || result.meta?.timeoutPhase || result.meta?.yielded || result.meta?.continuationPending || result.meta?.stopReason === 'tool_calls' || result.asyncWorkStarted || result.requesterContinuationSettled || result.payloads?.some((p) => p.isError)) fail('main_notice_unconfirmed');
          const text = result.meta?.finalAssistantVisibleText ?? result.payloads?.filter((p) => !p.isReasoning && !p.isCommentary && !p.isError).map((p) => p.text ?? '').filter(Boolean).join('\n');
          if (!text?.trim() || Buffer.byteLength(text) > MAX_RESULT_BYTES || text === params.prompt || text.includes(eventText)) fail('main_notice_result_unconfirmed');
          const after = target(params);
          if (after.entry.sessionId !== t.entry.sessionId) fail('main_notice_target_replaced');
          const published = await publish({ ...t.identity, sessionId: t.entry.sessionId, config: t.cfg, text, signal });
          if (!published || typeof published !== 'object' || (published as { ok?: boolean }).ok !== true || !safeString((published as { messageId?: string }).messageId, 512)) fail('main_notice_result_unconfirmed');
          if (signal.aborted || controller.signal.aborted) fail('main_notice_unconfirmed');
          const receipt: Receipt = { existingSession: true, hiddenInput: true, resultOnly: true, sessionId: t.identity.sessionKey, requestId, runId, stopReason: 'end_turn', text };
          record.receipt = receipt;
          return receipt;
        });
      } catch {
        record.failed = true;
        fail('main_notice_unconfirmed');
      } finally {
        clearTimeout(timer);
        active.delete(t.identity.sessionKey);
      }
    },
  };
}

export function registerMainNoticeGateway(api: OpenClawPluginApi): void {
  const gateway = api as unknown as GatewayApi;
  if (typeof gateway.registerGatewayMethod !== 'function') return;
  const host = createMainNoticeHost(api);
  const expose = (name: string, callback: (params: Record<string, unknown>) => unknown | Promise<unknown>, scope: string) => {
    gateway.registerGatewayMethod!(name, async ({ params, respond }) => {
      try { respond(true, await callback(params)); }
      catch (error) {
        const code = error instanceof Error && /^main_notice_[a-z_]+$/u.test(error.message) ? error.message : 'main_notice_unconfirmed';
        respond(false, undefined, { code: 'UNAVAILABLE', message: code });
      }
    }, { scope });
  };
  expose('eigenflux.main.capabilities', () => host.capabilities(), 'operator.read');
  expose('eigenflux.main.inspect', (params) => host.inspect(params), 'operator.read');
  expose('eigenflux.main.notify', (params) => host.notify(params), 'operator.write');
}
