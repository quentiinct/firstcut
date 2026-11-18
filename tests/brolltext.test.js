/* Tests des calculs B-roll sur la transcription. Lancer : node --test tests/ */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const T = require('../extension/js/brolltext.js');

const SRT = `1
00:00:01,000 --> 00:00:04,500
Aujourd'hui je vais vous parler de la montagne.

2
00:00:04,600 --> 00:00:09,000
Les sommets enneigés des Alpes sont magnifiques en hiver.

3
00:00:12,000 --> 00:00:16,000
Ensuite, nous irons à la <i>plage</i> pour regarder le coucher de soleil.

4
00:00:20,000 --> 00:00:24,000
Enfin, je vous montrerai comment préparer un bon café le matin.
`;

test('lecture SRT : temps, texte nettoye, ordre', () => {
  const s = T.parseSrt(SRT);
  assert.strictEqual(s.length, 4);
  assert.deepStrictEqual([s[0].a, s[0].b], [1, 4.5]);
  assert.strictEqual(s[2].text, 'Ensuite, nous irons à la plage pour regarder le coucher de soleil.');
  // VTT (point decimal, heures absentes)
  const v = T.parseSrt('WEBVTT\n\n00:01.500 --> 00:03.250\nBonjour la ville\n');
  assert.deepStrictEqual([v[0].a, v[0].b, v[0].text], [1.5, 3.25, 'Bonjour la ville']);
});

test('lecture whisper.cpp : segments et mots recolles depuis les jetons', () => {
  const json = {
    transcription: [
      {
        offsets: { from: 1000, to: 4500 },
        text: ' Je parle de la montagne.',
        tokens: [
          { text: '[_BEG_]', offsets: { from: 1000, to: 1000 } },
          { text: ' Je', offsets: { from: 1000, to: 1200 } },
          { text: ' parle', offsets: { from: 1200, to: 1600 } },
          { text: ' de', offsets: { from: 1600, to: 1700 } },
          { text: ' la', offsets: { from: 1700, to: 1800 } },
          { text: ' mont', offsets: { from: 1800, to: 2100 } },
          { text: 'agne', offsets: { from: 2100, to: 2500 } },
          { text: '.', offsets: { from: 2500, to: 2550 } }
        ]
      }
    ]
  };
  const s = T.parseWhisperJson(JSON.stringify(json));
  assert.strictEqual(s[0].text, 'Je parle de la montagne.');
  const mont = s[0].words.find((w) => w.w.startsWith('montagne'));
  assert.deepStrictEqual([mont.a, mont.b, mont.w], [1.8, 2.55, 'montagne.']);
});

test('mots-cles : sens, sans accents, pluriel ramene au singulier', () => {
  const k = T.keywords('Les sommets enneigés des Alpes sont magnifiques en hiver.', null, 5).map((x) => x.key);
  assert.ok(k.includes('sommet') && k.includes('alpe') && k.includes('hiver') && k.includes('enneige'), k.join(','));
  assert.ok(!k.includes('les') && !k.includes('sont'));
  assert.deepStrictEqual(T.tokens('Les CAFÉS du matin'), ['cafe', 'matin']);
});

test('mots-cles : un mot rare dans la video passe devant un mot repete partout', () => {
  const segs = [
    { text: 'la recette du gateau' },
    { text: 'la recette est simple' },
    { text: 'la recette avec du chocolat' }
  ];
  const k = T.keywords('la recette avec du chocolat', T.idf(segs), 2);
  assert.strictEqual(k[0].key, 'chocolat');
});

test('moments : rythme, durees, dans les sections, deterministes', () => {
  const segs = T.parseSrt(SRT);
  const p = { gapMin: 3, gapMax: 5, durMin: 2, durMax: 3 };
  const m = T.planMoments(segs, [[0, 25]], p, 42);
  assert.ok(m.length >= 3, 'trop peu de moments : ' + m.length);
  for (let i = 0; i < m.length; i++) {
    assert.ok(m[i].b - m[i].a >= 1 && m[i].b - m[i].a <= 3.001, 'duree ' + (m[i].b - m[i].a));
    assert.ok(m[i].a >= 0 && m[i].b <= 25);
    if (i) assert.ok(m[i].a - m[i - 1].b >= 3 - 1e-9, 'trop rapproches');
  }
  assert.deepStrictEqual(m, T.planMoments(segs, [[0, 25]], p, 42));
  assert.ok(m.some((x) => /montagne|sommets|Alpes|enneig|hiver/i.test(x.query)), m.map((x) => x.query).join(' | '));
  // rien hors des sections
  const only = T.planMoments(segs, [[11, 17]], p, 1);
  assert.ok(only.every((x) => x.a >= 11 && x.b <= 17));
  assert.ok(only.length >= 1 && /plage|coucher|soleil|regarder/i.test(only[0].query), JSON.stringify(only));
});

test('moments : cale le B-roll sur le mot-cle quand il est horodate', () => {
  const segs = [
    {
      a: 10,
      b: 16,
      text: 'et la je vous montre la cathedrale',
      words: [
        { a: 10, b: 10.3, w: 'et' },
        { a: 14.2, b: 15, w: 'cathedrale' }
      ]
    }
  ];
  const m = T.planMoments(segs, [[10, 20]], { gapMin: 1, gapMax: 1, durMin: 2, durMax: 2 }, 3);
  assert.ok(Math.abs(m[0].a - 14) < 1e-9, 'depart ' + m[0].a);
  assert.strictEqual(m[0].keys[0], 'cathedrale');
});

test('dossier : classement par nom, description et passage conseille', () => {
  const items = [
    { name: 'IMG_0001.MOV', rel: 'vacances/IMG_0001.MOV', duration: 20 },
    { name: 'drone_montagne_alpes.mp4', rel: 'drone_montagne_alpes.mp4', duration: 30 },
    {
      name: 'clip3.mp4',
      rel: 'divers/clip3.mp4',
      duration: 40,
      frames: [
        { t: 5, caption: 'une rue en ville' },
        { t: 25, caption: 'des sommets enneigés au lever du soleil' }
      ]
    },
    { name: 'montagne_courte.mp4', rel: 'montagne_courte.mp4', duration: 1 }
  ];
  const moment = { keys: ['sommet', 'montagne'] };
  const r = T.rankLibrary(moment, items, 2);
  assert.deepStrictEqual(r.map((x) => x.item.name), ['clip3.mp4', 'drone_montagne_alpes.mp4']);
  assert.strictEqual(r[0].t, 25);
  assert.strictEqual(T.passage(40, 3, 25), 23.5);
  assert.strictEqual(T.passage(10, 3, 9.8), 6.8); // ne deborde pas de la video
  assert.strictEqual(T.passage(10, 3, null, 0), 0.2);
});

test('sections et decalage', () => {
  const segs = T.shift(T.parseSrt(SRT), 100);
  assert.strictEqual(segs[0].a, 101);
  assert.strictEqual(T.inSections(segs, [[100, 110]]).length, 2);
});
