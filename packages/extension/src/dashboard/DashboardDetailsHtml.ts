export const dashboardDetailsScript = `
const retained=(resource)=>['Current','Refreshing','Stale'].includes(resource?._tag)?resource.value:undefined;
const resourceStatus=(resource,label,id)=>{
if(resource?._tag==='Refreshing')return '<p class="muted" role="status">Refreshing '+label+'…</p>';
if(resource?._tag==='Stale')return '<p class="muted" role="status">Stale '+label+'. '+escape(resource.reason)+' '+button('Retry','details',id)+'</p>';
if(resource?._tag==='Unavailable')return '<p class="muted" role="status">'+escape(resource.reason)+' '+button('Retry','details',id)+'</p>';
return '';
};
const metadata=(pr)=>{
const resource=model.details;
const details=retained(resource);
const statistics=model.statistics;
const comparison=retained(statistics);
const supplied=details?.metadata;
const pinned=supplied?.pullRequest.id===pr.id&&supplied.pullRequest.source._tag==='Available'&&supplied.pullRequest.source.ref.revision._tag==='Some'&&supplied.pullRequest.target.ref.revision._tag==='Some';
const fallback=pinned&&(supplied.filesChanged._tag==='Some'||supplied.linesChanged._tag==='Some')?{files:supplied.filesChanged._tag==='Some'?supplied.filesChanged.value:undefined,lines:supplied.linesChanged._tag==='Some'?supplied.linesChanged.value:undefined,reason:'Line totals unavailable in the metadata response.'}:undefined;
const summary=comparison??fallback;
const files=summary?.files;
const lines=summary?.lines;
const counts='<dl class="change-stats" aria-label="Change summary"><div><dt>Files changed</dt><dd>'+escape(files??'–')+'</dd></div><div><dt>Lines added</dt><dd class="'+(lines?'added':'muted')+'">'+(lines?'+'+escape(lines.additions):'–')+'</dd></div><div><dt>Lines deleted</dt><dd class="'+(lines?'deleted':'muted')+'">'+(lines?'−'+escape(lines.deletions):'–')+'</dd></div></dl>';
const statisticsStatus=resourceStatus(statistics,'change statistics',pr.id)+(statistics?._tag==='Loading'?'<p class="muted" role="status">Loading change statistics…</p>':summary&&!lines?'<p class="muted">'+escape(summary.reason)+'</p>':'')+(summary&&files===undefined?'<small>File count unavailable.</small>':'');
const description=details&&details.metadata.pullRequest.id===pr.id?'<h3>Description</h3><div class="description">'+details.descriptionHtml+'</div>':resource?._tag==='Unavailable'?'':'<p class="muted detail-status" role="status">Loading PR details…</p>';
return counts+(!comparison&&fallback?'<small>Provider-reported counts from this PR metadata snapshot.</small>':'')+statisticsStatus+resourceStatus(resource,'PR details',pr.id)+description;
};
`
