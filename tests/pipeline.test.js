/* Tests de la partie « fichiers » du panneau : recherche de la preconfiguration
 * d'export dans une installation de Premiere, et lecture d'un WAV tel qu'un
 * logiciel de montage l'ecrit (blocs supplementaires avant et apres le son).
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const W = require('../extension/js/wav.js');
const D = require('../extension/js/detect.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'firstcut-pipe-'));

function chunk(id, body) {
  const head = Buffer.alloc(8);
  head.write(id, 0, 'ascii');
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body, Buffer.alloc(body.length % 2)]);
}

test('WAV avec blocs annexes (LIST avant, metadonnees apres le son)', async () => {
  const SR = 48000;
  const seconds = 4;
  const pcm = Buffer.alloc(SR * seconds * 4);
  for (let i = 0; i < SR * seconds; i++) {
    const t = i / SR;
    const v = t >= 1 && t < 3 ? Math.round(16000 * Math.sin(2 * Math.PI * 300 * t)) : 0;
    pcm.writeInt16LE(v, i * 4);
    pcm.writeInt16LE(v, i * 4 + 2);
  }
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(1, 0);
  fmt.writeUInt16LE(2, 2);
  fmt.writeUInt32LE(SR, 4);
  fmt.writeUInt32LE(SR * 4, 8);
  fmt.writeUInt16LE(4, 12);
  fmt.writeUInt16LE(16, 14);
  // un bloc de longueur impaire avant le son, pour verifier l'alignement
  const before = chunk('LIST', Buffer.from('INFOISFT\x05\x00\x00\x00Lavf\x00', 'latin1'));
  const after = chunk('_PMX', Buffer.from('<x:xmpmeta>beaucoup de texte qui ne doit pas etre lu comme du son</x:xmpmeta>'));
  const body = Buffer.concat([Buffer.from('WAVE'), chunk('fmt ', fmt), before, chunk('data', pcm), after]);
  const riff = Buffer.alloc(8);
  riff.write('RIFF', 0, 'ascii');
  riff.writeUInt32LE(body.length, 4);
  const file = path.join(tmp, 'premiere.wav');
  fs.writeFileSync(file, Buffer.concat([riff, body]));

  const env = await W.readEnvelope(file, 0.005);
  assert.ok(Math.abs(env.durationSec - seconds) < 1e-9, 'duree lue : ' + env.durationSec);
  assert.strictEqual(env.peaks.length, 800);
  // rien apres la fin du son : les metadonnees ne sont pas prises pour du signal
  assert.strictEqual(env.peaks[799], 0);
  const r = D.detect(env, { ...D.DEFAULTS, marginBefore: 0 }, { startFrame: 0, endFrame: 120, fps: 30 });
  assert.deepStrictEqual(r.audio, [
    { startFrame: 0, endFrame: 30 },
    { startFrame: 90, endFrame: 120 }
  ]);
});

test('WAV dont la taille annoncee est fausse (export en flux)', async () => {
  const SR = 48000;
  const pcm = Buffer.alloc(SR * 2 * 2, 0);
  for (let i = 0; i < SR * 2; i++) pcm.writeInt16LE(i % 2 ? 8000 : -8000, i * 2);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(0xffffffff, 4);
  head.write('WAVE', 8, 'ascii');
  head.write('fmt ', 12, 'ascii');
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(SR, 24);
  head.writeUInt32LE(SR * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36, 'ascii');
  head.writeUInt32LE(0xffffffff, 40);
  const file = path.join(tmp, 'flux.wav');
  fs.writeFileSync(file, Buffer.concat([head, pcm]));
  const env = await W.readEnvelope(file, 0.005);
  assert.ok(Math.abs(env.durationSec - 2) < 1e-9);
  assert.ok(Math.abs(env.peaks[10] - 8000 / 32768) < 1e-6);
});

test('dix minutes de stereo 48 kHz se lisent en quelques secondes', async () => {
  const SR = 48000;
  const seconds = 600;
  const file = path.join(tmp, 'long.wav');
  const fd = fs.openSync(file, 'w');
  const head = Buffer.alloc(44);
  const dataLen = SR * seconds * 4;
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(36 + dataLen, 4);
  head.write('WAVE', 8, 'ascii');
  head.write('fmt ', 12, 'ascii');
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(2, 22);
  head.writeUInt32LE(SR, 24);
  head.writeUInt32LE(SR * 4, 28);
  head.writeUInt16LE(4, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36, 'ascii');
  head.writeUInt32LE(dataLen, 40);
  fs.writeSync(fd, head);
  // une seconde type : 0,6 s de son puis 0,4 s de blanc, repetee
  const sec = Buffer.alloc(SR * 4);
  for (let i = 0; i < SR; i++) {
    const v = i < SR * 0.6 ? Math.round(12000 * Math.sin((2 * Math.PI * 220 * i) / SR)) : 0;
    sec.writeInt16LE(v, i * 4);
    sec.writeInt16LE(v, i * 4 + 2);
  }
  for (let s = 0; s < seconds; s++) fs.writeSync(fd, sec);
  fs.closeSync(fd);

  const t0 = Date.now();
  let lastProgress = 0;
  const env = await W.readEnvelope(file, 0.005, (f) => {
    assert.ok(f >= lastProgress);
    lastProgress = f;
  });
  const readMs = Date.now() - t0;
  assert.strictEqual(lastProgress, 1);
  assert.strictEqual(env.peaks.length, seconds * 200);

  const t1 = Date.now();
  const r = D.detect(env, { ...D.DEFAULTS, marginBefore: 0 }, { startFrame: 0, endFrame: seconds * 30, fps: 30 });
  const detectMs = Date.now() - t1;
  assert.strictEqual(r.audio.length, seconds);
  assert.ok(Math.abs(r.stats.silenceSec - seconds * 0.4) < 1e-6);
  console.log('    lecture : ' + readMs + ' ms, detection : ' + detectMs + ' ms pour 10 minutes');
  assert.ok(readMs < 20000, 'lecture trop lente : ' + readMs + ' ms');
  assert.ok(detectMs < 1000, 'detection trop lente : ' + detectMs + ' ms');
});

test('extrait mono 16 kHz pour la transcription : duree, decalage, niveau', async () => {
  const SR = 48000;
  const secs = 6;
  // stereo : 1 kHz de 2 a 4 s, silence ailleurs
  const pcm = Buffer.alloc(SR * secs * 4);
  for (let i = 0; i < SR * secs; i++) {
    const t = i / SR;
    const v = t >= 2 && t < 4 ? Math.round(16000 * Math.sin(2 * Math.PI * 1000 * t)) : 0;
    pcm.writeInt16LE(v, i * 4);
    pcm.writeInt16LE(v, i * 4 + 2);
  }
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(36 + pcm.length, 4);
  head.write('WAVE', 8, 'ascii');
  head.write('fmt ', 12, 'ascii');
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(2, 22);
  head.writeUInt32LE(SR, 24);
  head.writeUInt32LE(SR * 4, 28);
  head.writeUInt16LE(4, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36, 'ascii');
  head.writeUInt32LE(pcm.length, 40);
  const src = path.join(tmp, 'zone.wav');
  const dst = path.join(tmp, 'zone16k.wav');
  fs.writeFileSync(src, Buffer.concat([head, pcm]));

  const r = await W.to16kMono(src, dst, 1, 4); // garde 1 s -> 5 s
  assert.ok(Math.abs(r.durationSec - 4) < 1e-3);
  const info = W.readHeader(dst);
  assert.deepStrictEqual([info.sampleRate, info.channels, info.bits], [16000, 1, 16]);
  const env = await W.readEnvelope(dst, 0.1);
  assert.strictEqual(env.peaks.length, 40);
  // silence jusqu'a 1 s (2 s de la source), son de 1 a 3 s, silence ensuite
  assert.ok(env.peaks[5] < 0.001 && env.peaks[35] < 0.001, 'silences');
  assert.ok(env.peaks[20] > 0.3, 'son conserve : ' + env.peaks[20]);
});

test.after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});
