/* Tests de la detection et de la lecture WAV. Lancer : node --test tests/ */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const D = require('../extension/js/detect.js');
const W = require('../extension/js/wav.js');

const SR = 48000;

/** Fabrique un WAV a partir d'une fonction (t en secondes) -> amplitude -1..1. */
function writeWav(file, seconds, fn, opts) {
  opts = opts || {};
  const channels = opts.channels || 2;
  const bits = opts.bits || 16;
  const float = opts.float === true;
  const bytes = bits / 8;
  const frames = Math.round(seconds * SR);
  const data = Buffer.alloc(frames * channels * bytes);
  let off = 0;
  for (let i = 0; i < frames; i++) {
    const v = Math.max(-1, Math.min(1, fn(i / SR, i)));
    for (let c = 0; c < channels; c++) {
      if (float) data.writeFloatLE(v, off);
      else if (bytes === 2) data.writeInt16LE(Math.round(v * 32767), off);
      else if (bytes === 3) data.writeIntLE(Math.round(v * 8388607), off, 3);
      else data.writeInt32LE(Math.round(v * 2147483647), off);
      off += bytes;
    }
  }
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVE', 8, 'ascii');
  head.write('fmt ', 12, 'ascii');
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(float ? 3 : 1, 20);
  head.writeUInt16LE(channels, 22);
  head.writeUInt32LE(SR, 24);
  head.writeUInt32LE(SR * channels * bytes, 28);
  head.writeUInt16LE(channels * bytes, 32);
  head.writeUInt16LE(bits, 34);
  head.write('data', 36, 'ascii');
  head.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([head, data]));
}

/** Rush de synthese : parole = sinus fort, fond = bruit a -60 dB. */
function rush(t, i) {
  const noise = 0.001 * (((i * 2654435761) % 2000) / 1000 - 1);
  const talking =
    (t >= 2 && t < 4) || (t >= 6 && t < 8) || (t >= 8.2 && t < 10) || (t >= 10.5 && t < 10.51);
  return talking ? 0.5 * Math.sin(2 * Math.PI * 440 * t) + noise : noise;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'firstcut-test-'));
const RANGE = { startFrame: 0, endFrame: 360, fps: 30 };

test('WAV 16 bits : enveloppe et detection avec les reglages par defaut', async () => {
  const file = path.join(tmp, 'rush16.wav');
  writeWav(file, 12, rush);
  const env = await W.readEnvelope(file, 0.005);
  assert.strictEqual(env.sampleRate, SR);
  assert.strictEqual(env.channels, 2);
  assert.ok(Math.abs(env.durationSec - 12) < 1e-6);
  assert.strictEqual(env.peaks.length, 2400);
  assert.ok(Math.abs(env.hopSec - 0.005) < 1e-12);

  // fond vers -60 dB, parole vers -6 dB
  assert.ok(D.toDb(env.peaks[100]) < -55);
  assert.ok(D.toDb(env.peaks[500]) > -8);

  const r = D.detect(env, D.DEFAULTS, RANGE);
  // [0-2] et [4-6] : silences francs. Le creux de 0,2 s a 8 s est trop court.
  // Le clic de 10 ms a 10,5 s est trop bref pour compter comme parole.
  assert.deepStrictEqual(r.audio, [
    { startFrame: 0, endFrame: 59 },
    { startFrame: 120, endFrame: 179 },
    { startFrame: 300, endFrame: 360 }
  ]);
  assert.deepStrictEqual(r.video, r.audio);
  assert.strictEqual(r.stats.count, 3);
  assert.ok(Math.abs(r.stats.silenceSec - (59 + 59 + 60) / 30) < 1e-9);
});

