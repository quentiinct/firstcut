/* B-roll - bibliotheque de videos de l'utilisateur.
 *
 * Parcourt un dossier, lit la duree et la taille de chaque video et en extrait
 * quelques images (ffmpeg). Avec l'IA activee, chaque video est decrite a partir
 * de ces images. Le resultat est mis en cache : une video deja vue n'est relue
 * que si elle a change (taille ou date).
 *
 * Le dossier de l'utilisateur n'est jamais modifie : images et cache vont dans
 * %APPDATA%\FirstCut\bibliotheques.
 */
(function (root, factory) {
  var mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  if (root) root.ADBrollLib = mod;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  var VIDEO_EXT = /\.(mp4|mov|m4v|mkv|avi|mts|m2ts|mxf|wmv|mpg|mpeg|webm)$/i;
  var MAX_FILES = 1500;

  function req(name) {
    if (typeof window !== 'undefined') {
      if (window.cep_node && window.cep_node.require) return window.cep_node.require(name);
      if (typeof window.require === 'function') return window.require(name);
    }
    return require(name);
  }

  // ---------------------------------------------------------------- ffmpeg

  function works(exe) {
    try {
      var r = req('child_process').spawnSync(exe, ['-hide_banner', '-version'], {
        encoding: 'utf8',
        timeout: 8000,
        windowsHide: true
      });
      return r.status === 0 && /ffmpeg version/i.test(String(r.stdout));
    } catch (e) {
      return false;
    }
  }

  /** ffmpeg : chemin choisi, sinon PATH, sinon les emplacements habituels (winget, C:\ffmpeg). */
  function findFfmpeg(preferred) {
    var fs = req('fs');
    var path = req('path');
    var os = req('os');
    if (preferred && fs.existsSync(preferred) && works(preferred)) return preferred;
    if (works('ffmpeg')) return 'ffmpeg';
    var cands = ['C:/ffmpeg/bin/ffmpeg.exe', 'C:/Program Files/ffmpeg/bin/ffmpeg.exe', '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'];
    var winget = path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'WinGet', 'Packages');
    try {
      fs.readdirSync(winget)
        .filter(function (d) {
          return /ffmpeg/i.test(d);
        })
        .forEach(function (d) {
          var base = path.join(winget, d);
          cands.push(path.join(base, 'bin', 'ffmpeg.exe'));
          try {
            fs.readdirSync(base).forEach(function (sub) {
              cands.push(path.join(base, sub, 'bin', 'ffmpeg.exe'));
            });
          } catch (e) {}
        });
    } catch (e2) {}
    for (var i = 0; i < cands.length; i++) {
      if (fs.existsSync(cands[i]) && works(cands[i])) return cands[i];
    }
    return null;
  }

  function run(exe, args) {
    return new Promise(function (resolve, reject) {
      var p;
      try {
        p = req('child_process').spawn(exe, args, { windowsHide: true });
      } catch (e) {
        reject(e);
        return;
      }
      var err = '';
      p.stdout.on('data', function () {});
      p.stderr.on('data', function (d) {
        if (err.length < 100000) err += d.toString();
      });
      p.on('error', reject);
      p.on('close', function (code) {
        resolve({ code: code, stderr: err });
      });
    });
  }

  /** Duree, taille et cadence, lues dans ce que ffmpeg ecrit sur stderr. */
  function parseProbe(stderr) {
    var out = { duration: 0, w: 0, h: 0, fps: 0, hasVideo: false };
    var d = /Duration:\s*(\d+):(\d\d):(\d\d(?:\.\d+)?)/.exec(stderr);
    if (d) out.duration = +d[1] * 3600 + +d[2] * 60 + parseFloat(d[3]);
    var v = /Stream #\d+:\d+[^\n]*?: Video: [^\n]*?(\d{2,5})x(\d{2,5})[^\n]*/.exec(stderr);
    if (v) {
      out.hasVideo = true;
      out.w = +v[1];
      out.h = +v[2];
      var f = /([\d.]+) fps/.exec(v[0]);
      if (f) out.fps = parseFloat(f[1]);
      // une video tournee a la verticale est enregistree couchee avec une rotation
      if (/rotate\s*:\s*-?(90|270)|rotation of -?(90|270)/i.test(stderr)) {
        var tmp = out.w;
        out.w = out.h;
        out.h = tmp;
      }
    }
    return out;
  }

  function probe(ffmpeg, file) {
    return run(ffmpeg, ['-hide_banner', '-nostdin', '-i', file]).then(function (r) {
      return parseProbe(r.stderr);
    });
  }

  function extractFrame(ffmpeg, file, t, out) {
    var args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', '-ss', String(Math.max(0, t)), '-i', file,
      '-frames:v', '1', '-vf', 'scale=384:-2', '-q:v', '5', out];
    return run(ffmpeg, args).then(function () {
      var fs = req('fs');
      if (!fs.existsSync(out)) throw new Error('image non extraite');
      return out;
    });
  }

  /** Instants des images a extraire : reparties sur la video, sans le tout debut ni la toute fin. */
  function frameTimes(duration) {
    var k = Math.max(3, Math.min(6, Math.round(duration / 10) + 2));
    var out = [];
    for (var i = 0; i < k; i++) out.push(Math.round(((i + 0.5) / k) * duration * 100) / 100);
    return out;
  }

  // ---------------------------------------------------------------- dossier

  /** Videos d'un dossier (sous-dossiers compris), chemins absolus. */
  function scan(rootDir) {
    var fs = req('fs');
    var path = req('path');
    var out = [];
    function walk(dir, depth) {
      if (depth > 6 || out.length >= MAX_FILES) return;
      var entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch (e) {
        return;
      }
      entries.forEach(function (e) {
        if (out.length >= MAX_FILES || /^[.$]/.test(e.name)) return;
        var full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full, depth + 1);
        else if (VIDEO_EXT.test(e.name)) out.push(full);
      });
    }
    walk(rootDir, 0);
    out.sort();
    return out;
  }

  function hash(s) {
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16);
  }

  function cachePaths(cacheDir, rootDir) {
    var path = req('path');
    var key = hash(String(rootDir).toLowerCase().replace(/\\/g, '/'));
    var dir = path.join(cacheDir, key);
    return { dir: dir, file: path.join(dir, 'index.json'), frames: path.join(dir, 'images') };
  }

  function loadIndex(cacheDir, rootDir) {
    var fs = req('fs');
    var c = cachePaths(cacheDir, rootDir);
    try {
      var j = JSON.parse(fs.readFileSync(c.file, 'utf8'));
      if (j && j.root === rootDir && Array.isArray(j.items)) return j;
    } catch (e) {}
    return { root: rootDir, items: [] };
  }

  /**
   * Indexe le dossier.
   * opts : { ffmpeg, cacheDir, describe: function(clip) -> Promise|null, onProgress(done, total, label), shouldStop() }
   * Rend { root, items: [{ id, path, rel, name, duration, w, h, size, mtime, frames: [{ t, jpg, caption }], summary, tags }], errors }
   */
  function index(rootDir, opts) {
    var fs = req('fs');
    var path = req('path');
    var c = cachePaths(opts.cacheDir, rootDir);
    fs.mkdirSync(c.frames, { recursive: true });
    var old = loadIndex(opts.cacheDir, rootDir);
    var byPath = {};
    old.items.forEach(function (it) {
      byPath[it.path] = it;
    });
    var files = scan(rootDir);
    var items = [];
    var errors = [];
    var k = 0;

    function save() {
      try {
        fs.writeFileSync(c.file, JSON.stringify({ root: rootDir, updated: Date.now(), items: items }, null, 1));
      } catch (e) {}
    }

    function next() {
      if (k >= files.length || (opts.shouldStop && opts.shouldStop())) {
        save();
        return Promise.resolve({ root: rootDir, items: items, errors: errors, total: files.length });
      }
      var file = files[k++];
      var st;
      try {
        st = fs.statSync(file);
      } catch (e) {
        return next();
      }
      var rel = path.relative(rootDir, file);
      if (opts.onProgress) opts.onProgress(k - 1, files.length, rel);
      var prev = byPath[file];
      var same = prev && prev.size === st.size && prev.mtime === st.mtimeMs && prev.frames &&
        prev.frames.every(function (f) {
          return fs.existsSync(f.jpg);
        });
      var step;
      if (same) {
        step = Promise.resolve(prev);
      } else {
        var id = 'L' + hash(file);
        step = probe(opts.ffmpeg, file).then(function (pr) {
          if (!pr.hasVideo || !(pr.duration > 0.5)) throw new Error('pas de piste video lisible');
          var times = frameTimes(pr.duration);
          var frames = [];
          var chain = Promise.resolve();
          times.forEach(function (t, i) {
            chain = chain.then(function () {
              var jpg = path.join(c.frames, id + '-' + i + '.jpg');
              return extractFrame(opts.ffmpeg, file, t, jpg).then(
                function () {
                  frames.push({ t: t, jpg: jpg, caption: '' });
                },
                function () {}
              );
            });
          });
          return chain.then(function () {
            return {
              id: id,
              path: file,
              rel: rel,
              name: path.basename(file),
              duration: Math.round(pr.duration * 100) / 100,
              w: pr.w,
              h: pr.h,
              size: st.size,
              mtime: st.mtimeMs,
              frames: frames,
              summary: '',
              tags: []
            };
          });
        });
      }
      return step
        .then(function (item) {
          // description par l'IA, seulement si elle manque
          if (opts.describe && !item.summary && item.frames.length) {
            return opts.describe(item).then(
              function (d) {
                item.summary = d.summary;
                item.tags = d.tags;
                item.frames.forEach(function (f) {
                  var best = null;
                  d.frames.forEach(function (g) {
                    if (!best || Math.abs(g.t - f.t) < Math.abs(best.t - f.t)) best = g;
                  });
                  if (best && Math.abs(best.t - f.t) < 1) f.caption = best.caption;
                });
                return item;
              },
              function (e) {
                errors.push(item.rel + ' : description impossible (' + e.message + ')');
                if (/Clé API|refus|accès/i.test(e.message)) opts.describe = null; // inutile d'insister
                return item;
              }
            );
          }
          return item;
        })
        .then(
          function (item) {
            items.push(item);
            if (k % 10 === 0) save();
            return next();
          },
          function (e) {
            errors.push(rel + ' : ' + e.message);
            return next();
          }
        );
    }
    return next();
  }

  return {
    VIDEO_EXT: VIDEO_EXT,
    findFfmpeg: findFfmpeg,
    parseProbe: parseProbe,
    probe: probe,
    frameTimes: frameTimes,
    scan: scan,
    index: index,
    loadIndex: loadIndex,
    hash: hash
  };
});
