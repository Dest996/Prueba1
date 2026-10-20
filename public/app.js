const $=id=>document.getElementById(id);
let state, project='', busy=false;
const labels={tarea:'Tarea',recordatorio:'Recordatorio',idea:'Idea',nota:'Nota'};
function el(tag,text,className){const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(className)e.className=className;return e;}
function notice(text){$('notice').textContent=text;}
async function api(path,options={}){const response=await fetch(path,options);const data=await response.json();if(!response.ok)throw new Error(data.error || 'No se pudo completar la acción.');return data;}
const json=(method,data)=>({method,headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
async function action(fn){if(busy)return;busy=true;$('save').disabled=true;notice('Procesando…');try{const result=await fn();await refresh();notice(result?.warning || result?.message || 'Guardado.');}catch(e){notice(e.message);}finally{busy=false;$('save').disabled=false;}}
async function refresh(){const [data,whatsapp]=await Promise.all([api('/api/state'),api('/api/whatsapp/status')]);state=data;state.whatsapp=whatsapp;render();}
function render(){
  $('ai-status').textContent=state.capabilities.ai?`${state.capabilities.aiProvider} configurado`:'Sin IA: configura un proveedor';
  $('audio').disabled=!state.capabilities.ai;
  const wa=state.whatsapp;
  $('whatsapp-status').textContent=wa.lastNote?`Última nota recibida: ${new Date(wa.lastNote).toLocaleString('es-CL')}`:wa.lastReceived?'Mensaje recibido. Comprueba su procesamiento más abajo.':wa.configured?'Configuración guardada. Falta comprobar Meta y recibir tu primer mensaje.':'WhatsApp pendiente de configuración. Sigue la guía de Windows incluida en el proyecto.';
  $('whatsapp-diagnostics').replaceChildren();
  if(wa.events?.length){
    const events=el('details'),title=el('summary','Diagnóstico de recepción de WhatsApp');events.append(title);
    wa.events.forEach(event=>events.append(el('p',`${new Date(event.received).toLocaleString('es-CL')} · ${event.summary}`)));
    $('whatsapp-diagnostics').append(events);
  }else $('whatsapp-diagnostics').textContent='Todavía no se registraron entregas desde que se instaló este diagnóstico.';
  $('projects').replaceChildren();
  state.projects.forEach(name=>{const b=el('button',name,'nav'+(project===name?' active':''));b.onclick=()=>{project=name;render();};$('projects').append(b);});
  $('all-notes').classList.toggle('active',!project);
  const all=state.notes.flatMap(n=>n.items);
  $('stats').replaceChildren(...[['Elementos',all.length],['Tareas pendientes',all.filter(i=>i.category==='tarea'&&!i.done).length],['Ideas',all.filter(i=>i.category==='idea').length],['Recordatorios',all.filter(i=>i.category==='recordatorio'&&!i.done).length]].map(([label,count])=>{const d=el('div',undefined,'stat');d.append(el('span',label),el('strong',String(count)));return d;}));
  const search=$('search').value.toLowerCase(), category=$('category').value, pending=$('pending').checked;
  const filtered=state.notes.map(note=>({note,items:note.items.map((item,index)=>({item,index})).filter(({item})=>(!project||item.project===project)&&(!category||item.category===category)&&(!pending||!item.done)&&(!search||[note.transcript,item.title,item.project||''].join(' ').toLowerCase().includes(search)))})).filter(x=>x.items.length);
  $('list-title').textContent=project || 'Tu bandeja';$('count').textContent=`${filtered.length} notas`;
  $('notes').replaceChildren();
  for(const {note,items} of filtered){
    const card=el('article',undefined,'note'),top=el('div',undefined,'note-top');
    top.append(el('span',new Date(note.received).toLocaleString('es-CL')),el('span',note.source==='whatsapp'?'WhatsApp':note.source==='audio'?'Audio':'Texto'));
    if(!note.classified)top.append(el('span','Por clasificar','tag'));
    card.append(top);
    for(const {item,index} of items){
      const row=el('div',undefined,'item'),check=document.createElement('input');check.type='checkbox';check.checked=item.done;check.setAttribute('aria-label',`Marcar completado: ${item.title}`);
      check.onchange=()=>action(()=>{const updated=structuredClone(note.items);updated[index].done=check.checked;return api(`/api/notes/${encodeURIComponent(note.id)}`,json('PATCH',{items:updated}));});
      const content=el('div',undefined,'item-content');content.append(el('p',item.title,'item-title'+(item.done?' done':'')));
      const meta=el('div',undefined,'meta');meta.append(el('span',labels[item.category],'tag'),el('span',item.project || 'Sin proyecto'));if(item.dueDate)meta.append(el('span',`Fecha: ${item.dueDate}`));content.append(meta);
      const edit=el('button','Editar','edit');edit.onclick=()=>editor(row,note,index);row.append(check,content,edit);card.append(row);
    }
    const details=el('details'),summary=el('summary','Ver original');details.append(summary,el('p',note.transcript));card.append(details);
    if(state.capabilities.ai){const retry=el('button','Clasificar con IA','edit');retry.onclick=()=>{if(note.classified&&!confirm('Se reemplazarán las clasificaciones y correcciones de esta nota. ¿Continuar?'))return;action(()=>api(`/api/notes/${encodeURIComponent(note.id)}/classify`,{method:'POST'}));};details.append(retry);}
    $('notes').append(card);
  }
  if(!filtered.length)$('notes').append(el('div',state.notes.length?'No hay notas que coincidan con estos filtros.':'Tu bandeja está esperando la primera idea. Crea un proyecto y escribe una nota para empezar.','empty'));
  $('jobs').replaceChildren();
  if(state.jobs.length){$('jobs').append(el('h2','Entrada de WhatsApp'));state.jobs.forEach(j=>$('jobs').append(el('p',`${j.status==='error'?'Error':j.status==='processing'?'Procesando':'En cola'} · ${j.error || new Date(j.received).toLocaleString('es-CL')}`)));if(state.jobs.some(j=>j.status==='error')){const b=el('button','Reintentar errores');b.onclick=()=>action(()=>api('/api/jobs/retry',{method:'POST'}));$('jobs').append(b);}}
}
function editor(row,note,index){
  const item=note.items[index],form=el('form',undefined,'editor');
  const title=document.createElement('input');title.value=item.title;title.required=true;title.maxLength=300;title.setAttribute('aria-label','Título');
  const category=el('select');Object.entries(labels).forEach(([value,label])=>{const o=el('option',label);o.value=value;category.append(o);});category.value=item.category;category.setAttribute('aria-label','Tipo');
  const select=el('select');[null,...state.projects].forEach(name=>{const o=el('option',name||'Sin proyecto');o.value=name||'';select.append(o);});select.value=item.project||'';select.setAttribute('aria-label','Proyecto');
  const date=document.createElement('input');date.type='date';date.value=item.dueDate||'';date.setAttribute('aria-label','Fecha');
  const save=el('button','Guardar'),cancel=el('button','Cancelar');cancel.type='button';cancel.onclick=render;
  form.append(title,category,select,date,save,cancel);form.onsubmit=e=>{e.preventDefault();action(()=>{const updated=structuredClone(note.items);updated[index]={...item,title:title.value,category:category.value,project:select.value||null,dueDate:date.value||null};return api(`/api/notes/${encodeURIComponent(note.id)}`,json('PATCH',{items:updated}));});};row.replaceChildren(form);title.focus();
}
$('note-form').onsubmit=e=>{e.preventDefault();const text=$('note-text').value;action(async()=>{const result=await api('/api/notes',json('POST',{text}));$('note-text').value='';return result;});};
$('project-form').onsubmit=e=>{e.preventDefault();action(async()=>{const result=await api('/api/projects',json('POST',{name:$('project-name').value}));$('project-name').value='';return result;});};
$('audio').onchange=()=>{const file=$('audio').files[0];if(!file)return;if(file.size>state.capabilities.maxAudioBytes){notice(`El audio debe pesar como máximo ${state.capabilities.maxAudioBytes/1024/1024} MB con ${state.capabilities.aiProvider}.`);return;}action(()=>api('/api/audio',{method:'POST',headers:{'Content-Type':file.type || 'audio/ogg'},body:file}));$('audio').value='';};
$('check-whatsapp').onclick=()=>action(()=>api('/api/whatsapp/check',{method:'POST'}));
$('check-ai').onclick=()=>action(()=>api('/api/ai/check',{method:'POST'}));
$('all-notes').onclick=()=>{project='';render();};
['search','category','pending'].forEach(id=>$(id).addEventListener('input',()=>state&&render()));
refresh().catch(e=>notice(e.message));
setInterval(()=>{if(state&&!document.hidden&&!busy&&!document.querySelector('.editor'))refresh().catch(()=>{});},5000);
