/** Optional cross-repository test: uses a built CLI and loopback fixtures only. */
import { createServer } from 'http';
import { createHash, generateKeyPairSync } from 'crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { Socket } from 'net';
import { EigenFluxWatchClient } from './watch-client';
import { Logger } from './logger';

const integrationTest = process.env.EIGENFLUX_TEST_CLI ? test : test.skip;
integrationTest('built CLI watch drives scoped ready/PM/control and terminates on owner conflict', async () => {
  const dir=mkdtempSync(join(tmpdir(),'eigenflux-claw-cli-'));
  const home=join(dir,'.eigenflux');
  mkdirSync(join(home,'servers','fixture'),{recursive:true,mode:0o700});
  const logger=new Logger({info:jest.fn(),debug:jest.fn(),warn:jest.fn(),error:jest.fn()});
  const peers=new Set<Socket>();
  const seen:string[]=[];
  let peer:Socket|undefined;
  const server=createServer((req,res)=>{
    req.resume();
    if(req.headers.authorization!=='Bearer fixture-token'){res.writeHead(401).end();return;}
    if(req.url==='/api/v2/runtime/control/stream'){
      res.writeHead(200,{'Content-Type':'text/event-stream'});
      res.write('event: command_available\ndata: {"command_id":"55"}\n\n');return;
    }
    if(req.url==='/api/v2/runtime/heartbeat'){
      res.setHeader('Content-Type','application/json');
      res.end(JSON.stringify({code:0,data:{pending_command_ids:['55'],next_heartbeat_seconds:30}}));return;
    }
    res.writeHead(404).end();
  });
  server.on('connection',socket=>{peers.add(socket);socket.once('close',()=>peers.delete(socket));});
  server.on('upgrade',(req,socket)=>{
    peer=socket as Socket;
    const accept=createHash('sha1').update(String(req.headers['sec-websocket-key'])+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const body=Buffer.from(JSON.stringify({type:'pm_push',data:{messages:[{msg_id:'pm-1',conv_id:'conv-1',sender_id:'peer',content:'fixture',created_at:1}]}}));
    const head=body.length<126?Buffer.from([0x81,body.length]):Buffer.from([0x81,126,body.length>>8,body.length&255]);
    socket.write(Buffer.concat([head,body]));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=(server.address() as {port:number}).port;
  const kv={auto_cli_update:'false',auto_skill_sync:'false',auto_plugin_update:'false'};
  writeFileSync(join(home,'config.json'),JSON.stringify({default_server:'fixture',servers:[{name:'fixture',endpoint:`http://127.0.0.1:${port}`,stream_endpoint:`ws://127.0.0.1:${port}`,kv}],kv}),{mode:0o600});
  writeFileSync(join(home,'servers','fixture','agent-v2-credentials.json'),JSON.stringify({agent_id:'owned-agent',principal_id:'owned-principal',access_token:'fixture-token',refresh_token:'unused',expires_at:Date.now()+3600000}),{mode:0o600});
  const keys=generateKeyPairSync('ed25519');
  const seed=(keys.privateKey.export({format:'der',type:'pkcs8'}) as Buffer).subarray(-32);
  const pub=(keys.publicKey.export({format:'der',type:'spki'}) as Buffer).subarray(-32);
  writeFileSync(join(home,'servers','fixture','identity.json'),JSON.stringify({key_type:'ed25519-v1',private_key:Buffer.concat([seed,pub]).toString('base64url'),created_at:Date.now()}),{mode:0o600});
  let scope='';
  const stopped=jest.fn();
  const client=new EigenFluxWatchClient({eigenfluxBin:process.env.EIGENFLUX_TEST_CLI!,eigenfluxHome:home,serverName:'fixture',logger,
    onPmEvent:async e=>{scope=String((e as any).state_scope);seen.push(e.type);},
    onWatchEvent:async e=>{seen.push(e.type);},onAuthRequired:async()=>{throw new Error('fixture authorization failed');},onIdentityChanged:stopped});
  const wait=async(predicate:()=>boolean)=>{const end=Date.now()+6000;while(!predicate()){if(Date.now()>end)throw new Error('built CLI integration timed out: '+seen.join(','));await new Promise(resolve=>setTimeout(resolve,20));}};
  try{
    await client.start();
    await wait(()=>client.isReady()&&seen.includes('pm_push')&&seen.includes('control_pending'));
    expect(scope).toMatch(/^[a-f0-9]{32}$/);
    // The documented WebSocket replacement code must not provoke a reconnect fight.
    const close=Buffer.alloc(2);close.writeUInt16BE(4002);
    peer!.write(Buffer.concat([Buffer.from([0x88,2]),close]));
    await wait(()=>stopped.mock.calls.length===1&&!client.isRunning());
    expect(client.isReady()).toBe(false);
  }finally{
    await client.stop();
    for(const socket of peers)socket.destroy();
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    rmSync(dir,{recursive:true,force:true});
  }
},15000);
