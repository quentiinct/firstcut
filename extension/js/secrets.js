/* Cles API chiffrees avec la session Windows (DPAPI).
 *
 * Dans settings.json, une cle chiffree s'ecrit « dpapi:<base64> ». Seule la
 * meme session Windows, sur le meme PC, sait la relire : copier le fichier
 * ailleurs ne suffit pas. Node n'a pas acces a DPAPI ; on passe par le
 * PowerShell de Windows (environ 0,3 s par appel), en envoyant les valeurs par
 * l'entree standard pour qu'elles n'apparaissent jamais dans une ligne de
 * commande. Hors Windows, rien n'est chiffre : available() rend false.
 */
(function (root, factory) {
  var mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  if (root) root.ADSecrets = mod;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  var PREFIX = 'dpapi:';

  function req(name) {
    if (typeof window !== 'undefined') {
      if (window.cep_node && window.cep_node.require) return window.cep_node.require(name);
      if (typeof window.require === 'function') return window.require(name);
    }
    return require(name);
  }

  function available() {
    try {
      return req('os').platform() === 'win32';
    } catch (e) {
      return false;
    }
  }

  function isSealed(v) {
    return typeof v === 'string' && v.indexOf(PREFIX) === 0;
  }

  /** Une ligne base64 par valeur en entree, une en sortie ('!' si elle echoue). */
  function script(method) {
    return "$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security;" +
      "$e=[Text.Encoding]::UTF8.GetBytes('FirstCut');$s=[Security.Cryptography.DataProtectionScope]::CurrentUser;" +
      "foreach($l in [Console]::In.ReadToEnd().Split([char]10)){$l=$l.Trim();if($l -eq ''){continue};" +
      "try{$r=[Security.Cryptography.ProtectedData]::" + method + "([Convert]::FromBase64String($l),$e,$s);" +
      "[Console]::Out.WriteLine([Convert]::ToBase64String($r))}catch{[Console]::Out.WriteLine('!')}}";
  }

  function powershell() {
    var env = {};
    try {
      env = req('process').env || {};
    } catch (e) {}
    var dir = env.SystemRoot || env.windir || 'C:\\Windows';
    return req('path').join(dir, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  }

  /** Rend un tableau de base64 (null pour une valeur refusee), ou null si PowerShell echoue. */
  function run(method, lines) {
    if (!lines.length) return [];
    try {
      var r = req('child_process').spawnSync(powershell(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script(method)], {
        input: lines.join('\n') + '\n',
        encoding: 'utf8',
        windowsHide: true,
        timeout: 20000
      });
      if (r.error || r.status !== 0) return null;
      var out = String(r.stdout || '').split(/\r?\n/).filter(function (l) {
        return l.trim() !== '';
      });
      if (out.length !== lines.length) return null;
      return out.map(function (l) {
        l = l.trim();
        return l === '!' ? null : l;
      });
    } catch (e) {
      return null;
    }
  }

  function b64(text) {
    return req('buffer').Buffer.from(String(text), 'utf8').toString('base64');
  }

  function unb64(text) {
    return req('buffer').Buffer.from(text, 'base64').toString('utf8');
  }

  /**
   * Chiffre des cles non vides. Rend un tableau de « dpapi:… » (null pour une
   * cle qui n'a pas pu l'etre), ou null si le chiffrement est indisponible.
   */
  function seal(values) {
    if (!available()) return null;
    var out = run('Protect', values.map(b64));
    if (!out) return null;
    return out.map(function (v) {
      return v ? PREFIX + v : null;
    });
  }

  /**
   * Dechiffre des « dpapi:… ». Rend un tableau de cles en clair (null pour une
   * cle illisible : autre PC, autre session Windows, fichier abime), ou null si
   * PowerShell n'a pas pu tourner du tout.
   */
  function unseal(values) {
    if (!available()) return null;
    var lines = values.map(function (v) {
      return isSealed(v) ? v.slice(PREFIX.length) : '!';
    });
    var out = run('Unprotect', lines);
    if (!out) return null;
    return out.map(function (v) {
      if (!v) return null;
      try {
        return unb64(v);
      } catch (e) {
        return null;
      }
    });
  }

  /**
   * Coffre pour les champs « fields » d'un objet de reglages : open() les
   * dechiffre sur place apres lecture, sealedCopy() rend la copie a ecrire.
   * api (pour les tests) remplace seal / unseal.
   */
  function vault(fields, api) {
    api = api || { seal: seal, unseal: unseal };
    var cache = {}; // cle en clair -> version chiffree : on ne relance pas PowerShell a chaque sauvegarde
    var kept = {}; // champ -> version chiffree que PowerShell n'a pas pu relire, reecrite telle quelle

    /** Dechiffre sur place. Rend true s'il reste des cles en clair a chiffrer. */
    function open(b) {
      if (!b) return false;
      var names = [];
      var values = [];
      var plain = false;
      fields.forEach(function (f) {
        if (isSealed(b[f])) {
          names.push(f);
          values.push(b[f]);
        } else if (typeof b[f] === 'string' && b[f]) plain = true;
      });
      if (!names.length) return plain;
      var out = api.unseal(values);
      names.forEach(function (f, i) {
        var key = out ? out[i] : null;
        if (key) {
          cache[key] = values[i];
          b[f] = key;
        } else {
          // PowerShell indisponible : la cle chiffree est gardee pour plus tard.
          // Cle illisible (autre PC, autre session) : perdue, a ressaisir.
          if (!out) kept[f] = values[i];
          b[f] = '';
        }
      });
      return plain;
    }

    /** Copie de b ou les cles sont chiffrees. */
    function sealedCopy(b) {
      var o = {};
      for (var k in b) if (Object.prototype.hasOwnProperty.call(b, k)) o[k] = b[k];
      var todo = [];
      fields.forEach(function (f) {
        var v = typeof b[f] === 'string' ? b[f] : '';
        if (!v) {
          o[f] = kept[f] || '';
          return;
        }
        delete kept[f];
        if (cache[v]) o[f] = cache[v];
        else todo.push(f);
      });
      if (todo.length) {
        var out = api.seal(todo.map(function (f) {
          return b[f];
        }));
        todo.forEach(function (f, i) {
          if (out && out[i]) {
            cache[b[f]] = out[i];
            o[f] = out[i];
          } else o[f] = b[f]; // chiffrement impossible : mieux vaut la cle en clair que perdue
        });
      }
      return o;
    }

    return { open: open, sealedCopy: sealedCopy };
  }

  return { PREFIX: PREFIX, available: available, isSealed: isSealed, seal: seal, unseal: unseal, vault: vault };
});
