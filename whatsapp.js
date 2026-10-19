import {createHash} from 'node:crypto';
export function whatsappInfo() {
  const names=['WHATSAPP_APP_SECRET','WHATSAPP_VERIFY_TOKEN','WHATSAPP_ACCESS_TOKEN','WHATSAPP_ALLOWED_FROM','WHATSAPP_PHONE_NUMBER_ID'];
  const missing=names.filter(name=>!process.env[name]?.trim());
  return {configured:missing.length===0,missing,webhookPort:Number(process.env.WHATSAPP_WEBHOOK_PORT)||null};
}
function graphVersion() {
  const version=process.env.WHATSAPP_GRAPH_VERSION || 'v23.0';
  if(!/^v\d+\.\d+$/.test(version)) throw new Error('WHATSAPP_GRAPH_VERSION debe tener un formato como v23.0.');
  return version;
}
async function graph(path) {
  if(!process.env.WHATSAPP_ACCESS_TOKEN) throw new Error('Configura WhatsApp con npm run configurar:whatsapp.');
  const response=await fetch(`https://graph.facebook.com/${graphVersion()}/${path}`,{headers:{Authorization:`Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`},signal:AbortSignal.timeout(30000)});
  if(!response.ok) {
    // Read only diagnostic codes; never surface Meta's raw messages or tokens.
    let code,subcode;
    try {const error=(await response.json()).error;code=error?.code;subcode=error?.error_subcode;}catch{}
    if(code===190||code===102) {
      if(subcode===463) throw new Error('El access token de Meta caducó (código 190/463). Genera otro en Paso 1. Probar, actualízalo con npm run configurar:whatsapp y reinicia Hilo.');
      throw new Error('Meta rechazó el access token (código '+code+'). Copia el Identificador de acceso de Paso 1. Probar, no el App Secret. Actualízalo con npm run configurar:whatsapp y reinicia Hilo.');
    }
    if(code===100) throw new Error('Meta no pudo consultar ese objeto o sus campos (código 100). Comprueba WHATSAPP_PHONE_NUMBER_ID: debe ser el Phone Number ID junto al número de pruebas. Si coincide, revisa que el token pertenezca a esa app y tenga acceso a ese número.');
    if(code===10||code===200) throw new Error('Meta indicó permisos insuficientes (código '+code+'). Revisa los permisos del token y su acceso al número de WhatsApp Business en tu app de Meta.');
    if([401,403].includes(response.status)) throw new Error('Meta rechazó el acceso. Revisa si el token expiró y si tiene permisos para tu número de WhatsApp Business.');
    throw new Error(`Meta respondió HTTP ${response.status}. Revisa el identificador del número y el token en tu app de Meta.`);
  }
  return response.json();
}
export async function checkWhatsApp() {
  const info=whatsappInfo();
  if(!info.configured) throw new Error('Completa npm run configurar:whatsapp y reinicia Hilo.');
  const id=process.env.WHATSAPP_PHONE_NUMBER_ID;
  if(!/^\d+$/.test(id)) throw new Error('El identificador del número debe ser numérico.');
  const data=await graph(`${id}?fields=id,display_phone_number,verified_name`);
  if(data.id!==id) throw new Error('Meta no devolvió el número esperado.');
  return {message:`Meta permite acceder al número ${data.display_phone_number || 'configurado'}. Falta verificar el webhook y enviar un audio real para comprobar la recepción.`};
}
export async function downloadWhatsAppAudio(id,maxBytes) {
  if(!/^\d+$/.test(id)) throw new Error('Identificador de audio inválido.');
  const meta=await graph(id),url=new URL(meta.url);
  if(url.protocol!=='https:' || !['lookaside.fbsbx.com','lookaside.facebook.com'].includes(url.hostname)) throw new Error('Destino de audio no permitido.');
  if(Number(meta.file_size)>maxBytes) throw new Error(`El audio supera el límite de ${maxBytes/1024/1024} MB del proveedor de IA.`);
  const response=await fetch(url,{headers:{Authorization:`Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`},redirect:'error',signal:AbortSignal.timeout(60000)});
  if(!response.ok) throw new Error(`Meta no permitió descargar el audio (HTTP ${response.status}). Revisa el token y vuelve a intentarlo.`);
  const chunks=[];let size=0;
  for await(const chunk of response.body) {
    size+=chunk.length;if(size>maxBytes){await response.body.cancel?.().catch(()=>{});throw new Error('El audio supera el tamaño permitido.');}
    chunks.push(chunk);
  }
  const buffer=Buffer.concat(chunks);
  if(meta.sha256) {
    const hex=createHash('sha256').update(buffer).digest('hex'),base64=createHash('sha256').update(buffer).digest('base64');
    if(meta.sha256!==hex&&meta.sha256!==base64) throw new Error('La verificación de integridad del audio falló. Vuelve a enviar el audio.');
  }
  return {buffer,mime:(meta.mime_type || 'audio/ogg').split(';')[0].trim()};
}
