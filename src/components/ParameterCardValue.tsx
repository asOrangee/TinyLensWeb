import type { Parameter } from '../data/stages';
import { useDemoI18n } from '../lib/demo-i18n';
import { parameterNotation } from '../lib/parameter-presentation';
import ParameterEstimate from './ParameterEstimate';
import ParameterSymbol from './ParameterSymbol';
import './parameter-cards.css';

export default function ParameterCardValue({ parameter, onDetail, live = false, showUnit = true }: {
  parameter: Parameter;
  onDetail: (parameter: Parameter) => void;
  live?: boolean;
  showUnit?: boolean;
}) {
  const { t } = useDemoI18n();
  const linear = parameter.role === 'linear';
  return <div className="parameter-card-value">
    <div className="parameter-card-formula">
      <button className="parameter-card-symbol" type="button" aria-label={parameterNotation(parameter).label} title={parameter.key} onClick={() => onDetail(parameter)}>
        <ParameterSymbol parameter={parameter}/>
      </button>
      {linear ? <span className="parameter-estimate" aria-hidden="true"/> : <ParameterEstimate parameter={parameter} live={live}/>}
    </div>
    {showUnit && (linear ? <span className="parameter-card-unit" aria-hidden="true"/> : parameter.unit !== '—' && <span className="parameter-card-unit">{t(parameter.unit)}</span>)}
  </div>;
}
