import type {Parameter} from '../data/stages';
import type {HistogramParameter} from '../lib/live-results';
import {groupParameters,parameterNotation} from '../lib/parameter-presentation';
import {useDemoI18n} from '../lib/demo-i18n';
import ParameterCardValue from './ParameterCardValue';
import {PosteriorDistribution} from './PosteriorChart';

export default function ParameterCards({parameters,histograms=[],onDetail,live=false}:{parameters:Parameter[];histograms?:HistogramParameter[];onDetail:(parameter:Parameter)=>void;live?:boolean}){
 const {t}=useDemoI18n();
 return <div className="parameter-card-groups">{groupParameters(parameters).map(group=><section className="parameter-card-group" data-category={group.id} key={group.id??'settings'} aria-label={group.label||undefined}>
  {group.label&&<h4 className="parameter-card-group-title">{group.label}</h4>}
  <div className="parameter-card-grid">{group.parameters.map(parameter=>{
   const histogram=histograms.find(h=>h.name===parameter.key);
   const linear=parameter.role==='linear';
   const available=parameter.role==='sampled'&&(live?!!histogram:Number.isFinite(parameter.mean)&&Number.isFinite(parameter.sigma)&&(parameter.sigma??0)>0);
   return <article className="parameter-card" data-parameter={parameter.key} key={parameter.key} aria-label={parameterNotation(parameter).label}>
    <ParameterCardValue parameter={parameter} onDetail={onDetail} live={live}/>
    <div className={`parameter-card-posterior${available||linear?'':' is-unavailable'}`}>
      {linear ? <span className="parameter-card-linear-label">{t('线性采样')}</span>
        : available ? <PosteriorDistribution parameter={parameter} histogram={histogram} real={live}/>
        : <span className="parameter-card-empty" aria-label={t('暂无采样后验')}>—</span>}
    </div>
   </article>;
  })}</div>
 </section>)}</div>;
}
