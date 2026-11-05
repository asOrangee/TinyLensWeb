import type { AgentUpdate } from './agent-types';
import type { InputDisplay, InputScale } from './input-display';
import type { PositionContext, PositionDraft, PositionFrame } from './position-likelihood';

export function inputPositionContext(display:InputDisplay|undefined,report:AgentUpdate|undefined,fallbackTarget:string,scale:InputScale='linear'):PositionContext {
  const base={target:fallbackTarget,synthetic:false,stage:'preflight'};
  const data=display?.planes.find(plane=>plane.id==='data');
  if(!display||display.rendered_from!=='numeric-array'||!data||!report?.id||display.source.provenance_path!==report.path)return base;
  const frame:PositionFrame={shape:[data.shape[0],data.shape[1]],pixelScale:display.pixel_scale_arcsec,xDirection:display.x_direction,yDirection:display.y_direction};
  const source={report_id:report.id,provenance_path:display.source.provenance_path,provenance_sha256:display.source.provenance_sha256,fits_path:display.source.fits_path,fits_sha256:display.source.fits_sha256};
  return {...base,target:source.fits_path.slice(0,source.fits_path.lastIndexOf('/')),image:data.variants[scale].src,imageReference:source.fits_path+'#VIS_FLUX',frame,
    coordinateFrame:{...frame,xDirection:'increasing',yDirection:'increasing'},source};
}

/** A different target has no verified association with this input image. */
export function positionContextForTarget(context:PositionContext,target?:string):PositionContext {
  return target!==undefined&&target.trim()!==context.target?{target:target.trim(),synthetic:context.synthetic,stage:context.stage}:context;
}

/** Upgrade only the old empty default; preserve every actual selection and custom target. */
export function positionDraftForInput(draft:PositionDraft,context:PositionContext,previousDefault:string):PositionDraft {
  return context.source&&!draft.points.length&&draft.target===previousDefault?{...draft,target:undefined}:draft;
}
