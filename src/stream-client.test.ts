import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { EigenFluxStreamClient, type PmStreamEvent } from './stream-client';
import { Logger } from './logger';

test('the stream child does not report an inherited Gateway model for another Agent', async () => {
  const home = mkdtempSync(join(tmpdir(), 'eigenflux-stream-model-'));
  const bin = join(home, 'eigenflux');
  const inherited = process.env.EIGENFLUX_MODEL;
  process.env.EIGENFLUX_MODEL = 'unrelated-gateway-model';
  writeFileSync(bin, `#!${process.execPath}
console.log(JSON.stringify({type:'test',data:{model:process.env.EIGENFLUX_MODEL || null}}));
setInterval(() => {}, 1000);
`, { mode: 0o700 });
  let deliver!: (event: PmStreamEvent) => void;
  const delivered = new Promise<PmStreamEvent>(resolve => { deliver = resolve; });
  let timeout: NodeJS.Timeout | undefined;
  const client = new EigenFluxStreamClient({
    serverName: 'owned-server', eigenfluxBin: bin,
    logger: new Logger({ info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() }),
    onPmEvent: async event => { deliver(event); }, onAuthRequired: async () => {},
  });
  try {
    await client.start();
    const event = await Promise.race([delivered, new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error('stream child did not respond')), 3000);
    })]);
    expect(event.data.model).toBeNull();
    expect(process.env.EIGENFLUX_MODEL).toBe('unrelated-gateway-model');
  } finally {
    clearTimeout(timeout);
    await client.stop();
    if (inherited === undefined) delete process.env.EIGENFLUX_MODEL; else process.env.EIGENFLUX_MODEL = inherited;
    rmSync(home, { recursive: true, force: true });
  }
});

test('legacy handoff waits for actual exit after SIGKILL', async () => {
  jest.useFakeTimers();
  const { EventEmitter } = await import('events');
  const child = Object.assign(new EventEmitter(), { kill: jest.fn(), exitCode: null, signalCode: null });
  const client = new EigenFluxStreamClient({
    serverName: 'owned-server', eigenfluxBin: 'unused',
    logger: new Logger({ info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() }),
    onPmEvent: async () => {}, onAuthRequired: async () => {},
  });
  Object.assign(client, { running: true, child });
  try {
    let settled = false;
    const stopping = client.stop().then(() => { settled = true; });
    await jest.advanceTimersByTimeAsync(5000);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(settled).toBe(false);
    child.emit('exit', null, 'SIGKILL');
    await stopping;
    expect(settled).toBe(true);
  } finally { jest.useRealTimers(); }
});

test('legacy stop rejects when the child never confirms exit', async () => {
  jest.useFakeTimers();
  const { EventEmitter } = await import('events');
  const child = Object.assign(new EventEmitter(), { kill: jest.fn(), exitCode: null, signalCode: null });
  const client = new EigenFluxStreamClient({
    serverName: 'owned-server', eigenfluxBin: 'unused',
    logger: new Logger({ info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() }),
    onPmEvent: async () => {}, onAuthRequired: async () => {},
  });
  Object.assign(client, { running: true, child });
  try {
    const rejected = expect(client.stop()).rejects.toThrow('replacement suppressed');
    await jest.advanceTimersByTimeAsync(10000);
    await rejected;
  } finally { jest.useRealTimers(); }
});
