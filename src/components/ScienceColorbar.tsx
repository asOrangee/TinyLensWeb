import { useDemoI18n } from '../lib/demo-i18n';
import { colorbarTicks, formatColorbarTick, type DisplayStretch } from '../lib/display-scale';

interface ScienceColorbarProps {
  min: number;
  max: number;
  stretch?: DisplayStretch;
  parameter?: number;
  redBlue?: boolean;
  constant?: boolean;
  unit?: string;
  title?: string;
  gradient?: string;
  constantColor?: string;
}

export default function ScienceColorbar({
  min, max, stretch = 'linear', parameter = 1, redBlue = false, constant = false,
  unit, title, gradient, constantColor,
}: ScienceColorbarProps) {
  const { t } = useDemoI18n();
  const range = t('显示范围：{min} 至 {max}', { min: formatColorbarTick(min), max: formatColorbarTick(max) });
  const unitLabel = typeof unit === 'string' ? unit.trim() : '';
  const background = constantColor ?? (gradient ? `url("${gradient}") center / 100% 100% no-repeat` : undefined);
  const hasUnit = unitLabel && !['1', '无量纲', 'dimensionless', 'unitless', '未提供'].includes(unitLabel.toLowerCase());
  return <div className="science-colorbar-column" role="group" aria-label={hasUnit ? `${range} · ${unitLabel}` : range} title={title}>
    {hasUnit && <span className="science-colorbar-unit" title={unitLabel} aria-hidden="true">{unitLabel}</span>}
    <div className={`science-colorbar${redBlue ? ' red-blue' : ''}${constant ? ' is-constant' : ''}`} style={{ background }}/>
    {colorbarTicks(min, max, stretch, parameter).map(({ fraction, value }, index) => (
      <div key={index} className="science-colorbar-tick" data-value={value} title={String(value)} style={{ top: `${(1 - fraction) * 100}%` }}>
        <i/>
        <span className="science-scale-number" style={{ transform: `translateY(${fraction === 1 ? 0 : fraction === 0 ? -100 : -50}%)` }}>
          {formatColorbarTick(value)}
        </span>
      </div>
    ))}
  </div>;
}
