/* B-roll - choix assiste par Claude (API Anthropic, cle de l'utilisateur).
 *
 * Deux usages :
 *   - planMoments : lit la transcription et choisit les moments a illustrer,
 *     avec pour chacun une recherche visuelle concrete (en anglais, ce que
 *     les banques comprennent le mieux) ou un passage d'une video du dossier ;
 *   - describeClip : decrit quelques images d'une video du dossier, pour que
 *     le choix puisse s'appuyer sur ce qu'on y voit.
 *
 * Les reponses sont contraintes par un schema JSON (structured outputs), puis
 * relues et bornees ici : rien de ce que renvoie le modele n'est pris tel quel.
 */
(function (root, factory) {
  var mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  if (root) root.ADBrollAI = mod;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  var MODELS = [
    { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 (meilleur choix)' },
    { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (plus economique)' },
    { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 (le moins cher)' }
  ];
  var DEFAULT_MODEL = 'claude-opus-5-5';

  function req(name) {
    if (typeof window !== 'undefined') {
      if (window.cep_node && window.cep_node.require) return window.cep_node.require(name);
      if (typeof window.require === 'function') return window.require(name);
    }
    return require(name);
  }

  var SDK = null;

  /** Le SDK officiel, charge depuis node_modules du panneau. */
  function sdk(extensionDir) {
    if (SDK) return SDK;
    var path = req('path');
    var mod = extensionDir
      ? req(path.join(extensionDir, 'node_modules', '@anthropic-ai', 'sdk'))
      : req('@anthropic-ai/sdk');
    SDK = mod.default || mod;
    return SDK;
  }

  /**
   * Client Anthropic.
   * Dans le panneau, les requetes passent par le fetch du navigateur integre
   * (Node de CEP est trop ancien pour en avoir un) ; l'API accepte ces appels
   * directs avec dangerouslyAllowBrowser. La cle reste sur ce poste.
   */
  function client(opts) {
    var Anthropic = sdk(opts.extensionDir);
    var conf = { apiKey: opts.apiKey, maxRetries: 2, timeout: 180000 };
    if (opts.baseURL) conf.baseURL = opts.baseURL;
    if (typeof window !== 'undefined' && window.fetch) {
      conf.fetch = window.fetch.bind(window);
      conf.dangerouslyAllowBrowser = true;
    }
    return new Anthropic(conf);
  }

  /** Requete a sortie JSON contrainte ; rend l'objet lu. */
  function ask(opts, params) {
    var Anthropic = sdk(opts.extensionDir);
    var c = client(opts);
    var model = opts.model || DEFAULT_MODEL;
    var body = {
      model: model,
      max_tokens: 16000,
      system: params.system,
      messages: params.messages,
      output_config: {
        effort: params.effort || 'medium',
        format: { type: 'json_schema', schema: params.schema }
      }
    };
    var call;
    if (/^claude-(opus|sonnet)-/.test(model)) {
      // Si le modele decline la demande, l'API la rejoue sur un autre modele
      // dans le meme appel (repli cote serveur).
      body.betas = ['server-side-fallback-2026-07-01'];
      body.fallbacks = 'default';
      call = c.beta.messages.create(body);
    } else {
      call = c.messages.create(body);
    }
    return call.then(
      function (res) {
        if (res.stop_reason === 'refusal') {
          throw new Error('Claude a refusé cette demande' + (res.stop_details && res.stop_details.category ? ' (' + res.stop_details.category + ')' : '') + '.');
        }
        if (res.stop_reason === 'max_tokens') throw new Error('Réponse de Claude tronquée : transcription trop longue pour une seule passe.');
        var text = '';
        (res.content || []).forEach(function (b) {
          if (b.type === 'text') text += b.text;
        });
        try {
          return { data: JSON.parse(text), usage: res.usage, model: res.model };
        } catch (e) {
          throw new Error('Réponse de Claude illisible.');
        }
      },
      function (err) {
        if (err instanceof Anthropic.AuthenticationError) throw new Error('Clé API Claude refusée : vérifie-la dans les réglages.');
        if (err instanceof Anthropic.PermissionDeniedError) throw new Error('Cette clé API n\'a pas accès à ' + model + '.');
        if (err instanceof Anthropic.RateLimitError) throw new Error('Limite de requêtes Claude atteinte : réessaie dans une minute.');
        if (err instanceof Anthropic.BadRequestError) throw new Error('Requête refusée par l\'API Claude : ' + err.message);
        if (err instanceof Anthropic.APIConnectionError) throw new Error('Impossible de joindre l\'API Claude (connexion internet ?).');
        if (err instanceof Anthropic.APIError) throw new Error('Erreur de l\'API Claude (' + err.status + ') : ' + err.message);
        throw err;
      }
    );
  }

  // ---------------------------------------------------------- moments

  var PLAN_SCHEMA = {
    type: 'object',
    properties: {
      moments: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            start: { type: 'number', description: 'debut du B-roll, secondes de la sequence' },
            end: { type: 'number', description: 'fin du B-roll, secondes de la sequence' },
            phrase: { type: 'string', description: 'les mots prononces que ce B-roll illustre' },
            query: { type: 'string', description: 'recherche visuelle concrete en anglais, 1 a 4 mots' },
            library_id: { type: 'string', description: 'id de la video du dossier choisie, ou chaine vide' },
            library_t: { type: 'number', description: 'instant (s) de la video du dossier a montrer, ou -1' }
          },
          required: ['start', 'end', 'phrase', 'query', 'library_id', 'library_t'],
          additionalProperties: false
        }
      }
    },
    required: ['moments'],
    additionalProperties: false
  };

  var PLAN_SYSTEM =
    'Tu es monteur video. On te donne la transcription horodatee d\'une video face camera. ' +
    'Tu choisis les moments ou un plan de coupe (B-roll) rend la video plus vivante : quand la personne ' +
    'parle de quelque chose de concret et visible (un lieu, un objet, une action, une ambiance). ' +
    'Evite les moments abstraits, les apartes, les remerciements et l\'introduction des 2 premieres secondes. ' +
    'Pour chaque moment, ecris une recherche visuelle en anglais, concrete et filmable (ex. "snowy mountain peaks", ' +
    '"pouring coffee cup"), jamais un concept abstrait. Si une video du dossier montre exactement le sujet, ' +
    'donne son id et l\'instant a montrer ; sinon laisse library_id vide et library_t a -1. ' +
    'Respecte strictement le rythme et les durees demandes, et reste dans les sections indiquees.';

  /**
   * Moments a illustrer, choisis par Claude.
   * @param input { segments, sections: [[a, b]], params: { gapMin, gapMax, durMin, durMax }, library: [...] }
   * @returns Promise<[{ a, b, text, query, library: { id, t } | null }]>
   */
  function planMoments(opts, input) {
    var payload = {
      rythme: 'un B-roll toutes les ' + input.params.gapMin + ' a ' + input.params.gapMax + ' secondes de parole',
      duree_broll: 'entre ' + input.params.durMin + ' et ' + input.params.durMax + ' secondes',
      sections: input.sections.map(function (s) {
        return { debut: round2(s[0]), fin: round2(s[1]) };
      }),
      transcription: input.segments.map(function (s) {
        return { debut: round2(s.a), fin: round2(s.b), texte: s.text };
      })
    };
    if (input.library && input.library.length) {
      payload.dossier = input.library.map(function (it) {
        return {
          id: it.id,
          fichier: it.rel || it.name,
          duree: round2(it.duration),
          resume: it.summary || '',
          images: (it.frames || []).map(function (f) {
            return { t: round2(f.t), description: f.caption || '' };
          })
        };
      });
    }
    return ask(opts, {
      system: PLAN_SYSTEM,
      effort: 'medium',
      schema: PLAN_SCHEMA,
      messages: [{ role: 'user', content: JSON.stringify(payload) }]
    }).then(function (r) {
      return { moments: sanitize(r.data.moments || [], input), usage: r.usage };
    });
  }

  function round2(x) {
    return Math.round(x * 100) / 100;
  }

  /** Remet dans les clous ce que renvoie le modele : sections, durees, chevauchements, ids. */
  function sanitize(list, input) {
    var p = input.params;
    var ids = {};
    (input.library || []).forEach(function (it) {
      ids[it.id] = it;
    });
    var out = [];
    list
      .slice()
      .sort(function (x, y) {
        return x.start - y.start;
      })
      .forEach(function (m) {
        var a = +m.start;
        var b = +m.end;
        if (!isFinite(a) || !isFinite(b)) return;
        var sec = null;
        input.sections.forEach(function (s) {
          if (a >= s[0] - 0.01 && a < s[1]) sec = s;
        });
        if (!sec) return;
        if (b - a > p.durMax) b = a + p.durMax;
        if (b - a < p.durMin) b = a + p.durMin;
        if (b > sec[1]) b = sec[1];
        if (b - a < Math.min(1, p.durMin)) return;
        var prev = out[out.length - 1];
        if (prev && a < prev.b + 0.5) return; // jamais deux B-rolls colles
        var lib = null;
        var item = m.library_id ? ids[m.library_id] : null;
        if (item) {
          var t = +m.library_t;
          lib = { id: item.id, t: isFinite(t) && t >= 0 && t <= item.duration ? t : null };
        }
        var query = String(m.query || '').replace(/\s+/g, ' ').trim().slice(0, 60);
        if (!query && !lib) return;
        out.push({
          a: round3(a),
          b: round3(b),
          text: String(m.phrase || '').slice(0, 200),
          query: query,
          keys: [],
          library: lib
        });
      });
    return out;
  }

  function round3(x) {
    return Math.round(x * 1000) / 1000;
  }

  // ------------------------------------------------------- description

  var CLIP_SCHEMA = {
    type: 'object',
    properties: {
      summary: { type: 'string', description: 'une phrase : ce que montre la video' },
      tags: { type: 'array', items: { type: 'string' }, description: '3 a 8 mots-cles en francais' },
      frames: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            t: { type: 'number' },
            caption: { type: 'string', description: 'ce qu\'on voit sur cette image, en francais' }
          },
          required: ['t', 'caption'],
          additionalProperties: false
        }
      }
    },
    required: ['summary', 'tags', 'frames'],
    additionalProperties: false
  };

  /**
   * Description d'une video a partir de quelques images.
   * @param clip { name, frames: [{ t, jpg }] }  jpg : chemin d'une image JPEG
   */
  function describeClip(opts, clip) {
    var fs = req('fs');
    var content = [];
    clip.frames.forEach(function (f) {
      content.push({ type: 'text', text: 'Image a t = ' + round2(f.t) + ' s' });
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: fs.readFileSync(f.jpg).toString('base64') }
      });
    });
    content.push({
      type: 'text',
      text: 'Video "' + clip.name + '". Decris chaque image en une courte phrase concrete (sujet, lieu, action), ' +
        'puis resume la video et donne des mots-cles, en francais.'
    });
    return ask(opts, {
      system: 'Tu decris des rushes video pour qu\'un monteur retrouve le bon plan.',
      effort: 'low',
      schema: CLIP_SCHEMA,
      messages: [{ role: 'user', content: content }]
    }).then(function (r) {
      var d = r.data || {};
      return {
        summary: String(d.summary || '').slice(0, 300),
        tags: (d.tags || []).map(String).slice(0, 10),
        frames: (d.frames || []).map(function (f) {
          return { t: +f.t, caption: String(f.caption || '').slice(0, 200) };
        }),
        usage: r.usage
      };
    });
  }

  return {
    MODELS: MODELS,
    DEFAULT_MODEL: DEFAULT_MODEL,
    planMoments: planMoments,
    describeClip: describeClip,
    sanitize: sanitize,
    PLAN_SCHEMA: PLAN_SCHEMA,
    CLIP_SCHEMA: CLIP_SCHEMA
  };
});
