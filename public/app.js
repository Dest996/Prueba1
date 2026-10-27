const $=id=>document.getElementById(id);
let state, project='', busy=false, notesView='cards';
try{const saved=localStorage.getItem('hilo.notesView');if(['list','cards'].includes(saved))notesView=saved;}catch{}
function applyNotesView(){
  $('notes').dataset.view=notesView;
  for(const view of ['list','cards'])$('view-'+view).setAttribute('aria-pressed',String(notesView===view));
}
function setNotesView(view){notesView=view;try{localStorage.setItem('hilo.notesView',view);}catch{}applyNotesView();}
const elementCount=count=>`${count} ${count===1?'elemento':'elementos'}`;
const labels={tarea:'Tarea',recordatorio:'Recordatorio',idea:'Idea',nota:'Nota'};
function el(tag,text,className){const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(className)e.className=className;return e;}
function projectDot(name){const dot=el('span',undefined,'project-dot');dot.style.backgroundColor=state.projectDetails?.find(p=>p.name===name)?.color || '#648148';return dot;}
function notice(text){$('notice').textContent=text;document.querySelectorAll('.dialog-notice').forEach(node=>node.textContent=text);}
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
  state.projects.forEach(name=>{
    const row=el('div',undefined,'project-row'),b=el('button',undefined,'nav'+(project===name?' active':''));
    b.append(projectDot(name),el('span',name,'project-name'));b.onclick=()=>{project=name;render();};
    const edit=el('button','✎','project-settings');edit.setAttribute('aria-label',`Personalizar proyecto ${name}`);edit.title=`Personalizar ${name}`;edit.onclick=()=>openProject(name);
    row.append(b,edit);$('projects').append(row);
  });
  updateProjectOrderControls();
  $('all-notes').classList.toggle('active',project==='');
  $('unassigned-notes').classList.toggle('active',project===null);
  const all=state.notes.flatMap(n=>n.items);
  $('stats').replaceChildren(...[['Elementos',all.length],['Tareas pendientes',all.filter(i=>i.category==='tarea'&&!i.done).length],['Ideas',all.filter(i=>i.category==='idea').length],['Recordatorios',all.filter(i=>i.category==='recordatorio'&&!i.done).length]].map(([label,count])=>{const d=el('div',undefined,'stat');d.append(el('span',label),el('strong',String(count)));return d;}));
  const search=$('search').value.toLowerCase(), category=$('category').value, pending=$('pending').checked;
  const filtered=state.notes.map(note=>({note,items:note.items.map((item,index)=>({item,index})).filter(({item})=>(project===''||(project===null?!item.project:item.project===project))&&(!category||item.category===category)&&(!pending||!item.done)&&(!search||[note.transcript,item.title,item.project||''].join(' ').toLowerCase().includes(search)))})).filter(x=>x.items.length);
  $('list-title').textContent=project===null?'Sin proyecto':project || (pending?'Pendientes por proyecto':'Notas por proyecto');
  $('count').textContent=`${filtered.length} notas · ${elementCount(filtered.reduce((sum,entry)=>sum+entry.items.length,0))}`;
  $('notes').replaceChildren();
  const groups=new Map();
  // Group the filtered elements, preserving their original indices for edits.
  for(const {note,items} of filtered){
    for(const name of new Set(items.map(({item})=>item.project || null))){
      if(!groups.has(name))groups.set(name,[]);
      groups.get(name).push({note,items:items.filter(({item})=>(item.project || null)===name)});
    }
  }
  const names=[...state.projects.filter(name=>groups.has(name)),...Array.from(groups.keys()).filter(name=>name!==null&&!state.projects.includes(name)),...(groups.has(null)?[null]:[])];
  for(const name of names){
    const group=el('section',undefined,'project-group'),heading=el('div',undefined,'group-heading'),title=el('h3',name || 'Sin proyecto');
    if(name)heading.append(projectDot(name));
    heading.append(title,el('span',elementCount(groups.get(name).reduce((sum,entry)=>sum+entry.items.length,0)),'muted'));
    const list=el('div',undefined,'group-notes');group.append(heading,list);$('notes').append(group);
    for(const {note,items} of groups.get(name)){

      const card=el('article',undefined,'note'),top=el('div',undefined,'note-top');
      top.append(el('span',new Date(note.received).toLocaleString('es-CL')),el('span',note.source==='whatsapp'?'WhatsApp':note.source==='audio'?'Audio':'Texto'));
      if(!note.classified)top.append(el('span','Por clasificar','tag'));
      const header=el('div',undefined,'note-header');header.append(top);card.append(header);
      const menu=el('details',undefined,'note-menu'),trigger=el('summary','⋯');trigger.setAttribute('aria-label','Acciones de la nota');trigger.title='Acciones de la nota';menu.append(trigger);
      menu.addEventListener('toggle',()=>{if(menu.open)document.querySelectorAll('.note-menu[open]').forEach(other=>{if(other!==menu)other.open=false;});});
      const actions=el('div',undefined,'note-actions'),move=el('select');move.setAttribute('aria-label','Mover toda la nota a un proyecto');
      const placeholder=el('option','Mover toda la nota a…');placeholder.value='';placeholder.disabled=true;placeholder.selected=true;move.append(placeholder);
      [null,...state.projects].forEach(name=>{const option=el('option',name||'Sin proyecto');option.value=name===null?'none':`project:${name}`;move.append(option);});
      move.onchange=()=>action(()=>api(`/api/notes/${encodeURIComponent(note.id)}/project`,json('PATCH',{project:move.value==='none'?null:move.value.slice(8)})));
      const remove=el('button','Eliminar nota','danger edit');remove.onclick=()=>{
        if(confirm('¿Eliminar esta nota completa y todos sus elementos? Esta acción no se puede deshacer.'))action(()=>api(`/api/notes/${encodeURIComponent(note.id)}`,{method:'DELETE'}));
      };
      actions.append(move,remove);menu.append(actions);header.append(menu);
      for(const {item,index} of items){
        const row=el('div',undefined,'item'),check=document.createElement('input');check.type='checkbox';check.checked=item.done;check.setAttribute('aria-label',`Marcar completado: ${item.title}`);
        check.onchange=()=>action(()=>{const updated=structuredClone(note.items);updated[index].done=check.checked;return api(`/api/notes/${encodeURIComponent(note.id)}`,json('PATCH',{items:updated}));});
        const content=el('div',undefined,'item-content');content.append(el('p',item.title,'item-title'+(item.done?' done':'')));
        const meta=el('div',undefined,'meta');const projectTag=el('span',undefined,'project-chip');if(item.project)projectTag.append(projectDot(item.project));projectTag.append(el('span',item.project || 'Sin proyecto'));meta.append(el('span',labels[item.category],'tag tag-'+item.category),projectTag);if(item.dueDate)meta.append(el('span',`Fecha: ${item.dueDate}`));content.append(meta);
        const edit=el('button','Editar','edit');edit.onclick=()=>editor(row,note,index);row.append(check,content,edit);card.append(row);
      }
      const details=el('details'),summary=el('summary','Ver original');details.append(summary,el('p',note.transcript));card.append(details);
      if(state.capabilities.ai){const retry=el('button','Clasificar con IA','edit');retry.onclick=()=>{if(note.classified&&!confirm('Se reemplazarán las clasificaciones y correcciones de esta nota. ¿Continuar?'))return;action(()=>api(`/api/notes/${encodeURIComponent(note.id)}/classify`,{method:'POST'}));};details.append(retry);}
      list.append(card);
    }
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
  form.append(title,category,select,date,save,cancel);
  if(note.items.length>1){const remove=el('button','Quitar este elemento','danger');remove.type='button';remove.onclick=()=>deleteItem(note,index);form.append(remove);}
  form.onsubmit=e=>{e.preventDefault();action(()=>{const updated=structuredClone(note.items);updated[index]={...item,title:title.value,category:category.value,project:select.value||null,dueDate:date.value||null};return api(`/api/notes/${encodeURIComponent(note.id)}`,json('PATCH',{items:updated}));});};row.replaceChildren(form);title.focus();
}
$('note-form').onsubmit=e=>{e.preventDefault();const text=$('note-text').value;action(async()=>{const result=await api('/api/notes',json('POST',{text}));$('note-text').value='';$('capture-dialog').close();return result;});};
$('project-form').onsubmit=e=>{e.preventDefault();action(async()=>{const result=await api('/api/projects',json('POST',{name:$('project-name').value,color:$('project-color').value}));$('project-name').value='';return result;});};
$('audio').onchange=()=>{const file=$('audio').files[0];if(!file)return;if(file.size>state.capabilities.maxAudioBytes){notice(`El audio debe pesar como máximo ${state.capabilities.maxAudioBytes/1024/1024} MB con ${state.capabilities.aiProvider}.`);return;}action(async()=>{const result=await api('/api/audio',{method:'POST',headers:{'Content-Type':file.type || 'audio/ogg'},body:file});$('capture-dialog').close();return result;});$('audio').value='';};
$('check-whatsapp').onclick=()=>action(()=>api('/api/whatsapp/check',{method:'POST'}));
$('check-ai').onclick=()=>action(()=>api('/api/ai/check',{method:'POST'}));
$('unassigned-notes').onclick=()=>{project=null;render();};
$('all-notes').onclick=()=>{project='';render();};
['search','category','pending'].forEach(id=>$(id).addEventListener('input',()=>state&&render()));
$('view-list').onclick=()=>setNotesView('list');
$('view-cards').onclick=()=>setNotesView('cards');
$('pending').checked=true;
$('new-note').onclick=()=>{notice('');$('capture-dialog').showModal();$('note-text').focus();};
$('open-settings').onclick=()=>{notice('');$('settings-dialog').showModal();};
$('close-capture').onclick=()=>$('capture-dialog').close();
$('close-settings').onclick=()=>$('settings-dialog').close();
document.addEventListener('click',event=>document.querySelectorAll('.note-menu[open]').forEach(menu=>{if(!menu.contains(event.target))menu.open=false;}));
document.addEventListener('keydown',event=>{if(event.key==='Escape')document.querySelectorAll('.note-menu[open]').forEach(menu=>{menu.open=false;menu.querySelector('summary').focus();});});
applyNotesView();
refresh().catch(e=>notice(e.message));
setInterval(()=>{if(state&&!document.hidden&&!busy&&!document.querySelector('.editor')&&!document.querySelector('dialog[open], .note-menu[open]')&&!['SELECT','INPUT'].includes(document.activeElement?.tagName))refresh().catch(()=>{});},5000);

