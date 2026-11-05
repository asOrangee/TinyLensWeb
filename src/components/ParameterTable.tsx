import { BookOpen, CircleHelp, ExternalLink } from 'lucide-react';
import type { Parameter } from '../data/stages';
import { useDemoI18n, type DemoTranslate } from '../lib/demo-i18n';
import {formatParameterNumber,groupParameters,parameterEstimate} from '../lib/parameter-presentation';
import ParameterEstimate from './ParameterEstimate';
import ParameterSymbol from './ParameterSymbol';

export const roleLabel = (role: Parameter['role'], t: DemoTranslate) => ({ sampled: t('采样参数'), fixed: t('固定参数'), linear: t('线性求解'), setting: t('计算设置') }[role]);
export const intervalLabel = (p: Parameter) => {const q=parameterEstimate(p).quantiles;return q?`${formatParameterNumber(q.q16)} – ${formatParameterNumber(q.q84)}`:'—';};

export default function ParameterTable({ parameters, onDetail, live = false }: { parameters: Parameter[]; onDetail: (p: Parameter) => void; live?: boolean }) {
  const { t } = useDemoI18n();
  return <div className="table-scroll"><table className={`parameter-table${live ? ' live-numeric-table' : ''}`}><thead><tr><th>{t('主要参数 / 物理含义')}</th><th>{t('求解方式')}</th><th>{live ? t('后验中位数 / 当前值') : t('示例值')}</th><th>{t('单位')}</th></tr></thead>{groupParameters(parameters).map(group=><tbody className="parameter-group" data-category={group.id} key={group.id??'settings'}>{group.label&&<tr className="parameter-group-heading"><th colSpan={4} scope="rowgroup">{group.label}</th></tr>}{group.parameters.map(p => <tr key={p.key} data-parameter={p.key}><td><button className="parameter-name" onClick={() => onDetail(p)}><span className="parameter-symbol">{p.symbol}</span><span>{p.name}</span><CircleHelp size={12}/></button></td><td><span className={`role-tag role-${p.role}`}>{roleLabel(p.role, t)}</span></td><td className="number-cell"><ParameterEstimate parameter={p} live={live}/></td><td className="parameter-unit">{p.unit === '—' ? '' : t(p.unit)}</td></tr>)}</tbody>)}</table></div>;
}

export function ParameterDetail({ parameter }: { parameter: Parameter; live?: boolean }) {
  const { t } = useDemoI18n();
  return <div className="parameter-detail"><span className="parameter-large-symbol"><ParameterSymbol parameter={parameter}/></span><div className="detail-tags"><span className="tag">{parameter.unit === '—' ? t('无单位 / 不适用') : t(parameter.unit)}</span></div><p>{t(parameter.description)}</p>{parameter.reference && <a className="reference-button" href={parameter.reference} target="_blank" rel="noreferrer"><BookOpen size={15}/>{t('查阅相关论文')}<ExternalLink size={13}/></a>}</div>;
}
