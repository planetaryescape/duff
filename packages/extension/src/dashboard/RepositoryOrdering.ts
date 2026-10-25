export const repositoryOrderingStyle = `
.repository-button{position:relative;display:flex;align-items:center;gap:8px;cursor:grab}
.repository-button:active{cursor:grabbing}.repository-grip{flex:none;opacity:0;font-size:14px;transition:opacity .1s}.repository-button:hover .repository-grip,.repository-button:focus-visible .repository-grip{opacity:.6}
.repository-button[data-drop-position="before"]{box-shadow:0 -2px var(--vscode-focusBorder)}
.repository-button[data-drop-position="after"]{box-shadow:0 2px var(--vscode-focusBorder)}
.repository-button[data-dragging]{opacity:.45}.repository-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
`

export const repositoryOrderingScript = `
let draggedRepository;
let reorderFocus;
let previousOrder;
const repositoryButton=(target)=>target instanceof Element?target.closest('[data-action="repository"]'):null;
const clearDropMarkers=()=>{for(const button of document.querySelectorAll('[data-drop-position]'))button.removeAttribute('data-drop-position');};
const moveRepository=(repositoryId,targetId,placement)=>{
if(repositoryId===targetId)return;
reorderFocus=repositoryId;
previousOrder=JSON.stringify(model.repositories.map((repository)=>repository.id));
bridge.postMessage({action:'preference',change:{_tag:'MoveRepository',repositoryId,targetId,placement}});
};
document.addEventListener('dragstart',(event)=>{
const button=repositoryButton(event.target);
if(!button||model?.mode!=='dashboard'||!event.dataTransfer)return;
draggedRepository=button.dataset.id;
event.dataTransfer.effectAllowed='move';
event.dataTransfer.setData('application/x-duff-repository',draggedRepository);
button.setAttribute('data-dragging','');
});
document.addEventListener('dragover',(event)=>{
const button=repositoryButton(event.target);
if(!draggedRepository||!button||button.dataset.id===draggedRepository)return;
event.preventDefault();
if(event.dataTransfer)event.dataTransfer.dropEffect='move';
clearDropMarkers();
const bounds=button.getBoundingClientRect();
button.dataset.dropPosition=event.clientY<bounds.top+bounds.height/2?'before':'after';
});
document.addEventListener('drop',(event)=>{
const button=repositoryButton(event.target);
if(!draggedRepository||!button)return;
event.preventDefault();
const bounds=button.getBoundingClientRect();
moveRepository(draggedRepository,button.dataset.id,event.clientY<bounds.top+bounds.height/2?'before':'after');
draggedRepository=undefined;
clearDropMarkers();
});
document.addEventListener('dragend',()=>{
draggedRepository=undefined;
clearDropMarkers();
render();
});
document.addEventListener('keydown',(event)=>{
const button=repositoryButton(event.target);
if(!button||!event.altKey||!['ArrowUp','ArrowDown'].includes(event.key))return;
event.preventDefault();
const index=model.repositories.findIndex((repository)=>repository.id===button.dataset.id);
const target=model.repositories[index+(event.key==='ArrowUp'?-1:1)];
if(target)moveRepository(button.dataset.id,target.id,event.key==='ArrowUp'?'before':'after');
});
const restoreRepositoryFocus=(focused)=>{
const reordered=reorderFocus&&previousOrder!==JSON.stringify(model.repositories.map((repository)=>repository.id));
const id=reordered?reorderFocus:focused;
if(!id)return;
const button=[...document.querySelectorAll('[data-action="repository"]')].find((button)=>button.dataset.id===id);
button?.focus({preventScroll:true});
if(!reordered)return;
button?.scrollIntoView({block:'nearest'});
const index=model.repositories.findIndex((repository)=>repository.id===reorderFocus);
const status=document.getElementById('repository-order-status');
if(status&&index>=0)status.textContent=model.repositories[index].name+', position '+(index+1)+' of '+model.repositories.length;
reorderFocus=undefined;
};
`
