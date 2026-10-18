import {test,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {aiInfo,classify,transcribe} from '../ai.js';
let previous;
beforeEach(()=>{
  previous={AI_PROVIDER:process.env.AI_PROVIDER,GEMINI_API_KEY:process.env.GEMINI_API_KEY,GEMINI_MODEL:process.env.GEMINI_MODEL};
  process.env.AI_PROVIDER='gemini';process.env.GEMINI_API_KEY='dummy-gemini-key';process.env.GEMINI_MODEL='gemini-2.5-flash';
});
afterEach(()=>{for(const [key,value] of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
const response=value=>Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(value)}]}}]});

test('Gemini transcribes audio and classifies only through Google with structured responses',async t=>{
  let calls=0;
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    calls++;assert.match(url,/^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\/gemini-2.5-flash:generateContent$/);
    assert.equal(url.includes('dummy-gemini-key'),false);assert.equal(options.headers['x-goog-api-key'],'dummy-gemini-key');
    const payload=JSON.parse(options.body),part=payload.contents[0].parts[0];
    assert.equal(payload.generationConfig.responseMimeType,'application/json');
    if(part.inlineData){assert.equal(Buffer.from(part.inlineData.data,'base64').toString(),'audio-sample');assert.equal(part.inlineData.mimeType,'audio/ogg');return response({text:'Para Norte: enviar propuesta y ofrecer soporte.'});}
    assert.match(payload.systemInstruction.parts[0].text,/Norte/);
    assert.equal(payload.generationConfig.responseSchema.properties.items.items.properties.project.nullable,true);
    assert.equal(payload.generationConfig.responseSchema.properties.items.items.properties.project.type,'STRING');
    return response({items:[{title:'Enviar propuesta',category:'tarea',project:'Norte',dueDate:null},{title:'Ofrecer soporte',category:'idea',project:'Inventado',dueDate:null}]});
  });
  const text=await transcribe(Buffer.from('audio-sample'),'audio/ogg');const items=await classify(text,['Norte']);
  assert.equal(calls,2);assert.equal(items.length,2);assert.equal(items[0].project,'Norte');assert.equal(items[1].project,null);assert.equal(items[0].done,false);
});
test('Gemini quota exhaustion does not call a paid provider or leak response bodies',async t=>{
  let calls=0;t.mock.method(globalThis,'fetch',async url=>{calls++;assert.match(url,/googleapis/);return Response.json({error:{message:'private'}},{status:429});});
  await assert.rejects(()=>classify('test',[]),e=>{assert.match(e.message,/cuota/);assert.doesNotMatch(e.message,/private/);return true;});assert.equal(calls,1);
});
test('Gemini audio rejects oversized files before a network call and detects empty transcripts',async t=>{
  assert.equal(aiInfo().maxAudioBytes,14*1024*1024);
  t.mock.method(globalThis,'fetch',async()=>response({text:''}));
  await assert.rejects(()=>transcribe(Buffer.alloc(14*1024*1024+1),'audio/ogg'),/14 MB/);
  await assert.rejects(()=>transcribe(Buffer.from('silence'),'audio/ogg'),/No se detectó texto/);
});
test('Gemini validates keys, blocked content and configuration',async t=>{
  delete process.env.GEMINI_API_KEY;
  assert.equal(aiInfo().configured,false);await assert.rejects(()=>classify('test',[]),/Falta configurar Gemini/);
  process.env.GEMINI_API_KEY='dummy';
  t.mock.method(globalThis,'fetch',async()=>Response.json({error:{details:[{reason:'API_KEY_INVALID'}]}},{status:400}));
  await assert.rejects(()=>classify('test',[]),/rechazó la clave/);
  t.mock.method(globalThis,'fetch',async()=>Response.json({candidates:[{finishReason:'SAFETY'}]}));
  await assert.rejects(()=>classify('test',[]),/no pudo completar/);
  process.env.AI_PROVIDER='unknown';assert.throws(()=>aiInfo(),/AI_PROVIDER/);
});


test('Gemini discovers a current Flash model instead of assuming a retired model is available',async t=>{
  delete process.env.GEMINI_MODEL;
  const paths=[];
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    paths.push(url);
    if(options.method==='GET')return Response.json({models:[{name:'models/gemini-3.5-flash-lite',supportedGenerationMethods:['generateContent']},{name:'models/gemini-2.5-flash-lite',supportedGenerationMethods:['generateContent']},{name:'models/gemini-3.8-flash',supportedGenerationMethods:['generateContent']}]});
    assert.match(url,/gemini-3.5-flash-lite:generateContent$/);
    return response({items:[{title:'Idea',category:'idea',project:null,dueDate:null}]});
  });
  await classify('test',[]);assert.equal(paths.length,2);assert.match(paths[0],/models\?pageSize/);
});
