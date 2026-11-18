/* FirstCut - pont entre le panneau et Premiere Pro.
 *
 * Regroupe les trois choses dont le panneau a besoin de la part de CEP :
 * executer de l'ExtendScript, acceder a Node, connaitre quelques dossiers.
 * On parle directement a window.__adobe_cep__ : c'est tout ce que
 * CSInterface.js ferait pour nous.
 */
(function (global) {
  'use strict';

  var cep = global.__adobe_cep__ || null;

  function nodeRequire(name) {
    if (global.cep_node && global.cep_node.require) return global.cep_node.require(name);
    if (typeof global.require === 'function') return global.require(name);
    throw new Error('Node.js est indisponible dans le panneau (--enable-nodejs manquant dans le manifeste).');
  }

  /** Chaine JavaScript en ASCII pur : evalScript ne transporte pas bien les accents. */
  function quote(value) {
    return JSON.stringify(String(value)).replace(/[\u007f-\uffff]/g, function (c) {
      return '\\u' + ('0000' + c.charCodeAt(0).toString(16)).slice(-4);
    });
  }

  function evalScript(script) {
    return new Promise(function (resolve, reject) {
      if (!cep) {
        reject(new Error('Ce panneau doit etre ouvert dans Premiere Pro.'));
        return;
      }
      try {
        cep.evalScript(script, function (result) {
          resolve(result);
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  var Host = {
    available: !!cep,
    require: nodeRequire,
    quote: quote,
    evalScript: evalScript,

    /**
     * Dossier systeme, en chemin ordinaire avec des barres obliques.
     * Selon les versions, CEP rend un chemin ou une adresse file:// encodee.
     */
    systemPath: function (type) {
      if (!cep) return '';
      var p = String(cep.getSystemPath(type));
      if (p.indexOf('file://') === 0) {
        try {
          p = decodeURI(p);
        } catch (e) {}
        p = /^file:\/\/\/[A-Za-z]:/.test(p) ? p.slice(8) : p.slice(7);
      }
      return p.split('\\').join('/');
    },

    extensionPath: function () {
      return Host.systemPath('extension');
    },

    /**
     * Appelle une fonction ExtendScript qui rend du JSON.
     * Les arguments sont tous transmis comme des chaines.
     */
    call: function (fn, args) {
      var list = (args || []).map(quote).join(',');
      return evalScript(fn + '(' + list + ')').then(function (raw) {
        if (raw === 'EvalScript error.' || raw === undefined || raw === null || raw === '') {
          throw new Error(
            'Premiere n\'a pas pu executer ' + fn + '. Ferme puis rouvre le panneau FirstCut.'
          );
        }
        try {
          return JSON.parse(raw);
        } catch (e) {
          throw new Error('Reponse illisible de Premiere pour ' + fn + ' : ' + String(raw).slice(0, 160));
        }
      });
    },

    /**
     * (Re)charge le script ExtendScript du panneau. Le manifeste le charge deja
     * a l'ouverture ; ce second passage garantit qu'on parle a la version du
     * dossier d'extension, meme apres une mise a jour sans redemarrage.
     */
    loadJsx: function () {
      var file = Host.extensionPath() + '/jsx/firstcut.jsx';
      var script =
        'try { $.evalFile(new File(' + quote(file) + ')); "OK"; } ' +
        'catch (e) { "ERR: " + e.toString() + (e.line ? " (ligne " + e.line + ")" : ""); }';
      return evalScript(script)
        .then(function (res) {
          if (typeof res === 'string' && res.indexOf('ERR:') === 0) throw new Error(res);
          return evalScript('typeof ADR_ping');
        })
        .then(function (kind) {
          if (kind !== 'function') throw new Error('Le script Premiere de FirstCut ne s\'est pas charge.');
          return Host.call('ADR_ping', []);
        });
    }
  };

  global.ADHost = Host;
})(window);
