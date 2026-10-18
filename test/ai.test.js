import {test} from 'node:test';
import assert from 'node:assert/strict';
import {classify,transcribe} from '../ai.js';

test('classification sends project and time context, validates structured multi-item output',async t=>{
  const old=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY='test-key';
  t.after(()=>{if(old===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=old;});
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    assert.equal(url,'https://api.openai.com/v1/chat/completions');
    const payload=JSON.parse(options.body);
    assert.equal(payload.response_format.json_schema.strict,true);
    assert.match(payload.messages[0].content,/Norte/);
    assert.match(payload.messages[0].content,/2026-10-18T12:00:00/);
    assert.equal(payload.messages[1].content,'Mandar propuesta y ofrecer soporte.');
    return Response.json({choices:[{message:{content:JSON.stringify({items:[{title:'Mandar propuesta',category:'tarea',project:'Norte',dueDate:'2026-10-23'},{title:'Ofrecer soporte',category:'idea',project:'Norte',dueDate:null}]})}}]});
  });
  const items=await classify('Mandar propuesta y ofrecer soporte.',['Norte'],new Date('2026-10-18T12:00:00Z'));
  assert.equal(items.length,2);assert.equal(items[0].dueDate,'2026-10-23');assert.equal(items[1].category,'idea');assert.equal(items[0].done,false);
});
test('audio is uploaded as multipart and upstream failures are surfaced without provider secrets',async t=>{
  const old=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY='test-key';
  t.after(()=>{if(old===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=old;});
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    assert.equal(url,'https://api.openai.com/v1/audio/transcriptions');
    assert.equal(options.body.get('file').name,'audio.ogg');
    assert.equal(await options.body.get('file').text(),'sample-audio');
    return Response.json({text:'Revisar el presupuesto.'});
  });
  assert.equal(await transcribe(Buffer.from('sample-audio'),'audio/ogg'),'Revisar el presupuesto.');
  t.mock.method(globalThis,'fetch',async()=>new Response('sensitive-provider-response',{status:401}));
  await assert.rejects(()=>transcribe(Buffer.from('audio'),'audio/ogg'),{message:'OpenAI rechazó la clave. Ejecuta npm run configurar con una clave válida y reinicia Hilo.'});
});

test('quota and network errors are actionable and do not leak provider responses',async t=>{
  const old=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY='test-key';
  t.after(()=>{if(old===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=old;});
  t.mock.method(globalThis,'fetch',async()=>Response.json({error:{code:'insufficient_quota',message:'private'}},{status:429}));
  await assert.rejects(()=>classify('test',[]),/no tiene cuota disponible/);
  t.mock.method(globalThis,'fetch',async()=>{throw new Error('private network details');});
  await assert.rejects(()=>classify('test',[]),/Revisa tu conexión/);
});

test('classifier rejects incomplete responses and keeps projects inside the personal project list',async t=>{
  const old=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY='test-key';
  t.after(()=>{if(old===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=old;});
  t.mock.method(globalThis,'fetch',async()=>Response.json({choices:[{message:{content:JSON.stringify({items:[{title:'Idea',category:'idea',project:'Inventado',dueDate:null}]})}}]}));
  assert.equal((await classify('test',['Norte']))[0].project,null);
  t.mock.method(globalThis,'fetch',async()=>Response.json({choices:[{message:{refusal:'refused',content:null}}]}));
  await assert.rejects(()=>classify('test',[]),/organizarla manualmente/);
  t.mock.method(globalThis,'fetch',async()=>Response.json({choices:[{message:{content:'invalid-json'}}]}));
  await assert.rejects(()=>classify('test',[]),/clasificación incompleta/);
});

test('429 distinguishes quota types, confirmed rate limits and missing provider diagnostics',async t=>{
  const old=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY='test-key';
  t.after(()=>{if(old===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=old;});
  const cases=[
    [{code:null,type:'insufficient_quota',message:'private'},/no tiene cuota disponible/],
    [{code:'billing_hard_limit_reached'},/no tiene cuota disponible/],
    [{code:'rate_limit_exceeded',message:'private'},/límite temporal/],
    [{type:'tokens'},/límite temporal/],
    [{code:null,type:'unrecognized',message:'private'},/sin un diagnóstico reconocido/],
    [null,/sin un diagnóstico reconocido/],
  ];
  for(const [error,expected] of cases){
    t.mock.method(globalThis,'fetch',async()=>Response.json({error},{status:429}));
    await assert.rejects(()=>classify('test',[]),e=>{assert.match(e.message,expected);assert.doesNotMatch(e.message,/private/);return true;});
  }
  t.mock.method(globalThis,'fetch',async()=>new Response('private proxy response',{status:429}));
  await assert.rejects(()=>classify('test',[]),/sin un diagnóstico reconocido/);
});
