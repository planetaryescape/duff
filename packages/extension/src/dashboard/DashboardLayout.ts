export const dashboardLayoutStyle = `
.layout{grid-template-columns:var(--navigation-width,240px) 5px minmax(280px,1fr) 5px var(--details-width,300px)}
.layout>nav{border-right:0;min-width:0}.layout>aside{border-left:0}
.splitter{position:relative;background:var(--vscode-widget-border,#7775);cursor:col-resize;touch-action:none;outline:none}
.splitter::after{content:'';position:absolute;inset:0 -2px;z-index:1}
.splitter:hover,.splitter:focus-visible,.splitter[data-active]{background:var(--vscode-focusBorder)}
body.resizing,body.resizing *{cursor:col-resize!important;user-select:none!important}
@media(max-width:1000px){.layout{grid-template-columns:var(--navigation-width,200px) 5px minmax(240px,1fr)}.navigation-splitter{grid-column:2;grid-row:1 / -1}.layout>main,.layout>aside{grid-column:3}.details-splitter{display:none}}
@media(max-width:560px){.splitter{display:none}.layout>main,.layout>aside{grid-column:1}}
`

export const dashboardSplitters = {
  navigation:
    '<div class="splitter navigation-splitter" role="separator" tabindex="0" aria-label="Repository list width" aria-orientation="vertical" aria-controls="dashboard-navigation" data-resize="navigation"></div>',
  details:
    '<div class="splitter details-splitter" role="separator" tabindex="0" aria-label="Pull request details width" aria-orientation="vertical" aria-controls="dashboard-details" data-resize="details"></div>',
}

export const dashboardLayoutScript = `
const savedLayout=bridge.getState?.();
const validWidth=(value)=>typeof value==='number'&&Number.isFinite(value)&&value>0;
const widths={
navigation:validWidth(savedLayout?.columnWidths?.navigation)?savedLayout.columnWidths.navigation:undefined,
details:validWidth(savedLayout?.columnWidths?.details)?savedLayout.columnWidths.details:undefined,
};
let resizing;
const layoutBounds=(side,layout)=>{
const wide=window.innerWidth>1000;
const navigation=Number(layout.querySelector('[data-resize="navigation"]')?.getAttribute('aria-valuenow'))||(wide?240:200);
const details=Number(layout.querySelector('[data-resize="details"]')?.getAttribute('aria-valuenow'))||300;
const minimum=side==='navigation'?160:240;
const other=side==='navigation'?details:navigation;
return {minimum,maximum:Math.max(minimum,layout.clientWidth-(wide?290+other:245))};
};
const applyLayout=()=>{
const layout=document.querySelector('.layout');
if(!layout||window.innerWidth<=560)return;
const wide=window.innerWidth>1000;
const navigation=Math.max(160,Math.min(widths.navigation??(wide?240:200),Math.max(160,layout.clientWidth-(wide?530:245))));
const details=Math.max(240,Math.min(widths.details??300,Math.max(240,layout.clientWidth-navigation-290)));
layout.style.setProperty('--navigation-width',navigation+'px');
layout.style.setProperty('--details-width',details+'px');
for(const side of ['navigation','details']){
const handle=layout.querySelector('[data-resize="'+side+'"]');
if(!handle)continue;
const minimum=side==='navigation'?160:240;
const maximum=Math.max(minimum,layout.clientWidth-(wide?290+(side==='navigation'?details:navigation):245));
handle.setAttribute('aria-valuemin',minimum);
handle.setAttribute('aria-valuemax',maximum);
handle.setAttribute('aria-valuenow',Math.round(side==='navigation'?navigation:details));
}
};
const saveLayout=()=>{
const columnWidths={};
for(const side of ['navigation','details'])if(validWidth(widths[side]))columnWidths[side]=widths[side];
bridge.setState?.({...bridge.getState?.(),columnWidths});
bridge.postMessage({action:'preference',change:{_tag:'ResizeColumns',columnWidths}});
};
const resizeColumn=(side,value)=>{
const layout=document.querySelector('.layout');
if(!layout||window.innerWidth<=560||(side==='details'&&window.innerWidth<=1000))return;
const {minimum,maximum}=layoutBounds(side,layout);
widths[side]=Math.min(maximum,Math.max(minimum,value));
applyLayout();
};
const finishResize=(event)=>{
if(!resizing||event.pointerId!==resizing.pointerId)return;
const pointerId=resizing.pointerId;
resizing=undefined;
document.body.classList.remove('resizing');
for(const handle of document.querySelectorAll('[data-resize]'))handle.removeAttribute('data-active');
if(document.documentElement.hasPointerCapture(pointerId))document.documentElement.releasePointerCapture(pointerId);
saveLayout();
};
document.addEventListener('pointerdown',(event)=>{
const handle=event.target.closest('[data-resize]');
if(!handle||event.button!==0||resizing)return;
event.preventDefault();
const side=handle.dataset.resize;
resizing={side,pointerId:event.pointerId,start:event.clientX,width:Number(handle.getAttribute('aria-valuenow'))};
document.documentElement.setPointerCapture(event.pointerId);
document.body.classList.add('resizing');
handle.setAttribute('data-active','');
});
document.addEventListener('pointermove',(event)=>{
if(!resizing||event.pointerId!==resizing.pointerId)return;
resizeColumn(resizing.side,resizing.width+(event.clientX-resizing.start)*(resizing.side==='details'?-1:1));
});
document.addEventListener('pointerup',finishResize);
document.addEventListener('pointercancel',finishResize);
document.addEventListener('lostpointercapture',finishResize);
document.addEventListener('keydown',(event)=>{
const handle=event.target.closest('[data-resize]');
if(!handle||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
const layout=document.querySelector('.layout');
if(!layout)return;
event.preventDefault();
const side=handle.dataset.resize;
const {minimum,maximum}=layoutBounds(side,layout);
const direction=(event.key==='ArrowRight'?1:-1)*(side==='details'?-1:1);
const value=event.key==='Home'?minimum:event.key==='End'?maximum:Number(handle.getAttribute('aria-valuenow'))+direction*(event.shiftKey?48:16);
resizeColumn(side,value);
saveLayout();
});
window.addEventListener('resize',applyLayout);
`
