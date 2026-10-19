import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer as createNetServer } from 'node:net';
import { pathToFileURL } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { createHmac } from 'node:crypto';
import { validateItems } from '../domain.js';

let dir, child, base;
const auth='Basic '+Buffer.from('admin:test-private-password').toString('base64');
async function start(ai=false,provider='openai',overrides={}){
  child=spawn(process.execPath,[...(ai?['--import',pathToFileURL(join(dir,'mock-provider.mjs')).href]:[]),'server.js'],{cwd:dir,env:{...process.env,HOST:'127.0.0.1',PORT:'0',GEMINI_MODEL:'gemini-test-flash',AI_PROVIDER:provider,GEMINI_API_KEY:ai&&provider==='gemini'?'test-gemini-key':'',OPENAI_API_KEY:ai?'sk-test-key':'',DASHBOARD_PASSWORD:'test-private-password',DASHBOARD_USER:'admin',WHATSAPP_APP_SECRET:'test-secret',WHATSAPP_VERIFY_TOKEN:'test-verification',WHATSAPP_ALLOWED_FROM:'56912345678',WHATSAPP_PHONE_NUMBER_ID:'',WHATSAPP_WEBHOOK_PORT:'',WHATSAPP_ACCESS_TOKEN:'dummy-test-token',...overrides},stdio:['ignore','pipe','pipe']});
  let logs='';
  await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('Server startup timeout: '+logs)),10000);child.stdout.on('data',data=>{logs+=data;const match=logs.match(/puerto (\d+)/);if(match){base=`http://127.0.0.1:${match[1]}`;clearTimeout(timeout);resolve();}});child.once('exit',code=>{clearTimeout(timeout);reject(new Error('Server exited: '+code));});});
}
async function stop(){if(child?.exitCode===null){const exited=once(child,'exit');child.kill('SIGTERM');await exited;}}
async function api(path,method='GET',data){return fetch(base+path,{method,headers:{Authorization:auth,...(data?{'Content-Type':'application/json'}:{})},body:data?JSON.stringify(data):undefined});}
const state=async()=> (await api('/api/state')).json();
before(async()=>{dir=await mkdtemp(join(tmpdir(),'hilo-test-'));for(const file of ['server.js','domain.js','ai.js','gemini.js','whatsapp.js','public'])await cp(new URL('../'+file,import.meta.url),join(dir,file),{recursive:true});await start();});
after(async()=>{await stop();await rm(dir,{recursive:true,force:true});});
test('rejects invalid item categories and impossible dates',()=>{
  assert.throws(()=>validateItems([{title:'x',category:'inventada'}]));
  assert.throws(()=>validateItems([{title:'x',category:'tarea',dueDate:'2026-02-30'}]));
  assert.equal(validateItems([{title:'Enviar propuesta',category:'tarea',dueDate:'2026-10-23'}])[0].done,false);
});
test('personal dashboard requires authentication and prevents cross-origin writes',async()=>{
  assert.equal((await fetch(base+'/api/state')).status,401);
  const page=await api('/');assert.equal(page.status,200);assert.match(await page.text(),/Todo empieza/);
  const bad=await fetch(base+'/api/projects',{method:'POST',headers:{Authorization:auth,Origin:'https://untrusted.example','Content-Type':'application/json'},body:'{"name":"intrusion"}'});assert.equal(bad.status,403);
});
test('notes can be organized, searched in stored data, completed and retained after restart',async()=>{
  assert.equal((await api('/api/projects','POST',{name:'Norte'})).status,201);
  assert.equal((await api('/api/notes','POST',{text:'Enviar el presupuesto el viernes. También ofrecer mantenimiento.'})).status,201);
  let s=await state();assert.deepEqual(s.projects,['Norte']);assert.equal(s.notes.length,1);assert.equal(s.notes[0].classified,false);
  const id=s.notes[0].id;
  assert.equal((await api(`/api/notes/${id}`,'PATCH',{items:[{title:'Enviar presupuesto',category:'tarea',project:'Norte',dueDate:'2026-10-23',done:true},{title:'Ofrecer mantenimiento',category:'idea',project:'Norte',dueDate:null,done:false}]})).status,200);
  await stop();await start();s=await state();assert.equal(s.notes[0].items.length,2);assert.equal(s.notes[0].items[0].done,true);assert.match(s.notes[0].transcript,/presupuesto/);
  assert.equal((await api(`/api/notes/${id}`,'PATCH',{items:[{title:'Bad',category:'unknown'}]})).status,400);
  assert.equal((await api('/api/audio','POST')).status,503);
});
test('WhatsApp verifies subscriptions, signatures, sender and duplicate delivery',async()=>{
  const verification=await fetch(base+'/webhook?hub.mode=subscribe&hub.verify_token=test-verification&hub.challenge=12345');assert.equal(await verification.text(),'12345');
  assert.equal((await fetch(base+'/webhook?hub.mode=subscribe&hub.verify_token=wrong')).status,403);
  const payload=JSON.stringify({entry:[{changes:[{value:{messages:[{id:'wamid.test-1',from:'56912345678',timestamp:'1792353600',type:'text',text:{body:'Idea para Norte: mantenimiento mensual'}},{id:'wamid.other',from:'56999999999',type:'text',text:{body:'Unwanted'}}]}}]}]});
  assert.equal((await fetch(base+'/webhook',{method:'POST',body:payload})).status,403);
  const send=()=>fetch(base+'/webhook',{method:'POST',headers:{'x-hub-signature-256':'sha256='+createHmac('sha256','test-secret').update(payload).digest('hex'),'Content-Type':'application/json'},body:payload});
  assert.equal((await send()).status,200);assert.equal((await send()).status,200);
  let s;
  for(let i=0;i<30;i++){s=await state();if(s.notes.some(n=>n.id==='wamid.test-1'))break;await new Promise(r=>setTimeout(r,100));}
  assert.equal(s.notes.filter(n=>n.id==='wamid.test-1').length,1);assert.equal(s.notes.some(n=>n.id==='wamid.other'),false);assert.equal(s.notes.find(n=>n.id==='wamid.test-1').source,'whatsapp');
});


