export type LabelContrast = {color:'#000000'|'#ffffff';blackContrast:number;whiteContrast:number;luminance:number;weight:number};
const linear = Float64Array.from({length:256},(_,n)=>{const s=n/255;return s<=.04045?s/12.92:((s+.055)/1.055)**2.4;});

/** Compare sRGB contrast only at glyph-covered pixels of the visible background. */
export function imageLabelContrast(background:ArrayLike<number>,glyphs:ArrayLike<number>):LabelContrast|undefined{
 if(background.length!==glyphs.length||background.length%4)throw Error('Invalid annotation raster');
 let black=0,white=0,luminance=0,weight=0;
 for(let i=0;i<background.length;i+=4){
  const w=glyphs[i+3]/255*background[i+3]/255;if(!w)continue;
  const l=.2126*linear[background[i]]+.7152*linear[background[i+1]]+.0722*linear[background[i+2]];
  black+=(l+.05)/.05*w;white+=1.05/(l+.05)*w;luminance+=l*w;weight+=w;
 }
 return weight?{color:black>=white?'#000000':'#ffffff',blackContrast:black/weight,whiteContrast:white/weight,luminance:luminance/weight,weight}:undefined;
}

export type ImageBox={x:number;y:number;width:number;height:number};
export function fittedImageBox(naturalWidth:number,naturalHeight:number,box:ImageBox,fit:string,position='50% 50%'):ImageBox{
 if(fit==='fill'||!(naturalWidth>0&&naturalHeight>0))return box;
 let scale=fit==='contain'?Math.min(box.width/naturalWidth,box.height/naturalHeight):fit==='cover'?Math.max(box.width/naturalWidth,box.height/naturalHeight):1;
 if(fit==='scale-down')scale=Math.min(1,box.width/naturalWidth,box.height/naturalHeight);
 const width=naturalWidth*scale,height=naturalHeight*scale,[px='50%',py='50%']=position.split(/\s+/);
 const offset=(token:string,space:number)=>token.endsWith('%')?Number(token.slice(0,-1))/100*space:token.endsWith('px')?Number(token.slice(0,-2)):space/2;
 return {x:box.x+offset(px,box.width-width),y:box.y+offset(py,box.height-height),width,height};
}
