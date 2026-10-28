import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { EigenFluxStreamClient, type PmStreamEvent } from './stream-client';
import { Logger } from './logger';

const logger = () => new Logger({ info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() });
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 4000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('stream lifecycle did not settle');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'eigenflux-claw-adopt-'));
  const bin = join(home, 'eigenflux');
  const versionPath = join(home, 'version');
  const logPath = join(home, 'processes');
  writeFileSync(versionPath, '0.6.6');
  writeFileSync(logPath, '');
  writeFileSync(bin, `#!${process.execPath}
const fs=require('fs');
const version=fs.readFileSync(${JSON.stringify(versionPath)},'utf8');
const record=(kind)=>fs.appendFileSync(${JSON.stringify(logPath)},JSON.stringify({kind,pid:process.pid,version})+'\\n');
record('start');
process.on('SIGTERM',()=>{
  record('term');
  console.log(JSON.stringify({type:'tail',data:{version,next_cursor:'358859368915009536'}}));
  setTimeout(()=>{record('exit');process.exit(0)},80);
});
console.log(JSON.stringify({type:'ready',data:{version,pid:process.pid,args:process.argv.slice(2),home:process.env.EIGENFLUX_HOME}}));
setInterval(()=>{},1000);
`, { mode: 0o700 });
  return {
    home, bin, versionPath,
    records: () => readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)),
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

test('unknown stream adopts a modern plan after delivery, trailing stdout and actual close, preserving Home/server/cursor', async () => {
  const f = fixture();
  const first = deferred();
  const tail = deferred();
  const events: PmStreamEvent[] = [];
  const client = new EigenFluxStreamClient({ eigenfluxBin: f.bin, eigenfluxHome: f.home,
    serverName: 'stable-server', logger: logger(), onAuthRequired: async () => {},
    onPmEvent: async event => {
      events.push(event);
      if (event.type === 'ready' && event.data.version === '0.6.6') await first.promise;
      if (event.type === 'tail' && event.data.version === '0.6.6') await tail.promise;
    },
  });
  try {
    await client.start();
    await until(() => events.some(event => event.type === 'ready'));
    writeFileSync(f.versionPath, '0.6.7');
    const adoption = client.adoptCLIVersion('0.6.7');
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(f.records().map(record => record.kind)).toEqual(['start']);
    first.resolve();
    await until(() => events.some(event => event.type === 'tail'));
    await until(() => f.records().some(record => record.kind === 'exit'));
    expect(f.records().filter(record => record.kind === 'start')).toHaveLength(1);
    tail.resolve();
    await adoption;
    await until(() => events.some(event => event.type === 'ready' && event.data.version === '0.6.7'));
    const next = events.find(event => event.type === 'ready' && event.data.version === '0.6.7')!;
    expect(next.data.args).toEqual(['stream', '-s', 'stable-server', '-f', 'json', '--homedir', f.home,
      '--cursor', '358859368915009536']);
    expect(next.data.home).toBe(f.home);
    expect(f.records().map(record => record.kind)).toEqual(['start', 'term', 'exit', 'start']);
    await Promise.all([client.adoptCLIVersion('0.6.7'), client.adoptCLIVersion('0.6.7')]);
    expect(f.records().filter(record => record.kind === 'start')).toHaveLength(2);
  } finally {
    first.resolve(); tail.resolve();
    await client.stop();
    f.cleanup();
  }
});

test('stop during delayed version adoption prevents any replacement or late heartbeat restart', async () => {
  const f = fixture();
  const delivery = deferred();
  let received = false;
  const client = new EigenFluxStreamClient({ eigenfluxBin: f.bin, eigenfluxHome: f.home,
    serverName: 'stable-server', logger: logger(), onAuthRequired: async () => {},
    onPmEvent: async event => { if (event.type === 'ready') { received = true; await delivery.promise; } },
  });
  try {
    await client.start();
    await until(() => received);
    const adopting = client.adoptCLIVersion('0.6.7');
    const stopping = client.stop();
    await until(() => f.records().some(record => record.kind === 'exit'));
    delivery.resolve();
    await Promise.all([adopting, stopping]);
    await client.adoptCLIVersion('0.6.8');
    expect(client.isRunning()).toBe(false);
    expect(f.records().filter(record => record.kind === 'start')).toHaveLength(1);
  } finally { delivery.resolve(); await client.stop(); f.cleanup(); }
});

test('legacy and invalid plans leave the existing stream intact', async () => {
  const f = fixture();
  const events: PmStreamEvent[] = [];
  const client = new EigenFluxStreamClient({ eigenfluxBin: f.bin, eigenfluxHome: f.home,
    serverName: 'stable-server', logger: logger(), onAuthRequired: async () => {},
    onPmEvent: async event => { events.push(event); },
  });
  try {
    await client.start();
    await until(() => events.length > 0);
    for (const value of [undefined, '', 'dev', '0.6.7; touch /tmp/no', '01.6.7']) await client.adoptCLIVersion(value);
    expect(f.records().map(record => record.kind)).toEqual(['start']);
  } finally { await client.stop(); f.cleanup(); }
});

