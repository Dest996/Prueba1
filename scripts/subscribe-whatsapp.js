import {createInterface} from 'node:readline/promises';
import {subscribeWhatsAppAccount} from '../whatsapp.js';

async function main() {
  if(!process.stdin.isTTY)throw new Error('Abre una terminal en la carpeta de Hilo para ejecutar este comando.');
  if(!process.env.WHATSAPP_ACCESS_TOKEN || !process.env.WHATSAPP_PHONE_NUMBER_ID)throw new Error('No se encontró la configuración. Ejecuta desde la carpeta que contiene .env usando node --env-file=.env scripts/subscribe-whatsapp.js.');
  console.log('\nAsociar la app a tu cuenta de WhatsApp Business\nEste paso suscribe la app asociada al token para recibir eventos de esa cuenta. No envía mensajes ni cambia el webhook, las claves ni otras apps suscritas.\n');
  console.log('En Meta → Paso 1. Probar, copia el Identificador de la cuenta WhatsApp Business que aparece junto al Phone Number ID. Son datos distintos. No pegues un token aquí.\n');
  const rl=createInterface({input:process.stdin,output:process.stdout});
  let accountId;
  try {accountId=(await rl.question('Identificador de la cuenta WhatsApp Business: ')).trim();}finally{rl.close();}
  if(!accountId){console.log('Cancelado. No se realizó ningún cambio.');return;}
  console.log('Comprobando el número y solicitando la suscripción a Meta…');
  console.log((await subscribeWhatsAppAccount(accountId)).message);
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
