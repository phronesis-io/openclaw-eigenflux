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
