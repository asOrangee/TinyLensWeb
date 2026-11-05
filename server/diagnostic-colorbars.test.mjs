import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {validateFormattedColorbars} from './diagnostic-colorbars.mjs';

test('printed colorbar metadata cannot reverse tick order or substitute external images',()=>{
 const bar={gradient_src:'data:image/png;base64,iVBORw0KGgo=',top:0,height:1,ticks:[{position:0,value:3},{position:.5,value:0},{position:1,value:-3}]};
 const panels={residual:{}};validateFormattedColorbars({residual:bar},panels);
 for(const broken of [{...bar,gradient_src:'/demo/fake.png'},{...bar,height:4},{...bar,ticks:[...bar.ticks].reverse()},{...bar,ticks:[{position:0,value:NaN},...bar.ticks.slice(1)]}])assert.throws(()=>validateFormattedColorbars({residual:broken},panels));
 assert.throws(()=>validateFormattedColorbars({residual:bar,model:bar},panels));
});

const python=process.env.TINYLENS_RESULT_TEST_PYTHON||'python3';
const available=spawnSync(python,['-B','-c','import numpy,PIL']).status===0;
test('only a verified printed linear axis may fill a missed label; ambiguous or nonlinear text is refused',{skip:!available},()=>{
 const script=`import importlib.util
s=importlib.util.spec_from_file_location('bars','server/diagnostic_colorbars.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
rows=[0,10,20,30,40,50,60];height=61;total=height*3+40
def label(i,text):return {'text':text,'confidence':1,'box':[0,1-(rows[i]*3+20)/total-.01,1,.02]}
labels=[label(i,str(3-i)) for i in [0,1,3,4,5,6]]
ticks=m.calibrate(rows,labels,height)
assert [t['value'] for t in ticks]==[3,2,1,0,-1,-2,-3]
assert ticks[2]['interpolated'] and ticks[2]['source_text'] is None
assert all(not t['interpolated'] for i,t in enumerate(ticks) if i!=2)
for bad in [labels[:3],[label(0,'1e3'),*labels[1:]],[label(0,'4'),*labels[1:]],[labels[0],labels[0],*labels[1:]]]:
 try:m.calibrate(rows,bad,height)
 except ValueError:pass
 else:raise AssertionError('ambiguous calibration accepted')
`;
 const result=spawnSync(python,['-B','-c',script],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);
});
