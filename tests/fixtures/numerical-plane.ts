import {createHash} from 'node:crypto';
export function numericalFixture(shape:number[]=[2,2]){
 const count=shape[0]*shape[1],raw=Buffer.alloc(count*8),mask=Buffer.alloc(count,1),colors=Buffer.alloc(1024);
 for(let i=0;i<count;i++)raw.writeDoubleLE(i,i*8);
 for(let i=0;i<256;i++){colors[i*4]=255-i;colors[i*4+1]=255-i;colors[i*4+2]=255-i;colors[i*4+3]=255;}
 const sha=(v:Buffer)=>createHash('sha256').update(v).digest('hex');
 return {src:'',colormap_src:'',shape,bounds_arcsec:[-shape[1]/2,shape[1]/2,-shape[0]/2,shape[0]/2],half_extent_arcsec:shape[0]/2,vmin:0,vmax:count-1,data_min:0,data_max:count-1,stretch:'linear',asinh_a:1,colormap:'magma',values_base64:raw.toString('base64'),values_sha256:sha(raw),mask_base64:mask.toString('base64'),array_y_direction:'increasing' as const,color_lut_base64:colors.toString('base64'),color_lut_sha256:sha(colors)};
}
