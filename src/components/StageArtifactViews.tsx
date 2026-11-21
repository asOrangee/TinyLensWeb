import { useState, type ReactNode } from 'react';
import { ArrowLeftRight, Images } from 'lucide-react';
import type { Parameter } from '../data/stages';
import type { AgentUpdate } from '../lib/agent-types';
import { useDemoI18n } from '../lib/demo-i18n';
import { parseStageView, preflightRawFilenames, useStageView, type JointParameters, type PreflightRawReports } from '../lib/stage-artifacts';
import type { LiveResult } from '../lib/live-results';
import { parameterNotation } from '../lib/parameter-presentation';
import { JointContourChart } from './JointContourChart';
import './stage-artifact-views.css';

export function RawResults({ report, directPreflightReports }: { report?: AgentUpdate; directPreflightReports?: PreflightRawReports }) {
  const { t } = useDemoI18n();
  const primary = useStageView('raw_artifacts', report);
  const audit = useStageView('raw_artifacts', report ? undefined : directPreflightReports?.[0]);
  const inspector = useStageView('raw_artifacts', report ? undefined : directPreflightReports?.[1]);
  const value = report ? primary.value : [audit, inspector].flatMap(({ value }, index) =>
    value?.filter(item => item.name === preflightRawFilenames[index]) ?? []);
  const loading = report ? primary.loading : audit.loading || inspector.loading;
  if (!value?.length) return <div className="empty-state"><Images size={28}/><h3>{t(loading ? '正在读取原始结果…' : '暂无已核验的原始图片')}</h3></div>;
  return <div className="stage-raw-results">{value.map(item => <figure key={item.name}>
    <figcaption>{item.name}</figcaption><img src={item.src} alt={item.name} loading="lazy"/>
  </figure>)}</div>;
}

function JointPicker({ data, parameters, histograms, report, switcher }: {
  data: JointParameters; parameters: Parameter[]; histograms?: LiveResult['parameters']; report?: AgentUpdate; switcher: ReactNode;
}) {
  const { t } = useDemoI18n();
  const [pair, setPair] = useState<[string, string]>(() => [data.names[0], data.names[1]]);
  const density = useStageView('joint_density', report, pair);
  const parameterFor = (name: string): Pick<Parameter, 'key' | 'symbol' | 'quantiles'> =>
    parameters.find(item => item.key === name) ?? { key: name, symbol: name };
  const medianFor = (name: string) => histograms?.find(row => row.name === name)?.q50 ?? parameterFor(name).quantiles?.q50;
  const options = data.names.map(name => ({ name, label: parameterNotation(parameterFor(name)).label }));
  const selectAxis = (index: 0 | 1) => <label data-axis={index === 0 ? 'x' : 'y'}>
    <span>{t(index === 0 ? '横轴' : '纵轴')}</span>
    <select value={pair[index]} onChange={event => {
      const next = event.target.value;
      setPair(previous => index === 0 ? [next, previous[1]] : [previous[0], next]);
    }}>
      {options.map(({ name, label }) => <option key={name} value={name} disabled={name === pair[1 - index]}>{label}</option>)}
    </select>
  </label>;
  return <>
    <div className="posterior-toolbar">
      {switcher}
      <div className="joint-parameter-picker">
        {selectAxis(0)}
        <button className="joint-swap-button" aria-label={t('交换横轴与纵轴')} title={t('交换横轴与纵轴')}
          type="button" onClick={() => setPair(([x, y]) => [y, x])}><ArrowLeftRight size={16}/></button>
        {selectAxis(1)}
      </div>
    </div>
    <div className="panel joint-posterior-panel">{density.value ? <figure className="joint-posterior-figure">
      <JointContourChart data={density.value} axes={[parameterFor(pair[0]), parameterFor(pair[1])]}
        medians={[medianFor(pair[0]), medianFor(pair[1])]}/>
      <figcaption className="joint-contour-legend" aria-label={t('可信区域')} title={t('σ 为一维高斯等效值')}>
        <span><i className="joint-contour-inner" aria-hidden="true"/>68% (1σ)</span>
        <span><i className="joint-contour-outer" aria-hidden="true"/>95% (2σ)</span>
      </figcaption>
    </figure> : <div className="joint-plot-placeholder" role="status">{t(density.loading ? '正在计算 GetDist 轮廓…' : '此参数组合暂无可用的联合后验轮廓')}</div>}</div>
  </>;
}

export function JointPosteriorView({ report, parameters, marginal, switcher }: {
  report?: AgentUpdate; parameters: Parameter[]; marginal?: LiveResult; switcher: ReactNode;
}) {
  const { t } = useDemoI18n();
  const knownParameters = marginal?.kind === 'weighted_posterior' ? parseStageView('joint_parameters', {
    names: marginal.parameters?.map(row => row.name), sample_count: marginal.sample_count,
  }) : undefined;
  const { value: fetchedParameters, loading } = useStageView('joint_parameters', knownParameters ? undefined : report);
  const value = knownParameters ?? fetchedParameters;
  return <section className="stage-joint-posterior" aria-label={t('联合后验')}>
    {value ? <JointPicker key={JSON.stringify([report?.id, value.names])} report={report} data={value} parameters={parameters}
      histograms={marginal?.kind === 'weighted_posterior' ? marginal.parameters : undefined} switcher={switcher}/>
      : <>
        <div className="posterior-toolbar">{switcher}</div>
        <div className="panel joint-posterior-panel"><p className="joint-plot-placeholder" role="status">
          {t(loading ? '正在读取联合样本…' : '暂无已核验的联合样本')}</p></div>
      </>}
  </section>;
}
