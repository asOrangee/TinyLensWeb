export const designs = [
  { id: 'classic', number: '01', name: '原版工作台', english: 'Sage workspace', title: '每一个阶段，都有迹可循', subtitle: '检查模型，理解结果，与 Agent 一起推进透镜建模。', description: '灰绿配色、横向阶段导航、三图并排与右侧协作栏。', focus: '均衡浏览 · 保留初版', palette: ['#13242c', '#f6f8f8', '#277d68'] },
  { id: 'observatory', number: '02', name: '深色观测台', english: 'Observatory', title: '透镜观测台', subtitle: '图像优先 · 从观测、模型到残差', description: '深色画布、琥珀色强调，放大观测主图，模型和残差纵向排列。', focus: '图像检查 · 主次分明', palette: ['#0b1019', '#182230', '#efb773'] },
  { id: 'paper', number: '03', name: '研究手记', english: 'Research notebook', title: '透镜建模记录', subtitle: '从阶段记录，到可追溯的科学判断', description: '暖白纸面、衬线标题与砖红批注，阶段目录在左，协作区在结果下方。', focus: '阅读解释 · 阶段记录', palette: ['#f4efe5', '#2e302c', '#a34b37'] },
  { id: 'studio', number: '04', name: 'Mac 工作台', english: 'Native studio', title: 'Einstein arc', subtitle: 'TL-DEMO-001 · 单透镜星系 · 合成样例', description: '浅灰侧栏、蓝色选中态和紧凑工具栏，图像与 Inspector 并排。', focus: '高密度操作 · 桌面应用', palette: ['#e9edf3', '#ffffff', '#2463db'] },
] as const;
export type DesignId = (typeof designs)[number]['id'];
export function isDesign(value: unknown): value is DesignId {
  return designs.some(design => design.id === value);
}
export function readDesign(): DesignId {
  const query = new URLSearchParams(window.location.search).get('design');
  if (isDesign(query)) return query;
  try { const saved = localStorage.getItem('tinylens-design-v1'); if (isDesign(saved)) return saved; } catch { /* Visual preferences are optional. */ }
  return 'classic';
}
