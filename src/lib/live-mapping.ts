import {mapperFromEvaluator, type PlaneFrame,type Point} from './lens-mapping.ts';
export type LiveMapping={schema:'tinylens.lens-mapping.v1';synthetic:false;stage:string;attempt:number;path:string;summary_sha256:string;fits_sha256:string;model:{kind:'sie-shear';theta_E:number;e1_mass:number;e2_mass:number;center_x_mass:number;center_y_mass:number;gamma1:number;gamma2:number};frames:{image:PlaneFrame;source:PlaneFrame};references:{image:Point;source:Point}[]};

/** Exact TinyLens SIE convention, checked against per-attempt library rays. */
export function sieMapper(model:LiveMapping['model'],frame:PlaneFrame){
 if(model.kind!=='sie-shear'||Object.entries(model).some(([key,v])=>key!=='kind'&&(typeof v!=='number'||!Number.isFinite(v)))||model.theta_E<=0)throw Error('Unsupported saved mass model');
 const e1=model.e1_mass||1e-12,e2=model.e2_mass||1e-12,e=Math.min(.9999,Math.hypot(e1,e2)),q=(1-e)/(1+e),angle=Math.atan2(e2,e1)/2-Math.PI/2,c=Math.cos(angle),s=Math.sin(angle);
 const deflect=(p:Point):Point=>{
  const dx=p.x-model.center_x_mass,dy=p.y-model.center_y_mass;let ax:number,ay:number;
  if(1-q<=Math.sqrt(2**-23)){const theta=Math.atan2(dy,dx);ax=model.theta_E*Math.cos(theta);ay=model.theta_E*Math.sin(theta);}
  else {const x=dx*c+dy*s,y=-dx*s+dy*c,theta=Math.atan2(y,x),factor=Math.sqrt(1/q-q),u=Math.asinh(Math.max(-1e10,Math.min(1e10,Math.sqrt(1/q**2-1)*Math.cos(theta))))/factor*model.theta_E,v=Math.asin(Math.max(-1+1e-8,Math.min(1-1e-8,Math.sqrt(1-q*q)*Math.sin(theta))))/factor*model.theta_E;ax=u*c-v*s;ay=u*s+v*c;}
  return {x:p.x-ax-model.gamma1*p.x-model.gamma2*p.y,y:p.y-ay-model.gamma2*p.x+model.gamma1*p.y};
 };
 const evaluate=(p:Point)=>{const h=1e-5,v=deflect(p),xp=deflect({x:p.x+h,y:p.y}),xm=deflect({x:p.x-h,y:p.y}),yp=deflect({x:p.x,y:p.y+h}),ym=deflect({x:p.x,y:p.y-h});return {...v,xx:(xp.x-xm.x)/(2*h),xy:((yp.x-ym.x)+(xp.y-xm.y))/(4*h),yy:(yp.y-ym.y)/(2*h)};};
 const mapping=mapperFromEvaluator(evaluate,frame);
 return {...mapping,criticalCurves:()=>mapping.criticalCurves().filter(curve=>curve.critical.some(p=>Math.hypot(p.x-model.center_x_mass,p.y-model.center_y_mass)>1e-3))};
}
export function verifiedLiveMapping(value:LiveMapping|undefined,binding:{stage:string;attempt:number;path:string;sha256:string;fitsSha256?:string}){
 try{
  if(!value||value.schema!=='tinylens.lens-mapping.v1'||value.synthetic!==false||value.stage!==binding.stage||value.attempt!==binding.attempt||value.path!==binding.path||value.summary_sha256!==binding.sha256||value.fits_sha256!==binding.fitsSha256)return null;
  for(const name of ['image','source'] as const){const frame=value.frames[name];if(!Array.isArray(frame?.shape)||frame.shape.length!==2||!frame.shape.every(n=>Number.isInteger(n)&&n>0&&n<=512)||!Array.isArray(frame.bounds_arcsec)||frame.bounds_arcsec.length!==4||!frame.bounds_arcsec.every(Number.isFinite)||frame.bounds_arcsec[1]<=frame.bounds_arcsec[0]||frame.bounds_arcsec[3]<=frame.bounds_arcsec[2]||frame.half_extent_arcsec<=0||Math.abs(frame.bounds_arcsec[3]-frame.bounds_arcsec[2]-frame.half_extent_arcsec*2)>1e-10)throw Error('Uncalibrated lens frame');}
  const mapper=sieMapper(value.model,value.frames.image);
  if(value.references.length<5||value.references.some(ray=>{if(![ray.image?.x,ray.image?.y,ray.source?.x,ray.source?.y].every(Number.isFinite))return true;const p=mapper.sourceFor(ray.image);return !Number.isFinite(p.x)||!Number.isFinite(p.y)||Math.hypot(p.x-ray.source.x,p.y-ray.source.y)>2e-5;}))return null;
  return {...mapper,frames:value.frames};
 }catch{return null;}
}
