import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,existsSync} from 'node:fs';
import {createInterface} from 'node:readline/promises';
import {Writable} from 'node:stream';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {hashPassword,password} from '../auth.js';

export async function resetAdminPassword(db,value){
  const user=db.prepare("SELECT id FROM users WHERE role='admin' LIMIT 1").get();
  if(!user)throw new Error('No existe una cuenta administradora. Inicia Hilo para crearla.');
  const hash=await hashPassword(password(value));
  db.exec('BEGIN');try{
    db.prepare('UPDATE users SET password_hash=?,active=1 WHERE id=?').run(hash,user.id);
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);
    db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
}
async function main(){
  if(!process.stdin.isTTY||!process.stdout.isTTY)throw new Error('Abre PowerShell en la carpeta de Hilo y ejecuta npm run configurar:admin de forma interactiva.');
  if(!existsSync('data/notes.sqlite'))throw new Error('Inicia Hilo primero para crear el administrador.');
  const db=new DatabaseSync('data/notes.sqlite');
  try{
    if(!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").get())throw new Error('Actualiza e inicia Hilo primero para migrar los usuarios.');
    const admin=db.prepare("SELECT username FROM users WHERE role='admin' LIMIT 1").get();
    if(!admin)throw new Error('Inicia Hilo primero para crear el administrador.');
    console.log(`Recuperar la cuenta ${admin.username}. Detén Hilo antes de continuar. Se conservarán las notas y la configuración.`);
    let hidden=false;
    const output=new Writable({write(chunk,encoding,callback){if(!hidden)process.stdout.write(chunk,encoding);callback();}});output.isTTY=true;output.columns=process.stdout.columns;
    const rl=createInterface({input:process.stdin,output,terminal:true});
    let value,confirmation;
    try{
      process.stdout.write('Nueva contraseña (mínimo 10 caracteres; texto oculto): ');hidden=true;value=await rl.question('');hidden=false;process.stdout.write('\n');
      process.stdout.write('Repite la contraseña: ');hidden=true;confirmation=await rl.question('');
    }finally{hidden=false;rl.close();process.stdout.write('\n');}
    if(!value){console.log('Cancelado. No se realizaron cambios.');return;}
    password(value);if(value!==confirmation)throw new Error('Las contraseñas no coinciden. No se realizaron cambios.');
    mkdirSync('data/backups',{recursive:true});db.prepare('VACUUM INTO ?').run(`data/backups/before-admin-reset-${Date.now()}-${randomUUID()}.sqlite`);
    await resetAdminPassword(db,value);
    console.log('Contraseña actualizada y sesiones del administrador cerradas. Ejecuta npm start e inicia sesión.');
  }finally{db.close();}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error.message);process.exitCode=1;});
