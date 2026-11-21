import { ClipboardList, MessageSquare } from 'lucide-react';
import { useId } from 'react';
import { stages, type Parameter, type StageId } from '../data/stages';
import { catalogParameters } from '../lib/parameter-catalog';
import { useDemoI18n } from '../lib/demo-i18n';
import { modelConfigurationCards } from '../lib/model-configuration';
import type { useVerifiedCompletion } from '../lib/verified-completion';
import ParameterEstimate from './ParameterEstimate';
import ParameterSymbol from './ParameterSymbol';
import './stage-artifact-views.css';

type CompletionState = ReturnType<typeof useVerifiedCompletion>;
type FinalRow = { name: string; value: number; quantiles?: Parameter['quantiles']; stage?: StageId; fixed?: boolean };
const parameters = new Map(stages.map(stage => [stage.id, catalogParameters(stage)]));
const unlabelledUnits = new Set(['1', '无量纲', 'dimensionless', 'unitless', '代码归一化', '固定', '未提供', '—']);
const regularizationParameters = new Set(['log_lambda_reg', 'adaptive_reg_rho']);
const finalParameterNames = modelConfigurationCards('m3').flatMap(card => card.parameters
  .filter(({ key }) => card.id === 'lens-mass' || regularizationParameters.has(key))
  .map(({ key }) => key));

export function FinalParameterCard({ value }: CompletionState) {
  const { t } = useDemoI18n();
  if (!value) return null;
  const rows = new Map<string, FinalRow>();
  for (const row of [
    ...value.parameters.map(({ name, stage, q16, q50, q84 }) => ({ name, value: q50, stage, quantiles: { q16, q50, q84 } })),
    ...(value.point_parameters ?? []),
    ...Object.entries(value.fixed_parameters).map(([name, value]) => ({ name, value, fixed: true })),
  ]) {
    if (!rows.has(row.name)) rows.set(row.name, row);
  }
  const ordered = finalParameterNames.map(name => rows.get(name)).filter(row => row !== undefined);
  if (!ordered.length) return null;
  return <section className="final-parameter-card" aria-label={t('最终参数')} data-result-attempt={value.attempt}>
    <h3><ClipboardList size={15} aria-hidden="true"/>{t('最终参数')}</h3>
    <table><thead><tr>
      <th scope="col">{t('参数')}</th>
      <th scope="col" className="final-parameter-value-heading">{t('数值')}</th>
      <th scope="col">{t('单位')}</th>
    </tr></thead><tbody>{ordered.map(row => {
      const meta = parameters.get(row.stage ?? 'm3')?.find(parameter => parameter.key === row.name);
      const parameter: Parameter = {
        key: row.name, symbol: meta?.symbol ?? row.name, name: meta?.name ?? row.name,
        value: String(row.value), numericValue: row.value, unit: meta?.unit ?? '', description: '',
        role: row.quantiles ? 'sampled' : row.fixed ? 'fixed' : 'setting', quantiles: row.quantiles,
      };
      const unit = parameter.unit.trim();
      return <tr key={row.name} data-parameter={row.name}>
        <th scope="row" title={t(parameter.name)}><ParameterSymbol parameter={parameter}/></th>
        <td className="final-parameter-value"><ParameterEstimate parameter={parameter} live/></td>
        <td className="final-parameter-unit">{unit && !unlabelledUnits.has(unit.toLowerCase()) ? t(unit) : ''}</td>
      </tr>;
    })}</tbody></table>
  </section>;
}

export function ModelingComment({ value, pending, stageTitle }: CompletionState & { stageTitle: (stage: StageId) => string }) {
  const { t } = useDemoI18n();
  const title = t('建模点评');
  const stageComments = value?.stage_comments;
  const tabId = useId();
  const panelId = `${tabId}-panel`;
  return <section className="stage-workspace" aria-label={title}>
    <div className="stage-content-header">
      <div className="content-tabs" role="tablist" aria-label={t('阶段内容')}>
        <button type="button" className="selected" role="tab" id={tabId} aria-selected="true" aria-controls={panelId}>
          <MessageSquare size={15} aria-hidden="true"/>{title}
        </button>
      </div>
    </div>
    <div className="tab-panel" id={panelId} role="tabpanel" aria-labelledby={tabId}>
      {stageComments ? <div className="modeling-stage-comments">{stages.map(stage => <article
        key={stage.id} className="panel modeling-comment modeling-stage-comment" data-stage={stage.id}
        aria-labelledby={`${tabId}-${stage.id}`}>
        <h3 id={`${tabId}-${stage.id}`}><span className="modeling-stage-code">{stage.id === 'preflight' ? 'D' : stage.code}</span>{stageTitle(stage.id)}</h3>
        <div className="modeling-comment-body">{stageComments[stage.id]}</div>
      </article>)}</div> : <div className="panel modeling-comment">
        {value?.comment ? <article aria-label="Pipeline AI" className="modeling-comment-body">{value.comment}</article>
          : <p className="modeling-comment-status" role="status">{t(pending ? '正在核验建模点评…' : '暂无已核验的建模点评')}</p>}
      </div>}
    </div>
  </section>;
}
