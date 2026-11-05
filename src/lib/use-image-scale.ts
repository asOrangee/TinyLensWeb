import {useEffect,useState} from 'react';
import type {ImageScale} from './image-scale';
export function useImageScale(mode:'live'|'demo',stage:string,scope?:string){
 const key=`tinylens-${mode}-image-scales-v1${scope?':'+scope:''}`,[settings,setSettings]=useState<Record<string,ImageScale>>(()=>{try{const saved=JSON.parse(localStorage.getItem(key)??'{}');return saved&&typeof saved==='object'&&!Array.isArray(saved)?saved:{}}catch{return {}}});
 const saved=settings[stage],scale:ImageScale=['original','linear','log','zscale'].includes(saved)?saved:'original';
 useEffect(()=>{try{localStorage.setItem(key,JSON.stringify(settings))}catch{/* Optional display preference. */}},[key,settings]);
 return [scale,(value:ImageScale)=>setSettings(previous=>({...previous,[stage]:value}))] as const;
}
