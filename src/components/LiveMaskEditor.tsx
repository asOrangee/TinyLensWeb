import {useMemo,useState} from 'react';
import {createPortal} from 'react-dom';
import {ChevronDown} from 'lucide-react';
import type {AgentUpdate} from '../lib/agent-types';
import type {LiveResult} from '../lib/live-results';
import type {ImageScale} from '../lib/image-scale';
import {useScaledPlanes} from '../lib/use-scaled-planes';
import {encodeMaskDraft,maskDraftKey,maskPrompt,parseMaskSource,restoreMaskDraft} from '../lib/mask-user-input';
import ImageScaleControls from './ImageScaleControls';
import MaskEditor from './MaskEditor';
import {useDemoI18n} from '../lib/demo-i18n';
type Source=ReturnType<typeof parseMaskSource>;
type Background='observation'|'source-lensed';
type Props={source?:Source;report?:AgentUpdate;threadId:string;summary:LiveResult|undefined;toolbarTarget:HTMLDivElement|null;scale:ImageScale;onScaleChange:(scale:ImageScale)=>void;onPromptChange:(next:string)=>void;disabled:boolean};
function DraftEditor({source,report,threadId,scale,onPromptChange,disabled,toolbarTarget,background}:Props&{source:Source;report:AgentUpdate;background:Background}){
 const reportId=report.display_source_report_id??report.id!;
 const key=maskDraftKey(source,threadId,reportId),[pixels,setPixels]=useState(()=>{try{return restoreMaskDraft(localStorage.getItem(key),source)}catch{return source.pixels}});
 const scaled=useScaledPlanes({observation:source.plane,'source-lensed':source.lensed_source_plane},scale,true,['observation','source-lensed'],{showFitExcluded:true});
 const backgroundSrc=scaled.planes?.[background]?.src??'';
 const geometry=useMemo(()=>({height:source.shape[0],width:source.shape[1],domain:source.domain,backgroundSrc,pixelScale:source.pixel_scale_arcsec,initialPixels:source.pixels,radius:source.modeling_radius_arcsec}),[source,backgroundSrc]);
 function change(next:number[]){setPixels(next);try{localStorage.setItem(key,encodeMaskDraft(next));}catch{/* Keep the current draft when storage is unavailable. */}onPromptChange(maskPrompt(next,source,threadId,reportId));}
 return <MaskEditor value={pixels} onChange={change} initialValue={source.pixels} geometry={geometry} disabled={disabled||!backgroundSrc} backgroundLabel={background==='source-lensed'?'Lensed source':undefined} toolbarTarget={toolbarTarget}/>;
}
export default function LiveMaskEditor(props:Props){
 const {report,threadId,source,summary,toolbarTarget,scale,onScaleChange}=props;
 const {t}=useDemoI18n();
 const [layer,setLayer]=useState<Background>('observation');
 const background=source?.lensed_source_plane?layer:'observation';
 const metrics=summary?.result?.metrics,statistics=typeof metrics?.included_arc_pixels==='number'&&typeof metrics?.masked_pixels==='number'?{included:metrics.included_arc_pixels,excluded:metrics.masked_pixels}:undefined;
 return <>
  {toolbarTarget&&createPortal(<div className="science-toolbar" role="toolbar" aria-label={t('图像显示工具')}>
    {source?.lensed_source_plane&&<div className="preflight-scale-controls">
      <select aria-label={t('图像图层')} value={background} onChange={event=>setLayer(event.currentTarget.value==='source-lensed'?'source-lensed':'observation')}>
        <option value="observation">{t('观测图像')}</option>
        <option value="source-lensed">Lensed source</option>
      </select><ChevronDown size={10} aria-hidden="true"/>
    </div>}
    <ImageScaleControls value={scale} onChange={onScaleChange} disabled={!source}/>
  </div>,toolbarTarget)}
  {source&&report?<DraftEditor key={maskDraftKey(source,threadId,report.display_source_report_id??report.id!)} {...props} source={source} report={report} background={background}/>
    :<MaskEditor value={[]} onChange={()=>{}} statistics={statistics} unavailable="—" toolbarTarget={toolbarTarget}/>}
 </>;
}
