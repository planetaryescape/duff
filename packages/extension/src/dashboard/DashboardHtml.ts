import { dashboardDetailsScript } from './DashboardDetailsHtml'
import { dashboardLayoutScript, dashboardLayoutStyle, dashboardSplitters } from './DashboardLayout'
import { descriptionMarkdownStyle } from './DescriptionMarkdownStyle'
import { repositoryOrderingScript, repositoryOrderingStyle } from './RepositoryOrdering'

/** A local-only webview with escaped labels and host-rendered, inert description Markdown. */
export function dashboardHtml(nonce: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<title>Duff dashboard</title><style nonce="${nonce}">
*{box-sizing:border-box}body{margin:0;color:var(--vscode-foreground);background:var(--vscode-editor-background);font:13px var(--vscode-font-family);line-height:1.5}button,input{font:inherit}button{cursor:pointer;color:inherit;background:transparent;border:1px solid var(--vscode-widget-border, #7775);border-radius:2px;padding:7px 12px}button:hover{background:var(--vscode-list-hoverBackground)}button:disabled{cursor:default;opacity:.5}button:focus-visible,input:focus-visible{outline:2px solid var(--vscode-focusBorder);outline-offset:2px}.primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border-color:transparent}.primary:hover{background:var(--vscode-button-hoverBackground)}.quiet{border-color:transparent}.muted,small{color:var(--vscode-descriptionForeground)}small{font-size:12px}.header{display:flex;align-items:center;justify-content:space-between;min-height:40px;padding:4px 16px;border-bottom:1px solid var(--vscode-widget-border, #7775);gap:16px}h1{font-size:13px;font-weight:600;margin:0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}h2{font-size:17px;font-weight:500;margin:0 0 8px}h3{font-size:13px;font-weight:500;margin:24px 0 8px}.layout{display:grid;grid-template-columns:240px minmax(280px,1fr) 300px;min-height:calc(100vh - 94px)}nav{padding:12px 8px;border-right:1px solid var(--vscode-widget-border,#7775)}nav h3{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:var(--vscode-descriptionForeground);margin:16px 8px 6px}nav h3:first-child{margin-top:0}nav button{display:block;text-align:left;width:100%;border:0;border-radius:0;margin:1px 0;padding:4px 8px;overflow-wrap:anywhere}nav button[aria-current="true"],.selected{background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground)}main{padding:12px 16px;min-width:0}aside{border-left:1px solid var(--vscode-widget-border,#7775);padding:16px;min-width:0;overflow-wrap:anywhere}aside p{margin:8px 0 14px}aside h2{font-size:15px;font-weight:600;line-height:1.35;margin:4px 0 8px}.actions{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0 0}.actions button{flex:1 1 auto}.toolbar{display:flex;align-items:center;gap:8px;margin:0 0 12px;flex-wrap:wrap}.icon{padding:4px 8px;border-color:transparent;font-size:15px;line-height:1}.toolbar input{flex:1;min-width:180px}input[type="search"],input[type="text"]{color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border, #7775);border-radius:2px;padding:5px 8px;width:100%}.tabs{display:flex;gap:2px}.tabs button{border:0;border-bottom:2px solid transparent;border-radius:0;padding:5px 10px;color:var(--vscode-descriptionForeground)}.tabs button:hover{background:transparent;color:var(--vscode-foreground)}.tabs button[aria-pressed="true"]{border-bottom-color:var(--vscode-focusBorder);color:var(--vscode-foreground)}.rows{border-top:1px solid var(--vscode-widget-border,#7775)}.row{display:flex;align-items:flex-start;gap:12px;padding:16px 8px;border:0;border-bottom:1px solid var(--vscode-widget-border,#7775);border-radius:0;width:100%;text-align:left;overflow-wrap:anywhere}.row .copy{flex:1;min-width:0}.row small{display:block;margin-top:4px}.row input{margin:4px 0 0;accent-color:var(--vscode-focusBorder)}.tag{font-size:11px;border:1px solid var(--vscode-widget-border,#7775);border-radius:2px;padding:2px 6px;white-space:nowrap}.empty{padding:48px 12px;max-width:580px}.empty h2{font-size:22px}.empty p{color:var(--vscode-descriptionForeground);margin-bottom:24px}.notice{margin:12px 0;padding:10px 0;color:var(--vscode-descriptionForeground);white-space:pre-wrap}.error{color:var(--vscode-errorForeground)}.selections{margin-top:16px}.selections:not(:empty){border-top:1px solid var(--vscode-widget-border,#7775)}.selection{display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid var(--vscode-widget-border,#7775)}.selection .copy{display:flex;flex-direction:column;min-width:0}.wide{width:100%;margin-top:12px}.mono{font-family:var(--vscode-editor-font-family);font-size:12px}.nowrap{white-space:nowrap}.hint{padding-top:16px;border-top:1px solid var(--vscode-widget-border,#7775);margin-top:24px}a{color:var(--vscode-textLink-foreground)}@media(max-width:1000px){.layout{grid-template-columns:200px minmax(240px,1fr)}aside{grid-column:2;border-left:0;border-top:1px solid var(--vscode-widget-border,#7775)}}@media(max-width:560px){.layout{display:block}nav{border-right:0;border-bottom:1px solid var(--vscode-widget-border,#7775);padding:12px}main,aside{padding:16px}.header{padding:4px 12px}.tag{white-space:normal}}
#app{height:100vh;display:flex;flex-direction:column}#app>.layout{flex:1;min-height:0;grid-template-rows:minmax(0,1fr)}body{overflow:hidden}.header{flex-shrink:0}.layout>nav,.layout>main,.layout>aside{min-height:0;overflow-y:auto;overscroll-behavior:contain}
@media(max-width:1000px){#app>.layout{grid-template-rows:repeat(2,minmax(0,1fr))}.layout>nav{grid-row:1 / -1}}
@media(max-width:560px){#app>.layout{display:grid;grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(0,.5fr) minmax(0,1fr) minmax(0,1.5fr)}.layout>nav{grid-row:auto}.layout>aside{grid-column:1}}
.avatar{position:relative;display:inline-grid;place-items:center;flex:none;width:28px;height:28px;border-radius:50%;background:var(--vscode-badge-background,#555);color:var(--vscode-badge-foreground,#fff);font-size:11px;overflow:hidden}.avatar img{position:absolute;width:100%;height:100%;object-fit:cover}.change-stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin:20px 0 8px;padding:12px 0;border-top:1px solid var(--vscode-widget-border,#7775);border-bottom:1px solid var(--vscode-widget-border,#7775)}.change-stats div{display:flex;flex-direction:column-reverse}.change-stats dt{font-size:11px;color:var(--vscode-descriptionForeground)}.change-stats dd{margin:0;font-size:20px;font-variant-numeric:tabular-nums}.added{color:var(--vscode-gitDecoration-addedResourceForeground,#81b88b)}.deleted{color:var(--vscode-gitDecoration-deletedResourceForeground,#c74e39)}.description{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.6;margin:8px 0 24px}.detail-status{padding:16px 0}.detail-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;color:var(--vscode-descriptionForeground)}.detail-meta .mono{overflow-wrap:anywhere}
.pull-row{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:2px 8px;padding:7px 10px;overflow-wrap:normal}.pull-row:not(.selected):hover{background:var(--vscode-list-hoverBackground)}.pull-row.selected{box-shadow:inset 2px 0 var(--vscode-focusBorder)}.pull-title,.pull-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.pull-meta{grid-column:1 / -1;display:flex;align-items:center;gap:6px;min-width:0;font-size:12px;color:var(--vscode-descriptionForeground)}.pull-row.selected .pull-meta{color:inherit;opacity:.8}.pull-meta .avatar{width:16px;height:16px;font-size:8px}
.nav-item{display:flex;align-items:center;gap:8px}.nav-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.nav-hint{display:block;padding:6px 8px 0}
.pick-row{align-items:center;gap:10px;padding:7px 10px;cursor:pointer}.pick-row:hover{background:var(--vscode-list-hoverBackground)}.pick-row input{margin:0}.pick-row .copy{display:flex;flex-direction:column}.pick-meta{font-size:12px;color:var(--vscode-descriptionForeground)}.pick-row.watched{cursor:default;opacity:.6}.pick-row.watched:hover{background:transparent}
${dashboardLayoutStyle}
${descriptionMarkdownStyle}
${repositoryOrderingStyle}
</style></head><body><div id="app"></div><script nonce="${nonce}">
{
const bridge=acquireVsCodeApi();
${dashboardLayoutScript}
let model;
let query='';
let avatarObserver;
let queryScope;
${repositoryOrderingScript}
const requestedAvatars=new Set();
const escape=(value)=>String(value??'').replace(/[&<>"']/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const hosted=(repo)=>repo.hosting._tag==='Some'?repo.hosting.value:undefined;
const label=(repo)=>Object.hasOwn(model.labels??{},repo.id)?model.labels[repo.id]:undefined;
const displayName=(repo)=>label(repo)??repo.name;
const repositoryContext=(repo)=>escape(JSON.stringify({webviewSection:'repository',repositoryId:repo.id,preventDefaultContextMenuItems:true}));
const repositoryName=(name)=>{const slash=name.lastIndexOf('/');return slash<0?escape(name):'<span class="muted">'+escape(name.slice(0,slash+1))+'</span>'+escape(name.slice(slash+1));};
const svg=(path)=>'<svg class="repository-icon" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round">'+path+'</svg>';
const repositoryIcon=svg('<path d="M3.5 12.5V3a1 1 0 0 1 1-1h8v9.5h-8a1 1 0 0 0-1 1 1 1 0 0 0 1 1h1.5M9 13.5h3.5v-2"/><path d="M6 4.5h4"/>');
const folderIcon=svg('<path d="M1.5 4a1 1 0 0 1 1-1h3.75l1.5 1.5h5.75a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z"/>');
const brand=(id,path)=>'<svg class="repository-icon provider-icon provider-'+id+'" viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="'+path+'"/></svg>';
const providerIcons={
github:brand('github','M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12'),
'azure-devops':brand('azure-devops','M0 8.877L2.247 5.91l8.405-3.416V.022l7.37 5.393L2.966 8.338v8.225L0 15.707zm24-4.45v14.651l-5.753 4.9-9.303-3.057v3.056l-5.978-7.416 15.057 1.798V5.415z'),
};
const providerIcon=(id)=>Object.hasOwn(providerIcons,id)?providerIcons[id]:repositoryIcon;
const navItem=(icon,label,action,id,current)=>'<button class="nav-item" data-action="'+action+'" data-id="'+escape(id)+'" aria-current="'+current+'" title="'+escape(label)+'"><span class="repository-lead" aria-hidden="true">'+icon+'</span><span class="nav-label">'+escape(label)+'</span></button>';
const send=(action,id)=>bridge.postMessage({action,id});
const button=(label,action,id,kind='')=>'<button class="'+kind+'" data-action="'+action+'"'+(id!==undefined?' data-id="'+escape(id)+'"':'')+'>'+escape(label)+'</button>';
const authorName=(pr)=>pr.author??'Unknown author';
const avatar=(pr)=>{
const name=authorName(pr);
const initials=name.split(/\\s+/).filter(Boolean).slice(0,2).map((part)=>Array.from(part)[0]).join('').toUpperCase();
const key=pr.authorAvatarKey;
const image=key&&Object.hasOwn(model.avatars??{},key)?model.avatars[key]:undefined;
const safe=typeof image==='string'&&/^data:image\\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+=*$/.test(image);
return '<span class="avatar" aria-hidden="true" title="Opened by '+escape(name)+'" data-avatar="'+escape(pr.id)+'">'+escape(initials)+(safe?'<img alt="" src="'+escape(image)+'">':'')+'</span>';
};
const branch=(ref)=>ref.name.replace('refs/heads/','');
${dashboardDetailsScript}
const render=()=>{
if(!model||draggedRepository)return;
const focusedRepository=document.activeElement?.dataset?.action==='repository'?document.activeElement.dataset.id:undefined;
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
const heading=picker?'Add repositories':(current?displayName(current):'Your repositories');
let nav='<h3>'+(picker?'Sources':'Repositories')+'</h3>';
if(picker){
nav+=navItem(folderIcon,'Local repositories','source','local',model.sourceId==='local')+'<h3>Remote repositories</h3>';
for(const provider of model.providers)nav+=navItem(providerIcon(provider.id),provider.displayName,'browse',provider.id,model.sources.some((source)=>source.id===model.sourceId&&source.providerId===provider.id));
if(model.sources.length){nav+='<h3>Collections</h3>';for(const source of model.sources)nav+=navItem(providerIcon(source.providerId),source.label,'suggestion',source.id,source.id===model.sourceId);nav+='<small class="nav-hint">Suggested from your Git remotes and browsing.</small>';}
}else{
nav+='<p class="sr-only" id="repository-order-help">Drag to reorder repositories, or focus a repository and press Alt plus Up or Down. Press F2 to rename.</p><div class="sr-only" id="repository-order-status" role="status" aria-live="polite"></div>';
for(const repo of model.repositories)nav+='<button class="repository-button" draggable="true" data-action="repository" data-id="'+escape(repo.id)+'" aria-describedby="repository-order-help" aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown F2" aria-current="'+(repo.id===model.repositoryId)+'" data-vscode-context="'+repositoryContext(repo)+'"><span class="repository-lead" aria-hidden="true">'+(hosted(repo)?providerIcon(hosted(repo).provider.id):folderIcon)+'<span class="repository-grip">⠿</span></span><span class="repository-label" title="'+escape(label(repo)?label(repo)+' ('+repo.name+')':repo.name)+'">'+(label(repo)?escape(label(repo)):repositoryName(repo.name))+(hosted(repo)?'':' <small>Local only</small>')+'</span></button>';
nav+=button('+ Add repositories','picker',undefined,'wide');
}
let body='';let detail='';
if(picker){
const sourceName=model.sourceId==='local'?'local repositories':model.sourceLabel;
body='<div class="toolbar"><input id="filter" type="search" aria-label="Filter repositories" placeholder="Filter '+escape(sourceName)+'…" value="'+escape(query)+'">'+button('Choose folders…','folders',undefined,'quiet')+button('Add by URL…','url',undefined,'quiet')+'</div><div class="rows">';
const visible=model.candidates.filter((repo)=>(repo.name+' '+repo.localPaths.join(' ')).toLowerCase().includes(query.toLowerCase()));
for(const repo of visible){const h=hosted(repo);const watched=model.repositories.some((item)=>item.id===repo.id&&repo.localPaths.every((path)=>item.localPaths.includes(path)));body+='<label class="row pick-row'+(watched?' watched':'')+'"><input type="checkbox" data-select="'+escape(repo.id)+'" '+(model.checked.includes(repo.id)?'checked ':'')+(watched?'disabled ':'')+'><span class="repository-lead" aria-hidden="true">'+(h?providerIcon(h.provider.id):folderIcon)+'</span><span class="copy"><span class="pull-title">'+repositoryName(repo.name)+'</span><span class="pull-text pick-meta">'+escape(repo.localPaths.join(', ')||h?.repository.authority||'Local repository')+'</span></span>'+(watched?'<small class="nowrap">Watching</small>':'')+'</label>';}
body+='</div>';
if(!visible.length&&!model.busy)body+='<div class="empty"><h2>'+(model.sourceId==='local'?'Choose a folder to begin':'No repositories on this page')+'</h2><p>'+(model.sourceId==='local'?'Choose folders containing your repositories. Parent folders are inspected one level deep, not your whole disk.':'Try another collection, check access, or continue to the next page.')+'</p></div>';
if(model.more)body+=button('Load more repositories','more',undefined,'wide');
detail='<h2>'+model.checked.length+' selected</h2><div class="actions">'+button('Add '+model.checked.length+' repositories','add',undefined,'primary')+button('Cancel','dashboard')+'</div><div class="selections">';
for(const id of model.checked){const repo=model.selections.find((item)=>item.id===id);if(repo)detail+='<div class="selection"><span class="repository-lead" aria-hidden="true">'+(hosted(repo)?providerIcon(hosted(repo).provider.id):folderIcon)+'</span><span class="copy"><span class="pull-title">'+repositoryName(repo.name)+'</span><span class="pick-meta">'+(hosted(repo)?'Watch pull requests'+(repo.localPaths.length?' and link local files':''):'Local branch comparison')+'</span></span></div>';}
detail+='</div><p class="hint muted">Selections stay when you switch sources. Provider access is only requested when you browse that source. Your watchlist is shared for this OS user.</p>';
}else if(!current){
body='<div class="empty"><h2>What would you like to review?</h2><p>Watch repositories across providers, or add local projects for branch comparison. Your watchlist is shared across local VS Code and VSCodium installations.</p>'+button('Add repositories','picker',undefined,'primary')+'</div>';
detail='<h2>Your review workspace</h2><p class="muted">Open a PR in its own window with a complete copy of its HEAD. Browse files, use language tooling, and keep your edits.</p><p class="hint muted">Duff never installs dependencies or runs project setup. Editor trust and language tooling still apply.</p>';
}else if(!hosted(current)){
body='<div class="empty"><h2>Local branch comparison</h2><p>This repository has no supported hosting remote. Open its folder to compare local branches. No provider connection is required.</p>'+button('Open local repository','local',current.id,'primary')+'</div>';
detail='<h2>'+escape(displayName(current))+'</h2><p class="mono">'+escape(current.localPaths.join(', '))+'</p><div class="actions">'+button('Rename…','rename',current.id)+button('Remove from watchlist','remove',current.id)+'</div>';
}else{
body='<div class="toolbar"><div class="tabs" role="group" aria-label="Pull request state">';
for(const state of ['open','merged','closed'])body+='<button data-action="state" data-id="'+state+'" aria-pressed="'+(model.filter===state)+'">'+state[0].toUpperCase()+state.slice(1)+'</button>';
body+='</div><input id="filter" type="search" aria-label="Filter pull requests" placeholder="Filter loaded PRs by title or number…" value="'+escape(query)+'"><button class="icon" data-action="refresh" aria-label="Refresh" title="Refresh">↻</button>'+button('Connect','connect',undefined,'quiet')+'</div>'+(model.filter==='closed'?'<p class="muted">Closed without merging</p>':'')+'<div class="rows">';
const visible=model.pulls.filter((pr)=>(pr.title+' #'+pr.id).toLowerCase().includes(query.toLowerCase()));
for(const pr of visible)body+='<button class="row pull-row '+(pr.id===model.pullRequestId?'selected':'')+'" data-action="pull" data-id="'+escape(pr.id)+'" title="'+escape(pr.title)+'"><span class="pull-title"><span class="muted">#'+escape(pr.id)+'</span> '+escape(pr.title)+'</span>'+(pr.draft?'<span class="tag">Draft</span>':'')+'<span class="pull-meta">'+avatar(pr)+'<span class="pull-text">'+escape(authorName(pr))+' · '+escape(pr.source._tag==='Available'?branch(pr.source.ref):'Source unavailable')+' → '+escape(branch(pr.target.ref))+'</span></span></button>';
body+='</div>';
if(!visible.length&&!model.busy&&!model.error)body+='<div class="empty"><h2>No matching pull requests</h2><p>Try another state or search. Search covers loaded pages only.</p></div>';
if(model.more)body+=button('Load more pull requests','more',undefined,'wide');
if(selected){detail='<small>#'+escape(selected.id)+' · '+escape(selected.state??'open')+(selected.draft?' · Draft':'')+'</small><h2>'+escape(selected.title)+'</h2><div class="detail-meta">'+avatar(selected)+'<span class="mono">'+escape(selected.source._tag==='Available'?branch(selected.source.ref):'Unavailable')+' → '+escape(branch(selected.target.ref))+'</span></div><div class="actions">'+button('Review in new window','review',selected.id,'primary')+button('Open on provider','external',selected.id)+'</div>'+metadata(selected);}
else detail='<h2>'+escape(displayName(current))+'</h2>'+(label(current)?'<p class="mono muted">'+escape(current.name)+'</p>':'')+'<p class="muted">Choose a pull request to prepare an isolated review workspace.</p><div class="actions">'+button('Rename…','rename',current.id)+button('Remove from watchlist','remove',current.id)+'</div>';
}
const notice=model.message?'<div class="notice '+(model.error?'error':'')+'" role="status">'+escape(model.message)+'</div>':'';
document.getElementById('app').innerHTML='<header class="header"><h1><span class="muted">Duff /</span> '+escape(heading)+'</h1>'+(picker?button('Back to dashboard','dashboard',undefined,'quiet'):'')+'</header><div class="layout"><nav id="dashboard-navigation" aria-label="'+(picker?'Repository sources':'Watched repositories')+'">'+nav+'</nav>${dashboardSplitters.navigation}<main>'+notice+body+'</main>${dashboardSplitters.details}<aside id="dashboard-details">'+detail+'</aside></div>';
applyLayout();
restoreRepositoryFocus(focusedRepository);
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
window.addEventListener('message',(event)=>{if(event.data.type==='state'){
if(!model){widths.navigation=event.data.value.columnWidths?.navigation;widths.details=event.data.value.columnWidths?.details;bridge.setState?.({...bridge.getState?.(),initialized:true});}
model=event.data.value;
const scope=JSON.stringify([model.mode,model.repositoryId,model.filter]);
if(scope!==queryScope){query=model.mode==='dashboard'?(model.query??''):'';queryScope=scope;}
render();
}});
document.addEventListener('click',(event)=>{const target=event.target.closest('[data-action]');if(target&&!target.disabled){if(['source','browse','suggestion','state','picker','dashboard','add'].includes(target.dataset.action)||(target.dataset.action==='repository'&&target.dataset.id!==model.repositoryId))query='';send(target.dataset.action,target.dataset.id);}});
document.addEventListener('change',(event)=>{if(event.target.dataset.select)send('toggle',event.target.dataset.select);});
document.addEventListener('error',(event)=>{if(event.target.tagName==='IMG')event.target.remove();},true);
document.addEventListener('input',(event)=>{if(event.target.id==='filter'){const caret=event.target.selectionStart;query=event.target.value.slice(0,1000);if(model.mode==='dashboard'&&model.repositoryId)bridge.postMessage({action:'preference',change:{_tag:'SetQuery',repositoryId:model.repositoryId,query}});render();const input=document.getElementById('filter');input?.focus();if(input&&caret!==null)input.setSelectionRange(caret,caret);}});
send('ready');
}
</script></body></html>`
}
