import { BookOpen, ExternalLink } from 'lucide-react';
import type { Parameter, Stage } from '../data/stages';
import type { LiveResult } from '../lib/live-results';
import { modelConfigurationCards } from '../lib/model-configuration';
import { useDemoI18n } from '../lib/demo-i18n';
import { catalogParameters } from '../lib/parameter-catalog';
import { parameterNotation } from '../lib/parameter-presentation';
import ParameterSymbol from './ParameterSymbol';
import './model-configuration.css';

const optimizationGroups = [
  { role: 'sampled', label: '采样' },
  { role: 'scan', label: '网格扫描' },
  { role: 'linear', label: '线性采样' },
  { role: 'fixed', label: '固定' },
] as const;

export default function StageConfiguration({ stage, live = false, summary, model, onDetail }: {
  stage: Stage; live?: boolean; summary?: LiveResult; model?: LiveResult; onDetail: (parameter: Parameter) => void;
}) {
  const { t } = useDemoI18n();
  const definitions = catalogParameters(stage);
  return <div className="model-config-grid" aria-label={t('当前模型')}>
    {modelConfigurationCards(stage.id, live, summary, model).map(card => <article className="model-config-card" key={card.id} aria-label={card.label}>
      <header><h3>{card.label}</h3><div className="model-config-title"><strong className="model-config-name">{card.model}</strong>{card.model==='MGE'&&card.details.map(detail=><span className="model-config-brief" key={typeof detail==='string'?detail:detail.template}>{typeof detail==='string'?t(detail):t(detail.template,detail.values)}</span>)}</div></header>
      <p className="model-config-introduction">{t(card.introduction)}</p>
      <section className="model-config-parameters" aria-label={t('模型参数')}><h4>{t('模型参数')}</h4>
        <div className="model-config-parameter-groups">{card.parameters.length ? optimizationGroups.map(group => ({ ...group, parameters: card.parameters.filter(parameter => parameter.role === group.role) })).filter(group => group.parameters.length > 0).map(group => <fieldset className="model-parameter-group" data-optimization={group.role} key={group.role}>
          <legend>{t(group.label)}</legend>
          <div className="model-config-symbols">{group.parameters.map(parameter => {const definition=definitions.find(item=>item.key===parameter.key);return <button className="model-parameter-link" type="button" key={parameter.key} aria-label={parameterNotation(definition??parameter).label} title={definition?t(definition.name):undefined} disabled={!definition} onClick={()=>{if(definition)onDetail(definition);}}><ParameterSymbol parameter={definition??parameter}/></button>;})}</div>
        </fieldset>) : '—'}</div>
        {card.model!=='MGE'&&card.details.map(detail => <p key={typeof detail==='string'?detail:detail.template}>{typeof detail==='string'?t(detail):t(detail.template,detail.values)}</p>)}
      </section>
      {card.references.length > 0 && <footer aria-label={t('参考文献')}>{card.references.map(reference => <a key={reference.url} href={reference.url} target="_blank" rel="noreferrer"><BookOpen size={14}/><span>{reference.label}</span><ExternalLink size={12}/></a>)}</footer>}
    </article>)}
  </div>;
}
