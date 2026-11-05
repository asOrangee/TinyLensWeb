import type {Parameter} from '../data/stages';
import type {HistogramParameter} from '../lib/live-results';
import {groupParameters,parameterNotation} from '../lib/parameter-presentation';
import {useDemoI18n} from '../lib/demo-i18n';
import ParameterEstimate from './ParameterEstimate';
import ParameterSymbol from './ParameterSymbol';
import {PosteriorDistribution} from './PosteriorChart';
import './parameter-cards.css';

export default function ParameterCards({parameters,histograms=[],onDetail,live=false}:{parameters:Parameter[];histograms?:HistogramParameter[];onDetail:(parameter:Parameter)=>void;live?:boolean}){
 const {t}=useDemoI18n();
 return <div className="parameter-card-groups">{groupParameters(parameters).map(group=><section className="parameter-card-group" data-category={group.id} key={group.id??'settings'} aria-label={group.label||undefined}>
  {group.label&&<h4 className="parameter-card-group-title">{group.label}</h4>}
  <div className="parameter-card-grid">{group.parameters.map(parameter=>{
   const histogram=histograms.find(h=>h.name===parameter.key);
   const available=parameter.role==='sampled'&&(live?!!histogram:Number.isFinite(parameter.mean)&&Number.isFinite(parameter.sigma)&&(parameter.sigma??0)>0);
   return <article className="parameter-card" data-parameter={parameter.key} key={parameter.key} aria-label={parameterNotation(parameter).label}>
    <div className="parameter-card-value"><div className="parameter-card-formula"><button className="parameter-card-symbol" aria-label={parameterNotation(parameter).label} title={parameter.key} onClick={()=>onDetail(parameter)}><ParameterSymbol parameter={parameter}/></button>{' '}<ParameterEstimate parameter={parameter} live={live}/></div>{parameter.unit!=='—'&&<span className="parameter-card-unit">{t(parameter.unit)}</span>}</div>
    <div className={`parameter-card-posterior${available?'':' is-unavailable'}`}>{available?<PosteriorDistribution parameter={parameter} histogram={histogram} real={live}/>:<span className="parameter-card-empty" aria-label={t('暂无采样后验')}>—</span>}</div>
   </article>;
  })}</div>
 </section>)}</div>;
}
