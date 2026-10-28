'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { foldText, queryWords, indexSettings, searchSettings } = loadTs('src/shared/settingsSearch.ts');
const { SETTINGS_INDEX } = loadTs('src/renderer/src/components/settingsIndex.ts');

const locale = (lng) => require(path.join(__dirname, '..', 'src/renderer/src/i18n/locales', `${lng}.json`));
const translator = (lng) => {
  const dict = locale(lng);
  return (key) => {
    const v = key.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), dict);
    return typeof v === 'string' ? v : key;
  };
};
const en = translator('en');
const es = translator('es');
const indexEs = indexSettings(SETTINGS_INDEX, es, en);
const indexEn = indexSettings(SETTINGS_INDEX, en, en);
const ids = (rows) => rows.map((r) => r.id);
const top = (index, q) => searchSettings(index, q)[0]?.id;

test('foldText strips Spanish accents and case', () => {
  assert.equal(foldText('Configuración'), 'configuracion');
  assert.equal(foldText('AUTONOMÍA y Límites'), 'autonomia y limites');
  assert.equal(foldText('Pequeño'), 'pequeno');
});

test('queryWords splits on spaces and punctuation, drops empties', () => {
  assert.deepEqual(queryWords('  ¿Modo   simple? '), ['modo', 'simple']);
  assert.deepEqual(queryWords(''), []);
});

test('every index key exists in both en and es', () => {
  for (const def of SETTINGS_INDEX) {
    for (const key of [def.label, def.desc, ...(def.extra ?? [])].filter(Boolean)) {
      assert.notEqual(en(key), key, `missing in en.json: ${key} (${def.id})`);
      assert.notEqual(es(key), key, `missing in es.json: ${key} (${def.id})`);
    }
  }
});

test('every setting anchor exists in the Settings modal', () => {
  const src = require('node:fs').readFileSync(
    path.join(__dirname, '..', 'src/renderer/src/components/SettingsModal.tsx'), 'utf8');
  for (const def of SETTINGS_INDEX) {
    if (def.isSection) continue;
    const anchor = def.anchor ?? def.id;
    assert.ok(src.includes(`data-setting-id="${anchor}"`), `no data-setting-id="${anchor}" for ${def.id}`);
  }
});

test('index ids are unique', () => {
  assert.equal(new Set(ids(SETTINGS_INDEX)).size, SETTINGS_INDEX.length);
});

test('Spanish UI: individual settings are found, not just tabs', () => {
  assert.equal(top(indexEs, 'notificaciones'), 'notifications');
  assert.equal(top(indexEs, 'idioma'), 'language');
  assert.equal(top(indexEs, 'presupuesto'), 'floorBudget');
  assert.equal(top(indexEs, 'tema'), 'officeTheme');
  assert.equal(top(indexEs, 'modelo predeterminado'), 'defaultModel');
  assert.equal(top(indexEs, 'modelo'), 'defaultModel');
  const voz = searchSettings(indexEs, 'voz');
  assert.ok(voz.length > 0 && voz.every((r) => r.section === 'Voice'), `voz -> ${ids(voz)}`);
});

test('accents are optional on either side', () => {
  assert.equal(top(indexEs, 'autonomia'), top(indexEs, 'autonomía'));
  assert.ok(searchSettings(indexEs, 'autonomia').length > 0);
  assert.ok(searchSettings(indexEs, 'memoria semantica').some((r) => r.id === 'semanticMemory'));
});

test('English words still work while the UI is in Spanish', () => {
  assert.equal(top(indexEs, 'notifications'), 'notifications');
  assert.equal(top(indexEs, 'budget'), 'floorBudget');
  assert.equal(top(indexEs, 'keep awake'), 'keepAwake');
});

test('English UI', () => {
  assert.equal(top(indexEn, 'language'), 'language');
  assert.equal(top(indexEn, 'telemetry') ?? null, null); // no usage-stats row in this fork
  assert.equal(top(indexEn, 'max turns'), 'maxTurns');
  assert.equal(top(indexEn, 'webhook'), 'webhooks');
  assert.equal(top(indexEn, 'certificate'), 'certs');
});

test('Spanish synonyms the labels do not spell out', () => {
  assert.equal(top(indexEs, 'modo simple'), 'simpleMode');
  assert.equal(top(indexEs, 'compactar'), 'autoCompact');
});

test('multi-word queries need every word, in any order', () => {
  assert.equal(top(indexEn, 'simple explain'), 'simpleMode');
  assert.deepEqual(searchSettings(indexEn, 'slack zzzz'), []);
});

test('a label hit ranks above a description hit', () => {
  const rows = searchSettings(indexEn, 'model');
  assert.equal(rows[0].id, 'defaultModel');
});

test('empty query returns nothing (the plain section list is shown instead)', () => {
  assert.deepEqual(searchSettings(indexEn, '   '), []);
});

test('rows carry the section to open and the anchor to scroll to', () => {
  const cert = searchSettings(indexEn, 'certificate').find((r) => r.id === 'certs');
  assert.equal(cert.section, 'Agents & Models');
  assert.equal(cert.anchor, 'aiEngines');
  const lang = searchSettings(indexEn, 'language').find((r) => r.id === 'language');
  assert.equal(lang.anchor, 'language');
});