test('slow host delivery defers adoption within a deadline and remains retryable', async () => {
  const f = fixture();
  const delivery = deferred();
  let received = false;
  const client = new EigenFluxStreamClient({ eigenfluxBin: f.bin, eigenfluxHome: f.home,
    serverName: 'stable-server', logger: logger(), onAuthRequired: async () => {},
    onPmEvent: async event => { if (event.type === 'ready' && event.data.version === '0.6.6') { received = true; await delivery.promise; } },
  });
  try {
    await client.start();
    await until(() => received);
    writeFileSync(f.versionPath, '0.6.7');
    jest.useFakeTimers();
    const adopting = client.adoptCLIVersion('0.6.7');
    await jest.advanceTimersByTimeAsync(30_000);
    await adopting;
    expect(f.records().map(record => record.kind)).toEqual(['start']);
    jest.useRealTimers();
    delivery.resolve();
    await client.adoptCLIVersion('0.6.7');
    await until(() => f.records().filter(record => record.kind === 'start').length === 2);
  } finally { jest.useRealTimers(); delivery.resolve(); await client.stop(); f.cleanup(); }
});

test('an unconfirmed close after forced termination never starts an overlapping stream', async () => {
  jest.useFakeTimers();
  const kill = jest.fn().mockReturnValue(true);
  const client = new EigenFluxStreamClient({ eigenfluxBin: 'unused', serverName: 'stable', logger: logger(),
    onAuthRequired: async () => {}, onPmEvent: async () => {},
  });
  const internals = client as any;
  internals.running = true;
  internals.child = { kill };
  internals.childClosed = new Promise(() => {});
  const spawn = jest.spyOn(internals, 'spawnStreamProcess');
  try {
    const adopting = client.adoptCLIVersion('0.6.7');
    await jest.advanceTimersByTimeAsync(6_000);
    await adopting;
    expect(kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
    expect(spawn).not.toHaveBeenCalled();
    expect(internals.cliVersion).toBeUndefined();
    const stopping = client.stop();
    await jest.advanceTimersByTimeAsync(6_000);
    await stopping;
    await client.start();
    expect(spawn).not.toHaveBeenCalled();
  } finally { jest.useRealTimers(); }
});

test('service stop has a bounded wait for a stalled host delivery', async () => {
  jest.useFakeTimers();
  const client = new EigenFluxStreamClient({ eigenfluxBin: 'unused', serverName: 'stable', logger: logger(),
    onAuthRequired: async () => {}, onPmEvent: async () => {},
  });
  (client as any).running = true;
  (client as any).pendingDeliveries.add(new Promise(() => {}));
  try {
    const stopping = client.stop();
    await jest.advanceTimersByTimeAsync(30_000);
    await stopping;
    expect(client.isRunning()).toBe(false);
  } finally { jest.useRealTimers(); }
});

test('late reconnect callbacks cannot spawn another child over an active replacement', async () => {
  const f = fixture();
  let ready = false;
  const client = new EigenFluxStreamClient({ eigenfluxBin: f.bin, eigenfluxHome: f.home,
    serverName: 'stable-server', logger: logger(), onAuthRequired: async () => {},
    onPmEvent: async event => { if (event.type === 'ready') ready = true; },
  });
  try {
    await client.start();
    await until(() => ready);
    (client as any).scheduleRestart((client as any).generation);
    (client as any).spawnStreamProcess();
    await new Promise(resolve => setTimeout(resolve, 1100));
    expect(f.records().filter(record => record.kind === 'start')).toHaveLength(1);
  } finally { await client.stop(); f.cleanup(); }
});

test('a handoff from a stopped lifecycle cannot replace a newly started stream', async () => {
  const oldDelivery = deferred();
  const client = new EigenFluxStreamClient({ eigenfluxBin: 'unused', serverName: 'stable', logger: logger(),
    onAuthRequired: async () => {}, onPmEvent: async () => {},
  });
  const internals = client as any;
  internals.running = true;
  const spawn = jest.spyOn(internals, 'spawnStreamProcess').mockImplementation(() => {});
  jest.spyOn(internals, 'waitForDeliveries')
    .mockImplementationOnce(() => oldDelivery.promise.then(() => true)).mockResolvedValue(true);
  const adopting = client.adoptCLIVersion('0.6.7');
  await client.stop();
  await client.start();
  oldDelivery.resolve();
  await adopting;
  expect(client.isRunning()).toBe(true);
  expect(spawn).toHaveBeenCalledTimes(1);
  expect(internals.cliVersion).toBeUndefined();
  await client.stop();
});

test('a delivery timeout before TERM preserves natural stream reconnection', async () => {
  const f = fixture();
  const delivery = deferred();
  let received = false;
  const client = new EigenFluxStreamClient({ eigenfluxBin: f.bin, eigenfluxHome: f.home,
    serverName: 'stable-server', logger: logger(), onAuthRequired: async () => {},
    onPmEvent: async event => {
      if (event.type === 'ready' && !received) {
        received = true;
        await delivery.promise;
      }
    },
  });
  try {
    await client.start();
    await until(() => received);
    jest.useFakeTimers();
    const adopting = client.adoptCLIVersion('0.6.7');
    await jest.advanceTimersByTimeAsync(30_000);
    await adopting;
    expect((client as any).adopting).toBe(false);
    expect(f.records().map(record => record.kind)).toEqual(['start']);
    jest.useRealTimers();
    (client as any).child.kill('SIGTERM');
    await until(() => f.records().filter(record => record.kind === 'start').length === 2);
    expect(client.isRunning()).toBe(true);
    expect(f.records().map(record => record.kind)).toEqual(['start', 'term', 'exit', 'start']);
  } finally { jest.useRealTimers(); delivery.resolve(); await client.stop(); f.cleanup(); }
});
