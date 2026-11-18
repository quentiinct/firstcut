/* B-roll - transcription locale avec whisper.cpp.
 *
 * Au premier usage, le panneau telecharge whisper.cpp (version figee, depuis
 * les publications officielles du projet) et un modele de langue, dans
 * %APPDATA%\FirstCut\whisper. Ensuite tout se passe hors ligne : l'audio ne
 * quitte pas l'ordinateur.
 */
(function (root, factory) {
  var mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  if (root) root.ADWhisper = mod;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  var VERSION = 'v1.9.2';
  var BIN_URL = 'https://github.com/ggml-org/whisper.cpp/releases/download/' + VERSION + '/whisper-bin-x64.zip';
  var MODEL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/';

  var MODELS = {
    base: { file: 'ggml-base.bin', mb: 148, label: 'Rapide (148 Mo)' },
    small: { file: 'ggml-small.bin', mb: 488, label: 'Précis (488 Mo)' }
  };

  function req(name) {
    if (typeof window !== 'undefined') {
      if (window.cep_node && window.cep_node.require) return window.cep_node.require(name);
      if (typeof window.require === 'function') return window.require(name);
    }
    return require(name);
  }

  function paths(baseDir, model) {
    var path = req('path');
    var dir = path.join(baseDir, 'whisper');
    return {
      dir: dir,
      zip: path.join(dir, 'whisper-bin-x64-' + VERSION + '.zip'),
      binDir: path.join(dir, 'bin-' + VERSION),
      exe: path.join(dir, 'bin-' + VERSION, 'Release', 'whisper-cli.exe'),
      model: path.join(dir, (MODELS[model] || MODELS.base).file)
    };
  }

  function supported() {
    return req('os').platform() === 'win32';
  }

  function isInstalled(baseDir, model) {
    var fs = req('fs');
    var p = paths(baseDir, model);
    try {
      return fs.existsSync(p.exe) && fs.existsSync(p.model) && fs.statSync(p.model).size > 1e7;
    } catch (e) {
      return false;
    }
  }

  /** Telecharge le programme et le modele manquants. onProgress(fraction, texte). */
  function install(baseDir, model, download, onProgress) {
    var fs = req('fs');
    var p = paths(baseDir, model);
    fs.mkdirSync(p.dir, { recursive: true });
    var m = MODELS[model] || MODELS.base;
    var chain = Promise.resolve();
    if (!fs.existsSync(p.exe)) {
      chain = chain
        .then(function () {
          return download(BIN_URL, p.zip, function (f) {
            onProgress(f * 0.1, 'Téléchargement de whisper.cpp…');
          });
        })
        .then(function () {
          onProgress(0.1, 'Décompression…');
          fs.mkdirSync(p.binDir, { recursive: true });
          // tar de Windows (System32) sait ouvrir les .zip
          var tar = req('path').join(req('process').env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
          var r = req('child_process').spawnSync(tar, ['-xf', p.zip, '-C', p.binDir], { windowsHide: true, encoding: 'utf8' });
          if (r.status !== 0 || !fs.existsSync(p.exe)) {
            throw new Error('Décompression de whisper.cpp impossible : ' + String(r.stderr || r.error || '').slice(0, 200));
          }
        });
    }
    if (!fs.existsSync(p.model) || fs.statSync(p.model).size < 1e7) {
      chain = chain.then(function () {
        return download(MODEL_URL + m.file, p.model, function (f) {
          onProgress(0.1 + f * 0.9, 'Téléchargement du modèle ' + m.label + '… ' + Math.round(f * 100) + ' %');
        });
      });
    }
    return chain.then(function () {
      onProgress(1, 'Moteur de transcription prêt.');
    });
  }

  /**
   * Transcrit un WAV mono 16 kHz.
   * @returns Promise<string> le JSON complet ecrit par whisper (-ojf)
   */
  function transcribe(baseDir, model, wav16k, lang, onProgress, isCancelled) {
    var fs = req('fs');
    var path = req('path');
    var os = req('os');
    var p = paths(baseDir, model);
    var outBase = wav16k.replace(/\.wav$/i, '');
    var threads = Math.max(1, Math.min(8, (os.cpus() || []).length - 1));
    var args = ['-m', p.model, '-f', wav16k, '-l', lang || 'fr', '-ojf', '-of', outBase, '-pp', '-t', String(threads)];
    return new Promise(function (resolve, reject) {
      var proc;
      try {
        proc = req('child_process').spawn(p.exe, args, { cwd: path.dirname(p.exe), windowsHide: true });
      } catch (e) {
        reject(e);
        return;
      }
      var log = '';
      var timer = setInterval(function () {
        if (isCancelled && isCancelled()) {
          try {
            proc.kill();
          } catch (e) {}
        }
      }, 300);
      function onText(d) {
        var s = d.toString();
        if (log.length < 20000) log += s;
        var m = /progress\s*=\s*(\d+)\s*%/g;
        var hit;
        var last = null;
        while ((hit = m.exec(s))) last = +hit[1];
        if (last !== null && onProgress) onProgress(last / 100);
      }
      proc.stdout.on('data', onText);
      proc.stderr.on('data', onText);
      proc.on('error', function (e) {
        clearInterval(timer);
        reject(new Error('whisper.cpp n\'a pas pu démarrer : ' + e.message));
      });
      proc.on('close', function (code) {
        clearInterval(timer);
        if (isCancelled && isCancelled()) return reject(new Error('Transcription interrompue.'));
        var json = outBase + '.json';
        if (code !== 0 || !fs.existsSync(json)) {
          var tail = log.split('\n').filter(function (l) {
            return l.trim();
          }).slice(-3).join(' | ');
          return reject(new Error('whisper.cpp a échoué (code ' + code + ') : ' + tail));
        }
        resolve(fs.readFileSync(json, 'utf8'));
      });
    });
  }

  return {
    VERSION: VERSION,
    MODELS: MODELS,
    supported: supported,
    paths: paths,
    isInstalled: isInstalled,
    install: install,
    transcribe: transcribe
  };
});
