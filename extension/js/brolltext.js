/* B-roll - calculs sur la transcription (module pur, teste sous Node).
 *
 *  - lecture d'une transcription : JSON de whisper.cpp ou fichier SRT ;
 *  - mots-cles d'un passage ;
 *  - choix des moments a illustrer (rythme, durees) sans IA ;
 *  - rapprochement mots-cles <-> videos d'un dossier.
 *
 * Temps en secondes. Un segment : { a, b, text, words: [{ a, b, w }] }.
 */
(function (root, factory) {
  var mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  if (root) root.ADBrollText = mod;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  var DEFAULTS = {
    gapMin: 6, // secondes entre deux B-rolls
    gapMax: 12,
    durMin: 2, // duree d'un B-roll
    durMax: 4
  };

  // Mots trop generaux pour illustrer quoi que ce soit (francais et anglais).
  var STOP = (
    'a ai aie aient aies ait alors as au aucun aucune aupres auquel aura aurai auraient aurais aurait aux avaient avais avait avant avec avez aviez avions avoir avons ayant ' +
    'bah beaucoup bien bon bonne bref car ce ceci cela celle celles celui cependant certes ces cet cette ceux chaque chez chose choses ci comme comment dans de debut des deja depuis dès devant devez doit donc dont du elle elles en encore entre es est et etaient etais etait ete etes etre eu eux fait faire fais faisons faut fois font genre gens ' +
    'ici il ils je jusqu juste la laquelle le lequel les leur leurs lors lorsque lui ma mais me meme memes merci mes moi moins mon ne ni non nos notre nous ok on ont ou oui par parce parfois pas peu peut peuvent peux plus plutot pour pourquoi pourrait pres puis qu quand que quel quelle quelles quels qui quoi sa sans se sera serait ses si sien son sont sous suis sur ta tant te tes toi ton tous tout toute toutes tres trop tu un une uns va vais vas vers voici voila vont vos votre vous vraiment ' +
    'y ca ça cest c est j l d m n s t qu ya voila truc trucs aussi autre autres apres avoir dire dit dis disons voir vois voit voyez allez aller faut faudrait chose quelque quelques choses rien tout tous euh hum bon ben alors donc enfin ensuite aujourd hui maintenant demain hier toujours jamais vraiment juste ' +
    'premier premiere premiers deux trois quatre cinq six sept huit neuf dix cent mille fois petit petite grand grande gros nouveau nouvelle vrai faux super tres peu pense penser crois croire sais savoir veux vouloir peux pouvoir dois devoir vais allons prendre mettre montrer parler ' +
    'the and for are but not you all any can her was one our out his has have had him how its may new now old see two way who did get got let put say she too use this that with from they will your what when were been into them than then there these those which while would could should about after again also because before being between both each just more most other over same some such only own very ' +
    'video videos episode chaine abonnez abonne like commentaire commentaires ' +
    'commence commencer commencez termine terminer finir fini aime aimer adore montre regarde regarder arrive arriver passe passer ' +
    'reste rester trouve trouver donne donner essaie essayer utilise utiliser dites voulez pouvez devez faites allons venez ' +
    'autour dessus dessous dedans dehors haut loin pres partout ailleurs vachement carrement franchement'
  ).split(/\s+/);
  var STOPSET = {};
  STOP.forEach(function (w) {
    STOPSET[w] = true;
  });

  function num(v, f) {
    var n = typeof v === 'number' ? v : parseFloat(v);
    return isFinite(n) ? n : f;
  }

  function normalize(p) {
    p = p || {};
    var gMin = Math.max(1, num(p.gapMin, DEFAULTS.gapMin));
    var gMax = Math.max(1, num(p.gapMax, DEFAULTS.gapMax));
    var dMin = Math.max(0.5, num(p.durMin, DEFAULTS.durMin));
    var dMax = Math.max(0.5, num(p.durMax, DEFAULTS.durMax));
    return {
      gapMin: Math.min(gMin, gMax),
      gapMax: Math.max(gMin, gMax),
      durMin: Math.min(dMin, dMax),
      durMax: Math.max(dMin, dMax)
    };
  }

  // ------------------------------------------------------------- lecture

  /** Enleve accents et majuscules : « Été » -> « ete ». */
  function fold(s) {
    return String(s)
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[’']/g, ' ');
  }

  function srtTime(s) {
    var m = /(\d+):(\d\d):(\d\d)[,.](\d{1,3})/.exec(s);
    if (!m) return NaN;
    return +m[1] * 3600 + +m[2] * 60 + +m[3] + +((m[4] + '00').slice(0, 3)) / 1000;
  }

  /** Fichier SRT (ou VTT) -> segments. */
  function parseSrt(text) {
    var out = [];
    var blocks = String(text).replace(/\r/g, '').replace(/^﻿/, '').split(/\n\s*\n/);
    blocks.forEach(function (b) {
      var lines = b.split('\n').filter(function (l) {
        return l.trim() !== '';
      });
      for (var i = 0; i < lines.length; i++) {
        var m = /([\d:.,]+)\s*-->\s*([\d:.,]+)/.exec(lines[i]);
        if (!m) continue;
        // VTT peut omettre les heures : « 01:02.500 » = 1 min 2,5 s
        var full = function (x) {
          return (x.match(/:/g) || []).length < 2 ? '00:' + x : x;
        };
        var a = srtTime(full(m[1]));
        var e = srtTime(full(m[2]));
        var txt = lines
          .slice(i + 1)
          .join(' ')
          .replace(/<[^>]+>/g, '')
          .replace(/\s+/g, ' ')
          .trim();
        if (isFinite(a) && isFinite(e) && e > a && txt) out.push({ a: a, b: e, text: txt, words: [] });
        break;
      }
    });
    out.sort(function (x, y) {
      return x.a - y.a;
    });
    return out;
  }

  /** Sortie JSON complete de whisper.cpp (-ojf) -> segments, avec les mots si presents. */
  function parseWhisperJson(json) {
    var j = typeof json === 'string' ? JSON.parse(json) : json;
    var list = (j && j.transcription) || [];
    var out = [];
    list.forEach(function (seg) {
      var off = seg.offsets || {};
      var a = num(off.from, NaN) / 1000;
      var b = num(off.to, NaN) / 1000;
      var text = String(seg.text || '').trim();
      if (!(b > a) || !text) return;
      var words = [];
      (seg.tokens || []).forEach(function (t) {
        var w = String(t.text || '');
        if (!w.trim() || /^\[.*\]$/.test(w.trim())) return; // jetons speciaux [_BEG_] ...
        var to = t.offsets || {};
        var wa = num(to.from, NaN) / 1000;
        var wb = num(to.to, NaN) / 1000;
        if (!(wb >= wa)) return;
        // un jeton qui commence par une espace ouvre un nouveau mot
        if (words.length && !/^\s/.test(w)) {
          var last = words[words.length - 1];
          last.w += w;
          last.b = wb;
        } else {
          words.push({ a: wa, b: wb, w: w.trim() });
        }
      });
      out.push({ a: a, b: b, text: text, words: words });
    });
    return out;
  }

  /** Decale les temps (transcription d'un extrait -> temps de la sequence). */
  function shift(segments, offset) {
    return segments.map(function (s) {
      return {
        a: s.a + offset,
        b: s.b + offset,
        text: s.text,
        words: (s.words || []).map(function (w) {
          return { a: w.a + offset, b: w.b + offset, w: w.w };
        })
      };
    });
  }

  /** Ne garde que les segments dont le milieu tombe dans une section [[a, b]] (secondes). */
  function inSections(segments, sections) {
    return segments.filter(function (s) {
      var m = (s.a + s.b) / 2;
      for (var i = 0; i < sections.length; i++) if (m >= sections[i][0] && m < sections[i][1]) return true;
      return false;
    });
  }

  // ----------------------------------------------------------- mots-cles

  /** Mots porteurs de sens d'un texte, sous forme repliee (sans accents). */
  function tokens(text, minLen) {
    var min = minLen || 4;
    return fold(text)
      .split(/[^a-z0-9]+/)
      .filter(function (w) {
        return w.length >= min && !STOPSET[w] && !/^\d+$/.test(w);
      })
      .map(stem);
  }

  // Adjectifs places avant le nom : « un bon café », « une petite plage ».
  var PRE_ADJ = {};
  'bon bonne bons bonnes beau belle beaux belles petit petite petits petites grand grande grands grandes gros grosse vieux vieille joli jolie nouveau nouvelle vrai vraie'.split(' ').forEach(function (w) {
    PRE_ADJ[w] = true;
  });

  /** Racine grossiere : enleve le pluriel, pour que « montagnes » = « montagne ». */
  function stem(w) {
    if (w.length > 5 && /aux$/.test(w)) return w.slice(0, -3) + 'al';
    if (w.length > 4 && /[sx]$/.test(w)) return w.slice(0, -1);
    return w;
  }

  /** Rarete de chaque mot dans toute la transcription : un mot rare est plus illustrable. */
  function idf(segments) {
    var df = {};
    segments.forEach(function (s) {
      var seen = {};
      tokens(s.text).forEach(function (t) {
        if (seen[t]) return;
        seen[t] = true;
        df[t] = (df[t] || 0) + 1;
      });
    });
    var n = Math.max(1, segments.length);
    var out = {};
    Object.keys(df).forEach(function (t) {
      out[t] = Math.log(1 + n / df[t]);
    });
    return out;
  }

  // Un mot apres un determinant est presque toujours un nom : c'est ce qui s'illustre.
  var DETERMINERS = {};
  ('le la les l un une des du de d au aux mon ma mes ton ta tes son sa ses notre nos votre vos leur leurs ce cet cette ces ' +
    'quel quelle quels quelles chaque plusieurs the a an my your his her our their this these those').split(' ').forEach(function (w) {
    DETERMINERS[w] = true;
  });

  /** Ressemble a un verbe conjugue, un adverbe ou un adjectif courant : moins illustrable. */
  function weakForm(w) {
    return /(ment|ons|ez|aient|ait|ais|erai|erait|eront|issent|ir|er)$/.test(w) ||
      /(ant|ante|ants|antes|ible|ibles|able|ables|eux|euse|euses)$/.test(w);
  }

  /**
   * Meilleurs mots-cles d'un texte, dans leur forme d'origine (pour la recherche).
   * Rend [{ key, word, score }] du plus fort au plus faible.
   */
  function keywords(text, weights, max) {
    var words = String(text).split(/[\s,.;:!?()"«»]+/);
    var best = {};
    var prev = '';
    var prev2 = '';
    words.forEach(function (raw) {
      var clean = raw.replace(/^[^\wÀ-ſ]+|[^\wÀ-ſ]+$/g, '');
      // « l'ocean », « d'Italie » : l'article colle au mot
      var elided = /^[a-z]['’]/i.test(clean);
      clean = clean.replace(/^[a-z]['’]/i, '');
      var folded = fold(raw).replace(/[^a-z]/g, '');
      var isNoun = elided || DETERMINERS[prev] || (DETERMINERS[prev2] && PRE_ADJ[prev]);
      // un nom court (« lac », « mer ») n'est retenu que derriere un determinant
      var t = tokens(clean, isNoun ? 3 : 4)[0];
      prev2 = prev;
      prev = folded;
      if (!t) return;
      var score = (weights && weights[t] ? weights[t] : 1) * (1 + Math.min(clean.length, 12) / 12);
      if (isNoun) score *= 1.8;
      else if (weakForm(t)) score *= 0.45;
      if (!best[t] || best[t].score < score) best[t] = { key: t, word: clean, score: score };
    });
    return Object.keys(best)
      .map(function (k) {
        return best[k];
      })
      .sort(function (x, y) {
        return y.score - x.score;
      })
      .slice(0, max || 3);
  }

  // ------------------------------------------------------------ moments

  function rng(seed) {
    var a = (seed >>> 0) || 1;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /**
   * Moments a illustrer, sans IA.
   * Avance dans chaque section par pas de gapMin a gapMax secondes ; a chaque
   * pas, prend dans la fenetre le segment qui a le mot-cle le plus illustrable
   * et cale le B-roll sur le mot lui-meme quand on connait son instant.
   * @param segments  transcription (temps de la sequence)
   * @param sections  [[debut, fin]] en secondes
   * @returns [{ a, b, text, query, keys: [...] }]
   */
  function planMoments(segments, sections, params, seed) {
    var p = normalize(params);
    var r = rng(seed);
    var w = idf(segments);
    var out = [];
    sections.forEach(function (sec) {
      var t = sec[0] + p.gapMin * 0.5 * r();
      while (t < sec[1] - p.durMin) {
        var winEnd = t + (p.gapMax - p.gapMin) + 2;
        var best = null;
        segments.forEach(function (s) {
          if (s.b <= t || s.a >= winEnd || s.a >= sec[1]) return;
          var k = keywords(s.text, w, 3);
          if (!k.length) return;
          if (!best || k[0].score > best.k[0].score) best = { s: s, k: k };
        });
        if (!best) {
          t += p.gapMin;
          continue;
        }
        // depart : le mot-cle s'il est horodate, sinon le debut du segment
        var start = Math.max(best.s.a, t);
        var key = best.k[0].key;
        (best.s.words || []).some(function (wd) {
          if (tokens(wd.w)[0] === key && wd.a >= t - 0.5) {
            start = Math.max(t, wd.a - 0.2);
            return true;
          }
          return false;
        });
        var dur = p.durMin + (p.durMax - p.durMin) * r();
        var end = Math.min(start + dur, sec[1]);
        if (end - start >= Math.min(p.durMin, 1)) {
          out.push({
            a: round3(start),
            b: round3(end),
            text: best.s.text,
            query: best.k.map(function (x) {
              return x.word;
            }).slice(0, 2).join(' '),
            keys: best.k.map(function (x) {
              return x.key;
            })
          });
        }
        t = end + p.gapMin + (p.gapMax - p.gapMin) * r();
      }
    });
    return out;
  }

  function round3(x) {
    return Math.round(x * 1000) / 1000;
  }

  // ------------------------------------------------------------ dossier

  /** Mots d'un element de bibliotheque : nom du fichier, dossiers, descriptions. */
  function itemTokens(item) {
    var parts = [item.rel || item.name || ''];
    if (item.summary) parts.push(item.summary);
    (item.tags || []).forEach(function (t) {
      parts.push(t);
    });
    (item.frames || []).forEach(function (f) {
      if (f.caption) parts.push(f.caption);
    });
    var seen = {};
    tokens(parts.join(' ').replace(/[_\-.\\/]+/g, ' ')).forEach(function (t) {
      seen[t] = true;
    });
    return seen;
  }

  /**
   * Videos du dossier classees pour un moment : nombre de mots-cles communs.
   * Rend [{ item, score, t }] (t = instant conseille dans la video), du meilleur au moins bon.
   */
  function rankLibrary(moment, items, minDur) {
    var ranked = [];
    items.forEach(function (item) {
      if (!(item.duration >= minDur)) return;
      var set = itemTokens(item);
      var score = 0;
      moment.keys.forEach(function (k, i) {
        if (set[k]) score += 3 - Math.min(i, 2);
      });
      if (!score) return;
      // l'image dont la description parle du mot-cle donne le passage
      var t = null;
      (item.frames || []).some(function (f) {
        if (!f.caption) return false;
        var ft = {};
        tokens(f.caption).forEach(function (x) {
          ft[x] = true;
        });
        if (moment.keys.some(function (k) { return ft[k]; })) {
          t = f.t;
          return true;
        }
        return false;
      });
      ranked.push({ item: item, score: score, t: t });
    });
    ranked.sort(function (x, y) {
      return y.score - x.score;
    });
    return ranked;
  }

  /** Debut du passage a prendre dans une video, pour une duree donnee. */
  function passage(duration, len, around, rand) {
    var maxStart = Math.max(0, duration - len - 0.2);
    var s;
    if (around !== null && around !== undefined) s = around - len / 2;
    else s = 0.2 + (maxStart - 0.2) * (rand === undefined ? 0.5 : rand);
    return round3(Math.max(0, Math.min(maxStart, s)));
  }

  return {
    DEFAULTS: DEFAULTS,
    normalize: normalize,
    fold: fold,
    parseSrt: parseSrt,
    parseWhisperJson: parseWhisperJson,
    shift: shift,
    inSections: inSections,
    tokens: tokens,
    idf: idf,
    keywords: keywords,
    planMoments: planMoments,
    rankLibrary: rankLibrary,
    passage: passage,
    rng: rng
  };
});
