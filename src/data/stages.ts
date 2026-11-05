import { mgeReference } from './scientific-references.ts';

/**
 * Curated scientific copy for the local UI prototype.
 * ALL numerical results below are fictional demonstration values, not server
 * measurements, real posterior samples, or evidence for scientific acceptance.
 * `mean` and `sigma` are used ONLY to draw illustrative posterior-shaped curves.
 * Parameter lists are representative, not an exhaustive parameter manifest.
 */
export type StageId = 'preflight' | 'a' | 'b' | 'm0' | 'm1' | 'm2' | 'm3';

export interface Parameter {
  key: string;
  symbol: string;
  name: string;
  value: string;
  rawValue?: string;
  interval?: string;
  unit: string;
  role: 'sampled' | 'fixed' | 'linear' | 'setting';
  description: string;
  reference?: string;
  mean?: number;
  sigma?: number;
  numericValue?: number;
  quantiles?: { q16: number; q50: number; q84: number };
}

export interface Stage {
  id: StageId;
  code: string;
  title: string;
  english: string;
  description: string;
  model: string;
  parameters: Parameter[];
  references: { label: string; url: string }[];
  review: string;
  outputs: string[];
}

const papers = {
  mge: { ...mgeReference, label: `${mgeReference.label} · MGE 光分布` },
  sersic: { label: 'Graham & Driver 2005 · Sérsic 轮廓', url: 'https://arxiv.org/pdf/astro-ph/0503176' },
  epl: { label: 'Tessore & Metcalf 2015 · 椭圆幂律透镜', url: 'https://arxiv.org/pdf/1507.01819' },
  inversion: { label: 'Warren & Dye 2003 · 半线性源反演', url: 'https://arxiv.org/pdf/astro-ph/0302587' },
  regularization: { label: 'Suyu et al. 2006 · 贝叶斯正则化', url: 'https://arxiv.org/pdf/astro-ph/0601493' },
};

const theta = (value: number, sigma: number): Parameter => ({
  key: 'theta_E', symbol: 'θE', name: '爱因斯坦角尺度', value: value.toFixed(3),
  interval: `± ${sigma.toFixed(3)}`, unit: 'arcsec', role: 'sampled', mean: value, sigma,
  description: '透镜质量模型的角尺度；在圆对称极限下对应爱因斯坦半径。椭圆模型中的定义需与所用质量轮廓一致。', reference: papers.epl.url,
});

const shape = (axis: 1 | 2, value: number, sigma: number): Parameter => ({
  key: `e${axis}_mass`, symbol: `e${axis === 1 ? '₁' : '₂'}`, name: `质量椭率分量 ${axis}`,
  value: value.toFixed(3), interval: `± ${sigma.toFixed(3)}`, unit: '无量纲', role: 'sampled', mean: value, sigma,
  description: '与另一个椭率分量共同描述投影质量分布的扁率与朝向。它不是轴比本身；转换公式与角度约定以 TinyLens 的参数定义为准。', reference: papers.epl.url,
});

const shear = (axis: 1 | 2, value: number, sigma: number): Parameter => ({
  key: `gamma${axis}`, symbol: `γ${axis === 1 ? '₁' : '₂'}`, name: `外剪切分量 ${axis}`,
  value: value.toFixed(3), interval: `± ${sigma.toFixed(3)}`, unit: '无量纲', role: 'sampled', mean: value, sigma,
  description: '描述邻近结构及视线环境对成像产生的近似潮汐形变。两个分量共同决定剪切强度和方向；与 EPL 的密度斜率 γ 是不同参数。',
});

const fixedCenter = (axis: 'x' | 'y', value: string): Parameter => ({
  key: `center_${axis}_mass`, symbol: `${axis}mass`, name: `质量中心 ${axis}`,
  value, unit: 'arcsec', role: 'fixed',
  description: '质量分布中心相对图像参考中心的角偏移。本阶段固定采用 Stage A 的结果，不产生新的该参数后验。',
});

const logLambda = (value: number, sigma: number, adaptive = false): Parameter => ({
  key: 'log_lambda_reg', symbol: 'ln λ', name: '对数正则化强度',
  value: value.toFixed(3), interval: `± ${sigma.toFixed(3)}`, unit: '代码归一化', role: 'sampled', mean: value, sigma,
  description: adaptive
    ? '控制源反演中结构先验的整体权重，并与自适应参数一起调节平滑程度。它是推断超参数，数值依赖网格与代码归一化；这里使用自然对数。'
    : '在 M0 标定值附近用窄先验继续采样，控制像素化源的整体正则化强度。它是推断超参数，不是天体物理量；这里使用自然对数。',
  reference: papers.regularization.url,
});

