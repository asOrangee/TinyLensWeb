import { useState } from 'react';
import { ChevronRight, Search } from 'lucide-react';
import type { Parameter, Stage } from '../data/stages';
import { useDemoI18n } from '../lib/demo-i18n';
import { catalogParameters } from '../lib/parameter-catalog';

export default function ParameterManual({ stages, onSelect }: { stages: Stage[]; onSelect: (stage: Stage, parameter: Parameter) => void }) {
  const { t } = useDemoI18n(), [search, setSearch] = useState('');
  return <><div className="search-field"><Search size={18}/><input autoFocus aria-label={t('搜索参数或阶段')} placeholder={t('搜索参数、符号或物理意义…')} value={search} onChange={event => setSearch(event.target.value)}/><kbd>⌘ K</kbd></div><div className="manual-results">{stages.flatMap(stage => catalogParameters(stage).map(parameter => ({ stage, parameter }))).filter(({ stage, parameter }) => `${parameter.name} ${t(parameter.name)} ${parameter.key} ${parameter.symbol} ${parameter.description} ${t(parameter.description)} ${stage.code}`.toLowerCase().includes(search.toLowerCase())).map(({ stage, parameter }) => <button key={`${stage.id}-${parameter.key}`} onClick={() => onSelect(stage, parameter)}><span className="manual-stage">{stage.code}</span><div><strong>{parameter.symbol}<span>{t(parameter.name)}</span></strong><p>{t(parameter.description)}</p></div><ChevronRight size={15}/></button>)}</div></>;
}
