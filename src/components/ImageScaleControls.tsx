import {ChevronDown} from 'lucide-react';
import type {ImageScale} from '../lib/image-scale';
import {useDemoI18n} from '../lib/demo-i18n';
type SelectedScale=Exclude<ImageScale,'original'>;
export default function ImageScaleControls({value,onChange,disabled=false}:{value:ImageScale;onChange:(value:SelectedScale)=>void;disabled?:boolean}){
 const {t}=useDemoI18n();
 return <div className="preflight-scale-controls">
  <select aria-label={t('显示尺度')} value={value} disabled={disabled} onChange={event=>{
   const next=event.currentTarget.value;
   if(next==='linear'||next==='log'||next==='zscale')onChange(next);
  }}>
   {value==='original'&&<option value="original" disabled hidden>—</option>}
   {([['linear','Linear'],['log','Log'],['zscale','Z']] as const).map(([scale,label])=><option key={scale} value={scale}>{label}</option>)}
  </select>
  <ChevronDown size={10} aria-hidden="true"/>
 </div>;
}
