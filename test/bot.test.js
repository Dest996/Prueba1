import {test,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createBot,reminderKey} from '../bot.js';
import {parseWhen,localInstant,localParts} from '../reminder-time.js';
let db,bot,now,sent,users,grants,phones,auth,previous;
const initial=Date.parse('2026-10-28T12:00:00Z');
const note=id=>db.prepare('SELECT * FROM notes WHERE id=?').get(id);
const item=id=>JSON.parse(note(id).items)[0];
const outbox=()=>db.prepare('SELECT * FROM bot_outbox ORDER BY created,id').all();
const replies=()=>outbox().filter(row=>!row.reminder_id);
const alarms=()=>outbox().filter(row=>row.reminder_id);
const talk=(id,text,phone='56911111111')=>{bot.incoming(phone);return bot.handle({id,phone,text});};
beforeEach(()=>{
  previous={};for(const name of ['WHATSAPP_APP_SECRET','WHATSAPP_VERIFY_TOKEN','WHATSAPP_ACCESS_TOKEN','WHATSAPP_PHONE_NUMBER_ID','WHATSAPP_BOT_ENABLED','TIMEZONE','AI_PROVIDER','OPENAI_API_KEY','GEMINI_API_KEY','WHATSAPP_REMINDER_TEMPLATE']){previous[name]=process.env[name];delete process.env[name];}
  Object.assign(process.env,{WHATSAPP_APP_SECRET:'test',WHATSAPP_VERIFY_TOKEN:'test',WHATSAPP_ACCESS_TOKEN:'test',WHATSAPP_PHONE_NUMBER_ID:'123',TIMEZONE:'America/Santiago',AI_PROVIDER:'gemini'});
  now=initial;sent=[];users={a:{id:'a',role:'user',active:true},b:{id:'b',role:'user',active:true}};phones={a:'56911111111',b:'56922222222'};grants={a:['Norte'],b:['Sur']};
  db=new DatabaseSync(':memory:');db.exec("CREATE TABLE notes(id TEXT PRIMARY KEY,received TEXT,source TEXT,transcript TEXT,items TEXT,classified INTEGER);CREATE TABLE projects(name TEXT,position INTEGER);CREATE TABLE note_owners(note_id TEXT PRIMARY KEY,user_id TEXT);CREATE TABLE jobs(id TEXT,payload TEXT,status TEXT,error TEXT);INSERT INTO projects VALUES ('Norte',0),('Sur',1)");
  auth={currentUser:id=>{if(!users[id]?.active)throw Error('disabled');return users[id];},whatsappPhone:id=>phones[id]||'',whatsappUser:phone=>Object.values(users).find(u=>u.active&&phones[u.id]===phone)||null,projectAccess:(u,p)=>grants[u.id].includes(p),canItem:(u,n,i)=>grants[u.id].includes(i.project)||(!i.project&&db.prepare('SELECT 1 FROM note_owners WHERE note_id=? AND user_id=?').get(n.id,u.id))};
  auth.fullNote=(u,n)=>JSON.parse(n.items).every(i=>auth.canItem(u,n,i));
  bot=createBot(db,auth,{clock:()=>now,send:async options=>{sent.push(options);return {id:'wamid.'+sent.length};}});
});
afterEach(()=>{db.close();for(const [name,value] of Object.entries(previous))if(value===undefined)delete process.env[name];else process.env[name]=value;});
test('Spanish relative dates and explicit times use Chile local dates, not the UTC date',()=>{
  assert.deepEqual(parseWhen('mañana a las 09:30',initial),{date:'2026-10-29',time:'09:30',ambiguous:false,invalidDate:false});
  assert.equal(parseWhen('hoy a las 9 de la mañana',initial).date,'2026-10-28');
  assert.equal(parseWhen('a las 3 de la tarde',initial).time,'15:00');assert.equal(parseWhen('mañana a las nueve y media',initial).time,'09:30');assert.equal(parseWhen('a las tres y media de la tarde',initial).time,'15:30');assert.equal(parseWhen('a las 3',initial).ambiguous,true);
  assert.equal(parseWhen('31/02/2026 a las 09:00',initial).invalidDate,true);
  assert.equal(parseWhen('hoy a las 23:00',Date.parse('2026-10-29T01:00:00Z')).date,'2026-10-28');
  assert.equal(localInstant('2026-10-29','09:00'),Date.parse('2026-10-29T12:00:00Z'));
});
test('DST gaps and repeated hours cannot silently choose the wrong instant',()=>{
  assert.throws(()=>localInstant('2026-09-06','00:30','America/Santiago'),/no existe/);
  assert.throws(()=>localInstant('2026-04-04','23:30','America/Santiago'),/se repite/);
});
test('complete common reminders save in one message without an AI call or confirmation question',async()=>{
  const started=performance.now();await talk('one','Recuérdame mañana a las 09:00 llamar al cliente');
  assert.equal(item('one').title,'llamar al cliente');assert.equal(alarms().length,1);assert.equal(alarms()[0].due_at,Date.parse('2026-10-29T12:00:00Z'));
  assert.match(replies()[0].text,/Listo/);assert.doesNotMatch(replies()[0].text,/\?/);assert.ok(performance.now()-started<20000);
});
test('one combined question asks for missing date and time; its answer updates the same saved note',async()=>{
  await talk('need','Recuérdame llamar al cliente');assert.equal(alarms().length,0);assert.match(replies()[0].text,/fecha y la hora/);assert.equal((replies()[0].text.match(/\?/g)||[]).length,1);
  await talk('answer','mañana a las 09:00');assert.equal(db.prepare('SELECT COUNT(*) AS n FROM notes').get().n,1);assert.equal(item('need').dueTime,'09:00');assert.equal(item('need').dueDate,'2026-10-29');assert.equal(alarms().length,1);assert.match(note('need').transcript,/Respuesta/);
  await talk('answer','mañana a las 09:00');assert.equal(replies().length,2);
});
test('date-only reminders ask only for the hour; hour-only reminders ask only for the date',async()=>{
  await talk('date','Recuérdame mañana llamar');assert.match(replies()[0].text,/¿A qué hora/);assert.equal(item('date').dueTime,null);
  await talk('hour','nuevo recordatorio: a las 15:00 enviar informe','56922222222');assert.match(replies().find(r=>r.recipient==='56922222222').text,/¿Qué día/);
});
test('ordinary notes need no follow-up; an absent project is personal, never guessed from another user',async()=>{
  grants.a=[];await talk('plain','Una idea para mi trabajo');assert.equal(item('plain').project,null);assert.equal(replies()[0].text,'Guardado.');assert.ok(auth.fullNote(users.a,note('plain')));assert.ok(!auth.fullNote(users.b,note('plain')));
});
test('two users have isolated conversations and cannot complete each other’s reminders',async()=>{
  await talk('aa','Recuérdame llamar');await talk('bb','Recuérdame comprar','56922222222');await talk('ba','mañana a las 10:00','56922222222');assert.equal(item('aa').dueDate,null);assert.equal(item('bb').dueDate,'2026-10-29');
  await talk('bad-code','HECHO '+alarms()[0].reminder_id.slice(0,8));assert.equal(item('bb').done,false);assert.match(replies().find(r=>r.id==='reply:bad-code').text,/No encuentro/);
});
test('cancelling an incomplete reminder preserves its note without an alert',async()=>{
  await talk('c','Recuérdame llamar');await talk('cc','cancelar');assert.equal(item('c').notify,false);assert.equal(alarms().length,0);assert.ok(note('c'));
});
test('past dates, impossible dates and ambiguous times are never silently scheduled',async()=>{
  await talk('past','Recuérdame hoy a las 08:00 llamar');assert.equal(alarms().length,0);assert.match(replies()[0].text,/ya pasaron/);
  await talk('past2','31/02/2026 a las 09:00');assert.equal(alarms().length,0);assert.match(replies().find(r=>r.id==='reply:past2').text,/no es válida/);
  await talk('past3','mañana a las 3');assert.equal(alarms().length,0);assert.match(replies().find(r=>r.id==='reply:past3').text,/24 horas/);
});
test('due alerts are sent to the owner with buttons and never resent after Meta acceptance',async()=>{
  await talk('soon','Recuérdame en 10 minutos llamar');await bot.deliver();assert.equal(sent.length,1);now+=10*60000;await bot.deliver();assert.equal(sent.length,2);assert.equal(sent[1].to,phones.a);assert.equal(sent[1].buttons.length,3);assert.match(sent[1].text,/llamar/);
  await bot.deliver();assert.equal(sent.length,2);assert.equal(alarms()[0].status,'accepted');
  bot.receipt({id:'wamid.2',status:'delivered'});bot.receipt({id:'wamid.2',status:'sent'});assert.equal(alarms()[0].status,'delivered');
});
test('scheduled alerts require an approved template after the 24-hour window',async()=>{
  await talk('later','Recuérdame pasado mañana a las 09:00 llamar');await bot.deliver();now=localInstant('2026-10-30','09:00');await bot.deliver();assert.equal(alarms()[0].status,'blocked');assert.equal(sent.length,1);
  bot.settings({templateName:'al_dia_recordatorio',templateLanguage:'es_CL'});bot.refreshBlocked();await bot.deliver();assert.equal(sent.length,2);assert.equal(sent[1].template.name,'al_dia_recordatorio');assert.equal(sent[1].template.parameters.length,3);assert.equal(alarms()[0].status,'accepted');
});
test('deleting or completing notes, disabling users, revoking projects or changing numbers prevents delivery',async()=>{
  for(const [id,mutate] of [['deleted',()=>{db.prepare('DELETE FROM notes WHERE id=?').run('deleted');bot.removeNote('deleted');assert.ok(outbox().filter(r=>r.note_id==='deleted').every(r=>r.text===''));}],['done',()=>{const n=note('done'),items=JSON.parse(n.items);items[0].done=true;db.prepare('UPDATE notes SET items=? WHERE id=?').run(JSON.stringify(items),n.id);}],['disabled',()=>{users.a.active=false;}],['revoked',()=>{grants.a=[];}],['phone',()=>{phones.a='56933333333';}]]){
    users.a.active=true;phones.a='56911111111';grants.a=['Norte'];now=initial;await talk(id,'Recuérdame en 1 minuto llamar');await bot.deliver();mutate();now+=60000;await bot.deliver();assert.equal(alarms().find(r=>r.note_id===id).status,'cancelled',id);
  }
});
test('snooze and done button replies update only the referenced reminder',async()=>{
  await talk('btn','Recuérdame en 1 minuto llamar');const alarm=alarms()[0];now+=60000;await bot.handle({id:'snooze',phone:phones.a,text:'En 10 minutos',buttonId:'snooze:'+alarm.reminder_id});
  assert.equal(item('btn').dueTime,localParts(now+10*60000).time);assert.equal(alarms().filter(r=>r.status==='pending').length,1);
  const active=alarms().find(r=>r.status==='pending');await bot.handle({id:'done',phone:phones.a,text:'Hecho',buttonId:'done:'+active.reminder_id});assert.equal(item('btn').done,true);assert.equal(alarms().filter(r=>r.status==='pending').length,0);
});
test('restart keeps scheduled data and marks interrupted sends uncertain instead of duplicating',async()=>{
  await talk('restart','Recuérdame en 1 minuto llamar');const id=alarms()[0].id;db.prepare("UPDATE bot_outbox SET status='sending' WHERE id=?").run(id);
  bot=createBot(db,auth,{clock:()=>now,send:async()=>{throw Error('must not send');}});now+=60000;await bot.deliver();assert.equal(alarms()[0].status,'uncertain');
});
test('duplicate deliveries do not create extra notes, questions or alerts',async()=>{
  await talk('dup','Recuérdame mañana a las 09:00 llamar');await talk('dup','Recuérdame mañana a las 09:00 llamar');assert.equal(replies().length,1);assert.equal(alarms().length,1);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM notes').get().n,1);
});
test('changing the global timezone does not silently move an already scheduled reminder',async()=>{
  await talk('zone','Recuérdame mañana a las 09:00 llamar');const original=alarms()[0].due_at;bot.settings({timezone:'Europe/Madrid'});bot.syncNote('zone');assert.equal(alarms()[0].due_at,original);assert.equal(db.prepare('SELECT zone FROM reminders').get().zone,'America/Santiago');
});
test('uncertain sends wait for an explicit retry; definitive temporary rejection uses bounded backoff',async()=>{
  await talk('net','Nota corta');bot=createBot(db,auth,{clock:()=>now,send:async()=>{throw Object.assign(Error('Sin confirmación'),{uncertain:true});}});await bot.deliver();assert.equal(replies()[0].status,'uncertain');await bot.deliver();assert.equal(replies()[0].attempts,1);
  bot.retry('reply:net');bot=createBot(db,auth,{clock:()=>now,send:async()=>({id:'wamid.retry'})});await bot.deliver();assert.equal(replies()[0].status,'accepted');assert.equal(replies()[0].attempts,2);
  await talk('retry','Otra nota');let attempts=0;bot=createBot(db,auth,{clock:()=>now,send:async()=>{attempts++;throw Object.assign(Error('Ocupado'),{retryable:true});}});
  await bot.deliver();assert.equal(attempts,1);await bot.deliver();assert.equal(attempts,1);
  for(const delay of [60000,120000,240000,480000]){now+=delay;await bot.deliver();}
  assert.equal(attempts,5);assert.equal(replies().find(r=>r.id==='reply:retry').status,'failed');
});

test('delivery receipts arriving before the send response are retained',async()=>{
  await talk('receipt','Nota');bot=createBot(db,auth,{clock:()=>now,send:async()=>{bot.receipt({id:'wamid.early',status:'delivered'});return {id:'wamid.early'};}});await bot.deliver();assert.equal(replies()[0].status,'delivered');
});
test('a Meta window rejection switches that reminder to template mode rather than retrying free text',async()=>{
  await talk('window','Recuérdame en 1 minuto llamar');await bot.deliver();now+=60000;
  bot=createBot(db,auth,{clock:()=>now,send:async()=>{throw Object.assign(Error('Plantilla requerida'),{blocked:true,requiresTemplate:true});}});await bot.deliver();assert.equal(alarms()[0].status,'blocked');
  bot.settings({templateName:'al_dia_recordatorio'});bot.refreshBlocked();let options;
  bot=createBot(db,auth,{clock:()=>now,send:async input=>{options=input;return {id:'wamid.template'};}});await bot.deliver();assert.equal(options.template.name,'al_dia_recordatorio');
});
