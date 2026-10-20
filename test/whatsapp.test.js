import {test,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {parseEnv} from 'node:util';
import {createHash} from 'node:crypto';
import {configureWhatsApp} from '../scripts/configure-whatsapp.js';
import {checkWhatsApp,downloadWhatsAppAudio,subscribeWhatsAppAccount} from '../whatsapp.js';
let previous;
const settings={from:'+56 9 1234 5678',phoneId:'123456',appSecret:'a'.repeat(32),accessToken:'dummy-test-access-token-123456'};
beforeEach(()=>{previous={};for(const key of ['WHATSAPP_APP_SECRET','WHATSAPP_VERIFY_TOKEN','WHATSAPP_ACCESS_TOKEN','WHATSAPP_ALLOWED_FROM','WHATSAPP_PHONE_NUMBER_ID','WHATSAPP_GRAPH_VERSION','WHATSAPP_WEBHOOK_PORT']){previous[key]=process.env[key];delete process.env[key];}Object.assign(process.env,parseEnv(configureWhatsApp('',settings)));});
afterEach(()=>{for(const [key,value] of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}});

test('WhatsApp setup preserves AI configuration and verification token across updates',()=>{
  const original='GEMINI_API_KEY=keep-local\nAI_PROVIDER=gemini\nPORT=3000\n';
  const first=configureWhatsApp(original,settings),env=parseEnv(first);
  assert.equal(env.WHATSAPP_ALLOWED_FROM,'56912345678');assert.equal(env.GEMINI_API_KEY,'keep-local');assert.equal(env.WHATSAPP_WEBHOOK_PORT,'3001');assert.ok(env.WHATSAPP_VERIFY_TOKEN.length>=16);
  assert.equal(parseEnv(configureWhatsApp(first,{...settings,accessToken:'new-dummy-access-token-123456'})).WHATSAPP_VERIFY_TOKEN,env.WHATSAPP_VERIFY_TOKEN);
  assert.equal(configureWhatsApp(first,settings),first);
  assert.throws(()=>configureWhatsApp(original,{...settings,appSecret:'bad'}));
  assert.throws(()=>configureWhatsApp(original,{...settings,phoneId:'123\nPORT=1'}));
  assert.throws(()=>configureWhatsApp('PORT=3001',settings));
});
test('WhatsApp access check reads phone metadata and never sends a message',async t=>{
  t.mock.method(globalThis,'fetch',async(url,options)=>{assert.match(url,/^https:\/\/graph.facebook.com\/v23.0\/123456\?fields=/);assert.equal(options.method,undefined);assert.equal(options.body,undefined);return Response.json({id:'123456',display_phone_number:'+1 555 0100'});});
  assert.match((await checkWhatsApp()).message,/Falta verificar el webhook/);
});
test('WhatsApp media is authenticated and integrity checked before transcription',async t=>{
  const audio=Buffer.from('sample-audio');let calls=0;
  t.mock.method(globalThis,'fetch',async(url,options)=>{calls++;assert.equal(options.headers.Authorization,'Bearer '+settings.accessToken);if(String(url).includes('graph.facebook.com'))return Response.json({url:'https://lookaside.fbsbx.com/audio',mime_type:'audio/ogg; codecs=opus',sha256:createHash('sha256').update(audio).digest('base64')});assert.equal(options.redirect,'error');return new Response(audio);});
  const result=await downloadWhatsAppAudio('12345',1000);assert.deepEqual(result.buffer,audio);assert.equal(result.mime,'audio/ogg');assert.equal(calls,2);
});
test('WhatsApp rejects unsafe media destinations, broken integrity and expired tokens',async t=>{
  t.mock.method(globalThis,'fetch',async()=>Response.json({url:'https://untrusted.example/audio'}));await assert.rejects(()=>downloadWhatsAppAudio('123',1000),/Destino de audio no permitido/);
  t.mock.method(globalThis,'fetch',async url=>String(url).includes('graph.facebook.com')?Response.json({url:'https://lookaside.fbsbx.com/audio',sha256:'incorrect'}):new Response('sample'));
  await assert.rejects(()=>downloadWhatsAppAudio('123',1000),/integridad/);
  t.mock.method(globalThis,'fetch',async()=>new Response('private response',{status:401}));await assert.rejects(()=>checkWhatsApp(),/token expiró/);
});

test('Meta HTTP 400 explains token, object and permission failures without exposing private details',async t=>{
  const cases=[
    [{code:190,error_subcode:463},/caducó/],
    [{code:190},/rechazó el access token/],
    [{code:100},/Phone Number ID/],
    [{code:200},/permisos insuficientes/],
    [{code:10},/permisos insuficientes/],
    [{code:999},/HTTP 400/],
  ];
  for(const [error,expected] of cases){
    t.mock.method(globalThis,'fetch',async()=>Response.json({error:{...error,message:'private-token-and-user-information'}},{status:400}));
    await assert.rejects(()=>checkWhatsApp(),e=>{assert.match(e.message,expected);assert.doesNotMatch(e.message,/private-token/);return true;});
  }
});


test('account subscription verifies phone membership before an additive subscription without sending messages',async t=>{
  const calls=[];
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    calls.push({url,method:options.method||'GET'});
    assert.doesNotMatch(url,/\/messages/);
    if(url.includes('/phone_numbers'))return Response.json({data:[{id:'123456'}]});
    assert.match(url,/\/7890\/subscribed_apps$/);assert.equal(options.method,'POST');assert.equal(options.body,undefined);return Response.json({success:true});
  });
  assert.match((await subscribeWhatsAppAccount('7890')).message,/confirmó la suscripción/);
  assert.equal(calls.length,2);assert.equal(calls[0].method,'GET');assert.equal(calls[1].method,'POST');
});
test('account subscription refuses a mismatched account or an unconfirmed result',async t=>{
  let writes=0;
  t.mock.method(globalThis,'fetch',async(url,options)=>{if(options.method==='POST')writes++;return Response.json({data:[{id:'different-phone'}]});});
  await assert.rejects(()=>subscribeWhatsAppAccount('7890'),/no se modificó/);assert.equal(writes,0);
  await assert.rejects(()=>subscribeWhatsAppAccount('invalid'),/identificador numérico/);
  t.mock.method(globalThis,'fetch',async url=>url.includes('/phone_numbers')?Response.json({data:[{id:'123456'}]}):Response.json({success:false}));
  await assert.rejects(()=>subscribeWhatsAppAccount('7890'),/no confirmó/);
});
test('subscription follows account phone pagination before making changes',async t=>{
  const urls=[];
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    urls.push(url);
    if(options.method==='POST')return Response.json({success:true});
    if(url.includes('after='))return Response.json({data:[{id:'123456'}]});
    return Response.json({data:[{id:'other-phone'}],paging:{next:'unused-provider-url',cursors:{after:'next-page'}}});
  });
  await subscribeWhatsAppAccount('7890');assert.equal(urls.length,3);assert.match(urls[1],/after=next-page/);
});
