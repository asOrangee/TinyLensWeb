import {stages,type Parameter} from '../data/stages.ts';
export type ParameterCategory='lens-mass'|'lens-light'|'source-light';
export const parameterCategories=[{id:'lens-mass',label:'Lens mass'},{id:'lens-light',label:'Lens light'},{id:'source-light',label:'Source light'}] as const;
const mass=new Set(['theta_E','gamma','gamma1','gamma2','e1_mass','e2_mass','center_x_mass','center_y_mass']);
const source=new Set(['center_x_src','center_y_src','e1_src','e2_src','source_mge_amplitudes','source_brightness','log_lambda_reg','log_lambda_best','adaptive_reg_rho','regularization_type','source_pixel_scale','source_grid_shape','source_grid_half_extent','arc_snr_threshold','arc_ignor_size','arc_ext_size','arc_close_size']);
export function parameterCategory(key:string):ParameterCategory|undefined{
 if(mass.has(key))return 'lens-mass';
 if(key==='lens_mge_amplitudes'||/^(?:e[12]|center_[xy])_lens_[12]$/.test(key))return 'lens-light';
 if(source.has(key))return 'source-light';
}
export function parameterMetadata(key:string){return stages.flatMap(s=>s.parameters).find(p=>p.key===key);}
/** Display notation only; original pipeline keys and physical meanings stay intact. */
export function parameterNotation(parameter:Pick<Parameter,'key'|'symbol'>){
 const known:Record<string,{base:string;subscript?:string;superscript?:string}>={
  theta_E:{base:'θ',subscript:'E'},e1_mass:{base:'e',subscript:'1'},e2_mass:{base:'e',subscript:'2'},
  center_x_mass:{base:'x',subscript:'lens_mass'},center_y_mass:{base:'y',subscript:'lens_mass'},
  gamma:{base:'γ'},gamma1:{base:'γ',subscript:'1'},gamma2:{base:'γ',subscript:'2'},
  center_x_src:{base:'x',subscript:'src'},center_y_src:{base:'y',subscript:'src'},e1_src:{base:'e',subscript:'1_src'},e2_src:{base:'e',subscript:'2_src'},
  lens_mge_amplitudes:{base:'a',subscript:'j_lens_light'},source_mge_amplitudes:{base:'a',subscript:'j_src'},source_brightness:{base:'s',subscript:'i'},
  lens_mge_sigmas:{base:'σ',subscript:'j_lens_light'},source_mge_sigmas:{base:'σ',subscript:'j_src'},
  source_grid_shape:{base:'N',subscript:'src'},source_pixel_scale:{base:'Δβ'},source_grid_half_extent:{base:'β',subscript:'max'},
  log_lambda_reg:{base:'ln λ',subscript:'reg',superscript:parameter.symbol.includes('*')?'*':undefined},log_lambda_best:{base:'ln λ',subscript:'reg',superscript:'*'},adaptive_reg_rho:{base:'ρ',subscript:'reg'},regularization_type:{base:'R'},
  modeling_radius:{base:'R',subscript:'mask'},detection_threshold:{base:'S/N'},minimum_connected_pixels:{base:'N',subscript:'min'},inspector_count:{base:'N',subscript:'vote'},
  arc_snr_threshold:{base:'S/N',subscript:'min'},arc_ignor_size:{base:'N',subscript:'min'},arc_ext_size:{base:'d',subscript:'ext'},arc_close_size:{base:'d',subscript:'close'},
 };
 const lens=parameter.key.match(/^(center_([xy])|e([12]))_lens_([12])$/);
 const notation=known[parameter.key]??(lens?{base:lens[2]??'e',subscript:`${lens[3]?lens[3]+' ':''}lens_light_${lens[4]}`}:{base:parameter.symbol});
 return {...notation,label:notation.base+(notation.subscript?'_'+notation.subscript:'')+(notation.superscript?'^'+notation.superscript:'')};
}
export function groupParameters(parameters:readonly Parameter[]){
 return [...parameterCategories.map(category=>({...category,parameters:parameters.filter(p=>parameterCategory(p.key)===category.id)})),{id:undefined,label:'',parameters:parameters.filter(p=>!parameterCategory(p.key))}].filter(group=>group.parameters.length>0);
}
export const formatParameterNumber=(value:number)=>{if(!Number.isFinite(value))return '—';const text=value.toFixed(5);return text==='-0.00000'?'0.00000':text;};
const scalar=(value:unknown)=>{if(typeof value==='number')return Number.isFinite(value)?value:undefined;if(typeof value!=='string')return undefined;const normalized=value.trim().replaceAll('−','-');if(!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(normalized))return undefined;const number=Number(normalized);return Number.isFinite(number)?number:undefined;};
export function parameterEstimate(parameter:Parameter,live=false){
 const p=parameter;let q=live?p.quantiles:p.quantiles??(p.role==='sampled'&&p.mean!==undefined&&p.sigma!==undefined?{q16:p.mean-p.sigma,q50:p.mean,q84:p.mean+p.sigma}:undefined);
 if(p.role!=='sampled'||!q||![q.q16,q.q50,q.q84].every(Number.isFinite)||q.q16>q.q50||q.q50>q.q84)q=undefined;
 const value=q?.q50??scalar(p.numericValue)??scalar(p.rawValue)??scalar(p.value);
 const text=value===undefined?p.value.split(/(\s*×\s*)/).map(part=>scalar(part)===undefined?part:formatParameterNumber(scalar(part)!)).join(''):formatParameterNumber(value);
 return {text,value,upper:q?formatParameterNumber(q.q84-q.q50):undefined,lower:q?formatParameterNumber(q.q50-q.q16):undefined,quantiles:q};
}
