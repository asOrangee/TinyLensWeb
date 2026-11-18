/** Included-pixel drafts on the original grid; never resample a scientific mask. */
export function maskGrid(width:number,domain?:readonly number[],height=width){
  const count=width*height;
  if(![width,height].every(n=>Number.isInteger(n)&&n>=1&&n<=512)||domain&&(domain.length!==count||domain.some(p=>p!==0&&p!==1)))throw Error('Invalid mask geometry');
  const inDomain=(x:number,y:number)=>x>=0&&y>=0&&x<width&&y<height&&(domain?domain[y*width+x]===1:Math.hypot(x+.5-width/2,y+.5-height/2)<Math.min(width,height)/2);
  const domainPixels=Array.from({length:count},(_,i)=>Number(inDomain(i%width,Math.floor(i/width))));
  const cleanMask=(input:readonly number[])=>domainPixels.map((valid,i)=>Number(valid&&input[i]>0));
  function translated(mask:readonly number[],dx:number,dy:number){
    const result=Array<number>(count).fill(0);
    for(let y=0;y<height;y++)for(let x=0;x<width;x++)if(mask[y*width+x]&&inDomain(x+dx,y+dy))result[(y+dy)*width+x+dx]=1;
    return result;
  }
  function morph(mask:readonly number[],grow:boolean){
    const result=Array<number>(count).fill(0);
    for(let y=0;y<height;y++)for(let x=0;x<width;x++){
      if(!inDomain(x,y))continue;let value=grow?0:1;
      for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){const pixel=inDomain(x+dx,y+dy)?mask[(y+dy)*width+x+dx]:0;value=grow?Math.max(value,pixel):Math.min(value,pixel);}
      result[y*width+x]=value;
    }return result;
  }
  return {inDomain,cleanMask,translated,morph,domainPixels,domainCount:domainPixels.reduce((a,b)=>a+b,0)};
}
