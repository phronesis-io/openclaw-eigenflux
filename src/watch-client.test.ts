import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { EigenFluxWatchClient, supportsWatch, WatchEvent } from './watch-client';
import { Logger } from './logger';

const logger = new Logger({info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn()});
const clients: EigenFluxWatchClient[] = [];
let home: string;
const wait = async (condition: () => boolean) => {
  const until = Date.now() + 3000;
  while (!condition()) {
    if (Date.now() > until) throw new Error('condition timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'ef-watch-host-')); });
afterEach(async () => { await Promise.all(clients.splice(0).map(client => client.stop())); rmSync(home, { recursive: true, force: true }); });
function make(script: string, options: Record<string, unknown> = {}) {
  const bin = join(home, 'eigenflux');
  writeFileSync(bin, `#!${process.execPath}\nconst fs=require('fs');const home=${JSON.stringify(home)};const args=process.argv.slice(2);\n` + script, {mode:0o700});
  const pm = jest.fn().mockResolvedValue(undefined);
  const event = jest.fn().mockResolvedValue(undefined);
  const client = new EigenFluxWatchClient({ eigenfluxBin:bin, eigenfluxHome:home, serverName:'alpha', logger,
    onPmEvent:pm, onWatchEvent:event, onAuthRequired:async()=>{}, version:async()=> '1.0.0', retryMs:10, stopGraceMs:100, ...options });
  clients.push(client);
  return {client, pm, event};
}
const prelude = `
let n=0;
const send=(type,data={},scope='account-a')=>console.log(JSON.stringify({schema_version:'eigenflux_watch.v1',event_id:String(++n),state_scope:scope,type,data}));
const identity={home,server:'alpha',agent_id:'agent-a',cli_version:'1.0.0'};
send('started',identity);send('runtime_ready',identity);
`;

test.each([['0.0.46',false],['1.0.0',true],['2.1.0',true],['1.0.0-beta',false],['garbage',false],[null,false]])('capability gate %s', (version, expected) => {
  expect(supportsWatch(version as string|null)).toBe(expected);
});
test('explicit identity, clean environment and ready events precede independent transport events', async()=> {
  const old = process.env.EIGENFLUX_UPDATE_REEXEC;
  process.env.EIGENFLUX_UPDATE_REEXEC='1';
  try {
    const {client,pm,event}=make(prelude+`send('pm_push',{args,reexec:process.env.EIGENFLUX_UPDATE_REEXEC||null,messages:[]});send('profile_review_due');send('control_pending');send('maintenance_due');setInterval(()=>{},1000);`);
    await client.start();
    await wait(()=> event.mock.calls.length===3 && pm.mock.calls.length===1);
    expect(client.isReady()).toBe(true);
    expect(pm.mock.calls[0][0].data.args).toEqual(['--homedir',home,'--server','alpha','watch']);
    expect(pm.mock.calls[0][0].data.reexec).toBeNull();
    expect(pm.mock.calls[0][0].state_scope).toBe('account-a');
  } finally { if (old===undefined) delete process.env.EIGENFLUX_UPDATE_REEXEC; else process.env.EIGENFLUX_UPDATE_REEXEC=old; }
});
test('old CLI retains stream with explicit Home and server', async()=>{
  const {client,pm}=make(`console.log(JSON.stringify({type:'pm_push',data:{args}}));setInterval(()=>{},1000);`, {version:async()=> '0.0.46'});
  await client.start(); await wait(()=>pm.mock.calls.length===1);
  expect(client.isWatchEnabled()).toBe(false);
  expect(pm.mock.calls[0][0].data.args).toEqual(['stream','-s','alpha','-f','json','--homedir',home]);
});
test('changed account stops transport without following or dispatching it', async()=>{
  const onIdentityChanged=jest.fn();
  const {client,event}=make(prelude+`send('control_pending',{},'account-b');setInterval(()=>{},1000);`, {onIdentityChanged});
  await client.start();await wait(()=>!client.isRunning());
  expect(event).not.toHaveBeenCalled();
  expect(onIdentityChanged).toHaveBeenCalledTimes(1);
  await client.start();expect(client.isRunning()).toBe(false);
});
test('in-flight event types coalesce while PM and other types remain deliverable', async()=>{
  let release!:()=>void;
  const blocked = new Promise<void>(resolve=> {release=resolve;});
  const onWatchEvent=jest.fn((e:WatchEvent)=>e.type==='maintenance_due'?blocked:Promise.resolve());
  const {client,pm}=make(prelude+`send('maintenance_due');send('maintenance_due');send('control_pending');send('pm_push',{messages:[]});setInterval(()=>{},1000);`,{onWatchEvent});
  await client.start();await wait(()=>onWatchEvent.mock.calls.length===2 && pm.mock.calls.length===1);
  release();
});
test('upgrade waits for old process exit, keeps identity, and can upgrade twice', async()=>{
  const file=join(home,'runs');
  const {client}=make(`
const file=home+'/runs'; const runs=fs.existsSync(file)?Number(fs.readFileSync(file,'utf8'))+1:1;fs.writeFileSync(file,String(runs));
process.on('SIGTERM',()=>setTimeout(()=>{fs.appendFileSync(home+'/exits',String(runs));process.exit(0);},30));
const version='1.0.'+(runs-1);let n=0;
const send=(type,data)=>console.log(JSON.stringify({schema_version:'eigenflux_watch.v1',event_id:String(++n),state_scope:'a',type,data}));
const identity={home,server:'alpha',agent_id:'agent-a',cli_version:version};send('started',identity);send('runtime_ready',identity);
if(runs<3) send('restart_required',{cli_version:'1.0.'+runs});
setInterval(()=>{},1000);
`);
  await client.start();await wait(()=>existsSync(file)&&readFileSync(file,'utf8')==='3'&&client.isReady());
  expect(readFileSync(join(home,'exits'),'utf8')).toBe('12');
  await client.stop();
  expect(readFileSync(join(home,'exits'),'utf8')).toBe('123');
});

test('a replacement still running the old version cannot report ready for the upgrade', async()=>{
  const file=join(home,'runs');
  const {client}=make(`
const file=home+'/runs';const runs=fs.existsSync(file)?Number(fs.readFileSync(file,'utf8'))+1:1;fs.writeFileSync(file,String(runs));
let n=0;const send=(type,data)=>console.log(JSON.stringify({schema_version:'eigenflux_watch.v1',event_id:String(++n),state_scope:'a',type,data}));
const identity={home,server:'alpha',agent_id:'agent-a',cli_version:'1.0.0'};
send('started',identity);send('runtime_ready',identity);if(runs===1)send('restart_required',{cli_version:'1.0.1'});
setInterval(()=>{},1000);
`, {retryMs:1000});
  await client.start();await wait(()=>existsSync(file)&&readFileSync(file,'utf8')==='2'&&!client.isRunning());
  expect(client.isReady()).toBe(false);
});

test('fatal exit 78 stops the whole account even when no diagnostic reaches stdout', async()=>{
  const onIdentityChanged=jest.fn();
  const {client}=make(`process.exit(78);`, {onIdentityChanged});
  await client.start();
  await wait(()=>onIdentityChanged.mock.calls.length===1 && !client.isRunning());
  await client.start();
  expect(client.isRunning()).toBe(false);
});

test('a slow PM does not block another conversation and bursts drain without stopping watch', async () => {
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const onPmEvent = jest.fn(async () => blocked);
  const { client } = make(prelude + `for(let i=0;i<65;i++)send('pm_push',{messages:[{conv_id:String(i)}]});setInterval(()=>{},1000);`, { onPmEvent });
  await client.start();
  await wait(() => onPmEvent.mock.calls.length >= 2);
  expect(client.isRunning()).toBe(true);
  release();
  await wait(() => onPmEvent.mock.calls.length === 65);
  expect(client.isRunning()).toBe(true);
});

test('build metadata cannot hide a replacement running an older patch', async () => {
  const file = join(home, 'runs');
  const { client } = make(`
const file=home+'/runs';const runs=fs.existsSync(file)?Number(fs.readFileSync(file,'utf8'))+1:1;fs.writeFileSync(file,String(runs));
let n=0;const send=(type,data)=>console.log(JSON.stringify({schema_version:'eigenflux_watch.v1',event_id:String(++n),state_scope:'a',type,data}));
const identity={home,server:'alpha',agent_id:'agent-a',cli_version:'1.0.0+old'};
send('started',identity);send('runtime_ready',identity);if(runs===1)send('restart_required',{cli_version:'1.0.1+new'});
setInterval(()=>{},1000);
`, { retryMs: 1000 });
  await client.start();
  await wait(() => existsSync(file) && readFileSync(file, 'utf8') === '2' && !client.isRunning());
  expect(client.isReady()).toBe(false);
});

test('exhausted process retries notify the host instead of leaving a silent maintenance owner', async () => {
  const onFatal = jest.fn();
  const { client } = make(`process.exit(1);`, { onFatal, retryMs: 1 });
  await client.start();
  await wait(() => onFatal.mock.calls.length === 1);
  expect(client.isRunning()).toBe(false);
  await client.start();
  expect(client.isRunning()).toBe(false);
});

test.each(['identity', 'fatal'])('PM microtasks cannot start after a same-chunk %s stop', async reason => {
  const { client, pm } = make('');
  Object.assign(client, { running: true, watch: true, started: true, scope: 'account-a' });
  (client as any).receive(JSON.stringify({ schema_version: 'eigenflux_watch.v1', event_id: 'pm-1', state_scope: 'account-a', type: 'pm_push', data: { messages: [] } }));
  if (reason === 'identity') {
    (client as any).receive(JSON.stringify({ schema_version: 'eigenflux_watch.v1', event_id: 'identity-1', state_scope: 'account-a', type: 'diagnostic', data: { code: 'identity_changed' } }));
  } else {
    (client as any).fail(new Error('fatal'));
  }
  await Promise.resolve();
  expect(pm).not.toHaveBeenCalled();
});

test.each(['identity', 'fatal'])('a resolved plan cannot outrun the synchronous %s host stop', async reason => {
  let active = true;
  let resolvePlan!: () => void;
  const plan = new Promise<void>(resolve => { resolvePlan = resolve; });
  const deliver = jest.fn();
  const onWatchEvent = jest.fn(async () => {
    await plan;
    if (active) deliver();
  });
  const stopHost = () => { active = false; };
  const { client } = make('', { onWatchEvent, onIdentityChanged: stopHost, onFatal: stopHost });
  Object.assign(client, { running: true, watch: true, started: true, scope: 'account-a' });
  (client as any).receive(JSON.stringify({ schema_version: 'eigenflux_watch.v1', event_id: 'control-1', state_scope: 'account-a', type: 'control_pending', data: {} }));
  await Promise.resolve();
  expect(onWatchEvent).toHaveBeenCalledTimes(1);
  resolvePlan();
  if (reason === 'identity') {
    (client as any).receive(JSON.stringify({ schema_version: 'eigenflux_watch.v1', event_id: 'identity-1', state_scope: 'account-a', type: 'diagnostic', data: { code: 'identity_changed' } }));
  } else {
    (client as any).fail(new Error('fatal'));
  }
  expect(active).toBe(false);
  await Promise.resolve();
  expect(deliver).not.toHaveBeenCalled();
});
