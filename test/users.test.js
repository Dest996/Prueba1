import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,cp,rm,writeFile,readFile,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {DatabaseSync} from 'node:sqlite';
let dir,child,base,admin,reader,editor,readerId,editorId,noteId,mixedId,secretId;
const adminPassword='admin-initial-password';
async function start(overrides={}){
  child=spawn(process.execPath,['server.js'],{cwd:dir,env:{...process.env,HOST:'127.0.0.1',PORT:'0',DASHBOARD_USER:'admin',DASHBOARD_PASSWORD:adminPassword,AI_PROVIDER:'gemini',GEMINI_API_KEY:'',OPENAI_API_KEY:'',WHATSAPP_WEBHOOK_PORT:'',...overrides},stdio:['ignore','pipe','pipe']});
  let logs='';child.stderr.on('data',()=>{});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Startup timeout')),10000);child.stdout.on('data',data=>{logs+=data;const match=logs.match(/puerto (\d+)/);if(match){base='http://127.0.0.1:'+match[1];clearTimeout(timer);resolve();}});child.once('exit',code=>{clearTimeout(timer);reject(new Error('Server exited '+code));});});
  return logs;
}
async function stop(){if(child?.exitCode===null){const done=once(child,'exit');child.kill();await done;}}
async function request(path,who,method='GET',data,extra={}){
  return fetch(base+path,{method,headers:{...(who?{Cookie:who.cookie,'X-CSRF-Token':who.csrf}:{}),...(data?{'Content-Type':'application/json'}:{}),...extra},body:data?JSON.stringify(data):undefined});
}
async function login(username,password){const r=await request('/api/auth/login',null,'POST',{username,password});assert.equal(r.status,200);const data=await r.json();return {cookie:r.headers.get('set-cookie').split(';')[0],csrf:data.csrf,user:data.user};}
async function state(who){const r=await request('/api/state',who);assert.equal(r.status,200);return r.json();}
async function createNote(text,items){const r=await request('/api/notes',admin,'POST',{text});assert.equal(r.status,201);const {id}=await r.json();assert.equal((await request('/api/notes/'+id,admin,'PATCH',{items})).status,200);return id;}
const item=(title,project,done=false)=>({title,category:'tarea',project,dueDate:'2026-11-10',done});
before(async()=>{
  dir=await mkdtemp(join(tmpdir(),'hilo-users-'));
  for(const file of ['server.js','auth.js','domain.js','ai.js','gemini.js','whatsapp.js','public'])await cp(new URL('../'+file,import.meta.url),join(dir,file),{recursive:true});
  await writeFile(join(dir,'.env'),'GEMINI_API_KEY=existing-config-must-remain\n');
  await start();admin=await login('admin',adminPassword);
  for(const name of ['Compartido','Privado'])assert.equal((await request('/api/projects',admin,'POST',{name})).status,201);
  noteId=await createNote('Original de proyecto compartido',[item('Trabajo visible','Compartido')]);
  mixedId=await createNote('ORIGINAL SECRETO: información de Privado',[item('Elemento visible','Compartido'),item('TÍTULO SECRETO','Privado')]);
  secretId=await createNote('ORIGINAL PRIVADO',[item('Privado por completo','Privado')]);
  await createNote('SIN PROYECTO',[item('Pendiente sin proyecto',null)]);
});
after(async()=>{await stop();await rm(dir,{recursive:true,force:true});});
test('sessions replace anonymous and Basic access; cookies, CSRF and generic login failures',async()=>{
  assert.equal((await request('/api/state')).status,401);
  assert.equal((await request('/api/state',null,'GET',null,{Authorization:'Basic '+Buffer.from('admin:'+adminPassword).toString('base64')})).status,401);
  assert.equal((await request('/')).status,200);
  const raw=await request('/api/auth/login',null,'POST',{username:'admin',password:adminPassword});
  assert.match(raw.headers.get('set-cookie'),/HttpOnly/);assert.match(raw.headers.get('set-cookie'),/SameSite=Strict/);assert.match(raw.headers.get('set-cookie'),/Max-Age=43200/);
  const bad=await request('/api/auth/login',null,'POST',{username:'admin',password:'incorrect-password'});const missing=await request('/api/auth/login',null,'POST',{username:'nobody',password:'incorrect-password'});
  assert.equal(bad.status,401);assert.deepEqual(await bad.json(),await missing.json());
  assert.equal((await request('/api/projects',{cookie:admin.cookie},'POST',{name:'No CSRF'})).status,403);
  assert.equal((await request('/api/projects',admin,'POST',{name:'Bad origin'},{Origin:'https://other.example'})).status,403);
  assert.equal((await request('/api/auth/login',null,'POST',{username:'admin',password:adminPassword},{'Sec-Fetch-Site':'cross-site'})).status,403);
  assert.equal((await request('/api/auth/setup',null,'POST',{username:'hacker',password:'attacker-password',setupToken:'x'})).status,409);
});
test('admin creates accounts with explicit per-project view/edit access; secrets stay on the server',async()=>{
  for(const [name,access] of [['lector','view'],['editor','edit']]){
    const r=await request('/api/users',admin,'POST',{username:name,displayName:name,password:name+'-password-long',grants:[{project:'Compartido',access}]});assert.equal(r.status,201);const {user}=await r.json();if(name==='lector')readerId=user.id;else editorId=user.id;
  }
  reader=await login('lector','lector-password-long');editor=await login('editor','editor-password-long');
  assert.equal((await request('/api/users',admin,'POST',{username:'lector',displayName:'duplicate',password:'long-password',grants:[]})).status,409);
  assert.equal((await request('/api/users',admin,'POST',{username:'invalid',displayName:'x',password:'short',grants:[]})).status,400);
  assert.equal((await request('/api/users',admin,'POST',{username:'invalid',displayName:'x',password:'long-password',grants:[{project:'Unknown',access:'edit'}]})).status,400);
  const exposed=JSON.stringify(await (await request('/api/users',admin)).json());assert.doesNotMatch(exposed,/password_hash|scrypt:|token_hash|password-long/);
  const db=new DatabaseSync(join(dir,'data/notes.sqlite'),{readOnly:true});
  assert.match(db.prepare('SELECT password_hash FROM users WHERE username=?').get('lector').password_hash,/^scrypt:/);
  assert.notEqual(db.prepare('SELECT token_hash FROM sessions LIMIT 1').get().token_hash,admin.cookie.split('=')[1]);db.close();
});
test('server filters projects, mixed-note items, originals and diagnostics for non-admin users',async()=>{
  const s=await state(reader);assert.deepEqual(s.projects,['Compartido']);assert.equal(s.notes.length,2);assert.deepEqual(s.jobs,[]);
  assert.doesNotMatch(JSON.stringify(s),/ORIGINAL SECRETO|TÍTULO SECRETO|ORIGINAL PRIVADO|SIN PROYECTO|Privado por completo/);
  const mixed=s.notes.find(n=>n.id===mixedId);assert.equal(mixed.transcript,null);assert.equal(mixed.partial,true);assert.equal(mixed.canEdit,false);assert.equal(mixed.items.length,1);
  assert.equal(s.notes.find(n=>n.id===noteId).transcript,'Original de proyecto compartido');assert.equal(s.notes.find(n=>n.id===noteId).canEdit,false);
  for(const [path,method,data] of [['/api/users','GET'],['/api/whatsapp/status','GET'],['/api/whatsapp/check','POST'],['/api/ai/check','POST'],['/api/jobs/retry','POST'],['/api/projects','POST',{name:'Forbidden'}],['/api/projects/Compartido','DELETE'],['/api/projects/order','PUT',{names:['Compartido']}],['/api/users/'+admin.user.id,'PATCH',{role:'admin'}]]){
    assert.equal((await request(path,reader,method,data)).status,403,path);
  }
  assert.equal((await request('/api/notes/'+secretId,editor,'DELETE')).status,404);
});
test('read-only users cannot mutate; editors cannot modify hidden items or move into forbidden projects',async()=>{
  const original=await state(admin);
  for(const [path,method,data] of [['/api/notes/'+noteId,'PATCH',{items:[item('Changed','Compartido')]}],['/api/notes/'+noteId,'DELETE'],['/api/notes','POST',{text:'Forbidden',project:'Compartido'}],['/api/audio?project=Compartido','POST']])assert.equal((await request(path,reader,method,data)).status,403);
  assert.equal((await request('/api/notes/'+mixedId,editor,'PATCH',{items:[item('Overwrite','Compartido')]})).status,403);
  assert.equal((await request('/api/notes/'+mixedId,editor,'DELETE')).status,403);
  assert.equal((await request('/api/notes/'+noteId+'/project',editor,'PATCH',{project:'Privado'})).status,403);
  assert.equal((await request('/api/notes/'+noteId+'/project',editor,'PATCH',{project:null})).status,403);
  assert.equal((await request('/api/notes/'+noteId,editor,'PATCH',{items:[item('Move','Privado')]})).status,403);
  assert.equal((await request('/api/notes',editor,'POST',{text:'No project'})).status,403);
  assert.deepEqual((await state(admin)).notes,original.notes);
  assert.equal((await request('/api/notes/'+noteId,editor,'PATCH',{items:[item('Trabajo editado','Compartido',true)]})).status,200);
  const captured=await request('/api/notes',editor,'POST',{text:'Nota de colaborador',project:'Compartido'});assert.equal(captured.status,201);
  const {id}=await captured.json(),note=(await state(editor)).notes.find(n=>n.id===id);assert.equal(note.items[0].project,'Compartido');assert.equal(note.transcript,'Nota de colaborador');assert.equal(note.canEdit,true);
  assert.equal((await request('/api/notes/'+id,editor,'DELETE')).status,200);
});
test('revocation applies immediately to existing sessions and direct API writes; grants survive project rename',async()=>{
  assert.equal((await request('/api/users/'+editorId,admin,'PATCH',{grants:[]})).status,200);
  assert.equal((await state(editor)).notes.length,0);assert.equal((await request('/api/notes/'+noteId,editor,'DELETE')).status,404);
  assert.equal((await request('/api/notes',editor,'POST',{text:'After revocation',project:'Compartido'})).status,403);
  assert.equal((await request('/api/projects/Compartido',admin,'PATCH',{name:'Renombrado'})).status,200);
  assert.deepEqual((await state(reader)).projects,['Renombrado']);
  assert.equal((await request('/api/users/'+editorId,admin,'PATCH',{grants:[{project:'Renombrado',access:'edit'}]})).status,200);
  assert.equal((await state(editor)).notes.find(n=>n.id===noteId).canEdit,true);
  await stop();await start({DASHBOARD_PASSWORD:'changed-env-must-not-reset-users'});
  assert.deepEqual((await state(reader)).projects,['Renombrado']);assert.equal((await state(editor)).notes.find(n=>n.id===noteId).items[0].done,true);
  assert.equal((await login('admin',adminPassword)).user.role,'admin');
  assert.equal(await readFile(join(dir,'.env'),'utf8'),'GEMINI_API_KEY=existing-config-must-remain\n');
});
test('password resets and deactivation revoke sessions; users can change their own password',async()=>{
  assert.equal((await request('/api/users/'+readerId,admin,'PATCH',{password:'reset-reader-password'})).status,200);
  assert.equal((await request('/api/state',reader)).status,401);reader=await login('lector','reset-reader-password');
  assert.equal((await request('/api/users/'+readerId,admin,'PATCH',{active:false})).status,200);assert.equal((await request('/api/state',reader)).status,401);
  assert.equal((await request('/api/auth/login',null,'POST',{username:'lector',password:'reset-reader-password'})).status,401);
  assert.equal((await request('/api/users/'+readerId,admin,'PATCH',{active:true})).status,200);reader=await login('lector','reset-reader-password');
  assert.equal((await request('/api/auth/password',reader,'POST',{currentPassword:'wrong-password',password:'new-reader-password'})).status,403);
  assert.equal((await request('/api/auth/password',reader,'POST',{currentPassword:'reset-reader-password',password:'new-reader-password'})).status,200);
  assert.equal((await request('/api/state',reader)).status,401);reader=await login('lector','new-reader-password');
  assert.equal((await request('/api/users/'+admin.user.id,admin,'PATCH',{active:false})).status,403);
  assert.equal((await request('/api/auth/logout',reader,'POST')).status,200);assert.equal((await request('/api/state',reader)).status,401);
});
test('project deletion revokes assignment while keeping notes available to admin; expired sessions are rejected',async()=>{
  assert.equal((await request('/api/projects/Renombrado',admin,'DELETE')).status,200);
  assert.deepEqual((await state(editor)).projects,[]);assert.equal((await state(editor)).notes.length,0);
  assert.ok((await state(admin)).notes.find(n=>n.id===noteId));
  const db=new DatabaseSync(join(dir,'data/notes.sqlite'));db.prepare('UPDATE sessions SET expires=0 WHERE user_id=?').run(editorId);db.close();
  assert.equal((await request('/api/state',editor)).status,401);
});
test('login attempts are bounded',async()=>{
  for(let i=0;i<10;i++)assert.equal((await request('/api/auth/login',null,'POST',{username:'guessing',password:'incorrect-password'})).status,401);
  assert.equal((await request('/api/auth/login',null,'POST',{username:'guessing',password:'incorrect-password'})).status,429);
});
test('fresh local installations require the one-time terminal code and cannot replace an existing admin',async()=>{
  await stop();const originalDir=dir;dir=await mkdtemp(join(tmpdir(),'hilo-setup-'));
  try{
    for(const file of ['server.js','auth.js','domain.js','ai.js','gemini.js','whatsapp.js','public'])await cp(new URL('../'+file,import.meta.url),join(dir,file),{recursive:true});
    const logs=await start({DASHBOARD_PASSWORD:''}),token=logs.match(/código ([a-f0-9]+)/)?.[1];assert.ok(token);
    const initial=await (await request('/api/auth/session')).json();assert.equal(initial.setupRequired,true);assert.doesNotMatch(JSON.stringify(initial),new RegExp(token));
    assert.equal((await request('/api/auth/setup',null,'POST',{username:'owner',password:'owner-password-long',setupToken:'wrong'})).status,403);
    const setup=await request('/api/auth/setup',null,'POST',{username:'owner',password:'owner-password-long',setupToken:token});assert.equal(setup.status,201);assert.equal((await setup.json()).user.role,'admin');
    assert.equal((await request('/api/auth/setup',null,'POST',{username:'other',password:'other-password-long',setupToken:token})).status,409);
    await stop();await start({DASHBOARD_PASSWORD:''});await login('owner','owner-password-long');
  }finally{await stop();await rm(dir,{recursive:true,force:true});dir=originalDir;}
});
