import {useMemo,useState} from 'react';
import {createPortal} from 'react-dom';
import type {AgentUpdate} from '../lib/agent-types';
import type {LiveResult} from '../lib/live-results';
import type {ImageScale} from '../lib/image-scale';
import {useScaledPlanes} from '../lib/use-scaled-planes';
import {encodeMaskDraft,maskDraftKey,maskPrompt,parseMaskSource,restoreMaskDraft} from '../lib/mask-user-input';
import ImageScaleControls from './ImageScaleControls';
import MaskEditor from './MaskEditor';
type Source=ReturnType<typeof parseMaskSource>;
type Props={source?:Source;report?:AgentUpdate;threadId:string;summary:LiveResult|undefined;toolbarTarget:HTMLDivElement|null;scale:ImageScale;onScaleChange:(scale:ImageScale)=>void;onPromptChange:(next:string)=>void;disabled:boolean};
function DraftEditor({source,report,threadId,scale,onPromptChange,disabled,toolbarTarget}:Props&{source:Source;report:AgentUpdate}){
 const key=maskDraftKey(source,threadId,report.id!),[pixels,setPixels]=useState(()=>{try{return restoreMaskDraft(localStorage.getItem(key),source)}catch{return source.pixels}});
 const scaled=useScaledPlanes({observation:source.plane},scale,true,['observation']);
 const geometry=useMemo(()=>({size:source.shape[0],domain:source.domain,backgroundSrc:scaled.planes?.observation?.src??'',halfExtent:source.plane.half_extent_arcsec,initialPixels:source.pixels,radius:source.modeling_radius_arcsec}),[source,scaled.planes?.observation?.src]);
 function change(next:number[]){setPixels(next);try{localStorage.setItem(key,encodeMaskDraft(next));}catch{/* Keep the current draft when storage is unavailable. */}onPromptChange(maskPrompt(next,source,threadId,report.id!));}
 return <MaskEditor value={pixels} onChange={change} initialValue={source.pixels} geometry={geometry} disabled={disabled||!scaled.planes?.observation?.src} toolbarTarget={toolbarTarget}/>;
}
export default function LiveMaskEditor(props:Props){
 const {report,threadId,source,summary,toolbarTarget,scale,onScaleChange}=props;
 const metrics=summary?.result?.metrics,statistics=typeof metrics?.included_arc_pixels==='number'&&typeof metrics?.masked_pixels==='number'?{included:metrics.included_arc_pixels,excluded:metrics.masked_pixels}:undefined;
 return <>{toolbarTarget&&createPortal(<div className="science-toolbar" role="toolbar" aria-label="图像显示工具"><ImageScaleControls value={scale} onChange={onScaleChange} disabled={!source}/></div>,toolbarTarget)}{source&&report?<DraftEditor key={maskDraftKey(source,threadId,report.id!)} {...props} source={source} report={report}/>:<MaskEditor value={[]} onChange={()=>{}} statistics={statistics} unavailable="—" toolbarTarget={toolbarTarget}/>}</>;
}
