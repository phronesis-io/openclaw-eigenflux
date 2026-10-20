#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { MAIN_NOTICE_CAPABILITY } from './main-notice';

const CAPABILITY_KEY = 'ai.eigenflux.mainConversation';
const MAX_LINE = 384 * 1024;
type GatewayCall = (method: string, params: Record<string, unknown>) => Promise<unknown>;

function resolveCli(argv: string[]): string {
  if (argv.length) {
    if (argv.length !== 2 || argv[0] !== '--openclaw-cli' || !isAbsolute(argv[1]) || !/\.(?:mjs|cjs|js)$/u.test(argv[1]) || argv[1].includes('\0')) throw new Error('invalid_openclaw_cli');
    return argv[1];
  }
  const require = createRequire(__filename);
  let directory = dirname(require.resolve('openclaw/plugin-sdk'));
  for (let i = 0; i < 8; i++, directory = dirname(directory)) {
    try {
      const pkg = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as { name?: string; bin?: string | { openclaw?: string } };
      if (pkg.name !== 'openclaw') continue;
      const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.openclaw;
      if (!bin || !/\.(?:mjs|cjs|js)$/u.test(bin)) break;
      return join(directory, bin);
    } catch { /* Only package metadata, never host config or session files. */ }
  }
  throw new Error('openclaw_cli_unavailable');
}
export function gatewayCaller(cliEntry: string): GatewayCall {
  return async (method, params) => new Promise((resolve, reject) => {
    // A JS entry run by Node is portable; never execute a Windows .cmd through
    // a shell and never derive executable/arguments from notification contents.
    execFile(process.execPath, [cliEntry, 'gateway', 'call', method, '--params', JSON.stringify(params), '--json', '--timeout', '130000'], { timeout: 135_000, maxBuffer: 512 * 1024, windowsHide: true, shell: false }, (error, stdout) => {
      if (error) { reject(new Error('main_notice_gateway_unavailable')); return; }
      try { resolve(JSON.parse(stdout)); }
      catch { reject(new Error('main_notice_gateway_invalid')); }
    });
  });
}
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function supported(value: unknown): boolean {
  return object(value) && value.version === 1 && value.host === 'openclaw' && value.existingSession === true && value.hiddenInput === true && value.resultOnly === true;
}

export function createMainNoticeBridge(call: GatewayCall) {
  let initialized = false;
  return async (request: unknown): Promise<unknown | undefined> => {
    if (!object(request) || request.jsonrpc !== '2.0' || typeof request.method !== 'string') return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid_request' } };
    const id = request.id;
    if (request.method === 'notifications/initialized' && id === undefined) return;
    if ((typeof id !== 'string' && typeof id !== 'number') || typeof id === 'number' && !Number.isSafeInteger(id)) return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid_request_id' } };
    try {
      if (request.method === 'initialize') {
        if (initialized || !supported(await call('eigenflux.main.capabilities', {}))) throw new Error('main_notice_runtime_unavailable');
        initialized = true;
        return { jsonrpc: '2.0', id, result: { protocolVersion: 1, agentInfo: { name: 'eigenflux-openclaw-main', version: '1' }, agentCapabilities: { _meta: { [CAPABILITY_KEY]: MAIN_NOTICE_CAPABILITY } } } };
      }
      if (!initialized) throw new Error('main_notice_not_initialized');
      if (!object(request.params)) throw new Error('main_notice_params_invalid');
      const methods: Record<string, string> = { '_eigenflux/main/inspect': 'eigenflux.main.inspect', '_eigenflux/main/notify': 'eigenflux.main.notify' };
      const method = methods[request.method];
      if (!method) return { jsonrpc: '2.0', id, error: { code: -32601, message: 'unsupported_method' } };
      const result = await call(method, request.params);
      if (!object(result) || result.existingSession !== true || result.hiddenInput !== true || result.resultOnly !== true || result.sessionId !== request.params.sessionId) throw new Error('main_notice_receipt_invalid');
      if (request.method === '_eigenflux/main/inspect') {
        if (result.host !== 'openclaw' || result.cwd !== request.params.cwd || !['idle', 'busy'].includes(result.state as string)) throw new Error('main_notice_receipt_invalid');
      } else if (result.requestId !== request.params.requestId || typeof result.runId !== 'string' || !result.runId || result.stopReason !== 'end_turn' || typeof result.text !== 'string' || !result.text.trim()) throw new Error('main_notice_receipt_invalid');
      return { jsonrpc: '2.0', id, result };
    } catch (error) {
      const message = error instanceof Error && /^main_notice_[a-z_]+$/u.test(error.message) ? error.message : 'main_notice_gateway_unconfirmed';
      return { jsonrpc: '2.0', id, error: { code: -32000, message } };
    }
  };
}

export async function serveMainNoticeBridge(input: Readable, output: Writable, call: GatewayCall): Promise<void> {
  const handle = createMainNoticeBridge(call);
  let pending = Buffer.alloc(0);
  for await (const chunk of input) {
    pending = Buffer.concat([pending, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    for (;;) {
      const end = pending.indexOf(10);
      if (end < 0) break;
      if (end > MAX_LINE) throw new Error('main_notice_line_oversized');
      const line = pending.subarray(0, end); pending = pending.subarray(end + 1);
      if (!line.toString('utf8').trim()) continue;
      let request: unknown;
      try { request = JSON.parse(line.toString('utf8')); }
      catch { throw new Error('main_notice_invalid_json'); }
      const response = await handle(request);
      if (response !== undefined) output.write(JSON.stringify(response) + '\n');
    }
    if (pending.length > MAX_LINE) throw new Error('main_notice_line_oversized');
  }
  if (pending.length && pending.toString('utf8').trim()) throw new Error('main_notice_incomplete_frame');
}

if (require.main === module) {
  let cli: string;
  try { cli = resolveCli(process.argv.slice(2)); }
  catch { process.stderr.write('main_notice_openclaw_cli_unavailable\n'); process.exitCode = 1; }
  if (cli!) serveMainNoticeBridge(process.stdin, process.stdout, gatewayCaller(cli)).catch(() => { process.stderr.write('main_notice_bridge_failed\n'); process.exitCode = 1; });
}
