/* POV - ecran de reglages (etape 2) et application dans Premiere.
 *
 * Etape 1 (commune, app.js) : zone + pistes audio, une par intervenant.
 * Validation : chaque micro est exporte seul et mesure. Ensuite tout reglage
 * recalcule le montage instantanement sur ces mesures.
 * Application : coupe les pistes video concernees a chaque changement de plan,
 * puis active la camera de celui qui parle et desactive les autres.
 */
(function (global) {
  'use strict';

  var P = global.ADPovPlan;
  var COLORS = ['#f26a2e', '#3ddc97', '#6f8bff', '#f2b84b', '#e05bd0', '#36c5e0'];
  var WIDE_COLOR = '#d5dbe8';
  var HOP = 0.02;

  var DEFAULTS = {
    cams: {}, // piste audio -> piste video
    wide: -1,
    thresholds: {}, // piste audio -> dB (absent = automatique)
    dominance: 6,
    minShot: 2,
    lead: 0,
    wideOnBoth: true,
    wideOnSilence: false,
    backup: true
  };

  var ctx = null;
  var data = null;
  var result = null; // { perSection: [...], shots (secondes depuis le debut de la zone), stats }
  var grow = 1;

  function $(id) {
    return document.getElementById(id);
  }

  function S() {
    return ctx.store.pov;
  }

  function color(k) {
    return COLORS[k % COLORS.length];
  }

  function normalize(s) {
    var o = {};
    var k;
    for (k in DEFAULTS) o[k] = DEFAULTS[k];
    for (k in s || {}) if (Object.prototype.hasOwnProperty.call(DEFAULTS, k)) o[k] = s[k];
    o.cams = o.cams && typeof o.cams === 'object' ? o.cams : {};
    o.thresholds = o.thresholds && typeof o.thresholds === 'object' ? o.thresholds : {};
    var p = P.normalize(o);
    o.dominance = p.dominance;
    o.minShot = p.minShot;
    o.lead = p.lead;
    o.wide = parseInt(o.wide, 10);
    if (isNaN(o.wide)) o.wide = -1;
    o.backup = o.backup !== false;
    return o;
  }

  function fmtPct(x) {
    return Math.round(x * 100) + ' %';
  }

  // ------------------------------------------------------------ correspondances

  /** Camera d'un intervenant : choix enregistre, sinon la piste video de meme numero. */
  function camOf(audioIndex) {
    var info = ctx.state.info;
    var v = S().cams[audioIndex];
    var vids = info ? info.video : [];
    if (v !== undefined && vids.some(function (t) { return t.index === v; })) return v;
    if (vids.some(function (t) { return t.index === audioIndex; })) return audioIndex;
    return vids.length ? vids[0].index : 0;
  }

  function wideTrack() {
    var info = ctx.state.info;
    var w = S().wide;
    if (w >= 0 && info && info.video.some(function (t) { return t.index === w; })) return w;
    return -1;
  }

  /** Probleme de configuration qui empeche d'appliquer, ou ''. */
  function configProblem() {
    if (!data) return '';
    var seen = {};
    var dup = false;
    data.tracks.forEach(function (a) {
      var v = camOf(a);
      if (seen[v] !== undefined) dup = true;
      seen[v] = a;
    });
    if (dup) return 'Deux intervenants ont la même caméra';
    var w = wideTrack();
    if (w >= 0 && seen[w] !== undefined) return 'Le plan large ne peut pas être la caméra d\'un intervenant';
    var info = ctx.state.info;
    var locked = info.video.filter(function (t) {
      return t.locked && (seen[t.index] !== undefined || t.index === w);
    });
    if (locked.length) return 'V' + (locked[0].index + 1) + ' est verrouillée dans Premiere';
    return '';
  }

  function renderSpeakers() {
    var box = $('p-speakers');
    box.innerHTML = '';
    if (!data) return;
    var info = ctx.state.info;
    data.tracks.forEach(function (a, k) {
      var t = info.audio.filter(function (x) {
        return x.index === a;
      })[0];
      var row = document.createElement('div');
      row.className = 'p-row';
      row.style.setProperty('--c', color(k));
      var name = document.createElement('div');
      name.className = 'p-name';
      name.innerHTML = '<i></i><b>A' + (a + 1) + '</b><span></span>';
      name.querySelector('span').textContent = t ? t.name : '';
      var arrow = document.createElement('span');
      arrow.className = 'z-arrow';
      arrow.textContent = '→';
      var sel = document.createElement('select');
      info.video.forEach(function (v) {
        var o = document.createElement('option');
        o.value = String(v.index);
        o.textContent = 'V' + (v.index + 1) + (v.name ? ' · ' + v.name : '') + (v.locked ? ' (verrouillée)' : '');
        sel.appendChild(o);
      });
      sel.value = String(camOf(a));
      sel.addEventListener('change', function () {
        S().cams[a] = parseInt(sel.value, 10);
        save();
        recompute();
      });
      var thr = document.createElement('input');
      thr.type = 'number';
      thr.className = 'num';
      thr.min = '-80';
      thr.max = '0';
      thr.step = '1';
      thr.placeholder = 'auto';
      thr.title = 'Seuil de parole de ce micro (dB). Vide = automatique.';
      var saved = S().thresholds[a];
      thr.value = saved === undefined || saved === null ? '' : String(saved);
      thr.addEventListener('change', function () {
        var v = thr.value.trim();
        if (v === '') delete S().thresholds[a];
        else S().thresholds[a] = Math.max(-80, Math.min(0, parseFloat(v) || -40));
        save();
        recompute();
      });
      var unit = document.createElement('span');
      unit.className = 'unit';
      unit.setAttribute('data-thr', String(k));
      var cam = document.createElement('div');
      cam.className = 'p-cam';
      cam.appendChild(arrow);
      cam.appendChild(sel);
      var lvl = document.createElement('div');
      lvl.className = 'p-thr';
      lvl.appendChild(document.createTextNode('seuil'));
      lvl.appendChild(thr);
      lvl.appendChild(unit);
      row.appendChild(name);
      row.appendChild(cam);
      row.appendChild(lvl);
      box.appendChild(row);
    });

    var wsel = $('p-wide');
    wsel.innerHTML = '<option value="-1">Aucun</option>';
    info.video.forEach(function (v) {
      var o = document.createElement('option');
      o.value = String(v.index);
      o.textContent = 'V' + (v.index + 1) + (v.name ? ' · ' + v.name : '');
      wsel.appendChild(o);
    });
    wsel.value = String(wideTrack());
  }

  // ---------------------------------------------------------------- calcul

  function params() {
    var s = S();
    return {
      thresholds: data.tracks.map(function (a) {
        var t = s.thresholds[a];
        return t === undefined ? null : t;
      }),
      dominance: s.dominance,
      minShot: s.minShot,
      lead: s.lead,
      wideOnBoth: s.wideOnBoth,
      wideOnSilence: s.wideOnSilence,
      hasWide: wideTrack() >= 0
    };
  }

  /** Recalcule le montage sur chaque section, a partir des mesures deja faites. */
  function recompute() {
    if (!data) {
      result = null;
      render();
      return;
    }
    var p = params();
    var fps = data.f.fps;
    var all = [];
    var frames = [];
    var thresholds = null;
    var levels = null;
    data.sections.forEach(function (sec) {
      var i0 = Math.round((sec.startFrame - data.range.startFrame) / fps / HOP);
      var i1 = Math.round((sec.endFrame - data.range.startFrame) / fps / HOP);
      var envs = data.envs.map(function (e) {
        return { hopSec: HOP, peaks: e.peaks.subarray(Math.max(0, i0), Math.min(e.peaks.length, i1)) };
      });
      if (!envs[0].peaks.length) return;
      var r = P.analyze(envs, p);
      thresholds = thresholds || r.thresholds;
      var offset = (sec.startFrame - data.range.startFrame) / fps;
      r.shots.forEach(function (s) {
        all.push({ a: s.a + offset, b: s.b + offset, cam: s.cam });
      });
      frames = frames.concat(P.toFrames(r.shots, sec.startFrame, sec.endFrame, fps));
    });
    // seuils et niveaux sur toute la zone, pour l'apercu
    var whole = P.analyze(data.envs.map(function (e) {
      return { hopSec: HOP, peaks: e.peaks };
    }), p);
    levels = whole.levels;
    thresholds = thresholds || whole.thresholds;
    var switches = 0;
    for (var i = 1; i < frames.length; i++) if (frames[i].cam !== frames[i - 1].cam && frames[i].startFrame === frames[i - 1].endFrame) switches++;
    result = { shots: all, frames: frames, thresholds: thresholds, levels: levels, stats: P.stats(all, data.tracks.length), switches: switches };
    render();
  }

  function render() {
    renderThresholds();
    renderStats();
    draw();
    ctx.updateUi();
  }

  function renderThresholds() {
    var nodes = document.querySelectorAll('#p-speakers [data-thr]');
    for (var i = 0; i < nodes.length; i++) {
      var k = parseInt(nodes[i].getAttribute('data-thr'), 10);
      nodes[i].textContent = result && result.thresholds[k] !== undefined ? 'dB (' + Math.round(result.thresholds[k]) + ')' : 'dB';
    }
  }

  function renderStats() {
    var box = $('p-stats');
    box.innerHTML = '';
    if (!result) return;
    var st = result.stats;
    var items = [[String(result.switches), 'changements de plan']];
    data.tracks.forEach(function (a, k) {
      items.push([fmtPct((st.per[k] || 0) / Math.max(1e-9, st.total)), 'sur A' + (a + 1)]);
    });
    if (wideTrack() >= 0) items.push([fmtPct((st.per[P.WIDE] || 0) / Math.max(1e-9, st.total)), 'plan large']);
    items.forEach(function (it, idx) {
      var d = document.createElement('div');
      d.className = 'stat';
      if (idx > 0) d.style.setProperty('--c', idx - 1 < data.tracks.length ? color(idx - 1) : WIDE_COLOR);
      d.innerHTML = '<b class="bump"></b><span></span>';
      d.querySelector('b').textContent = it[0];
      d.querySelector('span').textContent = it[1];
      box.appendChild(d);
    });
  }

  /** Une ligne par micro (niveau, colore quand il parle), puis la ligne du montage. */
  function draw() {
    if (ctx.state.screen !== 'tool' || ctx.state.tool !== 'pov' || ctx.state.step !== 2) return;
    var cv = $('p-canvas');
    var g = ctx.prepCanvas(cv);
    var c = g.ctx;
    if (!result || !data) return;
    var n = data.tracks.length;
    var rowH = Math.max(18, Math.floor((g.h - 34) / n));
    var total = result.levels[0].length * HOP;
    var xOf = function (t) {
      return (t / total) * g.w;
    };
    var cols = Math.floor(g.w);
    for (var k = 0; k < n; k++) {
      var y0 = k * rowH;
      c.fillStyle = '#12151b';
      c.fillRect(0, y0 + 1, g.w, rowH - 2);
      var lv = result.levels[k];
      var thr = result.thresholds[k];
      for (var x = 0; x < cols; x++) {
        var i0 = Math.floor((x / cols) * lv.length);
        var i1 = Math.max(i0 + 1, Math.floor(((x + 1) / cols) * lv.length));
        var m = -120;
        for (var i = i0; i < i1; i++) if (lv[i] > m) m = lv[i];
        var hgt = Math.max(1, Math.min(1, (m + 66) / 66) * (rowH - 4) * Math.max(0, Math.min(1, grow * 1.6 - (x / cols) * 0.6)));
        c.fillStyle = m >= thr ? color(k) : '#343c4f';
        c.fillRect(x, y0 + rowH - 2 - hgt, 1, hgt);
      }
      c.fillStyle = 'rgba(255,255,255,.7)';
      c.font = '10px Inter, "Segoe UI", Arial, sans-serif';
      c.fillText('A' + (data.tracks[k] + 1), 4, y0 + 11);
    }
    // montage
    var my = n * rowH + 6;
    c.fillStyle = '#12151b';
    c.fillRect(0, my, g.w, 24);
    result.shots.forEach(function (s) {
      var x0 = xOf(s.a);
      var w = Math.max(1, xOf(s.b) - x0 - 1);
      c.fillStyle = s.cam === P.WIDE ? WIDE_COLOR : color(s.cam);
      c.globalAlpha = 0.9;
      c.fillRect(x0, my + 3, w * Math.max(0, Math.min(1, grow * 1.6 - (x0 / g.w) * 0.6)), 18);
      c.globalAlpha = 1;
    });
    c.fillStyle = 'rgba(0,0,0,.65)';
    c.fillText('montage', 5, my + 15);
  }

  function animateIn() {
    grow = 0;
    ctx.tween(650, function (k) {
      grow = k;
      draw();
    });
  }

  // ------------------------------------------------------------- étapes

  /** Exporte chaque micro seul et le mesure. */
  function validate(sections, mode, tracks) {
    if (tracks.length < 2) {
      ctx.banner('POV a besoin d\'au moins deux pistes audio : une par intervenant.', 'error');
      return Promise.resolve();
    }
    var info;
    var envs = [];
    ctx.setBusy(true);
    ctx.banner('');
    showResult();
    return ctx
      .refresh(false)
      .then(function (ok) {
        if (!ok) throw new Error('');
        info = ctx.state.info;
        var f = ctx.seqFrame(info);
        var range = { startFrame: sections[0].startFrame, endFrame: sections[sections.length - 1].endFrame };
        var zoneExport = mode === 'inout' && range.startFrame === f.inFrame && range.endFrame === f.outFrame && (f.inValid || f.outValid);
        data = {
          seqId: info.sequence.id,
          seqName: info.sequence.name,
          fingerprint: info.sequence.fingerprint,
          timebase: info.sequence.timebase,
          f: f,
          range: range,
          sections: sections,
          tracks: tracks,
          envs: []
        };
        var dur = (range.endFrame - range.startFrame) / f.fps;
        var offset = zoneExport ? 0 : range.startFrame / f.fps;
        var chain = Promise.resolve();
        tracks.forEach(function (a, k) {
          chain = chain.then(function () {
            var label = 'Mesure de A' + (a + 1) + ' (' + (k + 1) + ' / ' + tracks.length + ')';
            if (ctx.DEMO) {
              envs.push(global.ADDemo.povEnvelope(k, tracks.length, dur, HOP));
              ctx.setProgress((k + 1) / tracks.length, label);
              return null;
            }
            var preset = ctx.findWavPreset(info.appPath, info.appVersion);
            if (!preset) throw new Error('Préconfiguration d\'export WAV de Premiere introuvable.');
            var wav = ctx.N().path.join(ctx.tempDir(), 'analyse-pov-' + Date.now() + '-' + a + '.wav');
            ctx.setProgress(null, label + ' : export par Premiere…');
            return ctx.call('ADR_exportAudio', [wav, preset, zoneExport ? '1' : '0', String(a)])
              .then(function (r) {
                if (!r.ok) throw new Error(r.error || 'Export audio de A' + (a + 1) + ' impossible.');
                return global.ADWav.readEnvelope(wav, HOP, function (x) {
                  ctx.setProgress(x, label + ' : lecture ' + Math.round(x * 100) + ' %');
                });
              })
              .then(function (env) {
                var i0 = Math.round(offset / env.hopSec);
                var cnt = Math.ceil(dur / env.hopSec);
                envs.push({ hopSec: env.hopSec, peaks: env.peaks.subarray(Math.min(env.peaks.length, i0), Math.min(env.peaks.length, i0 + cnt)) });
                try {
                  ctx.N().fs.unlinkSync(wav);
                } catch (e) {}
              });
          });
        });
        return chain;
      })
      .then(function () {
        var n = Math.min.apply(null, envs.map(function (e) {
          return e.peaks.length;
        }));
        if (!(n > 10)) throw new Error('Les exports audio sont vides : vérifie que les pistes ont du son dans la zone.');
        data.envs = envs.map(function (e) {
          return { hopSec: HOP, peaks: e.peaks.subarray(0, n) };
        });
        ctx.hideProgress();
        ctx.state.busy = false;
        ctx.show('tool', 2);
        renderSpeakers();
        recompute();
        animateIn();
        ctx.log('POV : ' + data.seqName + ', micros ' + tracks.map(function (a) { return 'A' + (a + 1); }).join(' ') + ' mesurés.');
      })
      .catch(function (e) {
        data = null;
        if (e && e.message) {
          ctx.banner(e.message, 'error');
          ctx.log('POV impossible : ' + e.message);
        }
      })
      .then(function () {
        ctx.hideProgress();
        ctx.setBusy(false);
      });
  }

  function showResult(kind, text) {
    var el = $('p-result');
    if (!text) {
      el.className = 'result hidden';
      el.textContent = '';
      return;
    }
    el.className = 'result ' + kind;
    el.textContent = text;
  }

  function apply() {
    if (ctx.state.busy || !result || !result.frames.length || configProblem()) return Promise.resolve();
    var s = S();
    var wide = wideTrack();
    var camFor = function (cam) {
      return cam === P.WIDE ? wide : camOf(data.tracks[cam]);
    };
    var tracks = [];
    data.tracks.forEach(function (a) {
      var v = camOf(a);
      if (tracks.indexOf(v) < 0) tracks.push(v);
    });
    if (wide >= 0 && tracks.indexOf(wide) < 0) tracks.push(wide);
    var planPath = '';
    var started = false;
    ctx.setBusy(true);
    ctx.state.cancel = false;
    ctx.banner('');
    showResult();
    return ctx
      .refresh(false)
      .then(function (ok) {
        if (!ok) throw new Error('');
        var info = ctx.state.info;
        if (info.sequence.id !== data.seqId || info.sequence.fingerprint !== data.fingerprint) {
          throw new Error('La timeline a changé depuis la mesure : valide à nouveau les sections.');
        }
        var now = new Date();
        var lines = ['version=1', 'sequenceId=' + data.seqId, 'timebase=' + data.timebase, 'backup=' + (s.backup ? '1' : '0'),
          'backupName=' + data.seqName + ' - avant POV ' + now.getHours() + 'h' + ctx.p2(now.getMinutes())];
        tracks.forEach(function (t) {
          lines.push('T ' + t);
        });
        result.frames.forEach(function (f) {
          lines.push('S ' + f.startFrame + ' ' + f.endFrame + ' ' + camFor(f.cam));
        });
        if (!ctx.DEMO) {
          planPath = ctx.N().path.join(ctx.tempDir(), 'plan-pov-' + Date.now() + '.txt');
          ctx.N().fs.writeFileSync(planPath, lines.join('\n') + '\n', 'utf8');
        }
        ctx.setProgress(null, s.backup ? 'Sauvegarde de la séquence…' : 'Préparation…');
        return ctx.call('ADP_begin', [planPath]);
      })
      .then(function (begin) {
        if (!begin.ok) throw new Error(begin.error || 'Préparation impossible.');
        started = true;
        $('btn-cancel').classList.remove('hidden');
        var PH = { scan: 'Lecture des pistes', razor: 'Coupes aux changements de plan', toggle: 'Activation des caméras', verify: 'Contrôle final' };
        var loop = function () {
          if (ctx.state.cancel) return ctx.call('ADP_cancel');
          return ctx.call('ADP_step', ['250']).then(function (st) {
            if (!st.ok) return ctx.call('ADP_cancel');
            ctx.setProgress(st.total ? st.done / st.total : null, (PH[st.phase] || st.phase) + (st.total > 1 ? ' · ' + st.done + ' / ' + st.total : ''));
            if (st.finished) return ctx.call('ADP_finish');
            return new Promise(function (r) {
              setTimeout(r, 10);
            }).then(loop);
          });
        };
        return loop();
      })
      .then(function (fin) {
        var backup = fin.backupName ? '\nSauvegarde intacte dans le projet : « ' + fin.backupName + ' ».' : '';
        var kind;
        var text;
        if (fin.code === 'CANCELLED' || (fin.code && fin.code !== 'INCOMPLETE' && !fin.enabled && !fin.disabled)) {
          kind = 'error';
          text = (fin.error || 'Interrompu.') + (fin.razorDone ? '\nDes coupes ont été posées : annule dans Premiere (Ctrl+Z) ou repars de la sauvegarde.' : '\nLa timeline n\'a pas été modifiée.');
        } else if (!fin.ok) {
          kind = 'warn';
          text = 'Appliqué avec des écarts : ' + fin.unsplit + ' coupe(s) manquante(s), ' + fin.mismatch + ' clip(s) mal réglé(s), ' +
            fin.refused + ' refus.\n' + (fin.notes || []).slice(0, 4).join('\n');
        } else {
          kind = 'ok';
          text = 'Terminé. ' + result.switches + ' changement' + (result.switches > 1 ? 's' : '') + ' de plan · ' +
            fin.disabled + ' clip' + (fin.disabled > 1 ? 's' : '') + ' désactivé' + (fin.disabled > 1 ? 's' : '') +
            (fin.enabled ? ', ' + fin.enabled + ' réactivé' + (fin.enabled > 1 ? 's' : '') : '') + '.';
        }
        showResult(kind, text + backup);
        var file = ctx.writeLogFile(fin.log || []);
        ctx.log((fin.log || []).concat(file ? ['journal : ' + file] : []));
        if (kind !== 'ok') $('log-card').open = true;
      })
      .catch(function (e) {
        if (e && e.message) {
          showResult('error', e.message + (started ? '' : '\nLa timeline n\'a pas été modifiée.'));
          ctx.log('POV impossible : ' + e.message);
        }
      })
      .then(function () {
        ctx.hideProgress();
        if (planPath) {
          try {
            ctx.N().fs.unlinkSync(planPath);
          } catch (e) {}
        }
        if (started) {
          data = null;
          result = null;
          render();
        }
        ctx.setBusy(false);
        window.scrollTo(0, 0);
        return ctx.refresh(true);
      });
  }

  function footer() {
    var busy = ctx.state.busy;
    if (!data) return { text: 'Revenir aux sections', disabled: busy, msg: '' };
    var problem = configProblem();
    var n = result ? result.switches : 0;
    return {
      text: 'Appliquer ' + n + ' changement' + (n > 1 ? 's' : '') + ' de plan',
      disabled: busy || !!problem || !result || !result.frames.length,
      msg: busy ? '' : problem
    };
  }

  function drop(message) {
    data = null;
    result = null;
    render();
    if (message) {
      ctx.banner(message);
      if (ctx.state.screen === 'tool' && ctx.state.tool === 'pov' && ctx.state.step === 2) ctx.show('tool', 1);
    }
  }

  function save() {
    ctx.saveSettings();
  }

  function bind() {
    $('p-wide').addEventListener('change', function () {
      S().wide = parseInt($('p-wide').value, 10);
      save();
      recompute();
    });
    [['p-dominance', 'dominance'], ['p-minshot', 'minShot'], ['p-lead', 'lead']].forEach(function (pair) {
      $(pair[0]).addEventListener('change', function () {
        S()[pair[1]] = parseFloat($(pair[0]).value);
        ctx.store.pov = normalize(S());
        writeControls();
        save();
        recompute();
      });
    });
    [['p-both', 'wideOnBoth'], ['p-silence', 'wideOnSilence'], ['p-backup', 'backup']].forEach(function (pair) {
      $(pair[0]).addEventListener('change', function () {
        S()[pair[1]] = $(pair[0]).checked;
        save();
        recompute();
      });
    });
    $('p-reset').addEventListener('click', function () {
      var keep = { cams: S().cams, wide: S().wide };
      ctx.store.pov = normalize(keep);
      writeControls();
      renderSpeakers();
      save();
      recompute();
    });
  }

  function writeControls() {
    var s = S();
    $('p-dominance').value = s.dominance;
    $('p-minshot').value = s.minShot;
    $('p-lead').value = s.lead;
    $('p-both').checked = s.wideOnBoth;
    $('p-silence').checked = s.wideOnSilence;
    $('p-backup').checked = s.backup;
  }

  function init(c) {
    ctx = c;
    ctx.store.pov = normalize(ctx.store.pov);
    writeControls();
    bind();
  }

  global.ADPov = {
    init: init,
    validate: validate,
    apply: apply,
    footer: footer,
    draw: draw,
    drop: drop,
    hasData: function () {
      return !!data;
    },
    isStale: function (info) {
      return !!data && (data.seqId !== info.sequence.id || data.fingerprint !== info.sequence.fingerprint);
    },
    showResult: showResult
  };
})(window);
