/* Tests du choix de camera d'POV. Lancer : node --test tests/ */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const P = require('../extension/js/povplan.js');

const HOP = 0.02;

/** Enveloppe : liste de [duree s, niveau lineaire]. */
function env(pattern) {
  const peaks = [];
  for (const [d, v] of pattern) for (let i = 0; i < Math.round(d / HOP); i++) peaks.push(v);
  return { hopSec: HOP, peaks: Float32Array.from(peaks) };
}

const LOUD = 0.3; // ~ -10 dB
const BLEED = 0.03; // ~ -30 dB : la voix de l'autre reprise par ce micro
const FLOOR = 0.001; // ~ -60 dB

function shots(r) {
  return r.shots.map((s) => [Math.round(s.a * 10) / 10, Math.round(s.b * 10) / 10, s.cam]);
}

/** Compare les plans : memes cameras, coupes a 0,25 s pres (le lissage du niveau decale un peu). */
function near(actual, expected) {
  assert.strictEqual(actual.length, expected.length, JSON.stringify(actual));
  actual.forEach((s, i) => {
    assert.strictEqual(s[2], expected[i][2], 'camera du plan ' + i + ' : ' + JSON.stringify(actual));
    assert.ok(Math.abs(s[0] - expected[i][0]) <= 0.25 && Math.abs(s[1] - expected[i][1]) <= 0.25, JSON.stringify(actual));
  });
}

test('dialogue simple : chacun son tour, la reprise d\'un micro par l\'autre est ignoree', () => {
  // A parle 0-5 s, B parle 5-10 s, A reparle 10-15 s
  const a = env([[5, LOUD], [5, BLEED], [5, LOUD]]);
  const b = env([[5, BLEED], [5, LOUD], [5, BLEED]]);
  const r = P.analyze([a, b], { thresholds: [-40, -40], minShot: 1 });
  near(shots(r), [[0, 5, 0], [5, 10, 1], [10, 15, 0]]);
});

test('seuil automatique : entre le fond et la voix', () => {
  const lv = P.smoothDb(env([[5, LOUD], [5, FLOOR]]).peaks, HOP, 0.4);
  const t = P.autoThreshold(lv);
  assert.ok(t > -55 && t < -15, 'seuil ' + t);
  const r = P.analyze([env([[5, LOUD], [5, FLOOR], [5, FLOOR]]), env([[5, FLOOR], [5, FLOOR], [5, LOUD]])], { minShot: 1 });
  // le silence du milieu garde le plan en cours
  near(shots(r), [[0, 10, 0], [10, 15, 1]]);
});

test('les deux parlent en meme temps : plan large si disponible, sinon plan en cours', () => {
  const a = env([[4, LOUD], [3, LOUD], [4, BLEED]]);
  const b = env([[4, BLEED], [3, LOUD], [4, LOUD]]);
  const p = { thresholds: [-40, -40], minShot: 1 };
  near(shots(P.analyze([a, b], { ...p, hasWide: true })), [[0, 4, 0], [4, 7, P.WIDE], [7, 11, 1]]);
  near(shots(P.analyze([a, b], { ...p, hasWide: true, wideOnBoth: false })), [[0, 7, 0], [7, 11, 1]]);
  near(shots(P.analyze([a, b], p)), [[0, 7, 0], [7, 11, 1]]);
});

test('silence : plan large seulement si demande', () => {
  const a = env([[3, LOUD], [4, FLOOR], [3, FLOOR]]);
  const b = env([[3, FLOOR], [4, FLOOR], [3, LOUD]]);
  const p = { thresholds: [-40, -40], minShot: 1, hasWide: true };
  near(shots(P.analyze([a, b], { ...p, wideOnSilence: true })), [[0, 3, 0], [3, 7, P.WIDE], [7, 10, 1]]);
  near(shots(P.analyze([a, b], p)), [[0, 7, 0], [7, 10, 1]]);
});

test('duree minimale : une relance de 0,6 s ne fait pas changer de plan', () => {
  const a = env([[5, LOUD], [0.6, BLEED], [5, LOUD]]);
  const b = env([[5, BLEED], [0.6, LOUD], [5, BLEED]]);
  const r = P.analyze([a, b], { thresholds: [-40, -40], minShot: 2, smooth: 0.1 });
  near(shots(r), [[0, 10.6, 0]]);
  const r2 = P.analyze([a, b], { thresholds: [-40, -40], minShot: 0.3, smooth: 0.1 });
  assert.strictEqual(r2.shots.length, 3);
});

test('trois intervenants et avance des coupes', () => {
  const a = env([[3, LOUD], [3, BLEED], [3, BLEED]]);
  const b = env([[3, BLEED], [3, LOUD], [3, BLEED]]);
  const c = env([[3, BLEED], [3, BLEED], [3, LOUD]]);
  const r = P.analyze([a, b, c], { thresholds: [-40, -40, -40], minShot: 1, lead: 0.3 });
  near(shots(r), [[0, 2.7, 0], [2.7, 5.7, 1], [5.7, 9, 2]]);
});

test('passage en images : coupes entieres, bornes de la zone respectees', () => {
  const f = P.toFrames([{ a: 0, b: 2.51, cam: 0 }, { a: 2.51, b: 2.52, cam: 1 }, { a: 2.52, b: 6, cam: 1 }], 300, 480, 30);
  assert.deepStrictEqual(f, [
    { startFrame: 300, endFrame: 375, cam: 0 },
    { startFrame: 375, endFrame: 480, cam: 1 }
  ]);
  const st = P.stats([{ a: 0, b: 4, cam: 0 }, { a: 4, b: 10, cam: 1 }], 2);
  assert.deepStrictEqual([st.switches, st.per[0], st.per[1]], [1, 4, 6]);
});
