import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer as createNetServer } from 'node:net';
import { pathToFileURL } from 'node:url';
import { writeFile, mkdir, readdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { createHmac } from 'node:crypto';
import { validateItems } from '../domain.js';

let dir, child, base;
let cookie,csrf;
async function start(ai=false,provider='openai',overrides={}){
  child=spawn(process.execPath,[...(ai?['--import',pathToFileURL(join(dir,'mock-provider.mjs')).href]:[]),'server.js'],{cwd:dir,env:{...process.env,HOST:'127.0.0.1',PORT:'0',GEMINI_MODEL:'gemini-test-flash',AI_PROVIDER:provider,GEMINI_API_KEY:ai&&provider==='gemini'?'test-gemini-key':'',OPENAI_API_KEY:ai?'sk-test-key':'',DASHBOARD_PASSWORD:'test-private-password',DASHBOARD_USER:'admin',WHATSAPP_APP_SECRET:'test-secret',WHATSAPP_VERIFY_TOKEN:'test-verification',WHATSAPP_ALLOWED_FROM:'56912345678',WHATSAPP_PHONE_NUMBER_ID:'',WHATSAPP_WEBHOOK_PORT:'',WHATSAPP_ACCESS_TOKEN:'dummy-test-token',...overrides},stdio:['ignore','pipe','pipe']});
  let logs='';child.stderr.on('data',()=>{});
  await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('Server startup timeout: '+logs)),10000);child.stdout.on('data',data=>{logs+=data;const match=logs.match(/puerto (\d+)/);if(match){base=`http://127.0.0.1:${match[1]}`;clearTimeout(timeout);resolve();}});child.once('exit',code=>{clearTimeout(timeout);reject(new Error('Server exited: '+code));});});
  const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:'test-private-password'})});
  assert.equal(login.status,200);cookie=login.headers.get('set-cookie').split(';')[0];csrf=(await login.json()).csrf;
}
async function stop(){if(child?.exitCode===null){const exited=once(child,'exit');child.kill('SIGTERM');await exited;}}
async function api(path,method='GET',data){return fetch(base+path,{method,headers:{Cookie:cookie,'X-CSRF-Token':csrf,...(data?{'Content-Type':'application/json'}:{})},body:data?JSON.stringify(data):undefined});}
const state=async()=> (await api('/api/state')).json();
before(async()=>{dir=await mkdtemp(join(tmpdir(),'hilo-test-'));for(const file of ['server.js','domain.js','ai.js','gemini.js','whatsapp.js','auth.js','public'])await cp(new URL('../'+file,import.meta.url),join(dir,file),{recursive:true});await start();});
after(async()=>{await stop();await rm(dir,{recursive:true,force:true});});
test('rejects invalid item categories and impossible dates',()=>{
  assert.throws(()=>validateItems([{title:'x',category:'inventada'}]));
  assert.throws(()=>validateItems([{title:'x',category:'tarea',dueDate:'2026-02-30'}]));
  assert.equal(validateItems([{title:'Enviar propuesta',category:'tarea',dueDate:'2026-10-23'}])[0].done,false);
});
test('personal dashboard requires authentication and prevents cross-origin writes',async()=>{
  assert.equal((await fetch(base+'/api/state')).status,401);
  const page=await api('/');assert.equal(page.status,200);assert.match(await page.text(),/Pendientes por proyecto/);
  const bad=await fetch(base+'/api/projects',{method:'POST',headers:{Cookie:cookie,'X-CSRF-Token':csrf,Origin:'https://untrusted.example','Content-Type':'application/json'},body:'{"name":"intrusion"}'});assert.equal(bad.status,403);
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
  const upload=await fetch(base+'/api/audio',{method:'POST',headers:{Cookie:cookie,'X-CSRF-Token':csrf,'Content-Type':'audio/ogg'},body:Buffer.from('fake-audio')});
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
  const upload=await fetch(base+'/api/audio',{method:'POST',headers:{Cookie:cookie,'X-CSRF-Token':csrf,'Content-Type':'audio/ogg'},body:Buffer.from('fake-audio')});
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

test('webhook diagnostics distinguish filters, duplicates and unsigned requests without exposing messages',async()=>{
  const diagnostic=async()=> (await api('/api/whatsapp/status')).json();
  const post=async(value,signed=true)=>{
    const payload=JSON.stringify({entry:[{changes:[{value}]}]});
    return fetch(base+'/webhook',{method:'POST',headers:signed?{'x-hub-signature-256':'sha256='+createHmac('sha256','test-secret').update(payload).digest('hex')}:{},body:payload});
  };
  assert.ok((await diagnostic()).events.some(e=>/duplicada/.test(e.summary)));
  const message={id:'private-message-id',from:'56999999999',type:'text',text:{body:'private-message-content'}};
  await post({metadata:{phone_number_id:'123456'},messages:[message]});
  let status=await diagnostic();assert.match(status.events[0].summary,/WHATSAPP_ALLOWED_FROM/);
  await post({metadata:{phone_number_id:'wrong-bot-id'},messages:[message]});status=await diagnostic();assert.match(status.events[0].summary,/WHATSAPP_PHONE_NUMBER_ID/);
  await post({},false);status=await diagnostic();assert.match(status.events[0].summary,/firma inválida/);
  await post({statuses:[{id:'private-message-id',status:'delivered'}]});status=await diagnostic();assert.match(status.events[0].summary,/sin notas/);
  for(let i=0;i<12;i++)await post({statuses:[]});
  status=await diagnostic();assert.equal(status.events.length,10);
  assert.doesNotMatch(JSON.stringify(status.events),/private-message|56999999999|test-secret/);
  await stop();await start();assert.equal((await diagnostic()).events.length,10);
});

test('project colors, names and order persist while rename and deletion preserve note contents',async()=>{
  const create=await api('/api/notes','POST',{text:'Original que debe conservarse.'});const {id}=await create.json();
  for(const [name,color] of [['Personal','#a040d0'],['Trabajo / Norte','#2172b5']])assert.equal((await api('/api/projects','POST',{name,color})).status,201);
  assert.equal((await api('/api/projects','POST',{name:'Personal',color:'#ffffff'})).status,409);
  assert.equal((await api('/api/projects','POST',{name:'Color malo',color:'red'})).status,400);
  const items=[{title:'Hacer seguimiento',category:'tarea',project:'Personal',dueDate:'2026-11-02',done:true},{title:'Probar idea',category:'idea',project:'Trabajo / Norte',dueDate:null,done:false}];
  assert.equal((await api(`/api/notes/${id}`,'PATCH',{items})).status,200);
  assert.equal((await api('/api/projects/Personal','PATCH',{name:'Privado',color:'#C03080'})).status,200);
  let s=await state(),note=s.notes.find(n=>n.id===id);
  assert.equal(note.transcript,'Original que debe conservarse.');assert.deepEqual(note.items,[{...items[0],project:'Privado'},items[1]]);
  assert.equal(s.projectDetails.find(p=>p.name==='Privado').color,'#c03080');
  assert.equal((await api('/api/projects/Privado','PATCH',{name:'Trabajo / Norte'})).status,409);
  assert.equal((await api('/api/projects/Privado','PATCH',{name:''})).status,400);
  const names=[...s.projects].reverse();assert.equal((await api('/api/projects/order','PUT',{names})).status,200);
  assert.equal((await api('/api/projects/order','PUT',{names:['Privado','Privado']})).status,400);
  await stop();await start();s=await state();assert.deepEqual(s.projects,names);assert.equal(s.projectDetails.find(p=>p.name==='Privado').color,'#c03080');
  assert.equal((await api('/api/projects/Privado','DELETE')).status,200);
  note=(await state()).notes.find(n=>n.id===id);assert.deepEqual(note.items,[{...items[0],project:null},items[1]]);assert.equal(note.transcript,'Original que debe conservarse.');
  assert.equal((await api('/api/projects/'+encodeURIComponent('Trabajo / Norte'),'PATCH',{name:'Trabajo renovado'})).status,200);
  note=(await state()).notes.find(n=>n.id===id);assert.equal(note.items[1].project,'Trabajo renovado');
});
test('whole-note moves preserve item details and review state and reject unknown projects',async()=>{
  const {id}=await(await api('/api/notes','POST',{text:'Mover sin clasificar.'})).json();
  const before=(await state()).notes.find(n=>n.id===id);
  assert.equal((await api(`/api/notes/${id}/project`,'PATCH',{project:'Trabajo renovado'})).status,200);
  let moved=(await state()).notes.find(n=>n.id===id);assert.equal(moved.classified,before.classified);assert.deepEqual(moved.items,before.items.map(i=>({...i,project:'Trabajo renovado'})));
  assert.equal((await api(`/api/notes/${id}/project`,'PATCH',{project:null})).status,200);
  assert.equal((await api(`/api/notes/${id}/project`,'PATCH',{project:'Inexistente'})).status,400);
  assert.equal((await api(`/api/notes/${id}`,'PATCH',{items:[{title:'Dato inválido',category:'nota',project:'Inexistente'}]})).status,400);
});
test('deleting notes removes contents and keeps WhatsApp delivery deduplication',async()=>{
  const id='wamid.deleted+note/=';
  const payload=JSON.stringify({entry:[{changes:[{value:{messages:[{id,from:'56912345678',type:'text',text:{body:'Nota a eliminar de WhatsApp'}}]}}]}]});
  const send=()=>fetch(base+'/webhook',{method:'POST',headers:{'x-hub-signature-256':'sha256='+createHmac('sha256','test-secret').update(payload).digest('hex')},body:payload});
  await send();
  for(let i=0;i<30;i++){if((await state()).notes.some(n=>n.id===id))break;await new Promise(r=>setTimeout(r,100));}
  assert.ok((await state()).notes.some(n=>n.id===id));assert.equal((await api(`/api/notes/${encodeURIComponent(id)}`,'DELETE')).status,200);
  assert.equal((await api(`/api/notes/${encodeURIComponent(id)}`,'DELETE')).status,404);
  await send();await new Promise(r=>setTimeout(r,1100));assert.equal((await state()).notes.some(n=>n.id===id),false);
});


test('legacy databases get a recoverable backup and migrate only once without losing notes',async()=>{
  await stop();
  const originalDir=dir;dir=await mkdtemp(join(tmpdir(),'hilo-legacy-'));
  try {
    for(const file of ['server.js','domain.js','ai.js','gemini.js','whatsapp.js','auth.js','public'])await cp(new URL('../'+file,import.meta.url),join(dir,file),{recursive:true});
    await mkdir(join(dir,'data'));
    const legacy=new DatabaseSync(join(dir,'data','notes.sqlite'));
    legacy.exec('CREATE TABLE projects (name TEXT PRIMARY KEY); CREATE TABLE notes (id TEXT PRIMARY KEY,received TEXT NOT NULL,source TEXT NOT NULL,transcript TEXT NOT NULL,items TEXT NOT NULL,classified INTEGER NOT NULL)');
    legacy.prepare('INSERT INTO projects VALUES (?)').run('Proyecto antiguo');
    const items=[{title:'Nota histórica',category:'nota',project:'Proyecto antiguo',dueDate:null,done:false}];
    legacy.prepare('INSERT INTO notes VALUES (?,?,?,?,?,?)').run('legacy-note','2026-10-01T12:00:00Z','texto','Original histórico',JSON.stringify(items),1);legacy.close();
    await start();const migrated=await state();assert.equal(migrated.projectDetails[0].color,'#648148');assert.deepEqual(migrated.notes[0].items,items);assert.equal(migrated.notes[0].transcript,'Original histórico');
    let backups=await readdir(join(dir,'data','backups'));assert.equal(backups.length,2);
    const backup=new DatabaseSync(join(dir,'data','backups',backups.find(name=>name.startsWith('before-project-settings-'))),{readOnly:true});assert.equal(backup.prepare('SELECT transcript FROM notes').get().transcript,'Original histórico');assert.deepEqual(backup.prepare('PRAGMA table_info(projects)').all().map(c=>c.name),['name']);backup.close();
    await stop();await start();backups=await readdir(join(dir,'data','backups'));assert.equal(backups.length,2);assert.equal((await state()).notes.length,1);
  }finally{await stop();await rm(dir,{recursive:true,force:true});dir=originalDir;}
});
