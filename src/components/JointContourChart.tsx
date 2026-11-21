import { useEffect, useRef } from 'react';
import type { Parameter } from '../data/stages';
import { useDemoI18n } from '../lib/demo-i18n';
import { parameterNotation } from '../lib/parameter-presentation';
import type { JointDensity } from '../lib/stage-artifacts';
import ParameterSymbol from './ParameterSymbol';

type AxisParameter = Pick<Parameter, 'key' | 'symbol'>;
type AxisMedians = readonly [number | undefined, number | undefined];

const contourColors = {
  outer: { fill: 'rgba(59, 130, 208, .24)', line: '#5b90c6' },
  inner: { fill: 'rgba(41, 104, 189, .60)', line: '#2864ac' },
};

function chartBounds(data: JointDensity, [xMedian, yMedian]: AxisMedians) {
  let left = xMedian ?? Infinity, right = xMedian ?? -Infinity;
  let bottom = yMedian ?? Infinity, top = yMedian ?? -Infinity;
  for (const contour of data.contours) for (const polygon of contour.polygons) for (const ring of polygon) {
    for (const [x, y] of ring) {
      left = Math.min(left, x); right = Math.max(right, x);
      bottom = Math.min(bottom, y); top = Math.max(top, y);
    }
  }
  if (!(left < right && bottom < top)) return data.bounds;
  const padX = (right - left) * .12, padY = (top - bottom) * .12;
  return [Math.max(data.bounds[0], left - padX), Math.min(data.bounds[1], right + padX),
    Math.max(data.bounds[2], bottom - padY), Math.min(data.bounds[3], top + padY)];
}

function ticks(low: number, high: number) {
  const target = (high - low) / 4;
  const power = 10 ** Math.floor(Math.log10(target));
  const interval = [1, 2, 2.5, 5, 10].map(step => step * power)
    .reduce((best, step) => Math.abs(Math.log(step / target)) < Math.abs(Math.log(best / target)) ? step : best);
  const first = Math.ceil(low / interval - 1e-12) * interval;
  const decimals = Math.min(12, Math.max(0, 1 - Math.floor(Math.log10(interval))));
  return Array.from({ length: 8 }, (_, i) => first + i * interval)
    .filter(value => Number.isFinite(value) && value >= low && value <= high)
    .map(value => ({ value, label: Math.abs(value) >= 1e5 || interval < 1e-5
      ? value.toExponential(3) : Number(value.toFixed(decimals)).toString() }));
}