test('WAV 24 bits, 32 bits flottant et mono donnent la meme enveloppe', async () => {
  const ref = path.join(tmp, 'ref.wav');
  writeWav(ref, 3, rush);
  const base = await W.readEnvelope(ref, 0.005);
  const variants = [
    { bits: 24 },
    { bits: 32 },
    { bits: 32, float: true },
    { bits: 16, channels: 1 }
  ];
  for (const v of variants) {
    const f = path.join(tmp, 'v' + v.bits + (v.float ? 'f' : '') + (v.channels || 2) + '.wav');
    writeWav(f, 3, rush, v);
    const env = await W.readEnvelope(f, 0.005);
    assert.strictEqual(env.peaks.length, base.peaks.length);
    for (let i = 0; i < env.peaks.length; i += 37) {
      assert.ok(Math.abs(env.peaks[i] - base.peaks[i]) < 1e-3, JSON.stringify(v) + ' tranche ' + i);
    }
  }
});

test("un fichier qui n'est pas un WAV est refuse proprement", async () => {
  const f = path.join(tmp, 'faux.wav');
  fs.writeFileSync(f, Buffer.from('ceci nest pas du son, vraiment pas du tout'));
  await assert.rejects(() => W.readEnvelope(f, 0.005), /WAV/);
});

function envFrom(pattern, hop) {
  // pattern : liste de [duree en secondes, niveau lineaire]
  const peaks = [];
  for (const [d, v] of pattern) {
    const n = Math.round(d / hop);
    for (let i = 0; i < n; i++) peaks.push(v);
  }
  return { hopSec: hop, peaks: Float32Array.from(peaks) };
}

test('les micro-creux dans une phrase ne coupent pas la parole', () => {
  // parole hachee : 0,15 s de son / 0,05 s de creux, repetee
  const pattern = [[1, 0]];
  for (let i = 0; i < 10; i++) pattern.push([0.15, 0.5], [0.05, 0]);
  pattern.push([1, 0]);
  const env = envFrom(pattern, 0.005);
  const r = D.detect(env, { ...D.DEFAULTS, marginBefore: 0 }, { startFrame: 0, endFrame: 120, fps: 30 });
  assert.deepStrictEqual(r.audio, [
    { startFrame: 0, endFrame: 30 },
    { startFrame: 89, endFrame: 120 }
  ]);
});

test('marges avant / apres : la parole est protegee des deux cotes', () => {
  const env = envFrom([[1, 0.5], [2, 0], [1, 0.5]], 0.005);
  const p = { ...D.DEFAULTS, marginBefore: 0.2, marginAfter: 0.3 };
  const r = D.detect(env, p, { startFrame: 100, endFrame: 220, fps: 30 });
  // silence brut 1..3 s -> 1,3..2,8 s -> images 139..184 (decalage de 100)
  assert.deepStrictEqual(r.audio, [{ startFrame: 139, endFrame: 184 }]);
});

test('temps minimal entre deux coupes', () => {
  const env = envFrom([[1, 0.5], [1, 0], [0.5, 0.5], [2, 0], [1, 0.5]], 0.005);
  const base = { ...D.DEFAULTS, marginBefore: 0 };
  const range = { startFrame: 0, endFrame: 165, fps: 30 };
  const libre = D.detect(env, base, range);
  assert.strictEqual(libre.audio.length, 2);
  const borne = D.detect(env, { ...base, minTimeBetweenCuts: { enabled: true, value: 1 } }, range);
  // le passage garde ne dure que 0,5 s : on renonce au silence le plus court
  assert.deepStrictEqual(borne.audio, [{ startFrame: 75, endFrame: 135 }]);
});

test('J-cut et L-cut decalent la video sans changer les durees', () => {
  const env = envFrom([[2, 0.5], [1, 0], [2, 0.5], [1, 0], [2, 0.5]], 0.005);
  const range = { startFrame: 0, endFrame: 240, fps: 30 };
  const base = { ...D.DEFAULTS, marginBefore: 0, overlapFrames: 12 };
  const l = D.detect(env, { ...base, transitions: 'l_cut' }, range);
  const j = D.detect(env, { ...base, transitions: 'j_cut' }, range);
  assert.deepStrictEqual(l.audio, [
    { startFrame: 60, endFrame: 90 },
    { startFrame: 150, endFrame: 180 }
  ]);
  assert.deepStrictEqual(l.video, [
    { startFrame: 48, endFrame: 78 },
    { startFrame: 138, endFrame: 168 }
  ]);
  assert.deepStrictEqual(j.video, [
    { startFrame: 72, endFrame: 102 },
    { startFrame: 162, endFrame: 192 }
  ]);
  // hors mode « supprimer », pas de decalage
  const k = D.detect(env, { ...base, transitions: 'l_cut', silences: 'keep' }, range);
  assert.deepStrictEqual(k.video, k.audio);
});

