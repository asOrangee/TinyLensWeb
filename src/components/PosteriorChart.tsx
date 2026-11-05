import { useDemoI18n } from '../lib/demo-i18n';
import { useId } from 'react';
import type { HistogramParameter, LiveResult } from '../lib/live-results';
import { resultNumber as number } from '../lib/live-parameters';
import type { Parameter } from '../data/stages';
import type {ReactNode} from 'react';
import {formatParameterNumber} from '../lib/parameter-presentation';
import ParameterEstimate from './ParameterEstimate';

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

export function EvidenceChart({data,real=false}:{data?:LiveResult['scan'];real?:boolean}={}) {
  const {t}=useDemoI18n();
  if(real&&!data)return null;
  if(data){
    const curve=data.fine,peak=Math.max(...data.coarse.log_evidence,...data.fine.log_evidence),xs=curve.log_lambda,ys=curve.log_evidence.map(v=>v-peak);
    const xmin=Math.min(...xs),xmax=Math.max(...xs),ymin=Math.min(...ys),ymax=Math.max(...ys);
    const x=(v:number)=>40+(v-xmin)/Math.max(xmax-xmin,1e-15)*474,y=(v:number)=>195-(v-ymin)/Math.max(ymax-ymin,1e-15)*157;
    return <div className="evidence-card live-evidence-scan"><div className="panel-heading"><div><span className="eyebrow">REGULARIZATION SCAN</span><h3>{t('让数据决定平滑程度')}</h3></div><span className="tag">证据扫描</span></div><svg viewBox="0 0 560 236" role="img" aria-label="ln lambda 与相对对数证据扫描，非后验分布">
      {[0,.5,1].map(f=><g key={f}><line x1="40" x2="514" y1={38+f*157} y2={38+f*157} stroke="currentColor" opacity=".12"/><text x="33" y={42+f*157} textAnchor="end" fontSize="10" fill="currentColor">{number(ymax-f*(ymax-ymin))}</text></g>)}
      <path d={xs.map((v,i)=>`${i?'L':'M'}${x(v)},${y(ys[i])}`).join(' ')} fill="none" stroke="var(--green)" strokeWidth="2.5"/>
      <line x1={x(data.log_lambda_best)} x2={x(data.log_lambda_best)} y1="28" y2="195" stroke="var(--green)" strokeDasharray="4 4"/><circle cx={x(data.log_lambda_best)} cy={y(ymax)} r="5" fill="var(--green)" stroke="white" strokeWidth="2"/>
      {[xmin,(xmin+xmax)/2,xmax].map(v=><text key={v} x={x(v)} y="215" textAnchor="middle" fontSize="11" fill="currentColor">{formatParameterNumber(v)}</text>)}<text x="280" y="234" textAnchor="middle" fontSize="11" fill="currentColor">ln λ</text>
    </svg><p>纵轴：相对对数证据 Δln ε。M0 进行网格搜索，本图不是后验分布。</p></div>;
  }
  const points=Array.from({length:81},(_,i)=>{const x=-1+i*.1; const ev=-Math.pow(x-2.84,2)*5.6;return [40+i*5.925,38-ev*1.55];});
  return <div className="evidence-card"><div className="panel-heading"><div><span className="eyebrow">REGULARIZATION SCAN</span><h3>{t("让数据决定平滑程度")}</h3></div><span className="tag">{t("合成曲线")}</span></div><svg viewBox="0 0 560 236" role="img" aria-label={t("M0 正则化强度与相对对数证据的合成曲线")}>
    {[45,95,145,195].map((y,i)=><g key={y}><line x1="40" x2="514" y1={y} y2={y} stroke="#e6ecea"/><text x="30" y={y+4} textAnchor="end" fontSize="11" fill="#84908f">{-i*30}</text></g>)}
    <path d={points.map((p,i)=>`${i?'L':'M'}${p[0]},${p[1]}`).join(' ')} stroke="#238f79" strokeWidth="2.5" fill="none"/>
    <line x1="267.52" x2="267.52" y1="28" y2="195" stroke="#238f79" strokeDasharray="4 4"/><circle cx="267.52" cy="38" r="5" fill="#238f79" stroke="white" strokeWidth="2"/>
    <text x="281" y="31" fontSize="11" fill="#247e6d">{t('示例最优 ln λ = {value}',{value:formatParameterNumber(2.84)})}</text>
    {[-1,1,3,5,7].map((v,i)=><text key={v} x={40+i*118.5} y="215" textAnchor="middle" fontSize="11" fill="#84908f">{formatParameterNumber(v)}</text>)}
    <text x="280" y="234" fontSize="11" textAnchor="middle" fill="#84908f">{t("ln λ · 全局正则化强度的自然对数")}</text>
  </svg><p>{t("纵轴：相对对数证据 Δln ε（示意）。M0 进行网格搜索，本图不是后验分布。")}</p></div>;
}