function drawPlot(canvas: HTMLCanvasElement, data: JointDensity, medians: AxisMedians) {
  const ctx = canvas.getContext('2d');
  const container = canvas.parentElement;
  if (!ctx || !container) return;
  const { width, height } = canvas.getBoundingClientRect();
  if (width < 180 || height < 160) return;
  const pixelRatio = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * pixelRatio);
  canvas.height = Math.round(height * pixelRatio);
  ctx.setTransform(canvas.width / width, 0, 0, canvas.height / height, 0, 0);
  const [xmin, xmax, ymin, ymax] = chartBounds(data, medians);
  const xTicks = ticks(xmin, xmax), yTicks = ticks(ymin, ymax);
  const style = getComputedStyle(canvas);
  ctx.font = `${style.fontSize} ${style.fontFamily}`;
  const widestYTick = Math.ceil(Math.max(0, ...yTicks.map(tick => ctx.measureText(tick.label).width)));
  const leftMargin = widestYTick + 45, rightMargin = 16, topMargin = 14, bottomMargin = 54;
  const availableWidth = width - leftMargin - rightMargin;
  const availableHeight = height - topMargin - bottomMargin;
  const side = Math.min(availableWidth, availableHeight);
  if (side <= 0) return;
  const left = leftMargin + (availableWidth - side) / 2;
  const top = topMargin + (availableHeight - side) / 2;
  const bottom = top + side;
  const sx = (x: number) => left + (x - xmin) * side / (xmax - xmin);
  const sy = (y: number) => top + (ymax - y) * side / (ymax - ymin);
  container.parentElement?.style.setProperty('--joint-plot-right-space', `${width - left - side}px`);
  container.style.setProperty('--joint-x-label-left', `${left + side / 2}px`);
  container.style.setProperty('--joint-x-label-top', `${bottom + 27}px`);
  container.style.setProperty('--joint-y-label-left', `${left - widestYTick - 25}px`);
  container.style.setProperty('--joint-y-label-top', `${top + side / 2}px`);

  ctx.strokeStyle = style.getPropertyValue('--line').trim() || '#cbd5e1';
  ctx.beginPath();
  for (const tick of xTicks) { const x = sx(tick.value); ctx.moveTo(x, top); ctx.lineTo(x, bottom); }
  for (const tick of yTicks) { const y = sy(tick.value); ctx.moveTo(left, y); ctx.lineTo(left + side, y); }
  ctx.stroke();

  ctx.save();
  ctx.beginPath(); ctx.rect(left, top, side, side); ctx.clip();
  for (const contour of data.contours.slice().sort((a, b) => b.probability - a.probability)) {
    const color = contour.probability === .68 ? contourColors.inner : contourColors.outer;
    ctx.fillStyle = color.fill;
    ctx.strokeStyle = color.line;
    ctx.lineWidth = 1.35;
    for (const polygon of contour.polygons) {
      ctx.beginPath();
      for (const ring of polygon) {
        ctx.moveTo(sx(ring[0][0]), sy(ring[0][1]));
        for (const [x, y] of ring.slice(1)) ctx.lineTo(sx(x), sy(y));
        ctx.closePath();
      }
      ctx.fill('evenodd'); ctx.stroke();
    }
  }
  const [xMedian, yMedian] = medians;
  if (xMedian !== undefined || yMedian !== undefined) {
    ctx.strokeStyle = style.color;
    ctx.lineWidth = 1.35;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    if (xMedian !== undefined) {
      const x = sx(xMedian);
      ctx.moveTo(x, top);
      ctx.lineTo(x, bottom);
    }
    if (yMedian !== undefined) {
      const y = sy(yMedian);
      ctx.moveTo(left, y);
      ctx.lineTo(left + side, y);
    }
    ctx.stroke();
  }
  ctx.restore();

  ctx.strokeStyle = style.color;
  ctx.lineWidth = .75;
  ctx.strokeRect(left, top, side, side);
  ctx.fillStyle = style.color;
  ctx.textAlign = 'center';
  for (const tick of xTicks) ctx.fillText(tick.label, sx(tick.value), bottom + 17);
  ctx.textAlign = 'right';
  for (const tick of yTicks) ctx.fillText(tick.label, left - 8, sy(tick.value) + 3);
}

export function JointContourChart({ data, axes, medians: [xMedian, yMedian] }: {
  data: JointDensity; axes: readonly [AxisParameter, AxisParameter]; medians: AxisMedians;
}) {
  const { t } = useDemoI18n();
  const chart = useRef<HTMLCanvasElement>(null);
  const [x, y] = axes;
  useEffect(() => {
    const canvas = chart.current;
    if (!canvas) return;
    const draw = () => drawPlot(canvas, data, [xMedian, yMedian]);
    const size = new ResizeObserver(draw);
    size.observe(canvas);
    const theme = new MutationObserver(draw);
    const shell = canvas.closest('.app-shell');
    if (shell) theme.observe(shell, { attributes: true, attributeFilter: ['data-design'] });
    draw();
    return () => { size.disconnect(); theme.disconnect(); };
  }, [data, xMedian, yMedian]);
  return <div className="joint-contour-plot">
    <canvas ref={chart} role="img" aria-label={`GetDist · ${parameterNotation(x).label} × ${parameterNotation(y).label}`}
      aria-description={xMedian !== undefined || yMedian !== undefined ? t('虚线表示加权后验中位数（q50）') : undefined}/>
    <span className="joint-axis-symbol" data-axis="x" aria-hidden="true"><ParameterSymbol parameter={x}/></span>
    <span className="joint-axis-symbol" data-axis="y" aria-hidden="true"><ParameterSymbol parameter={y}/></span>
  </div>;
}
