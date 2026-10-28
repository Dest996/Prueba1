import {readFileSync,writeFileSync,existsSync,lstatSync} from 'node:fs';
import {parseEnv} from 'node:util';
import {randomBytes} from 'node:crypto';
import {createInterface} from 'node:readline/promises';
import {Writable} from 'node:stream';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export function configureWhatsApp(contents,{from,phoneId,appSecret,accessToken}) {
  from=from.replace(/[+\s()-]/g,'');
  if(!/^\d{7,15}$/.test(from)) throw new Error('Introduce tu número personal con código de país, por ejemplo 56912345678.');
  if(!/^\d+$/.test(phoneId)) throw new Error('Copia el identificador numérico del número del bot (Phone number ID), no el número de teléfono.');
  if(!/^[a-fA-F0-9]{32}$/.test(appSecret)) throw new Error('El App Secret debe tener los 32 caracteres hexadecimales que muestra Meta.');
  if(!/^[A-Za-z0-9._|-]{20,}$/.test(accessToken)) throw new Error('El token contiene caracteres inesperados o está incompleto.');
  const previous=parseEnv(contents);
  const verifyToken=previous.WHATSAPP_VERIFY_TOKEN || randomBytes(24).toString('hex');
  if(!/^[A-Za-z0-9._-]{16,}$/.test(verifyToken)) throw new Error('El token de verificación existente debe tener al menos 16 caracteres seguros. Revísalo en .env.');
  const port=previous.WHATSAPP_WEBHOOK_PORT || '3001';
  if(!/^\d+$/.test(port)||Number(port)<1||Number(port)>65535||Number(port)===Number(previous.PORT||3000)) throw new Error('WHATSAPP_WEBHOOK_PORT debe ser un puerto válido distinto del dashboard.');
  const values={WHATSAPP_ALLOWED_FROM:from,WHATSAPP_PHONE_NUMBER_ID:phoneId,WHATSAPP_APP_SECRET:appSecret,WHATSAPP_ACCESS_TOKEN:accessToken,WHATSAPP_VERIFY_TOKEN:verifyToken,WHATSAPP_WEBHOOK_PORT:port};
  const found=new Set();
  const updated=[];
  for(const line of contents.replace(/\r\n/g,'\n').split('\n')) {
    const name=line.match(/^\s*(?:export\s+)?([A-Z_]+)\s*=/)?.[1];
    if(Object.hasOwn(values,name)){if(!found.has(name))updated.push(`${name}=${values[name]}`);found.add(name);}else updated.push(line);
  }
  for(const [name,value] of Object.entries(values))if(!found.has(name))updated.push(`${name}=${value}`);
  return updated.join('\n').replace(/\n*$/,'\n');
}
async function main() {
  if(!process.stdin.isTTY||!process.stdout.isTTY)throw new Error('Ejecuta npm run configurar:whatsapp en una terminal interactiva.');
  if(existsSync('.env')&&!lstatSync('.env').isFile())throw new Error('.env debe ser un archivo local normal.');
  console.log('\nConectar WhatsApp con AL DÍA\nNecesitas una app de Meta con WhatsApp, su número de pruebas y tu número personal autorizado como destinatario de pruebas.\nNo pegues credenciales en chats ni en GitHub.\n');
  let hidden=false;
  const output=new Writable({write(chunk,encoding,callback){if(!hidden)process.stdout.write(chunk,encoding);callback();}});output.isTTY=true;output.columns=process.stdout.columns;
  const rl=createInterface({input:process.stdin,output,terminal:true});
  async function ask(label,secret=false){process.stdout.write(label);hidden=secret;try{return(await rl.question('')).trim();}finally{if(secret)process.stdout.write('\n');hidden=false;}}
  let values;
  try {
    const from=await ask('Tu número personal con código de país: ');
    const phoneId=await ask('Phone number ID del bot (identificador numérico de Meta): ');
    const appSecret=await ask('App Secret de la app de Meta (oculto): ',true);
    const accessToken=await ask('Access token de WhatsApp (oculto): ',true);
    if(!from||!phoneId||!appSecret||!accessToken){console.log('Cancelado. No se modificó .env.');return;}
    values={from,phoneId,appSecret,accessToken};
  }finally{rl.close();}
  const original=existsSync('.env')?readFileSync('.env','utf8'):readFileSync('.env.example','utf8');
  writeFileSync('.env',configureWhatsApp(original,values),{mode:0o600});
  console.log('\nConfiguración guardada. Reinicia con npm start.\nAbre .env en Bloc de notas para copiar únicamente WHATSAPP_VERIFY_TOKEN en Meta.\nConsulta docs/whatsapp-windows.md para publicar el webhook de pruebas por HTTPS.');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(e.message);process.exitCode=1;});
