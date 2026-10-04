// Shared accessible controls; calls retain the revision displayed to reject concurrent corrections.
window.memoryControls=(root,data,save,customer)=>{
  const el=(tag,props={},...children)=>{const n=Object.assign(document.createElement(tag),props);n.append(...children);return n;};
  root.replaceChildren(el('h3',{textContent:'Customer memory'}),el('p',{textContent:data.disclosure}),el('p',{textContent:data.enabled?'Memory enabled':'Memory disabled'}));
  if(data.extraction?.status==='failed')root.append(el('p',{textContent:'Preferences could not be saved. Please try again.'}));
  const submit=(action,extra={})=>save({action,revision:data.revision,...extra});
  if(!data.enabled){if(customer)root.append(el('button',{type:'button',textContent:'Opt in to memory',onclick:()=>submit('enable',{disclosure_version:data.disclosure_version})}));return;}
  const list=el('ul');
  list.append(...data.preferences.map(p=>el('li',{},`${p.kind.replaceAll('_',' ')}: ${p.value}. ${p.provenance}; confirmed ${new Date(p.confirmed_at).toLocaleString()}; expires ${new Date(p.expires_at).toLocaleString()}.${p.source_message?` Source message ${p.source_message}.`:''}${p.corrected_by?` Operator ${p.corrected_by}.`:''}`)));
  root.append(list);
  const select=el('select',{name:'kind'});
  for(const kind of ['preferred_name','language','communication_style','product_interests'])select.append(el('option',{value:kind,textContent:kind.replaceAll('_',' ')}));
  const value=el('input',{name:'value',required:true,maxLength:120}),button=el('button',{textContent:'Save preference correction'});
  const form=el('form',{},el('label',{},'Preference kind',select),el('label',{},'Preference value',value),button);
  form.addEventListener('submit',event=>{event.preventDefault();submit('correct',{kind:select.value,value:value.value});});
  root.append(form,el('button',{type:'button',textContent:'Delete all preferences',onclick:()=>submit('delete')}),el('button',{type:'button',textContent:'Disable memory',onclick:()=>submit('disable')}));
};
