import {ChevronDown} from 'lucide-react';
import {imageScaleOptions,isImageScale,type ImageScale} from '../lib/image-scale';
import {useDemoI18n} from '../lib/demo-i18n';
export default function ImageScaleControls({value,onChange,disabled=false}:{value:ImageScale;onChange:(value:ImageScale)=>void;disabled?:boolean}){
 const {t}=useDemoI18n();
 return <div className="preflight-scale-controls">
  <select aria-label={t('显示尺度')} value={value} disabled={disabled} onChange={event=>{
   const next=event.currentTarget.value;
   if(isImageScale(next))onChange(next);
  }}>
   {imageScaleOptions.map(([scale,label])=><option key={scale} value={scale}>{label}</option>)}
  </select>
  <ChevronDown size={10} aria-hidden="true"/>
 </div>;
}
