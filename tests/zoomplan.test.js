/* Tests du tirage des zooms. Lancer : node --test tests/ */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Z = require('../extension/js/zoomplan.js');

const S = Z.TPS;

/** n clips de `dur` secondes colles bout a bout sur une piste. */
function track(index, n, dur, extra) {
  const clips = [];
  for (let k = 0; k < n; k++) {
    clips.push({ i: k, s: k * dur * S, e: (k + 1) * dur * S, sel: false, animated: false, motion: true, ...(extra ? extra(k) : {}) });
  }
  return { index, clips };
}

const ALL = (tracks) => [[0, 1e30]];

test('frequence 1 a 1 : tous les clips sont zoomes', () => {
  const t = [track(0, 10, 2)];
  const r = Z.buildPlan(t, ALL(), 'all', { freqMin: 1, freqMax: 1 }, 42);
  assert.strictEqual(r.items.length, 10);
  assert.deepStrictEqual(r.items.map((x) => x.i), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test('frequence 2 a 3 : ecarts toujours entre 2 et 3 clips', () => {
  for (let seed = 1; seed < 200; seed++) {
    const r = Z.buildPlan([track(0, 60, 2)], ALL(), 'all', { freqMin: 2, freqMax: 3 }, seed);
    const idx = r.items.map((x) => x.i);
    assert.ok(idx[0] <= 2, 'premier zoom trop loin : ' + idx[0]);
    for (let k = 1; k < idx.length; k++) {
      const gap = idx[k] - idx[k - 1];
      assert.ok(gap >= 2 && gap <= 3, 'ecart ' + gap + ' (graine ' + seed + ')');
    }
    assert.ok(idx.length >= 19 && idx.length <= 30);
  }
});

test('frequence 1 a 5 : ecarts entre 1 et 5, et les bornes inversees sont remises dans l\'ordre', () => {
  const r = Z.buildPlan([track(0, 100, 1)], ALL(), 'all', { freqMin: 5, freqMax: 1 }, 7);
  assert.strictEqual(r.params.freqMin, 1);
  assert.strictEqual(r.params.freqMax, 5);
  const idx = r.items.map((x) => x.i);
  for (let k = 1; k < idx.length; k++) assert.ok(idx[k] - idx[k - 1] >= 1 && idx[k] - idx[k - 1] <= 5);
});

test('meme graine, meme tirage ; autre graine, autre tirage', () => {
  const t = [track(0, 40, 2)];
  const p = { zooms: [{ from: 100, to: 110 }, { from: 120, to: 100 }, { from: 100, to: 125 }] };
  const a = Z.buildPlan(t, ALL(), 'all', p, 123);
  const b = Z.buildPlan(t, ALL(), 'all', p, 123);
  const c = Z.buildPlan(t, ALL(), 'all', p, 124);
  assert.deepStrictEqual(a.items, b.items);
  assert.notDeepStrictEqual(a.items, c.items);
});

test('jamais deux fois le meme zoom d\'affilee', () => {
  const p = { freqMin: 1, freqMax: 1, zooms: [{ from: 100, to: 110 }, { from: 120, to: 100 }] };
  const r = Z.buildPlan([track(0, 50, 1)], ALL(), 'all', p, 9);
  for (let k = 1; k < r.items.length; k++) assert.notStrictEqual(r.items[k].zoom, r.items[k - 1].zoom);
  // tous les zooms de la liste finissent par sortir
  const many = Z.buildPlan([track(0, 200, 1)], ALL(), 'all', { freqMin: 1, freqMax: 1, zooms: [{}, {}, {}, {}] }, 3);
  assert.ok(many.stats.perZoom.every((n) => n > 20), many.stats.perZoom.join(','));
});

test('clips selectionnes : seuls eux comptent', () => {
  const t = [track(0, 10, 2, (k) => ({ sel: k >= 3 && k <= 6 }))];
  const r = Z.buildPlan(t, [], 'selected', { freqMin: 1, freqMax: 1 }, 1);
  assert.deepStrictEqual(r.items.map((x) => x.i), [3, 4, 5, 6]);
  assert.strictEqual(r.tracks[0].clips.filter((c) => c.status === 'out').length, 6);
});

test('entree / sortie : un clip compte si son milieu est dans la zone', () => {
  const t = [track(0, 10, 2)]; // clips de 0-2 s, 2-4 s, ...
  // zone 3 s - 9 s : milieux a 3, 5, 7 s dedans ; 9 s exclu
  const r = Z.buildPlan(t, [[3 * S, 9 * S]], 'inout', { freqMin: 1, freqMax: 1 }, 1);
  assert.deepStrictEqual(r.items.map((x) => x.i), [1, 2, 3]);
});

test('clips trop courts, deja animes ou sans mouvement : ignores et comptes', () => {
  const t = [
    track(0, 8, 2, (k) => ({
      e: k === 1 ? 2 * S + 0.3 * S : (k + 1) * 2 * S,
      animated: k === 2,
      motion: k !== 3
    }))
  ];
  const r = Z.buildPlan(t, ALL(), 'all', { freqMin: 1, freqMax: 1, minClipSec: 0.5 }, 1);
  assert.deepStrictEqual(r.items.map((x) => x.i), [0, 4, 5, 6, 7]);
  assert.strictEqual(r.stats.short, 1);
  assert.strictEqual(r.stats.animated, 1);
  assert.strictEqual(r.stats.nomotion, 1);
  assert.strictEqual(r.stats.inScope, 8);
});

test('plusieurs pistes : rythme propre a chaque piste', () => {
  const r = Z.buildPlan([track(0, 6, 2), track(1, 3, 4)], ALL(), 'all', { freqMin: 1, freqMax: 1 }, 5);
  assert.strictEqual(r.items.filter((x) => x.track === 0).length, 6);
  assert.strictEqual(r.items.filter((x) => x.track === 1).length, 3);
});

test('liste de zooms vide : aucun zoom, pas d\'erreur', () => {
  const r = Z.buildPlan([track(0, 5, 2)], ALL(), 'all', { zooms: [] }, 1);
  assert.strictEqual(r.items.length, 0);
  assert.strictEqual(r.stats.eligible, 5);
});

test('valeurs aberrantes ramenees dans des bornes sures', () => {
  const z = Z.normalizeZoom({ from: '-5', to: 9999, duration: -2, ease: false });
  assert.deepStrictEqual(z, { from: 10, to: 400, duration: 0, ease: false, point: null });
  assert.strictEqual(Z.describe({ from: 100, to: 110, duration: 0 }), '100 → 110 %');
  assert.strictEqual(Z.describe({ from: 100, to: 115, duration: 0.3 }), '100 → 115 % en 0,3 s');
  assert.strictEqual(Z.describe({ from: 115, to: 115, duration: 0 }), 'fixe 115 %');
});

test('point de zoom : borne, centre = aucun point, description', () => {
  assert.deepStrictEqual(Z.normalizeZoom({ point: { x: 0.2, y: 0.3 } }).point, { x: 0.2, y: 0.3 });
  assert.deepStrictEqual(Z.normalizeZoom({ point: { x: -1, y: 7 } }).point, { x: 0, y: 1 });
  assert.strictEqual(Z.normalizeZoom({ point: { x: 0.5, y: 0.5 } }).point, null);
  assert.strictEqual(Z.normalizeZoom({ point: 'n importe quoi' }).point, null);
  assert.strictEqual(Z.describe({ from: 100, to: 110, duration: 0, point: { x: 0.25, y: 0.25 } }), '100 → 110 % vers haut gauche');
  assert.strictEqual(Z.describe({ from: 100, to: 130, duration: 0, point: { x: 0.12, y: 0.8 } }), '100 → 130 % vers 12 % / 80 %');
  const r = Z.buildPlan([track(0, 4, 2)], ALL(), 'all', { freqMin: 1, freqMax: 1, zooms: [{ from: 100, to: 120, point: { x: 0.2, y: 0.3 } }] }, 1);
  assert.deepStrictEqual(r.items[0].point, { x: 0.2, y: 0.3 });
});

test('clips desactives (camera non retenue par POV) : ni zoomes ni comptes dans le rythme', () => {
  const t = [track(0, 8, 2, (k) => ({ disabled: k % 2 === 1 }))];
  const r = Z.buildPlan(t, ALL(), 'all', { freqMin: 1, freqMax: 1 }, 1);
  assert.deepStrictEqual(r.items.map((x) => x.i), [0, 2, 4, 6]);
  assert.strictEqual(r.stats.inScope, 4);
});
