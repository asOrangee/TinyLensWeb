import test from 'node:test';
import assert from 'node:assert/strict';
import { stages } from '../src/data/stages.ts';
import { mgeReference } from '../src/data/scientific-references.ts';
import { catalogParameters } from '../src/lib/parameter-catalog.ts';
import { modelConfigurationCards } from '../src/lib/model-configuration.ts';

test('every modeling-stage configuration parameter has a matching handbook definition', () => {
  for (const stage of stages.filter(item => !['preflight', 'b'].includes(item.id))) {
    const catalog = catalogParameters(stage);
    assert.equal(new Set(catalog.map(item => item.key)).size, catalog.length);
    for (const parameter of modelConfigurationCards(stage.id).flatMap(card => card.parameters)) {
      const definition = catalog.find(item => item.key === parameter.key);
      assert.ok(definition, `${stage.id}/${parameter.key} lacks a definition`);
      assert.ok(definition.description.trim().length > 0);
      assert.ok(definition.unit.trim().length > 0);
    }
  }
});

test('fixed MGE widths and inherited quantities add definitions without adding numerical results', () => {
  const before = JSON.stringify(stages);
  const a = stages.find(stage => stage.id === 'a')!;
  const m1 = stages.find(stage => stage.id === 'm1')!;
  const catalog = catalogParameters(a);
  for (const key of ['lens_mge_sigmas', 'source_mge_sigmas']) {
    const definition = catalog.find(item => item.key === key)!;
    assert.equal(definition.role, 'fixed');
    assert.equal(definition.unit, 'arcsec');
    assert.equal(definition.reference, mgeReference.url);
    assert.equal(definition.value, '—');
    assert.equal(definition.quantiles, undefined);
    assert.equal(definition.mean, undefined);
    assert.equal(definition.sigma, undefined);
    assert.ok(!a.parameters.some(item => item.key === key));
  }
  const inherited = catalogParameters(m1).find(item => item.key === 'center_x_lens_1')!;
  assert.equal(inherited.role, 'fixed');
  assert.equal(inherited.value, '—');
  assert.equal(inherited.mean, undefined);
  assert.equal(JSON.stringify(stages), before);
  assert.equal(a.parameters.length, 21);
});
