import { useDemoI18n } from '../lib/demo-i18n';
import { useId } from 'react';
import type { HistogramParameter, LiveResult } from '../lib/live-results';
import { resultNumber as number } from '../lib/live-parameters';
import type { Parameter } from '../data/stages';
import type {ReactNode} from 'react';
import {formatParameterNumber, parameterEstimate} from '../lib/parameter-presentation';
import ParameterEstimate from './ParameterEstimate';
import ParameterCardValue from './ParameterCardValue';

export function PosteriorGroup({label,children}:{label:string;children:ReactNode}){return <>{label&&<h4 className="posterior-group-heading">{label}</h4>}{children}</>;}

export function PosteriorDistribution({parameter,histogram,real=false}:{parameter:Parameter;histogram?:HistogramParameter;real?:boolean}) {
  const {t}=useDemoI18n();
  const id=useId().replace(/:/g,'');
  if(real){
    if(!histogram)return null;
    const {edges,density}=histogram,xmin=edges[0],xmax=edges.at(-1)!,ymax=Math.max(...density,1e-30);
    const x=(v:number)=>26+(v-xmin)/(xmax-xmin)*270,y=(v:number)=>112-v/ymax*82;
    const path=density.map((v,i)=>`${i?'L':'M'}${x(edges[i])},${y(v)} L${x(edges[i+1])},${y(v)}`).join(' ');
    return <svg className="live-weighted-posterior" viewBox="0 0 322 145" role="img" aria-label={`${histogram.name} 的真实加权后验直方图`}>
      {[30,70,112].map(v=><line key={v} x1="26" x2="296" y1={v} y2={v} stroke="currentColor" opacity=".12" strokeDasharray="3 4"/>)}
      <path d={`${path} L296,112 L26,112 Z`} fill="var(--green)" opacity=".16"/><path d={path} fill="none" stroke="var(--green)" strokeWidth="2"/><line x1={x(histogram.q50)} x2={x(histogram.q50)} y1="24" y2="112" stroke="var(--green)" strokeDasharray="3 3"/>
      {[xmin,histogram.q50,xmax].map((v,i)=><text key={i} x={x(v)} y="135" textAnchor={i===0?'start':i===2?'end':'middle'} fill="currentColor" fontSize="10" fontFamily="monospace">{formatParameterNumber(v)}</text>)}
    </svg>;
  }
  if(!Number.isFinite(parameter.mean)||!Number.isFinite(parameter.sigma)||(parameter.sigma??0)<=0)return null;
  const mean=parameter.mean!, sigma=parameter.sigma!;
  const pts=Array.from({length:101},(_,i)=>{const t=-3.5+i*.07;return [26+i*2.7,112-82*Math.exp(-t*t/2)];});
  const path=pts.map((p,i)=>`${i?'L':'M'}${p[0]},${p[1]}`).join(' ');
  const fill=path+' L296,112 L26,112 Z';
  return <svg viewBox="0 0 322 145" role="img" aria-label={t("{name}的合成正态分布示意，非采样后验",{name:parameter.name})}>
      <defs><linearGradient id={id} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#299d87" stopOpacity=".27"/><stop offset="100%" stopColor="#299d87" stopOpacity=".025"/></linearGradient></defs>
      {[30,70,112].map(y=><line key={y} x1="26" x2="296" y1={y} y2={y} stroke="#e7edeb" strokeDasharray="3 4"/>)}
      <path d={fill} fill={`url(#${id})`}/><path d={path} fill="none" stroke="#21917d" strokeWidth="2"/>
      <line x1="161" x2="161" y1="24" y2="112" stroke="#1b665b" strokeDasharray="3 3"/>
      {[0,1,2].map(i=><text key={i} x={26+135*i} y="135" textAnchor={i===0?'start':i===2?'end':'middle'} fill="#7d898a" fontSize="10" fontFamily="monospace">{formatParameterNumber(mean+(i-1)*3.5*sigma)}</text>)}
    </svg>;
}

export function PosteriorChart({parameter,histogram,real=false}:{parameter:Parameter;histogram?:HistogramParameter;real?:boolean}){
 if(real&&!histogram)return null;
 return <div className="posterior-chart"><div className="plot-name"><span>{parameter.symbol}</span><span>{parameter.name}</span></div><PosteriorDistribution parameter={parameter} histogram={histogram} real={real}/><div className="plot-estimate"><ParameterEstimate parameter={histogram?{...parameter,quantiles:histogram}:parameter} live={real}/> <span>{parameter.unit==='—'?'':parameter.unit}</span></div></div>;
}

