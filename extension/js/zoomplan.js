/* Zoom - choix des clips a zoomer et du zoom de chacun.
 *
 * Module pur (aucun acces a Premiere ni au disque), comme detect.js : il
 * tourne a l'identique dans le panneau et sous Node pour les tests.
 *
 * Un zoom est relatif a l'echelle actuelle du clip : 100 = sa taille actuelle.
 * Un clip 4K reduit a 50 % dans une sequence HD passe donc de 50 a 55 pour un
 * zoom de 100 a 110, au lieu de sauter a 110.
 *
 * Le tirage depend d'une graine : l'apercu affiche et la timeline modifiee
 * sont strictement les memes.
 */
(function (root, factory) {
  var mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  if (root) root.ADZoomPlan = mod;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  var TPS = 254016000000;

  /** Durees proposees pour un zoom, en secondes. 0 = sur toute la duree du clip. */
  var DURATIONS = [0, 0.3, 0.5, 1, 2, 3];

  var DEFAULTS = {
    zooms: [
      { from: 100, to: 110, duration: 0, ease: true },
      { from: 120, to: 100, duration: 0, ease: true }
    ],
    freqMin: 2,
    freqMax: 3,
    minClipSec: 0.5,
    noRepeat: true
  };

  /** Zooms proposes en un clic. */
  var QUICK = [
    { label: 'Zoom avant léger', from: 100, to: 110, duration: 0, ease: true },
    { label: 'Zoom avant fort', from: 100, to: 125, duration: 0, ease: true },
    { label: 'Dézoom', from: 120, to: 100, duration: 0, ease: true },
    { label: 'Punch-in rapide', from: 100, to: 115, duration: 0.3, ease: true },
    { label: 'Vers la caméra (haut gauche)', from: 100, to: 130, duration: 0, ease: true, point: { x: 0.2, y: 0.25 } },
    { label: 'Recadrage fixe', from: 115, to: 115, duration: 0, ease: false }
  ];

  function num(v, fallback) {
    var n = typeof v === 'number' ? v : parseFloat(v);
    return isFinite(n) ? n : fallback;
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  /** Point vise : null = centre de l'image ; sinon { x, y } en fraction de l'image. */
  function normalizePoint(p) {
    if (!p || typeof p !== 'object') return null;
    var x = num(p.x, NaN);
    var y = num(p.y, NaN);
    if (!isFinite(x) || !isFinite(y)) return null;
    x = Math.round(clamp(x, 0, 1) * 100) / 100;
    y = Math.round(clamp(y, 0, 1) * 100) / 100;
    if (Math.abs(x - 0.5) < 0.005 && Math.abs(y - 0.5) < 0.005) return null;
    return { x: x, y: y };
  }

  function normalizeZoom(z) {
    z = z || {};
    return {
      from: Math.round(clamp(num(z.from, 100), 10, 400) * 10) / 10,
      to: Math.round(clamp(num(z.to, 110), 10, 400) * 10) / 10,
      duration: Math.max(0, num(z.duration, 0)),
      ease: z.ease !== false,
      point: normalizePoint(z.point)
    };
  }

  var POINTS = [
    { label: 'Centre', point: null },
    { label: 'Haut gauche', point: { x: 0.25, y: 0.25 } },
    { label: 'Haut droite', point: { x: 0.75, y: 0.25 } },
    { label: 'Bas gauche', point: { x: 0.25, y: 0.75 } },
    { label: 'Bas droite', point: { x: 0.75, y: 0.75 } },
    { label: 'Gauche', point: { x: 0.2, y: 0.5 } },
    { label: 'Droite', point: { x: 0.8, y: 0.5 } }
  ];

  /** Nom lisible d'un point. */
  function pointLabel(p) {
    if (!p) return 'centre';
    for (var i = 1; i < POINTS.length; i++) {
      if (Math.abs(POINTS[i].point.x - p.x) < 0.01 && Math.abs(POINTS[i].point.y - p.y) < 0.01) return POINTS[i].label.toLowerCase();
    }
    return Math.round(p.x * 100) + ' % / ' + Math.round(p.y * 100) + ' %';
  }

  /** Reglages complets et bornes, quoi qu'on lui donne. */
  function normalize(p) {
    p = p || {};
    var zooms = Array.isArray(p.zooms) ? p.zooms.map(normalizeZoom) : DEFAULTS.zooms.map(normalizeZoom);
    var a = Math.round(clamp(num(p.freqMin, DEFAULTS.freqMin), 1, 50));
    var b = Math.round(clamp(num(p.freqMax, DEFAULTS.freqMax), 1, 50));
    return {
      zooms: zooms,
      freqMin: Math.min(a, b),
      freqMax: Math.max(a, b),
      minClipSec: Math.max(0, num(p.minClipSec, DEFAULTS.minClipSec)),
      noRepeat: p.noRepeat !== false
    };
  }

  /** Generateur pseudo-aleatoire a graine (mulberry32) : meme graine, meme tirage. */
  function rng(seed) {
    var a = (seed >>> 0) || 1;
    var next = function () {
      a = (a + 0x6d2b79f5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    return {
      next: next,
      /** Entier entre lo et hi inclus. */
      int: function (lo, hi) {
        return lo + Math.floor(next() * (hi - lo + 1));
      }
    };
  }

  /** Le clip [s, e] (ticks) est-il dans la zone a traiter ? */
  function inScope(clip, sections, mode) {
    if (mode === 'selected') return clip.sel === true;
    var mid = (clip.s + clip.e) / 2;
    for (var i = 0; i < sections.length; i++) {
      if (mid >= sections[i][0] && mid < sections[i][1]) return true;
    }
    return false;
  }

  /**
   * Plan des zooms.
   * @param {Array}  tracks   [{ index, clips: [{ i, s, e, sel, animated, motion }] }]  (s, e en ticks)
   * @param {Array}  sections [[debut, fin]] en ticks
   * @param {string} mode     'all' | 'inout' | 'selected'
   * @param {Object} params   reglages (voir DEFAULTS)
   * @param {number} seed     graine du tirage
   * @returns {Object} { items, tracks, stats }
   *   items  : [{ track, i, s, e, zoom, from, to, duration, ease }] - ce qui sera applique
   *   tracks : [{ index, clips: [{ i, s, e, status, zoom }] }]       - pour l'apercu
   *            status : 'zoom' | 'keep' | 'out' | 'short' | 'animated' | 'nomotion'
   */
  function buildPlan(tracks, sections, mode, params, seed) {
    var p = normalize(params);
    var r = rng(seed);
    var minTicks = p.minClipSec * TPS;
    var items = [];
    var outTracks = [];
    var stats = { inScope: 0, eligible: 0, zoomed: 0, short: 0, animated: 0, nomotion: 0, perZoom: [] };
    var z;
    for (z = 0; z < p.zooms.length; z++) stats.perZoom.push(0);

    for (var t = 0; t < tracks.length; t++) {
      var src = tracks[t].clips.slice().sort(function (x, y) {
        return x.s - y.s;
      });
      var view = [];
      var eligible = [];
      for (var c = 0; c < src.length; c++) {
        var clip = src[c];
        var status = 'keep';
        // un clip desactive (camera non retenue par POV) ne se voit pas : on ne le compte pas
        if (!inScope(clip, sections, mode) || clip.disabled === true) status = 'out';
        else if (clip.motion === false) status = 'nomotion';
        else if (clip.animated) status = 'animated';
        else if (clip.e - clip.s < minTicks) status = 'short';
        var v = { i: clip.i, s: clip.s, e: clip.e, status: status, zoom: -1 };
        view.push(v);
        if (status === 'out') continue;
        stats.inScope++;
        if (status === 'keep') eligible.push(v);
        else stats[status]++;
      }
      stats.eligible += eligible.length;

      // On avance de « freqMin a freqMax » clips entre deux zooms. Le premier
      // zoom tombe au hasard dans le premier intervalle, pour que le rythme
      // ne demarre pas toujours sur le premier clip.
      if (p.zooms.length && eligible.length) {
        var pos = r.int(0, r.int(p.freqMin, p.freqMax) - 1);
        var last = -1;
        while (pos < eligible.length) {
          var pick;
          if (p.noRepeat && p.zooms.length > 1 && last >= 0) {
            pick = r.int(0, p.zooms.length - 2);
            if (pick >= last) pick++;
          } else {
            pick = r.int(0, p.zooms.length - 1);
          }
          last = pick;
          var target = eligible[pos];
          var zz = p.zooms[pick];
          target.status = 'zoom';
          target.zoom = pick;
          stats.zoomed++;
          stats.perZoom[pick]++;
          items.push({
            track: tracks[t].index,
            i: target.i,
            s: target.s,
            e: target.e,
            zoom: pick,
            from: zz.from,
            to: zz.to,
            duration: zz.duration,
            ease: zz.ease,
            point: zz.point
          });
          pos += r.int(p.freqMin, p.freqMax);
        }
      }
      outTracks.push({ index: tracks[t].index, clips: view });
    }
    return { params: p, items: items, tracks: outTracks, stats: stats };
  }

  /** Texte court d'un zoom, pour l'affichage. */
  function describe(z) {
    var d = z.duration > 0 ? ' en ' + String(z.duration).replace('.', ',') + ' s' : '';
    var pt = z.point ? ' vers ' + pointLabel(z.point) : '';
    if (z.from === z.to) return 'fixe ' + z.from + ' %' + pt;
    return z.from + ' → ' + z.to + ' %' + d + pt;
  }

  return {
    TPS: TPS,
    DURATIONS: DURATIONS,
    DEFAULTS: DEFAULTS,
    QUICK: QUICK,
    normalize: normalize,
    normalizeZoom: normalizeZoom,
    normalizePoint: normalizePoint,
    POINTS: POINTS,
    pointLabel: pointLabel,
    rng: rng,
    inScope: inScope,
    buildPlan: buildPlan,
    describe: describe
  };
});
