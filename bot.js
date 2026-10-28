import {createHash} from 'node:crypto';
import {classify,aiInfo} from './ai.js';
import {fallbackItems,validateItems} from './domain.js';
import {sendWhatsAppMessage,whatsappInfo} from './whatsapp.js';
import {parseWhen,localParts,localInstant,validZone,validTime,normalize,isReminder,reminderTitle,formatWhen} from './reminder-time.js';
const minute=60000,day=86400000;
const digest=value=>createHash('sha256').update(value).digest('hex');
export const reminderKey=(noteId,item)=>digest(JSON.stringify([noteId,item.title,item.dueDate,item.dueTime]));
export function createBot(db,auth,{clock=()=>Date.now(),send=sendWhatsAppMessage,infer=classify}={}){
  db.exec(`CREATE TABLE IF NOT EXISTS bot_settings (id INTEGER PRIMARY KEY CHECK(id=1),value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS bot_contacts (phone TEXT PRIMARY KEY,last_inbound INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS bot_conversations (phone TEXT PRIMARY KEY,user_id TEXT NOT NULL,note_id TEXT NOT NULL,expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS bot_processed (message_id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS note_bot_targets (note_id TEXT PRIMARY KEY,user_id TEXT NOT NULL,zone TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS reminders (id TEXT PRIMARY KEY,note_id TEXT NOT NULL,user_id TEXT NOT NULL,item_index INTEGER NOT NULL,recipient TEXT NOT NULL,due_at INTEGER NOT NULL,zone TEXT NOT NULL,title TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS bot_outbox (id TEXT PRIMARY KEY,recipient TEXT NOT NULL,user_id TEXT NOT NULL,note_id TEXT,reminder_id TEXT,text TEXT NOT NULL,due_at INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'pending',force_template INTEGER NOT NULL DEFAULT 0,attempts INTEGER NOT NULL DEFAULT 0,next_attempt INTEGER NOT NULL DEFAULT 0,meta_id TEXT UNIQUE,error TEXT,created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS bot_receipts (id TEXT PRIMARY KEY,status TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS bot_due ON bot_outbox(status,due_at,next_attempt);`);
  // A crash during a network send cannot prove whether Meta accepted it.
  db.prepare("UPDATE bot_outbox SET status='uncertain',error='El servidor se reinició durante el envío. Revisa antes de reintentar.' WHERE status='sending'").run();
  const transaction=fn=>{db.exec('BEGIN');try{const result=fn();db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}};
  const preferences=()=>({enabled:process.env.WHATSAPP_BOT_ENABLED!=='0',timezone:process.env.TIMEZONE||'America/Santiago',templateName:process.env.WHATSAPP_REMINDER_TEMPLATE||'',templateLanguage:process.env.WHATSAPP_TEMPLATE_LANGUAGE||'es_CL',...JSON.parse(db.prepare('SELECT value FROM bot_settings WHERE id=1').get()?.value||'{}')});
  function settings(data){
    const current=preferences(),next={...current};
    for(const name of ['enabled','timezone','templateName','templateLanguage'])if(data[name]!==undefined)next[name]=data[name];
    if(typeof next.enabled!=='boolean'||!validZone(next.timezone)||typeof next.templateName!=='string'||(next.templateName&&!/^[a-z0-9_]{1,512}$/.test(next.templateName))||! /^[a-z]{2}(?:_[A-Z]{2})?$/.test(next.templateLanguage))throw new Error('Revisa la configuración del bot, zona horaria y plantilla.');
    db.prepare('INSERT INTO bot_settings VALUES (1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(JSON.stringify(next));return next;
  }
  const enabled=()=>preferences().enabled&&whatsappInfo().configured;
  const noteById=id=>db.prepare('SELECT * FROM notes WHERE id=?').get(id);
  const userById=id=>{try{return auth.currentUser(id);}catch{return null;}};
  const incoming=(phone,when=clock())=>{db.prepare('INSERT INTO bot_contacts VALUES (?,?) ON CONFLICT(phone) DO UPDATE SET last_inbound=MAX(last_inbound,excluded.last_inbound)').run(phone,Math.min(when,clock()));if(clock()-when<day)db.prepare("UPDATE bot_outbox SET status='pending',next_attempt=0 WHERE recipient=? AND status='blocked' AND reminder_id IS NOT NULL AND due_at>?").run(phone,clock()-day);};
  function enqueue({id,user,phone,noteId=null,reminderId=null,text,dueAt=clock()}){
    db.prepare('INSERT OR IGNORE INTO bot_outbox (id,recipient,user_id,note_id,reminder_id,text,due_at,created) VALUES (?,?,?,?,?,?,?,?)').run(id,phone,user.id,noteId,reminderId,text.slice(0,4000),dueAt,clock());
  }
  function syncNote(noteId,userId){
    if(userId)db.prepare('INSERT INTO note_bot_targets VALUES (?,?,?) ON CONFLICT(note_id) DO NOTHING').run(noteId,userId,preferences().timezone);
    const target=db.prepare('SELECT user_id,zone FROM note_bot_targets WHERE note_id=?').get(noteId),note=noteById(noteId);
    const active=new Set(),user=target&&userById(target.user_id),phone=user&&auth.whatsappPhone(user.id),zone=target?.zone||preferences().timezone;
    if(note&&user&&phone){
      JSON.parse(note.items).forEach((item,index)=>{
        if(item.category!=='recordatorio'||item.done||item.notify===false||!item.dueDate||!validTime(item.dueTime)||!auth.canItem(user,note,item))return;
        let due;try{due=localInstant(item.dueDate,item.dueTime,zone);}catch{return;}
        const key=reminderKey(noteId,item);active.add(key);
        db.prepare('INSERT INTO reminders VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET item_index=excluded.item_index,recipient=excluded.recipient,zone=excluded.zone').run(key,noteId,user.id,index,phone,due,zone,item.title);
        const id='reminder:'+key,old=db.prepare('SELECT * FROM bot_outbox WHERE id=?').get(id);
        if(!old)enqueue({id,user,phone,noteId,reminderId:key,text:item.title,dueAt:due});
        else if(['pending','blocked','cancelled'].includes(old.status)&&due>clock())db.prepare("UPDATE bot_outbox SET recipient=?,status='pending',error=NULL,next_attempt=0 WHERE id=?").run(phone,id);
        if(!old&&due<clock())db.prepare("UPDATE bot_outbox SET status='expired',error='La fecha ya pasó. Programa una nueva fecha y hora.' WHERE id=?").run(id);
      });
    }
    for(const row of db.prepare('SELECT id,reminder_id,status FROM bot_outbox WHERE note_id=? AND reminder_id IS NOT NULL').all(noteId)){
      if(!active.has(row.reminder_id)&&['pending','blocked','failed'].includes(row.status))db.prepare("UPDATE bot_outbox SET status='cancelled',error=NULL WHERE id=?").run(row.id);
    }
  }
  function removeNote(noteId){
    syncNote(noteId);
    db.prepare("UPDATE jobs SET payload='{}',status='done',error=NULL WHERE id IN (SELECT substr(id,7) FROM bot_outbox WHERE note_id=? AND id LIKE 'reply:%')").run(noteId);
    db.prepare("UPDATE bot_outbox SET text='' WHERE note_id=?").run(noteId);
    db.prepare('DELETE FROM reminders WHERE note_id=?').run(noteId);
    db.prepare('DELETE FROM bot_conversations WHERE note_id=?').run(noteId);
    db.prepare('DELETE FROM note_bot_targets WHERE note_id=?').run(noteId);
  }
  function reminderState(note,item){
    if(item.category!=='recordatorio')return null;
    if(item.notify===false)return {status:'cancelled'};
    if(!item.dueDate||!item.dueTime)return {status:'needs_time'};
    const out=db.prepare('SELECT status,error,due_at FROM bot_outbox WHERE reminder_id=?').get(reminderKey(note.id,item));
    return out?{status:out.status,error:out.error,dueAt:out.due_at}:{status:'not_enabled'};
  }
  function pendingItems(note){return JSON.parse(note.items).map((item,index)=>({item,index})).filter(({item})=>item.category==='recordatorio'&&!item.done&&item.notify!==false&&(!item.dueDate||!item.dueTime||item.title==='Recordatorio'));}
  function question(note){
    const pending=pendingItems(note),{item}=pending[0];
    const what=item.title==='Recordatorio',date=!item.dueDate,time=!item.dueTime;
    const missing=[what?'qué debo recordarte':null,date?'la fecha':null,time?'la hora':null].filter(Boolean).join(' y ');
    return `${pending.length>1?`Hay ${pending.length} recordatorios incompletos. `:''}${what?'':`Para «${item.title}», `}falta ${missing}. ${what?'¿Qué te recuerdo'+(date||time?' y cuándo':'')+'?':date&&time?'¿Qué día y a qué hora te aviso?':date?'¿Qué día te aviso?':'¿A qué hora te aviso?'} Ejemplo: mañana a las 09:00.`;
  }
  function reply(id,user,phone,text,noteId=null){enqueue({id:'reply:'+id,user,phone,text,noteId});}
  function finish(id,user,phone,note){
    syncNote(note.id,user.id);
    if(pendingItems(note).length){db.prepare('INSERT INTO bot_conversations VALUES (?,?,?,?) ON CONFLICT(phone) DO UPDATE SET user_id=excluded.user_id,note_id=excluded.note_id,expires=excluded.expires').run(phone,user.id,note.id,clock()+30*minute);reply(id,user,phone,'Guardado. '+question(note),note.id);return;}
    db.prepare('DELETE FROM bot_conversations WHERE phone=?').run(phone);
    const reminders=JSON.parse(note.items).filter(item=>item.category==='recordatorio'&&!item.done&&item.notify!==false);
    if(reminders.length){
      const zone=db.prepare('SELECT zone FROM note_bot_targets WHERE note_id=?').get(note.id)?.zone||preferences().timezone,lines=reminders.map(item=>`«${item.title}»: ${item.dueDate} ${item.dueTime}`).join('; ');
      reply(id,user,phone,`Listo. Te avisaré: ${lines} (${zone}).`,note.id);
    }else reply(id,user,phone,'Guardado.',note.id);
  }
  async function handle({id,phone,text,received=new Date(clock()).toISOString(),buttonId}){
    if(typeof text!=='string'||!text.trim()||text.length>30000)throw new Error('Envía un texto o audio con entre 1 y 30000 caracteres.');
    if(db.prepare('SELECT 1 FROM bot_processed WHERE message_id=?').get(id))return;
    const user=auth.whatsappUser(phone);if(!user)return;
    const existingContext=db.prepare('SELECT c.note_id,t.zone FROM bot_conversations c JOIN note_bot_targets t ON t.note_id=c.note_id WHERE c.phone=? AND c.user_id=? AND c.expires>?').get(phone,user.id,clock());
    const zone=existingContext?.zone||preferences().timezone,now=clock(),command=normalize(text),when=parseWhen(text,Math.min(Date.parse(received)||now,now),zone);
    const button=buttonId?.match(/^(done|snooze|cancel):([a-f0-9]{64})$/);
    const typed=command.match(/^(hecho|listo|posponer|cancelar)\s+([a-f0-9]{8})(?:\s+(\d{1,3}))?$/i);
    const record=button?db.prepare('SELECT * FROM reminders WHERE id=? AND user_id=?').get(button[2],user.id):typed?db.prepare('SELECT * FROM reminders WHERE substr(id,1,8)=? AND user_id=?').get(typed[2].toLowerCase(),user.id):null;
    if(button||typed){
      transaction(()=>{
        const fresh=auth.whatsappUser(phone);if(!fresh||fresh.id!==user.id)return;
        const note=record&&noteById(record.note_id),items=note&&JSON.parse(note.items),item=items?.[record.item_index];
        if(!item||reminderKey(note.id,item)!==record.id||!auth.canItem(user,note,item,true)){reply(id,user,phone,'No encuentro un recordatorio que puedas modificar con ese código.');}
        else{
          const action=button?.[1]||({hecho:'done',listo:'done',posponer:'snooze',cancelar:'cancel'})[typed[1]];
          if(action==='done')item.done=true;
          else if(action==='cancel')item.notify=false;
          else{const delay=typed?.[3]?Number(typed[3]):10;if(delay<1||delay>999){reply(id,user,phone,'Usa entre 1 y 999 minutos para posponer.');db.prepare('INSERT OR IGNORE INTO bot_processed VALUES (?)').run(id);return;}const p=localParts(Math.ceil((now+delay*minute)/minute)*minute,zone);item.dueDate=p.date;item.dueTime=p.time;item.done=false;item.notify=true;}
          db.prepare('UPDATE notes SET items=? WHERE id=?').run(JSON.stringify(items),note.id);syncNote(note.id);
          reply(id,user,phone,action==='done'?'Hecho. Marcado como completado.':action==='cancel'?'Aviso cancelado. La nota se conserva.':`Listo. Te avisaré el ${item.dueDate} a las ${item.dueTime}.`,note.id);
        }
        db.prepare('INSERT OR IGNORE INTO bot_processed VALUES (?)').run(id);
      });return;
    }
    const context=db.prepare('SELECT * FROM bot_conversations WHERE phone=? AND user_id=? AND expires>?').get(phone,user.id,now);
    const freshNote=context&&noteById(context.note_id);
    const note=freshNote&&auth.fullNote(user,freshNote,true)?freshNote:null;
    if(/^(ayuda|\/ayuda)$/.test(command)){
      transaction(()=>{reply(id,user,phone,'Escribe una nota o un audio. Para un aviso: «Recuérdame mañana a las 09:00 llamar al cliente». Si falta fecha u hora, te las pediré juntas. Usa «nueva nota: …» para guardar otra cosa, «cancelar» para dejar un aviso sin programar, o los botones del recordatorio.');db.prepare('INSERT OR IGNORE INTO bot_processed VALUES (?)').run(id);});return;
    }
    if(note&&!/^(nueva nota|nota|nuevo recordatorio|recordatorio|recuerdame|avisame)\s*[: ]/.test(command)){
      transaction(()=>{
        if(db.prepare('SELECT 1 FROM bot_processed WHERE message_id=?').get(id))return;
        const current=noteById(note.id),userNow=auth.whatsappUser(phone);if(!current||!userNow||userNow.id!==user.id||!auth.fullNote(userNow,current,true))return;
        const items=JSON.parse(current.items),pending=pendingItems(current);
        if(/^(cancelar|sin aviso|no|dejalo|dejar sin aviso)$/.test(command)){
          pending.forEach(({index})=>{items[index].notify=false;});db.prepare('UPDATE notes SET items=? WHERE id=?').run(JSON.stringify(items),note.id);db.prepare('DELETE FROM bot_conversations WHERE phone=?').run(phone);syncNote(note.id);reply(id,user,phone,'Guardado sin aviso. Puedes programarlo después desde AL DÍA.',note.id);
        }else{
          const targets=/\b(todos|ambos|los dos)\b/.test(command)?pending:pending.slice(0,1);
          let invalid=when.invalidDate?'La fecha no es válida. ':when.ambiguous?'Indica la hora en formato 24 horas, por ejemplo 15:00. ':'';
          for(const {index} of targets){
            const old=items[index],updated={...old};if(when.date)updated.dueDate=when.date;if(when.time)updated.dueTime=when.time;
            if(updated.title==='Recordatorio'){const title=reminderTitle(text);if(title)updated.title=title;}
            if(updated.dueDate&&updated.dueTime){try{if(localInstant(updated.dueDate,updated.dueTime,zone)<=now)invalid='Esa fecha y hora ya pasaron. ';}catch(error){invalid=error.message+' ';}}
            if(!invalid)items[index]=updated;
          }
          if(invalid)reply(id,user,phone,invalid+'¿Qué día y a qué hora te aviso?',note.id);
          else{
            db.prepare('UPDATE notes SET items=?,transcript=transcript||? WHERE id=?').run(JSON.stringify(items),'\n\nRespuesta para programar el aviso: '+text,note.id);finish(id,user,phone,noteById(note.id));
          }
        }
        db.prepare('INSERT OR IGNORE INTO bot_processed VALUES (?)').run(id);
      });return;
    }
    let items,classified=0;
    const source=text.replace(/^nuevo recordatorio\s*:\s*/i,'recordatorio: ').replace(/^(?:nueva nota|nota)\s*:\s*/i,'');
    const projects=db.prepare('SELECT name FROM projects ORDER BY position,name').all().map(p=>p.name).filter(name=>auth.projectAccess(user,name,true));
    if(isReminder(source)&&!/[;]|\btambien\b/.test(normalize(source))){items=[{title:reminderTitle(source)||'Recordatorio',category:'recordatorio',project:null,dueDate:when.date,dueTime:when.time,done:false}];classified=1;}
    else if(aiInfo().configured){
      let timeout;try{items=await Promise.race([infer(source,projects,new Date(received),{timeoutMs:4000}),new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error('Tiempo de clasificación agotado.')),4500);})]);classified=1;}catch{items=fallbackItems(source);}finally{clearTimeout(timeout);}
    }else items=fallbackItems(source);
    if(!items?.length)items=fallbackItems(source);
    items=validateItems(items).map(item=>({...item,project:projects.includes(item.project)?item.project:projects.length===1?projects[0]:null}));
    let invalid='';
    items=items.map(item=>{
      if(item.category!=='recordatorio')return item;
      if(item.dueDate&&item.dueTime){try{if(localInstant(item.dueDate,item.dueTime,zone)<=now){invalid='Esa fecha y hora ya pasaron. ';return {...item,dueDate:null,dueTime:null};}}catch(error){invalid=error.message+' ';return {...item,dueDate:null,dueTime:null};}}
      return item;
    });
    transaction(()=>{
      const fresh=auth.whatsappUser(phone);if(!fresh||fresh.id!==user.id||db.prepare('SELECT 1 FROM bot_processed WHERE message_id=?').get(id))return;
      items=items.map(item=>({...item,project:auth.projectAccess(fresh,item.project,true)?item.project:null}));
      db.prepare('INSERT OR IGNORE INTO notes VALUES (?,?,?,?,?,?)').run(id,received,'whatsapp',text,JSON.stringify(items),classified);
      db.prepare('INSERT OR IGNORE INTO note_owners VALUES (?,?)').run(id,user.id);
      finish(id,user,phone,noteById(id));
      if(invalid){const out=db.prepare('SELECT text FROM bot_outbox WHERE id=?').get('reply:'+id);db.prepare('UPDATE bot_outbox SET text=? WHERE id=?').run(invalid+out.text,'reply:'+id);}
      db.prepare('INSERT INTO bot_processed VALUES (?)').run(id);
    });
  }
  function allowedMessage(row){
    const user=auth.whatsappUser(row.recipient);if(!user||user.id!==row.user_id)return false;
    if(!row.note_id)return true;
    const note=noteById(row.note_id);if(!note)return false;
    if(!row.reminder_id)return auth.fullNote(user,note);
    const reminder=db.prepare('SELECT * FROM reminders WHERE id=?').get(row.reminder_id),item=reminder&&JSON.parse(note.items)[reminder.item_index];
    return Boolean(item&&item.category==='recordatorio'&&!item.done&&item.notify!==false&&reminderKey(note.id,item)===row.reminder_id&&auth.canItem(user,note,item));
  }
  let sending=false;
  async function deliver(){
    if(sending||!enabled())return;sending=true;
    try{
      const now=clock(),row=db.prepare("SELECT * FROM bot_outbox WHERE status='pending' AND due_at<=? AND next_attempt<=? ORDER BY CASE WHEN reminder_id IS NULL THEN 0 ELSE 1 END,due_at LIMIT 1").get(now,now);
      if(!row)return;
      if(!allowedMessage(row)){db.prepare("UPDATE bot_outbox SET status='cancelled',error='El usuario, el número o el permiso ya no están vigentes.' WHERE id=?").run(row.id);return;}
      const last=db.prepare('SELECT last_inbound FROM bot_contacts WHERE phone=?').get(row.recipient)?.last_inbound||0;
      if(now-row.due_at>(row.reminder_id?day:30*minute)){db.prepare("UPDATE bot_outbox SET status='expired',error='Aviso vencido mientras el servicio estaba detenido.' WHERE id=?").run(row.id);return;}
      const prefs=preferences(),inWindow=last>0&&now-last<day-5*minute&&!row.force_template;
      if(!inWindow&&(!row.reminder_id||!prefs.templateName)){db.prepare("UPDATE bot_outbox SET status='blocked',error='Fuera de la ventana de 24 horas: configura una plantilla aprobada para los recordatorios.' WHERE id=?").run(row.id);return;}
      const reminder=row.reminder_id&&db.prepare('SELECT * FROM reminders WHERE id=?').get(row.reminder_id),code=row.reminder_id?.slice(0,8).toUpperCase();
      const text=reminder?`⏰ ${reminder.title}\n${formatWhen(reminder.due_at,reminder.zone)} (${reminder.zone})\nCódigo ${code}. Puedes responder HECHO ${code}, POSPONER ${code} 10 o CANCELAR ${code}.`:row.text;
      const options={to:row.recipient,text};
      if(reminder&&inWindow)options.buttons=[{id:'done:'+reminder.id,title:'Hecho'},{id:'snooze:'+reminder.id,title:'En 10 minutos'},{id:'cancel:'+reminder.id,title:'Cancelar aviso'}];
      if(reminder&&!inWindow)options.template={name:prefs.templateName,language:prefs.templateLanguage,parameters:[reminder.title,`${formatWhen(reminder.due_at,reminder.zone)} (${reminder.zone})`,code]};
      db.prepare("UPDATE bot_outbox SET status='sending',attempts=attempts+1 WHERE id=?").run(row.id);
      try{const result=await send(options);db.prepare("UPDATE bot_outbox SET status=CASE WHEN status IN ('delivered','read','failed') THEN status ELSE 'accepted' END,meta_id=?,error=NULL WHERE id=?").run(result.id,row.id);const early=db.prepare('SELECT * FROM bot_receipts WHERE id=?').get(result.id);if(early)receipt(early);}
      catch(error){const attempts=row.attempts+1,status=error.uncertain?'uncertain':error.blocked?'blocked':error.retryable&&attempts<5?'pending':'failed';db.prepare('UPDATE bot_outbox SET status=?,error=?,next_attempt=?,force_template=MAX(force_template,?) WHERE id=?').run(status,error.message,now+Math.min(60*minute,Math.pow(2,attempts)*30*1000),Number(Boolean(error.requiresTemplate)),row.id);}
    }finally{sending=false;}
  }
  function receipt(status){
    if(typeof status.id!=='string'||!['sent','delivered','read','failed'].includes(status.status))return;
    const prior=db.prepare('SELECT status FROM bot_receipts WHERE id=?').get(status.id),receiptRank={sent:1,delivered:2,read:3,failed:0};
    if(!prior||receiptRank[status.status]>=(receiptRank[prior.status]||0))db.prepare('INSERT INTO bot_receipts VALUES (?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status').run(status.id,status.status);
    db.exec('DELETE FROM bot_receipts WHERE rowid NOT IN (SELECT rowid FROM bot_receipts ORDER BY rowid DESC LIMIT 1000)');
    const current=db.prepare('SELECT * FROM bot_outbox WHERE meta_id=?').get(status.id);if(!current)return;
    const rank={accepted:1,sent:2,delivered:3,read:4};
    if(status.status==='failed'&&!['delivered','read'].includes(current.status))db.prepare("UPDATE bot_outbox SET status='failed',error='Meta informó que el mensaje no pudo entregarse. Revisa el número, la plantilla y los permisos.' WHERE id=?").run(current.id);
    else if(rank[status.status]&&(rank[status.status]>(rank[current.status]||0)))db.prepare('UPDATE bot_outbox SET status=?,error=NULL WHERE id=?').run(status.status,current.id);
  }
  function retry(id){
    const row=db.prepare('SELECT * FROM bot_outbox WHERE id=?').get(id);if(!row||!['blocked','failed','uncertain'].includes(row.status))throw new Error('El envío no admite reintento.');
    if(!allowedMessage(row))throw new Error('El destinatario o sus permisos ya no son válidos.');
    db.prepare("UPDATE bot_outbox SET status='pending',meta_id=NULL,error=NULL,next_attempt=0 WHERE id=?").run(id);
  }
  function status(){return {settings:preferences(),configured:whatsappInfo().configured,outbox:db.prepare('SELECT id,user_id,reminder_id,due_at,status,attempts,error,created FROM bot_outbox ORDER BY created DESC LIMIT 30').all().map(row=>({...row,username:userById(row.user_id)?.username||'Cuenta desactivada',zone:row.reminder_id?db.prepare('SELECT zone FROM reminders WHERE id=?').get(row.reminder_id)?.zone||preferences().timezone:preferences().timezone})),pendingConversations:db.prepare('SELECT COUNT(*) AS n FROM bot_conversations WHERE expires>?').get(clock()).n};}
  function refreshBlocked(){db.prepare("UPDATE bot_outbox SET status='pending',next_attempt=0 WHERE status='blocked' AND reminder_id IS NOT NULL AND due_at>?").run(clock()-day);}
  for(const target of db.prepare('SELECT note_id FROM note_bot_targets').all())syncNote(target.note_id);
  return {removeNote,enabled,settings,preferences,incoming,handle,deliver,receipt,syncNote,reminderState,status,retry,refreshBlocked,reply};
}
