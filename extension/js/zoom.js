/* Zoom - ecran de reglages (etape 2) et application dans Premiere.
 *
 * L'etape 1 (Sections) est partagee avec Silences et reste dans
 * app.js ; app.js transmet ici ses outils communs par init(ctx).
 *
 * Deroulement :
 *   1. validate : lit les clips des pistes video choisies, tire les zooms,
 *      affiche l'apercu.
 *   2. chaque reglage refait le tirage avec la MEME graine : seul « Nouveau
 *      tirage » change la graine. L'apercu est donc exactement ce qui sera pose.
 *   3. apply : ecrit le plan dans un fichier, Premiere le pose par etapes.
 */
(function (global) {
  'use strict';

  var ZP = global.ADZoomPlan;

  var COLORS = ['#f26a2e', '#3ddc97', '#6f8bff', '#f2b84b', '#e05bd0', '#36c5e0', '#ff5d73', '#a3e635'];
  var TPS = 254016000000;

  var ctx = null;
  var data = null; // { seqId, fingerprint, timebase, mode, sectionsTicks, tracks, seed, locked }
  var plan = null;
  var lastStats = [];
  var grow = 1;

  function $(id) {
    return document.getElementById(id);
  }

  function color(i) {
    return COLORS[i % COLORS.length];
  }

  function newSeed() {
    return (Math.floor(Math.random() * 0x7fffffff) ^ Date.now()) >>> 0;
  }

  function settings() {
    return ctx.store.zoom;
  }

  function fmtNum(v) {
    return String(v).replace('.', ',');
  }

  // ------------------------------------------------------------------ réglages

  function durLabel(d) {
    return d > 0 ? fmtNum(d) + ' s' : 'Tout le clip';
  }

  /** Une ligne de la liste des zooms. */
  function zoomRow(z, idx) {
    var row = document.createElement('div');
    row.className = 'z-row';
    row.style.setProperty('--c', color(idx));
    row.style.setProperty('--zf', String(z.from / 100));
    row.style.setProperty('--zt', String(z.to / 100));

    // L'apercu sert aussi a choisir le point vise : clic = point, double-clic = centre.
    var demo = document.createElement('span');
    demo.className = 'z-demo' + (z.point ? ' has-point' : '');
    demo.title = 'Clique pour choisir le point vers lequel zoomer (ex. ta caméra). Double-clic : centre.';
    var px = z.point ? z.point.x : 0.5;
    var py = z.point ? z.point.y : 0.5;
    row.style.setProperty('--px', px * 100 + '%');
    row.style.setProperty('--py', py * 100 + '%');
    var inner = document.createElement('i');
    demo.appendChild(inner);
    var dot = document.createElement('b');
    dot.className = 'z-dot';
    demo.appendChild(dot);
    var clickTimer = null;
    demo.addEventListener('click', function (ev) {
      var r = demo.getBoundingClientRect();
      var x = (ev.clientX - r.left) / r.width;
      var y = (ev.clientY - r.top) / r.height;
      clearTimeout(clickTimer);
      // on attend un instant : un double-clic ne doit pas d'abord poser un point
      clickTimer = setTimeout(function () {
        update(idx, { point: { x: x, y: y } });
      }, 220);
    });
    demo.addEventListener('dblclick', function () {
      clearTimeout(clickTimer);
      update(idx, { point: null });
    });

    function numField(label, value, onChange) {
      var wrap = document.createElement('label');
      wrap.className = 'z-num';
      var cap = document.createElement('span');
      cap.textContent = label;
      var input = document.createElement('input');
      input.type = 'number';
      input.className = 'num';
      input.min = '10';
      input.max = '400';
      input.step = '1';
      input.value = String(value);
      var unit = document.createElement('span');
      unit.className = 'unit';
      unit.textContent = '%';
      input.addEventListener('change', function () {
        onChange(input.value);
      });
      wrap.appendChild(cap);
      wrap.appendChild(input);
      wrap.appendChild(unit);
      return wrap;
    }

    var from = numField('De', z.from, function (v) {
      update(idx, { from: v });
    });
    var arrow = document.createElement('span');
    arrow.className = 'z-arrow';
    arrow.textContent = '→';
    var to = numField('À', z.to, function (v) {
      update(idx, { to: v });
    });

    var dur = document.createElement('select');
    dur.className = 'z-dur';
    dur.title = 'Durée du mouvement, à partir du début du clip';
    var durations = ZP.DURATIONS.slice();
    if (durations.indexOf(z.duration) < 0) durations.push(z.duration);
    durations.forEach(function (d) {
      var o = document.createElement('option');
      o.value = String(d);
      o.textContent = durLabel(d);
      if (d === z.duration) o.selected = true;
      dur.appendChild(o);
    });
    dur.addEventListener('change', function () {
      update(idx, { duration: parseFloat(dur.value) });
    });
    dur.disabled = z.from === z.to;

    var ease = document.createElement('label');
    ease.className = 'check z-ease';
    ease.title = 'Départ et arrivée en douceur';
    var easeInput = document.createElement('input');
    easeInput.type = 'checkbox';
    easeInput.checked = z.ease;
    easeInput.disabled = z.from === z.to;
    var easeText = document.createElement('span');
    easeText.textContent = 'Doux';
    ease.appendChild(easeInput);
    ease.appendChild(easeText);
    easeInput.addEventListener('change', function () {
      update(idx, { ease: easeInput.checked });
    });

    var count = document.createElement('span');
    count.className = 'z-count';
    count.setAttribute('data-zoom', String(idx));

    var del = document.createElement('button');
    del.className = 'z-del';
    del.title = 'Retirer ce zoom';
    del.textContent = '×';
    del.addEventListener('click', function () {
      row.classList.add('leaving');
      setTimeout(function () {
        var s = settings();
        s.zooms.splice(idx, 1);
        commit(true);
      }, 180);
    });

    var main = document.createElement('div');
    main.className = 'z-main';
    main.appendChild(from);
    main.appendChild(arrow);
    main.appendChild(to);
    var opts = document.createElement('div');
    opts.className = 'z-opts';
    var pointSel = document.createElement('select');
    pointSel.className = 'z-point';
    pointSel.title = 'Point vers lequel zoomer : il reste en place pendant le zoom';
    var matched = false;
    ZP.POINTS.forEach(function (p, k) {
      var o = document.createElement('option');
      o.value = String(k);
      o.textContent = '◎ ' + p.label;
      var same = !p.point ? !z.point : z.point && Math.abs(p.point.x - z.point.x) < 0.01 && Math.abs(p.point.y - z.point.y) < 0.01;
      if (same) {
        o.selected = true;
        matched = true;
      }
      pointSel.appendChild(o);
    });
    if (!matched) {
      var custom = document.createElement('option');
      custom.value = 'custom';
      custom.textContent = '◎ ' + ZP.pointLabel(z.point);
      custom.selected = true;
      pointSel.appendChild(custom);
    }
    pointSel.addEventListener('change', function () {
      if (pointSel.value === 'custom') return;
      update(idx, { point: ZP.POINTS[parseInt(pointSel.value, 10)].point });
    });

    opts.appendChild(dur);
    opts.appendChild(pointSel);
    opts.appendChild(ease);
    opts.appendChild(count);

    var body = document.createElement('div');
    body.className = 'z-body';
    body.appendChild(main);
    body.appendChild(opts);

    row.appendChild(demo);
    row.appendChild(body);
    row.appendChild(del);
    return row;
  }

  function renderList(appearIndex) {
    var box = $('z-list');
    box.innerHTML = '';
    var s = settings();
    if (!s.zooms.length) {
      var empty = document.createElement('div');
      empty.className = 'z-empty';
      empty.textContent = 'Aucun zoom : ajoutes-en un, ou choisis un ajout rapide ci-dessous.';
      box.appendChild(empty);
    }
    s.zooms.forEach(function (z, i) {
      var row = zoomRow(z, i);
      if (i === appearIndex) row.classList.add('appear');
      box.appendChild(row);
    });
    renderCounts();
  }

  function renderQuick() {
    var box = $('z-quick');
    box.innerHTML = '';
    ZP.QUICK.forEach(function (q) {
      var b = document.createElement('button');
      b.className = 'chip-btn';
      b.innerHTML = '';
      var t = document.createElement('b');
      t.textContent = q.label;
      var d = document.createElement('span');
      d.textContent = ZP.describe(q);
      b.appendChild(t);
      b.appendChild(d);
      b.addEventListener('click', function () {
        settings().zooms.push(ZP.normalizeZoom(q));
        commit(true, settings().zooms.length - 1);
      });
      box.appendChild(b);
    });
  }

  function writeControls() {
    var s = settings();
    $('z-fmin').value = s.freqMin;
    $('z-fmax').value = s.freqMax;
    $('z-minclip').value = s.minClipSec;
    $('z-norepeat').checked = s.noRepeat;
    $('z-backup').checked = ctx.store.zoomBackup !== false;
    renderRhythm();
  }

  function readControls() {
    var s = settings();
    s.freqMin = $('z-fmin').value;
    s.freqMax = $('z-fmax').value;
    s.minClipSec = $('z-minclip').value;
    s.noRepeat = $('z-norepeat').checked;
    ctx.store.zoom = ZP.normalize(s);
    ctx.store.zoomBackup = $('z-backup').checked;
  }

  function update(idx, patch) {
    var s = settings();
    var z = s.zooms[idx];
    if (!z) return;
    for (var k in patch) if (patch.hasOwnProperty(k)) z[k] = patch[k];
    s.zooms[idx] = ZP.normalizeZoom(z);
    commit(true);
  }

  /** Enregistre, redessine la liste si besoin, et refait le tirage avec la meme graine. */
  function commit(relist, appearIndex) {
    ctx.store.zoom = ZP.normalize(settings());
    ctx.saveSettings();
    if (relist) renderList(appearIndex);
    writeControls();
    rebuild();
  }

  // ------------------------------------------------------------------ rythme

  /** Petite frise qui montre ce que veut dire « tous les X a Y clips ». */
  function renderRhythm() {
    var s = settings();
    var box = $('z-rhythm');
    box.innerHTML = '';
    var r = ZP.rng(20240611);
    var n = 18;
    var pos = r.int(0, r.int(s.freqMin, s.freqMax) - 1);
    var hits = {};
    while (pos < n) {
      hits[pos] = true;
      pos += r.int(s.freqMin, s.freqMax);
    }
    for (var i = 0; i < n; i++) {
      var cell = document.createElement('i');
      if (hits[i]) cell.className = 'on';
      cell.style.setProperty('--i', String(i));
      box.appendChild(cell);
    }
    var help;
    if (s.freqMin === 1 && s.freqMax === 1) help = 'Tous les clips seront zoomés.';
    else if (s.freqMin === s.freqMax) help = 'Exactement un clip sur ' + s.freqMin + '.';
    else help = 'Entre un clip sur ' + s.freqMin + ' et un clip sur ' + s.freqMax + ', au hasard.';
    $('z-freq-help').textContent = help + ' Exemple ci-dessus : en orange, les clips zoomés.';
  }

  // ------------------------------------------------------------------ aperçu

  function rebuild() {
    if (!data) {
      plan = null;
      renderStats();
      renderCounts();
      draw();
      ctx.updateUi();
      return;
    }
    plan = ZP.buildPlan(data.tracks, data.sectionsTicks, data.mode, settings(), data.seed);
    renderStats();
    renderCounts();
    renderLegend();
    draw();
    ctx.updateUi();
  }

  function renderCounts() {
    var nodes = document.querySelectorAll('#z-list .z-count');
    for (var i = 0; i < nodes.length; i++) {
      var idx = parseInt(nodes[i].getAttribute('data-zoom'), 10);
      var n = plan && plan.stats.perZoom[idx] ? plan.stats.perZoom[idx] : 0;
      var text = plan ? '× ' + n : '';
      if (nodes[i].textContent !== text) {
        nodes[i].textContent = text;
        nodes[i].classList.remove('bump');
        void nodes[i].offsetWidth;
        if (text) nodes[i].classList.add('bump');
      }
    }
  }

  function renderLegend() {
    var box = $('z-legend');
    box.innerHTML = '';
    if (!plan) return;
    var items = [
      ['#3a4358', 'gardé tel quel'],
      ['repeating-linear-gradient(135deg,#2b3140 0 3px,#3a4358 3px 6px)', 'ignoré'],
      ['#1c2029', 'hors zone']
    ];
    items.forEach(function (it) {
      var s = document.createElement('span');
      var dot = document.createElement('i');
      dot.style.background = it[0];
      s.appendChild(dot);
      s.appendChild(document.createTextNode(it[1]));
      box.appendChild(s);
    });
    var hint = document.createElement('span');
    hint.className = 'hint';
    hint.textContent = 'couleur = zoom de la liste · survol : détail';
    box.appendChild(hint);
  }

  function renderStats() {
    var box = $('z-stats');
    box.innerHTML = '';
    if (!plan) return;
    var st = plan.stats;
    var ignored = st.short + st.animated + st.nomotion;
    var detail = [];
    if (st.animated) detail.push(st.animated + ' déjà animé' + (st.animated > 1 ? 's' : ''));
    if (st.short) detail.push(st.short + ' trop court' + (st.short > 1 ? 's' : ''));
    if (st.nomotion) detail.push(st.nomotion + ' sans Trajectoire');
    var items = [
      [String(st.zoomed), st.zoomed > 1 ? 'clips zoomés' : 'clip zoomé'],
      [String(st.inScope), 'clip' + (st.inScope > 1 ? 's' : '') + ' dans la zone'],
      [String(ignored), ignored ? detail.join(', ') : 'ignoré']
    ];
    var before = lastStats;
    lastStats = items.map(function (it) {
      return it[0];
    });
    items.forEach(function (it, idx) {
      var d = document.createElement('div');
      d.className = 'stat';
      var b = document.createElement('b');
      b.textContent = it[0];
      if (before[idx] !== it[0]) b.className = 'bump';
      var sp = document.createElement('span');
      sp.textContent = it[1];
      d.appendChild(b);
      d.appendChild(sp);
      box.appendChild(d);
    });
  }

  /** Une ligne d'apercu par piste video : les clips, colores selon leur sort. */
  function renderPreviewRows() {
    var box = $('z-preview');
    box.innerHTML = '';
    if (!data) {
      var empty = document.createElement('div');
      empty.className = 'wave-empty';
      empty.textContent = 'Valide les sections pour voir les clips.';
      box.appendChild(empty);
      return;
    }
    data.tracks.forEach(function (t, i) {
      var row = document.createElement('div');
      row.className = 'z-prow';
      var name = document.createElement('span');
      name.className = 'z-pname';
      name.textContent = 'V' + (t.index + 1);
      var cv = document.createElement('canvas');
      cv.setAttribute('data-track', String(i));
      row.appendChild(name);
      row.appendChild(cv);
      box.appendChild(row);
      bindHover(cv, i);
    });
  }

  /** Fenetre affichee : du premier au dernier clip concerne. */
  function viewRange() {
    var lo = Infinity;
    var hi = -Infinity;
    if (plan) {
      plan.tracks.forEach(function (t) {
        t.clips.forEach(function (c) {
          if (c.status === 'out') return;
          if (c.s < lo) lo = c.s;
          if (c.e > hi) hi = c.e;
        });
      });
    }
    if (!(hi > lo) && data) {
      data.tracks.forEach(function (t) {
        t.clips.forEach(function (c) {
          if (c.s < lo) lo = c.s;
          if (c.e > hi) hi = c.e;
        });
      });
    }
    if (!(hi > lo)) return { lo: 0, hi: 1 };
    var pad = (hi - lo) * 0.015;
    return { lo: Math.max(0, lo - pad), hi: hi + pad };
  }

  function roundRect(g, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    g.beginPath();
    g.moveTo(x + r, y);
    g.lineTo(x + w - r, y);
    g.quadraticCurveTo(x + w, y, x + w, y + r);
    g.lineTo(x + w, y + h - r);
    g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    g.lineTo(x + r, y + h);
    g.quadraticCurveTo(x, y + h, x, y + h - r);
    g.lineTo(x, y + r);
    g.quadraticCurveTo(x, y, x + r, y);
    g.closePath();
  }

  var hatch = null;
  function hatchPattern(g) {
    if (hatch) return hatch;
    var c = document.createElement('canvas');
    c.width = 6;
    c.height = 6;
    var x = c.getContext('2d');
    x.fillStyle = '#2b3140';
    x.fillRect(0, 0, 6, 6);
    x.strokeStyle = '#3a4358';
    x.lineWidth = 2;
    x.beginPath();
    x.moveTo(-1, 7);
    x.lineTo(7, -1);
    x.stroke();
    hatch = g.createPattern(c, 'repeat');
    return hatch;
  }

  function draw() {
    if (ctx.state.screen !== 'tool' || ctx.state.tool !== 'zoom' || ctx.state.step !== 2) return;
    var canvases = document.querySelectorAll('#z-preview canvas');
    if (!plan || !canvases.length) return;
    var vr = viewRange();
    for (var c = 0; c < canvases.length; c++) {
      var g = ctx.prepCanvas(canvases[c]);
      var t = plan.tracks[parseInt(canvases[c].getAttribute('data-track'), 10)];
      if (!t) continue;
      var xOf = function (tick) {
        return ((tick - vr.lo) / (vr.hi - vr.lo)) * g.w;
      };
      g.ctx.fillStyle = '#12151b';
      g.ctx.fillRect(0, 0, g.w, g.h);
      t.clips.forEach(function (clip) {
        var x0 = xOf(clip.s);
        var x1 = xOf(clip.e);
        if (x1 < 0 || x0 > g.w) return;
        var w = Math.max(1, x1 - x0 - 1.5);
        // a l'arrivee, les clips zoomes « poussent » de gauche a droite
        var k = Math.max(0, Math.min(1, grow * 1.6 - (x0 / g.w) * 0.6));
        var h = g.h - 6;
        if (clip.status === 'zoom') {
          var hh = h * (0.55 + 0.45 * k);
          g.ctx.fillStyle = color(clip.zoom);
          roundRect(g.ctx, x0, 3 + (h - hh) / 2, w, hh, 3);
          g.ctx.fill();
          return;
        }
        if (clip.status === 'out') g.ctx.fillStyle = '#1c2029';
        else if (clip.status === 'keep') g.ctx.fillStyle = '#3a4358';
        else g.ctx.fillStyle = hatchPattern(g.ctx);
        roundRect(g.ctx, x0, 3 + h * 0.22, w, h * 0.56, 2);
        g.ctx.fill();
      });
    }
  }

  var STATUS_TEXT = {
    zoom: '',
    keep: 'gardé tel quel',
    out: 'hors zone',
    short: 'ignoré : trop court',
    animated: 'ignoré : échelle déjà animée',
    nomotion: 'ignoré : pas d\'effet Trajectoire'
  };

  /** Detail du clip survole, en info-bulle. */
  function bindHover(cv, trackPos) {
    cv.addEventListener('mousemove', function (ev) {
      if (!plan) return;
      var t = plan.tracks[trackPos];
      var rect = cv.getBoundingClientRect();
      var vr = viewRange();
      var tick = vr.lo + ((ev.clientX - rect.left) / rect.width) * (vr.hi - vr.lo);
      var hit = null;
      var n = 0;
      t.clips.forEach(function (c, k) {
        if (tick >= c.s && tick < c.e) {
          hit = c;
          n = k + 1;
        }
      });
      if (!hit) {
        cv.title = '';
        return;
      }
      var head = 'V' + (t.index + 1) + ' · clip ' + n + ' · ' + ctx.fmtDur(hit.s / TPS) + ' (' +
        fmtNum(((hit.e - hit.s) / TPS).toFixed(1)) + ' s)';
      var what = hit.status === 'zoom'
        ? 'Zoom ' + (hit.zoom + 1) + ' : ' + ZP.describe(settings().zooms[hit.zoom] || {})
        : STATUS_TEXT[hit.status];
      cv.title = head + '\n' + what;
    });
  }

  function animateIn() {
    grow = 0;
    ctx.tween(650, function (k) {
      grow = k;
      draw();
    });
  }

  // ----------------------------------------------------------------- étapes

  /** Etape 1 -> 2 : lit les clips des pistes choisies et tire les zooms. */
  function validate(sections, mode, tracks) {
    var info;
    ctx.setBusy(true);
    ctx.banner('');
    showResult();
    return ctx
      .refresh(false)
      .then(function (ok) {
        if (!ok) throw new Error('');
        info = ctx.state.info;
        ctx.setProgress(null, 'Lecture des clips…');
        return ctx.call('ADZ_listClips', [tracks.join(',')]);
      })
      .then(function (res) {
        if (!res.ok) throw new Error(res.error || 'Lecture des clips impossible.');
        var locked = [];
        var usable = res.tracks.filter(function (t) {
          if (t.locked) locked.push('V' + (t.index + 1));
          return !t.locked;
        });
        if (!usable.length) throw new Error('Les pistes choisies sont verrouillées : déverrouille-les dans Premiere.');
        var tb = info.sequence.timebase;
        data = {
          seqId: info.sequence.id,
          seqName: info.sequence.name,
          fingerprint: info.sequence.fingerprint,
          timebase: tb,
          mode: mode,
          sectionsTicks: sections.map(function (s) {
            return [s.startFrame * tb, s.endFrame * tb];
          }),
          tracks: usable,
          seed: newSeed()
        };
        lastStats = [];
        ctx.hideProgress();
        ctx.state.busy = false;
        ctx.show('tool', 2);
        renderPreviewRows();
        rebuild();
        animateIn();
        if (locked.length) {
          ctx.banner('Pistes verrouillées laissées de côté : ' + locked.join(', ') + '.');
        }
        ctx.log('Zoom : ' + info.sequence.name + ', pistes ' +
          usable.map(function (t) { return 'V' + (t.index + 1); }).join(' ') + ', ' +
          plan.stats.inScope + ' clips dans la zone.');
      })
      .catch(function (e) {
        if (e && e.message) {
          ctx.banner(e.message, 'error');
          ctx.log('Zoom impossible : ' + e.message);
        }
      })
      .then(function () {
        ctx.hideProgress();
        ctx.setBusy(false);
      });
  }

  function showResult(kind, text) {
    var el = $('z-result');
    if (!text) {
      el.className = 'result hidden';
      el.textContent = '';
      return;
    }
    el.className = 'result ' + kind;
    el.textContent = text;
  }

  function planText(backupName) {
    var lines = [
      'version=1',
      'sequenceId=' + data.seqId,
      'backup=' + (ctx.store.zoomBackup !== false ? '1' : '0'),
      'backupName=' + backupName
    ];
    plan.items.forEach(function (it) {
      lines.push('Z ' + it.track + ' ' + it.i + ' ' + it.s + ' ' + it.e + ' ' + it.from + ' ' + it.to + ' ' +
        it.duration + ' ' + (it.ease ? '1' : '0') + ' ' + (it.point ? it.point.x + ' ' + it.point.y : '-1 -1'));
    });
    return lines.join('\n') + '\n';
  }

  function describe(fin) {
    var backup = fin.backupName ? '\nSauvegarde intacte dans le projet : « ' + fin.backupName + ' ».' : '';
    var extra = [];
    if (fin.skipped) extra.push(fin.skipped + ' clip(s) laissé(s) de côté');
    if (fin.failed) extra.push(fin.failed + ' échec(s)');
    var notes = fin.notes && fin.notes.length ? '\n' + fin.notes.slice(0, 4).join('\n') : '';
    if (fin.code === 'CANCELLED') {
      return { kind: 'error', text: 'Interrompu : ' + fin.applied + ' zoom(s) déjà posé(s). Annule dans Premiere (Ctrl+Z) ou repars de la sauvegarde.' + backup };
    }
    if (fin.failed) {
      return {
        kind: 'warn',
        text: fin.applied + ' zoom(s) posé(s) sur ' + fin.total + ' · ' + extra.join(' · ') + notes + backup
      };
    }
    return {
      kind: 'ok',
      text: 'Terminé. ' + fin.applied + ' zoom' + (fin.applied > 1 ? 's posés' : ' posé') +
        (extra.length ? ' · ' + extra.join(' · ') : '') + '.' + backup
    };
  }

  /** Pose les zooms dans Premiere. */
  function apply() {
    if (ctx.state.busy || !plan || !plan.items.length) return Promise.resolve();
    ctx.setBusy(true);
    ctx.state.cancel = false;
    ctx.banner('');
    showResult();
    var planPath = '';
    var started = false;
    var snapshot = data;

    return ctx
      .refresh(false)
      .then(function (ok) {
        if (!ok) throw new Error('');
        var info = ctx.state.info;
        if (info.sequence.id !== snapshot.seqId || info.sequence.fingerprint !== snapshot.fingerprint) {
          throw new Error('La timeline a changé depuis la lecture des clips : valide à nouveau les sections.');
        }
        var now = new Date();
        var stamp = now.getHours() + 'h' + ctx.p2(now.getMinutes());
        var text = planText(snapshot.seqName + ' - avant Zoom ' + stamp);
        if (!ctx.DEMO) {
          planPath = ctx.N().path.join(ctx.tempDir(), 'plan-zoom-' + Date.now() + '.txt');
          ctx.N().fs.writeFileSync(planPath, text, 'utf8');
        }
        ctx.setProgress(null, ctx.store.zoomBackup !== false ? 'Sauvegarde de la séquence…' : 'Préparation…');
        return ctx.call('ADZ_begin', [planPath]);
      })
      .then(function (begin) {
        if (!begin.ok) throw new Error(begin.error || 'Préparation impossible.');
        started = true;
        $('btn-cancel').classList.remove('hidden');
        var loop = function () {
          if (ctx.state.cancel) return ctx.call('ADZ_cancel');
          return ctx.call('ADZ_step', ['250']).then(function (st) {
            if (!st.ok) return ctx.call('ADZ_cancel');
            ctx.setProgress(st.total ? st.done / st.total : null, 'Pose des zooms · ' + st.done + ' / ' + st.total);
            if (st.finished) return ctx.call('ADZ_finish');
            return new Promise(function (resolve) {
              setTimeout(resolve, 10);
            }).then(loop);
          });
        };
        return loop();
      })
      .then(function (fin) {
        var res = describe(fin);
        var lines = (fin.log || []).slice();
        var file = ctx.writeLogFile(lines);
        ctx.log(lines.concat(file ? ['journal : ' + file] : []));
        showResult(res.kind, res.text);
        if (res.kind !== 'ok') $('log-card').open = true;
      })
      .catch(function (e) {
        if (e && e.message) {
          showResult('error', e.message + (started ? '' : '\nAucun zoom n\'a été posé.'));
          ctx.log('Zoom impossible : ' + e.message);
        }
      })
      .then(function () {
        ctx.hideProgress();
        if (planPath) {
          try {
            ctx.N().fs.unlinkSync(planPath);
          } catch (e) {}
        }
        // Les clips ont change (echelle animee) : un nouveau passage repart des sections.
        if (started) drop();
        ctx.setBusy(false);
        window.scrollTo(0, 0);
        return ctx.refresh(true);
      });
  }

  // ------------------------------------------------------------------ état

  function drop(message) {
    data = null;
    plan = null;
    renderPreviewRows();
    renderStats();
    renderCounts();
    $('z-legend').innerHTML = '';
    if (message) {
      ctx.banner(message);
      if (ctx.state.screen === 'tool' && ctx.state.tool === 'zoom' && ctx.state.step === 2) ctx.show('tool', 1);
    }
    ctx.updateUi();
  }

  /** La timeline a-t-elle change depuis la lecture des clips ? */
  function isStale(info) {
    return !!data && (data.seqId !== info.sequence.id || data.fingerprint !== info.sequence.fingerprint);
  }

  /** Texte, etat et message du bouton orange de l'etape 2. */
  function footer() {
    var busy = ctx.state.busy;
    if (!data) return { text: 'Revenir aux sections', disabled: busy, msg: '' };
    var n = plan ? plan.items.length : 0;
    var msg = '';
    if (!busy && !n) {
      msg = settings().zooms.length ? 'Aucun clip à zoomer avec ces réglages' : 'Ajoute au moins un zoom';
    }
    return {
      text: n ? 'Appliquer ' + n + ' zoom' + (n > 1 ? 's' : '') : 'Appliquer les zooms',
      disabled: busy || !n,
      msg: msg
    };
  }

  function hasData() {
    return !!data;
  }

  function bind() {
    $('z-add').addEventListener('click', function () {
      var s = settings();
      var last = s.zooms[s.zooms.length - 1];
      s.zooms.push(ZP.normalizeZoom(last ? { from: last.to, to: last.from, duration: last.duration, ease: last.ease } : {}));
      commit(true, s.zooms.length - 1);
    });
    $('z-reroll').addEventListener('click', function () {
      if (!data) return;
      data.seed = newSeed();
      var icon = $('z-reroll').querySelector('svg');
      icon.classList.remove('roll');
      void icon.offsetWidth;
      icon.classList.add('roll');
      rebuild();
      animateIn();
    });
    // Le champ qu'on vient de toucher a la priorite : monter le minimum au-dessus
    // du maximum monte aussi le maximum, et inversement.
    $('z-fmin').addEventListener('change', function () {
      var a = parseInt($('z-fmin').value, 10);
      if (a > parseInt($('z-fmax').value, 10)) $('z-fmax').value = a;
      readControls();
      commit(false);
    });
    $('z-fmax').addEventListener('change', function () {
      var b = parseInt($('z-fmax').value, 10);
      if (b < parseInt($('z-fmin').value, 10)) $('z-fmin').value = b;
      readControls();
      commit(false);
    });
    $('z-minclip').addEventListener('change', function () {
      readControls();
      commit(false);
    });
    ['z-norepeat', 'z-backup'].forEach(function (id) {
      $(id).addEventListener('change', function () {
        readControls();
        commit(false);
      });
    });
    $('z-reset').addEventListener('click', function () {
      ctx.store.zoom = ZP.normalize(ZP.DEFAULTS);
      ctx.store.zoomBackup = true;
      commit(true);
    });
  }

  function init(c) {
    ctx = c;
    ctx.store.zoom = ZP.normalize(ctx.store.zoom || ZP.DEFAULTS);
    bind();
    renderQuick();
    renderList();
    writeControls();
    renderPreviewRows();
  }

  global.ADZoom = {
    init: init,
    validate: validate,
    apply: apply,
    draw: draw,
    drop: drop,
    isStale: isStale,
    footer: footer,
    hasData: hasData,
    showResult: showResult,
    reload: function () {
      renderList();
      writeControls();
    }
  };
})(window);