test('un silence colle au bord de la plage reste aligne image et son', () => {
  const env = envFrom([[1, 0], [2, 0.5], [1, 0]], 0.005);
  const range = { startFrame: 0, endFrame: 120, fps: 30 };
  const r = D.detect(env, { ...D.DEFAULTS, marginBefore: 0, transitions: 'l_cut' }, range);
  assert.deepStrictEqual(r.video, r.audio);
});

test('plusieurs sections : rien n\'est coupe en dehors, chaque section a ses bords', () => {
  // enveloppe a partir de l'image 300 : 2 s parole, 1 s blanc, 2 s parole, 4 s blanc, 1 s parole
  const env = envFrom([[2, 0.5], [1, 0], [2, 0.5], [4, 0], [1, 0.5]], 0.005);
  const p = { ...D.DEFAULTS, marginBefore: 0 };
  // section 1 : 300-450 (5 premieres secondes) ; section 2 : 510-600 (2 s de blanc + 1 s de parole)
  const sections = [
    { startFrame: 300, endFrame: 450 },
    { startFrame: 510, endFrame: 600 }
  ];
  const r = D.detectSections(env, 300, sections, p, 30);
  assert.deepStrictEqual(r.audio, [
    { startFrame: 360, endFrame: 390 },
    { startFrame: 510, endFrame: 570 }
  ]);
  // le blanc entre les deux sections (450-510) n'est pas touche
  assert.strictEqual(r.stats.count, 2);
  assert.ok(Math.abs(r.stats.totalSec - 8) < 1e-9);
  assert.ok(Math.abs(r.stats.silenceSec - 3) < 1e-9);
  // une seule section couvrant tout donne le meme resultat que detect()
  const whole = { startFrame: 300, endFrame: 600 };
  assert.deepStrictEqual(
    D.detectSections(env, 300, [whole], p, 30).audio,
    D.detect(env, p, { ...whole, fps: 30 }).audio
  );
  const level = D.suggestNoiseLevelSections(env, 300, sections, 30);
  assert.ok(level > -70 && level < -5);
});

test('niveau de bruit automatique : entre le fond et la parole', async () => {
  const file = path.join(tmp, 'auto.wav');
  writeWav(file, 12, rush);
  const env = await W.readEnvelope(file, 0.005);
  const level = D.suggestNoiseLevel(env);
  assert.ok(level > -50 && level < -15, 'niveau propose : ' + level);
  const r = D.detect(env, { ...D.DEFAULTS, noiseLevel: level }, RANGE);
  assert.strictEqual(r.audio.length, 3);
});

test('cadence 23,976 : les plages restent des images entieres dans la plage', () => {
  const fps = 24000 / 1001;
  const env = envFrom([[1.337, 0.5], [0.911, 0], [2.2, 0.5], [0.4, 0], [1, 0.5]], 0.005);
  const total = env.peaks.length * env.hopSec;
  const range = { startFrame: 1000, endFrame: 1000 + Math.floor(total * fps), fps };
  const r = D.detect(env, D.DEFAULTS, range);
  assert.strictEqual(r.audio.length, 2);
  for (const s of r.audio) {
    assert.ok(Number.isInteger(s.startFrame) && Number.isInteger(s.endFrame));
    assert.ok(s.startFrame >= range.startFrame && s.endFrame <= range.endFrame);
    assert.ok(s.endFrame > s.startFrame);
  }
});

test.after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});
