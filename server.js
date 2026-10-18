import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { timingSafeEqual, createHmac, randomUUID } from 'node:crypto';
import { validateItems, fallbackItems } from './domain.js';
import { classify, transcribe } from './ai.js';

const host = process.env.HOST || '127.0.0.1';
if (!['127.0.0.1', 'localhost', '::1'].includes(host) && !process.env.DASHBOARD_PASSWORD) throw new Error('Configura DASHBOARD_PASSWORD antes de exponer el servidor.');
mkdirSync('data', { recursive:true });
const db = new DatabaseSync('data/notes.sqlite');
db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS projects (name TEXT PRIMARY KEY); CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, received TEXT NOT NULL, source TEXT NOT NULL, transcript TEXT NOT NULL, items TEXT NOT NULL, classified INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, received TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', error TEXT);`);
db.prepare("UPDATE jobs SET status='pending' WHERE status='processing'").run();
const projects = () => db.prepare('SELECT name FROM projects ORDER BY name').all().map(p=>p.name);
function equal(a,b) { const x=Buffer.from(a || ''), y=Buffer.from(b || ''); return x.length === y.length && timingSafeEqual(x,y); }
function send(res, status, value) { res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}); res.end(JSON.stringify(value)); }
async function body(req, limit=1024*1024) { const chunks=[]; let size=0; for await (const chunk of req) { size+=chunk.length; if(size>limit) { const e=new Error('Archivo demasiado grande.'); e.status=413; throw e; } chunks.push(chunk); } return Buffer.concat(chunks); }
async function saveNote(text, source, id=randomUUID(), received=new Date().toISOString()) {
  if (!text?.trim() || text.length>30000) throw new Error('El texto debe tener entre 1 y 30000 caracteres.');
  let items=fallbackItems(text), classified=0, warning=null;
  if (process.env.OPENAI_API_KEY) {
    try { items=await classify(text,projects(),new Date(received)); classified=1; }
    catch (e) { warning=`${e.message} Se guardó el texto para revisarlo y reintentar.`; }
  }
  db.prepare('INSERT OR IGNORE INTO notes VALUES (?,?,?,?,?,?)').run(id,received,source,text,JSON.stringify(items),classified);
  return {id,warning};
}
async function getMedia(id) {
  if (!/^\d+$/.test(id)) throw new Error('Identificador de audio inválido.');
  const headers={Authorization:`Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`};
  const response=await fetch(`https://graph.facebook.com/v23.0/${id}`,{headers,signal:AbortSignal.timeout(30000)});
  if(!response.ok) throw new Error(`WhatsApp: HTTP ${response.status} al consultar audio.`);
  const meta=await response.json(), url=new URL(meta.url);
  if(url.protocol!=='https:' || !['lookaside.fbsbx.com','lookaside.facebook.com'].includes(url.hostname)) throw new Error('Destino de audio no permitido.');
  const media=await fetch(url,{headers,redirect:'error',signal:AbortSignal.timeout(60000)});
  if(!media.ok) throw new Error(`WhatsApp: HTTP ${media.status} al descargar audio.`);
  const audio=await body(media.body,20*1024*1024);
  return transcribe(audio,(meta.mime_type || 'audio/ogg').split(';')[0]);
}
let working=false;
async function processJobs() {
  if(working) return; working=true;
  try {
    const job=db.prepare("SELECT * FROM jobs WHERE status='pending' ORDER BY received LIMIT 1").get();
    if(!job) return;
    db.prepare("UPDATE jobs SET status='processing', error=NULL WHERE id=?").run(job.id);
    try {
      const msg=JSON.parse(job.payload);
      const text=msg.type==='audio' ? await getMedia(msg.audio.id) : msg.text.body;
      await saveNote(text,'whatsapp',job.id,job.received);
      db.prepare("UPDATE jobs SET status='done' WHERE id=?").run(job.id);
    } catch(e) { db.prepare("UPDATE jobs SET status='error', error=? WHERE id=?").run(e.message,job.id); }
  } finally { working=false; }
}
const server=http.createServer(async(req,res)=>{
  try {
    const url=new URL(req.url,'http://localhost');
    if(url.pathname==='/webhook' && req.method==='GET') {
      if(process.env.WHATSAPP_VERIFY_TOKEN && url.searchParams.get('hub.mode')==='subscribe' && equal(url.searchParams.get('hub.verify_token'),process.env.WHATSAPP_VERIFY_TOKEN)) { res.writeHead(200,{'Content-Type':'text/plain'}); return res.end(url.searchParams.get('hub.challenge')); }
      return send(res,403,{error:'Verificación rechazada.'});
    }
    if(url.pathname==='/webhook' && req.method==='POST') {
      if(!process.env.WHATSAPP_APP_SECRET) return send(res,503,{error:'Webhook sin configurar.'});
      const raw=await body(req);
      const signature='sha256='+createHmac('sha256',process.env.WHATSAPP_APP_SECRET).update(raw).digest('hex');
      if(!equal(req.headers['x-hub-signature-256'],signature)) return send(res,403,{error:'Firma inválida.'});
      const event=JSON.parse(raw);
      for(const entry of event.entry || []) for(const change of entry.changes || []) for(const msg of change.value?.messages || []) {
        if(!['audio','text'].includes(msg.type)) continue;
        if(!process.env.WHATSAPP_ALLOWED_FROM || msg.from!==process.env.WHATSAPP_ALLOWED_FROM) continue;
        if(!msg.id || (msg.type==='audio' && !msg.audio?.id) || (msg.type==='text' && typeof msg.text?.body!=='string')) continue;
        const received=msg.timestamp && /^\d+$/.test(msg.timestamp) ? new Date(Number(msg.timestamp)*1000).toISOString() : new Date().toISOString();
        db.prepare('INSERT OR IGNORE INTO jobs (id,received,payload) VALUES (?,?,?)').run(msg.id,received,JSON.stringify(msg));
      }
      return send(res,200,{ok:true});
    }
    // Browser mutations must originate from this dashboard. No CORS is enabled.
    if(!['GET','HEAD'].includes(req.method) && req.headers.origin) {
      const origin=new URL(req.headers.origin);
      if(origin.host!==req.headers.host) return send(res,403,{error:'Origen inválido.'});
    }
    if(process.env.DASHBOARD_PASSWORD) {
      const credentials=Buffer.from((req.headers.authorization || '').replace(/^Basic /,''),'base64').toString();
      if(!equal(credentials,`${process.env.DASHBOARD_USER || 'admin'}:${process.env.DASHBOARD_PASSWORD}`)) { res.setHeader('WWW-Authenticate','Basic realm="Notas personales"'); return send(res,401,{error:'Acceso privado.'}); }
    }
    if(url.pathname==='/api/state' && req.method==='GET') return send(res,200,{projects:projects(),notes:db.prepare('SELECT * FROM notes ORDER BY received DESC').all().map(n=>({...n,items:JSON.parse(n.items),classified:Boolean(n.classified)})),jobs:db.prepare("SELECT id,received,status,error FROM jobs WHERE status!='done' ORDER BY received DESC").all(),capabilities:{ai:Boolean(process.env.OPENAI_API_KEY),whatsapp:Boolean(process.env.WHATSAPP_APP_SECRET && process.env.WHATSAPP_VERIFY_TOKEN && process.env.WHATSAPP_ACCESS_TOKEN && process.env.WHATSAPP_ALLOWED_FROM)}});
    if(url.pathname==='/api/ai/check' && req.method==='POST') {
      if(!process.env.OPENAI_API_KEY) return send(res,503,{error:'Ejecuta npm run configurar en la carpeta de Hilo y reinicia el servidor.'});
      const items=await classify('Para el proyecto Prueba: enviar el presupuesto. También tengo la idea de ofrecer mantenimiento mensual.',['Prueba']);
      return send(res,200,{message:'OpenAI respondió correctamente. La clasificación está disponible. Sube un audio corto para comprobar también la transcripción.',items});
    }
    if(url.pathname==='/api/projects' && req.method==='POST') {
      const {name}=JSON.parse(await body(req));
      if(typeof name!=='string' || !name.trim() || name.length>100) return send(res,400,{error:'Nombre inválido.'});
      db.prepare('INSERT OR IGNORE INTO projects VALUES (?)').run(name.trim()); return send(res,201,{ok:true});
    }
    if(url.pathname==='/api/notes' && req.method==='POST') {
      const {text}=JSON.parse(await body(req)); if(typeof text!=='string') return send(res,400,{error:'Falta el texto.'});
      return send(res,201,await saveNote(text,'texto'));
    }
    if(url.pathname==='/api/audio' && req.method==='POST') {
      if(!process.env.OPENAI_API_KEY) return send(res,503,{error:'Configura OPENAI_API_KEY para transcribir audios.'});
      const mime=(req.headers['content-type'] || '').split(';')[0];
      if(!['audio/ogg','audio/mpeg','audio/mp4','audio/wav','audio/x-wav','audio/webm'].includes(mime)) return send(res,400,{error:'Formato de audio no admitido.'});
      const text=await transcribe(await body(req,20*1024*1024),mime); return send(res,201,await saveNote(text,'audio'));
    }
    const match=url.pathname.match(/^\/api\/notes\/([^/]+)(\/classify)?$/);
    if(match) {
      const note=db.prepare('SELECT * FROM notes WHERE id=?').get(match[1]);
      if(!note) return send(res,404,{error:'Nota no encontrada.'});
      if(req.method==='POST' && match[2]) {
        if(!process.env.OPENAI_API_KEY) return send(res,503,{error:'Falta configurar IA.'});
        const items=await classify(note.transcript,projects(),new Date(note.received));
        db.prepare('UPDATE notes SET items=?, classified=1 WHERE id=?').run(JSON.stringify(items),note.id); return send(res,200,{ok:true});
      }
      if(req.method==='PATCH' && !match[2]) {
        const {items}=JSON.parse(await body(req)); const valid=validateItems(items);
        db.prepare('UPDATE notes SET items=?, classified=1 WHERE id=?').run(JSON.stringify(valid),note.id); return send(res,200,{ok:true});
      }
    }
    if(url.pathname==='/api/jobs/retry' && req.method==='POST') {
      db.prepare("UPDATE jobs SET status='pending',error=NULL WHERE status='error'").run(); return send(res,200,{ok:true});
    }
    const files={'/':['public/index.html','text/html; charset=utf-8'],'/app.js':['public/app.js','text/javascript; charset=utf-8'],'/style.css':['public/style.css','text/css; charset=utf-8']};
    if(req.method==='GET' && files[url.pathname]) { const [file,type]=files[url.pathname]; res.writeHead(200,{'Content-Type':type,'X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'"}); return res.end(readFileSync(file)); }
    send(res,404,{error:'No encontrado.'});
  } catch(e) { send(res,e.status || 400,{error:e instanceof SyntaxError ? 'Solicitud inválida.' : e.message}); }
});
const timer=setInterval(()=>void processJobs(),1000);
server.listen(Number(process.env.PORT || 3000),host,()=>console.log(`Dashboard iniciado en puerto ${server.address().port}.`));
function shutdown() { clearInterval(timer); server.close(()=>{db.close();process.exit(0);}); }
process.on('SIGTERM',shutdown); process.on('SIGINT',shutdown);
