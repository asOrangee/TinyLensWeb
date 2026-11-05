export type DisplayStretch = 'linear' | 'asinh' | 'log';

/** Five evenly spaced colors, labelled with the original data values. */
export function colorbarTicks(min:number,max:number,stretch:DisplayStretch='linear',parameter=1){
  if(!Number.isFinite(min)||!Number.isFinite(max)||max<min)throw new RangeError('Invalid display interval');
  if(stretch!=='linear'&&(!Number.isFinite(parameter)||parameter<=0))throw new RangeError('Invalid display stretch');
  return Array.from({length:5},(_,index)=>{
    const fraction=index/4,range=max-min;
    const value=index===0||range===0?min:index===4?max:stretch==='asinh'?min+Math.sinh(fraction*Math.asinh(parameter*range))/parameter:stretch==='log'?min+range*Math.expm1(fraction*Math.log1p(parameter))/parameter:min+fraction*range;
    return {fraction,value};
  });
}

export const formatScaleNumber=(value:number)=>(Math.abs(value)<.005?0:value).toFixed(2);

/** Five labels within the verified printed axis, without extrapolating its range. */
export function nativeColorbarTicks(ticks:readonly {position:number;value:number}[]){
  if(ticks.length<2||ticks.some((tick,index)=>![tick.position,tick.value].every(Number.isFinite)||index>0&&(tick.position<=ticks[index-1].position||tick.value>=ticks[index-1].value)))throw new RangeError('Invalid native colorbar calibration');
  if(ticks.length===5)return ticks.map(({position,value})=>({position,value}));
  const first=ticks[0],last=ticks[ticks.length-1];
  return Array.from({length:5},(_,index)=>{
    if(index===0)return {position:first.position,value:first.value};
    if(index===4)return {position:last.position,value:last.value};
    const value=first.value+(last.value-first.value)*index/4;
    const upper=ticks.findIndex((tick,i)=>i<ticks.length-1&&value<=tick.value&&value>=ticks[i+1].value);
    const left=ticks[upper],right=ticks[upper+1],fraction=(left.value-value)/(left.value-right.value);
    return {position:left.position+(right.position-left.position)*fraction,value};
  });
}