test('configured OpenAI flows from connection check through audio transcription to stored elements',async()=>{
  await stop();
  await writeFile(join(dir,'mock-provider.mjs'), `
    const original=globalThis.fetch;
    globalThis.fetch=async(url, options)=>{
      if(!String(url).startsWith('https://api.openai.com/')) return original(url,options);
      if(String(url).endsWith('audio/transcriptions')) return Response.json({text:'Para Norte: enviar presupuesto y ofrecer soporte.'});
      const request=JSON.parse(options.body);
      if(request.messages[1].content==='rechazar') return Response.json({error:{code:'invalid_api_key'}},{status:401});
      return Response.json({choices:[{message:{content:JSON.stringify({items:[{title:'Enviar presupuesto',category:'tarea',project:'Norte',dueDate:null},{title:'Ofrecer soporte',category:'idea',project:'Norte',dueDate:null}]})}}]});
    };
  `);
  await start(true);
  const checked=await api('/api/ai/check','POST');assert.equal(checked.status,200);assert.match((await checked.json()).message,/respondió correctamente/);
  const upload=await fetch(base+'/api/audio',{method:'POST',headers:{Authorization:auth,'Content-Type':'audio/ogg'},body:Buffer.from('fake-audio')});
  assert.equal(upload.status,201);const saved=await upload.json();
  const s=await state();const note=s.notes.find(n=>n.id===saved.id);
  assert.equal(note.classified,true);assert.equal(note.source,'audio');assert.match(note.transcript,/Para Norte/);assert.equal(note.items.length,2);assert.equal(note.items[1].category,'idea');assert.equal(note.items[0].project,'Norte');
  const failure=await api('/api/notes','POST',{text:'rechazar'});assert.equal(failure.status,201);
  const failed=await failure.json();assert.match(failed.warning,/rechazó la clave/);
  assert.equal((await state()).notes.find(n=>n.id===failed.id).classified,false);
});

