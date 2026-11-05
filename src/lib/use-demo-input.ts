import {useEffect,useState} from 'react';
import {demoInputRasters} from './demo-rasters';
import {renderInputDisplay} from './render-input';
let pending:ReturnType<typeof renderDemoInput>|undefined;
async function renderDemoInput(){return renderInputDisplay(await demoInputRasters());}
export function useDemoInput(enabled=true){
 const [loaded,setLoaded]=useState<Awaited<ReturnType<typeof renderDemoInput>>>();
 useEffect(()=>{if(!enabled)return;let current=true;void(pending??=renderDemoInput()).then(data=>{if(current)setLoaded(data)}).catch(()=>{});return()=>{current=false};},[enabled]);
 return enabled?loaded:undefined;
}
