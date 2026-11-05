import test from 'node:test';
import assert from 'node:assert/strict';
import {formatParameterNumber,groupParameters,parameterCategory,parameterEstimate,parameterNotation} from '../src/lib/parameter-presentation.ts';
import {stages,type Parameter} from '../src/data/stages.ts';
import {liveParameters} from '../src/lib/live-parameters.ts';
import type {LiveResult} from '../src/lib/live-results.ts';
const base={key:'theta_E',symbol:'θE',name:'',value:'1.407872',role:'sampled',unit:'arcsec',description:''} as Parameter;
test('display subscripts keep mass, lens-light and source-light identities without changing keys',()=>{
 for(const [key,symbol,label] of [['theta_E','θE','θ_E'],['center_x_mass','xmass','x_lens_mass'],['center_y_mass','ymass','y_lens_mass'],['center_x_lens_1','xlens,1','x_lens_light_1'],['center_y_lens_1','ylens,1','y_lens_light_1'],['e1_lens_1','e₁,lens,1','e_1 lens_light_1'],['e2_lens_1','e₂,lens,1','e_2 lens_light_1'],['center_x_lens_2','xlens,2','x_lens_light_2'],['center_y_lens_2','ylens,2','y_lens_light_2'],['e1_lens_2','e₁,lens,2','e_1 lens_light_2'],['e2_lens_2','e₂,lens,2','e_2 lens_light_2'],['lens_mge_amplitudes','aj','a_j_lens_light'],['e1_src','e₁,src','e_1_src'],['gamma1','γ₁','γ_1'],['log_lambda_reg','ln λ*','ln λ_reg^*']]){const p={key,symbol},copy={...p};assert.equal(parameterNotation(p).label,label);assert.deepEqual(p,copy);}
 assert.equal(parameterNotation({key:'unknown',symbol:'κ'}).label,'κ');
});
test('five-place estimates subtract unrounded asymmetric quantiles before rounding',()=>{
 const p={...base,quantiles:{q16:1.4073841117342283,q50:1.407872200012207,q84:1.4083311557769775}},result=parameterEstimate(p,true);
 assert.equal(result.text,'1.40787');assert.equal(result.upper,'0.00046');assert.equal(result.lower,'0.00049');assert.equal(p.quantiles.q50,1.407872200012207);
 const subtle=parameterEstimate({...base,quantiles:{q16:1.000004,q50:1.000009,q84:1.000014}},true);assert.equal(subtle.upper,'0.00001');
});
test('fixed quantities and missing real posteriors never inherit synthetic errors',()=>{
 for(const p of [{...base,role:'fixed' as const,mean:99,sigma:5},{...base,mean:99,sigma:5},{...base,quantiles:{q16:2,q50:1,q84:3}},{...base,role:'setting' as const,quantiles:{q16:0,q50:1,q84:2}}]){const r=parameterEstimate(p,true);assert.equal(r.text,'1.40787');assert.equal(r.upper,undefined);assert.equal(r.lower,undefined);}
 const missing=parameterEstimate({...base,value:'—'},true);assert.equal(missing.text,'—');assert.equal(missing.upper,undefined);
 const demo=parameterEstimate({...base,mean:1.2,sigma:.03});assert.equal(demo.text,'1.20000');assert.equal(demo.upper,'0.03000');assert.equal(demo.lower,'0.03000');
});
test('all numeric parameter forms retain five decimals and nonnumeric states remain states',()=>{
 assert.equal(formatParameterNumber(-.0000001),'0.00000');assert.equal(formatParameterNumber(0),'0.00000');assert.equal(formatParameterNumber(-3.27794592488),'-3.27795');assert.equal(formatParameterNumber(NaN),'—');
 assert.equal(parameterEstimate({...base,value:'−0.018',role:'fixed'}).text,'-0.01800');assert.equal(parameterEstimate({...base,value:'80 × 80',role:'setting'}).text,'80.00000 × 80.00000');assert.equal(parameterEstimate({...base,value:'条件线性解',role:'linear'}).text,'条件线性解');
});
test('all modeling-stage physical parameters have one explicit lens or source category',()=>{
 for(const stage of stages.filter(s=>!['preflight','b'].includes(s.id))){const grouped=groupParameters(stage.parameters);assert.deepEqual(new Set(grouped.flatMap(g=>g.parameters.map(p=>p.key))),new Set(stage.parameters.map(p=>p.key)));assert.ok(stage.parameters.every(p=>parameterCategory(p.key)));}
 const grouped=groupParameters(stages.find(s=>s.id==='a')!.parameters);assert.deepEqual(grouped.map(g=>g.label),['Lens mass','Lens light','Source light']);assert.equal(grouped[1].parameters.filter(p=>/_lens_[12]$/.test(p.key)).length,8);assert.equal(parameterCategory('adaptive_reg_rho'),'source-light');assert.equal(parameterCategory('new_unknown_parameter'),undefined);
});
test('reported lens-light groups and fixed mass fields enter the same curated table',()=>{
 const a=stages.find(s=>s.id==='a')!,summary={stage:'a',path:'/a',attempt:0,sha256:'hash',result:{metrics:{posterior_quantiles:{e1_lens_1:{q16:-.04,q50:-.037467181404941416,q84:-.036}}}}} as LiveResult;
 const row=liveParameters(a,summary).find(p=>p.key==='e1_lens_1')!;assert.equal(row.quantiles?.q50,-.037467181404941416);assert.equal(parameterEstimate(row,true).text,'-0.03747');
 const m2=stages.find(s=>s.id==='m2')!,fixed={kind:'weighted_posterior',parameters:[],fixed_parameters:{center_x_mass:-.016206387357967002}} as unknown as LiveResult;
 const center=liveParameters(m2,undefined,fixed).find(p=>p.key==='center_x_mass')!;assert.equal(center.role,'fixed');assert.equal(parameterEstimate(center,true).text,'-0.01621');assert.equal(center.quantiles,undefined);
});
test('fixed values from the display adapter require the same summary hash and attempt',()=>{
 const stage=stages.find(s=>s.id==='m0')!,summary={stage:'m0',path:'/m0',attempt:0,sha256:'saved',result:{metrics:{}}} as LiveResult,model={...summary,display_mapping:{model:{theta_E:1.407872200012207}}} as LiveResult;
 assert.equal(parameterEstimate(liveParameters(stage,summary,undefined,model).find(p=>p.key==='theta_E')!,true).text,'1.40787');
 for(const change of [{sha256:'foreign'},{attempt:1},{path:'/different'},{stage:'m1'}])assert.equal(liveParameters(stage,summary,undefined,{...model,...change}).find(p=>p.key==='theta_E')!.value,'—');
});
