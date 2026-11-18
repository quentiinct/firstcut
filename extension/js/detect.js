/* FirstCut - detection des silences.
 *
 * Module pur (aucun acces a Premiere ni au disque) : il prend l'enveloppe du
 * signal et les reglages, et rend la liste des plages a couper, calees sur les
 * images de la sequence. Il tourne a l'identique dans le panneau et sous Node,
 * ce qui permet de le tester sans Premiere.
 *
 * Enveloppe : { hopSec, peaks } ou peaks[i] est la crete (0..1) de la i-eme
 * tranche de hopSec secondes, la tranche 0 demarrant au debut de la plage
 * analysee.
 */
(function (root, factory) {
  var mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  if (root) root.ADDetect = mod;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  var FLOOR_DB = -120;

  var DEFAULTS = {
    noiseLevel: -29,
    autoNoiseLevel: false,
    minTimeOfSilence: 0.3,
    minTimeOfTalk: 0.2,
    marginBefore: 0.005,
    marginAfter: 0,
    minTimeBetweenCuts: { enabled: false, value: 1 },
    silences: 'delete',
    transitions: 'none',
    overlapFrames: 12
  };

  var SILENCE_MODES = ['delete', 'delete_keep_spaces', 'keep', 'mute'];
  var TRANSITIONS = ['none', 'j_cut', 'l_cut'];

  function toDb(lin) {
    return lin > 0 ? Math.max(FLOOR_DB, (20 * Math.log(lin)) / Math.LN10) : FLOOR_DB;
  }

  function fromDb(db) {
    return Math.pow(10, db / 20);
  }

  function num(v, fallback) {
    var n = typeof v === 'number' ? v : parseFloat(v);
    return isFinite(n) ? n : fallback;
  }

  /** Reglages complets et bornes, quoi qu'on lui donne. */
  function normalizeParams(p) {
    p = p || {};
    var mtb = p.minTimeBetweenCuts || {};
    var out = {
      noiseLevel: Math.min(0, Math.max(-90, num(p.noiseLevel, DEFAULTS.noiseLevel))),
      autoNoiseLevel: p.autoNoiseLevel === true,
      minTimeOfSilence: Math.max(0, num(p.minTimeOfSilence, DEFAULTS.minTimeOfSilence)),
      minTimeOfTalk: Math.max(0, num(p.minTimeOfTalk, DEFAULTS.minTimeOfTalk)),
      marginBefore: Math.max(0, num(p.marginBefore, DEFAULTS.marginBefore)),
      marginAfter: Math.max(0, num(p.marginAfter, DEFAULTS.marginAfter)),
      minTimeBetweenCuts: {
        enabled: mtb.enabled === true,
        value: Math.max(0, num(mtb.value, DEFAULTS.minTimeBetweenCuts.value))
      },
      silences: SILENCE_MODES.indexOf(p.silences) >= 0 ? p.silences : DEFAULTS.silences,
      transitions: TRANSITIONS.indexOf(p.transitions) >= 0 ? p.transitions : DEFAULTS.transitions,
      overlapFrames: Math.max(0, Math.round(num(p.overlapFrames, DEFAULTS.overlapFrames)))
    };
    return out;
  }

  /**
   * Plages brutes sous le seuil, en secondes depuis le debut de l'enveloppe.
   * Une tranche est silencieuse si sa crete est strictement sous le seuil.
   */
  function rawSilences(env, noiseLevelDb) {
    var peaks = env.peaks;
    var hop = env.hopSec;
    var n = peaks.length;
    var thr = fromDb(noiseLevelDb);
    var out = [];
    var i = 0;
    while (i < n) {
      if (peaks[i] < thr) {
        var j = i + 1;
        while (j < n && peaks[j] < thr) j++;
        out.push({ a: i * hop, b: j * hop });
        i = j;
      } else {
        i++;
      }
    }
    return out;
  }

  /**
   * Applique les durees minimales et les marges.
   *
   * L'ordre compte. On ecarte d'abord les silences trop courts : les micro-creux
   * a l'interieur d'une phrase redeviennent de la parole. Ensuite seulement on
   * efface les prises de parole trop courtes (clic, souffle), en soudant les
   * silences qui les entourent. Dans l'ordre inverse, une parole hachee serait
   * prise pour une suite de bruits et supprimee.
   */
  function refine(raw, total, p) {
    var EPS = 1e-9;
    var i;

    var sil = [];
    for (i = 0; i < raw.length; i++) {
      if (raw[i].b - raw[i].a >= p.minTimeOfSilence - EPS) sil.push({ a: raw[i].a, b: raw[i].b });
    }

    if (p.minTimeOfTalk > 0 && sil.length) {
      var merged = [sil[0]];
      for (i = 1; i < sil.length; i++) {
        var last = merged[merged.length - 1];
        if (sil[i].a - last.b < p.minTimeOfTalk - EPS) last.b = sil[i].b;
        else merged.push(sil[i]);
      }
      // Un bruit bref colle au bord de la plage n'est pas une prise de parole.
      if (merged[0].a > 0 && merged[0].a < p.minTimeOfTalk - EPS) merged[0].a = 0;
      var tail = merged[merged.length - 1];
      if (tail.b < total && total - tail.b < p.minTimeOfTalk - EPS) tail.b = total;
      sil = merged;
    }

    // Marges : on rend a la parole un peu de silence avant et apres elle. Aux
    // bords de la plage il n'y a pas de parole a proteger de ce cote-la.
    var out = [];
    for (i = 0; i < sil.length; i++) {
      var a = sil[i].a <= EPS ? 0 : sil[i].a + p.marginAfter;
      var b = sil[i].b >= total - EPS ? total : sil[i].b - p.marginBefore;
      if (b - a > EPS) out.push({ a: a, b: b });
    }
    return out;
  }

  /**
   * Temps minimal entre deux coupes : si le passage garde entre deux silences
   * est plus court que la valeur demandee, on renonce a l'un des deux silences
   * (le plus court) pour que les coupes ne s'enchainent pas trop vite.
   */
  function enforceMinBetweenCuts(sil, minGap) {
    if (!(minGap > 0) || sil.length < 2) return sil;
    var list = sil.slice();
    var i = 0;
    while (i + 1 < list.length) {
      var kept = list[i + 1].a - list[i].b;
      if (kept >= minGap - 1e-9) {
        i++;
        continue;
      }
      var d0 = list[i].b - list[i].a;
      var d1 = list[i + 1].b - list[i + 1].a;
      if (d0 < d1) {
        list.splice(i, 1);
        if (i > 0) i--;
      } else {
        list.splice(i + 1, 1);
      }
    }
    return list;
  }

  /**
   * Cale les plages sur les images de la sequence.
   * Le debut est arrondi vers le haut et la fin vers le bas : on ne retire
   * jamais plus que ce que les reglages ont decide.
   */
  function toFrames(sil, range, fps) {
    var out = [];
    var SNAP = 1e-6;
    for (var i = 0; i < sil.length; i++) {
      // « + 0 » : Math.ceil d'un negatif minuscule rend -0, qu'on ne veut pas voir sortir.
      var s = Math.ceil(range.startFrame + sil[i].a * fps - SNAP) + 0;
      var e = Math.floor(range.startFrame + sil[i].b * fps + SNAP) + 0;
      if (s < range.startFrame) s = range.startFrame;
      if (e > range.endFrame) e = range.endFrame;
      if (e - s < 1) continue;
      if (out.length && s <= out[out.length - 1].endFrame) {
        // Deux plages qui se touchent apres arrondi n'en font qu'une.
        if (e > out[out.length - 1].endFrame) out[out.length - 1].endFrame = e;
      } else {
        out.push({ startFrame: s, endFrame: e });
      }
    }
    return out;
  }

  /**
   * Plages a retirer sur les pistes video pour un J-cut ou un L-cut.
   *
   * On ne touche pas a la duree des plages : on les decale. Chaque piste perd
   * donc exactement le meme nombre d'images et l'image reste synchrone avec le
   * son ; seul le point de coupe de l'image s'ecarte de celui du son.
   *   L-cut : l'image coupe AVANT le son (le son du plan sortant deborde).
   *   J-cut : l'image coupe APRES le son (le son du plan entrant arrive en avance).
   * Les plages collees aux bords de la zone analysee ne sont pas decalees.
   */
  function shiftForVideo(frames, range, transition, overlapFrames) {
    var out = [];
    var n = frames.length;
    for (var i = 0; i < n; i++) {
      var f = frames[i];
      var shift = 0;
      var interior = f.startFrame > range.startFrame && f.endFrame < range.endFrame;
      if (interior && overlapFrames > 0 && (transition === 'l_cut' || transition === 'j_cut')) {
        if (transition === 'l_cut') {
          var prevEnd = i > 0 ? frames[i - 1].endFrame : range.startFrame;
          var keepBefore = f.startFrame - prevEnd;
          shift = -Math.min(overlapFrames, Math.floor(keepBefore / 2));
        } else {
          var nextStart = i + 1 < n ? frames[i + 1].startFrame : range.endFrame;
          var keepAfter = nextStart - f.endFrame;
          shift = Math.min(overlapFrames, Math.floor(keepAfter / 2));
        }
      }
      out.push({ startFrame: f.startFrame + shift, endFrame: f.endFrame + shift });
    }
    return out;
  }

  /**
   * Detection complete.
   * @param {Object} env    { hopSec, peaks }
   * @param {Object} params reglages (voir DEFAULTS)
   * @param {Object} range  { startFrame, endFrame, fps } - la plage analysee
   * @returns {Object} { params, seconds, audio, video, stats }
   */
  function detect(env, params, range) {
    var p = normalizeParams(params);
    var total = env.peaks.length * env.hopSec;
    var raw = rawSilences(env, p.noiseLevel);
    var sil = refine(raw, total, p);
    if (p.minTimeBetweenCuts.enabled) sil = enforceMinBetweenCuts(sil, p.minTimeBetweenCuts.value);

    var fps = range.fps;
    var audio = toFrames(sil, range, fps);
    var video =
      p.silences === 'delete'
        ? shiftForVideo(audio, range, p.transitions, p.overlapFrames)
        : shiftForVideo(audio, range, 'none', 0);

    var removedFrames = 0;
    for (var i = 0; i < audio.length; i++) removedFrames += audio[i].endFrame - audio[i].startFrame;
    var totalFrames = range.endFrame - range.startFrame;

    return {
      params: p,
      seconds: sil,
      audio: audio,
      video: video,
      stats: {
        count: audio.length,
        totalSec: totalFrames / fps,
        silenceSec: removedFrames / fps,
        keptSec: (totalFrames - removedFrames) / fps,
        ratio: totalFrames > 0 ? removedFrames / totalFrames : 0
      }
    };
  }

  /** Portion de l'enveloppe qui correspond a une section (en images de la sequence). */
  function sliceEnv(env, envStartFrame, section, fps) {
    var n = env.peaks.length;
    var i0 = Math.round((section.startFrame - envStartFrame) / fps / env.hopSec);
    var i1 = Math.round((section.endFrame - envStartFrame) / fps / env.hopSec);
    if (i0 < 0) i0 = 0;
    if (i1 > n) i1 = n;
    if (i1 < i0) i1 = i0;
    return { hopSec: env.hopSec, peaks: env.peaks.subarray(i0, i1) };
  }

  /**
   * Detection sur plusieurs sections de la timeline (clips selectionnes, par
   * exemple). Chaque section est traitee comme une zone a part : ses bords
   * comptent comme des bords de zone, et rien n'est coupe en dehors.
   * @param {Object} env            enveloppe commencant a envStartFrame
   * @param {number} envStartFrame  image de la sequence ou commence l'enveloppe
   * @param {Array}  sections       [{ startFrame, endFrame }] triees, disjointes
   */
  function detectSections(env, envStartFrame, sections, params, fps) {
    var p = normalizeParams(params);
    var audio = [];
    var video = [];
    var stats = { count: 0, totalSec: 0, silenceSec: 0, keptSec: 0, ratio: 0 };
    for (var i = 0; i < sections.length; i++) {
      var sec = sections[i];
      var r = detect(sliceEnv(env, envStartFrame, sec, fps), p, {
        startFrame: sec.startFrame,
        endFrame: sec.endFrame,
        fps: fps
      });
      audio = audio.concat(r.audio);
      video = video.concat(r.video);
      stats.count += r.stats.count;
      stats.totalSec += r.stats.totalSec;
      stats.silenceSec += r.stats.silenceSec;
      stats.keptSec += r.stats.keptSec;
    }
    stats.ratio = stats.totalSec > 0 ? stats.silenceSec / stats.totalSec : 0;
    return { params: p, audio: audio, video: video, sections: sections, stats: stats };
  }

  /** Niveau de bruit propose, calcule sur les seules sections retenues. */
  function suggestNoiseLevelSections(env, envStartFrame, sections, fps) {
    var parts = [];
    var total = 0;
    for (var i = 0; i < sections.length; i++) {
      var s = sliceEnv(env, envStartFrame, sections[i], fps).peaks;
      parts.push(s);
      total += s.length;
    }
    var all = new Float32Array(total);
    var off = 0;
    for (var j = 0; j < parts.length; j++) {
      all.set(parts[j], off);
      off += parts[j].length;
    }
    return suggestNoiseLevel({ hopSec: env.hopSec, peaks: all });
  }

  /**
   * Propose un niveau de bruit a partir du signal lui-meme (methode d'Otsu sur
   * l'histogramme des niveaux) : le seuil qui separe le mieux le « fond » de la
   * « parole ». C'est un point de depart, pas une verite : a ajuster a l'oeil
   * sur l'apercu.
   */
  function suggestNoiseLevel(env) {
    var LO = -80;
    var HI = 0;
    var BINS = 160;
    var hist = new Array(BINS);
    var i;
    for (i = 0; i < BINS; i++) hist[i] = 0;
    var n = env.peaks.length;
    var count = 0;
    for (i = 0; i < n; i++) {
      var db = toDb(env.peaks[i]);
      if (db < LO) db = LO;
      if (db > HI) db = HI;
      var k = Math.min(BINS - 1, Math.floor(((db - LO) / (HI - LO)) * BINS));
      hist[k]++;
      count++;
    }
    if (!count) return DEFAULTS.noiseLevel;

    var sumAll = 0;
    for (i = 0; i < BINS; i++) sumAll += i * hist[i];
    var wB = 0;
    var sumB = 0;
    var best = -1;
    var score = new Array(BINS);
    for (i = 0; i < BINS; i++) {
      score[i] = -1;
      wB += hist[i];
      if (!wB) continue;
      var wF = count - wB;
      if (!wF) break;
      sumB += i * hist[i];
      var mB = sumB / wB;
      var mF = (sumAll - sumB) / wF;
      score[i] = wB * wF * (mB - mF) * (mB - mF);
      if (score[i] > best) best = score[i];
    }
    if (best <= 0) return DEFAULTS.noiseLevel;
    // Entre un fond et une parole bien separes, tous les seuils intermediaires
    // se valent : on prend le milieu du plateau plutot que son bord.
    var first = -1;
    var last = -1;
    for (i = 0; i < BINS; i++) {
      if (score[i] >= best * (1 - 1e-9)) {
        if (first < 0) first = i;
        last = i;
      }
    }
    var level = LO + (((first + last) / 2 + 1) / BINS) * (HI - LO);
    return Math.round(Math.min(-10, Math.max(-60, level)));
  }

  /**
   * Reduit l'enveloppe a `columns` colonnes pour l'affichage (crete par colonne)
   * sur la fenetre [t0, t1] en secondes.
   */
  function columns(env, t0, t1, count) {
    var out = new Float32Array(count);
    var hop = env.hopSec;
    var n = env.peaks.length;
    var span = (t1 - t0) / count;
    for (var c = 0; c < count; c++) {
      var i0 = Math.floor((t0 + c * span) / hop);
      var i1 = Math.ceil((t0 + (c + 1) * span) / hop);
      if (i0 < 0) i0 = 0;
      if (i1 > n) i1 = n;
      if (i1 <= i0) i1 = Math.min(n, i0 + 1);
      var m = 0;
      for (var i = i0; i < i1; i++) if (env.peaks[i] > m) m = env.peaks[i];
      out[c] = m;
    }
    return out;
  }

  return {
    DEFAULTS: DEFAULTS,
    SILENCE_MODES: SILENCE_MODES,
    TRANSITIONS: TRANSITIONS,
    FLOOR_DB: FLOOR_DB,
    toDb: toDb,
    fromDb: fromDb,
    normalizeParams: normalizeParams,
    rawSilences: rawSilences,
    refine: refine,
    enforceMinBetweenCuts: enforceMinBetweenCuts,
    toFrames: toFrames,
    shiftForVideo: shiftForVideo,
    detect: detect,
    detectSections: detectSections,
    suggestNoiseLevel: suggestNoiseLevel,
    suggestNoiseLevelSections: suggestNoiseLevelSections,
    columns: columns
  };
});
