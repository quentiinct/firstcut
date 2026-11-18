/* FirstCut - controleur du panneau.
 *
 * Ecrans :
 *   accueil            choix de l'outil
 *   outil, etape 1     Sections : quelle partie de la timeline, quelles pistes
 *   outil, etape 2     Reglages : apercu, parametres, decoupe
 *
 * Deroulement de l'outil Silences :
 *   1. Valider les sections : Premiere exporte l'audio des pistes choisies en
 *      WAV, le panneau en tire une enveloppe de niveaux.
 *   2. Regler : chaque changement recalcule les silences sur cette enveloppe
 *      (instantane, pas de nouvel export) et redessine l'apercu.
 *   3. Couper : le plan est ecrit dans un fichier, puis applique dans Premiere
 *      par petites etapes pour afficher la progression.
 */
(function () {
  'use strict';

  var Host = window.ADHost;
  var D = window.ADDetect;
  var W = window.ADWav;
  var Demo = window.ADDemo;
  var Secrets = window.ADSecrets;
  var DEMO = !Host.available && Demo && Demo.active;

  var TPS = 254016000000;
  var HOP = 0.005;
  var DB_MIN = -66;
  var RULER_H = 15;

  var PHASES = {
    scan: 'Lecture de la timeline',
    razor: 'Pose des points de coupe',
    rescan: 'Contrôle des coupes',
    remove: 'Retrait des silences',
    move: 'Resserrement de la timeline',
    verify: 'Contrôle final',
    done: 'Terminé',
    error: 'Arrêt'
  };

  var CUT_LABELS = {
    delete: 'Couper et supprimer les silences',
    delete_keep_spaces: 'Supprimer les silences (espaces gardés)',
    keep: 'Poser les points de coupe',
    mute: 'Rendre les silences muets'
  };

  var MODE_NAMES = { all: 'toute la timeline', inout: 'entrée / sortie', selected: 'clips sélectionnés' };

  var Zoom = window.ADZoom;

  /** Ce qui change d'un outil a l'autre sur les ecrans communs. */
  var TOOLS = {
    silences: {
      title: 'Silences',
      icon: '#i-scissors',
      step2: 'Réglages',
      kind: 'A',
      lead: 'Choisis la partie de la timeline à dérusher et les pistes audio à écouter.',
      legendIn: 'Sections analysées',
      legendOut: 'Sections ignorées par l\'analyse',
      legendLimits: 'Limites de la zone qui sera coupée'
    },
    zoom: {
      title: 'Zoom',
      icon: '#i-zoom',
      step2: 'Zooms',
      kind: 'V',
      lead: 'Choisis les clips à dynamiser et les pistes vidéo à zoomer.',
      legendIn: 'Clips concernés',
      legendOut: 'Clips laissés de côté',
      legendLimits: 'Limites de la zone traitée'
    },
    broll: {
      title: 'B-roll',
      icon: '#i-film',
      step2: 'B-roll',
      kind: 'A',
      lead: 'Choisis la partie à illustrer et les pistes audio où l\'on parle.',
      legendIn: 'Parole transcrite',
      legendOut: 'Parties laissées de côté',
      legendLimits: 'Limites de la zone illustrée'
    },
    express: {
      title: 'Montage express',
      icon: '#i-bolt',
      step2: 'Recette',
      kind: 'A',
      lead: 'Choisis la zone et coche les micros (deux ou plus pour POV).',
      legendIn: 'Zone traitée',
      legendOut: 'Parties laissées de côté',
      legendLimits: 'Limites de la zone traitée'
    },
    pov: {
      title: 'POV',
      icon: '#i-pov',
      step2: 'POV',
      kind: 'A',
      lead: 'Choisis la zone et coche le micro de chaque intervenant (au moins deux).',
      legendIn: 'Parole analysée',
      legendOut: 'Parties laissées de côté',
      legendLimits: 'Limites de la zone traitée'
    }
  };

  var Broll = window.ADBroll;
  var Pov = window.ADPov;
  var Express = window.ADExpress;

  var state = {
    tool: 'silences',
    screen: 'home',
    step: 1,
    info: null,
    layout: null, // couverture des pistes et selection, lue a la demande
    sections: [], // [{ startFrame, endFrame }] a traiter
    sectionMsg: '',
    analysis: null, // { seqId, fingerprint, timebase, range, sections, env, audioOffset, tracks, wavPath, mode }
    plan: null,
    silSec: [], // silences, en secondes depuis le debut de la zone analysee
    secSec: [], // sections, dans le meme repere
    view: { t0: 0, t1: 1 },
    busy: false,
    cancel: false,
    cutting: false,
    playing: false,
    trackGrow: 1, // 0 -> 1 pendant l'apparition des bandes de pistes
    waveGrow: 1, // 0 -> 1 pendant l'apparition de la forme d'onde
    lastStats: []
  };

  var store = {
    params: clone(D.DEFAULTS),
    backup: true,
    skipSilences: true,
    presets: [],
    trackChoice: {},
    sectionMode: 'all',
    videoChoice: {},
    zoomSectionMode: 'selected',
    zoom: null,
    zoomBackup: true,
    onboarded: false,
    brollSectionMode: 'all',
    povSectionMode: 'all',
    expressSectionMode: 'all',
    expressChoice: {},
    express: null,
    povChoice: {},
    pov: null,
    broll: null,
    ffmpegPath: ''
  };

  function isZoom() {
    return state.tool === 'zoom';
  }

  /** Mode de sections de l'outil en cours (chaque outil retient le sien). */
  function sectionMode() {
    if (state.tool === 'broll') return store.brollSectionMode;
    if (state.tool === 'pov') return store.povSectionMode;
    if (state.tool === 'express') return store.expressSectionMode;
    return isZoom() ? store.zoomSectionMode : store.sectionMode;
  }

  function setSectionMode(mode) {
    if (state.tool === 'express') store.expressSectionMode = mode;
    else if (state.tool === 'pov') store.povSectionMode = mode;
    else if (state.tool === 'broll') store.brollSectionMode = mode;
    else if (isZoom()) store.zoomSectionMode = mode;
    else store.sectionMode = mode;
  }

  /** Pistes listees a l'etape 1 : audio pour Silences, video pour Zoom. */
  function toolTracks(info) {
    return isZoom() ? info.video : info.audio;
  }

  function trackChoices() {
    if (state.tool === 'pov') return store.povChoice;
    if (state.tool === 'express') return store.expressChoice;
    return isZoom() ? store.videoChoice : store.trackChoice;
  }

  function $(id) {
    return document.getElementById(id);
  }

  function clone(o) {
    return JSON.parse(JSON.stringify(o));
  }

  function call(fn, args) {
    return DEMO ? Demo.call(fn, args || []) : Host.call(fn, args || []);
  }

  // ------------------------------------------------------------------ fichiers

  var node = null;
  function N() {
    if (!node) {
      node = { fs: Host.require('fs'), path: Host.require('path'), os: Host.require('os') };
    }
    return node;
  }

  function dataDir() {
    var n = N();
    var home = n.os.homedir();
    var base;
    if (n.os.platform() === 'win32') {
      var env = Host.require('process').env;
      base = env.APPDATA || n.path.join(home, 'AppData', 'Roaming');
    } else {
      base = n.path.join(home, 'Library', 'Application Support');
    }
    var dir = n.path.join(base, 'FirstCut');
    // Avant de s'appeler FirstCut, l'app rangeait ses reglages dans « AutoDerush » :
    // on reprend ce dossier tel quel (reglages, prereglages, cles, transcriptions).
    var old = n.path.join(base, 'AutoDerush');
    if (!n.fs.existsSync(dir) && n.fs.existsSync(old)) {
      try {
        n.fs.renameSync(old, dir);
      } catch (e) {
        try {
          n.fs.mkdirSync(dir, { recursive: true });
          n.fs.copyFileSync(n.path.join(old, 'settings.json'), n.path.join(dir, 'settings.json'));
        } catch (e2) {}
      }
    }
    n.fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  function tempDir() {
    var n = N();
    var dir = n.path.join(n.os.tmpdir(), 'FirstCut');
    n.fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** Les exports d'analyse pesent lourd : on ne garde que celui en cours. */
  function cleanTemp(keep) {
    try {
      var n = N();
      var dir = tempDir();
      n.fs.readdirSync(dir).forEach(function (name) {
        var full = n.path.join(dir, name);
        if (full === keep) return;
        if (/^analyse-.*\.(wav|wav\.xmp|pek|cfa)$/i.test(name) || /^plan-.*\.txt$/i.test(name)) {
          try {
            n.fs.unlinkSync(full);
          } catch (e) {}
        }
      });
    } catch (e2) {}
  }

  function loadSettings() {
    var raw = null;
    try {
      if (DEMO || !Host.available) raw = window.localStorage.getItem('firstcut');
      else {
        var file = N().path.join(dataDir(), 'settings.json');
        if (N().fs.existsSync(file)) raw = N().fs.readFileSync(file, 'utf8');
      }
    } catch (e) {}
    if (!raw) return;
    try {
      var s = JSON.parse(raw);
      store.params = D.normalizeParams(s.params);
      store.backup = s.backup !== false;
      store.skipSilences = s.skipSilences !== false;
      store.presets = Array.isArray(s.presets) ? s.presets : [];
      store.trackChoice = s.trackChoice && typeof s.trackChoice === 'object' ? s.trackChoice : {};
      store.sectionMode = MODE_NAMES[s.sectionMode] ? s.sectionMode : 'all';
      store.videoChoice = s.videoChoice && typeof s.videoChoice === 'object' ? s.videoChoice : {};
      store.zoomSectionMode = MODE_NAMES[s.zoomSectionMode] ? s.zoomSectionMode : 'selected';
      store.zoom = window.ADZoomPlan.normalize(s.zoom || window.ADZoomPlan.DEFAULTS);
      store.zoomBackup = s.zoomBackup !== false;
      store.onboarded = s.onboarded === true;
      store.brollSectionMode = MODE_NAMES[s.brollSectionMode] ? s.brollSectionMode : 'all';
      store.povSectionMode = MODE_NAMES[s.povSectionMode] ? s.povSectionMode : 'all';
      store.expressSectionMode = MODE_NAMES[s.expressSectionMode] ? s.expressSectionMode : 'all';
      store.expressChoice = s.expressChoice && typeof s.expressChoice === 'object' ? s.expressChoice : {};
      store.express = s.express && typeof s.express === 'object' ? s.express : null;
      store.povChoice = s.povChoice && typeof s.povChoice === 'object' ? s.povChoice : {};
      store.pov = s.pov && typeof s.pov === 'object' ? s.pov : null;
      store.broll = s.broll && typeof s.broll === 'object' ? s.broll : null;
      store.ffmpegPath = typeof s.ffmpegPath === 'string' ? s.ffmpegPath : '';
    } catch (e2) {}
    // Des cles encore en clair (versions d'avant le chiffrement) : on les chiffre tout de suite.
    if (canSeal() && keyVault.open(store.broll)) saveSettings();
  }

  // Dans settings.json, les cles API sont chiffrees pour la session Windows
  // (voir secrets.js) ; en memoire, le panneau les garde en clair.
  var keyVault = Secrets ? Secrets.vault(['pexelsKey', 'claudeKey']) : null;

  function canSeal() {
    return !DEMO && Host.available && !!keyVault && Secrets.available();
  }

  var saveTimer = null;
  function saveSettings() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      try {
        var data = store;
        if (store.broll && canSeal()) {
          data = {};
          for (var k in store) if (Object.prototype.hasOwnProperty.call(store, k)) data[k] = store[k];
          data.broll = keyVault.sealedCopy(store.broll);
        }
        var raw = JSON.stringify(data, null, 1);
        if (DEMO || !Host.available) window.localStorage.setItem('firstcut', raw);
        else N().fs.writeFileSync(N().path.join(dataDir(), 'settings.json'), raw, 'utf8');
      } catch (e) {}
    }, 250);
  }

  // ----------------------------------------------------------------- affichage

  function p2(v) {
    return v < 10 ? '0' + v : '' + v;
  }

  function fmtDur(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    var s = Math.round(sec);
    var h = Math.floor(s / 3600);
    var m = Math.floor(s / 60) % 60;
    return (h ? h + ':' + p2(m) : '' + m) + ':' + p2(s % 60);
  }

  function fmtClock(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    var s = Math.round(sec);
    return p2(Math.floor(s / 3600)) + ':' + p2(Math.floor(s / 60) % 60) + ':' + p2(s % 60);
  }

  function fmtSec(sec) {
    return (Math.round(sec * 10) / 10).toFixed(1).replace('.', ',') + ' s';
  }

  function banner(text, kind) {
    var el = $('banner');
    if (!text) {
      el.className = 'banner hidden';
      el.textContent = '';
      return;
    }
    el.className = 'banner' + (kind === 'error' ? ' error' : '');
    el.textContent = text;
  }

  function log(lines) {
    var el = $('log');
    var stamp = new Date().toLocaleTimeString('fr-FR');
    var text = (Array.isArray(lines) ? lines : [lines]).join('\n');
    el.textContent += '[' + stamp + '] ' + text + '\n';
    el.scrollTop = el.scrollHeight;
  }

  function writeLogFile(lines) {
    if (DEMO || !Host.available) return '';
    try {
      var n = N();
      var dir = n.path.join(dataDir(), 'journaux');
      n.fs.mkdirSync(dir, { recursive: true });
      var d = new Date();
      var name =
        d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + '_' +
        p2(d.getHours()) + '-' + p2(d.getMinutes()) + '-' + p2(d.getSeconds()) + '.log';
      var file = n.path.join(dir, name);
      n.fs.writeFileSync(file, lines.join('\r\n') + '\r\n', 'utf8');
      return file;
    } catch (e) {
      return '';
    }
  }

  function setProgress(fraction, text) {
    var box = $('progress');
    box.classList.remove('hidden');
    var fill = box.querySelector('.fill');
    if (fraction === null) {
      fill.classList.add('indeterminate');
      fill.style.width = '';
    } else {
      fill.classList.remove('indeterminate');
      fill.style.width = Math.round(Math.max(0, Math.min(1, fraction)) * 100) + '%';
    }
    if (text !== undefined) box.querySelector('.ptext').textContent = text;
  }

  function hideProgress() {
    $('progress').classList.add('hidden');
    $('btn-cancel').classList.add('hidden');
  }

  function showResult(kind, text) {
    var el = $('result');
    if (!text) {
      el.className = 'result hidden';
      el.textContent = '';
      return;
    }
    el.className = 'result ' + kind;
    el.textContent = text;
  }

  // ----------------------------------------------------------------- mouvement

  var REDUCED = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  /** Rejoue une animation CSS portee par une classe. */
  function replay(el, cls) {
    el.classList.remove('enter-up', 'enter-fwd', 'enter-back', 'flash');
    void el.offsetWidth; // force le navigateur a repartir de zero
    el.classList.add(cls);
    // Garde-fou : une animation d'entree part d'un contenu transparent. Si le
    // panneau ne l'execute pas (fenetre en arriere-plan, moteur bride), on la
    // retire pour que le contenu s'affiche quoi qu'il arrive.
    clearTimeout(el.__adrAnim);
    el.__adrAnim = setTimeout(function () {
      el.classList.remove(cls);
    }, 1200);
  }

  /** Fait progresser une valeur de 0 a 1 (depart vif, arrivee douce). */
  function tween(ms, onFrame) {
    if (REDUCED) {
      onFrame(1);
      return;
    }
    var t0 = null;
    function frame(now) {
      if (t0 === null) t0 = now;
      var k = Math.min(1, (now - t0) / ms);
      onFrame(1 - Math.pow(1 - k, 3));
      if (k < 1) window.requestAnimationFrame(frame);
    }
    window.requestAnimationFrame(frame);
  }

  /** Onde qui part du point clique sur les boutons. */
  function bindRipple() {
    document.addEventListener('pointerdown', function (ev) {
      if (REDUCED || !ev.target.closest) return;
      var el = ev.target.closest('.btn, .icon-btn, .tool-card');
      if (!el || el.disabled) return;
      var rect = el.getBoundingClientRect();
      var size = Math.max(rect.width, rect.height) * 2.2;
      var dot = document.createElement('span');
      dot.className = 'ripple';
      dot.style.width = dot.style.height = size + 'px';
      dot.style.left = ev.clientX - rect.left - size / 2 + 'px';
      dot.style.top = ev.clientY - rect.top - size / 2 + 'px';
      el.appendChild(dot);
      dot.addEventListener('animationend', function () {
        if (dot.parentNode) dot.parentNode.removeChild(dot);
      });
    });
  }

  /** Remplit la glissiere en orange jusqu'au curseur. */
  function paintRange() {
    var el = $('noise');
    var pct = ((el.value - el.min) / (el.max - el.min)) * 100;
    el.style.setProperty('--val', pct + '%');
  }

  /** Boite de confirmation, avec saisie facultative. Rend false, true ou le texte saisi. */
  function ask(opts) {
    return new Promise(function (resolve) {
      var modal = $('modal');
      var input = $('modal-input');
      $('modal-title').textContent = opts.title || '';
      $('modal-text').textContent = opts.text || '';
      $('modal-ok').textContent = opts.ok || 'Continuer';
      input.classList.toggle('hidden', !opts.input);
      input.value = opts.value || '';
      modal.classList.remove('hidden');
      if (opts.input) input.focus();

      function close(value) {
        modal.classList.add('hidden');
        $('modal-ok').onclick = null;
        $('modal-cancel').onclick = null;
        input.onkeydown = null;
        resolve(value);
      }
      $('modal-ok').onclick = function () {
        close(opts.input ? input.value.trim() : true);
      };
      $('modal-cancel').onclick = function () {
        close(false);
      };
      input.onkeydown = function (ev) {
        if (ev.key === 'Enter') close(input.value.trim());
        if (ev.key === 'Escape') close(false);
      };
    });
  }

  // ---------------------------------------------------------------- navigation

  function show(screen, step) {
    var rank = function (sc, st) {
      return sc === 'home' ? 0 : st;
    };
    var before = rank(state.screen, state.step);
    var sameScreen = state.screen === screen;
    state.screen = screen;
    state.step = step || 1;
    var after = rank(screen, state.step);
    document.body.setAttribute('data-screen', screen);
    document.body.setAttribute('data-step', String(state.step));
    document.body.setAttribute('data-tool', state.tool);
    $('btn-back').classList.toggle('hidden', screen === 'home');
    $('step-1').classList.toggle('on', state.step === 1);
    $('step-1').classList.toggle('done', screen === 'tool' && state.step === 2);
    $('step-2').classList.toggle('on', state.step === 2);

    // l'ecran arrive du cote ou l'on va : a droite en avancant, a gauche en reculant
    if (screen === 'home') {
      replay($('screen-home'), 'enter-up');
      replay($('side'), 'enter-up');
    } else {
      var panel = state.step === 1 ? $('panel-sections') : isZoom() ? $('panel-zoom') : state.tool === 'broll' ? $('panel-broll') : state.tool === 'pov' ? $('panel-pov') : state.tool === 'express' ? $('panel-express') : $('panel-settings');
      if (!sameScreen) replay($('screen-tool'), 'enter-up');
      else $('screen-tool').classList.remove('enter-up');
      replay(panel, after >= before ? 'enter-fwd' : 'enter-back');
    }
    window.scrollTo(0, 0);
    updateUi();
    if (screen === 'tool' && state.step === 1) drawTracks();
    if (screen === 'tool' && state.step === 2) {
      if (isZoom()) Zoom.draw();
      else if (state.tool === 'broll') Broll.redraw();
      else if (state.tool === 'pov') Pov.draw();
      else if (state.tool === 'express') Express.render();
      else drawWave();
    }
  }

  function goBack() {
    if (state.busy) return;
    stopPlayback();
    if (state.screen === 'tool' && state.step === 2) show('tool', 1);
    else show('home');
  }

  function openTool(tool) {
    if (state.busy) return Promise.resolve();
    tool = TOOLS[tool] ? tool : 'silences';
    var changed = state.tool !== tool;
    state.tool = tool;
    var t = TOOLS[tool];
    $('tool-title-text').textContent = t.title;
    $('tool-title-icon').setAttribute('href', t.icon);
    $('step-2-label').textContent = t.step2;
    $('sections-lead').textContent = t.lead;
    $('legend-in').textContent = t.legendIn;
    $('legend-out').textContent = t.legendOut;
    $('legend-limits').textContent = t.legendLimits;
    banner('');
    if (changed) {
      showResult();
      Zoom.showResult();
      Broll.showResult();
      Pov.showResult();
      Express.showResult();
      renderTracks();
    }
    show('tool', 1);
    return loadTimeline(false);
  }

  /** Le bouton du bas change de role selon l'ecran. */
  function updateUi() {
    var msg = $('footer-msg');
    var main = $('btn-main');
    var p = store.params;
    var msgBefore = msg.textContent;
    msg.textContent = '';
    main.classList.toggle('loading', state.busy);
    document.body.classList.toggle('busy', state.busy);

    if (state.screen === 'tool' && state.step === 1) {
      main.textContent = 'Valider les sections';
      var problem = '';
      if (!state.info) problem = 'Ouvre une séquence dans Premiere';
      else if (state.sectionMsg) problem = state.sectionMsg;
      else if (!state.sections.length) problem = 'Définis les sections';
      else if (!selectedTracks().length) problem = 'Coche au moins une piste ' + (isZoom() ? 'vidéo' : 'audio');
      else if (state.tool === 'pov' && selectedTracks().length < 2) problem = 'Coche le micro de chaque intervenant (au moins deux)';
      msg.textContent = state.busy ? '' : problem;
      main.disabled = state.busy || !!problem;
    } else if (state.screen === 'tool' && (isZoom() || state.tool === 'broll' || state.tool === 'pov' || state.tool === 'express')) {
      var f = isZoom() ? Zoom.footer() : state.tool === 'pov' ? Pov.footer() : state.tool === 'express' ? Express.footer() : Broll.footer();
      main.textContent = f.text;
      main.disabled = f.disabled;
      msg.textContent = f.msg;
    } else if (state.screen === 'tool') {
      var count = state.plan ? state.plan.audio.length : 0;
      if (state.analysis) {
        main.textContent = CUT_LABELS[p.silences] || CUT_LABELS.delete;
        main.disabled = state.busy || !count;
        if (!state.busy && !count) msg.textContent = 'Aucun silence détecté avec ces réglages';
      } else {
        main.textContent = 'Revenir aux sections';
        main.disabled = state.busy;
      }
    }
    // le message du bas ne s'anime que lorsqu'il change vraiment
    if (msg.textContent && msg.textContent !== msgBefore) replay(msg, 'flash');
    syncAllBox();

    $('btn-refresh').disabled = state.busy;
    $('btn-play').disabled = !state.analysis || !state.analysis.wavPath;
    $('wave-empty').classList.toggle('hidden', !!state.analysis);

    var isDelete = p.silences === 'delete';
    $('transition').disabled = !isDelete;
    $('overlap').disabled = !isDelete || p.transitions === 'none';
    $('noise').disabled = p.autoNoiseLevel;
    $('noise-num').disabled = p.autoNoiseLevel;
    $('min-between').disabled = !p.minTimeBetweenCuts.enabled;

    var buttons = document.querySelectorAll('#section-modes .btn');
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].classList.toggle('on', buttons[i].getAttribute('data-mode') === sectionMode());
      buttons[i].disabled = state.busy;
    }
  }

  function setBusy(busy) {
    state.busy = busy;
    updateUi();
  }

  // ------------------------------------------------------------------ réglages

  function writeControls() {
    var p = store.params;
    $('noise').value = p.noiseLevel;
    $('noise-num').value = p.noiseLevel;
    $('auto-noise').checked = p.autoNoiseLevel;
    $('min-silence').value = p.minTimeOfSilence;
    $('min-talk').value = p.minTimeOfTalk;
    $('margin-before').value = p.marginBefore;
    $('margin-after').value = p.marginAfter;
    $('min-between-on').checked = p.minTimeBetweenCuts.enabled;
    $('min-between').value = p.minTimeBetweenCuts.value;
    $('transition').value = p.transitions;
    $('overlap').value = p.overlapFrames;
    $('backup').checked = store.backup;
    $('skip-silences').checked = store.skipSilences;
    var radios = document.querySelectorAll('input[name="mode"]');
    for (var i = 0; i < radios.length; i++) radios[i].checked = radios[i].value === p.silences;
    paintRange();
  }

  function readControls() {
    var mode = document.querySelector('input[name="mode"]:checked');
    return D.normalizeParams({
      noiseLevel: $('noise-num').value,
      autoNoiseLevel: $('auto-noise').checked,
      minTimeOfSilence: $('min-silence').value,
      minTimeOfTalk: $('min-talk').value,
      marginBefore: $('margin-before').value,
      marginAfter: $('margin-after').value,
      minTimeBetweenCuts: { enabled: $('min-between-on').checked, value: $('min-between').value },
      silences: mode ? mode.value : store.params.silences,
      transitions: $('transition').value,
      overlapFrames: $('overlap').value
    });
  }

  function onParamChange(source) {
    if (source === 'slider') $('noise-num').value = $('noise').value;
    var p = readControls();
    var autoTurnedOn = p.autoNoiseLevel && !store.params.autoNoiseLevel;
    store.params = p;
    if (source !== 'slider') $('noise').value = p.noiseLevel;
    if (autoTurnedOn) applyAutoNoise();
    paintRange();
    store.backup = $('backup').checked;
    store.skipSilences = $('skip-silences').checked;
    saveSettings();
    recompute();
  }

  function applyAutoNoise() {
    var a = state.analysis;
    if (!store.params.autoNoiseLevel || !a) return;
    store.params.noiseLevel = D.suggestNoiseLevelSections(a.env, a.range.startFrame, a.sections, a.range.fps);
    $('noise').value = store.params.noiseLevel;
    $('noise-num').value = store.params.noiseLevel;
    paintRange();
  }

  function renderPresets() {
    var sel = $('preset-select');
    sel.innerHTML = '';
    var first = document.createElement('option');
    first.value = '';
    first.textContent = store.presets.length ? 'Préréglages…' : 'Aucun préréglage';
    sel.appendChild(first);
    store.presets.forEach(function (p, i) {
      var o = document.createElement('option');
      o.value = String(i);
      o.textContent = p.name;
      sel.appendChild(o);
    });
    $('btn-preset-delete').disabled = true;
  }

  // ------------------------------------------------------------------ sections

  /** Reperes de la sequence, en images. */
  function seqFrame(info) {
    var seq = info.sequence;
    var fps = TPS / seq.timebase;
    var endTicks = seq.contentEndTicks > 0 ? seq.contentEndTicks : seq.endTicks;
    var endSec = endTicks / TPS;
    var eps = 0.5 / fps;
    // Sans point pose, Premiere rend une valeur hors de la sequence : on ne
    // retient un point que s'il tombe reellement dans le montage.
    var inValid = seq.inSec > eps && seq.inSec < endSec - eps;
    var start = inValid ? seq.inSec : 0;
    var outValid = seq.outSec > start + eps && seq.outSec < endSec - eps;
    return {
      fps: fps,
      endFrame: Math.round(endSec * fps),
      inValid: inValid,
      outValid: outValid,
      inFrame: Math.round(start * fps),
      outFrame: Math.round((outValid ? seq.outSec : endSec) * fps)
    };
  }

  /** Sections a traiter pour un mode donne. Rend { sections, message }. */
  function computeSections(mode) {
    var info = state.info;
    if (!info) return { sections: [], message: '' };
    var f = seqFrame(info);
    if (f.endFrame < 2) return { sections: [], message: 'La séquence est vide' };

    if (mode === 'all') return { sections: [{ startFrame: 0, endFrame: f.endFrame }], message: '' };

    if (mode === 'inout') {
      if (!f.inValid && !f.outValid) {
        return { sections: [], message: 'Pose un point d\'entrée et de sortie dans la timeline, puis reclique' };
      }
      return { sections: [{ startFrame: f.inFrame, endFrame: f.outFrame }], message: '' };
    }

    var tb = info.sequence.timebase;
    var out = [];
    ((state.layout && state.layout.selection) || []).forEach(function (s) {
      var a = Math.max(0, Math.round(s[0] / tb));
      var b = Math.min(f.endFrame, Math.round(s[1] / tb));
      if (b - a < 1) return;
      var last = out[out.length - 1];
      if (last && a <= last.endFrame) last.endFrame = Math.max(last.endFrame, b);
      else out.push({ startFrame: a, endFrame: b });
    });
    if (!out.length) {
      return { sections: [], message: 'Sélectionne des clips dans la timeline, puis reclique sur « Clips sélectionnés »' };
    }
    return { sections: out, message: '' };
  }

  function applyMode(mode) {
    setSectionMode(mode);
    var r = computeSections(mode);
    state.sections = r.sections;
    state.sectionMsg = r.message;
    renderSeqLine();
    drawTracks();
    updateUi();
  }

  function selectedTracks() {
    var out = [];
    var boxes = document.querySelectorAll('#track-rows input[type="checkbox"]');
    for (var i = 0; i < boxes.length; i++) {
      if (boxes[i].checked && !boxes[i].disabled) out.push(parseInt(boxes[i].value, 10));
    }
    return out;
  }

  /** Case « Tout » : cochee, vide, ou tiret quand seules certaines pistes le sont. */
  function syncAllBox() {
    var all = $('tracks-all');
    var boxes = document.querySelectorAll('#track-rows input[type="checkbox"]:not(:disabled)');
    var on = 0;
    for (var i = 0; i < boxes.length; i++) if (boxes[i].checked) on++;
    all.disabled = state.busy || boxes.length === 0;
    all.checked = boxes.length > 0 && on === boxes.length;
    all.indeterminate = on > 0 && on < boxes.length;
  }

  /** Coche ou decoche toutes les pistes d'un coup. */
  function setAllTracks(checked) {
    var boxes = document.querySelectorAll('#track-rows input[type="checkbox"]:not(:disabled)');
    for (var i = 0; i < boxes.length; i++) {
      boxes[i].checked = checked;
      var row = boxes[i].closest('.tl-row');
      if (row) row.classList.toggle('off', !checked);
    }
    if (state.info) {
      trackChoices()[state.info.sequence.id] = selectedTracks();
      saveSettings();
    }
    drawTracks();
    updateUi();
  }

  function renderSeqLine() {
    var info = state.info;
    if (!info) {
      $('seq-line').textContent = 'Aucune séquence active.';
      return;
    }
    var f = seqFrame(info);
    var total = 0;
    state.sections.forEach(function (s) {
      total += s.endFrame - s.startFrame;
    });
    var text = info.sequence.name;
    if (state.sections.length) {
      text +=
        ' · ' + MODE_NAMES[sectionMode()] + ' · ' + fmtDur(total / f.fps) + ' à traiter' +
        (state.sections.length > 1 ? ' en ' + state.sections.length + ' sections' : '');
    }
    $('seq-line').textContent = text;
    $('seq-line').title = text;
  }

  /** Lignes des pistes (audio pour Silences, video pour Zoom) : case a cocher, nom, bandeau. */
  function renderTracks() {
    var info = state.info;
    var box = $('track-rows');
    box.innerHTML = '';
    if (!info) return;

    var video = isZoom();
    var letter = video ? 'V' : 'A';
    var list = toolTracks(info);
    var seq = info.sequence;
    var saved = trackChoices()[seq.id];
    var withClips = list.filter(function (t) {
      return t.clips > 0 && !(video && t.locked);
    });
    var defaults;
    if (video) {
      // par defaut : la piste video la plus basse qui porte des clips (le plan principal)
      defaults = withClips.length ? [withClips[0].index] : [];
    } else {
      // POV : chaque micro compte, meme coupe a l'ecoute dans Premiere
      var audible = state.tool === 'pov' || state.tool === 'express' ? withClips : withClips.filter(function (t) {
        return !t.muted;
      });
      defaults = (audible.length ? audible : withClips).map(function (t) {
        return t.index;
      });
    }
    var chosen = Array.isArray(saved) ? saved : defaults;
    var anyValid = chosen.some(function (i) {
      return withClips.some(function (t) {
        return t.index === i;
      });
    });
    if (!anyValid) chosen = defaults;

    if (!list.length) {
      var none = document.createElement('div');
      none.className = 'tl-empty';
      none.textContent = 'Cette séquence n\'a pas de piste ' + (video ? 'vidéo' : 'audio') + '.';
      box.appendChild(none);
      return;
    }

    list.forEach(function (t, position) {
      var row = document.createElement('div');
      row.className = 'tl-row appear';
      row.style.setProperty('--i', String(position)); // les lignes arrivent l'une apres l'autre
      setTimeout(function () {
        row.classList.remove('appear');
      }, 1200 + position * 45);
      var head = document.createElement('span');
      head.className = 'tl-head';
      var lab = document.createElement('label');
      lab.className = 'box';
      var input = document.createElement('input');
      input.type = 'checkbox';
      input.value = String(t.index);
      var lockedVideo = video && t.locked;
      input.disabled = t.clips === 0 || lockedVideo;
      input.checked = !input.disabled && chosen.indexOf(t.index) >= 0;
      var mark = document.createElement('span');
      lab.appendChild(input);
      lab.appendChild(mark);
      var name = document.createElement('span');
      name.className = 'tl-name';
      name.textContent = letter + (t.index + 1);
      head.appendChild(lab);
      head.appendChild(name);
      head.title = t.name + (t.clips === 0 ? ' — piste vide' : ' — ' + t.clips + ' clip' + (t.clips > 1 ? 's' : '')) +
        (t.muted ? ' — muette dans Premiere' : '') + (lockedVideo ? ' — verrouillée dans Premiere' : '');
      var body = document.createElement('div');
      body.className = 'tl-body';
      var cv = document.createElement('canvas');
      cv.setAttribute('data-track', String(t.index));
      body.appendChild(cv);
      row.appendChild(head);
      row.appendChild(body);
      row.classList.toggle('off', !input.checked);
      input.addEventListener('change', function () {
        row.classList.toggle('off', !input.checked);
        trackChoices()[seq.id] = selectedTracks();
        saveSettings();
        drawTracks();
        updateUi();
      });
      box.appendChild(row);
    });
  }

  function prepCanvas(cv) {
    var dpr = window.devicePixelRatio || 1;
    var w = Math.max(1, cv.clientWidth);
    var h = Math.max(1, cv.clientHeight);
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
    }
    var ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { ctx: ctx, w: w, h: h };
  }

  var BAR_PATTERN = [0.34, 0.5, 0.82, 0.6, 0.3, 0.42, 0.95, 0.66, 0.26, 0.38, 0.74, 0.9, 0.46, 0.3];

  /** Mini-timeline de l'etape 1 : regle et une bande par piste audio. */
  function drawTracks() {
    if (state.screen !== 'tool' || state.step !== 1) return;
    var info = state.info;
    var endFrame = info ? seqFrame(info).endFrame : 0;
    var fps = info ? seqFrame(info).fps : 30;
    $('tl-end').textContent = fmtClock(endFrame / fps);

    var ruler = prepCanvas($('tl-ruler'));
    ruler.ctx.fillStyle = '#e6e9f2';
    ruler.ctx.fillRect(0, ruler.h - 2, ruler.w, 2);
    for (var k = 0; k <= 9; k++) {
      var rx = Math.min(ruler.w - 2, Math.round((k / 9) * (ruler.w - 2)));
      var edge = k === 0 || k === 9;
      ruler.ctx.fillRect(rx, edge ? 0 : ruler.h - 6, 2, edge ? ruler.h : 6);
    }
    if (!info || !endFrame) return;

    var tb = info.sequence.timebase;
    var checked = selectedTracks();
    var canvases = document.querySelectorAll('#track-rows canvas');
    for (var c = 0; c < canvases.length; c++) {
      var cv = canvases[c];
      var index = parseInt(cv.getAttribute('data-track'), 10);
      var g = prepCanvas(cv);
      var on = checked.indexOf(index) >= 0;
      var spans = null;
      var lay = state.layout && (isZoom() ? state.layout.video : state.layout.audio);
      if (lay) {
        lay.forEach(function (a) {
          if (a.index === index) spans = a.spans;
        });
      }
      var xOf = function (frame) {
        return (frame / endFrame) * g.w;
      };

      // fond des sections retenues
      if (on) {
        g.ctx.fillStyle = 'rgba(242, 106, 46, 0.10)';
        state.sections.forEach(function (s) {
          g.ctx.fillRect(xOf(s.startFrame), 0, Math.max(1, xOf(s.endFrame) - xOf(s.startFrame)), g.h);
        });
      }

      // barres : claires dans une section analysee, eteintes ailleurs
      var si = 0;
      var pi = 0;
      for (var x = 0, b = 0; x < g.w; x += 5, b++) {
        var frame = ((x + 1.5) / g.w) * endFrame;
        var tick = frame * tb;
        var covered = !spans;
        if (spans) {
          while (pi < spans.length && spans[pi][1] <= tick) pi++;
          covered = pi < spans.length && spans[pi][0] <= tick;
        }
        if (!covered) {
          g.ctx.fillStyle = '#262c3a';
          g.ctx.fillRect(x, g.h - 2, 3, 2);
          continue;
        }
        while (si < state.sections.length && state.sections[si].endFrame <= frame) si++;
        var inSection = si < state.sections.length && state.sections[si].startFrame <= frame;
        // a l'arrivee, les barres poussent de gauche a droite
        var grow = Math.max(0, Math.min(1, state.trackGrow * 1.6 - (x / g.w) * 0.6));
        // piste video : bande pleine, comme une pellicule ; piste audio : forme d'onde
        var shape = isZoom() ? 0.72 : BAR_PATTERN[b % BAR_PATTERN.length];
        var bh = Math.max(3, Math.round(shape * (g.h - 2) * grow));
        g.ctx.fillStyle = on && inSection ? '#d5dbe8' : '#3a4358';
        g.ctx.fillRect(x, g.h - bh, 3, bh);
      }

      // limites de la zone qui sera coupee
      g.ctx.strokeStyle = '#f26a2e';
      g.ctx.lineWidth = 1.5;
      g.ctx.setLineDash([4, 3]);
      state.sections.forEach(function (s) {
        [s.startFrame, s.endFrame].forEach(function (fr) {
          var lx = Math.min(g.w - 1, Math.max(1, Math.round(xOf(fr))));
          g.ctx.beginPath();
          g.ctx.moveTo(lx, 0);
          g.ctx.lineTo(lx, g.h);
          g.ctx.stroke();
        });
      });
      g.ctx.setLineDash([]);
    }
  }

  // ------------------------------------------------------------------ séquence

  function dropAnalysis(message) {
    if (!state.analysis) return;
    stopPlayback();
    state.analysis = null;
    state.plan = null;
    state.silSec = [];
    state.secSec = [];
    $('player').removeAttribute('src');
    renderStats();
    drawWave();
    if (message) {
      banner(message);
      if (state.screen === 'tool' && state.step === 2) show('tool', 1);
    }
    updateUi();
  }

  /** Relit la sequence active (leger). Rend true si elle est lisible. */
  function refresh(quiet) {
    return call('ADR_getInfo')
      .then(function (info) {
        if (!info.ok) {
          state.info = null;
          state.layout = null;
          state.sections = [];
          state.sectionMsg = '';
          renderTracks();
          renderSeqLine();
          drawTracks();
          dropAnalysis();
          updateUi();
          if (!quiet) {
            banner(
              info.code === 'NO_SEQUENCE' || info.code === 'NO_PROJECT'
                ? 'Aucune séquence active : ouvre ta timeline dans Premiere, puis clique sur le bouton d\'actualisation.'
                : info.error,
              'error'
            );
          }
          return false;
        }
        var changed =
          !state.info ||
          state.info.sequence.id !== info.sequence.id ||
          state.info.sequence.fingerprint !== info.sequence.fingerprint;
        state.info = info;
        if (changed || !document.querySelector('#track-rows .tl-row')) renderTracks();
        var a = state.analysis;
        if (a && (a.seqId !== info.sequence.id || a.fingerprint !== info.sequence.fingerprint)) {
          dropAnalysis(state.tool !== 'silences' ? '' : 'La timeline a changé depuis l\'analyse : valide à nouveau les sections.');
        }
        if (Express.isStale(info)) {
          Express.drop(state.tool === 'express' ? 'La timeline a changé : valide à nouveau les sections.' : '');
        }
        if (Pov.isStale(info)) {
          Pov.drop(state.tool === 'pov' ? 'La timeline a changé depuis la mesure des micros : valide à nouveau les sections.' : '');
        }
        if (Broll.isStale(info)) {
          Broll.drop(state.tool === 'broll' ? 'La timeline a changé depuis la transcription : valide à nouveau les sections.' : '');
        }
        if (Zoom.isStale(info)) {
          Zoom.drop(isZoom() ? 'La timeline a changé depuis la lecture des clips : valide à nouveau les sections.' : '');
        }
        updateUi();
        return true;
      })
      .catch(function (e) {
        if (!quiet) banner(e.message, 'error');
        return false;
      });
  }

  /** Relit la sequence ET son plan (clips par piste, selection), puis recalcule les sections. */
  function loadTimeline(quiet) {
    return refresh(quiet).then(function (ok) {
      if (!ok) return false;
      return call('ADR_getLayout')
        .then(function (layout) {
          state.layout = layout.ok ? layout : null;
        })
        .catch(function () {
          state.layout = null;
        })
        .then(function () {
          state.trackGrow = 0;
          applyMode(sectionMode());
          tween(520, function (k) {
            state.trackGrow = k;
            drawTracks();
          });
          return true;
        });
    });
  }

  // ------------------------------------------------------------------- analyse

  /**
   * Cherche la préconfiguration WAV fournie avec Premiere : d'abord dans le
   * dossier de l'application en cours, puis dans les installations voisines
   * (celle de la même année en premier).
   */
  function findWavPreset(appPath, appVersion) {
    var n = N();
    var roots = [];
    var p = String(appPath || '').split('\\').join('/').replace(/\/+$/, '');
    if (p) {
      if (/\.exe$/i.test(p)) p = n.path.dirname(p);
      roots.push(
        p + '/MediaIO/systempresets',
        p + '/Contents/MediaIO/systempresets',
        n.path.dirname(p) + '/MediaIO/systempresets'
      );
    }
    var year = '20' + String(parseInt(appVersion, 10) || '');
    var parents =
      n.os.platform() === 'win32'
        ? [(Host.require('process').env.ProgramFiles || 'C:/Program Files') + '/Adobe']
        : ['/Applications'];
    parents.forEach(function (parent) {
      try {
        var dirs = n.fs.readdirSync(parent).filter(function (d) {
          return /^Adobe Premiere Pro/i.test(d);
        });
        dirs.sort(function (a, b) {
          return (b.indexOf(year) >= 0 ? 1 : 0) - (a.indexOf(year) >= 0 ? 1 : 0);
        });
        dirs.forEach(function (d) {
          var base = parent.split('\\').join('/') + '/' + d;
          roots.push(base + '/MediaIO/systempresets');
          roots.push(base + '/' + d + '.app/Contents/MediaIO/systempresets');
        });
      } catch (e) {}
    });
    for (var i = 0; i < roots.length; i++) {
      var dir = roots[i] + '/3F3F3F3F_57415645'; // dossier des exports « Waveform Audio »
      try {
        if (!n.fs.existsSync(dir)) continue;
        var files = n.fs.readdirSync(dir).filter(function (f) {
          return /\.epr$/i.test(f);
        });
        if (!files.length) continue;
        var best =
          files.filter(function (f) {
            return /48.*16/.test(f);
          })[0] || files[0];
        return n.path.normalize(dir + '/' + best);
      } catch (e) {}
    }
    return '';
  }

  /**
   * Fait correspondre le WAV a la zone a analyser.
   * `zoneExport` : on a demande a Premiere la zone entree-sortie seulement.
   * Sinon (ou si Premiere a tout exporte quand meme), on recoupe la zone dans
   * le fichier de la sequence entiere.
   */
  function alignEnvelope(wav, range, seqEndFrame, zoneExport) {
    var fps = range.fps;
    var want = (range.endFrame - range.startFrame) / fps;
    var seqDur = seqEndFrame / fps;
    var dZone = Math.abs(wav.durationSec - want);
    var dAll = Math.abs(wav.durationSec - seqDur);
    var offset = 0;
    var note = '';
    if (zoneExport && !(dAll < dZone && dAll < Math.max(0.5, seqDur * 0.02))) {
      if (dZone > Math.max(0.5, want * 0.02)) {
        note =
          'Durée exportée inattendue (' + fmtSec(wav.durationSec) + ' au lieu de ' + fmtSec(want) +
          ') : vérifie l\'aperçu avant de couper.';
      }
    } else {
      offset = range.startFrame / fps;
      if (dAll > Math.max(0.5, seqDur * 0.02)) {
        note =
          'Durée exportée inattendue (' + fmtSec(wav.durationSec) + ' au lieu de ' + fmtSec(seqDur) +
          ') : vérifie l\'aperçu avant de couper.';
      }
    }
    var i0 = Math.min(wav.peaks.length, Math.round(offset / wav.hopSec));
    var i1 = Math.min(wav.peaks.length, i0 + Math.ceil(want / wav.hopSec));
    return { hopSec: wav.hopSec, peaks: wav.peaks.subarray(i0, i1), audioOffset: offset, note: note };
  }

  /** Etape 1 -> etape 2 : fige les sections, exporte l'audio et l'analyse. */
  function validateSections() {
    if (state.busy) return Promise.resolve();
    var sections = state.sections.slice();
    var mode = sectionMode();
    var tracks = selectedTracks();
    if (!sections.length || !tracks.length) return Promise.resolve();
    saveSettings();
    if (isZoom()) return Zoom.validate(sections, mode, tracks);
    if (state.tool === 'broll') return Broll.validate(sections, mode, tracks);
    if (state.tool === 'pov') return Pov.validate(sections, mode, tracks);
    if (state.tool === 'express') return Express.validate(sections, mode, tracks);

    setBusy(true);
    banner('');
    showResult();
    stopPlayback();
    saveSettings();
    var wavPath = '';
    var info, range, f, zoneExport;

    return refresh(false)
      .then(function (ok) {
        if (!ok) throw new Error('');
        info = state.info;
        f = seqFrame(info);
        range = { startFrame: sections[0].startFrame, endFrame: sections[sections.length - 1].endFrame, fps: f.fps };
        if (range.endFrame > f.endFrame) throw new Error('La timeline a changé : redéfinis les sections.');
        // Seule la zone entree-sortie peut etre exportee seule ; sinon Premiere
        // exporte toute la sequence et on y recoupe la zone voulue.
        zoneExport =
          mode === 'inout' && range.startFrame === f.inFrame && range.endFrame === f.outFrame && (f.inValid || f.outValid);

        setProgress(null, 'Premiere exporte l\'audio… (la fenêtre peut se figer quelques instants)');
        if (DEMO) return { demo: true };

        var preset = findWavPreset(info.appPath, info.appVersion);
        if (!preset) {
          throw new Error(
            'Préconfiguration d\'export WAV de Premiere introuvable (dossier MediaIO/systempresets). ' +
              'Dossier de l\'application : ' + (info.appPath || 'inconnu') + '.'
          );
        }
        wavPath = N().path.join(tempDir(), 'analyse-' + Date.now() + '.wav');
        // on lache le fichier de l'analyse precedente avant de l'effacer
        $('player').removeAttribute('src');
        $('player').load();
        cleanTemp(wavPath);
        return call('ADR_exportAudio', [wavPath, preset, zoneExport ? '1' : '0', tracks.join(',')]);
      })
      .then(function (res) {
        if (res.demo) return Demo.envelope(range);
        if (!res.ok) throw new Error(res.error || 'L\'export audio a échoué.');
        setProgress(0, 'Lecture de l\'audio…');
        return W.readEnvelope(wavPath, HOP, function (frac) {
          setProgress(frac, 'Lecture de l\'audio… ' + Math.round(frac * 100) + ' %');
        });
      })
      .then(function (wav) {
        var env = DEMO
          ? { hopSec: wav.hopSec, peaks: wav.peaks, audioOffset: 0, note: '' }
          : alignEnvelope(wav, range, f.endFrame, zoneExport);
        if (!env.peaks.length) throw new Error('L\'export audio est vide : aucune piste audible dans la zone ?');
        state.analysis = {
          seqId: info.sequence.id,
          seqName: info.sequence.name,
          fingerprint: info.sequence.fingerprint,
          timebase: info.sequence.timebase,
          range: range,
          sections: sections,
          mode: mode,
          outFrame: mode === 'inout' && f.outValid ? f.outFrame : -1,
          env: env,
          audioOffset: env.audioOffset,
          tracks: tracks,
          wavPath: DEMO ? '' : wavPath
        };
        state.secSec = sections.map(function (s) {
          return { a: (s.startFrame - range.startFrame) / range.fps, b: (s.endFrame - range.startFrame) / range.fps };
        });
        state.view = { t0: 0, t1: env.peaks.length * env.hopSec };
        if (!DEMO) $('player').src = encodeURI('file:///' + wavPath.split('\\').join('/'));
        applyAutoNoise();
        hideProgress();
        state.busy = false;
        show('tool', 2);
        if (env.note) banner(env.note);
        state.waveGrow = 0;
        state.lastStats = [];
        recompute();
        tween(700, function (k) {
          state.waveGrow = k;
          drawWave();
        });
        log('Analyse : ' + info.sequence.name + ' (' + MODE_NAMES[mode] + '), pistes ' +
          tracks.map(function (i) { return 'A' + (i + 1); }).join(' ') + ', ' +
          sections.length + ' section' + (sections.length > 1 ? 's' : '') + '.');
      })
      .catch(function (e) {
        if (e && e.message) {
          banner(e.message, 'error');
          log('Analyse impossible : ' + e.message);
        }
      })
      .then(function () {
        hideProgress();
        setBusy(false);
      });
  }

  function recompute() {
    var a = state.analysis;
    if (a) {
      state.plan = D.detectSections(a.env, a.range.startFrame, a.sections, store.params, a.range.fps);
      state.silSec = state.plan.audio.map(function (s) {
        return {
          a: (s.startFrame - a.range.startFrame) / a.range.fps,
          b: (s.endFrame - a.range.startFrame) / a.range.fps
        };
      });
    } else {
      state.plan = null;
      state.silSec = [];
    }
    renderStats();
    drawWave();
    updateUi();
  }

  function renderStats() {
    var box = $('stats');
    box.innerHTML = '';
    if (!state.plan) return;
    var s = state.plan.stats;
    var items = [
      [String(s.count), s.count > 1 ? 'silences détectés' : 'silence détecté'],
      [fmtSec(s.silenceSec), Math.round(s.ratio * 100) + ' % de la zone'],
      [fmtDur(s.keptSec), 'au lieu de ' + fmtDur(s.totalSec)]
    ];
    var before = state.lastStats;
    state.lastStats = items.map(function (it) {
      return it[0];
    });
    items.forEach(function (it, idx) {
      var d = document.createElement('div');
      d.className = 'stat';
      var b = document.createElement('b');
      b.textContent = it[0];
      if (before[idx] !== it[0]) b.className = 'bump'; // le chiffre qui change se signale
      var sp = document.createElement('span');
      sp.textContent = it[1];
      d.appendChild(b);
      d.appendChild(sp);
      box.appendChild(d);
    });
  }

  // -------------------------------------------------------------------- aperçu

  function totalSec() {
    var a = state.analysis;
    return a ? a.env.peaks.length * a.env.hopSec : 0;
  }

  /** Intervalle de `list` qui contient t, ou null. */
  function spanAt(list, t) {
    var lo = 0;
    var hi = list.length;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (list[mid].b <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo < list.length && list[lo].a <= t ? list[lo] : null;
  }

  function rulerStep(span) {
    var steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];
    for (var i = 0; i < steps.length; i++) if (span / steps[i] <= 7) return steps[i];
    return 7200;
  }

  function drawWave() {
    if (state.screen !== 'tool' || state.step !== 2 || state.tool !== 'silences') return;
    var g = prepCanvas($('wave'));
    var ctx = g.ctx;
    var w = g.w;
    var h = g.h;
    var a = state.analysis;
    if (!a) return;

    var t0 = state.view.t0;
    var t1 = state.view.t1;
    var span = t1 - t0;
    var plotH = h - RULER_H;
    var xOf = function (t) {
      return ((t - t0) / span) * w;
    };
    var i;

    // fond des silences
    ctx.fillStyle = 'rgba(239, 75, 75, 0.15)';
    for (i = 0; i < state.silSec.length; i++) {
      var s = state.silSec[i];
      if (s.b <= t0) continue;
      if (s.a >= t1) break;
      var x0 = Math.max(0, xOf(s.a));
      var x1 = Math.min(w, xOf(s.b));
      ctx.fillRect(x0, 0, Math.max(1, x1 - x0), plotH);
    }

    // niveaux, une barre par pixel
    var cols = D.columns(a.env, t0, t1, w);
    for (var x = 0; x < w; x++) {
      var db = D.toDb(cols[x]);
      var y = (db - DB_MIN) / -DB_MIN;
      if (y < 0) y = 0;
      if (y > 1) y = 1;
      // a l'arrivee, la forme d'onde se deploie de gauche a droite
      var grow = Math.max(0, Math.min(1, state.waveGrow * 1.6 - (x / w) * 0.6));
      var bar = Math.max(1, y * (plotH - 2) * grow);
      var t = t0 + ((x + 0.5) / w) * span;
      if (!spanAt(state.secSec, t)) ctx.fillStyle = '#343c4f'; // hors section : ignore
      else ctx.fillStyle = spanAt(state.silSec, t) ? '#ef4b4b' : '#3ddc97';
      ctx.fillRect(x, plotH - bar, 1, bar);
    }

    // niveau de bruit
    var yThr = plotH - ((store.params.noiseLevel - DB_MIN) / -DB_MIN) * (plotH - 2);
    ctx.strokeStyle = '#f26a2e';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(0, Math.round(yThr) + 0.5);
    ctx.lineTo(w, Math.round(yThr) + 0.5);
    ctx.stroke();
    ctx.setLineDash([]);

    // règle : temps de la séquence
    ctx.fillStyle = '#171a22';
    ctx.fillRect(0, plotH, w, RULER_H);
    ctx.fillStyle = '#98a2b6';
    ctx.font = '10px Inter, "Segoe UI", Arial, sans-serif';
    ctx.textBaseline = 'middle';
    var base = a.range.startFrame / a.range.fps;
    var step = rulerStep(span);
    var first = Math.ceil((base + t0) / step) * step;
    for (var tt = first; tt <= base + t1; tt += step) {
      var rx = xOf(tt - base);
      ctx.fillRect(Math.round(rx), plotH, 1, 4);
      var label = step < 1 ? fmtDur(Math.floor(tt)) + ',' + Math.round((tt % 1) * 10) : fmtDur(tt);
      if (rx + 3 < w - 24) ctx.fillText(label, rx + 3, plotH + RULER_H / 2 + 1);
    }

    // tête de lecture
    var pt = playerTime();
    if (pt !== null && pt >= t0 && pt <= t1) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(Math.round(xOf(pt)), 0, 1, plotH);
    }
  }

  function setView(t0, t1) {
    var total = totalSec();
    if (!total) return;
    var minSpan = Math.min(total, 0.5);
    var span = Math.max(minSpan, Math.min(total, t1 - t0));
    if (t0 < 0) t0 = 0;
    if (t0 + span > total) t0 = total - span;
    state.view = { t0: t0, t1: t0 + span };
    drawWave();
  }

  function zoom(factor, anchor) {
    var v = state.view;
    var span = v.t1 - v.t0;
    var at = anchor === undefined ? v.t0 + span / 2 : anchor;
    var ns = span * factor;
    var k = (at - v.t0) / span;
    setView(at - ns * k, at - ns * k + ns);
  }

  function bindWave() {
    var cv = $('wave');
    var drag = null;

    cv.addEventListener(
      'wheel',
      function (ev) {
        if (!state.analysis) return;
        ev.preventDefault();
        var rect = cv.getBoundingClientRect();
        var v = state.view;
        var at = v.t0 + ((ev.clientX - rect.left) / rect.width) * (v.t1 - v.t0);
        zoom(ev.deltaY < 0 ? 0.8 : 1.25, at);
      },
      { passive: false }
    );

    cv.addEventListener('mousedown', function (ev) {
      if (!state.analysis) return;
      drag = { x: ev.clientX, t0: state.view.t0, t1: state.view.t1, moved: false };
    });

    window.addEventListener('mousemove', function (ev) {
      if (!drag) return;
      var dx = ev.clientX - drag.x;
      if (Math.abs(dx) > 3) drag.moved = true;
      if (!drag.moved) return;
      var rect = cv.getBoundingClientRect();
      var dt = (dx / rect.width) * (drag.t1 - drag.t0);
      setView(drag.t0 - dt, drag.t1 - dt);
    });

    window.addEventListener('mouseup', function (ev) {
      if (!drag) return;
      var wasDrag = drag.moved;
      drag = null;
      if (wasDrag || !state.analysis) return;
      var rect = cv.getBoundingClientRect();
      if (ev.clientX < rect.left || ev.clientX > rect.right) return;
      var v = state.view;
      seek(v.t0 + ((ev.clientX - rect.left) / rect.width) * (v.t1 - v.t0), true);
    });

    cv.addEventListener('dblclick', function () {
      setView(0, totalSec());
    });

    $('btn-zoom-in').addEventListener('click', function () {
      zoom(0.5);
    });
    $('btn-zoom-out').addEventListener('click', function () {
      zoom(2);
    });
    $('btn-zoom-fit').addEventListener('click', function () {
      setView(0, totalSec());
    });

    window.addEventListener('resize', function () {
      drawTracks();
      drawWave();
      Zoom.draw();
      Pov.draw();
    });
  }

  // ------------------------------------------------------------------- lecture

  var cursor = null; // position choisie au clic quand il n'y a pas de lecteur

  function playerTime() {
    var a = state.analysis;
    if (!a) return null;
    if (!a.wavPath) return cursor;
    var t = $('player').currentTime - a.audioOffset;
    return isFinite(t) ? t : null;
  }

  function seek(t, movePlayhead) {
    var a = state.analysis;
    if (!a) return;
    t = Math.max(0, Math.min(totalSec(), t));
    cursor = t;
    if (a.wavPath) {
      try {
        $('player').currentTime = a.audioOffset + t;
      } catch (e) {}
    }
    if (movePlayhead) {
      var frame = a.range.startFrame + Math.round(t * a.range.fps);
      call('ADR_setPlayhead', [String(frame * a.timebase)]).catch(function () {});
    }
    renderPlayTime();
    drawWave();
  }

  function renderPlayTime() {
    var t = playerTime();
    $('play-time').textContent = t === null ? '' : fmtDur(t) + ' / ' + fmtDur(totalSec());
  }

  function stopPlayback() {
    var p = $('player');
    try {
      p.pause();
    } catch (e) {}
    state.playing = false;
    $('btn-play').textContent = '▶ Écouter';
  }

  /** Ou reprendre la lecture si t tombe dans un silence ou hors section. null = fin. */
  function skipTarget(t) {
    var sil = spanAt(state.silSec, t);
    if (sil) return sil.b;
    if (spanAt(state.secSec, t)) return t;
    for (var i = 0; i < state.secSec.length; i++) {
      if (state.secSec[i].a > t) return state.secSec[i].a;
    }
    return null;
  }

  function tickPlayback() {
    if (!state.playing) return;
    var a = state.analysis;
    var p = $('player');
    if (!a || p.paused) {
      stopPlayback();
      drawWave();
      return;
    }
    var t = p.currentTime - a.audioOffset;
    if (t >= totalSec() - 0.02) {
      stopPlayback();
    } else if (store.skipSilences) {
      var to = skipTarget(t);
      if (to === null || to >= totalSec() - 0.02) stopPlayback();
      else if (to > t) p.currentTime = a.audioOffset + to + 0.001;
    }
    // la fenêtre suit la lecture
    var v = state.view;
    if (state.playing && (t > v.t1 || t < v.t0)) setView(t, t + (v.t1 - v.t0));
    renderPlayTime();
    drawWave();
    if (state.playing) window.requestAnimationFrame(tickPlayback);
  }

  function togglePlayback() {
    var a = state.analysis;
    if (!a || !a.wavPath) return;
    var p = $('player');
    if (state.playing) {
      stopPlayback();
      return;
    }
    var t = p.currentTime - a.audioOffset;
    if (!(t >= 0) || t >= totalSec() - 0.05) p.currentTime = a.audioOffset;
    var started = p.play();
    state.playing = true;
    $('btn-play').textContent = '❚❚ Pause';
    if (started && started.catch) {
      started.catch(function (e) {
        stopPlayback();
        banner('Lecture de l\'aperçu impossible : ' + (e && e.message ? e.message : e), 'error');
      });
    }
    window.requestAnimationFrame(tickPlayback);
  }

  // -------------------------------------------------------------------- découpe

  function planText(a, plan, backupName) {
    var lines = [
      'version=1',
      'mode=' + plan.params.silences,
      'sequenceId=' + a.seqId,
      'timebase=' + a.timebase,
      'backup=' + (store.backup ? '1' : '0'),
      'backupName=' + backupName,
      'detectTracks=' + a.tracks.join(','),
      'outFrame=' + a.outFrame
    ];
    plan.video.forEach(function (s) {
      lines.push('V ' + s.startFrame + ' ' + s.endFrame);
    });
    plan.audio.forEach(function (s) {
      lines.push('A ' + s.startFrame + ' ' + s.endFrame);
    });
    return lines.join('\n') + '\n';
  }

  function describeResult(fin, plan) {
    var backup = fin.backupName ? '\nSauvegarde intacte dans le projet : « ' + fin.backupName + ' ».' : '';
    var locked =
      fin.lockedSkipped && fin.lockedSkipped.length
        ? '\nPistes verrouillées non touchées : ' + fin.lockedSkipped.join(', ') + '.'
        : '';

    if (!fin.ok) {
      return {
        kind: 'error',
        text:
          (fin.code === 'CANCELLED' ? 'Découpe interrompue.' : 'Découpe arrêtée : ' + (fin.error || 'erreur inconnue')) +
          (fin.removed || fin.razorDone
            ? '\nDéjà fait : ' + (fin.razorDone || 0) + ' coupe(s), ' + (fin.removed || 0) + ' clip(s) retiré(s).' +
              ' Annule dans Premiere (Ctrl+Z) ou repars de la sauvegarde.'
            : '\nLa timeline n\'a pas été modifiée.') +
          backup
      };
    }

    var s = plan.stats;
    var pl = s.count > 1 ? 's' : '';
    var head;
    if (fin.mode === 'delete') {
      head =
        s.count + ' silence' + pl + ' supprimé' + pl + ' · ' + fmtSec(fin.removedSeconds) + ' retirées · ' +
        fmtDur(s.totalSec) + ' → ' + fmtDur(s.keptSec);
    } else if (fin.mode === 'delete_keep_spaces') {
      head = s.count + ' silence' + pl + ' retiré' + pl + ', espaces laissés en place.';
    } else if (fin.mode === 'mute') {
      head = s.count + ' silence' + pl + ' rendu' + pl + ' muet' + pl + '.';
    } else {
      head = fin.razorDone + ' point' + (fin.razorDone > 1 ? 's' : '') + ' de coupe posé' + (fin.razorDone > 1 ? 's' : '') + '.';
    }

    if (fin.mismatch > 0) {
      return {
        kind: 'warn',
        text:
          head + '\nAttention : le contrôle final relève ' + fin.mismatch +
          ' écart(s) entre la timeline et le plan. Vérifie la synchronisation image / son.\n' +
          (fin.mismatchNotes || []).slice(0, 4).join('\n') + backup + locked
      };
    }
    var links = '';
    if (fin.relinked) links = '\nLiens image / son rétablis sur ' + fin.relinked + ' morceau' + (fin.relinked > 1 ? 'x' : '') + '.';
    if (fin.relinkFailed) {
      return {
        kind: 'warn',
        text: head + '\nAttention : ' + fin.relinkFailed + ' morceau(x) n\'ont pas pu être reliés à leur son (voir le journal).' + backup + locked
      };
    }
    return { kind: 'ok', text: 'Terminé. ' + head + links + backup + locked };
  }

  function cut() {
    if (state.busy) return Promise.resolve();
    var a = state.analysis;
    if (!a || !state.plan || !state.plan.audio.length) return Promise.resolve();
    setBusy(true);
    state.cancel = false;
    banner('');
    showResult();
    stopPlayback();

    var plan = state.plan;
    var planPath = '';
    var started = false;

    return refresh(false)
      .then(function (ok) {
        if (!ok) throw new Error('');
        // refresh a pu invalider l'analyse si la timeline a bouge entre-temps
        if (state.analysis !== a) throw new Error('');

        var locked = [];
        state.info.video.forEach(function (t) {
          if (t.locked && t.clips > 0) locked.push('V' + (t.index + 1));
        });
        state.info.audio.forEach(function (t) {
          if (t.locked && t.clips > 0) locked.push('A' + (t.index + 1));
        });
        if (locked.length && plan.params.silences === 'delete') {
          return ask({
            title: 'Pistes verrouillées',
            text:
              'Les pistes ' + locked.join(', ') + ' sont verrouillées : elles ne seront pas coupées et ' +
              'se retrouveront décalées par rapport au reste.\n\nDéverrouille-les dans Premiere pour tout garder synchrone.',
            ok: 'Couper quand même'
          });
        }
        return true;
      })
      .then(function (go) {
        if (!go) throw new Error('');
        var now = new Date();
        var stamp = now.getHours() + 'h' + p2(now.getMinutes());
        var text = planText(a, plan, a.seqName + ' - avant FirstCut ' + stamp);
        if (!DEMO) {
          planPath = N().path.join(tempDir(), 'plan-' + Date.now() + '.txt');
          N().fs.writeFileSync(planPath, text, 'utf8');
        }
        setProgress(null, store.backup ? 'Sauvegarde de la séquence…' : 'Préparation…');
        return call('ADR_begin', [planPath]);
      })
      .then(function (begin) {
        if (!begin.ok) {
          var e = new Error(begin.error || 'Préparation impossible.');
          e.backupName = begin.backupName;
          throw e;
        }
        started = true;
        $('btn-cancel').classList.remove('hidden');
        var loop = function () {
          if (state.cancel) return call('ADR_cancel');
          return call('ADR_step', ['250']).then(function (st) {
            if (!st.ok) return call('ADR_cancel');
            setProgress(
              st.total ? st.done / st.total : null,
              (PHASES[st.phase] || st.phase) + (st.total > 1 ? ' · ' + st.done + ' / ' + st.total : '')
            );
            if (st.finished) return call('ADR_finish');
            // on rend la main a Premiere entre deux etapes
            return new Promise(function (resolve) {
              setTimeout(resolve, 10);
            }).then(loop);
          });
        };
        return loop();
      })
      .then(function (fin) {
        var res = describeResult(fin, plan);
        var lines = (fin.log || []).slice();
        if (fin.error) lines.push('erreur : ' + fin.error);
        var file = writeLogFile(lines);
        log(lines.concat(file ? ['journal : ' + file] : []));
        showResult(res.kind, res.text);
        if (res.kind !== 'ok') $('log-card').open = true;
      })
      .catch(function (e) {
        if (e && e.message) {
          showResult(
            'error',
            e.message +
              (started ? '' : '\nLa timeline n\'a pas été modifiée.') +
              (e.backupName ? '\nUne copie de sauvegarde a été créée : « ' + e.backupName + ' ».' : '')
          );
          log('Découpe impossible : ' + e.message);
        }
      })
      .then(function () {
        hideProgress();
        if (planPath) {
          try {
            N().fs.unlinkSync(planPath);
          } catch (e) {}
        }
        // La timeline n'est plus celle de l'analyse : il faut repartir des
        // sections pour une nouvelle passe.
        if (started) {
          stopPlayback();
          state.analysis = null;
          state.plan = null;
          state.silSec = [];
          state.secSec = [];
          $('player').removeAttribute('src');
          renderStats();
          drawWave();
          window.scrollTo(0, 0);
        }
        setBusy(false);
        return refresh(true);
      });
  }

  // -------------------------------------------------------------- initialisation

  function onMain() {
    if (state.busy || state.screen !== 'tool') return;
    if (state.step === 1) validateSections();
    else if (isZoom() && Zoom.hasData()) Zoom.apply();
    else if (state.tool === 'broll' && Broll.hasData()) Broll.main();
    else if (state.tool === 'pov' && Pov.hasData()) Pov.apply();
    else if (state.tool === 'express' && Express.hasData()) Express.run();
    else if (!isZoom() && state.analysis) cut();
    else {
      showResult();
      Zoom.showResult();
      Broll.showResult();
      Pov.showResult();
      Express.showResult();
      show('tool', 1);
      loadTimeline(false);
    }
  }

  function bindControls() {
    $('noise').addEventListener('input', function () {
      onParamChange('slider');
    });
    ['noise-num', 'min-silence', 'min-talk', 'margin-before', 'margin-after', 'min-between', 'overlap'].forEach(
      function (id) {
        $(id).addEventListener('change', function () {
          onParamChange();
          writeControls();
        });
      }
    );
    ['auto-noise', 'min-between-on', 'transition', 'backup', 'skip-silences'].forEach(function (id) {
      $(id).addEventListener('change', function () {
        onParamChange();
      });
    });
    var radios = document.querySelectorAll('input[name="mode"]');
    var i;
    for (i = 0; i < radios.length; i++) {
      radios[i].addEventListener('change', function () {
        onParamChange();
      });
    }

    var openers = document.querySelectorAll('[data-open]');
    for (i = 0; i < openers.length; i++) {
      openers[i].addEventListener('click', function (ev) {
        openTool(ev.currentTarget.getAttribute('data-open'));
      });
    }

    var modeButtons = document.querySelectorAll('#section-modes .btn');
    for (i = 0; i < modeButtons.length; i++) {
      modeButtons[i].addEventListener('click', function (ev) {
        if (state.busy) return;
        // on relit la timeline a chaque clic : la selection ou les points
        // d'entree / sortie ont pu changer dans Premiere
        setSectionMode(ev.currentTarget.getAttribute('data-mode'));
        saveSettings();
        banner('');
        loadTimeline(false);
      });
    }

    $('btn-back').addEventListener('click', goBack);
    $('step-1').addEventListener('click', function () {
      if (state.step === 2) goBack();
    });
    $('step-2').addEventListener('click', function () {
      if (state.step === 1 && !$('btn-main').disabled) validateSections();
    });
    $('btn-main').addEventListener('click', onMain);

    $('btn-refresh').addEventListener('click', function () {
      banner('');
      var btn = $('btn-refresh');
      var since = Date.now();
      btn.classList.add('spinning');
      var work = state.screen === 'tool' && state.step === 1 ? loadTimeline(false) : refresh(false);
      // l'icone fait au moins un tour, meme si Premiere repond tout de suite
      work.then(function () {
        setTimeout(function () {
          btn.classList.remove('spinning');
        }, Math.max(0, 700 - (Date.now() - since)));
      });
    });
    $('tracks-all').addEventListener('change', function () {
      setAllTracks($('tracks-all').checked);
    });
    $('btn-cancel').addEventListener('click', function () {
      state.cancel = true;
      $('progress').querySelector('.ptext').textContent = 'Interruption…';
    });
    $('btn-play').addEventListener('click', togglePlayback);

    $('btn-reset').addEventListener('click', function () {
      store.params = clone(D.DEFAULTS);
      writeControls();
      applyAutoNoise();
      saveSettings();
      recompute();
    });

    $('preset-select').addEventListener('change', function () {
      var idx = parseInt($('preset-select').value, 10);
      $('btn-preset-delete').disabled = isNaN(idx);
      if (isNaN(idx) || !store.presets[idx]) return;
      store.params = D.normalizeParams(store.presets[idx].params);
      writeControls();
      applyAutoNoise();
      saveSettings();
      recompute();
    });

    $('btn-preset-save').addEventListener('click', function () {
      ask({ title: 'Enregistrer ces réglages', text: 'Nom du préréglage :', ok: 'Enregistrer', input: true }).then(
        function (name) {
          if (!name) return;
          var entry = { name: name, params: clone(store.params) };
          var found = -1;
          store.presets.forEach(function (p, k) {
            if (p.name.toLowerCase() === name.toLowerCase()) found = k;
          });
          if (found >= 0) store.presets[found] = entry;
          else store.presets.push(entry);
          saveSettings();
          renderPresets();
          $('preset-select').value = String(found >= 0 ? found : store.presets.length - 1);
          $('btn-preset-delete').disabled = false;
        }
      );
    });

    $('btn-preset-delete').addEventListener('click', function () {
      var idx = parseInt($('preset-select').value, 10);
      if (isNaN(idx) || !store.presets[idx]) return;
      store.presets.splice(idx, 1);
      saveSettings();
      renderPresets();
    });

    window.addEventListener('focus', function () {
      if (!state.busy && state.screen === 'tool') refresh(true);
    });
  }

  /** Outils communs transmis a l'ecran Zoom (js/zoom.js). */
  function zoomContext() {
    return {
      state: state,
      store: store,
      DEMO: DEMO,
      call: call,
      show: show,
      setBusy: setBusy,
      updateUi: updateUi,
      refresh: refresh,
      setProgress: setProgress,
      hideProgress: hideProgress,
      banner: banner,
      log: log,
      writeLogFile: writeLogFile,
      saveSettings: saveSettings,
      prepCanvas: prepCanvas,
      tween: tween,
      fmtDur: fmtDur,
      p2: p2,
      tempDir: tempDir,
      N: N,
      Host: Host,
      dataDir: dataDir,
      findWavPreset: findWavPreset,
      cleanTemp: cleanTemp,
      seqFrame: seqFrame,
      ask: ask
    };
  }

  function init() {
    loadSettings();
    writeControls();
    renderPresets();
    Zoom.init(zoomContext());
    Broll.init(zoomContext());
    Pov.init(zoomContext());
    Express.init(zoomContext());
    document.addEventListener('click', function (ev) {
      var a = ev.target && ev.target.closest ? ev.target.closest('a[data-ext]') : null;
      if (!a) return;
      ev.preventDefault();
      try {
        if (window.cep && window.cep.util && window.cep.util.openURLInDefaultBrowser) window.cep.util.openURLInDefaultBrowser(a.href);
        else window.open(a.href, '_blank');
      } catch (e) {}
    });
    var obCtx = zoomContext();
    obCtx.openTool = openTool;
    window.ADOnboarding.init(obCtx);
    bindControls();
    bindWave();
    bindRipple();
    show('home');

    if (DEMO) {
      $('version').textContent = 'démonstration';
      // index.html?demo&tool ouvre Silences (&zoom : Zoom), &mode=selected
      // choisit un mode, &auto valide les sections, &cut lance l'action simulée
      var q = window.location.search;
      var obm = /[?&]onboarding(?:=(\d))?/.exec(q);
      if (obm) {
        window.ADOnboarding.open();
        if (obm[1]) window.ADOnboarding.go(Number(obm[1]) - 1);
        return;
      }
      var tool = /[?&]zoom\b/.test(q) ? 'zoom' : /[?&]broll\b/.test(q) ? 'broll' : /[?&]pov\b/.test(q) ? 'pov' : /[?&]express\b/.test(q) ? 'express' : 'silences';
      state.tool = tool;
      var m = /[?&]mode=(\w+)/.exec(q);
      if (m && MODE_NAMES[m[1]]) setSectionMode(m[1]);
      if (!/[?&](tool|auto|zoom|broll|pov|express)\b/.test(q)) return;
      state.tool = tool === 'zoom' ? 'silences' : 'zoom'; // force le changement d'outil dans openTool
      openTool(tool).then(function () {
        if (!/[?&]auto\b/.test(q)) return;
        validateSections().then(function () {
          if (!/[?&]cut\b/.test(q)) return;
          if (tool === 'zoom') Zoom.apply();
          else if (tool === 'pov') Pov.apply();
          else if (tool === 'express') Express.run();
          else if (tool === 'broll') {
            // transcrire, proposer puis placer, comme avec le bouton du bas ;
            // &cut=N s'arrete apres N etapes
            var steps = /[?&]cut=(\d)/.exec(q);
            var n = steps ? +steps[1] : 3;
            var run = function (k) {
              if (k >= n) return;
              Broll.main();
              var wait = setInterval(function () {
                if (!state.busy) {
                  clearInterval(wait);
                  run(k + 1);
                }
              }, 150);
            };
            run(0);
          } else cut();
        });
      });
      return;
    }
    if (!Host.available) {
      banner('Ce panneau s\'ouvre dans Premiere Pro : Fenêtre > Extensions > FirstCut.', 'error');
      return;
    }

    cleanTemp('');
    Host.loadJsx()
      .then(function (ping) {
        $('version').textContent = 'v' + ping.version;
        $('version').title = 'Premiere Pro ' + ping.appVersion;
        obCtx.appInfo = ping;
      })
      .catch(function (e) {
        banner(e.message, 'error');
      })
      .then(function () {
        if (window.ADOnboarding.shouldOpen()) window.ADOnboarding.open();
      });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  // exposé pour la mise au point en mode démonstration
  window.ADApp = { state: state, store: store };
})();
