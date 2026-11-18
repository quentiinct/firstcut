/* POV - qui parle, et quelle camera montrer (module pur, teste sous Node).
 *
 * Entree : une enveloppe de niveau par micro (meme pas de temps pour toutes).
 * Sortie : une suite de plans { a, b, cam } ou cam est l'indice de l'intervenant
 * a montrer, ou WIDE pour le plan large.
 *
 * Regles :
 *   - un micro « parle » quand son niveau lisse depasse son seuil ;
 *   - si plusieurs parlent, le plus fort l'emporte s'il domine les autres d'au
 *     moins `dominance` dB (le son d'une personne repris par le micro de
 *     l'autre ne doit pas faire changer de plan) ; sinon c'est « les deux » ;
 *   - silence et « les deux » : plan large si on en a un et si on le demande,
 *     sinon on garde le plan en cours ;
 *   - aucun plan plus court que `minShot` : il est fondu dans son voisin.
 */
(function (root, factory) {
  var mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  if (root) root.ADPovPlan = mod;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  var WIDE = -1;
  var SILENT = -2;
  var BOTH = -3;

  var DEFAULTS = {
    thresholds: [], // dB par micro ; vide = seuil automatique
    dominance: 6, // dB
    minShot: 2, // s
    smooth: 0.4, // s : fenetre de lissage du niveau
    lead: 0, // s : avance des coupes (negatif = retard)
    wideOnBoth: true,
    wideOnSilence: false,
    hasWide: false
  };

  function num(v, f) {
    var n = typeof v === 'number' ? v : parseFloat(v);
    return isFinite(n) ? n : f;
  }

  function normalize(p) {
    p = p || {};
    return {
      thresholds: Array.isArray(p.thresholds) ? p.thresholds.map(function (t) {
        return t === null || t === '' || t === undefined ? null : Math.max(-90, Math.min(0, num(t, -40)));
      }) : [],
      dominance: Math.max(0, Math.min(40, num(p.dominance, DEFAULTS.dominance))),
      minShot: Math.max(0.2, Math.min(30, num(p.minShot, DEFAULTS.minShot))),
      smooth: Math.max(0.05, Math.min(2, num(p.smooth, DEFAULTS.smooth))),
      lead: Math.max(-2, Math.min(2, num(p.lead, DEFAULTS.lead))),
      wideOnBoth: p.wideOnBoth !== false,
      wideOnSilence: p.wideOnSilence === true,
      hasWide: p.hasWide === true
    };
  }

  function toDb(x) {
    return x > 0 ? Math.max(-120, (20 * Math.log(x)) / Math.LN10) : -120;
  }

  /** Niveau lisse en dB : moyenne quadratique glissante des cretes. */
  function smoothDb(peaks, hopSec, win) {
    var n = peaks.length;
    var k = Math.max(1, Math.round(win / hopSec));
    var half = Math.floor(k / 2);
    var out = new Float32Array(n);
    var acc = 0;
    var cnt = 0;
    var lo = 0;
    var hi = -1;
    for (var i = 0; i < n; i++) {
      var a = i - half;
      var b = i + half;
      while (hi < b && hi + 1 < n) {
        hi++;
        acc += peaks[hi] * peaks[hi];
        cnt++;
      }
      while (lo < a) {
        acc -= peaks[lo] * peaks[lo];
        cnt--;
        lo++;
      }
      out[i] = toDb(Math.sqrt(Math.max(0, acc) / Math.max(1, cnt)));
    }
    return out;
  }

  /** Seuil automatique : entre le fond et la voix (methode d'Otsu sur l'histogramme). */
  function autoThreshold(levelsDb) {
    var LO = -80;
    var HI = 0;
    var BINS = 160;
    var hist = new Array(BINS);
    var i;
    for (i = 0; i < BINS; i++) hist[i] = 0;
    for (i = 0; i < levelsDb.length; i++) {
      var d = Math.max(LO, Math.min(HI, levelsDb[i]));
      hist[Math.min(BINS - 1, Math.floor(((d - LO) / (HI - LO)) * BINS))]++;
    }
    var total = levelsDb.length;
    if (!total) return -40;
    var sumAll = 0;
    for (i = 0; i < BINS; i++) sumAll += i * hist[i];
    var wB = 0;
    var sumB = 0;
    var best = -1;
    var first = -1;
    var last = -1;
    var score = [];
    for (i = 0; i < BINS; i++) {
      wB += hist[i];
      var wF = total - wB;
      if (!wB || !wF) {
        score.push(-1);
        continue;
      }
      sumB += i * hist[i];
      var mB = sumB / wB;
      var mF = (sumAll - sumB) / wF;
      var s = wB * wF * (mB - mF) * (mB - mF);
      score.push(s);
      if (s > best) best = s;
    }
    if (best <= 0) return -40;
    for (i = 0; i < score.length; i++) {
      if (score[i] >= best * (1 - 1e-9)) {
        if (first < 0) first = i;
        last = i;
      }
    }
    var lvl = LO + (((first + last) / 2 + 1) / BINS) * (HI - LO);
    return Math.round(Math.max(-60, Math.min(-12, lvl)));
  }

  /** Etiquette brute de chaque pas : indice du micro qui parle, BOTH ou SILENT. */
  function labels(levels, thresholds, dominance) {
    var n = levels[0].length;
    var out = new Int16Array(n);
    for (var i = 0; i < n; i++) {
      var top = -1;
      var topV = -999;
      var second = -999;
      var talking = 0;
      for (var k = 0; k < levels.length; k++) {
        var v = levels[k][i];
        if (v < thresholds[k]) continue;
        talking++;
        // on compare des marges au-dessus du seuil : deux micros reglees
        // differemment restent comparables
        var m = v - thresholds[k];
        if (m > topV) {
          second = topV;
          topV = m;
          top = k;
        } else if (m > second) second = m;
      }
      if (!talking) out[i] = SILENT;
      else if (talking === 1 || topV - second >= dominance) out[i] = top;
      else out[i] = BOTH;
    }
    return out;
  }

  /** Remplace BOTH / SILENT par une camera : plan large, ou plan en cours. */
  function resolve(raw, p) {
    var out = new Int16Array(raw.length);
    var cur = null;
    // premier plan connu, pour le debut de la zone
    for (var j = 0; j < raw.length; j++) {
      if (raw[j] >= 0) {
        cur = raw[j];
        break;
      }
    }
    if (cur === null) cur = p.hasWide ? WIDE : 0;
    for (var i = 0; i < raw.length; i++) {
      var r = raw[i];
      if (r >= 0) cur = r;
      else if (r === BOTH && p.hasWide && p.wideOnBoth) {
        out[i] = WIDE;
        continue;
      } else if (r === SILENT && p.hasWide && p.wideOnSilence) {
        out[i] = WIDE;
        continue;
      }
      out[i] = cur;
    }
    return out;
  }

  function runs(cams, hop) {
    var out = [];
    for (var i = 0; i < cams.length; i++) {
      var last = out[out.length - 1];
      if (last && last.cam === cams[i]) last.b = (i + 1) * hop;
      else out.push({ a: i * hop, b: (i + 1) * hop, cam: cams[i] });
    }
    return out;
  }

  /** Fond les plans trop courts dans le plus long de leurs voisins, en commencant par le plus court. */
  function enforceMinShot(list, minShot) {
    var shots = list.map(function (s) {
      return { a: s.a, b: s.b, cam: s.cam };
    });
    for (;;) {
      var idx = -1;
      var shortest = Infinity;
      for (var i = 0; i < shots.length; i++) {
        var d = shots[i].b - shots[i].a;
        if (d < minShot - 1e-9 && d < shortest && shots.length > 1) {
          shortest = d;
          idx = i;
        }
      }
      if (idx < 0) break;
      var prev = shots[idx - 1];
      var next = shots[idx + 1];
      var into = !prev ? next : !next ? prev : prev.b - prev.a >= next.b - next.a ? prev : next;
      if (into === prev) prev.b = shots[idx].b;
      else next.a = shots[idx].a;
      shots.splice(idx, 1);
      // deux voisins identiques se rejoignent
      for (var k = shots.length - 1; k > 0; k--) {
        if (shots[k].cam === shots[k - 1].cam) {
          shots[k - 1].b = shots[k].b;
          shots.splice(k, 1);
        }
      }
    }
    return shots;
  }

  /**
   * Plan de montage pour une zone.
   * @param envs  [{ hopSec, peaks }] une par micro, alignees sur le debut de la zone
   * @returns { shots: [{ a, b, cam }], thresholds, levels, raw }
   */
  function analyze(envs, params) {
    var p = normalize(params);
    var hop = envs[0].hopSec;
    var n = Math.min.apply(null, envs.map(function (e) {
      return e.peaks.length;
    }));
    var levels = envs.map(function (e) {
      return smoothDb(e.peaks.subarray ? e.peaks.subarray(0, n) : e.peaks.slice(0, n), hop, p.smooth);
    });
    var thresholds = levels.map(function (l, k) {
      var t = p.thresholds[k];
      return t === null || t === undefined ? autoThreshold(l) : t;
    });
    var raw = labels(levels, thresholds, p.dominance);
    var cams = resolve(raw, p);
    var shots = enforceMinShot(runs(cams, hop), p.minShot);
    // avance des coupes : on change de plan un peu avant (ou apres) la parole
    if (p.lead) {
      for (var i = 1; i < shots.length; i++) {
        var t = Math.max(shots[i - 1].a + 0.1, Math.min(shots[i].b - 0.1, shots[i].a - p.lead));
        shots[i - 1].b = t;
        shots[i].a = t;
      }
    }
    return { shots: shots, thresholds: thresholds, levels: levels, raw: raw, hopSec: hop, params: p };
  }

  /**
   * Plans en images de la sequence, dans une section.
   * Les coupes tombent sur des images entieres ; les plans d'une seule image disparaissent.
   */
  function toFrames(shots, startFrame, endFrame, fps) {
    var out = [];
    shots.forEach(function (s) {
      var a = Math.max(startFrame, Math.round(startFrame + s.a * fps));
      var b = Math.min(endFrame, Math.round(startFrame + s.b * fps));
      if (b - a < 1) return;
      var last = out[out.length - 1];
      if (last && last.cam === s.cam) last.endFrame = b;
      else if (last && a < last.endFrame) {
        a = last.endFrame;
        if (b > a) out.push({ startFrame: a, endFrame: b, cam: s.cam });
      } else out.push({ startFrame: a, endFrame: b, cam: s.cam });
    });
    if (out.length) {
      out[0].startFrame = startFrame;
      out[out.length - 1].endFrame = endFrame;
    }
    return out;
  }

  /** Statistiques pour l'apercu : changements de plan et temps par camera. */
  function stats(shots, count) {
    var per = {};
    var total = 0;
    shots.forEach(function (s) {
      per[s.cam] = (per[s.cam] || 0) + (s.b - s.a);
      total += s.b - s.a;
    });
    return { switches: Math.max(0, shots.length - 1), per: per, total: total, count: count };
  }

  return {
    WIDE: WIDE,
    SILENT: SILENT,
    BOTH: BOTH,
    DEFAULTS: DEFAULTS,
    normalize: normalize,
    smoothDb: smoothDb,
    autoThreshold: autoThreshold,
    labels: labels,
    resolve: resolve,
    runs: runs,
    enforceMinShot: enforceMinShot,
    analyze: analyze,
    toFrames: toFrames,
    stats: stats
  };
});
