import type { CSSProperties } from 'react';
import { useDemoI18n } from '../lib/demo-i18n';
import { colorbarTicks, formatScaleNumber, type DisplayStretch } from '../lib/display-scale';

export default function ScienceColorbar({min,max,stretch='linear',parameter=1,redBlue=false,constant=false,title,gradient,constantColor}:{min:number;max:number;stretch?:DisplayStretch;parameter?:number;redBlue?:boolean;constant?:boolean;title?:string;gradient?:string;constantColor?:string}){
  const {t}=useDemoI18n();
  const format=formatScaleNumber;
  const ticks=colorbarTicks(min,max,stretch,parameter).map(tick=>({...tick,label:format(tick.value)}));
  const integerWidth=Math.max(...ticks.map(tick=>tick.label.replace(/^-/, '').split('.')[0].length));
  return <div className="science-colorbar-column" style={{'--scale-integer-width':`${integerWidth}ch`,minWidth:`calc(10px + ${integerWidth+4}ch)`} as CSSProperties} aria-label={t('显示范围：{min} 至 {max}',{min:format(min),max:format(max)})} title={title}>
    <div className={`science-colorbar${redBlue?' red-blue':''}${constant?' is-constant':''}`} style={constantColor?{background:constantColor}:gradient?{background:`url("${gradient}") center / 100% 100% no-repeat`}:undefined}/>
    {ticks.map(({fraction,value,label},index)=>{
      const [integer,decimal]=label.replace(/^-/, '').split('.');
      return <div key={index} className="science-colorbar-tick" data-value={value} title={String(value)} style={{top:`${(1-fraction)*100}%`}}><i/><span className="science-scale-number" aria-label={label} style={{transform:`translateY(${fraction===1?0:fraction===0?-100:-50}%)`}}><span className="science-scale-sign" aria-hidden="true">{label.startsWith('-')?'-':''}</span><span className="science-scale-integer" aria-hidden="true">{integer}</span><span className="science-scale-dot" aria-hidden="true">.</span><span className="science-scale-decimal" aria-hidden="true">{decimal}</span></span></div>;
    })}
  </div>;
}
