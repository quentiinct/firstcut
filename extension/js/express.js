/* Montage express - la recette : Silences, puis POV, puis Zoom, d'un coup.
 *
 * Etape 1 (commune, app.js) : zone + micros.
 * Etape 2 : les trois etapes, chacune activable, avec leurs reglages essentiels.
 * Ce sont les memes reglages que ceux des outils separes (meme memoire).
 *
 * Entre deux etapes la timeline a change : la coupe des silences raccourcit la
 * zone, POV coupe et desactive des clips. On relit donc la sequence et on
 * recalcule la zone a chaque fois, et une seule sauvegarde est faite, au debut.
 */
(function (global) {
  'use strict';

  var D = global.ADDetect;
  var P = global.ADPovPlan;
  var ZP = global.ADZoomPlan;
  var W = global.ADWav;
  var TPS = 254016000000;

  var STAGES = [
    { id: 'silences', label: 'Silences', desc: 'couper les blancs' },
    { id: 'pov', label: 'POV', desc: 'montrer celui qui parle' },
    { id: 'zoom', label: 'Zoom', desc: 'dynamiser avec des zooms' }
  ];

  var DEFAULTS = { silences: true, pov: true, zoom: true, zoomTracks: null, backup: true };

  var ctx = null;
  var data = null; // { sections, mode, tracks, seqId, fingerprint }
  var status = {}; // id -> { state: 'wait'|'run'|'done'|'skip'|'error', text }

  function $(id) {
    return document.getElementById(id);
  }

  function S() {
    return ctx.store.express;
  }

  function normalize(s) {
    var o = {};
    for (var k in DEFAULTS) o[k] = DEFAULTS[k];
    for (var j in s || {}) if (Object.prototype.hasOwnProperty.call(DEFAULTS, j)) o[j] = s[j];
    o.silences = o.silences !== false;
    o.pov = o.pov !== false;
    o.zoom = o.zoom !== false;
    o.backup = o.backup !== false;
    o.zoomTracks = Array.isArray(o.zoomTracks) ? o.zoomTracks : null;
    return o;
  }

  function enabledStages() {
    return STAGES.filter(function (st) {
      return S()[st.id] && !(st.id === 'pov' && data && data.tracks.length < 2);
    });
  }

  // -------------------------------------------------------------- reglages

  function camOf(a) {
    var info = ctx.state.info;
    var v = ctx.store.pov.cams[a];
    var vids = info ? info.video : [];
    if (v !== undefined && vids.some(function (t) { return t.index === v; })) return v;
    if (vids.some(function (t) { return t.index === a; })) return a;
    return vids.length ? vids[0].index : 0;
  }

  function wideTrack() {
    var info = ctx.state.info;
    var w = ctx.store.pov.wide;
    return w >= 0 && info && info.video.some(function (t) { return t.index === w; }) ? w : -1;
  }

  /** Pistes a zoomer : choix enregistre, sinon les cameras d'POV, sinon V1. */
  function zoomTracks() {
    var info = ctx.state.info;
    var vids = info ? info.video.filter(function (t) { return t.clips > 0 && !t.locked; }) : [];
    var saved = S().zoomTracks;
    if (saved) {
      var ok = saved.filter(function (i) {
        return vids.some(function (t) { return t.index === i; });
      });
      if (ok.length) return ok;
    }
    if (S().pov && data && data.tracks.length >= 2) {
      var cams = [];
      data.tracks.forEach(function (a) {
        var v = camOf(a);
        if (cams.indexOf(v) < 0) cams.push(v);
      });
      return cams;
    }
    return vids.length ? [vids[0].index] : [];
  }

  function problem() {
    if (!data) return '';
    var st = enabledStages();
    if (!st.length) return 'Active au moins une étape';
    if (S().pov && data.tracks.length >= 2) {
      var seen = {};
      for (var i = 0; i < data.tracks.length; i++) {
        var v = camOf(data.tracks[i]);
        if (seen[v]) return 'POV : deux micros ont la même caméra';
        seen[v] = true;
      }
      if (wideTrack() >= 0 && seen[wideTrack()]) return 'POV : le plan large est aussi la caméra d\'un intervenant';
    }
    if (S().zoom && !zoomTracks().length) return 'Zoom : aucune piste vidéo à zoomer';
    if (S().zoom && !ctx.store.zoom.zooms.length) return 'Zoom : la liste des zooms est vide';
    return '';
  }

  function render() {
    if (!data) {
      $('x-stages').innerHTML = '';
      return;
    }
    var info = ctx.state.info;
    var box = $('x-stages');
    box.innerHTML = '';
    STAGES.forEach(function (st, n) {
      var on = S()[st.id];
      var povImpossible = st.id === 'pov' && data.tracks.length < 2;
      var row = document.createElement('div');
      row.className = 'x-stage' + (on && !povImpossible ? ' on' : '') + (status[st.id] ? ' st-' + status[st.id].state : '');
      var head = document.createElement('label');
      head.className = 'x-head';
      var sw = document.createElement('input');
      sw.type = 'checkbox';
      sw.className = 'x-switch';
      sw.checked = on && !povImpossible;
      sw.disabled = povImpossible || ctx.state.busy || !!data.done;
      sw.addEventListener('change', function () {
        S()[st.id] = sw.checked;
        save();
      });
      var num = document.createElement('span');
      num.className = 'x-num';
      num.textContent = String(n + 1);
      var title = document.createElement('span');
      title.className = 'x-title';
      title.innerHTML = '<b></b><em></em>';
      title.querySelector('b').textContent = st.label;
      title.querySelector('em').textContent = povImpossible ? 'il faut au moins deux micros (étape 1)' : st.desc;
      var state = document.createElement('span');
      state.className = 'x-state';
      state.textContent = status[st.id] ? status[st.id].text : '';
      head.appendChild(sw);
      head.appendChild(num);
      head.appendChild(title);
      head.appendChild(state);
      row.appendChild(head);
      var body = document.createElement('div');
      body.className = 'x-body';
      if (st.id === 'silences') renderSilences(body);
      else if (st.id === 'pov' && !povImpossible) renderPov(body, info);
      else if (st.id === 'zoom') renderZoom(body, info);
      row.appendChild(body);
      box.appendChild(row);
    });
    ctx.updateUi();
  }

  function numInput(value, attrs, onChange) {
    var i = document.createElement('input');
    i.type = 'number';
    i.className = 'num';
    for (var k in attrs) i.setAttribute(k, attrs[k]);
    i.value = String(value);
    i.addEventListener('change', function () {
      onChange(parseFloat(i.value));
    });
    return i;
  }

  function field(label, input, unit) {
    var w = document.createElement('label');
    w.className = 'x-field';
    var t = document.createElement('span');
    t.textContent = label;
    w.appendChild(t);
    w.appendChild(input);
    if (unit) {
      var u = document.createElement('span');
      u.className = 'unit';
      u.textContent = unit;
      w.appendChild(u);
    }
    return w;
  }

  function renderSilences(body) {
    var p = ctx.store.params;
    body.appendChild(field('Bruit', numInput(p.noiseLevel, { min: -60, max: 0, step: 1 }, function (v) {
      ctx.store.params.noiseLevel = v;
      ctx.store.params = D.normalizeParams(ctx.store.params);
      save();
    }), 'dB'));
    body.appendChild(field('Silence min.', numInput(p.minTimeOfSilence, { min: 0, step: 0.05 }, function (v) {
      ctx.store.params.minTimeOfSilence = v;
      ctx.store.params = D.normalizeParams(ctx.store.params);
      save();
    }), 's'));
    var mode = document.createElement('select');
    [['delete', 'Supprimer'], ['delete_keep_spaces', 'Supprimer, garder les espaces']].forEach(function (o) {
      var op = document.createElement('option');
      op.value = o[0];
      op.textContent = o[1];
      mode.appendChild(op);
    });
    mode.value = p.silences === 'delete_keep_spaces' ? 'delete_keep_spaces' : 'delete';
    mode.addEventListener('change', function () {
      ctx.store.params.silences = mode.value;
      save();
    });
    body.appendChild(field('Silences', mode));
  }

  function renderPov(body, info) {
    data.tracks.forEach(function (a) {
      var sel = document.createElement('select');
      info.video.forEach(function (v) {
        var o = document.createElement('option');
        o.value = String(v.index);
        o.textContent = 'V' + (v.index + 1);
        sel.appendChild(o);
      });
      sel.value = String(camOf(a));
      sel.addEventListener('change', function () {
        ctx.store.pov.cams[a] = parseInt(sel.value, 10);
        save();
      });
      body.appendChild(field('A' + (a + 1) + ' →', sel));
    });
    var wide = document.createElement('select');
    wide.innerHTML = '<option value="-1">aucun</option>';
    info.video.forEach(function (v) {
      var o = document.createElement('option');
      o.value = String(v.index);
      o.textContent = 'V' + (v.index + 1);
      wide.appendChild(o);
    });
    wide.value = String(wideTrack());
    wide.addEventListener('change', function () {
      ctx.store.pov.wide = parseInt(wide.value, 10);
      save();
    });
    body.appendChild(field('Plan large', wide));
    body.appendChild(field('Plan min.', numInput(ctx.store.pov.minShot, { min: 0.2, max: 30, step: 0.5 }, function (v) {
      ctx.store.pov.minShot = Math.max(0.2, Math.min(30, v || 2));
      save();
    }), 's'));
  }

  function renderZoom(body, info) {
    var chosen = zoomTracks();
    var wrap = document.createElement('div');
    wrap.className = 'x-field';
    wrap.appendChild(document.createTextNode('Pistes'));
    info.video.filter(function (t) { return t.clips > 0; }).forEach(function (t) {
      var l = document.createElement('label');
      l.className = 'check';
      var c = document.createElement('input');
      c.type = 'checkbox';
      c.checked = chosen.indexOf(t.index) >= 0;
      c.disabled = t.locked;
      c.addEventListener('change', function () {
        var now = zoomTracks().filter(function (i) { return i !== t.index; });
        if (c.checked) now.push(t.index);
        now.sort();
        S().zoomTracks = now;
        save();
      });
      var s = document.createElement('span');
      s.textContent = 'V' + (t.index + 1);
      l.appendChild(c);
      l.appendChild(s);
      wrap.appendChild(l);
    });
    body.appendChild(wrap);
    var z = ctx.store.zoom;
    body.appendChild(field('Un clip sur', numInput(z.freqMin, { min: 1, max: 50, step: 1 }, function (v) {
      z.freqMin = v;
      if (z.freqMax < v) z.freqMax = v;
      ctx.store.zoom = ZP.normalize(z);
      save();
    })));
    body.appendChild(field('à', numInput(z.freqMax, { min: 1, max: 50, step: 1 }, function (v) {
      z.freqMax = v;
      if (z.freqMin > v) z.freqMin = v;
      ctx.store.zoom = ZP.normalize(z);
      save();
    })));
    var chips = document.createElement('div');
    chips.className = 'x-chips';
    z.zooms.forEach(function (zz) {
      var c = document.createElement('span');
      c.textContent = ZP.describe(zz);
      chips.appendChild(c);
    });
    if (!z.zooms.length) chips.textContent = 'Aucun zoom : ajoute-les dans Zoom.';
    body.appendChild(chips);
  }

  function save() {
    ctx.saveSettings();
    render();
  }

  function setStatus(id, state, text) {
    status[id] = { state: state, text: text || '' };
    render();
  }

  // ------------------------------------------------------------- execution

  function sleep(ms) {
    return new Promise(function (r) {
      setTimeout(r, ms);
    });
  }

  /** Deroule begin / step / finish d'un outil Premiere, avec progression. */
  function runSteps(prefix, planPath, label, phases) {
    return ctx.call(prefix + '_begin', [planPath]).then(function (begin) {
      if (!begin.ok) throw new Error(begin.error || 'Préparation impossible.');
      var loop = function () {
        if (ctx.state.cancel) return ctx.call(prefix + '_cancel');
        return ctx.call(prefix + '_step', ['250']).then(function (st) {
          if (!st.ok) return ctx.call(prefix + '_cancel');
          ctx.setProgress(st.total ? st.done / st.total : null, label + ' · ' + ((phases && phases[st.phase]) || '') + (st.total > 1 ? ' ' + st.done + ' / ' + st.total : ''));
          if (st.finished) return ctx.call(prefix + '_finish');
          return sleep(10).then(loop);
        });
      };
      return loop();
    });
  }

  function writePlan(name, lines) {
    if (ctx.DEMO) return '';
    var p = ctx.N().path.join(ctx.tempDir(), 'plan-' + name + '-' + Date.now() + '.txt');
    ctx.N().fs.writeFileSync(p, lines.join('\n') + '\n', 'utf8');
    return p;
  }

  function removeFile(p) {
    if (!p) return;
    try {
      ctx.N().fs.unlinkSync(p);
    } catch (e) {}
  }

  /** Relit la sequence ; rend { info, f } ou leve une erreur. */
  function reread() {
    return ctx.refresh(true).then(function (ok) {
      if (!ok) throw new Error('Premiere ne répond plus : la séquence active est-elle toujours ouverte ?');
      return { info: ctx.state.info, f: ctx.seqFrame(ctx.state.info) };
    });
  }

  /** Exporte des pistes audio sur la zone et rend l'enveloppe alignee sur son debut. */
  function zoneEnvelope(z, tracks, hop, label, demoK) {
    var range = { startFrame: z.sections[0].startFrame, endFrame: z.sections[z.sections.length - 1].endFrame, fps: z.f.fps };
    var dur = (range.endFrame - range.startFrame) / range.fps;
    if (ctx.DEMO) {
      return Promise.resolve(demoK === undefined ? global.ADDemo.envelope(range) : global.ADDemo.povEnvelope(demoK.k, demoK.n, dur, hop));
    }
    var f = z.f;
    var zoneExport = z.mode === 'inout' && range.startFrame === f.inFrame && range.endFrame === f.outFrame && (f.inValid || f.outValid);
    var preset = ctx.findWavPreset(z.info.appPath, z.info.appVersion);
    if (!preset) return Promise.reject(new Error('Préconfiguration d\'export WAV de Premiere introuvable.'));
    var wav = ctx.N().path.join(ctx.tempDir(), 'analyse-express-' + Date.now() + '.wav');
    ctx.setProgress(null, label + ' : export de l\'audio par Premiere…');
    return ctx.call('ADR_exportAudio', [wav, preset, zoneExport ? '1' : '0', tracks.join(',')])
      .then(function (r) {
        if (!r.ok) throw new Error(r.error || 'Export audio impossible.');
        return W.readEnvelope(wav, hop, function (x) {
          ctx.setProgress(x, label + ' : lecture de l\'audio ' + Math.round(x * 100) + ' %');
        });
      })
      .then(function (env) {
        removeFile(wav);
        var offset = zoneExport ? 0 : range.startFrame / range.fps;
        var i0 = Math.min(env.peaks.length, Math.round(offset / env.hopSec));
        var i1 = Math.min(env.peaks.length, i0 + Math.ceil(dur / env.hopSec));
        return { hopSec: env.hopSec, peaks: env.peaks.subarray(i0, i1) };
      });
  }

  /** Position d'une image apres retrait de plages [a, b[ (en images) avant elle. */
  function shiftFrame(frame, removed) {
    var d = 0;
    for (var i = 0; i < removed.length; i++) {
      var a = removed[i].startFrame;
      var b = removed[i].endFrame;
      if (frame <= a) break;
      d += Math.min(b, frame) - a;
    }
    return frame - d;
  }

  // ---- etape 1 : silences
  function stageSilences(z, backup, report) {
    var p = ctx.store.params;
    return zoneEnvelope(z, z.tracks, 0.005, 'Silences').then(function (env) {
      var plan = D.detectSections(env, z.sections[0].startFrame, z.sections, p, z.f.fps);
      if (!plan.audio.length) {
        report.silences = 'aucun silence trouvé';
        return { sections: z.sections, modified: false };
      }
      var lines = ['version=1', 'mode=' + plan.params.silences, 'sequenceId=' + z.info.sequence.id, 'timebase=' + z.info.sequence.timebase,
        'backup=' + (backup ? '1' : '0'), 'backupName=' + backupName(z), 'detectTracks=' + z.tracks.join(','),
        'outFrame=' + (z.mode === 'inout' && z.f.outValid ? z.sections[z.sections.length - 1].endFrame : -1)];
      plan.video.forEach(function (s) {
        lines.push('V ' + s.startFrame + ' ' + s.endFrame);
      });
      plan.audio.forEach(function (s) {
        lines.push('A ' + s.startFrame + ' ' + s.endFrame);
      });
      var path = writePlan('express-silences', lines);
      return runSteps('ADR', path, 'Silences', { razor: 'coupes', remove: 'retrait', move: 'resserrement', verify: 'contrôle', relink: 'liens', link: 'liens' })
        .then(function (fin) {
          removeFile(path);
          if (!fin.ok) throw new Error('Silences : ' + (fin.error || 'contrôle final en écart, recette arrêtée'));
          report.silences = plan.stats.count + ' silences, ' + (Math.round(fin.removedSeconds * 10) / 10).toString().replace('.', ',') + ' s retirées';
          var removed = plan.params.silences === 'delete' ? plan.audio : [];
          var sections = z.sections.map(function (s) {
            return { startFrame: shiftFrame(s.startFrame, removed), endFrame: shiftFrame(s.endFrame, removed) };
          }).filter(function (s) {
            return s.endFrame - s.startFrame >= 1;
          });
          ctx.log(fin.log || []);
          return { sections: sections, modified: true, backupName: fin.backupName };
        });
    });
  }

  // ---- etape 2 : POV
  function stagePov(z, backup, report) {
    var pv = ctx.store.pov;
    var hop = 0.02;
    var envs = [];
    var chain = Promise.resolve();
    z.tracks.forEach(function (a, k) {
      chain = chain.then(function () {
        return zoneEnvelope(z, [a], hop, 'POV · micro A' + (a + 1), { k: k, n: z.tracks.length }).then(function (e) {
          envs.push({ hopSec: hop, peaks: e.peaks });
        });
      });
    });
    return chain.then(function () {
      var n = Math.min.apply(null, envs.map(function (e) { return e.peaks.length; }));
      envs = envs.map(function (e) { return { hopSec: hop, peaks: e.peaks.subarray(0, n) }; });
      var params = {
        thresholds: z.tracks.map(function (a) {
          return pv.thresholds[a] === undefined ? null : pv.thresholds[a];
        }),
        dominance: pv.dominance,
        minShot: pv.minShot,
        lead: pv.lead,
        wideOnBoth: pv.wideOnBoth,
        wideOnSilence: pv.wideOnSilence,
        hasWide: wideTrack() >= 0
      };
      var start0 = z.sections[0].startFrame;
      var frames = [];
      z.sections.forEach(function (sec) {
        var i0 = Math.round((sec.startFrame - start0) / z.f.fps / hop);
        var i1 = Math.round((sec.endFrame - start0) / z.f.fps / hop);
        var part = envs.map(function (e) { return { hopSec: hop, peaks: e.peaks.subarray(i0, Math.min(n, i1)) }; });
        if (!part[0].peaks.length) return;
        frames = frames.concat(P.toFrames(P.analyze(part, params).shots, sec.startFrame, sec.endFrame, z.f.fps));
      });
      if (!frames.length) {
        report.pov = 'rien à analyser';
        return null;
      }
      var cams = [];
      z.tracks.forEach(function (a) {
        var v = camOf(a);
        if (cams.indexOf(v) < 0) cams.push(v);
      });
      var w = wideTrack();
      if (w >= 0 && cams.indexOf(w) < 0) cams.push(w);
      var lines = ['version=1', 'sequenceId=' + z.info.sequence.id, 'timebase=' + z.info.sequence.timebase,
        'backup=' + (backup ? '1' : '0'), 'backupName=' + backupName(z)];
      cams.forEach(function (t) {
        lines.push('T ' + t);
      });
      var switches = 0;
      frames.forEach(function (f, i) {
        lines.push('S ' + f.startFrame + ' ' + f.endFrame + ' ' + (f.cam === P.WIDE ? w : camOf(z.tracks[f.cam])));
        if (i && frames[i - 1].endFrame === f.startFrame && frames[i - 1].cam !== f.cam) switches++;
      });
      var path = writePlan('express-pov', lines);
      return runSteps('ADP', path, 'POV', { razor: 'coupes', toggle: 'caméras', verify: 'contrôle' }).then(function (fin) {
        removeFile(path);
        ctx.log(fin.log || []);
        if (!fin.ok && (fin.code === 'CANCELLED' || fin.code === 'RAZOR_FAILED' || (!fin.enabled && !fin.disabled && fin.code))) {
          throw new Error('POV : ' + (fin.error || 'arrêt'));
        }
        report.pov = switches + ' changements de plan' + (fin.ok ? '' : ' (avec écarts, voir le journal)');
        return fin;
      });
    });
  }

  // ---- etape 3 : Zoom
  function stageZoom(z, backup, report) {
    var tracks = zoomTracks();
    return ctx.call('ADZ_listClips', [tracks.join(',')]).then(function (res) {
      if (!res.ok) throw new Error('Zoom : ' + (res.error || 'lecture des clips impossible'));
      var tb = z.info.sequence.timebase;
      var sectionsTicks = z.sections.map(function (s) {
        return [s.startFrame * tb, s.endFrame * tb];
      });
      var usable = res.tracks.filter(function (t) { return !t.locked; });
      var plan = ZP.buildPlan(usable, sectionsTicks, 'inout', ctx.store.zoom, (Math.random() * 1e9) >>> 0);
      if (!plan.items.length) {
        report.zoom = 'aucun clip à zoomer';
        return null;
      }
      var lines = ['version=1', 'sequenceId=' + z.info.sequence.id, 'backup=' + (backup ? '1' : '0'), 'backupName=' + backupName(z)];
      plan.items.forEach(function (it) {
        lines.push('Z ' + it.track + ' ' + it.i + ' ' + it.s + ' ' + it.e + ' ' + it.from + ' ' + it.to + ' ' + it.duration + ' ' +
          (it.ease ? '1' : '0') + ' ' + (it.point ? it.point.x + ' ' + it.point.y : '-1 -1'));
      });
      var path = writePlan('express-zoom', lines);
      return runSteps('ADZ', path, 'Zoom', {}).then(function (fin) {
        removeFile(path);
        ctx.log(fin.log || []);
        if (fin.code === 'CANCELLED') throw new Error('Zoom interrompu.');
        report.zoom = fin.applied + ' zooms posés' + (fin.failed ? ', ' + fin.failed + ' échecs' : '');
        return fin;
      });
    });
  }

  function backupName(z) {
    var now = new Date();
    return z.info.sequence.name + ' - avant Montage express ' + now.getHours() + 'h' + ctx.p2(now.getMinutes());
  }

  function run() {
    if (ctx.state.busy || !data || problem()) return Promise.resolve();
    var stages = enabledStages();
    var report = {};
    var backupLeft = S().backup;
    var backupName0 = '';
    status = {};
    stages.forEach(function (st) {
      status[st.id] = { state: 'wait', text: 'en attente' };
    });
    STAGES.forEach(function (st) {
      if (!status[st.id]) status[st.id] = { state: 'skip', text: 'désactivée' };
    });
    ctx.setBusy(true);
    ctx.state.cancel = false;
    ctx.banner('');
    showResult();
    $('btn-cancel').classList.remove('hidden');
    render();

    var zone = { sections: data.sections.slice(), mode: data.mode, tracks: data.tracks.slice() };
    var chain = reread().then(function (r) {
      if (r.info.sequence.id !== data.seqId || r.info.sequence.fingerprint !== data.fingerprint) {
        throw new Error('La timeline a changé depuis la validation : valide à nouveau les sections.');
      }
      zone.info = r.info;
      zone.f = r.f;
    });

    stages.forEach(function (st) {
      chain = chain.then(function () {
        if (ctx.state.cancel) throw new Error('Recette interrompue.');
        setStatus(st.id, 'run', 'en cours…');
        var job = st.id === 'silences' ? stageSilences(zone, backupLeft, report)
          : st.id === 'pov' ? stagePov(zone, backupLeft, report)
          : stageZoom(zone, backupLeft, report);
        return job
          .then(function (out) {
            if (st.id === 'silences' && out) zone.sections = out.sections;
            if (out && out.backupName && !backupName0) backupName0 = out.backupName;
            // une seule sauvegarde : des qu'une etape a reellement modifie la sequence
            if (out && out.modified !== false) backupLeft = false;
            setStatus(st.id, 'done', report[st.id] || 'fait');
            return reread();
          })
          .then(function (r) {
            zone.info = r.info;
            zone.f = r.f;
          });
      });
    });

    return chain
      .then(function () {
        var lines = stages.map(function (st) {
          return st.label + ' : ' + (report[st.id] || 'fait');
        });
        showResult('ok', 'Recette terminée.\n' + lines.join('\n') + (backupName0 ? '\nSauvegarde intacte dans le projet : « ' + backupName0 + ' ».' : ''));
        // on garde l'affichage des etapes et de leur bilan ; un nouveau passage repart des sections
        data.done = true;
      })
      .catch(function (e) {
        var cur = stages.filter(function (st) {
          return status[st.id] && status[st.id].state === 'run';
        })[0];
        if (cur) setStatus(cur.id, 'error', 'arrêt');
        stages.forEach(function (st) {
          if (status[st.id].state === 'wait') setStatus(st.id, 'skip', 'non lancée');
        });
        var done = stages.filter(function (st) { return status[st.id].state === 'done'; }).map(function (st) { return st.label; });
        showResult('error', (e && e.message ? e.message : 'Recette arrêtée.') +
          (done.length ? '\nDéjà fait : ' + done.join(', ') + '. Annule dans Premiere (Ctrl+Z) ou repars de la sauvegarde.' : '\nLa timeline n\'a pas été modifiée.'));
        $('log-card').open = true;
        data.done = true;
      })
      .then(function () {
        ctx.hideProgress();
        ctx.setBusy(false);
        render();
        window.scrollTo(0, 0);
        return ctx.refresh(true);
      });
  }

  function showResult(kind, text) {
    var el = $('x-result');
    if (!text) {
      el.className = 'result hidden';
      el.textContent = '';
      return;
    }
    el.className = 'result ' + kind;
    el.textContent = text;
  }

  // ------------------------------------------------------------------ etapes

  function validate(sections, mode, tracks) {
    return ctx.refresh(false).then(function (ok) {
      if (!ok) return;
      var info = ctx.state.info;
      data = { sections: sections, mode: mode, tracks: tracks, seqId: info.sequence.id, fingerprint: info.sequence.fingerprint };
      status = {};
      showResult();
      ctx.show('tool', 2);
      render();
    });
  }

  function footer() {
    var busy = ctx.state.busy;
    if (!data || data.done) return { text: 'Revenir aux sections', disabled: busy, msg: '' };
    var pb = problem();
    var n = enabledStages().length;
    return {
      text: 'Lancer la recette (' + n + ' étape' + (n > 1 ? 's' : '') + ')',
      disabled: busy || !!pb,
      msg: busy ? '' : pb
    };
  }

  function init(c) {
    ctx = c;
    ctx.store.express = normalize(ctx.store.express);
    $('x-backup').checked = S().backup;
    $('x-backup').addEventListener('change', function () {
      S().backup = $('x-backup').checked;
      ctx.saveSettings();
    });
  }

  global.ADExpress = {
    init: init,
    validate: validate,
    run: run,
    footer: footer,
    hasData: function () {
      return !!data && !data.done;
    },
    isStale: function (info) {
      return !!data && !data.done && !ctx.state.busy && (data.seqId !== info.sequence.id || data.fingerprint !== info.sequence.fingerprint);
    },
    drop: function (message) {
      data = null;
      render();
      if (message) {
        ctx.banner(message);
        if (ctx.state.screen === 'tool' && ctx.state.tool === 'express' && ctx.state.step === 2) ctx.show('tool', 1);
      }
    },
    showResult: showResult,
    shiftFrame: shiftFrame,
    render: render
  };
})(window);