function deleteItem(note,index){
  if(note.items.length<=1){notice('Para eliminar la nota completa usa Eliminar nota.');return;}
  if(!confirm('¿Quitar este elemento de la nota? La transcripción original se conservará.'))return;
  action(()=>api(`/api/notes/${encodeURIComponent(note.id)}`,json('PATCH',{items:note.items.filter((_,i)=>i!==index)})));
}
function openProject(name){
  const details=state.projectDetails.find(p=>p.name===name);
  $('project-dialog').dataset.name=name;
  $('settings-project-name').value=name;$('settings-project-color').value=details.color;
  updateProjectOrderControls();$('project-dialog').showModal();
}
function updateProjectOrderControls(){
  if(!state)return;
  const index=state.projects.indexOf($('project-dialog').dataset.name);
  $('project-up').disabled=index<=0;$('project-down').disabled=index<0||index===state.projects.length-1;
}
function moveProject(offset){
  action(()=>{const names=[...state.projects],index=names.indexOf($('project-dialog').dataset.name),target=index+offset;
    if(index<0||target<0||target>=names.length)throw new Error('No se puede mover el proyecto en esa dirección.');
    [names[index],names[target]]=[names[target],names[index]];return api('/api/projects/order',json('PUT',{names}));
  });
}
$('project-up').onclick=()=>moveProject(-1);$('project-down').onclick=()=>moveProject(1);
$('cancel-project').onclick=()=>$('project-dialog').close();
$('project-settings-form').onsubmit=e=>{
  e.preventDefault();
  action(async()=>{const oldName=$('project-dialog').dataset.name,name=$('settings-project-name').value.trim();
    const result=await api(`/api/projects/${encodeURIComponent(oldName)}`,json('PATCH',{name,color:$('settings-project-color').value}));
    if(project===oldName)project=name;$('project-dialog').close();return result;
  });
};
$('delete-project').onclick=()=>{
  const name=$('project-dialog').dataset.name;
  if(!confirm(`¿Eliminar el proyecto “${name}”? Sus notas se conservarán sin proyecto.`))return;
  action(async()=>{const result=await api(`/api/projects/${encodeURIComponent(name)}`,{method:'DELETE'});if(project===name)project=null;$('project-dialog').close();return result;});
};
