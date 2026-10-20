import { PassThrough } from 'node:stream';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMainNoticeBridge, gatewayCaller, serveMainNoticeBridge } from './main-notice-bridge';
import { MAIN_NOTICE_CAPABILITY } from './main-notice';

const sessionId = 'agent:main:eigenflux';
const cwd = '/fixture/workspace';
const target = { host: 'openclaw', existingSession: true, hiddenInput: true, resultOnly: true, sessionId, cwd, state: 'idle' };
const receipt = { existingSession: true, hiddenInput: true, resultOnly: true, sessionId, requestId: 'request-1', runId: 'run-1', stopReason: 'end_turn', text: '完成' };
function rpc(method: string, params?: unknown, id: number = 1) { return { jsonrpc: '2.0', id, method, params }; }
function fixture() {
  const call = jest.fn(async (method: string, params: Record<string, unknown>) => method === 'eigenflux.main.capabilities' ? MAIN_NOTICE_CAPABILITY : method === 'eigenflux.main.inspect' ? target : { ...receipt, requestId: params.requestId });
  return { call, bridge: createMainNoticeBridge(call) };
}
test('advertises the exact custom capability only after a real host capability response', async () => {
  const f = fixture();
  expect(await f.bridge(rpc('initialize'))).toMatchObject({ result: { agentCapabilities: { _meta: { 'ai.eigenflux.mainConversation': MAIN_NOTICE_CAPABILITY } } } });
  expect(f.call).toHaveBeenCalledWith('eigenflux.main.capabilities', {});
  expect(await f.bridge(rpc('_eigenflux/main/inspect', { sessionId, cwd }, 2))).toMatchObject({ result: target });
  expect(await f.bridge(rpc('_eigenflux/main/notify', { sessionId, cwd, requestId: 'request-1', prompt: 'data' }, 3))).toMatchObject({ result: { sessionId, requestId: 'request-1', runId: 'run-1', stopReason: 'end_turn', text: '完成' } });
});
test.each(['session/new', 'session/load', 'session/prompt', 'session/cancel', 'cancel', 'unknown'])('never falls back through %s', async (method) => {
  const f = fixture(); await f.bridge(rpc('initialize'));
  const result = await f.bridge(rpc(method, { sessionId, cwd }, 2));
  expect(result).toMatchObject({ error: { code: -32601 } }); expect(f.call).toHaveBeenCalledTimes(1);
});
test.each([
  { supported: false }, { ...MAIN_NOTICE_CAPABILITY, hiddenInput: false }, { ...MAIN_NOTICE_CAPABILITY, resultOnly: false }, {},
])('does not fabricate unsupported host capabilities', async (capability) => {
  const call = jest.fn().mockResolvedValue(capability); const bridge = createMainNoticeBridge(call);
  expect(await bridge(rpc('initialize'))).toMatchObject({ error: { message: 'main_notice_runtime_unavailable' } });
  expect(await bridge(rpc('_eigenflux/main/notify', { sessionId, cwd }))).toMatchObject({ error: { message: 'main_notice_not_initialized' } });
  expect(call).toHaveBeenCalledTimes(1);
});
test.each([
  { ...target, sessionId: 'agent:other:main' }, { ...target, hiddenInput: false }, { ...target, existingSession: false },
  { sessionId, cwd, state: 'idle' }, { ...target, state: 'unknown' }, { ...target, cwd: '/wrong' },
])('rejects a stale or incomplete inspect receipt', async (receipt) => {
  const f = fixture(); await f.bridge(rpc('initialize')); f.call.mockResolvedValueOnce(receipt as any);
  expect(await f.bridge(rpc('_eigenflux/main/inspect', { sessionId, cwd }))).toMatchObject({ error: { message: 'main_notice_receipt_invalid' } });
});
test('requires the exact notify request id and a completed nonempty result', async () => {
  for (const overrides of [{ requestId: 'other' }, { text: '' }, { stopReason: 'queued' }, { runId: '' }, { resultOnly: false }]) {
    const f = fixture(); await f.bridge(rpc('initialize'));
    f.call.mockResolvedValueOnce({ ...receipt, ...overrides } as any);
    expect(await f.bridge(rpc('_eigenflux/main/notify', { sessionId, cwd, requestId: 'request-1' }))).toMatchObject({ error: { message: 'main_notice_receipt_invalid' } });
  }
});
test('fragments stdout as line-delimited JSON without exposing prompts or diagnostics', async () => {
  const f = fixture(); const input = new PassThrough(); const output = new PassThrough(); let stdout = '';
  output.on('data', (x) => { stdout += String(x); });
  const serving = serveMainNoticeBridge(input, output, f.call);
  const init = JSON.stringify(rpc('initialize')) + '\n'; input.write(init.slice(0, 12)); input.write(init.slice(12));
  input.end(JSON.stringify(rpc('_eigenflux/main/notify', { sessionId, cwd, requestId: 'request-1', prompt: 'PRIVATE_PROMPT' }, 2)) + '\n');
  await serving; expect(stdout).not.toContain('PRIVATE_PROMPT');
  expect(stdout.trim().split('\n').map((line) => JSON.parse(line))).toHaveLength(2);
});
test('sanitizes unknown Gateway failures and never retries them', async () => {
  const f = fixture(); await f.bridge(rpc('initialize')); f.call.mockRejectedValueOnce(new Error('SECRET_GATEWAY_TOKEN diagnostic'));
  const reply = await f.bridge(rpc('_eigenflux/main/notify', { sessionId, cwd }));
  expect(JSON.stringify(reply)).not.toContain('SECRET'); expect(f.call).toHaveBeenCalledTimes(2);
});


test('runs the portable Node Gateway bridge in separate processes with exact completed receipts', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'eigenflux-main-bridge-'));
  const cli = join(directory, 'openclaw-fixture.cjs');
  const calls = join(directory, 'calls.jsonl');
  const script = `const fs=require('node:fs');
const args=process.argv.slice(2);
if(args[0]!=='gateway'||args[1]!=='call'||args[3]!=='--params'||args[5]!=='--json'||args[6]!=='--timeout')process.exit(2);
const params=JSON.parse(args[4]);fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({method:args[2],sessionId:params.sessionId})+'\\n');
const result=args[2]==='eigenflux.main.capabilities'?${JSON.stringify(MAIN_NOTICE_CAPABILITY)}:args[2]==='eigenflux.main.inspect'?${JSON.stringify(target)}:args[2]==='eigenflux.main.notify'?{...${JSON.stringify(receipt)},requestId:params.requestId}:null;
if(!result)process.exit(3);process.stdout.write(JSON.stringify(result));`;
  try {
    writeFileSync(cli, script);
    const bridge = createMainNoticeBridge(gatewayCaller(cli));
    expect(await bridge(rpc('initialize'))).toMatchObject({ result: { protocolVersion: 1 } });
    expect(await bridge(rpc('_eigenflux/main/inspect', { sessionId, cwd }, 2))).toEqual({ jsonrpc: '2.0', id: 2, result: target });
    expect(await bridge(rpc('_eigenflux/main/notify', { sessionId, cwd, requestId: 'request-1', prompt: 'PRIVATE_EVENT' }, 3))).toEqual({ jsonrpc: '2.0', id: 3, result: receipt });
    expect(readFileSync(calls, 'utf8').trim().split('\n').map((line) => JSON.parse(line).method)).toEqual(['eigenflux.main.capabilities', 'eigenflux.main.inspect', 'eigenflux.main.notify']);
    expect(readFileSync(calls, 'utf8')).not.toContain('PRIVATE_EVENT');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
