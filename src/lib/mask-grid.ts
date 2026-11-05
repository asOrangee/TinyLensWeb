/** Included-pixel drafts on the original grid; never resample a scientific mask. */
export function maskGrid(size:number,domain?:readonly number[]){
  if(!Number.isInteger(size)||size<1||size>512||domain&&(domain.length!==size*size||domain.some(p=>p!==0&&p!==1)))throw Error('Invalid mask geometry');
  const count=size*size;
  const inDomain=(x:number,y:number)=>x>=0&&y>=0&&x<size&&y<size&&(domain?domain[y*size+x]===1:Math.hypot(x+.5-size/2,y+.5-size/2)<size/2);
  const domainPixels=Array.from({length:count},(_,i)=>Number(inDomain(i%size,Math.floor(i/size))));
  const cleanMask=(input:readonly number[])=>domainPixels.map((valid,i)=>Number(valid&&input[i]>0));
  function translated(mask:readonly number[],dx:number,dy:number){
    const result=Array<number>(count).fill(0);
    for(let y=0;y<size;y++)for(let x=0;x<size;x++)if(mask[y*size+x]&&inDomain(x+dx,y+dy))result[(y+dy)*size+x+dx]=1;
    return result;
  }
  function morph(mask:readonly number[],grow:boolean){
    const result=Array<number>(count).fill(0);
    for(let y=0;y<size;y++)for(let x=0;x<size;x++){
      if(!inDomain(x,y))continue;let value=grow?0:1;
      for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){const pixel=inDomain(x+dx,y+dy)?mask[(y+dy)*size+x+dx]:0;value=grow?Math.max(value,pixel):Math.min(value,pixel);}
      result[y*size+x]=value;
    }return result;
  }
  return {inDomain,cleanMask,translated,morph,domainPixels,domainCount:domainPixels.reduce((a,b)=>a+b,0)};
}