// Stage A's _mge("lens", two_groups=True) shares these four parameters
// within each group. Metadata only: no additional demo measurements.
const lensLightParameters: Parameter[] = [1, 2].flatMap(group => [
  ...(['x', 'y'] as const).map(axis => ({key:`center_${axis}_lens_${group}`,symbol:`${axis}lens,${group}`,name:`透镜光第 ${group} 组中心 ${axis}`,value:'—',unit:'arcsec',role:'sampled' as const,description:`透镜光第 ${group} 组 MGE 高斯分量共用的 ${axis} 中心角坐标，相对当前图像参考中心定义。`,reference:papers.mge.url})),
  ...([1, 2] as const).map(axis => ({key:`e${axis}_lens_${group}`,symbol:`e${axis===1?'₁':'₂'},lens,${group}`,name:`透镜光第 ${group} 组椭率分量 ${axis}`,value:'—',unit:'无量纲',role:'sampled' as const,description:`透镜光第 ${group} 组 MGE 高斯分量共用的形状分量；与该组另一分量共同描述光分布的扁率和朝向，约定沿用实际实现。`,reference:papers.mge.url})),
]);

export const stages: Stage[] = [
  {
    id: 'preflight', code: 'P', title: '系统预检', english: 'System inspection',
    description: '读取输入图像，检查系统形态与污染源。三个独立 Inspector 的意见经过综合，决定是否进入建模，并生成统一的有效建模区域。',
    model: '3 个独立 Inspector · 综合审查',
    parameters: [
      { key: 'modeling_radius', symbol: 'Rmask', name: '建模半径', value: '4.0', unit: 'arcsec', role: 'fixed', description: '仅使用参考中心周围此角半径内的有效像素；圆外区域从后续拟合中排除。' },
      { key: 'detection_threshold', symbol: 'S/N', name: '分割阈值', value: '3.0', unit: 'σ', role: 'fixed', description: '分割图使用达到三倍局部噪声的正信号；这是像素检测门槛，不是整个透镜系统的探测显著性。' },
      { key: 'minimum_connected_pixels', symbol: 'Nmin', name: '最小连通像素', value: '5', unit: 'pixel', role: 'fixed', description: '连续达到分割阈值的像素至少达到此数量才构成检测区域，帮助排除孤立噪声峰。' },
      { key: 'inspector_count', symbol: 'Nvote', name: '独立审查数', value: '3', unit: '份', role: 'fixed', description: '三位 Inspector 独立审查。综合结论遵循现有投票规则，并保留每份原始意见。' },
    ],
    references: [],
    review: '预检展示三个独立意见及其综合结论。当前为演示记录；真实预检与建模许可需要由服务器返回。',
    outputs: ['preflight_2panel.png', 'preflight_6panel.png', 'segmentation.fits', 'modeling_mask.fits', 'synthesis.json'],
  },
  {
    id: 'a', code: 'A', title: '初步联合建模', english: 'Parametric foundation',
    description: '联合拟合透镜星系光、背景源光与 SIE + 外剪切质量模型，建立初始成像关系。当前 pipeline 的两类光分布均使用 MGE，Sérsic 选择尚待后端接入。',
    model: 'SIE + Shear · MGE lens · MGE source',
    parameters: [
      theta(1.686, 0.027), shape(1, 0.142, 0.019), shape(2, -0.083, 0.017),
      { key: 'center_x_mass', symbol: 'xmass', name: '质量中心 x', value: '0.012', interval: '± 0.008', unit: 'arcsec', role: 'sampled', mean: 0.012, sigma: 0.008, description: '质量分布中心相对图像参考中心的 x 方向角偏移。参考中心与坐标轴方向由图像坐标定义。' },
      { key: 'center_y_mass', symbol: 'ymass', name: '质量中心 y', value: '−0.018', interval: '± 0.009', unit: 'arcsec', role: 'sampled', mean: -0.018, sigma: 0.009, description: '质量分布中心相对图像参考中心的 y 方向角偏移；并非天球上的绝对赤纬。' },
      shear(1, 0.031, 0.008), shear(2, -0.016, 0.007),
      ...lensLightParameters,
      { key: 'lens_mge_amplitudes', symbol: 'aⱼ,lens', name: '透镜光 MGE 光强系数', value: '线性求解', unit: '模型归一化', role: 'linear', description: '给定当前非线性参数后，由非负线性求解确定透镜光各高斯基函数的幅度；不将条件线性解当作采样后验。', reference: papers.mge.url },
      { key: 'center_x_src', symbol: 'xsrc', name: '源光中心 x', value: '0.064', interval: '± 0.012', unit: 'arcsec', role: 'sampled', mean: 0.064, sigma: 0.012, description: '背景源在源平面的中心角坐标。它参与确定后续像素化源网格的中心，而非像平面上某条弧的位置。', reference: papers.mge.url },
      { key: 'center_y_src', symbol: 'ysrc', name: '源光中心 y', value: '0.041', interval: '± 0.010', unit: 'arcsec', role: 'sampled', mean: 0.041, sigma: 0.010, description: '背景源在源平面的中心角坐标。MGE 的同组高斯分量共用中心，后验中位数用于后续源网格定位。', reference: papers.mge.url },
      { key: 'e1_src', symbol: 'e₁,src', name: '源光椭率分量 1', value: '0.105', interval: '± 0.032', unit: '无量纲', role: 'sampled', mean: 0.105, sigma: 0.032, description: '描述参数化源光的形状分量。同组 MGE 高斯分量共用形状参数；与另一分量一起决定扁率和朝向。', reference: papers.mge.url },
      { key: 'e2_src', symbol: 'e₂,src', name: '源光椭率分量 2', value: '−0.052', interval: '± 0.029', unit: '无量纲', role: 'sampled', mean: -0.052, sigma: 0.029, description: '与 e₁,src 联合描述参数化源光形状。这里展示主要参数示例；透镜光 MGE 另有各组共用的中心与形状参数。', reference: papers.mge.url },
      { key: 'source_mge_amplitudes', symbol: 'aⱼ,src', name: '源光 MGE 光强系数', value: '线性求解', unit: '模型归一化', role: 'linear', description: '给定当前非线性参数后，由非负线性求解确定源光各高斯基函数的幅度；基函数宽度固定，不将条件线性解当作采样后验。', reference: papers.mge.url },
    ],
    references: [papers.mge, papers.sersic, papers.epl],
    review: '检查主要多重像的对应关系、透镜光与弧的分离，以及质量参数是否受先验边界限制。局部残差可保留为后续像素化源拟合的待检问题。',
    outputs: ['stage_a.pkl', 'stage_a_model.png', 'stage_a_predicted_image_family.json'],
  },
  {
    id: 'b', code: 'B', title: '透镜弧掩膜', english: 'Arc mask refinement',
    description: '扣除 Stage A 的透镜星系光，根据剩余信号构造透镜弧支持区域。检查遗漏的弧、无关成分和边界，在图像上直接修订需要保留的拟合区域。',
    model: '残差信噪比 · 连通区域 · 掩膜修订',
    parameters: [
      { key: 'arc_snr_threshold', symbol: 'S/Nmin', name: '弧信噪比阈值', value: '3.0', unit: 'σ', role: 'setting', description: '用（观测图像 − A 的透镜光模型）/ 噪声识别显著源光。较低阈值可纳入暗弧，也可能纳入更多噪声或透镜光残差。' },
      { key: 'arc_ignor_size', symbol: 'Nmin', name: '小区域过滤尺度', value: '5', unit: 'pixel', role: 'setting', description: '用于过滤过小的检测区域，避免零散信号主导掩膜。这里的数值为界面演示配置。' },
      { key: 'arc_ext_size', symbol: 'dext', name: '区域扩展尺度', value: '2', unit: 'pixel', role: 'setting', description: '控制已检测弧区域向周围扩展的像素尺度，帮助覆盖弧的外围信号；扩展仍应受有效建模区域约束。' },
      { key: 'arc_close_size', symbol: 'dclose', name: '闭运算尺度', value: '3', unit: 'pixel', role: 'setting', description: '控制形态学闭运算的空间尺度，帮助连接小间隙与填补局部孔洞；它是图像处理设置，不是物理参数。' },
    ],
    references: [],
    review: '重点检查所有主要透镜像是否被保留、无关目标是否被排除。绿色区域表示用于拟合的弧支持区域；本阶段没有参数采样后验。',
    outputs: ['feature_mask.fits', 'stage_b_components.json', 'stage_b_morphology_audit.png', 'stage_b_morphology_audit.json'],
  },
  {
    id: 'm0', code: 'M0', title: '源网格与正则化', english: 'Source grid calibration',
    description: '固定 A 的质量模型，引入像素化源并扫描正则化强度。检查源光是否延伸到网格边界；接受后固定网格，供 M1–M3 共用。',
    model: '固定 SIE + Shear · 一阶正则化',
    parameters: [
      { key: 'log_lambda_reg', symbol: 'ln λ*', name: '最佳扫描值', value: '2.840', unit: '代码归一化', role: 'setting', description: '粗、细两轮网格扫描中证据最高位置的自然对数正则化强度。该值来自扫描，曲线不是采样后验。', reference: papers.regularization.url },
      { key: 'regularization_type', symbol: 'R', name: '正则化形式', value: 'first-order', unit: '固定', role: 'fixed', description: '一阶正则化约束相邻源像素的亮度差。当前 pipeline 固定使用此形式，前端不提供尚未接入的类型切换。', reference: papers.regularization.url },
      { key: 'source_pixel_scale', symbol: 'Δβ', name: '源平面像素尺度', value: '0.020', unit: 'arcsec / pixel', role: 'fixed', description: '每个源像素覆盖的角尺度。当前流程扩展网格时保持此尺度不变。' },
      { key: 'source_grid_shape', symbol: 'Nsrc', name: '源网格尺寸', value: '80 × 80', unit: 'pixel', role: 'setting', description: '初始源网格有 80 × 80 个像素。若相干源光被边界截断，可依规则扩展至 100 × 100 或 120 × 120。' },
      { key: 'source_grid_half_extent', symbol: 'βmax', name: '网格半宽', value: '0.80', unit: 'arcsec', role: 'setting', description: '以 A 的源中心为锚点，网格外边界初始向四周延伸 0.8 角秒；只有 M0 可以按规定扩大网格。' },
      { key: 'theta_E', symbol: 'θE', name: '固定质量角尺度', value: '1.686', unit: 'arcsec', role: 'fixed', description: '沿用 Stage A 接受结果的质量角尺度；此阶段扫描正则化，不重新采样透镜质量参数。', reference: papers.epl.url },
      fixedCenter('x', '0.012'), fixedCenter('y', '−0.018'),
    ],
    references: [papers.inversion, papers.regularization],
    review: 'M0 专家只判断源网格是否截断连续的真实源光，不承担最终质量模型审查。界面展示证据扫描与网格诊断，不虚构 M0 后验。',
    outputs: ['stage_m0.pkl', 'source_grid_spec.json', 'stage_m0_source_grid.png', 'stage_m0_model.png'],
  },
  {
    id: 'm1', code: 'M1', title: '像素化源建模', english: 'Pixelized source inference',
    description: '在 M0 确定的网格上重建像素化源，并重新拟合 SIE + 外剪切。正则化强度在 M0 附近继续采样，为后续阶段提供质量参数与源模板。',
    model: 'SIE + Shear · 像素化源',
    parameters: [
      theta(1.698, 0.018), shape(1, 0.151, 0.014), shape(2, -0.078, 0.013),
      shear(1, 0.029, 0.006), shear(2, -0.018, 0.006), logLambda(2.872, 0.116),
      fixedCenter('x', '0.012'), fixedCenter('y', '−0.018'),
      { key: 'source_brightness', symbol: 'sᵢ', name: '源像素亮度', value: '条件线性解', unit: '模型亮度', role: 'linear', description: '给定当前质量模型与正则化超参数后，通过线性反演求解的源像素亮度。这里的重建图不能等同于逐像素完整后验。', reference: papers.inversion.url },
      { key: 'source_grid_shape', symbol: 'Nsrc', name: '源网格尺寸', value: '80 × 80', unit: 'pixel', role: 'fixed', description: '沿用 M0 已接受并固定的网格。本阶段若发现新的真实截断，应进入人工审查而不是自行扩大网格。' },
    ],
    references: [papers.inversion, papers.regularization],
    review: '检查像素化源是否支持可信的 SIE 成像关系，以及从 A 到 M1 的变化是否有观测依据。未解决的结构性问题需要明确记录。',
    outputs: ['stage_m1.pkl', 'stage_m1_model.png', 'M1 source template'],
  },
  {
    id: 'm2', code: 'M2', title: '自适应正则化', english: 'Adaptive regularization',
    description: '固定 M1 的质量几何，以 M1 的源模板构造随位置变化的正则化。本阶段只采样正则化超参数，源亮度随每组超参数重新求解。',
    model: '固定 M1 质量模型 · 自适应正则化',
    parameters: [
      logLambda(2.416, 0.238, true),
      { key: 'adaptive_reg_rho', symbol: 'ρreg', name: '自适应正则化参数', value: '1.820', interval: '± 0.260', unit: '无量纲', role: 'sampled', mean: 1.82, sigma: 0.26, description: '与固定的 M1 源模板共同控制正则化在不同位置的变化。它是算法超参数，不是物质密度；精确作用公式需要与当前 TinyLens 实现对应。', reference: papers.regularization.url },
      { key: 'theta_E', symbol: 'θE', name: '固定质量角尺度', value: '1.698', unit: 'arcsec', role: 'fixed', description: '采用 M1 的质量参数中位数。M2 不重新拟合质量几何，因此不能通过调正则化修复错误的成像结构。', reference: papers.epl.url },
      { key: 'e1_mass', symbol: 'e₁', name: '固定质量椭率 1', value: '0.151', unit: '无量纲', role: 'fixed', description: '沿用 M1 的质量形状分量，本阶段不重新采样。' },
      { key: 'e2_mass', symbol: 'e₂', name: '固定质量椭率 2', value: '−0.078', unit: '无量纲', role: 'fixed', description: '沿用 M1 的质量形状分量，与另一分量共同定义投影质量形状。' },
      { key: 'gamma1', symbol: 'γ₁', name: '固定外剪切 1', value: '0.029', unit: '无量纲', role: 'fixed', description: '沿用 M1 的外剪切分量，不纳入本阶段的自由参数。' },
      { key: 'gamma2', symbol: 'γ₂', name: '固定外剪切 2', value: '−0.018', unit: '无量纲', role: 'fixed', description: '沿用 M1 的外剪切分量，不纳入本阶段的自由参数。' },
      { key: 'source_brightness', symbol: 'sᵢ', name: '源像素亮度', value: '重新求解', unit: '模型亮度', role: 'linear', description: '用于自适应正则化的源模板固定，但最终源亮度仍会随着超参数更新而重新反演。', reference: papers.inversion.url },
    ],
    references: [papers.regularization, papers.inversion],
    review: '关注正则化后验是否可用、空间权重是否稳定、主要源结构是否保留。质量几何固定，因此不能将残差变化直接归因于质量模型改善。',
    outputs: ['stage_m2.pkl', 'stage_m2_model.png', 'regularization hyperparameters'],
  },
  {
    id: 'm3', code: 'M3', title: '最终宏模型', english: 'Final mass inference',
    description: '将质量模型扩展为 EPL + 外剪切，释放径向密度斜率，并使用 M2 标定的正则化完成最终宏模型拟合。当前 pipeline 的质量模型形式固定为 EPL + Shear。',
    model: 'EPL + Shear · 固定自适应正则化',
    parameters: [
      theta(1.702, 0.016),
      { key: 'gamma', symbol: 'γ', name: 'EPL 径向斜率', value: '2.064', interval: '± 0.072', unit: '无量纲', role: 'sampled', mean: 2.064, sigma: 0.072, description: '控制 EPL 质量分布的径向变化，区别于外剪切 γ₁、γ₂。论文使用投影斜率 t；最终参数说明需核对 TinyLens 中 γ 与 t 的转换约定。', reference: papers.epl.url },
      shape(1, 0.149, 0.013), shape(2, -0.081, 0.012),
      shear(1, 0.027, 0.006), shear(2, -0.019, 0.005),
      fixedCenter('x', '0.012'), fixedCenter('y', '−0.018'),
      { key: 'log_lambda_reg', symbol: 'ln λ', name: '固定正则化强度', value: '2.416', unit: '代码归一化', role: 'fixed', description: '沿用 M2 的正则化强度，本阶段不重新采样该超参数；参数采用自然对数。', reference: papers.regularization.url },
      { key: 'adaptive_reg_rho', symbol: 'ρreg', name: '固定自适应参数', value: '1.820', unit: '无量纲', role: 'fixed', description: '沿用 M2 的自适应正则化参数，与 M1 源模板和 M0 网格共同定义源反演设置。', reference: papers.regularization.url },
      { key: 'source_brightness', symbol: 'sᵢ', name: '最终源亮度', value: '条件线性解', unit: '模型亮度', role: 'linear', description: '对每组质量参数重新求解源亮度，最后展示代表性重建。重建图与质量参数后验应分别解读。', reference: papers.inversion.url },
    ],
    references: [papers.epl, papers.inversion, papers.regularization],
    review: '最终科学审查需要确认主要透镜像对应、临界线与源重建可信，并解释剩余残差是否影响质量模型解释。程序完成并不等于科学接受。',
    outputs: ['stage_m3.pkl', 'stage_m3_model.png', 'review.json', 'accepted/m3.json'],
  },
];

export function getStage(id: StageId): Stage {
  return stages.find((stage) => stage.id === id) ?? stages[0];
}
