const dayPattern=/^\d{4}-\d{2}-\d{2}$/;
export function validDay(value){return typeof value==='string'&&dayPattern.test(value)&&!Number.isNaN(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;}
export const validTime=value=>typeof value==='string'&&/^([01]\d|2[0-3]):[0-5]\d$/.test(value);
export function validZone(value){try{new Intl.DateTimeFormat('es-CL',{timeZone:value}).format();return typeof value==='string'&&value.length<80;}catch{return false;}}
export function localParts(instant,zone='America/Santiago'){
  const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(instant)).map(p=>[p.type,p.value]));
  return {date:`${p.year}-${p.month}-${p.day}`,time:`${p.hour}:${p.minute}`};
}
export function localInstant(date,time,zone='America/Santiago'){
  if(!validDay(date)||!validTime(time)||!validZone(zone))throw new Error('Fecha, hora o zona horaria inválida.');
  const nominal=Date.parse(`${date}T${time}:00Z`),offsets=new Set();
  for(let delta=-36;delta<=36;delta+=6){const probe=nominal+delta*3600000,wall=localParts(probe,zone);offsets.add(Date.parse(`${wall.date}T${wall.time}:00Z`)-probe);}
  const candidates=[...offsets].map(offset=>nominal-offset).filter(value=>{const p=localParts(value,zone);return p.date===date&&p.time===time;});
  if(!candidates.length)throw new Error('Esa hora no existe por el cambio de horario. Elige otra hora.');
  if(candidates.length>1)throw new Error('Esa hora se repite por el cambio de horario. Elige una hora fuera del cambio.');
  return candidates[0];
}
export const normalize=text=>String(text).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim();
const addDays=(date,n)=>new Date(Date.parse(date+'T12:00:00Z')+n*86400000).toISOString().slice(0,10);
const numberWords={una:1,uno:1,dos:2,tres:3,cuatro:4,cinco:5,seis:6,siete:7,ocho:8,nueve:9,diez:10,once:11,doce:12};
export function parseWhen(text,now=Date.now(),zone='America/Santiago'){
  const n=normalize(text),today=localParts(now,zone).date;let date=null,time=null,ambiguous=false;
  if(/\ben media hora\b/.test(n))return {...localParts(Math.ceil((now+30*60000)/60000)*60000,zone),ambiguous:false};
  const relative=n.match(/\ben\s+(\d{1,4})\s*(minutos?|mins?|min|horas?|hrs?|h)\b/);
  if(relative){const quantity=Number(relative[1]),minutes=quantity*(relative[2].startsWith('h')?60:1);if(minutes>0&&minutes<=525600)return {...localParts(Math.ceil((now+minutes*60000)/60000)*60000,zone),ambiguous:false};}
  const explicit=n.match(/\b(\d{4}-\d{2}-\d{2})\b/),slash=n.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?\b/);
  if(explicit)date=explicit[1];
  else if(slash)date=`${slash[3]||today.slice(0,4)}-${slash[2].padStart(2,'0')}-${slash[1].padStart(2,'0')}`;
  else if(/\bpasado manana\b/.test(n))date=addDays(today,2);
  else if(/\bmanana\b/.test(n.replace(/\b(?:de|por) la manana\b/g,'')))date=addDays(today,1);
  else if(/\bhoy\b/.test(n))date=today;
  else {
    const days=['domingo','lunes','martes','miercoles','jueves','viernes','sabado'];
    const weekday=days.findIndex(day=>new RegExp('\\b'+day+'\\b').test(n));
    if(weekday>=0){const delta=(weekday-new Date(today+'T12:00:00Z').getUTCDay()+7)%7;date=addDays(today,delta===0&&/proximo|siguiente/.test(n)?7:delta);}
    const months=['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
    const named=n.match(/\b(\d{1,2}) de ([a-z]+)(?: (?:de )?(\d{4}))?\b/);
    if(named&&months.includes(named[2]))date=`${named[3]||today.slice(0,4)}-${String(months.indexOf(named[2])+1).padStart(2,'0')}-${named[1].padStart(2,'0')}`;
  }
  const clock=n.match(/\b(?:a las?\s+)?(\d{1,2}):(\d{2})\s*(am|pm|a\.m\.|p\.m\.)?\b/)||n.match(/\ba las?\s+(\d{1,2}|una|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce)(?:\s*(am|pm)|\s+de la\s+(manana|tarde|noche))?\b/)||n.match(/\b(\d{1,2})\s*(am|pm)\b/)||n.match(/^(\d{1,2})$/);
  if(clock){
    let hour=numberWords[clock[1]]??Number(clock[1]),minute=0,period;
    const colon=clock[0].includes(':');
    if(colon){minute=Number(clock[2]);period=clock[3];}
    else{period=clock[2]||clock[3];const tail=n.slice(clock.index+clock[0].length);if(/^\s+y media\b/.test(tail))minute=30;if(/^\s+y cuarto\b/.test(tail))minute=15;if(/^\s+menos cuarto\b/.test(tail)){hour=(hour+23)%24;minute=45;}period=period||tail.slice(0,40).match(/\bde la (manana|tarde|noche)\b/)?.[1];}
    if(period&&/pm|tarde|noche/.test(period)&&hour<12)hour+=12;
    if(period&&/am|manana/.test(period)&&hour===12)hour=0;
    ambiguous=!colon&&!period&&hour>=1&&hour<=7;
    if(hour>=0&&hour<=23&&minute<=59&&!ambiguous)time=`${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}`;
  }
  if(/\bmediodia\b/.test(n))time='12:00';
  return {date:date&&validDay(date)?date:null,time,ambiguous,invalidDate:Boolean(date&&!validDay(date))};
}
export function reminderTitle(text){
  return String(text).trim().replace(/^(?:recordatorio\s*:?|recu[eé]rdame|recordarme|av[ií]same|recordar|no olvides)(?:\s+que)?\s*/i,'')
    .replace(/\b(?:a las?\s+)?\d{1,2}:\d{2}\s*(?:am|pm)?\b/gi,'')
    .replace(/\ba las?\s+(?:\d{1,2}|una|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce)(?:\s+(?:y media|y cuarto|menos cuarto))?(?:\s*(?:am|pm)|\s+de la\s+(?:ma[ñn]ana|tarde|noche))?\b/gi,'')
    .replace(/\b(?:pasado ma[ñn]ana|ma[ñn]ana|hoy|(?:el |pr[oó]ximo )?(?:lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo))\b/gi,'')
    .replace(/\b(?:el\s+)?\d{4}-\d{2}-\d{2}\b|\b(?:el\s+)?\d{1,2}\/\d{1,2}(?:\/\d{4})?\b/g,'')
    .replace(/\ben media hora\b/gi,'')
    .replace(/\b\d{1,2} de (?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)(?: (?:de )?\d{4})?\b/gi,'')
    .replace(/\ben\s+\d+\s*(?:minutos?|mins?|min|horas?|hrs?|h)\b/gi,'').replace(/\s+/g,' ').replace(/^[\s,;:.\-]+|[\s,;:.\-]+$/g,'').slice(0,300);
}
export const isReminder=text=>/^(recordatorio\b|recuerdame\b|recordarme\b|avisame\b|recordar\b|no olvides\b)/.test(normalize(text));
export function formatWhen(instant,zone){return new Intl.DateTimeFormat('es-CL',{timeZone:zone,dateStyle:'short',timeStyle:'short',hourCycle:'h23'}).format(new Date(instant));}
