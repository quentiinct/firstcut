/* FirstCut - mode demonstration.
 *
 * Ouvrir index.html?demo dans un navigateur affiche le panneau sans Premiere,
 * avec une sequence et un signal fabriques. Sert a mettre au point l'interface.
 * Dans Premiere ce fichier ne fait rien.
 */
(function (global) {
  'use strict';

  var active = !global.__adobe_cep__ && /[?&]demo\b/.test(global.location.search);
  var TPS = 254016000000;
  var TB = TPS / 30;
  var END_FRAMES = 2850; // 95 s a 30 i/s
  var cut = null;

  function info() {
    return {
      ok: true,
      version: 'démo',
      appVersion: 'navigateur',
      appPath: '',
      sequence: {
        name: 'Rush interview (démonstration)',
        id: 'demo-seq',
        timebase: TB,
        displayFormat: 104,
        zeroTicks: 0,
        endTicks: END_FRAMES * TB,
        contentEndTicks: END_FRAMES * TB,
        inSec: 12,
        outSec: 58,
        fingerprint: 'demo'
      },
      video: [
        { index: 0, name: 'Video 1', clips: videoClips()[0].length, locked: false },
        { index: 1, name: 'B-roll', clips: videoClips()[1].length, locked: false },
        { index: 2, name: 'Titres', clips: 0, locked: false }
      ],
      audio: [
        { index: 0, name: 'Micro', clips: 1, locked: false, muted: false },
        { index: 1, name: 'Ambiance', clips: 1, locked: false, muted: true },
        { index: 2, name: 'Audio 3', clips: 0, locked: false, muted: false }
      ]
    };
  }

  var vclips = null;

  /** Clips video fabriques : V1 = rush deja derushe (beaucoup de petits clips), V2 = quelques B-roll. */
  function videoClips() {
    if (vclips) return vclips;
    var seed = 99;
    function rnd() {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    }
    var v1 = [];
    var t = 0;
    var end = END_FRAMES / 30;
    while (t < end - 0.5) {
      var d = Math.min(end - t, 1.2 + rnd() * 3.8);
      v1.push({ s: t, e: t + d });
      t += d;
    }
    var v2 = [[8, 12.5], [30, 34], [61, 66], [80, 84.5]].map(function (x) {
      return { s: x[0], e: x[1] };
    });
    vclips = [v1, v2];
    return vclips;
  }

  function listClips(csv) {
    var all = videoClips();
    var tracks = String(csv)
      .split(',')
      .filter(function (x) {
        return x !== '' && all[parseInt(x, 10)];
      })
      .map(function (x) {
        var idx = parseInt(x, 10);
        return {
          index: idx,
          locked: false,
          clips: all[idx].map(function (c, i) {
            var mid = (c.s + c.e) / 2;
            return {
              i: i,
              s: Math.round(c.s * 30) * TB,
              e: Math.round(c.e * 30) * TB,
              sel: (mid >= 18 && mid < 37) || (mid >= 55 && mid < 78),
              motion: true,
              animated: idx === 1 && i === 2
            };
          })
        };
      });
    return { ok: true, tracks: tracks };
  }

  // ------------------------------------------------------------ B-roll

  var PHRASES = [
    'Salut à tous, aujourd\'hui on part en voyage dans les Alpes.',
    'Le matin, on commence toujours par un bon café en terrasse.',
    'Ensuite on prend la voiture pour monter jusqu\'au col.',
    'Là-haut, les sommets enneigés sont vraiment impressionnants.',
    'On a marché près de trois heures en forêt avant d\'arriver au lac.',
    'Le lac était d\'un bleu incroyable, avec des montagnes tout autour.',
    'Le soir, on a regardé le coucher de soleil depuis le chalet.',
    'Et pour finir, une fondue au fromage devant la cheminée.',
    'Dites-moi en commentaire quelle région vous voulez voir ensuite.'
  ];

  function brollTranscript(sections) {
    var a = sections[0][0] + 1;
    var segs = [];
    var b = sections[sections.length - 1][1];
    var i = 0;
    while (a < b - 3) {
      var text = PHRASES[i % PHRASES.length];
      var dur = 3 + (text.length % 5) * 0.7;
      segs.push({ a: a, b: Math.min(b, a + dur), text: text, words: [] });
      a += dur + 1.2;
      i++;
    }
    return { segments: segs, source: 'démonstration' };
  }

  var HUES = [18, 200, 140, 280, 40, 330];

  function thumb(label, hue) {
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 90">' +
      '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(' + hue + ',70%,55%)"/>' +
      '<stop offset="1" stop-color="hsl(' + ((hue + 60) % 360) + ',60%,25%)"/></linearGradient></defs>' +
      '<rect width="160" height="90" fill="url(#g)"/><path d="M0 70 40 45 70 62 105 35 160 68V90H0z" fill="rgba(0,0,0,.35)"/>' +
      '<text x="8" y="16" font-family="Segoe UI,Arial" font-size="11" fill="#fff">' + String(label).replace(/[<&]/g, '') + '</text></svg>';
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }

  function brollCandidates(m) {
    var out = [];
    for (var k = 0; k < 3; k++) {
      out.push({
        id: 'demo-' + Math.round(m.a * 10) + '-' + k,
        provider: k === 1 ? 'openverse' : 'pexels',
        kind: k === 1 ? 'image' : 'video',
        thumb: thumb(m.query + (k ? ' (' + (k + 1) + ')' : ''), HUES[(Math.round(m.a) + k) % HUES.length]),
        url: '',
        w: 1920,
        h: 1080,
        duration: 12,
        credit: 'Exemple ' + (k + 1),
        license: 'démonstration'
      });
    }
    return out;
  }

  function brollLibrary() {
    return {
      root: 'D:/Rushes',
      items: [
        { id: 'Ldemo1', path: 'D:/Rushes/drone_alpes.mp4', rel: 'drone_alpes.mp4', name: 'drone_alpes.mp4', duration: 42, w: 3840, h: 2160,
          frames: [{ t: 10, jpg: '', caption: 'sommets enneigés vus du ciel' }], summary: 'Survol des Alpes en drone', tags: ['montagne', 'neige'] },
        { id: 'Ldemo2', path: 'D:/Rushes/lac.mov', rel: 'lac.mov', name: 'lac.mov', duration: 25, w: 1920, h: 1080,
          frames: [{ t: 8, jpg: '', caption: 'un lac bleu entouré de montagnes' }], summary: 'Lac de montagne', tags: ['lac'] }
      ]
    };
  }

  /** POV : micro k d'une conversation a n personnes ; chacun parle a son tour, avec la reprise des autres. */
  function povEnvelope(k, n, dur, hop) {
    var count = Math.floor(dur / hop);
    var peaks = new Float32Array(count);
    var seed = 77;
    function rnd() {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    }
    var t = 0;
    var who = 0;
    var until = 4;
    for (var i = 0; i < count; i++) {
      t = i * hop;
      if (t >= until) {
        who = (who + 1 + (rnd() < 0.2 ? 1 : 0)) % n;
        until = t + 2 + rnd() * 7;
      }
      var r = rnd();
      var speech = 0.12 + 0.35 * Math.abs(Math.sin(t * 13 + k)) * (0.6 + 0.4 * r);
      peaks[i] = who === k ? speech : speech * 0.08 + 0.002;
    }
    return { hopSec: hop, peaks: peaks };
  }

  /** Signal de synthese : des phrases de longueur variable separees par des blancs. */
  function envelope(range) {
    var hop = 0.005;
    var total = (range.endFrame - range.startFrame) / range.fps;
    var n = Math.floor(total / hop);
    var peaks = new Float32Array(n);
    var seed = 12345;
    function rnd() {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    }
    var t = 0;
    var talking = false;
    var until = 0.8;
    for (var i = 0; i < n; i++) {
      t = i * hop;
      if (t >= until) {
        talking = !talking;
        until = t + (talking ? 1.2 + rnd() * 4.5 : 0.25 + rnd() * 1.8);
      }
      var floor = 0.0016 + rnd() * 0.0012;
      if (talking) {
        var syll = 0.5 + 0.5 * Math.sin(t * 21) * Math.sin(t * 3.3);
        peaks[i] = Math.max(floor, (0.12 + 0.5 * syll) * (0.55 + 0.45 * rnd()));
      } else {
        peaks[i] = rnd() < 0.004 ? 0.05 : floor;
      }
    }
    return { hopSec: hop, peaks: peaks, durationSec: total };
  }

  function call(fn) {
    if (fn === 'ADR_ping') return Promise.resolve({ ok: true, version: 'démo', appVersion: 'navigateur' });
    if (fn === 'ADR_getInfo') return Promise.resolve(info());
    if (fn === 'ADR_getLayout') {
      var S = TPS;
      return Promise.resolve({
        ok: true,
        audio: [
          { index: 0, spans: [[0, END_FRAMES * TB]] },
          { index: 1, spans: [[5 * S, 40 * S], [52 * S, 90 * S]] },
          { index: 2, spans: [] }
        ],
        video: [
          { index: 0, spans: [[0, END_FRAMES * TB]] },
          {
            index: 1,
            spans: videoClips()[1].map(function (c) {
              return [c.s * S, c.e * S];
            })
          },
          { index: 2, spans: [] }
        ],
        selectedCount: 3,
        selection: [[18 * S, 37 * S], [55 * S, 78 * S]]
      });
    }
    if (fn === 'ADR_setPlayhead') return Promise.resolve({ ok: true });
    if (fn === 'ADZ_listClips') return Promise.resolve(listClips(arguments[1] && arguments[1][0]));
    if (fn === 'ADP_begin') {
      cut = { done: 0, total: 6 };
      return Promise.resolve({ ok: true, tracks: 2, backupName: 'Rush interview - avant POV' });
    }
    if (fn === 'ADP_step') {
      cut.done = Math.min(cut.total, cut.done + 1);
      return new Promise(function (resolve) {
        setTimeout(function () {
          resolve({ ok: true, phase: cut.done < 3 ? 'razor' : 'toggle', done: cut.done, total: cut.total, finished: cut.done >= cut.total });
        }, 70);
      });
    }
    if (fn === 'ADP_finish' || fn === 'ADP_cancel') {
      return Promise.resolve({
        ok: fn === 'ADP_finish',
        code: fn === 'ADP_finish' ? null : 'CANCELLED',
        error: fn === 'ADP_finish' ? null : 'POV interrompu.',
        razorDone: 24, razorTotal: 24, enabled: 0, disabled: 12, refused: 0, unsplit: 0, mismatch: 0, notes: [],
        backupName: 'Rush interview - avant POV',
        log: ['mode démonstration : aucune caméra modifiée']
      });
    }
    if (fn === 'ADB_projectInfo') return Promise.resolve({ ok: true, projectPath: '', frameW: 1920, frameH: 1080 });
    if (fn === 'ADB_begin') {
      cut = { done: 0, total: 8 };
      return Promise.resolve({ ok: true, total: cut.total, imported: 5, backupName: 'Rush interview - avant B-roll' });
    }
    if (fn === 'ADB_step') {
      cut.done = Math.min(cut.total, cut.done + 1);
      return new Promise(function (resolve) {
        setTimeout(function () {
          resolve({ ok: true, done: cut.done, total: cut.total, finished: cut.done >= cut.total });
        }, 70);
      });
    }
    if (fn === 'ADB_finish' || fn === 'ADB_cancel') {
      return Promise.resolve({
        ok: fn === 'ADB_finish',
        code: fn === 'ADB_finish' ? null : 'CANCELLED',
        applied: cut ? cut.done : 0,
        failed: 0,
        total: cut ? cut.total : 0,
        notes: [],
        backupName: 'Rush interview - avant B-roll',
        log: ['mode démonstration : aucun B-roll posé']
      });
    }
    if (fn === 'ADZ_begin') {
      cut = { done: 0, total: 14 };
      return Promise.resolve({ ok: true, total: cut.total, backupName: 'Rush interview - avant Zoom' });
    }
    if (fn === 'ADZ_step') {
      cut.done = Math.min(cut.total, cut.done + 2);
      return new Promise(function (resolve) {
        setTimeout(function () {
          resolve({ ok: true, done: cut.done, total: cut.total, finished: cut.done >= cut.total });
        }, 70);
      });
    }
    if (fn === 'ADZ_finish' || fn === 'ADZ_cancel') {
      return Promise.resolve({
        ok: fn === 'ADZ_finish',
        code: fn === 'ADZ_finish' ? null : 'CANCELLED',
        applied: cut ? cut.done : 0,
        skipped: 0,
        failed: 0,
        total: cut ? cut.total : 0,
        notes: [],
        backupName: 'Rush interview - avant Zoom',
        log: ['mode démonstration : aucun zoom posé']
      });
    }
    if (fn === 'ADR_begin') {
      cut = { done: 0, total: 240 };
      return Promise.resolve({ ok: true, tracks: ['V1', 'A1'], lockedSkipped: [], backupName: 'Rush interview - avant FirstCut' });
    }
    if (fn === 'ADR_step') {
      cut.done = Math.min(cut.total, cut.done + 30);
      var phase = cut.done < 120 ? 'razor' : 'remove';
      return new Promise(function (resolve) {
        setTimeout(function () {
          resolve({ ok: true, phase: phase, done: cut.done, total: cut.total, finished: cut.done >= cut.total });
        }, 80);
      });
    }
    if (fn === 'ADR_finish' || fn === 'ADR_cancel') {
      return Promise.resolve({
        ok: fn === 'ADR_finish',
        code: fn === 'ADR_finish' ? null : 'CANCELLED',
        error: fn === 'ADR_finish' ? null : 'Découpe interrompue.',
        mode: 'delete',
        razorTotal: 120,
        razorDone: 120,
        removed: 60,
        moved: 0,
        mismatch: 0,
        mismatchNotes: [],
        removedSeconds: 31.4,
        lockedSkipped: [],
        backupName: 'Rush interview - avant FirstCut',
        log: ['mode démonstration : rien n\'a été coupé']
      });
    }
    return Promise.reject(new Error('fonction inconnue en démonstration : ' + fn));
  }

  global.ADDemo = {
    active: active,
    call: call,
    envelope: envelope,
    brollTranscript: brollTranscript,
    brollCandidates: brollCandidates,
    brollLibrary: brollLibrary,
    povEnvelope: povEnvelope
  };
})(window);
