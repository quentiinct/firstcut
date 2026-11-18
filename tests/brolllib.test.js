/* Tests de la bibliotheque de videos. Le test d'indexation utilise le ffmpeg
 * installe sur le poste ; il est saute s'il n'y en a pas. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const L = require('../extension/js/brolllib.js');

test('lecture de la sortie ffmpeg : duree, taille, cadence, rotation', () => {
  const err = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'a.mp4':
  Duration: 00:01:02.50, start: 0.000000, bitrate: 5000 kb/s
  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(tv, bt709), 1920x1080 [SAR 1:1 DAR 16:9], 4900 kb/s, 29.97 fps, 29.97 tbr
  Stream #0:1[0x2](und): Audio: aac (LC), 48000 Hz, stereo, fltp, 128 kb/s`;
  assert.deepStrictEqual(L.parseProbe(err), { duration: 62.5, w: 1920, h: 1080, fps: 29.97, hasVideo: true });
  const rot = L.parseProbe(err.replace('29.97 tbr', '29.97 tbr\n    Side data:\n      displaymatrix: rotation of -90.00 degrees'));
  assert.deepStrictEqual([rot.w, rot.h], [1080, 1920]);
  assert.strictEqual(L.parseProbe('Duration: 00:00:05.00\n Stream #0:0: Audio: mp3').hasVideo, false);
});

test('images reparties sur la video', () => {
  assert.deepStrictEqual(L.frameTimes(6), [1, 3, 5]);
  assert.strictEqual(L.frameTimes(300).length, 6);
});

const ffmpeg = L.findFfmpeg();

test('indexation reelle d\'un dossier (ffmpeg du poste), puis reprise depuis le cache', { skip: !ffmpeg && 'ffmpeg absent' }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adr-lib-'));
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'adr-cache-'));
  fs.mkdirSync(path.join(root, 'drone'));
  const make = (file, dur, size) =>
    cp.spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc=size=${size}:rate=25:duration=${dur}`,
      '-pix_fmt', 'yuv420p', file], { windowsHide: true });
  make(path.join(root, 'drone', 'montagne alpes.mp4'), 4, '640x360');
  make(path.join(root, 'cafe.mov'), 2, '320x240');
  fs.writeFileSync(path.join(root, 'notes.txt'), 'pas une video');
  fs.writeFileSync(path.join(root, 'casse.mp4'), 'pas une vraie video');

  try {
    const steps = [];
    let described = 0;
    const r = await L.index(root, {
      ffmpeg,
      cacheDir: cache,
      onProgress: (done, total) => steps.push(done + '/' + total),
      describe: (item) => {
        described++;
        return Promise.resolve({ summary: 'resume de ' + item.name, tags: ['test'], frames: item.frames.map((f) => ({ t: f.t, caption: 'image ' + f.t })) });
      }
    });
    assert.strictEqual(r.total, 3, 'le .txt est ignore');
    assert.strictEqual(r.items.length, 2);
    assert.strictEqual(r.errors.length, 1, 'la fausse video est signalee : ' + r.errors.join(' ; '));
    const drone = r.items.find((i) => i.name === 'montagne alpes.mp4');
    assert.ok(Math.abs(drone.duration - 4) < 0.1);
    assert.deepStrictEqual([drone.w, drone.h], [640, 360]);
    assert.strictEqual(drone.rel, path.join('drone', 'montagne alpes.mp4'));
    assert.strictEqual(drone.frames.length, 3);
    assert.ok(drone.frames.every((f) => fs.statSync(f.jpg).size > 500), 'images extraites');
    assert.strictEqual(drone.frames[0].caption, 'image ' + drone.frames[0].t);
    assert.strictEqual(described, 2);
    // le dossier de l'utilisateur n'a pas ete modifie
    assert.deepStrictEqual(fs.readdirSync(root).sort(), ['cafe.mov', 'casse.mp4', 'drone', 'notes.txt']);

    // deuxieme passage : tout vient du cache, rien n'est redecrit
    described = 0;
    const r2 = await L.index(root, { ffmpeg, cacheDir: cache, describe: () => { described++; return Promise.resolve({ summary: 'x', tags: [], frames: [] }); } });
    assert.strictEqual(r2.items.length, 2);
    assert.strictEqual(described, 0);
    assert.strictEqual(L.loadIndex(cache, root).items.length, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(cache, { recursive: true, force: true });
  }
});
