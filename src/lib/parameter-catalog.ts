import { stages, type Parameter, type Stage } from '../data/stages.ts';
import { mgeReference } from '../data/scientific-references.ts';
import { modelConfigurationCards } from './model-configuration.ts';

const widths: Parameter[] = [
  { key:'lens_mge_sigmas',symbol:'σⱼ,lens',name:'透镜光 MGE 高斯宽度',value:'—',unit:'arcsec',role:'fixed',description:'透镜星系光 MGE 中第 j 个椭圆高斯的角宽度，决定该分量描述的空间尺度。本次流程预先生成这些宽度并保持固定，高斯光强系数另行求解。',reference:mgeReference.url },
  { key:'source_mge_sigmas',symbol:'σⱼ,src',name:'源光 MGE 高斯宽度',value:'—',unit:'arcsec',role:'fixed',description:'背景源光 MGE 中第 j 个椭圆高斯的角宽度，定义在源平面的角坐标中。本次流程预先生成这些宽度，拟合时保持固定。',reference:mgeReference.url },
];

/** Handbook metadata can cover fixed/inherited model parameters without adding
 * them to a stage's numerical results or inventing measurements. */
export function catalogParameters(stage: Stage): Parameter[] {
  const entries = new Map(stage.parameters.map(parameter => [parameter.key, parameter]));
  for (const parameter of modelConfigurationCards(stage.id).flatMap(card => card.parameters)) {
    if (entries.has(parameter.key)) continue;
    const definition = widths.find(item => item.key === parameter.key) ?? stages.flatMap(item => item.parameters).find(item => item.key === parameter.key);
    if (!definition) continue;
    entries.set(parameter.key, { key:definition.key,symbol:definition.symbol,name:definition.name,description:definition.description,unit:definition.unit,reference:definition.reference,value:'—',role:parameter.role==='scan'?'setting':parameter.role });
  }
  return [...entries.values()];
}