test('Gemini works end to end without OpenAI and exposes the active provider',async()=>{
  await stop();
  await writeFile(join(dir,'mock-provider.mjs'), `
    globalThis.fetch=async(url, options)=>{
      if(!String(url).startsWith('https://generativelanguage.googleapis.com/')) throw new Error('Unexpected provider');
      const payload=JSON.parse(options.body);
      const value=payload.contents[0].parts[0].inlineData ? {text:'Para Norte: enviar propuesta.'} : {items:[{title:'Enviar propuesta',category:'tarea',project:'Norte',dueDate:null}]};
      return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(value)}]}}]});
    };
  `);
  await start(true,'gemini');
  const s=await state();assert.equal(s.capabilities.aiProvider,'Gemini');assert.equal(s.capabilities.maxAudioBytes,14*1024*1024);
  const check=await api('/api/ai/check','POST');assert.equal(check.status,200);assert.match((await check.json()).message,/Gemini respondió/);
  const upload=await fetch(base+'/api/audio',{method:'POST',headers:{Authorization:auth,'Content-Type':'audio/ogg'},body:Buffer.from('fake-audio')});
  assert.equal(upload.status,201);const saved=await upload.json();const note=(await state()).notes.find(n=>n.id===saved.id);assert.equal(note.classified,true);assert.equal(note.items[0].project,'Norte');assert.equal(note.transcript,'Para Norte: enviar propuesta.');
});


test('public webhook listener receives signed audio while keeping the dashboard private',async()=>{
  await stop();
  const probe=createNetServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(r=>probe.close(r));
  await writeFile(join(dir,'mock-provider.mjs'), `
    globalThis.fetch=async(url,options)=>{
      if(String(url).includes('graph.facebook.com'))return Response.json({url:'https://lookaside.fbsbx.com/audio',mime_type:'audio/ogg',sha256:'6ed8919ce20490a5e3ad8630a4fab69475297abd07db73918dd5f36fcfaeb11b'});
      if(String(url).includes('lookaside.fbsbx.com'))return new Response('audio');
      if(!String(url).includes('generativelanguage.googleapis.com'))throw new Error('Unexpected provider');
      const payload=JSON.parse(options.body);
      const value=payload.contents[0].parts[0].inlineData?{text:'Para Norte: llamar al cliente.'}:{items:[{title:'Llamar al cliente',category:'tarea',project:'Norte',dueDate:null}]};
      return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(value)}]}}]});
    };
  `);
  await start(true,'gemini',{WHATSAPP_WEBHOOK_PORT:String(port),WHATSAPP_PHONE_NUMBER_ID:'123456'});
  const publicBase='http://127.0.0.1:'+port;
  assert.equal((await fetch(publicBase+'/')).status,404);assert.equal((await fetch(publicBase+'/api/state')).status,404);assert.equal((await fetch(publicBase+'/api/jobs/retry',{method:'POST'})).status,404);
  const verify=await fetch(publicBase+'/webhook?hub.mode=subscribe&hub.verify_token=test-verification&hub.challenge=987');assert.equal(await verify.text(),'987');
  const send=async(phone,id)=>{
    const payload=JSON.stringify({entry:[{changes:[{value:{metadata:{phone_number_id:phone},messages:[{id,from:'56912345678',type:'audio',audio:{id:'12345'}}]}}]}]});
    return fetch(publicBase+'/webhook',{method:'POST',headers:{'x-hub-signature-256':'sha256='+createHmac('sha256','test-secret').update(payload).digest('hex')},body:payload});
  };
  assert.equal((await send('wrong-bot','wamid.wrong-bot')).status,200);assert.equal((await send('123456','wamid.audio')).status,200);assert.equal((await send('123456','wamid.audio')).status,200);
  let s;
  for(let i=0;i<40;i++){s=await state();if(s.notes.some(n=>n.id==='wamid.audio'))break;await new Promise(r=>setTimeout(r,100));}
  assert.equal(s.notes.filter(n=>n.id==='wamid.audio').length,1);assert.equal(s.notes.find(n=>n.id==='wamid.audio').items[0].title,'Llamar al cliente');assert.equal(s.notes.some(n=>n.id==='wamid.wrong-bot'),false);
});
