import http from 'node:http';
import {createBot} from './bot.js';
import { createAuth, fail } from './auth.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { timingSafeEqual, createHmac, randomUUID } from 'node:crypto';
import { validateItems, fallbackItems } from './domain.js';
import { classify, transcribe, aiInfo } from './ai.js';
import {whatsappInfo,checkWhatsApp,downloadWhatsAppAudio} from './whatsapp.js';

const host = process.env.HOST || '127.0.0.1';

mkdirSync('data', { recursive:true });
const db = new DatabaseSync('data/notes.sqlite');
db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS projects (name TEXT PRIMARY KEY); CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, received TEXT NOT NULL, source TEXT NOT NULL, transcript TEXT NOT NULL, items TEXT NOT NULL, classified INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, received TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', error TEXT);`);
db.exec('CREATE TABLE IF NOT EXISTS webhook_events (id INTEGER PRIMARY KEY, received TEXT NOT NULL, summary TEXT NOT NULL)');
db.prepare("UPDATE jobs SET status='pending' WHERE status='processing'").run();
function recordWebhook(summary) {
  db.prepare('INSERT INTO webhook_events (received,summary) VALUES (?,?)').run(new Date().toISOString(),summary);
  db.exec('DELETE FROM webhook_events WHERE id NOT IN (SELECT id FROM webhook_events ORDER BY id DESC LIMIT 10)');
  console.log('WhatsApp: '+summary);
}
// Add project settings without replacing existing notes or projects.
const projectColumns=db.prepare('PRAGMA table_info(projects)').all().map(column=>column.name);
if(!projectColumns.includes('color')||!projectColumns.includes('position')) {
  if(db.prepare('SELECT COUNT(*) AS n FROM notes').get().n||db.prepare('SELECT COUNT(*) AS n FROM projects').get().n) {
    mkdirSync('data/backups',{recursive:true});
    db.prepare('VACUUM INTO ?').run(`data/backups/before-project-settings-${Date.now()}-${randomUUID()}.sqlite`);
  }
  db.exec('BEGIN');
  try {
    if(!projectColumns.includes('color'))db.exec("ALTER TABLE projects ADD COLUMN color TEXT NOT NULL DEFAULT '#648148'");
    if(!projectColumns.includes('position')) {
      db.exec('ALTER TABLE projects ADD COLUMN position INTEGER NOT NULL DEFAULT 0');
      db.prepare('SELECT name FROM projects ORDER BY name').all().forEach((p,index)=>db.prepare('UPDATE projects SET position=? WHERE name=?').run(index,p.name));
    }
    db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
}
const auth=await createAuth(db);
if(!auth.hasUsers()&&!['127.0.0.1','localhost','::1'].includes(host))throw new Error('Crea el administrador primero usando HOST=127.0.0.1.');
const projectDetails = () => db.prepare('SELECT name,color,position FROM projects ORDER BY position,name').all();
const projects = () => projectDetails().map(p=>p.name);
const bot=createBot(db,auth);
function projectName(value) {
  if(typeof value!=='string'||!value.trim()||value.trim().length>100)throw new Error('El nombre del proyecto debe tener entre 1 y 100 caracteres.');
  return value.trim();
}
function projectColor(value) {
  if(typeof value!=='string'||!/^#[0-9a-f]{6}$/i.test(value))throw new Error('El color debe tener el formato #RRGGBB.');
  return value.toLowerCase();
}
function transaction(fn) {
  db.exec('BEGIN');try{const result=fn();db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}
}
function rewriteProject(oldName,newName) {
  for(const note of db.prepare('SELECT id,items FROM notes').all()) {
    const items=JSON.parse(note.items);
    if(items.some(item=>item.project===oldName))db.prepare('UPDATE notes SET items=? WHERE id=?').run(JSON.stringify(items.map(item=>item.project===oldName?{...item,project:newName}:item)),note.id);
  }
}
function checkedItems(items) {
  const valid=validateItems(items),names=projects();
  if(valid.some(item=>item.project&&!names.includes(item.project)))throw new Error('El proyecto seleccionado ya no existe. Actualiza la página y selecciona otro.');
  return valid;
}
function equal(a,b) { const x=Buffer.from(a || ''), y=Buffer.from(b || ''); return x.length === y.length && timingSafeEqual(x,y); }
function send(res, status, value) { res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}); res.end(JSON.stringify(value)); }
async function body(req, limit=1024*1024) { const chunks=[]; let size=0; for await (const chunk of req) { size+=chunk.length; if(size>limit) { const e=new Error('Archivo demasiado grande.'); e.status=413; throw e; } chunks.push(chunk); } return Buffer.concat(chunks); }
async function saveNote(text, source, id=randomUUID(), received=new Date().toISOString(), context=null) {
  if (!text?.trim() || text.length>30000) throw new Error('El texto debe tener entre 1 y 30000 caracteres.');
  let items=fallbackItems(text), classified=0, warning=null;
  if (aiInfo().configured) {
    try { items=await classify(text,context?.project?[context.project]:projects(),new Date(received)); classified=1; }
    catch (e) { warning=`${e.message} Se guardó el texto para revisarlo y reintentar.`; }
  }
  if(context){
    const actor=auth.currentUser(context.user.id);
    if(actor.role!=='admin'||context.project!==null){
      if(!auth.projectAccess(actor,context.project,true))throw fail('Ya no tienes permiso para guardar en ese proyecto.',403);
      items=items.map(item=>({...item,project:context.project}));
    }
  }
  const currentProjects=projects();
  items=items.map(item=>({...item,project:currentProjects.includes(item.project)?item.project:null}));
  db.prepare('INSERT OR IGNORE INTO notes VALUES (?,?,?,?,?,?)').run(id,received,source,text,JSON.stringify(items),classified);
  if(context){db.prepare('INSERT OR IGNORE INTO note_owners VALUES (?,?)').run(id,context.user.id);bot.syncNote(id,context.user.id);}
  return {id,warning};
}
async function getMedia(id) {
  const signal=AbortSignal.timeout(14000);
  const {buffer,mime}=await downloadWhatsAppAudio(id,aiInfo().maxAudioBytes,{signal});
  signal.throwIfAborted();return transcribe(buffer,mime,{timeoutMs:10000,signal});
}
const processingPhones=new Set();
async function processJobs() {
  if(processingPhones.size>=4)return;
  const job=db.prepare("SELECT * FROM jobs WHERE status='pending' ORDER BY received,rowid LIMIT 100").all().find(job=>!processingPhones.has(JSON.parse(job.payload).from));
  if(!job)return;
  const phone=JSON.parse(job.payload).from;processingPhones.add(phone);
  try {
    db.prepare("UPDATE jobs SET status='processing', error=NULL WHERE id=?").run(job.id);
    try {
      const msg=JSON.parse(job.payload),sender=auth.whatsappUser(msg.from);
      if(!sender||(msg._userId?sender.id!==msg._userId:sender.role!=='admin')){db.prepare("UPDATE jobs SET status='done' WHERE id=?").run(job.id);return;}
      const buttonId=msg.type==='interactive'?msg.interactive?.button_reply?.id:msg.type==='button'?msg.button?.payload:null;
      let timeout;const audio=msg.type==='audio'?Promise.race([getMedia(msg.audio.id),new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error('El audio tardó demasiado. Prueba un audio breve o texto.')),14000);})]).finally(()=>clearTimeout(timeout)):null;
      const text=msg.type==='audio'?await audio:msg.type==='text'?msg.text.body:msg.interactive?.button_reply?.title||msg.button?.text||'';
      if(auth.whatsappUser(msg.from)?.id===sender.id)await bot.handle({id:job.id,phone:msg.from,text,received:job.received,buttonId});
      db.prepare("UPDATE jobs SET status='done' WHERE id=?").run(job.id);
    } catch(e) { db.prepare("UPDATE jobs SET status='error', error=? WHERE id=?").run(e.message,job.id);const msg=JSON.parse(job.payload),user=auth.whatsappUser(msg.from);if(user&&(!msg._userId||user.id===msg._userId))bot.reply('error:'+job.id,user,msg.from,'No pude procesar el audio. Prueba una grabación breve o escribe tu nota. El administrador puede reintentar el audio desde Configuración.'); }
  } finally { processingPhones.delete(phone); }
}
async function handleRequest(req,res,webhookOnly=false){
  try {
    const url=new URL(req.url,'http://localhost');
    if(webhookOnly && url.pathname!=='/webhook') return send(res,404,{error:'No encontrado.'});
    if(url.pathname==='/webhook' && req.method==='GET') {
      if(process.env.WHATSAPP_VERIFY_TOKEN && url.searchParams.get('hub.mode')==='subscribe' && equal(url.searchParams.get('hub.verify_token'),process.env.WHATSAPP_VERIFY_TOKEN)) { res.writeHead(200,{'Content-Type':'text/plain'}); return res.end(url.searchParams.get('hub.challenge')); }
      return send(res,403,{error:'Verificación rechazada.'});
    }
    if(url.pathname==='/webhook' && req.method==='POST') {
      if(!process.env.WHATSAPP_APP_SECRET) return send(res,503,{error:'Webhook sin configurar.'});
      const raw=await body(req);
      const signature='sha256='+createHmac('sha256',process.env.WHATSAPP_APP_SECRET).update(raw).digest('hex');
      if(!equal(req.headers['x-hub-signature-256'],signature)) {recordWebhook('Petición rechazada: firma inválida. Si fue una entrega de Meta, comprueba el App Secret de esta app.');return send(res,403,{error:'Firma inválida.'});}
      const event=JSON.parse(raw);
      const counts={accepted:0,duplicate:0,bot:0,sender:0,type:0,invalid:0};
      for(const entry of event.entry || []) for(const change of entry.changes || []) for(const msg of change.value?.messages || []) {
        if(process.env.WHATSAPP_PHONE_NUMBER_ID && change.value?.metadata?.phone_number_id!==process.env.WHATSAPP_PHONE_NUMBER_ID) {counts.bot++;continue;}
        if(!['audio','text','interactive','button'].includes(msg.type)) {counts.type++;continue;}
        const inboundUser=auth.whatsappUser(msg.from);if(!inboundUser) {counts.sender++;continue;}
        if(!msg.id || (msg.type==='audio' && !msg.audio?.id) || (msg.type==='text' && typeof msg.text?.body!=='string') || (msg.type==='interactive'&&!msg.interactive?.button_reply?.id) || (msg.type==='button'&&!msg.button?.payload)) {counts.invalid++;continue;}
        const timestamp=/^\d{1,12}$/.test(msg.timestamp||'')?Number(msg.timestamp)*1000:Date.now();
        if(!Number.isFinite(timestamp)||timestamp>253402300799000){counts.invalid++;continue;}
        const received=new Date(Math.min(timestamp,Date.now())).toISOString();
        const saved=db.prepare('INSERT OR IGNORE INTO jobs (id,received,payload) VALUES (?,?,?)').run(msg.id,received,JSON.stringify({...msg,_userId:inboundUser.id}));
        if(saved.changes){bot.incoming(msg.from,Date.parse(received));counts.accepted++;}else counts.duplicate++;
      }
      for(const entry of event.entry||[])for(const change of entry.changes||[]){
        if(process.env.WHATSAPP_PHONE_NUMBER_ID&&change.value?.metadata?.phone_number_id!==process.env.WHATSAPP_PHONE_NUMBER_ID)continue;
        for(const status of change.value?.statuses||[])bot.receipt(status);
      }
      const reasons=[];
      if(counts.accepted)reasons.push(`${counts.accepted} mensaje(s) nuevo(s) aceptado(s)`);
      if(counts.duplicate)reasons.push(`${counts.duplicate} entrega(s) duplicada(s), ya registrada(s)`);
      if(counts.bot)reasons.push('Mensaje ignorado: el Phone Number ID recibido no coincide con WHATSAPP_PHONE_NUMBER_ID');
      if(counts.sender)reasons.push('Mensaje ignorado: el remitente no tiene una cuenta activa con ese WhatsApp. Revisa Usuarios o WHATSAPP_ALLOWED_FROM para la importación inicial');
      if(counts.type)reasons.push('Contenido ignorado: se admiten texto, audio y botones del bot');
      if(counts.invalid)reasons.push('Mensaje ignorado: faltan campos requeridos');
      recordWebhook(reasons.join('. ') || 'Evento firmado recibido sin notas: puede ser un estado de entrega u otra notificación');
      return send(res,200,{ok:true});
    }
    // Browser mutations must originate from this dashboard. No CORS is enabled.
    if(!['GET','HEAD'].includes(req.method)&&req.headers['sec-fetch-site']==='cross-site')return send(res,403,{error:'Origen inválido.'});
    if(!['GET','HEAD'].includes(req.method) && req.headers.origin) {
      const origin=new URL(req.headers.origin);
      if(origin.host!==req.headers.host) return send(res,403,{error:'Origen inválido.'});
    }
    // Serve only the shell and assets publicly; all application data requires a session.
    const files={'/':['public/index.html','text/html; charset=utf-8'],'/app.js':['public/app.js','text/javascript; charset=utf-8'],'/style.css':['public/style.css','text/css; charset=utf-8'],'/logo.svg':['public/logo.svg','image/svg+xml']};
    if(req.method==='GET'&&files[url.pathname]){
      const [file,type]=files[url.pathname];res.writeHead(200,{'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin','Content-Security-Policy':"default-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'"});return res.end(readFileSync(file));
    }
    const who=auth.identity(req);
    if(url.pathname==='/api/auth/session'&&req.method==='GET')return send(res,200,{user:who?auth.publicUser(who.user):null,csrf:who?.session.csrf||null,setupRequired:!auth.hasUsers()});
    if(url.pathname==='/api/auth/login'&&req.method==='POST')return send(res,200,await auth.login(req,res,JSON.parse(await body(req,8192))));
    if(url.pathname==='/api/auth/setup'&&req.method==='POST')return send(res,201,await auth.setup(req,res,JSON.parse(await body(req,8192))));
    if(!who)return send(res,401,{error:'Inicia sesión para acceder a AL DÍA.'});
    if(!['GET','HEAD'].includes(req.method))auth.csrf(req,who);
    const user=who.user;
    if(url.pathname==='/api/auth/logout'&&req.method==='POST'){auth.logout(req,res,who);return send(res,200,{ok:true});}
    if(url.pathname==='/api/auth/password'&&req.method==='POST'){
      await auth.changePassword(user,JSON.parse(await body(req,8192)));auth.logout(req,res,who);return send(res,200,{message:'Contraseña actualizada. Vuelve a iniciar sesión.'});
    }
    if(url.pathname==='/api/users'){
      auth.admin(user);
      if(req.method==='GET')return send(res,200,{users:auth.listUsers()});
      if(req.method==='POST')return send(res,201,{user:await auth.createUser(user,JSON.parse(await body(req,128*1024)))});
    }
    const userMatch=url.pathname.match(/^\/api\/users\/([a-f0-9]+)$/);
    if(userMatch&&req.method==='PATCH'){const updated=await auth.updateUser(user,userMatch[1],JSON.parse(await body(req,128*1024)));for(const target of db.prepare('SELECT note_id FROM note_bot_targets WHERE user_id=?').all(updated.id))bot.syncNote(target.note_id);return send(res,200,{user:updated});}
    if(url.pathname==='/api/state'&&req.method==='GET'){
      const details=projectDetails().filter(p=>auth.projectAccess(user,p.name));
      return send(res,200,{user:auth.publicUser(user),projects:details.map(p=>p.name),projectDetails:details,
        notes:db.prepare('SELECT * FROM notes ORDER BY received DESC').all().map(n=>{const visible=auth.visibleNote(user,n);return visible?{...visible,reminderStates:visible.items.map(item=>bot.reminderState(n,item))}:null;}).filter(Boolean),
        jobs:user.role==='admin'?db.prepare("SELECT id,received,status,error FROM jobs WHERE status!='done' ORDER BY received DESC").all():[],
        capabilities:{ai:aiInfo().configured,aiProvider:aiInfo().name,maxAudioBytes:aiInfo().maxAudioBytes,whatsapp:user.role==='admin'&&whatsappInfo().configured}});
    }
    if(url.pathname.startsWith('/api/bot/')||url.pathname.startsWith('/api/whatsapp/')||url.pathname==='/api/ai/check'||url.pathname==='/api/jobs/retry'||url.pathname.startsWith('/api/projects/'))auth.admin(user);
    if(url.pathname==='/api/projects'&&req.method!=='GET')auth.admin(user);
    if(url.pathname==='/api/bot/status'&&req.method==='GET')return send(res,200,bot.status());
    if(url.pathname==='/api/bot/settings'&&req.method==='PATCH'){const settings=bot.settings(JSON.parse(await body(req,8192)));bot.refreshBlocked();return send(res,200,{settings,message:'Configuración del bot guardada.'});}
    if(url.pathname==='/api/bot/retry'&&req.method==='POST'){const {id}=JSON.parse(await body(req,8192));bot.retry(id);return send(res,200,{message:'Reintento solicitado. Meta podría duplicar un envío cuyo resultado era incierto.'});}
    if(url.pathname==='/api/bot/phone'&&req.method==='PATCH'){auth.setPhone(user.id,JSON.parse(await body(req,8192)).phone);for(const target of db.prepare('SELECT note_id FROM note_bot_targets WHERE user_id=?').all(user.id))bot.syncNote(target.note_id);return send(res,200,{message:'WhatsApp del administrador actualizado.'});}
    const unchanged=note=>{const latest=db.prepare('SELECT * FROM notes WHERE id=?').get(note.id);if(!latest||latest.items!==note.items)throw fail('La nota cambió. Actualiza la página.',409);};
    const captureContext=target=>{
      if(target!==null&&(typeof target!=='string'||!projects().includes(target)))throw fail('Selecciona un proyecto existente.');
      if(user.role!=='admin'&&(!target||!auth.projectAccess(user,target,true)))throw fail('Selecciona uno de tus proyectos con permiso de edición.',403);
      return {user,project:target};
    };
    if(url.pathname==='/api/whatsapp/status' && req.method==='GET') return send(res,200,{...whatsappInfo(),events:db.prepare('SELECT received,summary FROM webhook_events ORDER BY id DESC').all(),lastReceived:db.prepare('SELECT MAX(received) AS value FROM jobs').get().value,lastNote:db.prepare("SELECT MAX(received) AS value FROM notes WHERE source='whatsapp'").get().value});
    if(url.pathname==='/api/whatsapp/check' && req.method==='POST') return send(res,200,await checkWhatsApp());
    if(url.pathname==='/api/ai/check' && req.method==='POST') {
      if(!aiInfo().configured) return send(res,503,{error:'Ejecuta npm run configurar -- gemini (o npm run configurar para OpenAI) y reinicia AL DÍA.'});
      const items=await classify('Para el proyecto Prueba: enviar el presupuesto. También tengo la idea de ofrecer mantenimiento mensual.',['Prueba']);
      return send(res,200,{message:`${aiInfo().name} respondió correctamente. La clasificación está disponible. Sube un audio corto para comprobar también la transcripción.`,items});
    }
    if(url.pathname==='/api/projects' && req.method==='POST') {
      const data=JSON.parse(await body(req));
      const name=projectName(data.name),color=projectColor(data.color===undefined?'#4f8cff':data.color);
      if(projects().includes(name))return send(res,409,{error:'Ya existe un proyecto con ese nombre.'});
      const position=db.prepare('SELECT COALESCE(MAX(position),-1)+1 AS value FROM projects').get().value;
      db.prepare('INSERT INTO projects (name,color,position) VALUES (?,?,?)').run(name,color,position);
      return send(res,201,{ok:true});
    }
    if(url.pathname==='/api/projects/order' && req.method==='PUT') {
      const {names}=JSON.parse(await body(req)),current=projects();
      if(!Array.isArray(names)||names.length!==current.length||new Set(names).size!==current.length||!names.every(name=>current.includes(name)))return send(res,400,{error:'El orden debe incluir todos los proyectos una sola vez. Actualiza la página.'});
      transaction(()=>names.forEach((name,index)=>db.prepare('UPDATE projects SET position=? WHERE name=?').run(index,name)));
      return send(res,200,{ok:true});
    }
    const projectMatch=url.pathname.match(/^\/api\/projects\/([^/]+)$/);
    if(projectMatch&&['PATCH','DELETE'].includes(req.method)) {
      const oldName=decodeURIComponent(projectMatch[1]);
      const existing=db.prepare('SELECT * FROM projects WHERE name=?').get(oldName);
      if(!existing)return send(res,404,{error:'Proyecto no encontrado.'});
      if(req.method==='DELETE') {
        transaction(()=>{rewriteProject(oldName,null);db.prepare('DELETE FROM user_projects WHERE project=?').run(oldName);db.prepare('DELETE FROM projects WHERE name=?').run(oldName);});
        return send(res,200,{message:'Proyecto eliminado. Sus notas se conservaron sin proyecto.'});
      }
      const data=JSON.parse(await body(req)),name=data.name===undefined?oldName:projectName(data.name),color=data.color===undefined?existing.color:projectColor(data.color);
      if(name!==oldName&&projects().includes(name))return send(res,409,{error:'Ya existe un proyecto con ese nombre.'});
      transaction(()=>{db.prepare('UPDATE projects SET name=?,color=? WHERE name=?').run(name,color,oldName);if(name!==oldName){rewriteProject(oldName,name);db.prepare('UPDATE user_projects SET project=? WHERE project=?').run(name,oldName);}});
      for(const n of db.prepare('SELECT id FROM notes').all())bot.syncNote(n.id);
      return send(res,200,{ok:true});
    }
    if(url.pathname==='/api/notes' && req.method==='POST') {
      const {text,project:target=null}=JSON.parse(await body(req));const context=captureContext(target); if(typeof text!=='string') return send(res,400,{error:'Falta el texto.'});
      return send(res,201,await saveNote(text,'texto',randomUUID(),new Date().toISOString(),context));
    }
    if(url.pathname==='/api/audio' && req.method==='POST') {
      const context=captureContext(url.searchParams.get('project'));
      if(!aiInfo().configured) return send(res,503,{error:'Ejecuta npm run configurar -- gemini (o npm run configurar para OpenAI) y reinicia AL DÍA.'});
      const mime=(req.headers['content-type'] || '').split(';')[0];
      if(!['audio/ogg','audio/mpeg','audio/mp4','audio/wav','audio/x-wav','audio/webm'].includes(mime)) return send(res,400,{error:'Formato de audio no admitido.'});
      const text=await transcribe(await body(req,aiInfo().maxAudioBytes),mime); return send(res,201,await saveNote(text,'audio',randomUUID(),new Date().toISOString(),context));
    }
    const match=url.pathname.match(/^\/api\/notes\/([^/]+)(\/classify|\/project)?$/);
    if(match) {
      const note=db.prepare('SELECT * FROM notes WHERE id=?').get(decodeURIComponent(match[1]));
      if(!note||!auth.visibleNote(user,note))return send(res,404,{error:'Nota no encontrada.'});
      if(!auth.fullNote(user,note,true))throw fail('No tienes permiso para modificar la nota completa. Solicita el cambio al administrador.',403);
      if(req.method==='DELETE'&&!match[2]) {
        transaction(()=>{
          db.prepare('DELETE FROM notes WHERE id=?').run(note.id);bot.removeNote(note.id);db.prepare('DELETE FROM note_owners WHERE note_id=?').run(note.id);
          // Keep the WhatsApp delivery ID to avoid recreating a deleted note on retry.
          db.prepare("UPDATE jobs SET payload='{}',status='done',error=NULL WHERE id=?").run(note.id);
        });
        return send(res,200,{message:'Nota eliminada.'});
      }
      if(req.method==='PATCH'&&match[2]==='/project') {
        const data=JSON.parse(await body(req));
        unchanged(note);
        if(!auth.fullNote(user,note,true))throw fail('El acceso a esta nota cambió.',403);
        if(data.project!==null&&(typeof data.project!=='string'||!projects().includes(data.project)))return send(res,400,{error:'Selecciona un proyecto existente o Sin proyecto.'});
        if(!auth.canItem(user,note,{project:data.project},true))throw fail('No tienes permiso de edición en ese proyecto.',403);
        const items=JSON.parse(note.items).map(item=>({...item,project:data.project}));
        db.prepare('UPDATE notes SET items=? WHERE id=?').run(JSON.stringify(items),note.id);bot.syncNote(note.id);
        return send(res,200,{message:'Nota movida.'});
      }
      if(req.method==='POST' && match[2]==='/classify') {
        if(!aiInfo().configured) return send(res,503,{error:'Falta configurar IA.'});
        const allowed=projects().filter(name=>auth.projectAccess(user,name,true));
        const items=checkedItems(await classify(note.transcript,allowed,new Date(note.received)));
        const current=db.prepare('SELECT * FROM notes WHERE id=?').get(note.id);
        if(!current||current.items!==note.items)throw fail('La nota cambió. Actualiza la página antes de clasificarla.',409);
        if(!auth.fullNote(user,current,true)||items.some(item=>!auth.projectAccess(user,item.project,true)))throw fail('La clasificación requiere acceso de edición a todos sus proyectos.',403);
        db.prepare('UPDATE notes SET items=?, classified=1 WHERE id=?').run(JSON.stringify(items),note.id);bot.syncNote(note.id,user.id); return send(res,200,{ok:true});
      }
      if(req.method==='PATCH' && !match[2]) {
        const {items}=JSON.parse(await body(req)); const valid=checkedItems(items);
        unchanged(note);
        if(!auth.fullNote(user,note,true)||valid.some(item=>!auth.canItem(user,note,item,true)))throw fail('No tienes permiso de edición en todos los proyectos seleccionados.',403);
        db.prepare('UPDATE notes SET items=?, classified=1 WHERE id=?').run(JSON.stringify(valid),note.id);bot.syncNote(note.id,user.id); return send(res,200,{ok:true});
      }
    }
    if(url.pathname==='/api/jobs/retry' && req.method==='POST') {
      db.prepare("UPDATE jobs SET status='pending',error=NULL WHERE status='error'").run(); return send(res,200,{ok:true});
    }
    send(res,404,{error:'No encontrado.'});
  } catch(e) { send(res,e.status || 400,{error:e instanceof SyntaxError ? 'Solicitud inválida.' : e.message}); }
}
if(auth.bootstrapToken)console.log(`Instalación inicial: abre AL DÍA en este equipo y usa el código ${auth.bootstrapToken}`);
const server=http.createServer((req,res)=>handleRequest(req,res));
const webhookPort=process.env.WHATSAPP_WEBHOOK_PORT;
if(webhookPort && (!/^\d+$/.test(webhookPort)||Number(webhookPort)<1||Number(webhookPort)>65535||Number(webhookPort)===Number(process.env.PORT||3000))) throw new Error('Configura un WHATSAPP_WEBHOOK_PORT válido y distinto del dashboard.');
const webhookServer=webhookPort?http.createServer((req,res)=>handleRequest(req,res,true)):null;
const timer=setInterval(()=>{void processJobs().catch(()=>{});void bot.deliver().catch(()=>{});},1000);
server.listen(Number(process.env.PORT || 3000),host,()=>console.log(`Dashboard iniciado en puerto ${server.address().port}.`));
if(webhookServer)webhookServer.listen(Number(webhookPort),'127.0.0.1',()=>console.log(`Receptor de WhatsApp iniciado en puerto ${webhookPort}.`));
function shutdown() { clearInterval(timer);if(webhookServer)webhookServer.close();server.close(()=>{db.close();process.exit(0);}); }
process.on('SIGTERM',shutdown); process.on('SIGINT',shutdown);