function demoEvidenceCurve(best: number) {
  const log_lambda = [...new Set([...Array.from({ length: 81 }, (_, i) => -1 + i * .1), best])].sort((a, b) => a - b);
  return { log_lambda, log_evidence: log_lambda.map(value => -5.6 * (value - best) ** 2) };
}

export function EvidenceChart({ parameter, onDetail, data, real = false }: {
  parameter?: Parameter;
  onDetail: (parameter: Parameter) => void;
  data?: LiveResult['scan'];
  real?: boolean;
}) {
  const { t } = useDemoI18n();
  const className = `evidence-card${real ? ' live-evidence-scan' : ''}`;
  const heading = parameter && <header className="evidence-scan-heading"><ParameterCardValue parameter={parameter} onDetail={onDetail} live={real} showUnit={false}/></header>;
  if (real && !data) return <div className={className}>{heading}</div>;

  const selected = data?.log_lambda_best ?? (parameter && parameterEstimate(parameter).value) ?? 2.84;
  const curve = data?.fine ?? demoEvidenceCurve(selected);
  const peak = Math.max(...(data?.coarse.log_evidence ?? []), ...curve.log_evidence);
  const xs = curve.log_lambda, ys = curve.log_evidence.map(value => value - peak);
  const xmin = Math.min(...xs), xmax = Math.max(...xs), ymin = Math.min(...ys), ymax = Math.max(...ys);
  const left = 94, right = 527, top = 23, bottom = 190;
  const x = (value: number) => xmin === xmax ? (left + right) / 2 : left + (value - xmin) / (xmax - xmin) * (right - left);
  const y = (value: number) => ymin === ymax ? (top + bottom) / 2 : bottom - (value - ymin) / (ymax - ymin) * (bottom - top);
  const xTicks = xmin === xmax ? [xmin] : (data ? [0, .5, 1] : [0, .25, .5, .75, 1]).map(f => xmin + f * (xmax - xmin));
  const yTicks = ymin === ymax ? [ymax] : [ymax, (ymin + ymax) / 2, ymin];
  const selectedIndex = xs.indexOf(selected);

  return <div className={className}>{heading}
    <svg viewBox="0 0 560 236" role="img" aria-label={t(real ? 'M0 正则化强度与相对对数证据' : 'M0 正则化强度与相对对数证据的合成曲线')}>
      {yTicks.map(value => <g key={value}>
        <line x1={left - 4} x2={right} y1={y(value)} y2={y(value)} stroke="currentColor" opacity=".16"/>
        <text x={left - 8} y={y(value) + 3.5} textAnchor="end" fontSize="10">{number(value)}</text>
      </g>)}
      <line x1={left} x2={left} y1={top} y2={bottom} stroke="currentColor" opacity=".55"/>
      <line x1={left} x2={right} y1={bottom} y2={bottom} stroke="currentColor" opacity=".55"/>
      <path className="evidence-scan-trace" d={xs.map((value, index) => `${index ? 'L' : 'M'}${x(value)},${y(ys[index])}`).join(' ')} fill="none" strokeWidth="2.5"/>
      {selectedIndex >= 0 && <>
        <line className="evidence-scan-trace" x1={x(selected)} x2={x(selected)} y1={top} y2={bottom} strokeDasharray="4 4"/>
        <circle cx={x(selected)} cy={y(ys[selectedIndex])} r="5" fill="var(--evidence-accent)" stroke="white" strokeWidth="2"/>
      </>}
      {xTicks.map(value => <g key={value}>
        <line x1={x(value)} x2={x(value)} y1={bottom} y2={bottom + 4} stroke="currentColor" opacity=".55"/>
        <text x={x(value)} y={bottom + 17} textAnchor="middle" fontSize="10">{formatParameterNumber(value)}</text>
      </g>)}
      <text x={(left + right) / 2} y="230" textAnchor="middle" fontSize="11">ln λ<tspan baselineShift="sub" fontSize="8">reg</tspan></text>
      <text transform={`translate(17 ${(top + bottom) / 2}) rotate(-90)`} textAnchor="middle" fontSize="11">Δln evidence</text>
    </svg>
  </div>;
}
