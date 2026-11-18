/* FirstCut - couche ExtendScript (cote Premiere Pro).
 *
 * ExtendScript est de l'ECMAScript 3 : pas de JSON, pas de forEach / map /
 * indexOf sur les tableaux, pas de Object.keys. Ce fichier reste en ASCII pur :
 * $.evalFile lit mal les accents selon l'encodage.
 *
 * Tous les noms sont prefixes ADR_ / adr_ : Premiere partage le meme moteur
 * ExtendScript entre les extensions, un nom generique ecraserait celui d'un
 * autre panneau.
 *
 * Le travail de decoupe est tranche en petites etapes (ADR_begin, puis
 * ADR_step en boucle, puis ADR_finish) pour que le panneau puisse afficher la
 * progression et que Premiere reste reactif.
 *
 * Unite de temps interne : le tick (254 016 000 000 par seconde), entier exact
 * quelle que soit la cadence.
 */

var ADR_VERSION = '1.0.0';
var ADR_TPS = 254016000000;
var ADR_state = null;

// ------------------------------------------------------------------ utilitaires

function adr_now() {
    return new Date().getTime();
}

function adr_num(x) {
    var n = parseFloat(String(x));
    return isNaN(n) ? 0 : n;
}

function adr_abs(x) {
    return x < 0 ? -x : x;
}

function adr_pad2(n) {
    n = Math.floor(n);
    return n < 10 ? '0' + n : '' + n;
}

function adr_quote(s) {
    s = String(s);
    var out = '"';
    for (var i = 0; i < s.length; i++) {
        var c = s.charAt(i);
        var code = s.charCodeAt(i);
        if (c === '"') out += '\\"';
        else if (c === '\\') out += '\\\\';
        else if (c === '\n') out += '\\n';
        else if (c === '\r') out += '\\r';
        else if (c === '\t') out += '\\t';
        else if (code < 32 || code > 126) {
            var h = code.toString(16);
            while (h.length < 4) h = '0' + h;
            out += '\\u' + h;
        } else out += c;
    }
    return out + '"';
}

/** Serialisation JSON (ExtendScript n'a pas d'objet JSON). */
function adr_json(v) {
    var t = typeof v;
    if (v === null || t === 'undefined') return 'null';
    if (t === 'number') return isFinite(v) ? String(v) : 'null';
    if (t === 'boolean') return v ? 'true' : 'false';
    if (t === 'string') return adr_quote(v);
    var i;
    if (Object.prototype.toString.call(v) === '[object Array]') {
        var parts = [];
        for (i = 0; i < v.length; i++) parts.push(adr_json(v[i]));
        return '[' + parts.join(',') + ']';
    }
    var props = [];
    for (var k in v) {
        if (!v.hasOwnProperty(k)) continue;
        if (typeof v[k] === 'function') continue;
        props.push(adr_quote(k) + ':' + adr_json(v[k]));
    }
    return '{' + props.join(',') + '}';
}

function adr_fail(code, message, extra) {
    var o = extra || {};
    o.ok = false;
    o.code = code;
    o.error = message;
    return adr_json(o);
}

function adr_readText(path) {
    var f = new File(path);
    if (!f.exists) return null;
    f.encoding = 'UTF-8';
    if (!f.open('r')) return null;
    var s = f.read();
    f.close();
    return s;
}

