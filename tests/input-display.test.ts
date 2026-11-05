import {numericalFixture} from './fixtures/numerical-plane.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseInputDisplay, selectInputReport } from '../src/lib/input-display.ts';
import { formatScaleNumber } from '../src/lib/display-scale.ts';
import type { AgentUpdate } from '../src/lib/agent-types.ts';

const report: AgentUpdate = { id: 'input', kind: 'artifact', stage: 'preflight', path: '/project/output/run/input-provenance.json' };
const fixture = () => ({ schema: 'tinylens.input-display.v1', source: { provenance_path: report.path, fits_sha256: 'a'.repeat(64) }, pixel_scale_arcsec: .05, log_a: 1000, psf_sum: 1, x_direction: 'increasing', y_direction: 'decreasing', planes: ['data', 'noise', 'snr', 'psf'].map(id => ({ id, shape: [11, 11], half_extent_arcsec: .275, half_extent_x_arcsec: .275, scale_bar_arcsec: .1, numeric:{...numericalFixture([11,11]),src:'',colormap_src:'',input_fits_sha256:'a'.repeat(64),array_y_direction:'decreasing'}, variants: Object.fromEntries(['linear', 'log', 'zscale'].map(scale => [scale, { src: '', vmin: 1e-12, vmax: .0037 }])) })) });
test('only explicit preflight input reports are selected, with the latest report replacing the old one', () => {
  assert.equal(selectInputReport([report, { ...report, id: 'new' }, { ...report, id: 'wrong-stage', stage: 'a' }, { ...report, id: 'note', kind: 'note' }])?.id, 'new');
  assert.equal(selectInputReport([{ ...report, path: '/private/other.fits' }]), undefined);
});
test('input display refuses another run, missing images, false geometry or external image URLs', () => {
  assert.equal(parseInputDisplay(fixture(), report).planes.length, 4);
  const another = fixture(); another.source.provenance_path += '.old'; assert.throws(() => parseInputDisplay(another, report));
  const missing = fixture(); missing.planes.pop(); assert.throws(() => parseInputDisplay(missing, report));
  const geometry = fixture(); geometry.planes[0].half_extent_arcsec = 4; assert.throws(() => parseInputDisplay(geometry, report));
  const external = fixture(); external.planes[0].variants.linear.src = 'http://other/image.png'; assert.throws(() => parseInputDisplay(external, report));
  const range = fixture(); range.planes[0].variants.linear.vmin = NaN; assert.throws(() => parseInputDisplay(range, report));
});
test('small RMS and PSF ticks follow the requested two-decimal display while raw values remain unchanged', () => {
  const input=parseInputDisplay(fixture(),report);
  const value=input.planes[0].variants.linear.vmin;
  assert.equal(formatScaleNumber(value),'0.00');assert.equal(value,1e-12);
  assert.equal(formatScaleNumber(.006686117230731341),'0.01');
  assert.equal(formatScaleNumber(0),'0.00');
});
