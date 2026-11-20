import {mapperFromEvaluator, type LensCurvePair, type PlaneFrame,type Point} from './lens-mapping.ts';
import {eplMapper,type EplShearModel} from './epl-mapping.ts';
import type { LiveResult } from './live-results.ts';
type SieShearModel=Omit<EplShearModel,'kind'|'gamma'>&{kind:'sie-shear'};
type Frames = { image: PlaneFrame; source: PlaneFrame };
type MappingIdentity = { synthetic: false; stage: string; attempt: number; path: string; run_id?: string; summary_sha256: string; fits_sha256: string;
  model: SieShearModel | EplShearModel; frames: Frames; references: { image: Point; source: Point; determinant?: number }[] };
export type LiveMapping = MappingIdentity & ({ schema: 'tinylens.lens-mapping.v1' } | {
  schema: 'tinylens.lens-mapping.v2'; curves: LensCurvePair[] | null; mapping_source: { path: string; sha256: string };
});
type MappingBinding = { stage: string; attempt: number; path: string; sha256: string; fitsSha256?: string; runId?: string; frames?: Frames };
const displayDirectory = (path: string) => path.replace(/\/(?:display\/?|display-manifest\.json|stage-result\.json)$/, '') + '/display/';
const isHash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function isCalibratedFrame(frame?: PlaneFrame): frame is PlaneFrame {
  const bounds = frame?.bounds_arcsec;
  return !!frame && Array.isArray(frame.shape) && frame.shape.length === 2
    && frame.shape.every(n => Number.isInteger(n) && n > 0 && n <= 512)
    && Array.isArray(bounds) && bounds.length === 4 && [...bounds, frame.half_extent_arcsec].every(Number.isFinite)
    && bounds[1] > bounds[0] && bounds[3] > bounds[2] && frame.half_extent_arcsec > 0
    && Math.abs(bounds[3] - bounds[2] - frame.half_extent_arcsec * 2) <= 1e-10;
}

/** Exact TinyLens SIE convention, checked against per-attempt library rays. */
export function sieMapper(model:SieShearModel,frame:PlaneFrame){
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
export function verifiedLiveMapping(value: LiveMapping | undefined, binding: MappingBinding) {
 try{
  if(!value||!['tinylens.lens-mapping.v1','tinylens.lens-mapping.v2'].includes(value.schema)||value.synthetic!==false||value.stage!==binding.stage||value.attempt!==binding.attempt||value.path!==binding.path||value.summary_sha256!==binding.sha256||value.fits_sha256!==binding.fitsSha256)return null;
  if (!isCalibratedFrame(value.frames.image) || !isCalibratedFrame(value.frames.source)) return null;
  const isEpl=value.model.kind==='epl-shear';
  if((binding.stage==='m3')!==isEpl)return null;
  const mapper=value.model.kind==='epl-shear'?eplMapper(value.model,value.frames.image):sieMapper(value.model,value.frames.image);
  if(!Array.isArray(value.references)||value.references.length<5)return null;
  for(const ray of value.references){
   if(![ray.image?.x,ray.image?.y,ray.source?.x,ray.source?.y].every(Number.isFinite))return null;
   const p=mapper.sourceFor(ray.image);
   if(!Number.isFinite(p.x)||!Number.isFinite(p.y)||Math.hypot(p.x-ray.source.x,p.y-ray.source.y)>2e-5)return null;
   if(isEpl){
    const determinant=mapper.determinantFor(ray.image),expected=ray.determinant;
    if(typeof expected!=='number'||!Number.isFinite(expected)||!Number.isFinite(determinant)||Math.abs(determinant-expected)>2e-5*Math.max(1,Math.abs(expected)))return null;
   }
  }
  if (value.schema === 'tinylens.lens-mapping.v2') {
    const sameFrame = (a: PlaneFrame, b: PlaneFrame) => JSON.stringify(a.shape) === JSON.stringify(b.shape)
      && JSON.stringify(a.bounds_arcsec) === JSON.stringify(b.bounds_arcsec);
    const directory = displayDirectory(binding.path);
    if (value.run_id !== binding.runId || !value.mapping_source?.path?.startsWith(directory)
        || !/^[^/]+\.json$/.test(value.mapping_source.path.slice(directory.length))
        || !isHash(value.mapping_source.sha256)
        || (binding.frames && (!sameFrame(value.frames.image, binding.frames.image) || !sameFrame(value.frames.source, binding.frames.source)))) return null;
    const curves = value.curves;
    if (curves !== null && (!Array.isArray(curves) || curves.some(pair => !Array.isArray(pair?.critical) || !Array.isArray(pair.caustic)
      || pair.critical.length < 2 || pair.critical.length !== pair.caustic.length || typeof pair.closed !== 'boolean'
      || [...pair.critical, ...pair.caustic].some(point => !Number.isFinite(point?.x) || !Number.isFinite(point?.y))))) return null;
    return { ...mapper, frames: value.frames, criticalCurves: () => curves ?? [] };
  }
  return {...mapper,frames:value.frames};
 }catch{return null;}
}

export function verifiedResultMapping(result?: LiveResult, stage = result?.stage) {
  if (!result || stage !== result.stage || result.attempt === null) return null;
  const { observation, source } = result.planes ?? {};
  if (result.display_mapping !== undefined) {
    if (result.display_mapping?.schema === 'tinylens.lens-mapping.v2' && (!observation || !source)) return null;
    return verifiedLiveMapping(result.display_mapping, { stage, attempt: result.attempt, path: result.path, sha256: result.sha256,
      runId: result.run_id, fitsSha256: observation?.input_fits_sha256, frames: observation && source ? { image: observation, source } : undefined });
  }
  if (stage !== 'a' || result.display_mapping_from_parameters !== true || result.kind !== 'summary'
      || result.result?.status !== 'success' || result.result.stage !== 'a' || result.result.attempt !== result.attempt
      || result.parameter_contract !== 'tinylens.stage-parameters.v1'
      || !isCalibratedFrame(observation) || !isCalibratedFrame(source)
      || !isHash(result.sha256) || !isHash(observation.input_fits_sha256)
      || source.input_fits_sha256 !== observation.input_fits_sha256) return null;
  const directory = displayDirectory(result.path);
  if (!directory.endsWith(`/attempts/a/${result.attempt}/display/`)
      || result.parameter_source?.path !== directory + 'StageA_Parameters.json'
      || !isHash(result.parameter_source.sha256)) return null;
  const { theta_E, e1_mass, e2_mass, center_x_mass, center_y_mass, gamma1, gamma2 } =
    (result.result.metrics.medians ?? {}) as Omit<SieShearModel, 'kind'>;
  try {
    const mapper = sieMapper({ kind: 'sie-shear', theta_E, e1_mass, e2_mass, center_x_mass, center_y_mass, gamma1, gamma2 }, observation);
    return { ...mapper, frames: { image: observation, source } };
  } catch { return null; }
}
