import { randomBytes, createHash, scrypt as derive, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
const scrypt=promisify(derive);
const sessionAge=12*60*60*1000;
export const fail=(message,status=400)=>Object.assign(new Error(message),{status});
export function username(value){
  if(typeof value!=='string'||! /^[a-z0-9][a-z0-9._-]{2,63}$/i.test(value.trim()))throw fail('El usuario debe tener entre 3 y 64 letras, números, puntos, guiones o guiones bajos.');
  return value.trim().toLowerCase();
}
export function password(value){if(typeof value!=='string'||value.length<6||value.length>200)throw fail('La contraseña debe tener entre 6 y 200 caracteres.');return value;}
export async function hashPassword(value){const salt=randomBytes(16).toString('hex');const key=await scrypt(value,salt,64);return `scrypt:${salt}:${key.toString('hex')}`;}
export async function verifyPassword(value,hash){
  if(typeof value!=='string'||value.length>1024)return false;
  const [,salt,digest]=hash.split(':');const key=await scrypt(value,salt,64);const expected=Buffer.from(digest,'hex');return key.length===expected.length&&timingSafeEqual(key,expected);
}
const digest=token=>createHash('sha256').update(token).digest('hex');
export async function createAuth(db){
  if(!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").get()){
    if(db.prepare('SELECT COUNT(*) AS n FROM notes').get().n||db.prepare('SELECT COUNT(*) AS n FROM projects').get().n){
      const {mkdirSync}=await import('node:fs');mkdirSync('data/backups',{recursive:true});
      db.prepare('VACUUM INTO ?').run(`data/backups/before-users-${Date.now()}-${randomBytes(6).toString('hex')}.sqlite`);
    }
  }
  db.exec(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY,username TEXT NOT NULL UNIQUE COLLATE NOCASE,display_name TEXT NOT NULL,password_hash TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('admin','user')),active INTEGER NOT NULL DEFAULT 1,created TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS user_projects (user_id TEXT NOT NULL,project TEXT NOT NULL,access TEXT NOT NULL CHECK(access IN ('view','edit')),PRIMARY KEY(user_id,project));
    CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL,csrf TEXT NOT NULL,expires INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);`);
  const hasUsers=()=>Boolean(db.prepare('SELECT 1 FROM users LIMIT 1').get());
  if(!hasUsers()&&process.env.DASHBOARD_PASSWORD){
    const name=(process.env.DASHBOARD_USER||'admin').trim().toLowerCase();
    if(!name||name.length>128)throw fail('DASHBOARD_USER debe tener entre 1 y 128 caracteres.');
    db.prepare('INSERT INTO users VALUES (?,?,?,?,?,?,?)').run(randomBytes(16).toString('hex'),name,name,await hashPassword(process.env.DASHBOARD_PASSWORD),'admin',1,new Date().toISOString());
  }
  const bootstrapToken=hasUsers()?null:randomBytes(24).toString('hex');
  const dummyHash=await hashPassword(randomBytes(32).toString('hex'));
  const attempts=new Map();
  const grants=id=>db.prepare('SELECT project,access FROM user_projects WHERE user_id=? ORDER BY project').all(id);
  const publicUser=user=>({id:user.id,username:user.username,displayName:user.display_name,role:user.role,active:Boolean(user.active),grants:user.role==='admin'?[]:grants(user.id)});
  function currentUser(id){const u=db.prepare('SELECT * FROM users WHERE id=? AND active=1').get(id);if(!u)throw fail('La sesión ha caducado. Vuelve a iniciar sesión.',401);return u;}
  function identity(req){
    const cookie=(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('hilo_session='));
    const token=cookie?.slice('hilo_session='.length);
    if(!token||! /^[a-f0-9]{64}$/.test(token))return null;
    const session=db.prepare('SELECT * FROM sessions WHERE token_hash=? AND expires>?').get(digest(token),Date.now());
    if(!session)return null;
    const user=db.prepare('SELECT * FROM users WHERE id=? AND active=1').get(session.user_id);
    return user?{user,session}:null;
  }
  function sessionCookie(req,token,maxAge){
    const secure=req.socket.encrypted||process.env.SESSION_COOKIE_SECURE==='1';
    return `hilo_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure?'; Secure':''}`;
  }
  function issue(req,res,user){
    db.prepare('DELETE FROM sessions WHERE expires<=?').run(Date.now());
    const token=randomBytes(32).toString('hex'),csrf=randomBytes(24).toString('hex');
    db.prepare('INSERT INTO sessions VALUES (?,?,?,?)').run(digest(token),user.id,csrf,Date.now()+sessionAge);
    res.setHeader('Set-Cookie',sessionCookie(req,token,sessionAge/1000));
    return {user:publicUser(user),csrf,setupRequired:false};
  }
  function projectAccess(user,name,write=false){
    user=currentUser(user.id);
    if(user.role==='admin')return true;
    if(!name)return false;
    const grant=db.prepare('SELECT access FROM user_projects WHERE user_id=? AND project=?').get(user.id,name);
    return Boolean(grant&&(!write||grant.access==='edit'));
  }
  function admin(user){if(currentUser(user.id).role!=='admin')throw fail('Esta acción requiere una cuenta de administrador.',403);}
  function fullNote(user,note,write=false){return JSON.parse(note.items).every(item=>projectAccess(user,item.project,write));}
  function visibleNote(user,note){
    const items=JSON.parse(note.items),visible=items.filter(item=>projectAccess(user,item.project));
    if(!visible.length)return null;
    const partial=visible.length!==items.length;
    // The transcript can mention projects the caller cannot access.
    return {id:note.id,received:note.received,source:note.source,classified:Boolean(note.classified),items:visible,transcript:partial?null:note.transcript,partial,canEdit:!partial&&fullNote(user,note,true)};
  }
  function csrf(req,who){
    if(!who||typeof req.headers['x-csrf-token']!=='string'||req.headers['x-csrf-token']!==who.session.csrf)throw fail('Sesión inválida. Actualiza la página.',403);
  }
  function throttle(req,name){
    const now=Date.now();
    for(const [key,value] of attempts)if(value.until<=now)attempts.delete(key);
    const keys=[`ip:${req.socket.remoteAddress}`,`user:${name.toLowerCase()}`];
    if(keys.some(key=>(attempts.get(key)?.count||0)>=10))throw fail('Demasiados intentos. Espera 15 minutos antes de volver a probar.',429);
    for(const key of keys){const previous=attempts.get(key);attempts.set(key,{count:(previous?.count||0)+1,until:previous?.until||now+15*60*1000});}
    if(attempts.size>10000)throw fail('Demasiados intentos. Vuelve a intentarlo más tarde.',429);
    return ()=>keys.forEach(key=>attempts.delete(key));
  }
  async function login(req,res,data){
    const name=typeof data.username==='string'?data.username.trim().slice(0,128):'';
    const clear=throttle(req,name),user=db.prepare('SELECT * FROM users WHERE username=?').get(name);
    const valid=await verifyPassword(data.password,user?.password_hash||dummyHash);
    if(!valid||!user?.active)throw fail('Usuario o contraseña incorrectos.',401);
    // Re-read after the asynchronous password derivation to honor disable/reset.
    const fresh=currentUser(user.id);if(fresh.password_hash!==user.password_hash)throw fail('Usuario o contraseña incorrectos.',401);
    clear();const old=identity(req);if(old)db.prepare('DELETE FROM sessions WHERE token_hash=?').run(old.session.token_hash);
    return issue(req,res,fresh);
  }
  async function setup(req,res,data){
    if(hasUsers())throw fail('El administrador ya está configurado.',409);
    const clear=throttle(req,'initial-setup');
    if(!bootstrapToken||data.setupToken!==bootstrapToken||!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress))throw fail('El código de instalación no es válido.',403);
    const name=username(data.username),hash=await hashPassword(password(data.password));
    if(hasUsers())throw fail('El administrador ya está configurado.',409);
    const id=randomBytes(16).toString('hex');db.prepare('INSERT INTO users VALUES (?,?,?,?,?,?,?)').run(id,name,name,hash,'admin',1,new Date().toISOString());
    clear();return issue(req,res,currentUser(id));
  }
  function logout(req,res,who){if(who)db.prepare('DELETE FROM sessions WHERE token_hash=?').run(who.session.token_hash);res.setHeader('Set-Cookie',sessionCookie(req,'',0));}
  function checkedGrants(value){
    if(!Array.isArray(value)||value.length>1000)throw fail('Selecciona los proyectos y su nivel de acceso.');
    const names=new Set();
    return value.map(g=>{
      if(!g||typeof g.project!=='string'||!['view','edit'].includes(g.access)||names.has(g.project)||!db.prepare('SELECT 1 FROM projects WHERE name=?').get(g.project))throw fail('Proyecto o permiso inválido.');
      names.add(g.project);return {project:g.project,access:g.access};
    });
  }
  function assign(id,list){db.prepare('DELETE FROM user_projects WHERE user_id=?').run(id);for(const g of list)db.prepare('INSERT INTO user_projects VALUES (?,?,?)').run(id,g.project,g.access);}
  function displayName(data){if(typeof data.displayName!=='string'||!data.displayName.trim()||data.displayName.trim().length>100)throw fail('El nombre debe tener entre 1 y 100 caracteres.');return data.displayName.trim();}
  const listUsers=()=>db.prepare('SELECT * FROM users ORDER BY role,username').all().map(publicUser);
  async function createUser(actor,data){
    admin(actor);const name=username(data.username),display=displayName(data),hash=await hashPassword(password(data.password));admin(actor);
    const list=checkedGrants(data.grants||[]);
    if(db.prepare('SELECT 1 FROM users WHERE username=?').get(name))throw fail('Ese usuario ya existe.',409);
    if(data.active!==undefined&&typeof data.active!=='boolean')throw fail('Estado de usuario inválido.');
    const id=randomBytes(16).toString('hex');
    db.exec('BEGIN');try{db.prepare('INSERT INTO users VALUES (?,?,?,?,?,?,?)').run(id,name,display,hash,'user',data.active===false?0:1,new Date().toISOString());assign(id,list);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
    return listUsers().find(user=>user.id===id);
  }
  async function updateUser(actor,id,data){
    admin(actor);const target=db.prepare('SELECT * FROM users WHERE id=?').get(id);
    if(!target)throw fail('Usuario no encontrado.',404);
    if(target.role==='admin')throw fail('La cuenta administradora se gestiona desde Mi cuenta.',403);
    const display=data.displayName===undefined?target.display_name:displayName(data);
    if(data.active!==undefined&&typeof data.active!=='boolean')throw fail('Estado de usuario inválido.');
    const hash=data.password===undefined?null:await hashPassword(password(data.password));admin(actor);
    const list=data.grants===undefined?null:checkedGrants(data.grants);
    db.exec('BEGIN');try{
      db.prepare('UPDATE users SET display_name=?,active=?,password_hash=COALESCE(?,password_hash) WHERE id=?').run(display,data.active===undefined?target.active:Number(data.active),hash,id);
      if(list)assign(id,list);
      if(hash||data.active===false)db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
      db.exec('COMMIT');
    }catch(e){db.exec('ROLLBACK');throw e;}
    return listUsers().find(u=>u.id===id);
  }
  async function changePassword(user,data){
    const before=currentUser(user.id);
    if(!await verifyPassword(data.currentPassword,before.password_hash))throw fail('La contraseña actual no es correcta.',403);
    const hash=await hashPassword(password(data.password)),fresh=currentUser(user.id);
    if(fresh.password_hash!==before.password_hash)throw fail('La contraseña cambió. Inicia sesión de nuevo.',401);
    db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hash,user.id);
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);
  }
  return {hasUsers,bootstrapToken,publicUser,currentUser,identity,issue,projectAccess,admin,fullNote,visibleNote,csrf,login,setup,logout,listUsers,createUser,updateUser,changePassword};
}
