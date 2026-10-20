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

test('order notification pagination cannot overwrite the PM reconnect cursor', async () => {
  const onPmEvent = jest.fn().mockResolvedValue(undefined);
  const client = new EigenFluxStreamClient({ serverName: 'test', eigenfluxBin: 'unused',
    logger: new Logger({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
    onPmEvent, onAuthRequired: async () => {},
  });
  const line = (event: unknown) => (client as any).handleLine(JSON.stringify(event));
  line({ type: 'pm_push', data: { next_cursor: '358859368915009536' } });
  line({ type: 'notification_push', data: { next_cursor: 'opaque-notification-page', notifications: [] } });
  line({ type: 'commission_order_notification', notification: { notification_id: '1' } });
  expect(client.getLastCursor()).toBe('358859368915009536');
  expect(onPmEvent).toHaveBeenCalledTimes(3);
});

test('an auth exit forwards the final CLI owner action after stderr drainage with a bounded tail', async () => {
  const home = mkdtempSync(join(tmpdir(), 'eigenflux-stream-auth-'));
  const bin = join(home, 'eigenflux');
  const notice = JSON.stringify({ schema_version: 'eigenflux_auth_required.v1',
    code: 'REFRESH_INVALID', owner_action: 'Reply "Recover my current EigenFlux account".' });
  writeFileSync(bin, `#!${process.execPath}
process.stderr.write('earlier-diagnostic:' + 'x'.repeat(20000), () => {
  process.stderr.write('\\n' + ${JSON.stringify(notice)} + '\\n', () => { process.exitCode = 4; });
});
`, { mode: 0o700 });
  let receive!: (detail?: string) => void;
  const received = new Promise<string | undefined>(resolve => { receive = resolve; });
  let timeout: NodeJS.Timeout | undefined;
  const client = new EigenFluxStreamClient({
    serverName: 'owned-server', eigenfluxBin: bin,
    logger: new Logger({ info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() }),
    onPmEvent: async () => {}, onAuthRequired: async detail => { receive(detail); },
  });
  try {
    await client.start();
    const detail = await Promise.race([received, new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error('stream auth notice did not arrive')), 3000);
    })]);
    expect(detail).toContain(notice);
    expect(detail).not.toContain('earlier-diagnostic:');
    expect(detail!.length).toBeLessThanOrEqual(16_384);
  } finally {
    clearTimeout(timeout);
    await client.stop();
    rmSync(home, { recursive: true, force: true });
  }
});

test('a spawn failure schedules one reconnect when error is followed by close', async () => {
  const home = mkdtempSync(join(tmpdir(), 'eigenflux-stream-spawn-'));
  let reconnect!: () => void;
  const reconnected = new Promise<void>(resolve => { reconnect = resolve; });
  const info = jest.fn((message: string) => {
    if (message.includes('Stream reconnecting')) reconnect();
  });
  const onStreamError = jest.fn();
  let timeout: NodeJS.Timeout | undefined;
  const client = new EigenFluxStreamClient({
    serverName: 'owned-server', eigenfluxBin: join(home, 'missing-cli'),
    logger: new Logger({ info, debug: jest.fn(), warn: jest.fn(), error: jest.fn() }),
    onPmEvent: async () => {}, onAuthRequired: async () => {}, onStreamError,
  });
  try {
    await client.start();
    await Promise.race([reconnected, new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error('spawn failure did not schedule a reconnect')), 3000);
    })]);
    expect(onStreamError).toHaveBeenCalledTimes(1);
    expect(info.mock.calls.filter(([message]) => message.includes('Stream reconnecting')))
      .toEqual([['[EigenFlux] Stream reconnecting in 1000ms (failure #1) for server=owned-server']]);
  } finally {
    clearTimeout(timeout);
    await client.stop();
    rmSync(home, { recursive: true, force: true });
  }
});
