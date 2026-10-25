/** A local-only webview. All repository content enters through escaped text, never executable HTML. */
export function dashboardHtml(nonce: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<title>Duff dashboard</title><style nonce="${nonce}">
*{box-sizing:border-box}body{margin:0;color:var(--vscode-foreground);background:var(--vscode-editor-background);font:13px var(--vscode-font-family);line-height:1.5}button,input{font:inherit}button{cursor:pointer;color:inherit;background:transparent;border:1px solid var(--vscode-widget-border, #7775);border-radius:4px;padding:7px 12px}button:hover{background:var(--vscode-list-hoverBackground)}button:disabled{cursor:default;opacity:.5}button:focus-visible,input:focus-visible{outline:2px solid var(--vscode-focusBorder);outline-offset:2px}.primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border-color:transparent}.primary:hover{background:var(--vscode-button-hoverBackground)}.quiet{border-color:transparent}.muted,small{color:var(--vscode-descriptionForeground)}small{font-size:12px}.header{display:flex;align-items:center;justify-content:space-between;padding:20px 24px;border-bottom:1px solid var(--vscode-widget-border, #7775);gap:16px}h1{font-size:22px;font-weight:500;margin:0}h2{font-size:17px;font-weight:500;margin:0 0 8px}h3{font-size:13px;font-weight:500;margin:24px 0 8px}.header p{margin:3px 0 0}.layout{display:grid;grid-template-columns:240px minmax(280px,1fr) 300px;min-height:calc(100vh - 94px)}nav{padding:20px 12px;border-right:1px solid var(--vscode-widget-border,#7775)}nav button{display:block;text-align:left;width:100%;border:0;margin:3px 0;overflow-wrap:anywhere}nav button[aria-current="true"],.selected{background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground)}main{padding:24px;min-width:0}aside{border-left:1px solid var(--vscode-widget-border,#7775);padding:24px;min-width:0;overflow-wrap:anywhere}aside p{margin:10px 0 18px}.toolbar{display:flex;align-items:center;gap:8px;margin:16px 0;flex-wrap:wrap}.toolbar input{flex:1;min-width:180px}input[type="search"],input[type="text"]{color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border, #7775);border-radius:4px;padding:8px 10px;width:100%}.tabs{display:flex;gap:4px}.tabs button[aria-pressed="true"]{border-bottom:2px solid var(--vscode-focusBorder)}.rows{border-top:1px solid var(--vscode-widget-border,#7775)}.row{display:flex;align-items:flex-start;gap:12px;padding:16px 8px;border:0;border-bottom:1px solid var(--vscode-widget-border,#7775);border-radius:0;width:100%;text-align:left;overflow-wrap:anywhere}.row .copy{flex:1;min-width:0}.row small{display:block;margin-top:4px}.row input{margin:4px 0 0;accent-color:var(--vscode-focusBorder)}.tag{font-size:11px;border:1px solid var(--vscode-widget-border,#7775);border-radius:3px;padding:2px 6px;white-space:nowrap}.empty{padding:48px 12px;max-width:580px}.empty h2{font-size:22px}.empty p{color:var(--vscode-descriptionForeground);margin-bottom:24px}.notice{margin:12px 0;padding:10px 0;color:var(--vscode-descriptionForeground);white-space:pre-wrap}.error{color:var(--vscode-errorForeground)}.footer{padding:16px 24px;border-top:1px solid var(--vscode-widget-border,#7775);display:flex;gap:12px;align-items:center;justify-content:space-between}.footer small{max-width:65%}.selection{margin:12px 0;padding:8px 0;border-bottom:1px solid var(--vscode-widget-border,#7775)}.wide{width:100%;margin-top:12px}.mono{font-family:var(--vscode-editor-font-family);font-size:12px}.nowrap{white-space:nowrap}.hint{padding-top:16px;border-top:1px solid var(--vscode-widget-border,#7775);margin-top:24px}a{color:var(--vscode-textLink-foreground)}@media(max-width:1000px){.layout{grid-template-columns:200px minmax(240px,1fr)}aside{grid-column:2;border-left:0;border-top:1px solid var(--vscode-widget-border,#7775)}}@media(max-width:560px){.layout{display:block}nav{border-right:0;border-bottom:1px solid var(--vscode-widget-border,#7775);padding:12px}main,aside{padding:16px}.header{padding:16px}.footer{padding:16px}.tag{white-space:normal}}
#app{height:100vh;display:flex;flex-direction:column}#app>.layout{flex:1;min-height:0;grid-template-rows:minmax(0,1fr)}body{overflow:hidden}.header,.footer{flex-shrink:0}.layout>nav,.layout>main,.layout>aside{min-height:0;overflow-y:auto;overscroll-behavior:contain}.footer{background:var(--vscode-editor-background)}
@media(max-width:1000px){#app>.layout{grid-template-rows:repeat(2,minmax(0,1fr))}.layout>nav{grid-row:1 / -1}}
@media(max-width:560px){#app>.layout{display:grid;grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(0,.5fr) minmax(0,1fr) minmax(0,1.5fr)}.layout>nav{grid-row:auto}.layout>aside{grid-column:1}}
.author{display:flex;align-items:center;gap:8px;margin-top:8px}.avatar{position:relative;display:inline-grid;place-items:center;flex:none;width:28px;height:28px;border-radius:50%;background:var(--vscode-badge-background,#555);color:var(--vscode-badge-foreground,#fff);font-size:11px;overflow:hidden}.avatar img{position:absolute;width:100%;height:100%;object-fit:cover}.author small{margin:0}.change-stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin:24px 0 8px}.change-stats div{display:flex;flex-direction:column-reverse}.change-stats dt{font-size:11px;color:var(--vscode-descriptionForeground)}.change-stats dd{margin:0;font-size:20px;font-variant-numeric:tabular-nums}.added{color:var(--vscode-gitDecoration-addedResourceForeground,#81b88b)}.deleted{color:var(--vscode-gitDecoration-deletedResourceForeground,#c74e39)}.description{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.6;margin:8px 0 24px}.detail-status{padding:16px 0}.detail-author{margin:16px 0}
</style></head><body><div id="app"></div><script nonce="${nonce}">
{
const bridge=acquireVsCodeApi();
let model;
let query='';
let avatarObserver;
const requestedAvatars=new Set();
const escape=(value)=>String(value??'').replace(/[&<>"']/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const hosted=(repo)=>repo.hosting._tag==='Some'?repo.hosting.value:undefined;
const send=(action,id)=>bridge.postMessage({action,id});
const button=(label,action,id,kind='')=>'<button class="'+kind+'" data-action="'+action+'"'+(id!==undefined?' data-id="'+escape(id)+'"':'')+'>'+escape(label)+'</button>';
const author=(pr)=>{
const name=pr.author??'Unknown author';
const initials=name.split(/\\s+/).filter(Boolean).slice(0,2).map((part)=>Array.from(part)[0]).join('').toUpperCase();
const key=pr.authorAvatarKey;
const image=key&&Object.hasOwn(model.avatars??{},key)?model.avatars[key]:undefined;
const safe=typeof image==='string'&&/^data:image\\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+=*$/.test(image);
return '<span class="author"><span class="avatar" aria-hidden="true" data-avatar="'+escape(pr.id)+'">'+escape(initials)+(safe?'<img alt="" src="'+escape(image)+'">':'')+'</span><small>Opened by '+escape(name)+'</small></span>';
};
const metadata=(pr)=>{
const state=model.details;
if(state?._tag==='Failed')return '<div class="detail-status" role="status">Could not load PR details. '+button('Retry','details',pr.id)+'</div>';
if(state?._tag!=='Loaded'||state.value.pullRequest.id!==pr.id)return '<p class="muted detail-status" role="status">Loading PR details…</p>';
const details=state.value;
const files=details.filesChanged._tag==='Some'?details.filesChanged.value:undefined;
const lines=details.linesChanged._tag==='Some'?details.linesChanged.value:undefined;
return '<dl class="change-stats" aria-label="Change summary"><div><dt>Files changed</dt><dd>'+escape(files??'—')+'</dd></div><div><dt>Lines added</dt><dd class="'+(lines?'added':'muted')+'">'+(lines?'+'+escape(lines.additions):'—')+'</dd></div><div><dt>Lines deleted</dt><dd class="'+(lines?'deleted':'muted')+'">'+(lines?'−'+escape(lines.deletions):'—')+'</dd></div></dl>'+(files===undefined?'<small>File count unavailable.</small>':'')+(!lines?'<p class="muted">Line totals unavailable from this provider.</p>':'')+'<h3>Description</h3><div class="description">'+escape(details.description.trim()?details.description:'No description provided.')+'</div>';
};
const render=()=>{
if(!model)return;
if(!model.pulls.length)requestedAvatars.clear();
const scroll=Object.entries({
nav:model.mode,
main:JSON.stringify([model.mode,model.repositoryId,model.filter,model.sourceId]),
aside:JSON.stringify([model.mode,model.repositoryId,model.sourceId,model.pullRequestId]),
}).map(([tag,key])=>{
const element=document.querySelector('.layout>'+tag);
return {tag,key,top:element?.dataset.scrollKey===key?element.scrollTop:0};
});
const picker=model.mode==='picker';
const current=model.repositories.find((repo)=>repo.id===model.repositoryId);
const selected=model.pulls.find((pr)=>pr.id===model.pullRequestId);
const heading=picker?'Add repositories':(current?.name??'Your repositories');
let nav='<h3>'+(picker?'Sources':'Repositories')+'</h3>';
if(picker){
nav+='<button data-action="source" data-id="local" aria-current="'+(model.sourceId==='local')+'">Local repositories</button><h3>Remote repositories</h3>';
for(const provider of model.providers)nav+='<button data-action="browse" data-id="'+escape(provider.id)+'" aria-current="'+model.sources.some((source)=>source.id===model.sourceId&&source.providerId===provider.id)+'">'+escape(provider.displayName)+'</button>';
if(model.sources.length){nav+='<h3>Collections</h3>';for(const source of model.sources)nav+=button(source.label,'suggestion',source.id,source.id===model.sourceId?'selected':'');nav+='<small>Suggested from Git remotes or browsed by you. Explore to load repositories; nothing is added automatically.</small>';}
}else{
for(const repo of model.repositories)nav+='<button data-action="repository" data-id="'+escape(repo.id)+'" aria-current="'+(repo.id===model.repositoryId)+'">'+escape(repo.name)+(hosted(repo)?'':' <small>Local only</small>')+'</button>';
nav+=button('+ Add repositories','picker',undefined,'wide');
}
let body='';let detail='';
if(picker){
body='<h2>'+(model.sourceId==='local'?'Local repositories':escape(model.sourceLabel))+'</h2><p class="muted">Choose several repositories, then add them together.</p><div class="toolbar"><input id="filter" type="search" aria-label="Filter repositories" placeholder="Filter loaded repositories…" value="'+escape(query)+'">'+button('Choose folders…','folders')+button('Add by URL…','url')+'</div>';
if(model.sourceId==='local')body+='<p class="muted">Open repositories and folders you choose. Selected parent folders are inspected one level deep, not your whole disk.</p>';
body+='<div class="rows">';
const visible=model.candidates.filter((repo)=>(repo.name+' '+repo.localPaths.join(' ')).toLowerCase().includes(query.toLowerCase()));
for(const repo of visible){const h=hosted(repo);const watched=model.repositories.some((item)=>item.id===repo.id&&repo.localPaths.every((path)=>item.localPaths.includes(path)));body+='<label class="row"><input type="checkbox" data-select="'+escape(repo.id)+'" '+(model.checked.includes(repo.id)?'checked ':'')+(watched?'disabled ':'')+'><span class="copy">'+escape(repo.name)+'<small>'+escape(repo.localPaths.join(', ')||h?.repository.authority||'Local repository')+'</small></span><span class="tag">'+(watched?'Already watched':escape(h?.provider.displayName??'Local only'))+'</span></label>';}
body+='</div>';
if(!visible.length&&!model.busy)body+='<div class="empty"><h2>'+(model.sourceId==='local'?'Choose a folder to begin':'No repositories on this page')+'</h2><p>'+(model.sourceId==='local'?'Add open projects or choose folders containing your repositories.':'Try another collection, check access, or continue to the next page.')+'</p></div>';
if(model.more)body+=button('Load more repositories','more',undefined,'wide');
detail='<h2>'+model.checked.length+' selected</h2>';
for(const id of model.checked){const repo=model.selections.find((item)=>item.id===id);if(repo)detail+='<div class="selection">'+escape(repo.name)+'<br><small>'+(hosted(repo)?'Watch pull requests'+(repo.localPaths.length?' and link local files':''):'Local branch comparison')+'</small></div>';}
detail+='<p class="muted">Selections stay when you switch sources.</p><p class="hint muted">Local-only repositories support branch comparison. Provider access is only requested when you browse that source.</p>';
}else if(!current){
body='<div class="empty"><h2>What would you like to review?</h2><p>Watch repositories across providers, or add local projects for branch comparison. Your watchlist is shared across local VS Code and VSCodium installations.</p>'+button('Add repositories','picker',undefined,'primary')+'</div>';
detail='<h2>Your review workspace</h2><p class="muted">Open a PR in its own window with a complete copy of its HEAD. Browse files, use language tooling, and keep your edits.</p><p class="hint muted">Duff never installs dependencies or runs project setup. Editor trust and language tooling still apply.</p>';
}else if(!hosted(current)){
body='<div class="empty"><h2>Local branch comparison</h2><p>This repository has no supported hosting remote. Open its folder to compare local branches. No provider connection is required.</p>'+button('Open local repository','local',current.id,'primary')+'</div>';
detail='<h2>'+escape(current.name)+'</h2><p class="mono">'+escape(current.localPaths.join(', '))+'</p>'+button('Remove from watchlist','remove',current.id,'wide');
}else{
body='<div class="toolbar"><input id="filter" type="search" aria-label="Filter pull requests" placeholder="Filter loaded PRs by title or number…" value="'+escape(query)+'">'+button('Refresh','refresh')+button('Connect','connect')+'</div><div class="tabs" role="group" aria-label="Pull request state">';
for(const state of ['open','merged','closed'])body+='<button data-action="state" data-id="'+state+'" aria-pressed="'+(model.filter===state)+'">'+state[0].toUpperCase()+state.slice(1)+'</button>';
body+='</div><p class="muted">'+escape(hosted(current).provider.displayName)+' · '+escape(hosted(current).repository.authority)+(model.filter==='closed'?' · Closed without merging':'')+'</p><div class="rows">';
const visible=model.pulls.filter((pr)=>(pr.title+' #'+pr.id).toLowerCase().includes(query.toLowerCase()));
for(const pr of visible)body+='<button class="row '+(pr.id===model.pullRequestId?'selected':'')+'" data-action="pull" data-id="'+escape(pr.id)+'"><span class="muted nowrap">#'+escape(pr.id)+'</span><span class="copy">'+escape(pr.title)+author(pr)+'<small>'+escape(pr.source._tag==='Available'?pr.source.ref.name.replace('refs/heads/',''):'Source unavailable')+' → '+escape(pr.target.ref.name.replace('refs/heads/',''))+'</small></span><span class="tag">'+escape(pr.state??'open')+'</span></button>';
body+='</div>';
if(!visible.length&&!model.busy&&!model.error)body+='<div class="empty"><h2>No matching pull requests</h2><p>Try another state or search. Search covers loaded pages only.</p></div>';
if(model.more)body+=button('Load more pull requests','more',undefined,'wide');
if(selected){detail='<small>#'+escape(selected.id)+' · '+escape(selected.state??'open')+(selected.draft?' · Draft':'')+'</small><h2>'+escape(selected.title)+'</h2><div class="detail-author">'+author(selected)+'</div><p class="mono">'+escape(selected.source._tag==='Available'?selected.source.ref.name.replace('refs/heads/',''):'Unavailable')+' → '+escape(selected.target.ref.name.replace('refs/heads/',''))+'</p>'+button('Open review in new window','review',selected.id,'primary wide')+button('Open on provider','external',selected.id,'wide')+metadata(selected);}
else detail='<h2>'+escape(current.name)+'</h2><p class="muted">Choose a pull request to prepare an isolated review workspace.</p>'+button('Remove from watchlist','remove',current.id,'wide');
}
const notice=model.message?'<div class="notice '+(model.error?'error':'')+'" role="status">'+escape(model.message)+'</div>':'';
document.getElementById('app').innerHTML='<header class="header"><div><small>Duff</small><h1>'+escape(heading)+'</h1><p class="muted">'+(picker?'Remote and local repositories, in one watchlist.':'Your repositories. Your reviews.')+'</p></div>'+button(picker?'Back to dashboard':'Add repositories',picker?'dashboard':'picker')+'</header><div class="layout"><nav aria-label="'+(picker?'Repository sources':'Watched repositories')+'">'+nav+'</nav><main>'+notice+body+'</main><aside>'+detail+'</aside></div>'+(picker?'<footer class="footer"><small>Shared for this OS user on this extension host. Credentials stay with their existing authentication sources.</small><div>'+button('Cancel','dashboard')+' '+button('Add '+model.checked.length+' repositories','add',undefined,'primary')+'</div></footer>':'');
const add=document.querySelector('[data-action="add"]');if(add)add.disabled=!model.checked.length||model.busy;
for(const control of document.querySelectorAll('[data-action="review"],[data-action="more"]'))control.disabled=model.busy;
for(const position of scroll){
const element=document.querySelector('.layout>'+position.tag);
if(element){element.dataset.scrollKey=position.key;element.scrollTop=position.top;}
}
avatarObserver?.disconnect();
if(typeof IntersectionObserver!=='undefined'){
avatarObserver=new IntersectionObserver((entries)=>{for(const entry of entries){if(!entry.isIntersecting)continue;const id=entry.target.dataset.avatar;const pr=model.pulls.find((item)=>item.id===id);const key=pr?.authorAvatarKey;const request=model.repositoryId+'|'+key;if(key&&!requestedAvatars.has(request)){requestedAvatars.add(request);send('avatar',id);}avatarObserver.unobserve(entry.target);}});
for(const element of document.querySelectorAll('[data-avatar]'))avatarObserver.observe(element);
}
};
window.addEventListener('message',(event)=>{if(event.data.type==='state'){model=event.data.value;render();}});
document.addEventListener('click',(event)=>{const target=event.target.closest('[data-action]');if(target&&!target.disabled){if(['repository','source','browse','suggestion','state','picker','dashboard','add'].includes(target.dataset.action))query='';send(target.dataset.action,target.dataset.id);}});
document.addEventListener('change',(event)=>{if(event.target.dataset.select)send('toggle',event.target.dataset.select);});
document.addEventListener('error',(event)=>{if(event.target.tagName==='IMG')event.target.remove();},true);
document.addEventListener('input',(event)=>{if(event.target.id==='filter'){const caret=event.target.selectionStart;query=event.target.value;render();const input=document.getElementById('filter');input?.focus();if(input&&caret!==null)input.setSelectionRange(caret,caret);}});
send('ready');
}
</script></body></html>`
}
