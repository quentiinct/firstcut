/* B-roll - acces reseau : recherche dans les banques en ligne et telechargements.
 *
 * Passe par le module https de Node (et non par fetch) : pas de blocage CORS,
 * et les redirections des liens de telechargement sont suivies.
 *
 * Banques :
 *   - Pexels    : videos et photos, licence libre d'usage, cle API gratuite ;
 *   - Openverse : photos sous licence Creative Commons, sans cle (attribution
 *                 a faire : les credits sont ecrits a cote des fichiers).
 *
 * Un candidat : { id, provider, kind: 'video'|'image', thumb, url, w, h,
 *                 duration, page, credit, license }
 */
(function (root, factory) {
  var mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  if (root) root.ADBrollSrc = mod;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  var UA = 'FirstCut/1.0 (Premiere Pro panel)';

  function req(name) {
    if (typeof window !== 'undefined') {
      if (window.cep_node && window.cep_node.require) return window.cep_node.require(name);
      if (typeof window.require === 'function') return window.require(name);
    }
    return require(name);
  }

  // ------------------------------------------------------------------ http

  /** GET avec redirections ; rend { status, headers, body (Buffer) }. */
  function get(url, headers, redirects) {
    return new Promise(function (resolve, reject) {
      var lib = /^https:/i.test(url) ? req('https') : req('http');
      var h = { 'User-Agent': UA };
      for (var k in headers || {}) h[k] = headers[k];
      var r = lib.get(url, { headers: h, timeout: 30000 }, function (res) {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if ((redirects || 0) > 6) return reject(new Error('trop de redirections : ' + url));
          var next = new URL(res.headers.location, url).toString();
          return resolve(get(next, headers, (redirects || 0) + 1));
        }
        var chunks = [];
        res.on('data', function (c) {
          chunks.push(c);
        });
        res.on('end', function () {
          resolve({ status: res.statusCode, headers: res.headers, body: req('buffer').Buffer.concat(chunks) });
        });
        res.on('error', reject);
      });
      r.on('timeout', function () {
        r.destroy(new Error('delai depasse : ' + url));
      });
      r.on('error', reject);
    });
  }

  function getJson(url, headers) {
    return get(url, headers).then(function (res) {
      var text = res.body.toString('utf8');
      if (res.status === 401 || res.status === 403) {
        var e = new Error('acces refuse (' + res.status + ') : verifie la cle API');
        e.status = res.status;
        throw e;
      }
      if (res.status === 429) throw new Error('trop de recherches d\'affilee : reessaie dans une minute');
      if (res.status >= 400) throw new Error('erreur ' + res.status + ' de ' + new URL(url).host);
      try {
        return JSON.parse(text);
      } catch (e2) {
        throw new Error('reponse illisible de ' + new URL(url).host);
      }
    });
  }

  /**
   * Telecharge un fichier (avec redirections) ; ne refait rien s'il existe deja.
   * Ecrit d'abord dans un fichier temporaire : un telechargement coupe ne laisse
   * pas de fichier abime derriere lui.
   */
  function download(url, dest, onProgress, redirects) {
    var fs = req('fs');
    var path = req('path');
    try {
      if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return Promise.resolve(dest);
    } catch (e) {}
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    return new Promise(function (resolve, reject) {
      var lib = /^https:/i.test(url) ? req('https') : req('http');
      var r = lib.get(url, { headers: { 'User-Agent': UA }, timeout: 60000 }, function (res) {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if ((redirects || 0) > 6) return reject(new Error('trop de redirections'));
          return resolve(download(new URL(res.headers.location, url).toString(), dest, onProgress, (redirects || 0) + 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error('telechargement refuse (' + res.statusCode + ')'));
        }
        var total = parseInt(res.headers['content-length'] || '0', 10);
        var got = 0;
        var part = dest + '.part';
        var out = fs.createWriteStream(part);
        res.on('data', function (c) {
          got += c.length;
          if (onProgress && total) onProgress(got / total);
        });
        res.pipe(out);
        out.on('finish', function () {
          out.close(function () {
            try {
              fs.renameSync(part, dest);
              resolve(dest);
            } catch (e) {
              reject(e);
            }
          });
        });
        out.on('error', reject);
        res.on('error', reject);
      });
      r.on('timeout', function () {
        r.destroy(new Error('delai depasse pendant le telechargement'));
      });
      r.on('error', reject);
    });
  }

  // ---------------------------------------------------------------- Pexels

  /** Fichier video le mieux adapte a la sequence : juste au-dessus de sa hauteur. */
  function pickVideoFile(files, targetH) {
    var mp4 = (files || []).filter(function (f) {
      return /mp4/i.test(f.file_type || '') && f.link && f.height;
    });
    if (!mp4.length) return null;
    mp4.sort(function (a, b) {
      return a.height - b.height;
    });
    for (var i = 0; i < mp4.length; i++) {
      if (mp4[i].height >= targetH && mp4[i].height <= 2160) return mp4[i];
    }
    var under = mp4.filter(function (f) {
      return f.height <= 2160;
    });
    return under.length ? under[under.length - 1] : mp4[0];
  }

  function pexelsVideos(key, query, opts) {
    var q = encodeURIComponent(query);
    var url = 'https://api.pexels.com/videos/search?query=' + q + '&per_page=' + (opts.count || 8) +
      '&orientation=' + (opts.orientation || 'landscape') + '&locale=fr-FR';
    return getJson(url, { Authorization: key }).then(function (j) {
      return (j.videos || [])
        .filter(function (v) {
          return v.duration >= (opts.minDuration || 0);
        })
        .map(function (v) {
          var f = pickVideoFile(v.video_files, opts.targetH || 1080);
          if (!f) return null;
          return {
            id: 'pexels-v' + v.id,
            provider: 'pexels',
            kind: 'video',
            thumb: v.image,
            url: f.link,
            ext: 'mp4',
            w: f.width,
            h: f.height,
            duration: v.duration,
            page: v.url,
            credit: (v.user && v.user.name ? v.user.name : 'Pexels') + ' (Pexels)',
            license: 'Licence Pexels'
          };
        })
        .filter(Boolean);
    });
  }

  function pexelsPhotos(key, query, opts) {
    var q = encodeURIComponent(query);
    var url = 'https://api.pexels.com/v1/search?query=' + q + '&per_page=' + (opts.count || 8) +
      '&orientation=' + (opts.orientation || 'landscape') + '&locale=fr-FR';
    return getJson(url, { Authorization: key }).then(function (j) {
      return (j.photos || []).map(function (p) {
        var src = p.src || {};
        return {
          id: 'pexels-p' + p.id,
          provider: 'pexels',
          kind: 'image',
          thumb: src.medium || src.small,
          url: src.large2x || src.original,
          ext: 'jpg',
          w: p.width,
          h: p.height,
          duration: 0,
          page: p.url,
          credit: (p.photographer || 'Pexels') + ' (Pexels)',
          license: 'Licence Pexels'
        };
      });
    });
  }

  // ------------------------------------------------------------- Openverse

  function openverseImages(query, opts) {
    var url = 'https://api.openverse.org/v1/images/?q=' + encodeURIComponent(query) +
      '&page_size=' + (opts.count || 8) + '&license_type=commercial,modification&mature=false' +
      (opts.orientation === 'portrait' ? '&aspect_ratio=tall' : '&aspect_ratio=wide');
    return getJson(url).then(function (j) {
      return (j.results || [])
        .filter(function (r) {
          return r.url && r.width >= 640;
        })
        .map(function (r) {
          var ext = (/\.(jpe?g|png)(\?|$)/i.exec(r.url) || [0, 'jpg'])[1].toLowerCase().replace('jpeg', 'jpg');
          return {
            id: 'openverse-' + r.id,
            provider: 'openverse',
            kind: 'image',
            thumb: r.thumbnail || r.url,
            url: r.url,
            ext: ext,
            w: r.width,
            h: r.height,
            duration: 0,
            page: r.foreign_landing_url || r.url,
            credit: r.attribution || ((r.title || 'Image') + ' par ' + (r.creator || 'inconnu') + ', ' + r.license),
            license: 'CC ' + String(r.license || '').toUpperCase() + ' ' + (r.license_version || '')
          };
        });
    });
  }

  /**
   * Candidats en ligne pour une recherche.
   * opts : { pexelsKey, types: { video, image }, count, minDuration, targetH, orientation }
   * Sans cle Pexels : photos Openverse seulement.
   */
  function search(query, opts) {
    var jobs = [];
    if (opts.pexelsKey) {
      if (opts.types.video) jobs.push(pexelsVideos(opts.pexelsKey, query, opts));
      if (opts.types.image) jobs.push(pexelsPhotos(opts.pexelsKey, query, opts));
    } else if (opts.types.image || opts.types.video) {
      jobs.push(openverseImages(query, opts));
    }
    return Promise.all(
      jobs.map(function (j) {
        return j.catch(function (e) {
          return { error: e };
        });
      })
    ).then(function (lists) {
      var errors = lists.filter(function (l) {
        return l && l.error;
      });
      var ok = lists.filter(function (l) {
        return Array.isArray(l);
      });
      if (!ok.length && errors.length) throw errors[0].error;
      // videos et photos en alternance, videos d'abord
      var out = [];
      var max = Math.max.apply(null, ok.map(function (l) {
        return l.length;
      }).concat([0]));
      for (var i = 0; i < max; i++) {
        ok.forEach(function (l) {
          if (l[i]) out.push(l[i]);
        });
      }
      return out;
    });
  }

  return {
    get: get,
    getJson: getJson,
    download: download,
    pickVideoFile: pickVideoFile,
    search: search,
    pexelsVideos: pexelsVideos,
    pexelsPhotos: pexelsPhotos,
    openverseImages: openverseImages
  };
});
