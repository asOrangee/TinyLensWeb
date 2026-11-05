import { useEffect, useState } from 'react';
import type { InputScale } from './input-display';

/** One display preference drives both the input panels and position picker. */
export function usePreflightScale(mode:'live'|'demo',scope?:string) {
  const key=`tinylens-${mode}-preflight-scale-v1${scope?':'+scope:''}`;
  const [scale,setScale]=useState<InputScale>(()=>{
    try { const saved=localStorage.getItem(key);if(saved==='linear'||saved==='log'||saved==='zscale')return saved; } catch { /* Optional display preference. */ }
    return 'linear';
  });
  useEffect(()=>{try{localStorage.setItem(key,scale);}catch{/* Keep the controls usable. */}},[key,scale]);
  return [scale,setScale] as const;
}
