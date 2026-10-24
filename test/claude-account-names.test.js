import test, {before,after} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {randomBytes} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const directory=mkdtempSync(join(tmpdir(),'aigate-vault-names-'));
const ADMIN=randomBytes(24).toString('hex'),GATEWAY='dummy-name-test-gateway';
const names=['work!','personal#2','José','long-'+ 'x'.repeat(160)];
const tokens=names.map((_,i)=>'sk-ant-oat01-dummy-manual-name-'+i);
const seenCaptures=new Set(),probes=[];
const MODEL='claude-sonnet-4-6';
const quotas=()=>({
  'anthropic-ratelimit-unified-5h-utilization':'.2',
  'anthropic-ratelimit-unified-7d-utilization':'.25',
  'anthropic-ratelimit-unified-5h-reset':String(Math.floor(Date.now()/1000)+10000),
  'anthropic-ratelimit-unified-7d-reset':String(Math.floor(Date.now()/1000)+20000)
});
function responseBytes(index,stream) {
  const message={id:'msg-vault-name-'+index,type:'message',role:'assistant',model:MODEL,content:[],stop_reason:'end_turn',usage:{input_tokens:7,output_tokens:4,cache_read_input_tokens:2}};
  if(!stream)return JSON.stringify(message);
  const events=[{type:'message_start',message:{...message,stop_reason:null,usage:{...message.usage,output_tokens:0}}},
    {type:'message_delta',usage:{output_tokens:4},delta:{stop_reason:'end_turn'}},{type:'message_stop'}];
  return events.map(event=>`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}
const upstream=http.createServer(async(req,res)=>{
  req.on('error',()=>{});
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  const body=JSON.parse(Buffer.concat(chunks).toString());
  const index=tokens.findIndex(token=>req.headers.authorization==='Bearer '+token);
  if(index<0 || req.url!='/v1/messages'){res.writeHead(400);res.end('invalid dummy request');return;}
  if(body.max_tokens===1){
    probes.push(names[index]);res.writeHead(200,{...quotas(),'content-type':'application/json'});
    res.end(JSON.stringify({type:'message',usage:{input_tokens:1,output_tokens:1}}));return;
  }
  res.writeHead(200,{...quotas(),'content-type':body.stream?'text/event-stream':'application/json'});
  const bytes=responseBytes(index,body.stream);
  // Exercise the observer and capture across transport chunks.
  res.write(bytes.slice(0,Math.floor(bytes.length/2)));res.end(bytes.slice(Math.floor(bytes.length/2)));
});
await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
Object.assign(process.env,{
  AIGATE_DB:join(directory,'vault.db'),AIGATE_TOKEN:ADMIN,AIGATE_PROXY_TOKEN:GATEWAY,
  AIGATE_ENCRYPTION_KEY:randomBytes(32).toString('hex'),AIGATE_POLL_MS:'0',AIGATE_KEY_POLL_MS:'0',AIGATE_WATCHDOG_MS:'0',
  AIGATE_TRANSPARENT_UPSTREAM_CLAUDE_CODE:`http://127.0.0.1:${upstream.address().port}`
});
delete process.env.AIGATE_ALLOW_CIDR;
const {server,db,claudePool}=await import('../src/server.js');
let base;
const admin=(path,method='GET',body)=>fetch(base+path,{method,headers:{authorization:'Bearer '+ADMIN,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
const accountPath=name=>'/api/accounts/'+encodeURIComponent(name);
const request=stream=>new Promise((resolve,reject)=>{
  const req=http.request(base+'/proxy/claude-code/v1/messages',{method:'POST',headers:{authorization:'Bearer '+GATEWAY,'content-type':'application/json'}},res=>{
    const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('error',reject);
    res.on('aborted',()=>reject(new Error('downstream response aborted')));
    res.on('end',()=>resolve({status:res.statusCode,body:Buffer.concat(chunks).toString(),complete:res.complete}));
  });
  req.on('error',reject);req.setTimeout(5000,()=>req.destroy(new Error('mock relay timeout')));
  req.end(JSON.stringify({model:MODEL,max_tokens:10,messages:[],stream}));
});
async function nextCapture() {
  for(let i=0;i<200;i++){
    const list=await(await admin('/api/proxy/traffic')).json();
    const item=list.find(row=>row.provider==='claude-code'&&!seenCaptures.has(row.id));
    if(item&&item.state!=='running'){
      seenCaptures.add(item.id);
      return(await admin('/api/proxy/traffic/'+item.id+'?limit=1000')).json();
    }
    await new Promise(resolve=>setTimeout(resolve,5));
  }
  throw new Error('capture did not finish');
}
before(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${server.address().port}`;
  for(const [i,account]of names.entries()){
    assert.equal((await admin('/api/accounts','POST',{account,setup_token:tokens[i]})).status,200);
    assert.equal((await admin(accountPath(account)+'/disabled','POST',{disabled:true})).status,200);
  }
});
after(async()=>{
  await claudePool.stop();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  upstream.closeAllConnections();await new Promise(resolve=>upstream.close(resolve));
  db.close();rmSync(directory,{recursive:true,force:true});
});

for(const [index,name]of names.entries())test('native JSON/SSE preserve completed usage and capture for vault name '+index,async()=>{
  assert.equal((await admin(accountPath(name)+'/disabled','POST',{disabled:false})).status,200);
  const refresh=await admin(accountPath(name)+'/refresh','POST',{});assert.equal(refresh.status,200);
  assert.ok(probes.includes(name));
  const state=await(await admin('/api/proxy/claude-code/status?model='+MODEL)).json();
  assert.equal(state.next_account,name);
  for(const stream of [false,true,false,true]){
    const result=await request(stream);
    assert.equal(result.status,200);assert.equal(result.complete,true);assert.equal(result.body,responseBytes(index,stream));
    const row=db.prepare('SELECT * FROM usage_events WHERE source=? AND source_event_id=?').get('claude_code','msg-vault-name-'+index);
    assert.equal(row.account,name);assert.equal(row.billing,'subscription');assert.equal(row.input_tokens,7);assert.equal(row.output_tokens,4);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM usage_events WHERE source_event_id=?').get('msg-vault-name-'+index).n,1);
    const capture=await nextCapture();assert.equal(capture.state,'complete');
    assert.equal(capture.events.filter(event=>event.type==='end').length,1);
    assert.equal(capture.events.some(event=>event.type==='error'),false);
    const captured=Buffer.concat(capture.events.filter(event=>event.type==='response_body').map(event=>Buffer.from(event.data,'base64'))).toString();
    assert.equal(captured,result.body);
  }
  assert.equal((await admin(accountPath(name)+'/disabled','POST',{disabled:true})).status,200);
});

test('public usage events still reject caller-supplied account attribution',async()=>{
  const response=await admin('/api/spend/events','POST',{source:'claude_code',host:'mock',events:[{
    source_event_id:'msg-public-override',ts:new Date().toISOString(),provider:'anthropic',model:MODEL,input_tokens:1,output_tokens:1,account:names[0]
  }]});
  assert.equal(response.status,400);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM usage_events WHERE source_event_id=?').get('msg-public-override').n,0);
});