/** Premier indice i tel que arr[i] >= x (arr trie). */
function adr_lowerBound(arr, x) {
    var lo = 0;
    var hi = arr.length;
    while (lo < hi) {
        var mid = (lo + hi) >> 1;
        if (arr[mid] < x) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

// --------------------------------------------------------------------- timecode

/**
 * Timecode calcule a la main, en repli quand Time.getFormatted ne repond pas.
 * `drop` : timecode a images compensees (29,97 et 59,94), separateur ';'.
 */
function adr_manualTc(frame, fps, drop) {
    var nominal = Math.round(fps);
    if (nominal < 1) nominal = 30;
    if (frame < 0) frame = 0;
    var sep = ':';
    if (drop) {
        sep = ';';
        var dropFrames = Math.round(nominal / 15); // 2 a 29,97 ; 4 a 59,94
        var per10Min = nominal * 600 - dropFrames * 9;
        var perMin = nominal * 60 - dropFrames;
        var d = Math.floor(frame / per10Min);
        var m = frame % per10Min;
        if (m > dropFrames) {
            frame += dropFrames * 9 * d + dropFrames * Math.floor((m - dropFrames) / perMin);
        } else {
            frame += dropFrames * 9 * d;
        }
    }
    var ff = frame % nominal;
    var totalSec = Math.floor(frame / nominal);
    return adr_pad2(Math.floor(totalSec / 3600)) + sep +
           adr_pad2(Math.floor(totalSec / 60) % 60) + sep +
           adr_pad2(totalSec % 60) + sep +
           adr_pad2(ff);
}

/**
 * Timecode a donner au rasoir pour un instant donne.
 * methode : 'F1' Time.getFormatted, 'M1' calcul maison ; le chiffre dit si
 * l'on ajoute le timecode de depart de la sequence (1) ou non (0).
 */
function adr_tc(S, tick, method) {
    var t = tick + (method.charAt(1) === '1' ? S.zero : 0);
    if (method.charAt(0) === 'F') {
        try {
            var tm = new Time();
            tm.ticks = String(t);
            var s = tm.getFormatted(S.frameRate, S.fmt);
            return s ? String(s) : null;
        } catch (e) {
            return null;
        }
    }
    return adr_manualTc(Math.round(t / S.tb), S.fps, S.fmt === 102 || S.fmt === 106);
}

// --------------------------------------------------------------------- lecture

function adr_trackEnd(track) {
    var n = track.clips.numItems;
    if (!n) return 0;
    return adr_num(track.clips[n - 1].end.ticks);
}

function adr_bool(fn) {
    try {
        return fn() ? true : false;
    } catch (e) {
        return false;
    }
}

function ADR_ping() {
    var v = '';
    try {
        v = String(app.version);
    } catch (e) {}
    return adr_json({ ok: true, version: ADR_VERSION, appVersion: v });
}

/** Description de la sequence active : pistes, cadence, points d'entree / sortie. */
function ADR_getInfo() {
    try {
        if (!app.project) return adr_fail('NO_PROJECT', 'Aucun projet ouvert.');
        var seq = app.project.activeSequence;
        if (!seq) return adr_fail('NO_SEQUENCE', 'Aucune sequence active.');

        var tb = adr_num(seq.timebase);
        if (!(tb > 0)) return adr_fail('NO_TIMEBASE', 'Cadence de la sequence illisible.');

        var fmt = 0;
        try {
            fmt = seq.getSettings().videoDisplayFormat;
        } catch (e1) {}
        var zero = 0;
        try {
            zero = adr_num(seq.zeroPoint);
        } catch (e2) {}
        var seqEnd = 0;
        try {
            seqEnd = adr_num(seq.end);
        } catch (e3) {}
        var inSec = -1;
        var outSec = -1;
        try {
            inSec = parseFloat(String(seq.getInPoint()));
            outSec = parseFloat(String(seq.getOutPoint()));
        } catch (e4) {}
        if (isNaN(inSec)) inSec = -1;
        if (isNaN(outSec)) outSec = -1;

        var video = [];
        var audio = [];
        var finger = [];
        var contentEnd = 0;
        var i, t, n, end;

        for (i = 0; i < seq.videoTracks.numTracks; i++) {
            t = seq.videoTracks[i];
            n = t.clips.numItems;
            end = n ? adr_num(t.clips[n - 1].end.ticks) : 0;
            if (end > contentEnd) contentEnd = end;
            video.push({
                index: i,
                name: String(t.name),
                clips: n,
                locked: adr_bool(function () { return t.isLocked(); })
            });
            finger.push('V' + i + ':' + n + ':' + end);
        }
        for (i = 0; i < seq.audioTracks.numTracks; i++) {
            t = seq.audioTracks[i];
            n = t.clips.numItems;
            end = n ? adr_num(t.clips[n - 1].end.ticks) : 0;
            if (end > contentEnd) contentEnd = end;
            audio.push({
                index: i,
                name: String(t.name),
                clips: n,
                locked: adr_bool(function () { return t.isLocked(); }),
                muted: adr_bool(function () { return t.isMuted(); })
            });
            finger.push('A' + i + ':' + n + ':' + end);
        }

        var appPath = '';
        try {
            appPath = String(app.path);
        } catch (e5) {}

        return adr_json({
            ok: true,
            version: ADR_VERSION,
            appVersion: String(app.version),
            appPath: appPath,
            sequence: {
                name: String(seq.name),
                id: String(seq.sequenceID),
                timebase: tb,
                displayFormat: fmt,
                zeroTicks: zero,
                endTicks: seqEnd,
                contentEndTicks: contentEnd,
                inSec: inSec,
                outSec: outSec,
                fingerprint: finger.join('|')
            },
            video: video,
            audio: audio
        });
    } catch (e) {
        return adr_fail('EXCEPTION', 'getInfo : ' + e.toString());
    }
}

/** Fusionne des intervalles [debut, fin] qui se touchent ou se chevauchent. */
function adr_mergeSpans(spans, tol) {
    spans.sort(function (a, b) { return a[0] - b[0]; });
    var out = [];
    for (var i = 0; i < spans.length; i++) {
        var last = out.length ? out[out.length - 1] : null;
        if (last && spans[i][0] <= last[1] + tol) {
            if (spans[i][1] > last[1]) last[1] = spans[i][1];
        } else {
            out.push([spans[i][0], spans[i][1]]);
        }
    }
    return out;
}

/**
 * Plan de la timeline pour l'ecran "Sections" : ou chaque piste audio porte
 * des clips, et quelles plages de temps couvrent les clips selectionnes.
 * Plus couteux que ADR_getInfo (il lit chaque clip) : a n'appeler qu'a la
 * demande.
 */
function ADR_getLayout() {
    try {
        if (!app.project) return adr_fail('NO_PROJECT', 'Aucun projet ouvert.');
        var seq = app.project.activeSequence;
        if (!seq) return adr_fail('NO_SEQUENCE', 'Aucune sequence active.');
        var tb = adr_num(seq.timebase);
        var tol = Math.floor(tb / 4);
        var audio = [];
        var i, j, s, e, clips, n;

        for (i = 0; i < seq.audioTracks.numTracks; i++) {
            clips = seq.audioTracks[i].clips;
            n = clips.numItems;
            var spans = [];
            for (j = 0; j < n; j++) {
                s = adr_num(clips[j].start.ticks);
                e = adr_num(clips[j].end.ticks);
                if (e > s) spans.push([s, e]);
            }
            audio.push({ index: i, spans: adr_mergeSpans(spans, tol) });
        }

        var video = [];
        for (i = 0; i < seq.videoTracks.numTracks; i++) {
            clips = seq.videoTracks[i].clips;
            n = clips.numItems;
            var vspans = [];
            for (j = 0; j < n; j++) {
                s = adr_num(clips[j].start.ticks);
                e = adr_num(clips[j].end.ticks);
                if (e > s) vspans.push([s, e]);
            }
            video.push({ index: i, spans: adr_mergeSpans(vspans, tol) });
        }

        // Clips selectionnes : l'API directe d'abord, sinon on interroge chaque clip.
        var sel = [];
        var direct = false;
        try {
            var items = seq.getSelection();
            if (items && typeof items.length === 'number') {
                direct = true;
                for (i = 0; i < items.length; i++) {
                    try {
                        s = adr_num(items[i].start.ticks);
                        e = adr_num(items[i].end.ticks);
                        if (e > s && s >= 0) sel.push([s, e]);
                    } catch (eI) {}
                }
            }
        } catch (eS) {}
        if (!direct) {
            var groups = [seq.videoTracks, seq.audioTracks];
            for (var g = 0; g < 2; g++) {
                for (i = 0; i < groups[g].numTracks; i++) {
                    clips = groups[g][i].clips;
                    n = clips.numItems;
                    for (j = 0; j < n; j++) {
                        var c = clips[j];
                        if (adr_bool(function () { return c.isSelected(); })) {
                            sel.push([adr_num(c.start.ticks), adr_num(c.end.ticks)]);
                        }
                    }
                }
            }
        }

        return adr_json({
            ok: true,
            audio: audio,
            video: video,
            selectedCount: sel.length,
            selection: adr_mergeSpans(sel, tol)
        });
    } catch (e2) {
        return adr_fail('EXCEPTION', 'getLayout : ' + e2.toString());
    }
}

/** Place la tete de lecture (ticks depuis le debut de la sequence). */
function ADR_setPlayhead(ticks) {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return adr_fail('NO_SEQUENCE', 'Aucune sequence active.');
        seq.setPlayerPosition(String(ticks));
        return adr_json({ ok: true });
    } catch (e) {
        return adr_fail('EXCEPTION', 'setPlayhead : ' + e.toString());
    }
}

// ---------------------------------------------------------------- export audio

function adr_restoreMutes(seq, restore) {
    for (var i = 0; i < restore.length; i++) {
        try {
            seq.audioTracks[restore[i][0]].setMute(restore[i][1] ? 1 : 0);
        } catch (e) {}
    }
}

/**
 * Exporte l'audio de la sequence en WAV, limite aux pistes choisies.
 *
 * Premiere n'expose aucun echantillon audio aux scripts : on lui demande donc
 * un export, exactement ce qu'on entend sur la timeline (vitesse, effets,
 * sequences imbriquees compris). Les autres pistes sont rendues muettes le
 * temps de l'export, puis remises dans leur etat d'origine quoi qu'il arrive.
 *
 * @param outPath     fichier WAV a ecrire
 * @param presetPath  preconfiguration d'export (.epr) WAV
 * @param useInOut    '1' : entre les points d'entree et de sortie ; '0' : tout
 * @param tracksCsv   indices des pistes audio a garder, ex. '0,2'
 */
function ADR_exportAudio(outPath, presetPath, useInOut, tracksCsv) {
    var seq = null;
    var restore = [];
    try {
        seq = app.project.activeSequence;
        if (!seq) return adr_fail('NO_SEQUENCE', 'Aucune sequence active.');

        var preset = new File(presetPath);
        if (!preset.exists) {
            return adr_fail('NO_PRESET', 'Preconfiguration d export introuvable : ' + presetPath);
        }

        var want = {};
        var parts = String(tracksCsv).split(',');
        var i;
        for (i = 0; i < parts.length; i++) {
            if (parts[i] !== '') want[parseInt(parts[i], 10)] = true;
        }

        for (i = 0; i < seq.audioTracks.numTracks; i++) {
            var tr = seq.audioTracks[i];
            var muted = adr_bool(function () { return tr.isMuted(); });
            var shouldMute = want[i] ? false : true;
            if (muted !== shouldMute) {
                try {
                    tr.setMute(shouldMute ? 1 : 0);
                    restore.push([i, muted]);
                } catch (eM) {}
            }
        }

        var result = '';
        try {
            result = String(seq.exportAsMediaDirect(outPath, presetPath, String(useInOut) === '1' ? 1 : 0));
        } catch (eX) {
            result = 'EXCEPTION ' + eX.toString();
        }

        adr_restoreMutes(seq, restore);
        restore = [];

        var out = new File(outPath);
        if (!out.exists || !(out.length > 44)) {
            return adr_fail('EXPORT_FAILED', 'L export audio n a rien produit (' + result + ').', {
                result: result
            });
        }
        return adr_json({ ok: true, result: result, bytes: out.length });
    } catch (e) {
        if (seq) adr_restoreMutes(seq, restore);
        return adr_fail('EXCEPTION', 'exportAudio : ' + e.toString());
    }
}

// ------------------------------------------------------------------------ plan

/**
 * Le plan arrive dans un fichier texte, une information par ligne :
 *   cle=valeur            reglage
 *   V <debut> <fin>       plage a retirer sur les pistes video, en images
 *   A <debut> <fin>       plage a retirer sur les pistes audio, en images
 * Pas de JSON a evaluer : rien de ce fichier n'est execute.
 */
function adr_parsePlan(text) {
    var plan = {
        mode: 'delete',
        seqId: '',
        timebase: 0,
        backup: false,
        backupName: '',
        detect: {},
        outFrame: -1,
        V: [],
        A: []
    };
    var lines = String(text).split('\n');
    for (var i = 0; i < lines.length; i++) {
        var ln = lines[i].replace(/\r/g, '');
        if (!ln) continue;
        var c = ln.charAt(0);
        if ((c === 'V' || c === 'A') && ln.charAt(1) === ' ') {
            var p = ln.split(' ');
            var a = parseInt(p[1], 10);
            var b = parseInt(p[2], 10);
            if (!isNaN(a) && !isNaN(b) && b > a) plan[c].push([a, b]);
            continue;
        }
        var eq = ln.indexOf('=');
        if (eq <= 0) continue;
        var key = ln.substring(0, eq);
        var val = ln.substring(eq + 1);
        if (key === 'mode') plan.mode = val;
        else if (key === 'sequenceId') plan.seqId = val;
        else if (key === 'timebase') plan.timebase = adr_num(val);
        else if (key === 'backup') plan.backup = val === '1';
        else if (key === 'backupName') plan.backupName = val;
        else if (key === 'outFrame') plan.outFrame = parseInt(val, 10);
        else if (key === 'detectTracks') {
            var ids = val.split(',');
            for (var j = 0; j < ids.length; j++) {
                if (ids[j] !== '') plan.detect[parseInt(ids[j], 10)] = true;
            }
        }
    }
    return plan;
}

/** Plages en ticks, avec le cumul des durees retirees (pour les decalages). */
function adr_ticksList(frames, tb) {
    var out = [];
    var cum = 0;
    var prevEnd = -1;
    for (var i = 0; i < frames.length; i++) {
        var a = frames[i][0] * tb;
        var b = frames[i][1] * tb;
        if (a < prevEnd) return null; // plages non triees ou qui se chevauchent
        cum += b - a;
        out.push({ a: a, b: b, cum: cum });
        prevEnd = b;
    }
    return out;
}

function adr_bounds(sil) {
    var out = [];
    for (var i = 0; i < sil.length; i++) {
        if (!out.length || out[out.length - 1] !== sil[i].a) out.push(sil[i].a);
        out.push(sil[i].b);
    }
    return out;
}

/** Duree totale retiree avant l'instant t. */
function adr_removedBefore(sil, t, tol) {
    var lo = 0;
    var hi = sil.length;
    while (lo < hi) {
        var mid = (lo + hi) >> 1;
        if (sil[mid].b <= t + tol) lo = mid + 1;
        else hi = mid;
    }
    return lo > 0 ? sil[lo - 1].cum : 0;
}

/** Le clip [cs, ce] est-il entierement dans une plage a retirer ? */
function adr_inSilence(sil, cs, ce, tol) {
    var lo = 0;
    var hi = sil.length;
    while (lo < hi) {
        var mid = (lo + hi) >> 1;
        if (sil[mid].a <= cs + tol) lo = mid + 1;
        else hi = mid;
    }
    if (lo === 0) return false;
    var s = sil[lo - 1];
    return cs >= s.a - tol && ce <= s.b + tol;
}

function adr_snapshot(track) {
    var clips = track.clips;
    var n = clips.numItems;
    var s = [];
    var e = [];
    for (var i = 0; i < n; i++) {
        var c = clips[i];
        s.push(adr_num(c.start.ticks));
        e.push(adr_num(c.end.ticks));
    }
    return { n: n, s: s, e: e };
}

function adr_isOrdered(snap, tol) {
    for (var i = 1; i < snap.n; i++) {
        if (snap.s[i] < snap.e[i - 1] - tol) return false;
    }
    return true;
}

function adr_hasEditAt(track, tick, tol) {
    var clips = track.clips;
    var n = clips.numItems;
    for (var i = 0; i < n; i++) {
        if (adr_abs(adr_num(clips[i].start.ticks) - tick) <= tol) return true;
    }
    return false;
}

// -------------------------------------------------------------------- sauvegarde

/** Duplique la sequence et laisse la copie intacte dans le projet. */
function adr_backup(seq, name) {
    var seqs = app.project.sequences;
    var seen = {};
    var origId = String(seq.sequenceID);
    var i;
    for (i = 0; i < seqs.numSequences; i++) seen[String(seqs[i].sequenceID)] = true;

    seq.clone();

    var created = null;
    seqs = app.project.sequences;
    for (i = 0; i < seqs.numSequences; i++) {
        if (!seen[String(seqs[i].sequenceID)]) {
            created = seqs[i];
            break;
        }
    }
    if (!created) return { ok: false, name: '' };

    try {
        if (name) created.name = name;
    } catch (eN) {}

    // Si Premiere a bascule sur la copie, on revient sur l'originale : c'est
    // elle qu'on coupe, la copie doit rester telle quelle.
    var act = app.project.activeSequence;
    if (!act || String(act.sequenceID) !== origId) {
        try {
            app.project.openSequence(origId);
        } catch (eO) {}
        act = app.project.activeSequence;
        if (!act || String(act.sequenceID) !== origId) {
            try {
                app.project.activeSequence = seq;
            } catch (eA) {}
        }
    }
    var name2 = '';
    try {
        name2 = String(created.name);
    } catch (eN2) {}
    return { ok: true, name: name2 };
}

// ------------------------------------------------------------------- demarrage

/**
 * Prepare la decoupe : lit le plan, verifie la sequence, fait la sauvegarde.
 * Ne modifie pas encore la timeline (hors duplication de sauvegarde).
 */
function ADR_begin(planPath) {
    try {
        ADR_state = null;

        var text = adr_readText(planPath);
        if (text === null) return adr_fail('NO_PLAN', 'Plan illisible : ' + planPath);
        var plan = adr_parsePlan(text);

        if (!app.project) return adr_fail('NO_PROJECT', 'Aucun projet ouvert.');
        var seq = app.project.activeSequence;
        if (!seq) return adr_fail('NO_SEQUENCE', 'Aucune sequence active.');
        if (plan.seqId && String(seq.sequenceID) !== plan.seqId) {
            return adr_fail('SEQ_CHANGED', 'La sequence active n est plus celle qui a ete analysee.');
        }

        var tb = adr_num(seq.timebase);
        if (!(tb > 0)) return adr_fail('NO_TIMEBASE', 'Cadence de la sequence illisible.');
        if (plan.timebase && plan.timebase !== tb) {
            return adr_fail('SEQ_CHANGED', 'La cadence de la sequence a change depuis l analyse.');
        }

        var silV = adr_ticksList(plan.V, tb);
        var silA = adr_ticksList(plan.A, tb);
        if (silV === null || silA === null) return adr_fail('BAD_PLAN', 'Plan incoherent (plages non triees).');
        if (!silV.length && !silA.length) return adr_fail('EMPTY_PLAN', 'Aucun silence a couper.');

        try {
            app.enableQE();
        } catch (eQ) {}
        if (typeof qe === 'undefined' || !qe || !qe.project) {
            return adr_fail('NO_QE', 'L outil de decoupe de Premiere (QE) est indisponible.');
        }

        var backupName = '';
        if (plan.backup) {
            var bk = adr_backup(seq, plan.backupName);
            if (!bk.ok) {
                return adr_fail('BACKUP_FAILED',
                    'La duplication de sauvegarde a echoue : rien n a ete coupe.');
            }
            backupName = bk.name;
            seq = app.project.activeSequence;
            if (!seq || String(seq.sequenceID) !== plan.seqId) {
                return adr_fail('SEQ_CHANGED',
                    'Premiere a change de sequence pendant la sauvegarde. Reclique dans la timeline a couper, puis relance.',
                    { backupName: backupName });
            }
        }

        var qeSeq = qe.project.getActiveSequence();
        if (!qeSeq) return adr_fail('NO_QE', 'Aucune sequence active cote decoupe (QE).', { backupName: backupName });
        if (String(qeSeq.name) !== String(seq.name)) {
            return adr_fail('QE_MISMATCH',
                'Premiere pointe sur deux sequences differentes. Clique dans la timeline a couper, puis relance.',
                { backupName: backupName });
        }

        var fmt = 0;
        var frameRate = null;
        try {
            var st = seq.getSettings();
            fmt = st.videoDisplayFormat;
            frameRate = st.videoFrameRate;
        } catch (eS) {}
        var zero = 0;
        try {
            zero = adr_num(seq.zeroPoint);
        } catch (eZ) {}

        var S = {
            plan: plan,
            seq: seq,
            qeSeq: qeSeq,
            tb: tb,
            tol: Math.floor(tb / 4),
            fps: ADR_TPS / tb,
            fmt: fmt,
            frameRate: frameRate,
            zero: zero,
            sil: { V: silV, A: silA },
            bounds: { V: adr_bounds(silV), A: adr_bounds(silA) },
            tracks: [],
            lockedSkipped: [],
            phase: 'scan',
            ti: 0,
            oi: 0,
            ci: 0,
            ki: 0,
            razorMethod: null,
            tcMethods: [],
            moveMethod: null,
            probeDone: false,
            forceMove: false,
            razorTotal: 0,
            razorDone: 0,
            razorFailed: 0,
            unsplit: 0,
            removed: 0,
            moved: 0,
            mismatch: 0,
            mismatchNotes: [],
            error: null,
            errorCode: null,
            backupName: backupName,
            log: [],
            t0: adr_now()
        };

        if (frameRate) S.tcMethods.push('F1');
        S.tcMethods.push('M1');
        if (zero !== 0) {
            if (frameRate) S.tcMethods.push('F0');
            S.tcMethods.push('M0');
        }

        var labels = [];
        var i, t;
        var onlyDetect = plan.mode === 'mute';

        if (!onlyDetect) {
            for (i = 0; i < seq.videoTracks.numTracks; i++) {
                t = seq.videoTracks[i];
                if (!t.clips.numItems) continue;
                if (adr_bool(function () { return t.isLocked(); })) {
                    S.lockedSkipped.push('V' + (i + 1));
                    continue;
                }
                S.tracks.push({ kind: 'V', index: i, label: 'V' + (i + 1), dom: t, qe: qeSeq.getVideoTrackAt(i) });
                labels.push('V' + (i + 1));
            }
        }
        for (i = 0; i < seq.audioTracks.numTracks; i++) {
            t = seq.audioTracks[i];
            if (!t.clips.numItems) continue;
            if (onlyDetect && !plan.detect[i]) continue;
            if (adr_bool(function () { return t.isLocked(); })) {
                S.lockedSkipped.push('A' + (i + 1));
                continue;
            }
            S.tracks.push({ kind: 'A', index: i, label: 'A' + (i + 1), dom: t, qe: qeSeq.getAudioTrackAt(i) });
            labels.push('A' + (i + 1));
        }

        if (!S.tracks.length) {
            return adr_fail('NO_TRACKS', 'Aucune piste deverrouillee a couper.', { backupName: backupName });
        }

        S.log.push('FirstCut ' + ADR_VERSION + ' - Premiere ' + String(app.version));
        S.log.push('sequence : ' + String(seq.name) + '  cadence : ' + S.fps + ' i/s  format : ' + fmt);
        S.log.push('mode : ' + plan.mode + '  plages : ' + silA.length + ' audio, ' + silV.length + ' video');
        S.log.push('pistes : ' + labels.join(' ') +
                   (S.lockedSkipped.length ? '  (verrouillees ignorees : ' + S.lockedSkipped.join(' ') + ')' : ''));
        if (backupName) S.log.push('sauvegarde : ' + backupName);

        S.relinked = 0;
        S.relinkFailed = 0;
        S.linkOk = 0;
        S.relinkTodo = [];
        S.relinkSeen = {};
        S.ourSelection = [];
        adr_recordLinks(S);
        S.log.push('liens image / son : ' + (S.linkApi ? S.linkPairs + ' couple(s) a conserver' : 'API de liaison indisponible'));

        ADR_state = S;
        return adr_json({
            ok: true,
            tracks: labels,
            lockedSkipped: S.lockedSkipped,
            backupName: backupName
        });
    } catch (e) {
        ADR_state = null;
        return adr_fail('EXCEPTION', 'begin : ' + e.toString() + (e.line ? ' (ligne ' + e.line + ')' : ''));
    }
}

// ----------------------------------------------------------------------- etapes

function adr_stop(S, code, message) {
    S.phase = 'error';
    S.errorCode = code;
    S.error = message;
    S.log.push('ARRET [' + code + '] ' + message);
}

/** Etape 1 : photographie d'une piste et liste de ses points de coupe. */
function adr_unitScan(S) {
    var T = S.tracks[S.ti];
    var pre = adr_snapshot(T.dom);
    if (!adr_isOrdered(pre, S.tol)) {
        adr_stop(S, 'UNORDERED', 'Les clips de la piste ' + T.label + ' ne sont pas dans l ordre attendu.');
        return;
    }
    T.pre = pre;

    var B = S.bounds[T.kind];
    var ops = [];
    var i, k;
    for (i = 0; i < pre.n; i++) {
        var cs = pre.s[i];
        var ce = pre.e[i];
        k = adr_lowerBound(B, cs + S.tol);
        while (k < B.length && B[k] < ce - S.tol) {
            if (B[k] > cs + S.tol) ops.push(B[k]);
            k++;
        }
    }
    T.ops = ops;
    S.razorTotal += ops.length;

    // Une piste "a trous" a du contenu apres un silence qu'elle ne couvre pas
    // entierement. La suppression avec resserrement, qui decale une piste de la
    // duree de ce qu'on lui enleve, la laisserait en retard sur les autres :
    // on la traitera en deplacant ses clips nous-memes.
    T.gappy = false;
    if (S.plan.mode === 'delete' && pre.n) {
        var sil = S.sil[T.kind];
        var lastEnd = pre.e[pre.n - 1];
        var ci = 0;
        for (var j = 0; j < sil.length; j++) {
            var a = sil[j].a;
            var b = sil[j].b;
            if (lastEnd <= b + S.tol) break;
            while (ci < pre.n && pre.e[ci] <= a) ci++;
            var cov = 0;
            k = ci;
            while (k < pre.n && pre.s[k] < b) {
                var lo = pre.s[k] > a ? pre.s[k] : a;
                var hi = pre.e[k] < b ? pre.e[k] : b;
                if (hi > lo) cov += hi - lo;
                k++;
            }
            if (cov < b - a - S.tol) {
                T.gappy = true;
                break;
            }
        }
    }

    S.ti++;
    if (S.ti >= S.tracks.length) {
        S.phase = 'razor';
        S.ti = 0;
        S.oi = 0;
    }
}

/** Pose un point de montage sur une piste. Rend vrai si la piste a un clip de plus. */
function adr_razor(S, T, tick) {
    var before = T.dom.clips.numItems;
    var methods = S.razorMethod ? [S.razorMethod] : S.tcMethods;
    for (var m = 0; m < methods.length; m++) {
        var tc = adr_tc(S, tick, methods[m]);
        if (!tc) continue;
        try {
            T.qe.razor(tc);
        } catch (e) {
            S.lastRazorError = e.toString();
            continue;
        }
        if (T.dom.clips.numItems > before) {
            if (!S.razorMethod) {
                // Premier succes : on verifie que la coupe est bien tombee ou on
                // l'a demandee, pas seulement qu'il y a un clip de plus.
                if (!adr_hasEditAt(T.dom, tick, S.tol)) {
                    adr_stop(S, 'RAZOR_MISPLACED',
                        'Le rasoir a coupe ailleurs que prevu (timecode ' + tc + '). Arret avant toute suppression.');
                    return false;
                }
                S.razorMethod = methods[m];
                S.log.push('rasoir : methode ' + methods[m] + ', exemple ' + tc);
            }
            return true;
        }
    }
    return false;
}

/** Etape 2 : un point de coupe. */
function adr_unitRazor(S) {
    if (S.ti >= S.tracks.length) {
        S.phase = 'rescan';
        S.ti = 0;
        return;
    }
    var T = S.tracks[S.ti];
    if (S.oi >= T.ops.length) {
        S.ti++;
        S.oi = 0;
        return;
    }
    var tick = T.ops[S.oi++];
    var ok = adr_razor(S, T, tick);
    if (S.phase === 'error') return;
    S.razorDone++;
    if (!ok) {
        S.razorFailed++;
        if (!S.razorMethod && S.razorFailed >= 3) {
            adr_stop(S, 'RAZOR_FAILED',
                'Premiere refuse les points de coupe (rasoir sans effet' +
                (S.lastRazorError ? ' : ' + S.lastRazorError : '') + '). Rien n a ete supprime.');
        }
    }
}

/** Etape 3 : controle des coupes et tri des morceaux a retirer. */
function adr_unitRescan(S) {
    var T = S.tracks[S.ti];
    var post = adr_snapshot(T.dom);
    if (!adr_isOrdered(post, S.tol)) {
        adr_stop(S, 'UNORDERED', 'Les clips de la piste ' + T.label + ' ne sont plus dans l ordre attendu.');
        return;
    }
    T.post = post;

    var B = S.bounds[T.kind];
    var sil = S.sil[T.kind];
    var removing = S.plan.mode !== 'keep';
    var ripple = S.plan.mode === 'delete';
    var unsplit = 0;
    var silent = [];
    var expS = [];
    var expE = [];
    var keptOrig = [];
    var nSilent = 0;

    for (var i = 0; i < post.n; i++) {
        var cs = post.s[i];
        var ce = post.e[i];
        var k = adr_lowerBound(B, cs + S.tol);
        while (k < B.length && B[k] < ce - S.tol) {
            if (B[k] > cs + S.tol) unsplit++;
            k++;
        }
        var isSilent = removing && adr_inSilence(sil, cs, ce, S.tol);
        silent.push(isSilent);
        if (isSilent) {
            nSilent++;
        } else {
            var shift = ripple ? adr_removedBefore(sil, cs, S.tol) : 0;
            expS.push(cs - shift);
            expE.push(ce - shift);
            keptOrig.push(cs);
        }
    }

    T.silent = silent;
    T.nSilent = nSilent;
    T.exp = { s: expS, e: expE };
    T.keptOrig = keptOrig;
    T.unsplit = unsplit;
    T.removed = 0;
    S.unsplit += unsplit;
    S.log.push(T.label + ' : ' + T.pre.n + ' clips -> ' + post.n + ' apres decoupe, ' + nSilent +
               ' a retirer' + (T.gappy ? ', piste a trous (deplacement manuel)' : '') +
               (unsplit ? ', ' + unsplit + ' COUPE(S) MANQUANTE(S)' : ''));

    S.ti++;
    if (S.ti < S.tracks.length) return;

    if (S.unsplit > 0 && removing) {
        adr_stop(S, 'RAZOR_INCOMPLETE',
            S.unsplit + ' point(s) de coupe n ont pas pu etre poses. Rien n a ete supprime : ' +
            'la timeline contient seulement des coupes en plus.');
        return;
    }
    if (!removing) {
        S.phase = 'verify';
        S.ti = 0;
        return;
    }
    S.phase = 'remove';
    S.ti = 0;
    S.ci = S.tracks[0].post.n - 1;
}

/** Un autre piste non encore traitee, pour verifier qu'on ne la touche pas. */
function adr_witness(S, ti) {
    for (var i = ti + 1; i < S.tracks.length; i++) {
        if (S.tracks[i].post.n) return S.tracks[i];
    }
    return null;
}

/** Etape 4 : un clip (parcours de la fin vers le debut de chaque piste). */
function adr_unitRemove(S) {
    if (S.ci < 0) {
        S.ti++;
        if (S.ti >= S.tracks.length) {
            S.phase = S.plan.mode === 'delete' ? 'move' : 'verify';
            S.ti = 0;
            S.ki = 0;
            return;
        }
        S.ci = S.tracks[S.ti].post.n - 1;
        return;
    }

    var T = S.tracks[S.ti];
    var i = S.ci--;
    if (!T.silent[i]) return;

    var ripple = S.plan.mode === 'delete' && !T.gappy && !S.forceMove;
    var clips = T.dom.clips;
    var n0 = clips.numItems;
    if (i >= n0) {
        adr_stop(S, 'UNEXPECTED_STATE', 'Piste ' + T.label + ' : il manque des clips (un autre outil modifie la timeline ?).');
        return;
    }
    var c = clips[i];
    var cs = adr_num(c.start.ticks);
    var ce = adr_num(c.end.ticks);
    // A rebours, rien de ce qui precede n'a bouge : le clip doit etre exactement
    // la ou la photographie l'a vu. Sinon on s'arrete plutot que de retirer le
    // mauvais morceau.
    if (adr_abs(cs - T.post.s[i]) > S.tol || adr_abs(ce - T.post.e[i]) > S.tol) {
        adr_stop(S, 'UNEXPECTED_STATE',
            'Piste ' + T.label + ' : un clip n est plus a sa place. Arret pour ne rien abimer.');
        return;
    }

    // Premiere suppression avec resserrement : on verifie sur pieces ce que
    // fait reellement Premiere avant de continuer.
    var probe = ripple && !S.probeDone && i + 1 < n0;
    var nextStart = 0;
    var W = null;
    var wN = 0;
    var wEnd = 0;
    if (probe) {
        nextStart = adr_num(clips[i + 1].start.ticks);
        W = adr_witness(S, S.ti);
        if (W) {
            wN = W.dom.clips.numItems;
            wEnd = adr_trackEnd(W.dom);
        }
    }

    try {
        c.remove(ripple, false);
    } catch (eR) {
        adr_stop(S, 'REMOVE_FAILED', 'Piste ' + T.label + ' : suppression refusee (' + eR.toString() + ').');
        return;
    }

    var n1 = T.dom.clips.numItems;
    if (n1 !== n0 - 1) {
        adr_stop(S, 'REMOVE_FAILED',
            'Piste ' + T.label + ' : la suppression n a pas eu l effet attendu (' + n0 + ' -> ' + n1 + ' clips).');
        return;
    }
    T.removed++;
    S.removed++;

    if (probe) {
        S.probeDone = true;
        if (W && (W.dom.clips.numItems !== wN || adr_abs(adr_trackEnd(W.dom) - wEnd) > S.tol)) {
            adr_stop(S, 'RIPPLE_GLOBAL',
                'La suppression sur ' + T.label + ' a aussi modifie ' + W.label +
                ' : comportement inattendu de Premiere, arret immediat.');
            return;
        }
        var ns = adr_num(T.dom.clips[i].start.ticks);
        if (adr_abs(ns - (nextStart - (ce - cs))) <= S.tol) {
            S.log.push('resserrement : natif (verifie sur ' + T.label + ')');
        } else if (adr_abs(ns - nextStart) <= S.tol) {
            // Premiere a retire le clip sans resserrer : on fermera les trous
            // nous-memes, piste par piste. Rien n'a encore bouge, donc aucun
            // rattrapage a faire.
            S.forceMove = true;
            S.log.push('resserrement : non applique par Premiere, deplacement manuel des clips');
        } else {
            adr_stop(S, 'RIPPLE_UNEXPECTED',
                'Piste ' + T.label + ' : decalage inattendu apres suppression. Arret immediat.');
        }
    }
}

/** Deplace un clip de `delta` ticks et rend sa nouvelle position de depart. */
function adr_moveClip(S, T, k, delta, from) {
    var methods = S.moveMethod ? [S.moveMethod] : ['ticks', 'seconds', 'number'];
    for (var m = 0; m < methods.length; m++) {
        try {
            var c = T.dom.clips[k];
            if (methods[m] === 'number') {
                c.move(delta / ADR_TPS);
            } else {
                var t = new Time();
                if (methods[m] === 'ticks') t.ticks = String(delta);
                else t.seconds = delta / ADR_TPS;
                c.move(t);
            }
        } catch (e) {
            S.lastMoveError = e.toString();
        }
        var now = adr_num(T.dom.clips[k].start.ticks);
        if (adr_abs(now - from) > S.tol) {
            if (!S.moveMethod) {
                S.moveMethod = methods[m];
                S.log.push('deplacement : methode ' + methods[m]);
            }
            return now;
        }
    }
    return from;
}

/** Etape 5 : fermeture des trous sur les pistes non resserrees par Premiere. */
function adr_unitMove(S) {
    if (S.ti >= S.tracks.length) {
        S.phase = 'verify';
        S.ti = 0;
        return;
    }
    var T = S.tracks[S.ti];
    if (!(T.gappy || S.forceMove) || S.ki >= T.exp.s.length) {
        S.ti++;
        S.ki = 0;
        return;
    }
    // Du debut vers la fin : chaque clip recule dans l'espace que les
    // precedents viennent de liberer, il ne peut donc rien ecraser.
    var k = S.ki++;
    var target = T.exp.s[k];
    var orig = T.keptOrig[k];
    if (adr_abs(target - orig) <= S.tol) return;

    if (k >= T.dom.clips.numItems) {
        adr_stop(S, 'UNEXPECTED_STATE', 'Piste ' + T.label + ' : il manque des clips pendant le resserrement.');
        return;
    }
    var cur = adr_num(T.dom.clips[k].start.ticks);
    if (adr_abs(cur - target) <= S.tol) return; // deja en place
    if (adr_abs(cur - orig) > S.tol) {
        adr_stop(S, 'UNEXPECTED_STATE',
            'Piste ' + T.label + ' : un clip a bouge tout seul pendant le resserrement. Arret immediat.');
        return;
    }
    var now = adr_moveClip(S, T, k, target - cur, cur);
    if (adr_abs(now - target) > S.tol) {
        adr_stop(S, 'MOVE_FAILED',
            'Piste ' + T.label + ' : impossible de deplacer un clip pour fermer un trou' +
            (S.lastMoveError ? ' (' + S.lastMoveError + ')' : '') + '. Les silences sont retires mais des trous restent.');
        return;
    }
    S.moved++;
}

/** Etape 6 : la timeline obtenue est-elle celle qu'on attendait ? */
function adr_unitVerify(S) {
    var T = S.tracks[S.ti];
    var fin = adr_snapshot(T.dom);
    var bad = 0;
    if (fin.n !== T.exp.s.length) {
        bad = adr_abs(fin.n - T.exp.s.length);
        if (S.mismatchNotes.length < 12) {
            S.mismatchNotes.push(T.label + ' : ' + fin.n + ' clips au lieu de ' + T.exp.s.length);
        }
    } else {
        for (var i = 0; i < fin.n; i++) {
            if (adr_abs(fin.s[i] - T.exp.s[i]) > S.tol || adr_abs(fin.e[i] - T.exp.e[i]) > S.tol) {
                bad++;
                if (S.mismatchNotes.length < 12) {
                    S.mismatchNotes.push(T.label + ' clip ' + (i + 1) + ' : debut ' +
                        (fin.s[i] / ADR_TPS).toFixed(3) + ' s au lieu de ' + (T.exp.s[i] / ADR_TPS).toFixed(3) + ' s');
                }
            }
        }
    }
    T.mismatch = bad;
    S.mismatch += bad;
    S.ti++;
    if (S.ti >= S.tracks.length) {
        S.phase = 'relink';
        S.ti = 0;
        S.oi = 0;
    }
}

// ------------------------------------------------------------- liens image / son
//
// Premiere peut perdre le lien entre un clip video et son audio quand les
// pistes sont coupees separement. Avant toute modification, on note quels
// clips video sont lies a quels clips audio : pistes, media source et decalage
// de synchro entre les deux. Apres la coupe, chaque morceau video est relie
// aux morceaux audio qui ont le meme debut, la meme fin et la meme synchro
// d'origine. Un morceau deja correctement lie n'est pas touche.

function adr_nodeId(clip) {
    try {
        var p = clip.projectItem;
        if (p) {
            var id = p.nodeId;
            if (id) return String(id);
            var mp = p.getMediaPath();
            if (mp) return String(mp);
            return String(p.name);
        }
    } catch (e) {}
    return '';
}

function adr_inTicks(clip) {
    try {
        return adr_num(clip.inPoint.ticks);
    } catch (e) {}
    return 0;
}

function adr_isAudioItem(item) {
    try {
        var t = String(item.mediaType);
        if (t) return /audio/i.test(t);
    } catch (e) {}
    return false;
}

/** Couple video / audio lie : pistes et sources. Survit a la coupe et au resserrement. */
function adr_pairBase(vIndex, aIndex, v, a) {
    return 'V' + vIndex + 'A' + aIndex + '|' + adr_nodeId(v) + '|' + adr_nodeId(a);
}

/** Decalage de synchro entre la video et l'audio d'un couple (ticks). */
function adr_pairDelta(v, a) {
    return (adr_inTicks(v) - adr_num(v.start.ticks)) - (adr_inTicks(a) - adr_num(a.start.ticks));
}

// Ecart de synchro accepte entre un couple note et un morceau : Premiere cale
// le point d'entree d'une camera sur ses propres images (camera a 30 i/s dans
// une sequence a 60 i/s), ce qui fait bouger la synchro d'une ou deux images.
var ADR_LINK_SLACK = ADR_TPS / 4;

/**
 * Ces deux morceaux etaient-ils lies avant la coupe ? Memes pistes et memes
 * sources qu'un couple note. Le decalage de synchro ne sert qu'a departager
 * plusieurs couples des memes sources sur les memes pistes.
 */
function adr_wasLinked(S, vIndex, aIndex, v, a) {
    var list = S.linkKeys[adr_pairBase(vIndex, aIndex, v, a)];
    if (!list) return false;
    if (list.length === 1) return true;
    var d = adr_pairDelta(v, a);
    for (var i = 0; i < list.length; i++) {
        if (adr_abs(list[i] - d) <= ADR_LINK_SLACK) return true;
    }
    return false;
}

/** Note un couple ; rend true s'il est nouveau. */
function adr_notePair(S, vIndex, aIndex, v, a) {
    var base = adr_pairBase(vIndex, aIndex, v, a);
    var d = adr_pairDelta(v, a);
    var list = S.linkKeys[base];
    if (!list) {
        S.linkKeys[base] = [d];
        S.linkTracks['V' + (vIndex + 1) + '-A' + (aIndex + 1)] = true;
        return true;
    }
    for (var i = 0; i < list.length; i++) {
        if (adr_abs(list[i] - d) <= S.tb / 2) return false;
    }
    list.push(d);
    return true;
}

/** Piste video (parmi celles traitees) qui porte ce clip, ou -1. */
function adr_videoTrackOf(S, item) {
    var s = adr_num(item.start.ticks);
    var e = adr_num(item.end.ticks);
    var node = adr_nodeId(item);
    for (var t = 0; t < S.tracks.length; t++) {
        var T = S.tracks[t];
        if (T.kind !== 'V') continue;
        var clips = T.dom.clips;
        for (var i = 0; i < clips.numItems; i++) {
            var c = clips[i];
            if (adr_abs(adr_num(c.start.ticks) - s) <= S.tol && adr_abs(adr_num(c.end.ticks) - e) <= S.tol && adr_nodeId(c) === node) {
                return T.index;
            }
        }
    }
    return -1;
}

/**
 * Releve des liens avant la coupe. On part de chaque clip audio, dont on connait
 * la piste : deux pistes audio peuvent porter le meme son au meme endroit (double
 * mono), ce qu'une recherche par contenu ne saurait pas distinguer.
 */
function adr_recordLinks(S) {
    S.linkKeys = {};
    S.linkTracks = {};
    S.linkPairs = 0;
    S.linkApi = typeof S.seq.linkSelection === 'function' && typeof S.seq.unlinkSelection === 'function';
    if (!S.linkApi) return;
    for (var t = 0; t < S.tracks.length; t++) {
        var A = S.tracks[t];
        if (A.kind !== 'A') continue;
        var clips = A.dom.clips;
        for (var i = 0; i < clips.numItems; i++) {
            var a = clips[i];
            var li = null;
            try {
                li = a.getLinkedItems();
            } catch (e) {
                S.linkApi = false;
                return;
            }
            if (!li) continue;
            for (var j = 0; j < li.numItems; j++) {
                var v = li[j];
                if (adr_isAudioItem(v)) continue;
                var vi = adr_videoTrackOf(S, v);
                if (vi < 0) continue;
                if (adr_notePair(S, vi, A.index, v, a)) S.linkPairs++;
            }
        }
    }
}

function adr_clearSelection(seq) {
    try {
        var sel = seq.getSelection();
        for (var i = 0; sel && i < sel.length; i++) {
            try {
                sel[i].setSelected(false, false);
            } catch (e) {}
        }
    } catch (e2) {}
}


/** Clip d'une piste traitee aux bornes donnees (ticks), ou null. */
function adr_clipAt(S, kind, index, s, e) {
    for (var t = 0; t < S.tracks.length; t++) {
        var T = S.tracks[t];
        if (T.kind !== kind || T.index !== index) continue;
        var clips = T.dom.clips;
        for (var i = 0; i < clips.numItems; i++) {
            var c = clips[i];
            var cs = adr_num(c.start.ticks);
            if (cs > s + S.tol) break;
            if (adr_abs(cs - s) <= S.tol && adr_abs(adr_num(c.end.ticks) - e) <= S.tol) return c;
        }
    }
    return null;
}

/**
 * Selectionne exactement ces clips. La selection est faite et defaite clip par
 * clip, avec mise a jour de l'interface : selon les versions, Premiere ne
 * compte pas autrement les clips selectionnes par script, et un groupe pourrait
 * rester selectionne au moment de lier le suivant.
 */
function adr_selectOnly(S, items) {
    adr_deselectOurs(S);
    adr_clearSelection(S.seq);
    for (var i = 0; i < items.length; i++) {
        try {
            items[i].setSelected(true, true);
        } catch (e) {}
        S.ourSelection.push(items[i]);
    }
}

function adr_deselectOurs(S) {
    var list = S.ourSelection || [];
    for (var i = 0; i < list.length; i++) {
        try {
            list[i].setSelected(false, true);
        } catch (e) {}
    }
    S.ourSelection = [];
}

/**
 * Clips d'une piste traitee qui chevauchent [s, e] de plus que la tolerance.
 * Apres la coupe, toutes les pistes sont tranchees aux memes instants : deux
 * morceaux qui se chevauchent viennent du meme passage garde, meme si l'un
 * commence ou finit plus tard (camera lancee apres l'autre).
 */
function adr_clipsOver(S, kind, index, s, e) {
    var out = [];
    for (var t = 0; t < S.tracks.length; t++) {
        var T = S.tracks[t];
        if (T.kind !== kind || T.index !== index) continue;
        var clips = T.dom.clips;
        for (var i = 0; i < clips.numItems; i++) {
            var c = clips[i];
            var cs = adr_num(c.start.ticks);
            if (cs >= e - S.tol) break;
            var ce = adr_num(c.end.ticks);
            if (Math.min(ce, e) - Math.max(cs, s) > S.tol) out.push(c);
        }
    }
    return out;
}

/** Clips actuels d'un groupe (membres reperes par piste et bornes), ou null si l'un manque. */
function adr_groupItems(S, g) {
    var out = [];
    for (var i = 0; i < g.members.length; i++) {
        var m = g.members[i];
        var c = adr_clipAt(S, m.kind, m.index, m.s, m.e);
        if (!c) return null;
        out.push(c);
    }
    return out;
}

/** Identite d'un clip lue par getLinkedItems : type, source et bornes. */
function adr_sameClip(S, a, b) {
    return adr_isAudioItem(a) === adr_isAudioItem(b) && adr_nodeId(a) === adr_nodeId(b) &&
        adr_abs(adr_num(a.start.ticks) - adr_num(b.start.ticks)) <= S.tol &&
        adr_abs(adr_num(a.end.ticks) - adr_num(b.end.ticks)) <= S.tol;
}

/**
 * Le groupe est-il lie exactement comme il faut ? On lit les liens depuis un
 * clip video (unique a cette position) : il doit etre lie a tous les autres
 * membres, et a rien d'autre. Selon les versions, getLinkedItems compte ou non
 * le clip lui-meme : on l'ignore.
 */
function adr_groupExact(S, items) {
    var ref = null;
    for (var i = 0; i < items.length; i++) {
        if (!adr_isAudioItem(items[i])) {
            ref = items[i];
            break;
        }
    }
    if (!ref) return false;
    var li = null;
    try {
        li = ref.getLinkedItems();
    } catch (e) {
        return false;
    }
    if (!li) return false;
    var others = [];
    for (var j = 0; j < li.numItems; j++) {
        if (!adr_sameClip(S, li[j], ref)) others.push(li[j]);
    }
    if (others.length !== items.length - 1) return false;
    var used = [];
    for (var k = 0; k < items.length; k++) {
        if (items[k] === ref) continue;
        var hit = -1;
        for (var o = 0; o < others.length; o++) {
            if (!used[o] && adr_sameClip(S, others[o], items[k])) {
                hit = o;
                break;
            }
        }
        if (hit < 0) return false;
        used[hit] = true;
    }
    return true;
}

/**
 * Etape 1 de la liaison : reconstitue chaque groupe d'origine a chaque position.
 * Un groupe peut compter plusieurs videos (ex. webcam + capture d'ecran liees
 * ensemble) : on part d'un morceau video, on ajoute les morceaux audio qui lui
 * etaient lies, puis les autres videos liees a ces audios, et ainsi de suite.
 * Les groupes deja exacts sont laisses tels quels ; les autres sont notes par
 * positions (les objets de Premiere ne survivent pas aux changements de liens).
 */
function adr_unitRelink(S) {
    if (!S.linkApi || !S.linkPairs) {
        S.phase = 'done';
        return;
    }
    if (!S.relinkTodo) S.relinkTodo = [];
    if (!S.relinkSeen) S.relinkSeen = {};
    if (S.ti >= S.tracks.length) {
        S.phase = S.relinkTodo.length ? 'unlink' : 'done';
        S.ti = 0;
        return;
    }
    var T = S.tracks[S.ti];
    if (T.kind !== 'V' || S.oi >= T.dom.clips.numItems) {
        S.ti++;
        S.oi = 0;
        return;
    }
    var v = T.dom.clips[S.oi++];
    var vs = adr_num(v.start.ticks);
    var ve = adr_num(v.end.ticks);
    if (S.relinkSeen[adr_pieceKey(S, 'V', T.index, vs, ve)]) return;

    // Composante connexe autour de ce morceau : les morceaux qui le chevauchent
    // sur les autres pistes et qui etaient lies a lui avant la coupe, puis ceux
    // qui chevauchent ces derniers, etc. Les bornes peuvent differer d'une piste
    // a l'autre (camera 2 lancee apres la camera 1).
    var members = [{ kind: 'V', index: T.index, clip: v, s: vs, e: ve }];
    var inGroup = {};
    inGroup[adr_pieceKey(S, 'V', T.index, vs, ve)] = true;
    var t;
    for (var q = 0; q < members.length; q++) {
        var m = members[q];
        for (t = 0; t < S.tracks.length; t++) {
            var O = S.tracks[t];
            if (O.kind === m.kind) continue;
            var over = adr_clipsOver(S, O.kind, O.index, m.s, m.e);
            for (var n = 0; n < over.length; n++) {
                var c = over[n];
                var cs = adr_num(c.start.ticks);
                var ce = adr_num(c.end.ticks);
                var pk = adr_pieceKey(S, O.kind, O.index, cs, ce);
                if (inGroup[pk]) continue;
                var linked = m.kind === 'V'
                    ? adr_wasLinked(S, m.index, O.index, m.clip, c)
                    : adr_wasLinked(S, O.index, m.index, c, m.clip);
                if (!linked) continue;
                inGroup[pk] = true;
                members.push({ kind: O.kind, index: O.index, clip: c, s: cs, e: ce });
            }
        }
    }
    for (t = 0; t < members.length; t++) {
        if (members[t].kind === 'V') S.relinkSeen[adr_pieceKey(S, 'V', members[t].index, members[t].s, members[t].e)] = true;
    }
    if (members.length < 2) return;
    var items = [];
    for (t = 0; t < members.length; t++) items.push(members[t].clip);
    if (adr_groupExact(S, items)) {
        S.linkOk++;
        return;
    }
    var plain = [];
    for (t = 0; t < members.length; t++) plain.push({ kind: members[t].kind, index: members[t].index, s: members[t].s, e: members[t].e });
    S.relinkTodo.push({ members: plain, s: vs, e: ve, label: T.label });
}

/** Repere d'un morceau : piste et bornes arrondies a l'image. */
function adr_pieceKey(S, kind, index, s, e) {
    return kind + index + '@' + Math.round(s / S.tb) + ':' + Math.round(e / S.tb);
}

/** Etape 2 : delie d'un coup tout ce qui doit etre relie. */
function adr_unitUnlink(S) {
    var all = [];
    for (var i = 0; i < S.relinkTodo.length; i++) {
        var items = adr_groupItems(S, S.relinkTodo[i]);
        if (items) all = all.concat(items);
    }
    try {
        if (all.length) {
            adr_selectOnly(S, all);
            S.seq.unlinkSelection();
        }
    } catch (e) {
        S.mismatchNotes.push('liens : deliaison refusee (' + e.toString() + ')');
    }
    adr_deselectOurs(S);
    S.phase = 'link';
    S.ki = 0;
}

/** Etape 3 : un groupe, relie et verifie. */
function adr_unitLink(S) {
    if (S.ki >= S.relinkTodo.length) {
        adr_deselectOurs(S);
        adr_clearSelection(S.seq);
        S.phase = 'done';
        return;
    }
    var g = S.relinkTodo[S.ki++];
    var items = adr_groupItems(S, g);
    var ok = false;
    if (items) {
        try {
            adr_selectOnly(S, items);
            S.seq.linkSelection();
        } catch (e) {}
        adr_deselectOurs(S);
        ok = adr_groupExact(S, items);
    }
    if (ok) S.relinked++;
    else {
        S.relinkFailed++;
        if (S.mismatchNotes.length < 12) {
            S.mismatchNotes.push(g.label + ' ' + (g.s / ADR_TPS).toFixed(2) + ' s : lien image / son non retabli');
        }
    }
}

/** Pour le journal : morceaux lies a au moins un autre clip, par piste video. */
function adr_linkReport(S) {
    var out = [];
    for (var t = 0; t < S.tracks.length; t++) {
        var T = S.tracks[t];
        if (T.kind !== 'V') continue;
        var clips = T.dom.clips;
        var linked = 0;
        for (var i = 0; i < clips.numItems; i++) {
            try {
                var li = clips[i].getLinkedItems();
                var others = 0;
                for (var j = 0; li && j < li.numItems; j++) if (!adr_sameClip(S, li[j], clips[i])) others++;
                if (others) linked++;
            } catch (e) {}
        }
        out.push(T.label + ' ' + linked + '/' + clips.numItems);
    }
    return out.join(', ');
}

function adr_progress(S) {
    var done = 0;
    var total = 0;
    var i;
    if (S.phase === 'link' || S.phase === 'unlink') {
        done = S.ki || 0;
        total = Math.max(1, S.relinkTodo ? S.relinkTodo.length : 1);
    } else if (S.phase === 'relink') {
        for (i = 0; i < S.tracks.length; i++) {
            var nv = S.tracks[i].kind === 'V' ? S.tracks[i].dom.clips.numItems : 0;
            total += nv;
            if (i < S.ti) done += nv;
            else if (i === S.ti) done += S.oi;
        }
    } else if (S.phase === 'scan' || S.phase === 'rescan' || S.phase === 'verify') {
        done = S.ti;
        total = S.tracks.length;
    } else if (S.phase === 'razor') {
        done = S.razorDone;
        total = S.razorTotal;
    } else if (S.phase === 'remove') {
        for (i = 0; i < S.tracks.length; i++) {
            var n = S.tracks[i].post ? S.tracks[i].post.n : 0;
            total += n;
            if (i < S.ti) done += n;
            else if (i === S.ti) done += n - 1 - S.ci;
        }
    } else if (S.phase === 'move') {
        for (i = 0; i < S.tracks.length; i++) {
            var m = S.tracks[i].exp ? S.tracks[i].exp.s.length : 0;
            total += m;
            if (i < S.ti) done += m;
            else if (i === S.ti) done += S.ki;
        }
    } else {
        done = 1;
        total = 1;
    }
    return { done: done, total: total > 0 ? total : 1 };
}

/**
 * Avance le travail pendant `budgetMs` millisecondes au plus, puis rend la
 * main. Le panneau rappelle tant que `finished` est faux.
 */
function ADR_step(budgetMs) {
    var S = ADR_state;
    if (!S) return adr_fail('NO_STATE', 'Aucune decoupe en cours.');
    var budget = adr_num(budgetMs);
    if (!(budget > 0)) budget = 250;
    var t0 = adr_now();
    try {
        while (S.phase !== 'done' && S.phase !== 'error') {
            if (S.phase === 'scan') adr_unitScan(S);
            else if (S.phase === 'razor') adr_unitRazor(S);
            else if (S.phase === 'rescan') adr_unitRescan(S);
            else if (S.phase === 'remove') adr_unitRemove(S);
            else if (S.phase === 'move') adr_unitMove(S);
            else if (S.phase === 'verify') adr_unitVerify(S);
            else if (S.phase === 'relink') adr_unitRelink(S);
            else if (S.phase === 'unlink') adr_unitUnlink(S);
            else if (S.phase === 'link') adr_unitLink(S);
            else adr_stop(S, 'BAD_PHASE', 'Etat interne inconnu : ' + S.phase);
            if (adr_now() - t0 >= budget) break;
        }
    } catch (e) {
        adr_stop(S, 'EXCEPTION', 'Erreur pendant la phase ' + S.phase + ' : ' + e.toString() +
                 (e.line ? ' (ligne ' + e.line + ')' : ''));
    }
    var p = adr_progress(S);
    return adr_json({
        ok: true,
        phase: S.phase,
        done: p.done,
        total: p.total,
        finished: S.phase === 'done' || S.phase === 'error'
    });
}

/** Cloture : bilan, remise en place du point de sortie, liberation de l'etat. */
function ADR_finish() {
    var S = ADR_state;
    if (!S) return adr_fail('NO_STATE', 'Aucune decoupe en cours.');
    ADR_state = null;
    try {
        var complete = S.phase === 'done';
        var removedTicks = 0;
        if (complete && S.plan.mode === 'delete' && S.sil.A.length) {
            removedTicks = S.sil.A[S.sil.A.length - 1].cum;
        }

        // La zone entree / sortie raccourcit avec le montage : on recale la
        // sortie pour qu'elle designe toujours la fin de la zone traitee.
        var outMoved = false;
        if (complete && S.plan.mode === 'delete' && S.plan.outFrame >= 0 && removedTicks > 0 && S.mismatch === 0) {
            try {
                S.seq.setOutPoint((S.plan.outFrame * S.tb - removedTicks) / ADR_TPS);
                outMoved = true;
            } catch (eO) {}
        }

        S.log.push('coupes posees : ' + (S.razorDone - S.razorFailed) + ' / ' + S.razorTotal +
                   '   clips retires : ' + S.removed + '   clips deplaces : ' + S.moved);
        if (S.linkApi && S.linkPairs) {
            S.log.push('liens image / son : ' + S.linkOk + ' deja en place, ' + S.relinked + ' retablis' +
                       (S.relinkFailed ? ', ' + S.relinkFailed + ' EN ECHEC' : ''));
            var pairs = [];
            for (var lt in S.linkTracks) if (S.linkTracks.hasOwnProperty(lt)) pairs.push(lt);
            S.log.push('  couples d\'origine : ' + pairs.join(', '));
            S.log.push('  morceaux video lies : ' + adr_linkReport(S));
        }
        if (S.mismatch) {
            S.log.push('CONTROLE FINAL : ' + S.mismatch + ' ecart(s)');
            for (var i = 0; i < S.mismatchNotes.length; i++) S.log.push('  ' + S.mismatchNotes[i]);
        } else if (complete) {
            S.log.push('controle final : la timeline correspond au plan');
        }
        S.log.push('duree : ' + ((adr_now() - S.t0) / 1000).toFixed(1) + ' s');

        return adr_json({
            ok: complete,
            code: S.errorCode,
            error: S.error,
            phase: S.phase,
            mode: S.plan.mode,
            razorTotal: S.razorTotal,
            razorDone: S.razorDone - S.razorFailed,
            removed: S.removed,
            moved: S.moved,
            mismatch: S.mismatch,
            mismatchNotes: S.mismatchNotes,
            relinked: S.relinked,
            relinkFailed: S.relinkFailed,
            linkOk: S.linkOk,
            linkApi: S.linkApi,
            removedSeconds: removedTicks / ADR_TPS,
            lockedSkipped: S.lockedSkipped,
            backupName: S.backupName,
            outMoved: outMoved,
            log: S.log
        });
    } catch (e) {
        return adr_fail('EXCEPTION', 'finish : ' + e.toString());
    }
}

/** Abandon demande par l'utilisateur : on rend ce qui a deja ete fait. */
function ADR_cancel() {
    var S = ADR_state;
    if (!S) return adr_json({ ok: true, cancelled: false });
    if (S.phase !== 'done' && S.phase !== 'error') {
        adr_stop(S, 'CANCELLED', 'Decoupe interrompue a la phase ' + S.phase + '.');
    }
    return ADR_finish();
}

// ==========================================================================
// ZOOM
//
// Pose des images cles sur l'echelle (effet Trajectoire / Motion) des clips
// video. Les valeurs du plan sont relatives a l'echelle actuelle du clip :
// 100 = sa taille actuelle.
//
// Les instants des images cles sont exprimes dans le temps du media source :
// le debut visible du clip correspond a son point d'entree (inPoint), pas a sa
// position dans la sequence.
// ==========================================================================

var ADZ_state = null;

/** Interpolation "Bezier" des images cles (courbe douce). */
var ADZ_KF_BEZIER = 5;

/** Effet Trajectoire (Motion) du clip, ou null. */
function adz_motion(clip) {
    var comps = clip.components;
    if (!comps) return null;
    var i, c;
    for (i = 0; i < comps.numItems; i++) {
        c = comps[i];
        try {
            if (String(c.matchName) === 'AE.ADBE Motion') return c;
        } catch (e) {}
    }
    // Repli sur le nom affiche, selon la langue de Premiere.
    var names = /^(motion|trajectoire|bewegung|movimiento|movimento|ruch|beweging)$/i;
    for (i = 0; i < comps.numItems; i++) {
        c = comps[i];
        try {
            if (names.test(String(c.displayName))) return c;
        } catch (e2) {}
    }
    return null;
}

/** Parametre Echelle de l'effet Trajectoire, ou null. */
function adz_scale(motion) {
    var props = motion.properties;
    if (!props) return null;
    // "\u00e9" / "\u00c9" : e accent aigu, minuscule et majuscule (fichier garde en ASCII).
    var names = /^(scale|\u00e9chelle|\u00c9chelle|echelle|skalierung|escala|scala|skala|schaal)$/i;
    var i;
    for (i = 0; i < props.numItems; i++) {
        try {
            if (names.test(String(props[i].displayName))) return props[i];
        } catch (e) {}
    }
    // Ordre habituel de Trajectoire : Position, Echelle, Largeur, ...
    if (props.numItems > 1) return props[1];
    return null;
}

function adz_isAnimated(param) {
    try {
        return param.isTimeVarying() ? true : false;
    } catch (e) {
        return false;
    }
}

/**
 * Clips des pistes video demandees, pour l'apercu du panneau.
 * @param tracksCsv indices des pistes video, ex. '0,1'
 */
function ADZ_listClips(tracksCsv) {
    try {
        if (!app.project) return adr_fail('NO_PROJECT', 'Aucun projet ouvert.');
        var seq = app.project.activeSequence;
        if (!seq) return adr_fail('NO_SEQUENCE', 'Aucune sequence active.');

        var parts = String(tracksCsv).split(',');
        var tracks = [];
        for (var p = 0; p < parts.length; p++) {
            if (parts[p] === '') continue;
            var ti = parseInt(parts[p], 10);
            if (isNaN(ti) || ti < 0 || ti >= seq.videoTracks.numTracks) continue;
            var track = seq.videoTracks[ti];
            var clips = track.clips;
            var n = clips.numItems;
            var list = [];
            for (var j = 0; j < n; j++) {
                var c = clips[j];
                var motion = null;
                var scale = null;
                try {
                    motion = adz_motion(c);
                    if (motion) scale = adz_scale(motion);
                } catch (eM) {}
                list.push({
                    i: j,
                    s: adr_num(c.start.ticks),
                    e: adr_num(c.end.ticks),
                    sel: adr_bool(function () { return c.isSelected(); }),
                    disabled: c.disabled === true,
                    motion: scale ? true : false,
                    animated: scale ? adz_isAnimated(scale) : false
                });
            }
            tracks.push({
                index: ti,
                locked: adr_bool(function () { return track.isLocked(); }),
                clips: list
            });
        }
        return adr_json({ ok: true, tracks: tracks });
    } catch (e) {
        return adr_fail('EXCEPTION', 'listClips : ' + e.toString());
    }
}

/**
 * Plan Zoom, une information par ligne :
 *   cle=valeur
 *   Z <piste> <indice> <debut> <fin> <de> <a> <duree> <doux>
 *     debut / fin : ticks du clip dans la sequence (controle de position)
 *     de / a      : pourcentages de l'echelle actuelle
 *     duree       : secondes, 0 = toute la duree du clip
 *     doux        : 1 = courbe douce, 0 = lineaire
 */
function adz_parsePlan(text) {
    var plan = { seqId: '', backup: false, backupName: '', items: [] };
    var lines = String(text).split('\n');
    for (var i = 0; i < lines.length; i++) {
        var ln = lines[i].replace(/\r/g, '');
        if (!ln) continue;
        if (ln.charAt(0) === 'Z' && ln.charAt(1) === ' ') {
            var p = ln.split(' ');
            var it = {
                track: parseInt(p[1], 10),
                i: parseInt(p[2], 10),
                s: adr_num(p[3]),
                e: adr_num(p[4]),
                from: adr_num(p[5]),
                to: adr_num(p[6]),
                duration: adr_num(p[7]),
                ease: p[8] === '1',
                // point vise, en fraction de l'image (-1 : centre, pas de mouvement)
                px: p.length > 10 ? adr_num(p[9]) : -1,
                py: p.length > 10 ? adr_num(p[10]) : -1
            };
            if (!isNaN(it.track) && !isNaN(it.i) && it.e > it.s && it.from > 0 && it.to > 0) plan.items.push(it);
            continue;
        }
        var eq = ln.indexOf('=');
        if (eq <= 0) continue;
        var key = ln.substring(0, eq);
        var val = ln.substring(eq + 1);
        if (key === 'sequenceId') plan.seqId = val;
        else if (key === 'backup') plan.backup = val === '1';
        else if (key === 'backupName') plan.backupName = val;
    }
    return plan;
}

function ADZ_begin(planPath) {
    try {
        ADZ_state = null;
        var text = adr_readText(planPath);
        if (text === null) return adr_fail('NO_PLAN', 'Plan illisible : ' + planPath);
        var plan = adz_parsePlan(text);
        if (!plan.items.length) return adr_fail('EMPTY_PLAN', 'Aucun zoom a appliquer.');

        if (!app.project) return adr_fail('NO_PROJECT', 'Aucun projet ouvert.');
        var seq = app.project.activeSequence;
        if (!seq) return adr_fail('NO_SEQUENCE', 'Aucune sequence active.');
        if (plan.seqId && String(seq.sequenceID) !== plan.seqId) {
            return adr_fail('SEQ_CHANGED', 'La sequence active n est plus celle qui a ete preparee.');
        }

        var backupName = '';
        if (plan.backup) {
            var bk = adr_backup(seq, plan.backupName);
            if (!bk.ok) return adr_fail('BACKUP_FAILED', 'La duplication de sauvegarde a echoue : aucun zoom pose.');
            backupName = bk.name;
            seq = app.project.activeSequence;
            if (!seq || String(seq.sequenceID) !== plan.seqId) {
                return adr_fail('SEQ_CHANGED',
                    'Premiere a change de sequence pendant la sauvegarde. Reclique dans la timeline, puis relance.',
                    { backupName: backupName });
            }
        }

        var frame = 1 / 30;
        try {
            var tb = adr_num(seq.timebase);
            if (tb > 0) frame = tb / ADR_TPS;
        } catch (eT) {}

        var frameW = 0;
        var frameH = 0;
        try {
            frameW = adr_num(seq.frameSizeHorizontal);
            frameH = adr_num(seq.frameSizeVertical);
        } catch (eF) {}

        ADZ_state = {
            plan: plan,
            seq: seq,
            frame: frame,
            frameW: frameW,
            frameH: frameH,
            k: 0,
            done: 0,
            skipped: 0,
            failed: 0,
            notes: [],
            backupName: backupName,
            cancelled: false,
            log: ['Zoom ' + ADR_VERSION + ' - Premiere ' + String(app.version),
                  'sequence : ' + String(seq.name) + '  zooms prevus : ' + plan.items.length +
                  (backupName ? '  sauvegarde : ' + backupName : '')],
            t0: adr_now()
        };
        return adr_json({ ok: true, total: plan.items.length, backupName: backupName });
    } catch (e) {
        ADZ_state = null;
        return adr_fail('EXCEPTION', 'zoom begin : ' + e.toString() + (e.line ? ' (ligne ' + e.line + ')' : ''));
    }
}

/** Retrouve le clip du plan, meme si un autre clip a ete ajoute avant lui. */
function adz_findClip(S, it) {
    var seq = S.seq;
    if (it.track < 0 || it.track >= seq.videoTracks.numTracks) return null;
    var clips = seq.videoTracks[it.track].clips;
    var tol = S.frame * ADR_TPS / 4;
    if (it.i < clips.numItems) {
        var c = clips[it.i];
        if (adr_abs(adr_num(c.start.ticks) - it.s) <= tol && adr_abs(adr_num(c.end.ticks) - it.e) <= tol) return c;
    }
    for (var j = 0; j < clips.numItems; j++) {
        var d = clips[j];
        if (adr_abs(adr_num(d.start.ticks) - it.s) <= tol && adr_abs(adr_num(d.end.ticks) - it.e) <= tol) return d;
    }
    return null;
}

/** Ajoute une image cle et verifie qu'elle existe bien a cet instant. */
function adz_key(param, sec, value) {
    // Selon les versions, Premiere attend des secondes ou un objet Time.
    try {
        param.addKey(sec);
        param.setValueAtKey(sec, value, true);
        return;
    } catch (e) {}
    var t = new Time();
    t.seconds = sec;
    param.addKey(t);
    param.setValueAtKey(t, value, true);
}

/** Parametre Position de l'effet Trajectoire, ou null. */
function adz_position(motion) {
    var props = motion.properties;
    if (!props) return null;
    for (var i = 0; i < props.numItems; i++) {
        try {
            if (/^position$/i.test(String(props[i].displayName))) return props[i];
        } catch (e) {}
    }
    // Ordre habituel de Trajectoire : Position en premier.
    return props.numItems ? props[0] : null;
}

/** Valeur [x, y] d'une position, ou null si illisible. */
function adz_xy(v) {
    if (v && v.length >= 2) {
        var x = adr_num(v[0]);
        var y = adr_num(v[1]);
        if (isFinite(x) && isFinite(y)) return [x, y];
    }
    return null;
}

/**
 * Position qui garde le point P immobile a l'ecran quand l'echelle est
 * multipliee par k : P + (pos0 - P) * k. P est donne en fraction de l'image ;
 * selon les versions, Premiere exprime Position en fraction ou en pixels.
 */
function adz_posFor(pos0, P, k, unit) {
    return [P[0] * unit[0] + (pos0[0] - P[0] * unit[0]) * k, P[1] * unit[1] + (pos0[1] - P[1] * unit[1]) * k];
}

/** Pose un zoom sur un clip. Rend '' si tout va bien, sinon la raison. */
function adz_apply(S, it) {
    var clip = adz_findClip(S, it);
    if (!clip) return 'clip introuvable (la timeline a change)';
    var motion = adz_motion(clip);
    var scale = motion ? adz_scale(motion) : null;
    if (!scale) return 'pas d effet Trajectoire';
    if (adz_isAnimated(scale)) return 'echelle deja animee';

    var base = adr_num(scale.getValue());
    if (!(base > 0)) return 'echelle actuelle illisible';
    var v0 = base * it.from / 100;
    var v1 = base * it.to / 100;

    // Zoom vers un point : la position bouge avec l'echelle.
    var pos = null;
    var pos0 = null;
    var unit = [1, 1];
    var P = it.px >= 0 && it.py >= 0 ? [it.px, it.py] : null;
    if (P) {
        pos = adz_position(motion);
        if (!pos) return 'pas de parametre Position';
        if (adz_isAnimated(pos)) return 'position deja animee';
        try {
            pos0 = adz_xy(pos.getValue());
        } catch (eP) {}
        if (!pos0) return 'position actuelle illisible';
        // valeurs en pixels (au-dela d'une ou deux fois la taille de l'image en fraction)
        if (adr_abs(pos0[0]) > 4 || adr_abs(pos0[1]) > 4) unit = [S.frameW || 1920, S.frameH || 1080];
    }
    var p0 = P ? adz_posFor(pos0, P, it.from / 100, unit) : null;
    var p1 = P ? adz_posFor(pos0, P, it.to / 100, unit) : null;

    // Zoom fixe : pas d'image cle, on change l'echelle (et la position) une fois pour toutes.
    if (adr_abs(it.from - it.to) < 0.001) {
        scale.setValue(v0, true);
        if (P) pos.setValue(p0, true);
        return '';
    }

    var tStart = clip.start.seconds;
    var tEnd = clip.end.seconds;
    var inP = clip.inPoint.seconds;
    var outP = clip.outPoint.seconds;
    var len = tEnd - tStart;
    if (!(len > 0)) return 'clip de duree nulle';
    var speed = (outP - inP) / len;
    if (!(speed > 0) || !isFinite(speed)) speed = 1;

    // La derniere image cle tombe sur la derniere image du clip.
    var span = it.duration > 0 ? Math.min(it.duration, len) : len;
    if (span > S.frame * 1.5) span -= S.frame;
    var k0 = inP;
    var k1 = inP + span * speed;

    scale.setTimeVarying(true);
    adz_key(scale, k0, v0);
    adz_key(scale, k1, v1);
    if (P) {
        pos.setTimeVarying(true);
        adz_key(pos, k0, p0);
        adz_key(pos, k1, p1);
    }

    var keys = null;
    var pkeys = null;
    try {
        keys = scale.getKeys();
        if (P) pkeys = pos.getKeys();
    } catch (eK) {}
    if ((keys && keys.length < 2) || (P && pkeys && pkeys.length < 2)) {
        try {
            scale.setTimeVarying(false);
            scale.setValue(base, true);
            if (P) {
                pos.setTimeVarying(false);
                pos.setValue(pos0, true);
            }
        } catch (eR) {}
        return 'images cles refusees par Premiere';
    }

    if (it.ease) {
        try {
            scale.setInterpolationTypeAtKey(k0, ADZ_KF_BEZIER, true);
            scale.setInterpolationTypeAtKey(k1, ADZ_KF_BEZIER, true);
            if (P) {
                pos.setInterpolationTypeAtKey(k0, ADZ_KF_BEZIER, true);
                pos.setInterpolationTypeAtKey(k1, ADZ_KF_BEZIER, true);
            }
        } catch (eI) {}
    }
    return '';
}

function ADZ_step(budgetMs) {
    var S = ADZ_state;
    if (!S) return adr_fail('NO_STATE', 'Aucun zoom en cours.');
    var budget = adr_num(budgetMs);
    if (!(budget > 0)) budget = 250;
    var t0 = adr_now();
    var items = S.plan.items;
    while (S.k < items.length) {
        var it = items[S.k++];
        var why = '';
        try {
            why = adz_apply(S, it);
        } catch (e) {
            why = 'erreur : ' + e.toString();
        }
        if (!why) S.done++;
        else {
            if (why === 'echelle deja animee' || why === 'position deja animee' || why === 'pas d effet Trajectoire') S.skipped++;
            else S.failed++;
            if (S.notes.length < 12) {
                S.notes.push('V' + (it.track + 1) + ' clip ' + (it.i + 1) + ' (' +
                    (it.s / ADR_TPS).toFixed(2) + ' s) : ' + why);
            }
        }
        if (adr_now() - t0 >= budget) break;
    }
    return adr_json({ ok: true, done: S.k, total: items.length, finished: S.k >= items.length });
}

function ADZ_finish() {
    var S = ADZ_state;
    if (!S) return adr_fail('NO_STATE', 'Aucun zoom en cours.');
    ADZ_state = null;
    S.log.push('zooms poses : ' + S.done + '  ignores : ' + S.skipped + '  en echec : ' + S.failed);
    for (var i = 0; i < S.notes.length; i++) S.log.push('  ' + S.notes[i]);
    S.log.push('duree : ' + ((adr_now() - S.t0) / 1000).toFixed(1) + ' s');
    return adr_json({
        ok: !S.cancelled && S.failed === 0,
        code: S.cancelled ? 'CANCELLED' : S.failed ? 'PARTIAL' : null,
        applied: S.done,
        skipped: S.skipped,
        failed: S.failed,
        total: S.plan.items.length,
        notes: S.notes,
        backupName: S.backupName,
        log: S.log
    });
}

function ADZ_cancel() {
    var S = ADZ_state;
    if (!S) return adr_json({ ok: true, cancelled: false });
    S.cancelled = true;
    S.log.push('interrompu apres ' + S.k + ' / ' + S.plan.items.length);
    return ADZ_finish();
}

// ==========================================================================
// B-ROLL
//
// Importe les fichiers choisis dans un chutier "FirstCut B-roll", fabrique
// pour chaque video un sous-clip SANS SON (le son du B-roll ne doit pas
// ecraser la voix), le pose sur la piste video choisie, et l'agrandit pour
// remplir le cadre de la sequence.
// ==========================================================================

var ADB_state = null;
var ADB_BIN_NAME = 'FirstCut B-roll';

/** Dossier du projet et taille d'image de la sequence active. */
function ADB_projectInfo() {
    try {
        if (!app.project) return adr_fail('NO_PROJECT', 'Aucun projet ouvert.');
        var seq = app.project.activeSequence;
        var path = '';
        try {
            path = String(app.project.path);
        } catch (eP) {}
        return adr_json({
            ok: true,
            projectPath: path,
            frameW: seq ? adr_num(seq.frameSizeHorizontal) : 0,
            frameH: seq ? adr_num(seq.frameSizeVertical) : 0
        });
    } catch (e) {
        return adr_fail('EXCEPTION', 'projectInfo : ' + e.toString());
    }
}

function adb_norm(p) {
    return String(p).replace(/\\/g, '/').toLowerCase();
}

/** Chutier de travail a la racine du projet (cree s'il manque). */
function adb_bin() {
    var root = app.project.rootItem;
    var i;
    for (i = 0; i < root.children.numItems; i++) {
        var c = root.children[i];
        if (String(c.name) === ADB_BIN_NAME && c.type === 2) return c;
    }
    var made = null;
    try {
        made = root.createBin(ADB_BIN_NAME);
    } catch (e) {}
    if (made && made.type === 2) return made;
    for (i = 0; i < root.children.numItems; i++) {
        if (String(root.children[i].name) === ADB_BIN_NAME && root.children[i].type === 2) return root.children[i];
    }
    return root;
}

/** Element du projet dont le media est ce fichier (chutier et sous-chutiers). Les sous-clips sont ignores. */
function adb_findItem(bin, path, depth) {
    var want = adb_norm(path);
    for (var i = 0; i < bin.children.numItems; i++) {
        var c = bin.children[i];
        if (c.type === 2) {
            if ((depth || 0) < 3) {
                var sub = adb_findItem(c, path, (depth || 0) + 1);
                if (sub) return sub;
            }
            continue;
        }
        if (/ - B-roll \d+$/.test(String(c.name))) continue;
        var mp = '';
        try {
            mp = String(c.getMediaPath());
        } catch (e) {}
        if (mp && adb_norm(mp) === want) return c;
    }
    return null;
}

/**
 * Plan B-roll, une ligne par B-roll :
 *   B <piste> <debut_ticks> <duree_ticks> <entree_s> <v|i> <largeur> <hauteur> <chemin>
 * Le chemin est en dernier : il peut contenir des espaces.
 */
function adb_parsePlan(text) {
    var plan = { seqId: '', backup: false, backupName: '', fill: true, items: [] };
    var lines = String(text).split('\n');
    for (var i = 0; i < lines.length; i++) {
        var ln = lines[i].replace(/\r/g, '');
        if (!ln) continue;
        if (ln.charAt(0) === 'B' && ln.charAt(1) === ' ') {
            var p = ln.split(' ');
            if (p.length < 9) continue;
            var it = {
                track: parseInt(p[1], 10),
                start: adr_num(p[2]),
                dur: adr_num(p[3]),
                srcIn: adr_num(p[4]),
                kind: p[5] === 'i' ? 'i' : 'v',
                w: adr_num(p[6]),
                h: adr_num(p[7]),
                path: p.slice(8).join(' ')
            };
            if (!isNaN(it.track) && it.dur > 0 && it.start >= 0 && it.path) plan.items.push(it);
            continue;
        }
        var eq = ln.indexOf('=');
        if (eq <= 0) continue;
        var key = ln.substring(0, eq);
        var val = ln.substring(eq + 1);
        if (key === 'sequenceId') plan.seqId = val;
        else if (key === 'backup') plan.backup = val === '1';
        else if (key === 'backupName') plan.backupName = val;
        else if (key === 'fill') plan.fill = val !== '0';
    }
    return plan;
}

function ADB_begin(planPath) {
    try {
        ADB_state = null;
        var text = adr_readText(planPath);
        if (text === null) return adr_fail('NO_PLAN', 'Plan illisible : ' + planPath);
        var plan = adb_parsePlan(text);
        if (!plan.items.length) return adr_fail('EMPTY_PLAN', 'Aucun B-roll a placer.');
        if (!app.project) return adr_fail('NO_PROJECT', 'Aucun projet ouvert.');
        var seq = app.project.activeSequence;
        if (!seq) return adr_fail('NO_SEQUENCE', 'Aucune sequence active.');
        if (plan.seqId && String(seq.sequenceID) !== plan.seqId) {
            return adr_fail('SEQ_CHANGED', 'La sequence active n est plus celle qui a ete preparee.');
        }
        var i;
        for (i = 0; i < plan.items.length; i++) {
            var tr = plan.items[i].track;
            if (tr < 0 || tr >= seq.videoTracks.numTracks) {
                return adr_fail('NO_TRACK', 'La piste V' + (tr + 1) + ' n existe pas dans cette sequence.');
            }
            if (adr_bool(function () { return seq.videoTracks[tr].isLocked(); })) {
                return adr_fail('LOCKED', 'La piste V' + (tr + 1) + ' est verrouillee.');
            }
            if (!new File(plan.items[i].path).exists) {
                return adr_fail('NO_FILE', 'Fichier introuvable : ' + plan.items[i].path);
            }
        }

        var backupName = '';
        if (plan.backup) {
            var bk = adr_backup(seq, plan.backupName);
            if (!bk.ok) return adr_fail('BACKUP_FAILED', 'La duplication de sauvegarde a echoue : aucun B-roll pose.');
            backupName = bk.name;
            seq = app.project.activeSequence;
            if (!seq || String(seq.sequenceID) !== plan.seqId) {
                return adr_fail('SEQ_CHANGED',
                    'Premiere a change de sequence pendant la sauvegarde. Reclique dans la timeline, puis relance.',
                    { backupName: backupName });
            }
        }

        // Import groupe : un seul appel pour tous les fichiers absents du projet.
        var bin = adb_bin();
        var items = {};
        var missing = [];
        var seen = {};
        for (i = 0; i < plan.items.length; i++) {
            var path = plan.items[i].path;
            var key = adb_norm(path);
            if (seen[key]) continue;
            seen[key] = true;
            var found = adb_findItem(bin, path) || adb_findItem(app.project.rootItem, path);
            if (found) items[key] = found;
            else missing.push(path);
        }
        if (missing.length) {
            try {
                app.project.importFiles(missing, true, bin, false);
            } catch (eI) {
                return adr_fail('IMPORT_FAILED', 'Import refuse par Premiere : ' + eI.toString(), { backupName: backupName });
            }
            for (i = 0; i < missing.length; i++) {
                var got = adb_findItem(bin, missing[i]) || adb_findItem(app.project.rootItem, missing[i]);
                if (got) items[adb_norm(missing[i])] = got;
            }
        }

        var frameW = 0;
        var frameH = 0;
        try {
            frameW = adr_num(seq.frameSizeHorizontal);
            frameH = adr_num(seq.frameSizeVertical);
        } catch (eF) {}

        ADB_state = {
            plan: plan,
            seq: seq,
            bin: bin,
            items: items,
            frameW: frameW,
            frameH: frameH,
            tol: adr_num(seq.timebase) / 4,
            k: 0,
            done: 0,
            failed: 0,
            notes: [],
            backupName: backupName,
            cancelled: false,
            log: ['B-roll ' + ADR_VERSION + ' - Premiere ' + String(app.version),
                  'sequence : ' + String(seq.name) + '  B-rolls prevus : ' + plan.items.length +
                  '  importes : ' + missing.length + (backupName ? '  sauvegarde : ' + backupName : '')],
            t0: adr_now()
        };
        return adr_json({ ok: true, total: plan.items.length, imported: missing.length, backupName: backupName });
    } catch (e) {
        ADB_state = null;
        return adr_fail('EXCEPTION', 'broll begin : ' + e.toString() + (e.line ? ' (ligne ' + e.line + ')' : ''));
    }
}

function adb_time(sec) {
    var t = new Time();
    t.seconds = sec;
    return t;
}

/** Sous-clip image seule d'une video, de srcIn a srcIn + duree (secondes du media). */
function adb_subclip(S, item, it, n) {
    var name = String(item.name).replace(/\.[^.]+$/, '') + ' - B-roll ' + n;
    var a = it.srcIn;
    var b = it.srcIn + it.dur / ADR_TPS;
    var sub = null;
    try {
        sub = item.createSubClip(name, adb_time(a), adb_time(b), 0, 1, 0);
    } catch (e) {}
    if (!sub) {
        try {
            sub = item.createSubClip(name, String(Math.round(a * ADR_TPS)), String(Math.round(b * ADR_TPS)), 0, 1, 0);
        } catch (e2) {}
    }
    return sub;
}

/** Pose un element a un instant sur une piste video ; rend le clip pose ou null. */
function adb_overwrite(S, track, item, startTicks) {
    var placed = false;
    try {
        track.overwriteClip(item, startTicks / ADR_TPS);
        placed = true;
    } catch (e) {}
    if (!placed) {
        try {
            var t = new Time();
            t.ticks = String(startTicks);
            track.overwriteClip(item, t);
            placed = true;
        } catch (e2) {}
    }
    if (!placed) return null;
    for (var i = 0; i < track.clips.numItems; i++) {
        var c = track.clips[i];
        if (adr_abs(adr_num(c.start.ticks) - startTicks) <= S.tol) return c;
    }
    return null;
}

function adb_setEnd(clip, ticks) {
    try {
        var t = clip.end;
        t.ticks = String(ticks);
        clip.end = t;
    } catch (e) {}
    return adr_num(clip.end.ticks);
}

/** Agrandit le clip pour qu'il remplisse le cadre (sans bandes noires). */
function adb_fill(S, clip, it) {
    if (!(S.frameW > 0 && S.frameH > 0 && it.w > 0 && it.h > 0)) return '';
    var motion = adz_motion(clip);
    var scale = motion ? adz_scale(motion) : null;
    if (!scale) return 'pas d effet Trajectoire';
    var v = Math.max(S.frameW / it.w, S.frameH / it.h) * 100;
    try {
        if (adz_isAnimated(scale)) scale.setTimeVarying(false);
        scale.setValue(Math.round(v * 100) / 100, true);
    } catch (e) {
        return 'echelle refusee';
    }
    return '';
}

function adb_apply(S, it, n) {
    var item = S.items[adb_norm(it.path)];
    if (!item) return 'fichier non importe';
    var track = S.seq.videoTracks[it.track];
    var src = item;
    if (it.kind === 'v') {
        src = adb_subclip(S, item, it, n);
        if (!src) return 'sous-clip impossible';
    } else {
        // image fixe : sa duree est fixee avant de la poser
        try {
            item.setInPoint(0, 4);
            item.setOutPoint(it.dur / ADR_TPS, 4);
        } catch (eS) {}
    }
    var clip = adb_overwrite(S, track, src, it.start);
    if (!clip) return 'pose refusee par Premiere';
    var want = it.start + it.dur;
    var end = adr_num(clip.end.ticks);
    if (adr_abs(end - want) > S.tol) end = adb_setEnd(clip, want);
    if (adr_abs(end - want) > S.tol && S.notes.length < 12) {
        S.notes.push('V' + (it.track + 1) + ' ' + (it.start / ADR_TPS).toFixed(2) + ' s : duree ' +
            ((end - it.start) / ADR_TPS).toFixed(2) + ' s au lieu de ' + (it.dur / ADR_TPS).toFixed(2) + ' s');
    }
    if (S.plan.fill) {
        var why = adb_fill(S, clip, it);
        if (why && S.notes.length < 12) S.notes.push('V' + (it.track + 1) + ' ' + (it.start / ADR_TPS).toFixed(2) + ' s : ' + why);
    }
    return '';
}

function ADB_step(budgetMs) {
    var S = ADB_state;
    if (!S) return adr_fail('NO_STATE', 'Aucun B-roll en cours.');
    var budget = adr_num(budgetMs);
    if (!(budget > 0)) budget = 250;
    var t0 = adr_now();
    var items = S.plan.items;
    while (S.k < items.length) {
        var it = items[S.k++];
        var why = '';
        try {
            why = adb_apply(S, it, S.k);
        } catch (e) {
            why = 'erreur : ' + e.toString();
        }
        if (!why) S.done++;
        else {
            S.failed++;
            if (S.notes.length < 12) S.notes.push('V' + (it.track + 1) + ' ' + (it.start / ADR_TPS).toFixed(2) + ' s : ' + why);
        }
        if (adr_now() - t0 >= budget) break;
    }
    return adr_json({ ok: true, done: S.k, total: items.length, finished: S.k >= items.length });
}

function ADB_finish() {
    var S = ADB_state;
    if (!S) return adr_fail('NO_STATE', 'Aucun B-roll en cours.');
    ADB_state = null;
    S.log.push('B-rolls poses : ' + S.done + '  en echec : ' + S.failed);
    for (var i = 0; i < S.notes.length; i++) S.log.push('  ' + S.notes[i]);
    S.log.push('duree : ' + ((adr_now() - S.t0) / 1000).toFixed(1) + ' s');
    return adr_json({
        ok: !S.cancelled && S.failed === 0,
        code: S.cancelled ? 'CANCELLED' : S.failed ? 'PARTIAL' : null,
        applied: S.done,
        failed: S.failed,
        total: S.plan.items.length,
        notes: S.notes,
        backupName: S.backupName,
        log: S.log
    });
}

function ADB_cancel() {
    var S = ADB_state;
    if (!S) return adr_json({ ok: true, cancelled: false });
    S.cancelled = true;
    S.log.push('interrompu apres ' + S.k + ' / ' + S.plan.items.length);
    return ADB_finish();
}

// ==========================================================================
// POV
//
// Plan recu : une suite de plans (debut, fin, piste video a montrer) et la
// liste des pistes video concernees (cameras + plan large). Les pistes
// concernees sont coupees a chaque changement de plan, puis chaque clip est
// active s'il appartient a la camera du plan, desactive sinon. Rien n'est
// supprime ni deplace : desactiver un clip se defait d'un clic.
// ==========================================================================

var ADP_state = null;

/**
 *   T <piste video>                   piste concernee
 *   S <debut> <fin> <piste video>     plan, en images de la sequence
 */
function adp_parsePlan(text) {
    var plan = { seqId: '', timebase: 0, backup: false, backupName: '', tracks: [], shots: [] };
    var lines = String(text).split('\n');
    for (var i = 0; i < lines.length; i++) {
        var ln = lines[i].replace(/\r/g, '');
        if (!ln) continue;
        var p = ln.split(' ');
        if (p[0] === 'T' && p.length >= 2) {
            var t = parseInt(p[1], 10);
            if (!isNaN(t)) plan.tracks.push(t);
            continue;
        }
        if (p[0] === 'S' && p.length >= 4) {
            var a = parseInt(p[1], 10);
            var b = parseInt(p[2], 10);
            var c = parseInt(p[3], 10);
            if (!isNaN(a) && !isNaN(b) && !isNaN(c) && b > a) plan.shots.push({ a: a, b: b, cam: c });
            continue;
        }
        var eq = ln.indexOf('=');
        if (eq <= 0) continue;
        var key = ln.substring(0, eq);
        var val = ln.substring(eq + 1);
        if (key === 'sequenceId') plan.seqId = val;
        else if (key === 'timebase') plan.timebase = adr_num(val);
        else if (key === 'backup') plan.backup = val === '1';
        else if (key === 'backupName') plan.backupName = val;
    }
    return plan;
}

function ADP_begin(planPath) {
    try {
        ADP_state = null;
        var text = adr_readText(planPath);
        if (text === null) return adr_fail('NO_PLAN', 'Plan illisible : ' + planPath);
        var plan = adp_parsePlan(text);
        if (!plan.shots.length || !plan.tracks.length) return adr_fail('EMPTY_PLAN', 'Aucun plan a appliquer.');
        if (!app.project) return adr_fail('NO_PROJECT', 'Aucun projet ouvert.');
        var seq = app.project.activeSequence;
        if (!seq) return adr_fail('NO_SEQUENCE', 'Aucune sequence active.');
        if (plan.seqId && String(seq.sequenceID) !== plan.seqId) {
            return adr_fail('SEQ_CHANGED', 'La sequence active n est plus celle qui a ete analysee.');
        }
        var tb = adr_num(seq.timebase);
        if (plan.timebase && plan.timebase !== tb) return adr_fail('SEQ_CHANGED', 'La cadence de la sequence a change depuis l analyse.');
        var i;
        for (i = 0; i < plan.tracks.length; i++) {
            var ti = plan.tracks[i];
            if (ti < 0 || ti >= seq.videoTracks.numTracks) return adr_fail('NO_TRACK', 'La piste V' + (ti + 1) + ' n existe pas.');
            if (adr_bool(function () { return seq.videoTracks[ti].isLocked(); })) {
                return adr_fail('LOCKED', 'La piste V' + (ti + 1) + ' est verrouillee : deverrouille-la pour qu POV puisse la modifier.');
            }
        }
        try {
            app.enableQE();
        } catch (eQ) {}
        if (typeof qe === 'undefined' || !qe || !qe.project) return adr_fail('NO_QE', 'L outil de decoupe de Premiere (QE) est indisponible.');

        var backupName = '';
        if (plan.backup) {
            var bk = adr_backup(seq, plan.backupName);
            if (!bk.ok) return adr_fail('BACKUP_FAILED', 'La duplication de sauvegarde a echoue : rien n a ete modifie.');
            backupName = bk.name;
            seq = app.project.activeSequence;
            if (!seq || String(seq.sequenceID) !== plan.seqId) {
                return adr_fail('SEQ_CHANGED', 'Premiere a change de sequence pendant la sauvegarde. Reclique dans la timeline, puis relance.',
                    { backupName: backupName });
            }
        }
        var qeSeq = qe.project.getActiveSequence();
        if (!qeSeq || String(qeSeq.name) !== String(seq.name)) {
            return adr_fail('QE_MISMATCH', 'Premiere pointe sur deux sequences differentes. Clique dans la timeline, puis relance.',
                { backupName: backupName });
        }

        var fmt = 0;
        var frameRate = null;
        try {
            var st = seq.getSettings();
            fmt = st.videoDisplayFormat;
            frameRate = st.videoFrameRate;
        } catch (eS) {}
        var zero = 0;
        try {
            zero = adr_num(seq.zeroPoint);
        } catch (eZ) {}

        // Meme forme que l'etat de la decoupe des silences : le rasoir est partage.
        var S = {
            plan: plan,
            seq: seq,
            tb: tb,
            tol: Math.floor(tb / 4),
            fps: ADR_TPS / tb,
            fmt: fmt,
            frameRate: frameRate,
            zero: zero,
            tcMethods: [],
            razorMethod: null,
            phase: 'scan',
            ti: 0,
            oi: 0,
            tracks: [],
            razorTotal: 0,
            razorDone: 0,
            razorFailed: 0,
            enabled: 0,
            disabled: 0,
            refused: 0,
            unsplit: 0,
            mismatch: 0,
            notes: [],
            error: null,
            errorCode: null,
            backupName: backupName,
            log: ['POV ' + ADR_VERSION + ' - Premiere ' + String(app.version),
                  'sequence : ' + String(seq.name) + '  plans : ' + plan.shots.length + '  pistes : ' +
                  plan.tracks.length + (backupName ? '  sauvegarde : ' + backupName : '')],
            t0: adr_now()
        };
        if (frameRate) S.tcMethods.push('F1');
        S.tcMethods.push('M1');
        if (zero !== 0) {
            if (frameRate) S.tcMethods.push('F0');
            S.tcMethods.push('M0');
        }
        // bornes des plans, en ticks, triees
        S.bounds = [];
        for (i = 0; i < plan.shots.length; i++) {
            var sh = plan.shots[i];
            if (!S.bounds.length || S.bounds[S.bounds.length - 1] !== sh.a * tb) S.bounds.push(sh.a * tb);
            S.bounds.push(sh.b * tb);
        }
        for (i = 0; i < plan.tracks.length; i++) {
            var k = plan.tracks[i];
            S.tracks.push({ index: k, label: 'V' + (k + 1), dom: seq.videoTracks[k], qe: qeSeq.getVideoTrackAt(k) });
        }
        ADP_state = S;
        return adr_json({ ok: true, backupName: backupName, tracks: plan.tracks.length });
    } catch (e) {
        ADP_state = null;
        return adr_fail('EXCEPTION', 'pov begin : ' + e.toString() + (e.line ? ' (ligne ' + e.line + ')' : ''));
    }
}

/** Plan qui contient l'instant t (ticks), ou null hors de la zone. */
function adp_shotAt(S, t) {
    var shots = S.plan.shots;
    var lo = 0;
    var hi = shots.length;
    while (lo < hi) {
        var mid = (lo + hi) >> 1;
        if (shots[mid].b * S.tb <= t) lo = mid + 1;
        else hi = mid;
    }
    if (lo < shots.length && shots[lo].a * S.tb <= t) return shots[lo];
    return null;
}

function adp_unitScan(S) {
    var T = S.tracks[S.ti];
    var snap = adr_snapshot(T.dom);
    var ops = [];
    for (var i = 0; i < snap.n; i++) {
        var k = adr_lowerBound(S.bounds, snap.s[i] + S.tol);
        while (k < S.bounds.length && S.bounds[k] < snap.e[i] - S.tol) {
            ops.push(S.bounds[k]);
            k++;
        }
    }
    T.ops = ops;
    S.razorTotal += ops.length;
    S.ti++;
    if (S.ti >= S.tracks.length) {
        S.phase = 'razor';
        S.ti = 0;
        S.oi = 0;
    }
}

function adp_unitRazor(S) {
    if (S.ti >= S.tracks.length) {
        S.phase = 'toggle';
        S.ti = 0;
        S.oi = 0;
        return;
    }
    var T = S.tracks[S.ti];
    if (S.oi >= T.ops.length) {
        S.ti++;
        S.oi = 0;
        return;
    }
    var ok = adr_razor(S, T, T.ops[S.oi++]);
    if (S.phase === 'error') return;
    S.razorDone++;
    if (!ok) {
        S.razorFailed++;
        if (!S.razorMethod && S.razorFailed >= 3) {
            adr_stop(S, 'RAZOR_FAILED', 'Premiere refuse les points de coupe. Rien n a ete active ni desactive.');
        }
    }
}

/** Un clip : active s'il est sur la camera du plan, desactive sinon. */
function adp_unitToggle(S) {
    if (S.ti >= S.tracks.length) {
        S.phase = 'verify';
        S.ti = 0;
        S.oi = 0;
        return;
    }
    var T = S.tracks[S.ti];
    var clips = T.dom.clips;
    if (S.oi >= clips.numItems) {
        S.ti++;
        S.oi = 0;
        return;
    }
    var c = clips[S.oi++];
    var s = adr_num(c.start.ticks);
    var e = adr_num(c.end.ticks);
    var shot = adp_shotAt(S, (s + e) / 2);
    if (!shot) return; // hors de la zone : on n'y touche pas
    var want = shot.cam === T.index;
    var was = c.disabled === true;
    if (was === !want) return;
    try {
        c.disabled = !want;
    } catch (eD) {}
    if ((c.disabled === true) === !want) {
        if (want) S.enabled++;
        else S.disabled++;
    } else {
        S.refused++;
    }
}

function adp_unitVerify(S) {
    if (S.ti >= S.tracks.length) {
        S.phase = 'done';
        return;
    }
    var T = S.tracks[S.ti++];
    var clips = T.dom.clips;
    for (var i = 0; i < clips.numItems; i++) {
        var c = clips[i];
        var s = adr_num(c.start.ticks);
        var e = adr_num(c.end.ticks);
        var k = adr_lowerBound(S.bounds, s + S.tol);
        if (k < S.bounds.length && S.bounds[k] < e - S.tol) {
            S.unsplit++;
            if (S.notes.length < 12) S.notes.push(T.label + ' ' + (S.bounds[k] / ADR_TPS).toFixed(2) + ' s : coupe manquante');
            continue;
        }
        var shot = adp_shotAt(S, (s + e) / 2);
        if (!shot) continue;
        if ((c.disabled === true) !== (shot.cam !== T.index)) {
            S.mismatch++;
            if (S.notes.length < 12) S.notes.push(T.label + ' ' + (s / ADR_TPS).toFixed(2) + ' s : clip dans le mauvais etat');
        }
    }
}

function ADP_step(budgetMs) {
    var S = ADP_state;
    if (!S) return adr_fail('NO_STATE', 'Aucun POV en cours.');
    var budget = adr_num(budgetMs);
    if (!(budget > 0)) budget = 250;
    var t0 = adr_now();
    try {
        while (S.phase !== 'done' && S.phase !== 'error') {
            if (S.phase === 'scan') adp_unitScan(S);
            else if (S.phase === 'razor') adp_unitRazor(S);
            else if (S.phase === 'toggle') adp_unitToggle(S);
            else if (S.phase === 'verify') adp_unitVerify(S);
            else adr_stop(S, 'BAD_PHASE', 'Etat interne inconnu : ' + S.phase);
            if (adr_now() - t0 >= budget) break;
        }
    } catch (e) {
        adr_stop(S, 'EXCEPTION', 'Erreur pendant la phase ' + S.phase + ' : ' + e.toString() + (e.line ? ' (ligne ' + e.line + ')' : ''));
    }
    var done = 0;
    var total = 1;
    if (S.phase === 'razor') {
        done = S.razorDone;
        total = Math.max(1, S.razorTotal);
    } else if (S.phase === 'toggle' || S.phase === 'verify' || S.phase === 'scan') {
        done = S.ti;
        total = Math.max(1, S.tracks.length);
    } else done = total;
    return adr_json({ ok: true, phase: S.phase, done: done, total: total, finished: S.phase === 'done' || S.phase === 'error' });
}

function ADP_finish() {
    var S = ADP_state;
    if (!S) return adr_fail('NO_STATE', 'Aucun POV en cours.');
    ADP_state = null;
    var complete = S.phase === 'done';
    S.log.push('coupes : ' + (S.razorDone - S.razorFailed) + ' / ' + S.razorTotal + '  clips actives : ' + S.enabled +
               '  desactives : ' + S.disabled + '  refuses : ' + S.refused);
    if (S.unsplit || S.mismatch) S.log.push('CONTROLE : ' + S.unsplit + ' coupe(s) manquante(s), ' + S.mismatch + ' clip(s) mal regle(s)');
    for (var i = 0; i < S.notes.length; i++) S.log.push('  ' + S.notes[i]);
    S.log.push('duree : ' + ((adr_now() - S.t0) / 1000).toFixed(1) + ' s');
    return adr_json({
        ok: complete && !S.refused && !S.unsplit && !S.mismatch,
        code: S.errorCode || (complete ? null : 'INCOMPLETE'),
        error: S.error,
        razorDone: S.razorDone - S.razorFailed,
        razorTotal: S.razorTotal,
        enabled: S.enabled,
        disabled: S.disabled,
        refused: S.refused,
        unsplit: S.unsplit,
        mismatch: S.mismatch,
        notes: S.notes,
        backupName: S.backupName,
        log: S.log
    });
}

function ADP_cancel() {
    var S = ADP_state;
    if (!S) return adr_json({ ok: true, cancelled: false });
    if (S.phase !== 'done' && S.phase !== 'error') adr_stop(S, 'CANCELLED', 'POV interrompu a la phase ' + S.phase + '.');
    return ADP_finish();
}
