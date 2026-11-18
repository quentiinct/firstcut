/* B-roll - ecran de reglages (etape 2) et pose dans Premiere.
 *
 * L'etape 1 (Sections : zone + pistes audio a transcrire) est commune et vit
 * dans app.js, qui transmet ses outils par init(ctx).
 *
 * Deroulement, pilote par le bouton orange du bas :
 *   1. Transcrire  : whisper.cpp en local, ou un fichier SRT exporte de Premiere ;
 *   2. Proposer    : choisit les moments (mots-cles, ou Claude) puis cherche
 *                    pour chacun des images dans les sources choisies ;
 *   3. Placer      : telecharge ce qu'il faut, puis Premiere pose les B-rolls.
 */
(function (global) {
  'use strict';

  var T = global.ADBrollText;
  var TPS = 254016000000;

  var DEFAULTS = {
    transcriber: 'whisper',
    whisperModel: 'base',
    lang: 'fr',
    srtPath: '',
    online: true,
    pexelsKey: '',
    types: { video: true, image: true },
    library: false,
    libraryPath: '',
    engine: 'keywords',
    claudeKey: '',
    model: 'claude-opus-5-5',
    gapMin: 6,
    gapMax: 12,
    durMin: 2,
    durMax: 4,
    track: -1,
    fill: true,
    backup: true
  };

  var ctx = null;
  var data = null; // zone validee a l'etape 1
  var transcript = null; // { segments, source }
  var library = null; // { root, items }
  var moments = null; // propositions
  var seed = 1;
  var busyCancel = false;

  function $(id) {
    return document.getElementById(id);
  }

  function S() {
    return ctx.store.broll;
  }

  function save() {
    ctx.saveSettings();
  }

  function N() {
    return ctx.N();
  }

  function node(name) {
    return ctx.Host.require(name);
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function fmtT(sec) {
    var s = Math.max(0, sec);
    var m = Math.floor(s / 60);
    var r = s - m * 60;
    return m + ':' + (r < 10 ? '0' : '') + r.toFixed(1).replace('.', ',');
  }

  function normalize(s) {
    var o = {};
    var k;
    for (k in DEFAULTS) o[k] = DEFAULTS[k];
    for (k in s || {}) if (Object.prototype.hasOwnProperty.call(DEFAULTS, k)) o[k] = s[k];
    o.types = { video: !(s && s.types && s.types.video === false), image: !(s && s.types && s.types.image === false) };
    var r = T.normalize(o);
    o.gapMin = r.gapMin;
    o.gapMax = r.gapMax;
    o.durMin = r.durMin;
    o.durMax = r.durMax;
    o.track = parseInt(o.track, 10);
    if (isNaN(o.track)) o.track = -1;
    return o;
  }

  // ---------------------------------------------------------------- réglages

  function writeControls() {
    var s = S();
    $('b-tr-engine').value = s.transcriber === 'srt' ? 'srt' : 'whisper-' + s.whisperModel;
    $('b-lang').value = s.lang;
    $('b-srt-path').value = s.srtPath;
    $('b-online').checked = s.online;
    $('b-pexels-key').value = s.pexelsKey;
    $('b-type-video').checked = s.types.video;
    $('b-type-image').checked = s.types.image;
    $('b-lib').checked = s.library;
    $('b-lib-path').value = s.libraryPath;
    $('b-claude-key').value = s.claudeKey;
    $('b-model').value = s.model;
    $('b-gmin').value = s.gapMin;
    $('b-gmax').value = s.gapMax;
    $('b-dmin').value = s.durMin;
    $('b-dmax').value = s.durMax;
    $('b-fill').checked = s.fill;
    $('b-backup').checked = s.backup;
    var radios = document.querySelectorAll('input[name="b-engine"]');
    for (var i = 0; i < radios.length; i++) radios[i].checked = radios[i].value === s.engine;
    syncVisibility();
  }

  function readControls() {
    var engine = $('b-tr-engine').value;
    var e = document.querySelector('input[name="b-engine"]:checked');
    ctx.store.broll = normalize({
      transcriber: engine === 'srt' ? 'srt' : 'whisper',
      whisperModel: engine === 'whisper-small' ? 'small' : 'base',
      lang: $('b-lang').value,
      srtPath: $('b-srt-path').value.trim(),
      online: $('b-online').checked,
      pexelsKey: $('b-pexels-key').value.trim(),
      types: { video: $('b-type-video').checked, image: $('b-type-image').checked },
      library: $('b-lib').checked,
      libraryPath: $('b-lib-path').value.trim(),
      engine: e ? e.value : 'keywords',
      claudeKey: $('b-claude-key').value.trim(),
      model: $('b-model').value,
      gapMin: $('b-gmin').value,
      gapMax: $('b-gmax').value,
      durMin: $('b-dmin').value,
      durMax: $('b-dmax').value,
      track: $('b-track').value,
      fill: $('b-fill').checked,
      backup: $('b-backup').checked
    });
  }

  function syncVisibility() {
    var s = S();
    $('b-srt-row').classList.toggle('hidden', s.transcriber !== 'srt');
    $('b-lang-row').classList.toggle('hidden', s.transcriber === 'srt');
    $('b-online-opts').classList.toggle('off', !s.online);
    $('b-lib-opts').classList.toggle('off', !s.library);
    $('b-ai-opts').classList.toggle('hidden', s.engine !== 'ai');
    $('b-online-help').textContent = s.pexelsKey
      ? 'Vidéos et photos Pexels, libres d\'usage.'
      : 'Sans clé Pexels : photos libres Openverse (Creative Commons, crédits enregistrés à côté des fichiers). Avec une clé gratuite : vidéos et photos Pexels.';
  }

  function onChange(relist) {
    readControls();
    save();
    syncVisibility();
    if (relist) renderTracksSelect();
    ctx.updateUi();
  }

  // ---------------------------------------------------------- destination

  /** Pistes video et clips deja presents aux moments proposes. */
  function trackConflicts(index) {
    if (!moments || !ctx.state.layout || !ctx.state.layout.video) return 0;
    var spans = null;
    ctx.state.layout.video.forEach(function (v) {
      if (v.index === index) spans = v.spans;
    });
    if (!spans) return 0;
    var n = 0;
    moments.forEach(function (m) {
      if (m.removed) return;
      var a = m.a * TPS;
      var b = m.b * TPS;
      if (spans.some(function (s) { return s[0] < b && s[1] > a; })) n++;
    });
    return n;
  }

  function autoTrack() {
    var info = ctx.state.info;
    if (!info) return 1;
    var vids = info.video.filter(function (t) {
      return !t.locked;
    });
    for (var i = 0; i < vids.length; i++) {
      if (vids[i].index >= 1 && trackConflicts(vids[i].index) === 0) return vids[i].index;
    }
    return vids.length ? vids[vids.length - 1].index : 0;
  }

  function destTrack() {
    var t = S().track;
    var info = ctx.state.info;
    if (t >= 0 && info && info.video.some(function (v) { return v.index === t && !v.locked; })) return t;
    return autoTrack();
  }

  function renderTracksSelect() {
    var sel = $('b-track');
    var info = ctx.state.info;
    var keep = S().track;
    sel.innerHTML = '';
    var auto = document.createElement('option');
    auto.value = '-1';
    auto.textContent = 'Automatique (V' + (autoTrack() + 1) + ')';
    sel.appendChild(auto);
    (info ? info.video : []).forEach(function (v) {
      var o = document.createElement('option');
      o.value = String(v.index);
      var c = trackConflicts(v.index);
      o.textContent = 'V' + (v.index + 1) + (v.locked ? ' (verrouillée)' : c ? ' (' + c + ' chevauchement' + (c > 1 ? 's' : '') + ')' : v.clips ? '' : ' (vide)');
      o.disabled = v.locked;
      sel.appendChild(o);
    });
    sel.value = String(keep);
    if (sel.value !== String(keep)) sel.value = '-1';
    var d = destTrack();
    var conflicts = trackConflicts(d);
    $('b-track-help').textContent = conflicts
      ? 'Attention : V' + (d + 1) + ' a déjà des clips à ' + conflicts + ' de ces moments ; ils seront recouverts à ces endroits.'
      : 'Les B-rolls sont posés sur V' + (d + 1) + ', au-dessus de ton image.';
    $('b-track-help').classList.toggle('warn', conflicts > 0);
  }

  // ---------------------------------------------------------- transcription

  function cacheDir(sub) {
    var dir = N().path.join(ctx.dataDir(), sub);
    N().fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  function transcriptKey() {
    var s = S();
    return [data.seqId, data.fingerprint, data.tracks.join(','), data.range.startFrame, data.range.endFrame,
      s.transcriber === 'srt' ? 'srt:' + s.srtPath : 'whisper:' + s.whisperModel + ':' + s.lang].join('|');
  }

  function loadCachedTranscript() {
    if (ctx.DEMO) return null;
    try {
      var f = N().path.join(cacheDir('transcriptions'), global.ADBrollLib.hash(transcriptKey()) + '.json');
      if (N().fs.existsSync(f)) return JSON.parse(N().fs.readFileSync(f, 'utf8'));
    } catch (e) {}
    return null;
  }

  function saveTranscript(t) {
    if (ctx.DEMO) return;
    try {
      var f = N().path.join(cacheDir('transcriptions'), global.ADBrollLib.hash(transcriptKey()) + '.json');
      N().fs.writeFileSync(f, JSON.stringify(t));
    } catch (e) {}
  }

  /** Audio de la zone, exporte par Premiere puis ramene en mono 16 kHz. */
  function exportZoneWav() {
    var info = ctx.state.info;
    var f = data.f;
    var preset = ctx.findWavPreset(info.appPath, info.appVersion);
    if (!preset) throw new Error('Préconfiguration d\'export WAV de Premiere introuvable.');
    var dir = ctx.tempDir();
    var stamp = Date.now();
    var wav = N().path.join(dir, 'analyse-' + stamp + '.wav');
    var wav16 = N().path.join(dir, 'analyse-' + stamp + '-16k.wav');
    ctx.cleanTemp('');
    ctx.setProgress(null, 'Premiere exporte l\'audio… (la fenêtre peut se figer quelques instants)');
    return ctx.call('ADR_exportAudio', [wav, preset, data.zoneExport ? '1' : '0', data.tracks.join(',')]).then(function (r) {
      if (!r.ok) throw new Error(r.error || 'L\'export audio a échoué.');
      var offset = data.zoneExport ? 0 : data.range.startFrame / f.fps;
      var dur = (data.range.endFrame - data.range.startFrame) / f.fps;
      ctx.setProgress(0, 'Préparation de l\'audio…');
      return global.ADWav.to16kMono(wav, wav16, offset, dur, function (x) {
        ctx.setProgress(x, 'Préparation de l\'audio… ' + Math.round(x * 100) + ' %');
      }).then(function () {
        try {
          N().fs.unlinkSync(wav);
        } catch (e) {}
        return wav16;
      });
    });
  }

  function transcribe() {
    if (ctx.state.busy || !data) return Promise.resolve();
    var s = S();
    var W = global.ADWhisper;
    ctx.setBusy(true);
    ctx.banner('');
    showResult();
    busyCancel = false;
    var start = data.range.startFrame / data.f.fps;
    var sections = data.sectionsSec;
    var job;

    if (ctx.DEMO) {
      job = Promise.resolve(global.ADDemo.brollTranscript(sections));
    } else if (s.transcriber === 'srt') {
      job = Promise.resolve().then(function () {
        if (!s.srtPath) throw new Error('Choisis le fichier SRT exporté de Premiere (Texte > Transcription > Exporter).');
        if (!N().fs.existsSync(s.srtPath)) throw new Error('Fichier introuvable : ' + s.srtPath);
        var segs = T.parseSrt(N().fs.readFileSync(s.srtPath, 'utf8'));
        if (!segs.length) throw new Error('Aucune réplique lisible dans ce fichier SRT.');
        return { segments: T.inSections(segs, sections), source: 'SRT · ' + N().path.basename(s.srtPath) };
      });
    } else {
      if (!W.supported()) {
        ctx.setBusy(false);
        ctx.banner('La transcription automatique n\'est disponible que sous Windows : utilise un fichier SRT.', 'error');
        return Promise.resolve();
      }
      var base = ctx.dataDir();
      var ready = W.isInstalled(base, s.whisperModel)
        ? Promise.resolve(true)
        : ctx.ask({
            title: 'Installer la transcription',
            text: 'Premier usage : FirstCut va télécharger whisper.cpp (' + W.VERSION + ', 8 Mo) et le modèle ' +
              W.MODELS[s.whisperModel].label + ' depuis leurs sites officiels.\n\nEnsuite, tout se fait hors ligne : ton audio ne quitte pas ton ordinateur.',
            ok: 'Télécharger'
          }).then(function (go) {
            if (!go) throw new Error('');
            return W.install(base, s.whisperModel, global.ADBrollSrc.download, function (f, label) {
              ctx.setProgress(f, label);
            });
          });
      job = ready
        .then(function () {
          return exportZoneWav();
        })
        .then(function (wav16) {
          ctx.setProgress(0, 'Transcription… 0 %');
          $('btn-cancel').classList.remove('hidden');
          return W.transcribe(base, s.whisperModel, wav16, s.lang, function (f) {
            ctx.setProgress(f, 'Transcription… ' + Math.round(f * 100) + ' %');
          }, function () {
            return ctx.state.cancel;
          });
        })
        .then(function (json) {
          var segs = T.shift(T.parseWhisperJson(json), start);
          return { segments: T.inSections(segs, sections), source: 'whisper ' + W.MODELS[s.whisperModel].label.split(' ')[0].toLowerCase() };
        });
    }

    ctx.state.cancel = false;
    return job
      .then(function (t) {
        if (!t.segments.length) throw new Error('Aucune parole trouvée dans la zone choisie.');
        transcript = t;
        saveTranscript(t);
        moments = null;
        renderTranscript();
        renderMoments();
        ctx.log('Transcription : ' + t.segments.length + ' phrases (' + t.source + ').');
      })
      .catch(function (e) {
        if (e && e.message) {
          ctx.banner(e.message, 'error');
          ctx.log('Transcription impossible : ' + e.message);
        }
      })
      .then(function () {
        ctx.hideProgress();
        ctx.setBusy(false);
      });
  }

  function renderTranscript() {
    var box = $('b-tr-list');
    var st = $('b-tr-status');
    box.innerHTML = '';
    if (!transcript) {
      st.textContent = data ? 'Pas encore transcrit.' : '';
      $('b-tr-view').classList.add('hidden');
      return;
    }
    var words = 0;
    transcript.segments.forEach(function (s) {
      words += s.text.split(/\s+/).length;
    });
    st.textContent = transcript.segments.length + ' phrases · ' + words + ' mots · ' + transcript.source;
    $('b-tr-view').classList.remove('hidden');
    transcript.segments.slice(0, 400).forEach(function (s) {
      var row = document.createElement('div');
      row.className = 'b-line';
      row.innerHTML = '<span class="t">' + fmtT(s.a) + '</span><span>' + esc(s.text) + '</span>';
      box.appendChild(row);
    });
  }

  // -------------------------------------------------------------- dossier

  function indexLibrary() {
    var s = S();
    if (ctx.state.busy) return Promise.resolve();
    if (ctx.DEMO) {
      library = global.ADDemo.brollLibrary();
      renderLibraryStatus();
      return Promise.resolve();
    }
    var L = global.ADBrollLib;
    if (!s.libraryPath || !N().fs.existsSync(s.libraryPath)) {
      ctx.banner('Choisis d\'abord un dossier de vidéos existant.', 'error');
      return Promise.resolve();
    }
    var ffmpeg = L.findFfmpeg(ctx.store.ffmpegPath);
    if (!ffmpeg) {
      ctx.banner('ffmpeg est introuvable : il sert à lire tes vidéos. Installe-le (winget install ffmpeg) puis réessaie.', 'error');
      return Promise.resolve();
    }
    var describe = null;
    if (s.engine === 'ai' && s.claudeKey) {
      describe = function (item) {
        return global.ADBrollAI.describeClip(aiOpts(), { name: item.rel, frames: item.frames });
      };
    }
    ctx.setBusy(true);
    ctx.state.cancel = false;
    $('btn-cancel').classList.remove('hidden');
    return L.index(s.libraryPath, {
      ffmpeg: ffmpeg,
      cacheDir: cacheDir('bibliotheques'),
      describe: describe,
      shouldStop: function () {
        return ctx.state.cancel;
      },
      onProgress: function (done, total, label) {
        ctx.setProgress(total ? done / total : null, (describe ? 'Analyse et description' : 'Analyse') + ' des vidéos · ' + done + ' / ' + total + ' · ' + label);
      }
    })
      .then(function (r) {
        library = r;
        renderLibraryStatus();
        if (r.errors.length) ctx.log(['Dossier : ' + r.errors.length + ' vidéo(s) ignorée(s)'].concat(r.errors.slice(0, 10)));
        if (moments) renderMoments();
      })
      .catch(function (e) {
        ctx.banner('Analyse du dossier impossible : ' + e.message, 'error');
      })
      .then(function () {
        ctx.hideProgress();
        ctx.setBusy(false);
      });
  }

  function loadLibraryFromCache() {
    var s = S();
    library = null;
    if (ctx.DEMO || !s.libraryPath) return renderLibraryStatus();
    try {
      var idx = global.ADBrollLib.loadIndex(cacheDir('bibliotheques'), s.libraryPath);
      if (idx.items.length) library = idx;
    } catch (e) {}
    renderLibraryStatus();
  }

  function renderLibraryStatus() {
    var el = $('b-lib-status');
    if (!library) {
      el.textContent = S().libraryPath ? 'Dossier pas encore analysé.' : 'Aucun dossier choisi.';
      return;
    }
    var described = library.items.filter(function (i) {
      return i.summary;
    }).length;
    el.textContent = library.items.length + ' vidéo' + (library.items.length > 1 ? 's' : '') + ' prête' + (library.items.length > 1 ? 's' : '') +
      (described ? ' · ' + described + ' décrite' + (described > 1 ? 's' : '') + ' par l\'IA' : ' · choix d\'après les noms de fichiers' + (S().engine === 'ai' ? ' (relance l\'analyse pour les faire décrire par l\'IA)' : ''));
  }

  // ---------------------------------------------------------- propositions

  function aiOpts() {
    var s = S();
    return { apiKey: s.claudeKey, model: s.model, extensionDir: ctx.Host.extensionPath() };
  }

  function libraryOn() {
    return S().library && library && library.items.length;
  }

  /** Candidats d'un moment : videos du dossier d'abord, puis la banque en ligne. */
  function candidatesFor(m) {
    var s = S();
    var len = m.b - m.a;
    var out = [];
    if (libraryOn()) {
      var picks = [];
      if (m.library) {
        library.items.forEach(function (it) {
          if (it.id === m.library.id) picks.push({ item: it, t: m.library.t });
        });
      }
      T.rankLibrary(m, library.items, len).slice(0, 4).forEach(function (r) {
        if (!picks.some(function (p) { return p.item.id === r.item.id; })) picks.push(r);
      });
      var r = T.rng(Math.round(m.a * 1000) + seed);
      picks.forEach(function (p) {
        if (p.item.duration < len) return;
        var srcIn = T.passage(p.item.duration, len, p.t, r());
        var mid = srcIn + len / 2;
        var frame = null;
        (p.item.frames || []).forEach(function (f) {
          if (!frame || Math.abs(f.t - mid) < Math.abs(frame.t - mid)) frame = f;
        });
        out.push({
          id: p.item.id + '@' + srcIn,
          provider: 'library',
          kind: 'video',
          thumb: frame ? 'file:///' + frame.jpg.split('\\').join('/') : '',
          path: p.item.path,
          srcIn: srcIn,
          w: p.item.w,
          h: p.item.h,
          duration: p.item.duration,
          credit: p.item.rel,
          caption: (frame && frame.caption) || p.item.summary || ''
        });
      });
    }
    if (!s.online || !m.query || !(s.types.video || s.types.image)) return Promise.resolve(out);
    if (ctx.DEMO) return Promise.resolve(out.concat(global.ADDemo.brollCandidates(m)));
    var info = ctx.state.projectInfo || {};
    return global.ADBrollSrc.search(m.query, {
      pexelsKey: s.pexelsKey,
      types: s.types,
      count: 6,
      minDuration: Math.ceil(len),
      targetH: info.frameH || 1080,
      orientation: (info.frameH || 1080) > (info.frameW || 1920) ? 'portrait' : 'landscape'
    }).then(
      function (list) {
        return out.concat(list);
      },
      function (e) {
        m.error = e.message;
        return out;
      }
    );
  }

  function mapLimit(items, limit, worker, onDone) {
    return new Promise(function (resolve) {
      var next = 0;
      var done = 0;
      if (!items.length) return resolve();
      function launch() {
        if (next >= items.length) return;
        var i = next++;
        Promise.resolve(worker(items[i], i)).then(function () {
          done++;
          if (onDone) onDone(done, items.length);
          if (done === items.length) resolve();
          else launch();
        });
      }
      for (var k = 0; k < Math.min(limit, items.length); k++) launch();
    });
  }

  function generate() {
    if (ctx.state.busy || !transcript) return Promise.resolve();
    var s = S();
    if (!s.online && !libraryOn()) {
      ctx.banner('Active au moins une source : la banque en ligne ou ton dossier de vidéos (analysé).', 'error');
      return Promise.resolve();
    }
    if (s.engine === 'ai' && !s.claudeKey && !ctx.DEMO) {
      ctx.banner('Le choix par IA demande une clé API Claude (console.anthropic.com).', 'error');
      return Promise.resolve();
    }
    ctx.setBusy(true);
    ctx.banner('');
    showResult();
    seed = (Math.floor(Math.random() * 1e9) ^ Date.now()) >>> 0;
    var params = { gapMin: s.gapMin, gapMax: s.gapMax, durMin: s.durMin, durMax: s.durMax };
    var info0 = ctx.DEMO ? Promise.resolve({ ok: true, frameW: 1920, frameH: 1080, projectPath: '' }) : ctx.call('ADB_projectInfo');
    var plan;
    return info0
      .then(function (pi) {
        ctx.state.projectInfo = pi.ok ? pi : {};
        if (s.engine === 'ai' && !ctx.DEMO) {
          ctx.setProgress(null, 'Claude lit la transcription et choisit les moments…');
          return global.ADBrollAI.planMoments(aiOpts(), {
            segments: transcript.segments,
            sections: data.sectionsSec,
            params: params,
            library: libraryOn() ? library.items : null
          }).then(function (r) {
            ctx.log('Claude (' + s.model + ') : ' + r.moments.length + ' moments · ' +
              (r.usage ? r.usage.input_tokens + ' jetons lus, ' + r.usage.output_tokens + ' écrits' : ''));
            return r.moments;
          });
        }
        return T.planMoments(transcript.segments, data.sectionsSec, params, seed);
      })
      .then(function (list) {
        plan = list.map(function (m) {
          if (!m.keys || !m.keys.length) {
            m.keys = T.keywords(m.text || '', T.idf(transcript.segments), 3).map(function (k) {
              return k.key;
            });
          }
          m.cands = [];
          m.pick = 0;
          m.removed = false;
          return m;
        });
        if (!plan.length) throw new Error('Aucun moment à illustrer trouvé : élargis la zone ou réduis l\'écart entre deux B-rolls.');
        ctx.setProgress(0, 'Recherche des images… 0 / ' + plan.length);
        return mapLimit(plan, 3, function (m) {
          return candidatesFor(m).then(function (c) {
            m.cands = c;
          });
        }, function (done, total) {
          ctx.setProgress(done / total, 'Recherche des images… ' + done + ' / ' + total);
        });
      })
      .then(function () {
        moments = plan;
        var empty = moments.filter(function (m) {
          return !m.cands.length;
        }).length;
        var errs = moments.filter(function (m) {
          return m.error;
        });
        if (errs.length) ctx.banner('Recherche en ligne : ' + errs[0].error, 'error');
        else if (empty) ctx.banner(empty + ' moment' + (empty > 1 ? 's' : '') + ' sans image trouvée : ' + (empty > 1 ? 'ils seront ignorés' : 'il sera ignoré') + '.');
        renderMoments(true);
        renderTracksSelect();
      })
      .catch(function (e) {
        if (e && e.message) {
          ctx.banner(e.message, 'error');
          ctx.log('Propositions impossibles : ' + e.message);
        }
      })
      .then(function () {
        ctx.hideProgress();
        ctx.setBusy(false);
      });
  }

  function activeMoments() {
    return (moments || []).filter(function (m) {
      return !m.removed && m.cands.length;
    });
  }

  var BADGE = { library: 'Mon dossier', pexels: 'Pexels', openverse: 'Openverse' };

  function renderMoments(appear) {
    var box = $('b-list');
    box.innerHTML = '';
    var stats = $('b-stats');
    stats.innerHTML = '';
    if (!moments) {
      var empty = document.createElement('div');
      empty.className = 'z-empty';
      empty.textContent = transcript ? 'Prêt : lance « Proposer des B-rolls ».' : 'Transcris d\'abord l\'audio de la zone.';
      box.appendChild(empty);
      ctx.updateUi();
      return;
    }
    var act = activeMoments();
    var secs = 0;
    act.forEach(function (m) {
      secs += m.b - m.a;
    });
    var fromLib = act.filter(function (m) {
      return m.cands[m.pick].provider === 'library';
    }).length;
    [[String(act.length), 'B-rolls retenus'], [String(Math.round(secs)) + ' s', 'd\'illustrations'], [String(fromLib), 'de ton dossier']].forEach(function (it) {
      var d = document.createElement('div');
      d.className = 'stat';
      d.innerHTML = '<b class="bump">' + esc(it[0]) + '</b><span>' + esc(it[1]) + '</span>';
      stats.appendChild(d);
    });

    moments.forEach(function (m, i) {
      var c = m.cands[m.pick];
      var row = document.createElement('div');
      row.className = 'b-card' + (m.removed ? ' removed' : '') + (!c ? ' none' : '') + (appear ? ' appear' : '');
      row.style.setProperty('--i', String(Math.min(i, 12)));
      var thumb = document.createElement('div');
      thumb.className = 'b-thumb';
      if (c && c.thumb) {
        var img = document.createElement('img');
        img.src = c.thumb;
        img.loading = 'lazy';
        img.alt = '';
        img.onerror = function () {
          thumb.classList.add('broken');
        };
        thumb.appendChild(img);
      }
      if (c) {
        var tag = document.createElement('span');
        tag.className = 'b-kind ' + c.kind;
        tag.textContent = c.kind === 'video' ? '▶' : '▣';
        thumb.appendChild(tag);
      }
      var body = document.createElement('div');
      body.className = 'b-body';
      var phrase = esc(m.text || '');
      (m.keys || []).forEach(function (k) {
        phrase = phrase.replace(new RegExp('(^|[^\\w\\u00c0-\\u017f])([\\w\\u00c0-\\u017f]*' + k.replace(/[^a-z0-9]/g, '').slice(0, 5) + '[\\w\\u00c0-\\u017f]*)', 'i'), '$1<mark>$2</mark>');
      });
      body.innerHTML =
        '<div class="b-top"><span class="b-time">' + fmtT(m.a) + ' → ' + fmtT(m.b) + '</span>' +
        (c ? '<span class="b-src ' + c.provider + '">' + BADGE[c.provider] + '</span>' : '<span class="b-src none">rien trouvé</span>') +
        '</div><div class="b-phrase">« ' + phrase + ' »</div>' +
        '<div class="b-query">' + (m.query ? 'recherche : ' + esc(m.query) : '') +
        (c && m.cands.length > 1 ? ' · ' + (m.pick + 1) + ' / ' + m.cands.length : '') + '</div>';
      if (c) thumb.title = (c.caption ? c.caption + '\n' : '') + c.credit + (c.license ? ' · ' + c.license : '');
      var tools = document.createElement('div');
      tools.className = 'b-tools';
      var next = document.createElement('button');
      next.className = 'btn mini';
      next.title = 'Autre proposition';
      next.textContent = '↻';
      next.disabled = m.cands.length < 2 || m.removed;
      next.addEventListener('click', function () {
        m.pick = (m.pick + 1) % m.cands.length;
        renderMoments();
      });
      var del = document.createElement('button');
      del.className = 'btn mini';
      del.title = m.removed ? 'Remettre ce B-roll' : 'Retirer ce B-roll';
      del.textContent = m.removed ? '↩' : '✕';
      del.addEventListener('click', function () {
        m.removed = !m.removed;
        renderMoments();
        renderTracksSelect();
      });
      var go = document.createElement('button');
      go.className = 'btn mini';
      go.title = 'Placer la tête de lecture de Premiere ici';
      go.textContent = '⌖';
      go.addEventListener('click', function () {
        ctx.call('ADR_setPlayhead', [String(Math.round(m.a * TPS))]).catch(function () {});
      });
      tools.appendChild(next);
      tools.appendChild(del);
      tools.appendChild(go);
      row.appendChild(thumb);
      row.appendChild(body);
      row.appendChild(tools);
      box.appendChild(row);
    });
    ctx.updateUi();
  }

  // ------------------------------------------------------------------ pose

  function mediaDir() {
    var pi = ctx.state.projectInfo || {};
    var base = pi.projectPath ? N().path.dirname(pi.projectPath) : N().path.join(N().os.homedir(), 'Documents');
    return N().path.join(base, 'FirstCut B-roll');
  }

  function showResult(kind, text) {
    var el = $('b-result');
    if (!text) {
      el.className = 'result hidden';
      el.textContent = '';
      return;
    }
    el.className = 'result ' + kind;
    el.textContent = text;
  }

  function place() {
    var act = activeMoments();
    if (ctx.state.busy || !act.length) return Promise.resolve();
    var s = S();
    var track = destTrack();
    var tb = data.timebase;
    var dir = ctx.DEMO ? '' : mediaDir();
    var lines = [];
    var credits = [];
    var planPath = '';
    var started = false;
    ctx.setBusy(true);
    ctx.state.cancel = false;
    ctx.banner('');
    showResult();

    var conflicts = trackConflicts(track);
    var confirm = conflicts
      ? ctx.ask({
          title: 'Piste déjà occupée',
          text: 'V' + (track + 1) + ' contient déjà des clips à ' + conflicts + ' des moments choisis : ils seront recouverts par les B-rolls à ces endroits.\n\nChoisis une autre piste de destination pour éviter ça.',
          ok: 'Placer quand même'
        })
      : Promise.resolve(true);

    return confirm
      .then(function (go) {
        if (!go) throw new Error('');
        return ctx.refresh(false);
      })
      .then(function (ok) {
        if (!ok) throw new Error('');
        var info = ctx.state.info;
        if (info.sequence.id !== data.seqId || info.sequence.fingerprint !== data.fingerprint) {
          throw new Error('La timeline a changé depuis la transcription : valide à nouveau les sections.');
        }
        // telechargement de ce qui vient d'internet
        var k = 0;
        return mapLimit(act, 3, function (m) {
          var c = m.cands[m.pick];
          if (c.provider === 'library' || ctx.DEMO) {
            m.file = c.path || 'demo';
            return null;
          }
          var dest = N().path.join(dir, c.id + '.' + (c.ext || (c.kind === 'video' ? 'mp4' : 'jpg')));
          return global.ADBrollSrc.download(c.url, dest).then(
            function (f) {
              m.file = f;
              credits.push(N().path.basename(f) + ' : ' + c.credit + (c.license ? ' (' + c.license + ')' : '') + (c.page ? ' - ' + c.page : ''));
            },
            function (e) {
              m.file = null;
              ctx.log('Téléchargement impossible (' + c.id + ') : ' + e.message);
            }
          );
        }, function (done, total) {
          k = done;
          ctx.setProgress(done / total, 'Téléchargement des médias… ' + done + ' / ' + total);
        });
      })
      .then(function () {
        act.forEach(function (m) {
          if (!m.file) return;
          var c = m.cands[m.pick];
          var startF = Math.round(m.a * data.f.fps);
          var durF = Math.max(1, Math.round((m.b - m.a) * data.f.fps));
          var srcIn = c.provider === 'library' ? c.srcIn : c.kind === 'video' ? Math.max(0, Math.min(1, ((c.duration || 0) - (m.b - m.a)) / 2)) : 0;
          lines.push(['B', track, startF * tb, durF * tb, Math.round(srcIn * 1000) / 1000, c.kind === 'video' ? 'v' : 'i',
            c.w || 0, c.h || 0, m.file].join(' '));
        });
        if (!lines.length) throw new Error('Aucun média n\'a pu être récupéré.');
        if (credits.length && !ctx.DEMO) {
          try {
            N().fs.mkdirSync(dir, { recursive: true });
            N().fs.appendFileSync(N().path.join(dir, 'credits-broll.txt'), credits.join('\r\n') + '\r\n', 'utf8');
          } catch (e) {}
        }
        var now = new Date();
        var head = ['version=1', 'sequenceId=' + data.seqId, 'backup=' + (s.backup ? '1' : '0'),
          'backupName=' + data.seqName + ' - avant B-roll ' + now.getHours() + 'h' + ctx.p2(now.getMinutes()),
          'fill=' + (s.fill ? '1' : '0')];
        if (!ctx.DEMO) {
          planPath = N().path.join(ctx.tempDir(), 'plan-broll-' + Date.now() + '.txt');
          N().fs.writeFileSync(planPath, head.concat(lines).join('\n') + '\n', 'utf8');
        }
        ctx.setProgress(null, s.backup ? 'Sauvegarde de la séquence…' : 'Import dans Premiere…');
        return ctx.call('ADB_begin', [planPath]);
      })
      .then(function (begin) {
        if (!begin.ok) throw new Error(begin.error || 'Préparation impossible.');
        started = true;
        $('btn-cancel').classList.remove('hidden');
        var loop = function () {
          if (ctx.state.cancel) return ctx.call('ADB_cancel');
          return ctx.call('ADB_step', ['250']).then(function (st) {
            if (!st.ok) return ctx.call('ADB_cancel');
            ctx.setProgress(st.total ? st.done / st.total : null, 'Pose des B-rolls · ' + st.done + ' / ' + st.total);
            if (st.finished) return ctx.call('ADB_finish');
            return new Promise(function (r) {
              setTimeout(r, 10);
            }).then(loop);
          });
        };
        return loop();
      })
      .then(function (fin) {
        var backup = fin.backupName ? '\nSauvegarde intacte dans le projet : « ' + fin.backupName + ' ».' : '';
        var where = '\nMédias : ' + (ctx.DEMO ? 'dossier du projet' : dir) + (credits.length ? ' (crédits dans credits-broll.txt)' : '');
        var kind = fin.code === 'CANCELLED' ? 'error' : fin.failed ? 'warn' : 'ok';
        var text = fin.code === 'CANCELLED'
          ? 'Interrompu : ' + fin.applied + ' B-roll(s) déjà posé(s). Annule dans Premiere (Ctrl+Z) ou repars de la sauvegarde.'
          : (fin.failed ? fin.applied + ' B-roll(s) posé(s) sur ' + fin.total + ' · ' + fin.failed + ' échec(s)\n' + (fin.notes || []).slice(0, 4).join('\n')
            : 'Terminé. ' + fin.applied + ' B-roll' + (fin.applied > 1 ? 's posés' : ' posé') + ' sur V' + (track + 1) + '.');
        showResult(kind, text + where + backup);
        var file = ctx.writeLogFile(fin.log || []);
        ctx.log((fin.log || []).concat(file ? ['journal : ' + file] : []));
        if (kind !== 'ok') $('log-card').open = true;
      })
      .catch(function (e) {
        if (e && e.message) {
          showResult('error', e.message + (started ? '' : '\nRien n\'a été posé.'));
          ctx.log('B-roll impossible : ' + e.message);
        }
      })
      .then(function () {
        ctx.hideProgress();
        if (planPath) {
          try {
            N().fs.unlinkSync(planPath);
          } catch (e) {}
        }
        if (started) {
          moments = null;
          data = null;
          transcript = null;
          renderAll();
        }
        ctx.setBusy(false);
        window.scrollTo(0, 0);
        return ctx.refresh(true);
      });
  }

  // ------------------------------------------------------------------ étapes

  /** Etape 1 -> 2 : fige la zone, reprend une transcription deja faite si possible. */
  function validate(sections, mode, tracks) {
    ctx.banner('');
    showResult();
    return ctx.refresh(false).then(function (ok) {
      if (!ok) return;
      var info = ctx.state.info;
      var f = ctx.seqFrame(info);
      var range = { startFrame: sections[0].startFrame, endFrame: sections[sections.length - 1].endFrame };
      data = {
        seqId: info.sequence.id,
        seqName: info.sequence.name,
        fingerprint: info.sequence.fingerprint,
        timebase: info.sequence.timebase,
        f: f,
        mode: mode,
        tracks: tracks,
        range: range,
        sectionsSec: sections.map(function (s) {
          return [s.startFrame / f.fps, s.endFrame / f.fps];
        }),
        zoneExport: mode === 'inout' && range.startFrame === f.inFrame && range.endFrame === f.outFrame && (f.inValid || f.outValid)
      };
      transcript = loadCachedTranscript();
      moments = null;
      loadLibraryFromCache();
      ctx.show('tool', 2);
      renderAll();
      if (transcript) ctx.log('Transcription reprise du cache : ' + transcript.segments.length + ' phrases.');
    });
  }

  function renderAll() {
    renderTranscript();
    renderLibraryStatus();
    renderTracksSelect();
    renderMoments();
  }

  function footer() {
    var busy = ctx.state.busy;
    var s = S();
    if (!data) return { text: 'Revenir aux sections', disabled: busy, msg: '' };
    if (!transcript) {
      return { text: s.transcriber === 'srt' ? 'Lire le fichier SRT' : 'Transcrire l\'audio', disabled: busy, msg: '' };
    }
    if (!moments) {
      var noSource = !s.online && !libraryOn();
      return {
        text: 'Proposer des B-rolls',
        disabled: busy || noSource,
        msg: !busy && noSource ? 'Active une source d\'images' : ''
      };
    }
    var n = activeMoments().length;
    return { text: n ? 'Placer ' + n + ' B-roll' + (n > 1 ? 's' : '') : 'Placer les B-rolls', disabled: busy || !n, msg: !busy && !n ? 'Aucun B-roll retenu' : '' };
  }

  function main() {
    if (!data) return false;
    if (!transcript) transcribe();
    else if (!moments) generate();
    else place();
    return true;
  }

  function isStale(info) {
    return !!data && (data.seqId !== info.sequence.id || data.fingerprint !== info.sequence.fingerprint);
  }

  function drop(message) {
    data = null;
    transcript = null;
    moments = null;
    renderAll();
    if (message) {
      ctx.banner(message);
      if (ctx.state.screen === 'tool' && ctx.state.tool === 'broll' && ctx.state.step === 2) ctx.show('tool', 1);
    }
    ctx.updateUi();
  }

  function browse(title, folder, types) {
    try {
      var fsapi = global.cep && global.cep.fs;
      if (!fsapi || !fsapi.showOpenDialog) return null;
      var r = fsapi.showOpenDialog(false, folder, title, '', types || []);
      if (!r || r.err !== 0 || !r.data || !r.data.length) return null;
      return String(r.data[0]);
    } catch (e) {
      return null;
    }
  }

  function bind() {
    ['b-tr-engine', 'b-lang', 'b-online', 'b-type-video', 'b-type-image', 'b-lib', 'b-model', 'b-fill', 'b-backup', 'b-track'].forEach(function (id) {
      $(id).addEventListener('change', function () {
        onChange(id === 'b-track');
        if (id === 'b-tr-engine' || id === 'b-lang') {
          if (data) {
            transcript = loadCachedTranscript();
            moments = null;
            renderAll();
          }
        }
        if (id === 'b-lib' && $('b-lib').checked && !library) loadLibraryFromCache();
      });
    });
    ['b-srt-path', 'b-pexels-key', 'b-lib-path', 'b-claude-key', 'b-gmin', 'b-gmax', 'b-dmin', 'b-dmax'].forEach(function (id) {
      $(id).addEventListener('change', function () {
        onChange(false);
        writeControls();
        if (id === 'b-lib-path') loadLibraryFromCache();
      });
    });
    var radios = document.querySelectorAll('input[name="b-engine"]');
    for (var i = 0; i < radios.length; i++) {
      radios[i].addEventListener('change', function () {
        onChange(false);
        renderLibraryStatus();
      });
    }
    $('b-srt-browse').addEventListener('click', function () {
      var p = browse('Fichier SRT exporté de Premiere', false, ['srt', 'vtt']);
      if (p) {
        $('b-srt-path').value = p;
        onChange(false);
      }
    });
    $('b-lib-browse').addEventListener('click', function () {
      var p = browse('Dossier de vidéos pour les B-rolls', true);
      if (p) {
        $('b-lib-path').value = p;
        $('b-lib').checked = true;
        onChange(false);
        loadLibraryFromCache();
      }
    });
    $('b-lib-index').addEventListener('click', indexLibrary);
    $('b-transcribe').addEventListener('click', function () {
      transcript = null;
      moments = null;
      renderAll();
      transcribe();
    });
    $('b-generate').addEventListener('click', generate);
    $('b-key-link').addEventListener('click', function (e) {
      e.preventDefault();
      openUrl('https://www.pexels.com/api/');
    });
    $('b-claude-link').addEventListener('click', function (e) {
      e.preventDefault();
      openUrl('https://console.anthropic.com/settings/keys');
    });
  }

  function openUrl(url) {
    try {
      if (global.cep && global.cep.util && global.cep.util.openURLInDefaultBrowser) global.cep.util.openURLInDefaultBrowser(url);
      else window.open(url, '_blank');
    } catch (e) {}
  }

  function init(c) {
    ctx = c;
    ctx.store.broll = normalize(ctx.store.broll);
    var sel = $('b-model');
    global.ADBrollAI.MODELS.forEach(function (m) {
      var o = document.createElement('option');
      o.value = m.id;
      o.textContent = m.label;
      sel.appendChild(o);
    });
    writeControls();
    bind();
    renderAll();
  }

  global.ADBroll = {
    DEFAULTS: DEFAULTS,
    init: init,
    validate: validate,
    main: main,
    footer: footer,
    isStale: isStale,
    drop: drop,
    hasData: function () {
      return !!data;
    },
    showResult: showResult,
    redraw: renderTracksSelect,
    reload: function () {
      ctx.store.broll = normalize(ctx.store.broll);
      writeControls();
    }
  };
})(window);
