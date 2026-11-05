import type {Parameter} from '../data/stages';
import {parameterNotation} from '../lib/parameter-presentation';
export default function ParameterSymbol({parameter}:{parameter:Pick<Parameter,'key'|'symbol'>}){
 const notation=parameterNotation(parameter);
 return <span className="parameter-notation" aria-label={notation.label}><span className="parameter-notation-base">{notation.base}</span>{notation.subscript&&<sub>{notation.subscript}</sub>}{notation.superscript&&<sup>{notation.superscript}</sup>}</span>;
}
