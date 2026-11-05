import type {Parameter} from '../data/stages';
import {formatParameterNumber,parameterEstimate} from '../lib/parameter-presentation';
import './parameter-presentation.css';
export default function ParameterEstimate({parameter,live=false}:{parameter:Parameter;live?:boolean}){
 const estimate=parameterEstimate(parameter,live),{text,upper,lower,quantiles}=estimate;
 const label=upper!==undefined&&lower!==undefined?`${text} +${upper} −${lower}`:text;
 const title=quantiles?`q50 ${formatParameterNumber(quantiles.q50)}; q16 ${formatParameterNumber(quantiles.q16)}; q84 ${formatParameterNumber(quantiles.q84)}`:text;
 return <span className="parameter-estimate" aria-label={label} title={title} data-central={text} data-upper={upper} data-lower={lower}><span className="parameter-central">{text}</span>{upper!==undefined&&lower!==undefined&&<span className="parameter-errors" aria-hidden="true"><sup>+{upper}</sup><sub>−{lower}</sub></span>}</span>;
}
