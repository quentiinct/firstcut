/* Simulation de Premiere Pro pour tester firstcut.jsx sans Premiere.
 *
 * Tourne sous Windows Script Host (JScript), un moteur ECMAScript 3 comme
 * ExtendScript : une syntaxe trop moderne dans le .jsx y echoue de la meme
 * facon. Ce fichier ne reproduit que ce que le .jsx utilise.
 *
 * MOCK.config permet de simuler des variantes de comportement de Premiere.
 */
var MOCK = {
    TPS: 254016000000,
    config: null,
    errors: [],
    calls: { razor: 0, remove: 0, move: 0, clone: 0 }
};

MOCK.resetConfig = function () {
    MOCK.config = {
        rippleWorks: true,      // remove(true) resserre la piste
        moveAccepts: 'ticks',   // forme d'argument acceptee par move : ticks | seconds | number
        formattedThrows: false, // Time.getFormatted indisponible
        razorDead: false,       // le rasoir ne fait rien
        cloneSwitches: false    // clone() bascule sur la copie
    };
    MOCK.errors = [];
    MOCK.calls = { razor: 0, remove: 0, move: 0, clone: 0 };
};
MOCK.resetConfig();

var $ = { version: 'mock' };

// ------------------------------------------------------------------- fichiers

function File(path) {
    this.path = String(path);
    this.encoding = '';
    this._fso = new ActiveXObject('Scripting.FileSystemObject');
    this.exists = this._fso.FileExists(this.path);
    this.length = this.exists ? this._fso.GetFile(this.path).Size : 0;
    this._stream = null;
}
File.prototype.open = function (mode) {
    if (mode !== 'r' || !this.exists) return false;
    this._stream = this._fso.OpenTextFile(this.path, 1, false, 0);
    return true;
};
File.prototype.read = function () {
    return this._stream.AtEndOfStream ? '' : this._stream.ReadAll();
};
File.prototype.close = function () {
    if (this._stream) this._stream.Close();
    this._stream = null;
};

// ---------------------------------------------------------------------- temps

function Time() {
    this.ticks = null;
    this.seconds = null;
}
Time.prototype.getFormatted = function (frameRate, fmt) {
    if (MOCK.config.formattedThrows) throw new Error('getFormatted indisponible');
    var frame = Math.round(Number(this.ticks) / Number(frameRate.ticks));
    return MOCK.tc(frame, MOCK.seq._nominal);
};

MOCK.pad = function (n) {
    return n < 10 ? '0' + n : '' + n;
};
MOCK.tc = function (frame, nominal) {
    var ff = frame % nominal;
    var s = Math.floor(frame / nominal);
    return MOCK.pad(Math.floor(s / 3600)) + ':' + MOCK.pad(Math.floor(s / 60) % 60) + ':' +
           MOCK.pad(s % 60) + ':' + MOCK.pad(ff);
};
MOCK.parseTc = function (tc, nominal) {
    var p = String(tc).split(':');
    if (p.length !== 4) return -1;
    return ((Number(p[0]) * 60 + Number(p[1])) * 60 + Number(p[2])) * nominal + Number(p[3]);
};

// --------------------------------------------------------------------- pistes

function MockTrack(seq, kind, index, frames) {
    this._seq = seq;
    this._kind = kind;
    this._index = index;
    this._locked = false;
    this._muted = false;
    this.name = (kind === 'V' ? 'Video ' : 'Audio ') + (index + 1);
    this._items = [];
    for (var i = 0; i < frames.length; i++) {
        this._items.push({ s: frames[i][0] * seq._tb, e: frames[i][1] * seq._tb });
    }
    this.clips = { numItems: 0 };
    this._rebuild();
}
MockTrack.prototype.isLocked = function () { return this._locked; };
MockTrack.prototype.setLocked = function (v) { this._locked = !!v; };
MockTrack.prototype.isMuted = function () { return this._muted; };
MockTrack.prototype.setMute = function (v) { this._muted = !!v; };

MockTrack.prototype._rebuild = function () {
    var self = this;
    if (this.clips && this.clips.numItems) this._syncDisabled();
    var i;
    this._items.sort(function (a, b) { return a.s - b.s; });
    for (i = 0; i < this._items.length; i++) {
        if (i > 0 && this._items[i].s < this._items[i - 1].e) {
            MOCK.errors.push(this._kind + (this._index + 1) + ' : chevauchement de clips');
        }
        if (this._items[i].s < 0) MOCK.errors.push(this._kind + (this._index + 1) + ' : clip avant zero');
    }
    for (var k in this.clips) {
        if (k !== 'numItems') delete this.clips[k];
    }
    this.clips.numItems = this._items.length;
    for (i = 0; i < this._items.length; i++) {
        this.clips[i] = (function (item, kind) {
            var inP = item.inP || 0;
            return {
                name: 'clip',
                start: { ticks: String(item.s), seconds: item.s / MOCK.TPS },
                end: { ticks: String(item.e), seconds: item.e / MOCK.TPS },
                inPoint: { seconds: inP, ticks: String(Math.round(inP * MOCK.TPS)) },
                mediaType: kind === 'V' ? 'Video' : 'Audio',
                projectItem: { nodeId: item.node || 'rush', name: 'rush.mp4', getMediaPath: function () { return 'C:/rush.mp4'; } },
                setSelected: function (b, updateUI) { MOCK.select(item, b, updateUI); },
                getLinkedItems: function () { return MOCK.linkedOf(item); },
                outPoint: { seconds: inP + (item.e - item.s) / MOCK.TPS * (item.speed || 1) },
                components: kind === 'V' && !item.noMotion ? MOCK.motionComponents(item) : { numItems: 0 },
                isSelected: function () { return item.sel === true; },
                remove: function (ripple, align) { self._remove(item, ripple); },
                move: function (t) { self._move(item, t); }
            };
        })(this._items[i], this._kind);
        // l'etat active / desactive survit aux reconstructions, comme dans Premiere
        if (this._items[i]._dis === undefined) this._items[i]._dis = false;
        this.clips[i].disabled = this._items[i]._dis;
        this.clips[i]._item = this._items[i];
    }
};

/** Secondes d'un argument de temps : nombre ou objet Time. */
MOCK.secs = function (t) {
    if (typeof t === 'number') {
        if (MOCK.config.keyNeedsTime) throw new Error('objet Time attendu');
        return t;
    }
    return t.seconds !== null ? t.seconds : Number(t.ticks) / MOCK.TPS;
};

/** Parametre animable simule (valeur nombre ou tableau). */
MOCK.newParam = function (name, value, animated) {
    return {
        displayName: name,
        _value: value,
        _varying: !!animated,
        _keys: animated ? [{ t: 0, v: value }] : [],
        _interp: {},
        isTimeVarying: function () { return this._varying; },
        setTimeVarying: function (b) {
            this._varying = !!b;
            if (!b) this._keys = [];
        },
        getValue: function () { return this._value; },
        setValue: function (v) { this._value = v; },
        addKey: function (t) {
            if (!this._varying) throw new Error('parametre non anime');
            var s = MOCK.secs(t);
            for (var i = 0; i < this._keys.length; i++) if (Math.abs(this._keys[i].t - s) < 1e-9) return;
            this._keys.push({ t: s, v: this._value });
            this._keys.sort(function (a, b) { return a.t - b.t; });
        },
        setValueAtKey: function (t, v) {
            var s = MOCK.secs(t);
            for (var i = 0; i < this._keys.length; i++) {
                if (Math.abs(this._keys[i].t - s) < 1e-9) {
                    this._keys[i].v = v;
                    return;
                }
            }
            throw new Error('aucune image cle a ' + s);
        },
        getKeys: function () {
            var out = [];
            for (var i = 0; i < this._keys.length; i++) out.push({ seconds: this._keys[i].t });
            return out;
        },
        setInterpolationTypeAtKey: function (t, type) { this._interp[MOCK.secs(t)] = type; }
    };
};

/** Effet Trajectoire simule : Position puis Echelle, comme dans Premiere. */
MOCK.motionComponents = function (item) {
    if (!item.scale) {
        item.scale = {
            displayName: MOCK.config.scaleName || 'Scale',
            _value: item.baseScale || 100,
            _varying: !!item.animated,
            _keys: item.animated ? [{ t: 0, v: 100 }] : [],
            _interp: {},
            isTimeVarying: function () { return this._varying; },
            setTimeVarying: function (b) {
                this._varying = !!b;
                if (!b) this._keys = [];
            },
            getValue: function () { return this._value; },
            setValue: function (v) { this._value = v; },
            addKey: function (t) {
                if (!this._varying) throw new Error('parametre non anime');
                var s = MOCK.secs(t);
                for (var i = 0; i < this._keys.length; i++) if (Math.abs(this._keys[i].t - s) < 1e-9) return;
                this._keys.push({ t: s, v: this._value });
                this._keys.sort(function (a, b) { return a.t - b.t; });
            },
            setValueAtKey: function (t, v) {
                var s = MOCK.secs(t);
                for (var i = 0; i < this._keys.length; i++) {
                    if (Math.abs(this._keys[i].t - s) < 1e-9) {
                        this._keys[i].v = v;
                        return;
                    }
                }
                throw new Error('aucune image cle a ' + s);
            },
            getKeys: function () {
                var out = [];
                for (var i = 0; i < this._keys.length; i++) out.push({ seconds: this._keys[i].t });
                return out;
            },
            setInterpolationTypeAtKey: function (t, type) { this._interp[MOCK.secs(t)] = type; }
        };
    }
    if (!item.position) {
        item.position = MOCK.newParam(MOCK.config.positionName || 'Position',
            MOCK.config.positionPixels ? [960, 540] : [0.5, 0.5], !!item.posAnimated);
    }
    var position = item.position;
    var motion = {
        matchName: MOCK.config.noMatchName ? '' : 'AE.ADBE Motion',
        displayName: MOCK.config.motionName || 'Motion',
        properties: { numItems: 2, 0: position, 1: item.scale }
    };
    var opacity = { matchName: 'AE.ADBE Opacity', displayName: 'Opacity', properties: { numItems: 0 } };
    return { numItems: 2, 0: opacity, 1: motion };
};

/** Etat desactive d'un clip, lu sur son objet clip (la ou le script l'ecrit). */
MOCK.disabledOf = function (item) {
    return item._dis === true;
};

/** Recopie dans les clips simules l'etat ecrit par le script avant toute reconstruction. */
MockTrack.prototype._syncDisabled = function () {
    for (var i = 0; i < this.clips.numItems; i++) {
        var w = this.clips[i];
        if (w && w._item) w._item._dis = w.disabled === true;
    }
};

MockTrack.prototype._remove = function (item, ripple) {
    MOCK.calls.remove++;
    if (this._locked) throw new Error('piste verrouillee');
    var idx = -1;
    var i;
    for (i = 0; i < this._items.length; i++) if (this._items[i] === item) idx = i;
    if (idx < 0) throw new Error('clip deja retire');
    var dur = item.e - item.s;
    this._items.splice(idx, 1);
    if (ripple && MOCK.config.rippleWorks) {
        for (i = idx; i < this._items.length; i++) {
            this._items[i].s -= dur;
            this._items[i].e -= dur;
        }
    }
    this._rebuild();
};

MockTrack.prototype._move = function (item, t) {
    MOCK.calls.move++;
    var delta = null;
    var accepts = MOCK.config.moveAccepts;
    if (typeof t === 'number') {
        if (accepts === 'number') delta = Math.round(t * MOCK.TPS);
    } else if (t && t.ticks !== null) {
        if (accepts === 'ticks') delta = Number(t.ticks);
    } else if (t && t.seconds !== null) {
        if (accepts === 'seconds') delta = Math.round(t.seconds * MOCK.TPS);
    }
    if (delta === null) return; // forme d'argument ignoree : rien ne bouge
    item.s += delta;
    item.e += delta;
    this._rebuild();
};

MockTrack.prototype._razor = function (tick) {
    this._syncDisabled();
    MOCK.calls.razor++;
    if (MOCK.config.razorDead || this._locked) return;
    for (var i = 0; i < this._items.length; i++) {
        var it = this._items[i];
        if (it.s < tick && tick < it.e) {
            var dis = MOCK.disabledOf(it);
            var cfg = MOCK.config.razorLinks || 'keep';
            // 'break' : les morceaux perdent leur lien ; 'keep' : ils restent tous lies ensemble ;
            // 'pairs' : chaque morceau reste lie a son vis-a-vis (ce que fait Premiere quand tout va bien)
            var lkL = cfg === 'break' ? null : it._lk;
            var lkR = cfg === 'break' ? null : cfg === 'pairs' && it._lk ? it._lk + '@' + tick : it._lk;
            var inR = (it.inP || 0) + (tick - it.s) / MOCK.TPS;
            this._items.splice(i, 1,
                { s: it.s, e: tick, _dis: dis, _lk: lkL, inP: it.inP, node: it.node },
                { s: tick, e: it.e, _dis: dis, _lk: lkR, inP: inR, node: it.node });
            this._rebuild();
            return;
        }
    }
};

/** Clips et etat : "0-60 60-90:off ..." */
MockTrack.prototype.states = function () {
    this._syncDisabled();
    var out = [];
    for (var i = 0; i < this._items.length; i++) {
        out.push(this._items[i].s / this._seq._tb + '-' + this._items[i].e / this._seq._tb + (this._items[i]._dis ? ':off' : ''));
    }
    return out.join(' ');
};

MockTrack.prototype.frames = function () {
    var out = [];
    for (var i = 0; i < this._items.length; i++) {
        out.push(this._items[i].s / this._seq._tb + '-' + this._items[i].e / this._seq._tb);
    }
    return out.join(' ');
};

// ------------------------------------------------------------------- sequence

function MockSequence(name, id, fps, layout) {
    this.name = name;
    this.sequenceID = id;
    this._nominal = fps;
    this._tb = MOCK.TPS / fps;
    this._zero = (layout.zeroFrames || 0) * this._tb;
    this.timebase = String(this._tb);
    this.zeroPoint = String(this._zero);
    this._in = -400000;
    this._out = -400000;
    this._layout = layout;
    var i;
    this.videoTracks = { numTracks: layout.V.length };
    for (i = 0; i < layout.V.length; i++) this.videoTracks[i] = new MockTrack(this, 'V', i, layout.V[i]);
    this.audioTracks = { numTracks: layout.A.length };
    for (i = 0; i < layout.A.length; i++) this.audioTracks[i] = new MockTrack(this, 'A', i, layout.A[i]);
    this.end = '0';
    this.frameSizeHorizontal = 1920;
    this.frameSizeVertical = 1080;
}
MockSequence.prototype.getSettings = function () {
    return { videoFrameRate: { ticks: String(this._tb), seconds: this._tb / MOCK.TPS }, videoDisplayFormat: 104 };
};
MockSequence.prototype.getInPoint = function () { return String(this._in); };
MockSequence.prototype.getOutPoint = function () { return String(this._out); };
MockSequence.prototype.setOutPoint = function (sec) { this._out = sec; };
MockSequence.prototype.setPlayerPosition = function (ticks) { this._cti = ticks; };
MockSequence.prototype.exportAsMediaDirect = function () { return 'No Error'; };
/** Clips lies a un clip simule (lui compris), sur toutes les pistes de la sequence active. */
MOCK.linkedOf = function (item) {
    var out = { numItems: 0 };
    if (!item._lk) return out;
    var seq = MOCK.seq;
    var groups = [seq.videoTracks, seq.audioTracks];
    for (var g = 0; g < 2; g++) {
        for (var i = 0; i < groups[g].numTracks; i++) {
            var tr = groups[g][i];
            for (var j = 0; j < tr._items.length; j++) {
                if (tr._items[j]._lk === item._lk) {
                    out[out.numItems] = tr.clips[j];
                    out.numItems++;
                }
            }
        }
    }
    return out;
};

MOCK.forSelected = function (seq, fn) {
    var groups = [seq.videoTracks, seq.audioTracks];
    for (var g = 0; g < 2; g++) {
        for (var i = 0; i < groups[g].numTracks; i++) {
            var tr = groups[g][i];
            for (var j = 0; j < tr._items.length; j++) if (tr._items[j].sel === true) fn(tr._items[j]);
        }
    }
};

/**
 * Selection simulee, avec deux comportements reels possibles de Premiere :
 *  - linkedSelect : selectionner un clip lie selectionne aussi ses partenaires ;
 *  - selectionNeedsUI : getSelection ne voit que ce qui a ete selectionne avec
 *    mise a jour de l'interface, alors que la liaison agit sur toute la selection.
 */
MOCK.select = function (item, b, updateUI) {
    var targets = [item];
    if (b && MOCK.config.linkedSelect && item._lk) {
        var groups = [MOCK.seq.videoTracks, MOCK.seq.audioTracks];
        for (var g = 0; g < 2; g++) {
            for (var i = 0; i < groups[g].numTracks; i++) {
                var its = groups[g][i]._items;
                for (var j = 0; j < its.length; j++) if (its[j] !== item && its[j]._lk === item._lk) targets.push(its[j]);
            }
        }
    }
    for (var k = 0; k < targets.length; k++) {
        targets[k].sel = !!b;
        if (updateUI) targets[k].uiSel = !!b;
    }
};

MOCK.linkSeq = 0;
MockSequence.prototype.linkSelection = function () {
    MOCK.calls.link = (MOCK.calls.link || 0) + 1;
    var id = 'L' + (++MOCK.linkSeq);
    MOCK.forSelected(this, function (it) { it._lk = id; });
    return true;
};
MockSequence.prototype.unlinkSelection = function () {
    MOCK.forSelected(this, function (it) { it._lk = null; });
    return true;
};

/** Liens d'une piste : "0-61:L1 61-182:L2 ..." (vide si non lie). */
MOCK.links = function (track) {
    var out = [];
    for (var i = 0; i < track._items.length; i++) {
        var it = track._items[i];
        out.push(it.s / track._seq._tb + '-' + it.e / track._seq._tb + ':' + (it._lk || '-'));
    }
    return out.join(' ');
};

MockSequence.prototype.getSelection = function () {
    if (MOCK.config.noGetSelection) throw new Error('getSelection indisponible');
    var out = [];
    var groups = [this.videoTracks, this.audioTracks];
    for (var g = 0; g < 2; g++) {
        for (var i = 0; i < groups[g].numTracks; i++) {
            var tr = groups[g][i];
            for (var j = 0; j < tr._items.length; j++) {
                var vis = MOCK.config.selectionNeedsUI ? tr._items[j].uiSel === true : tr._items[j].sel === true;
                if (vis) out.push(tr.clips[j]);
            }
        }
    }
    return out;
};
MockSequence.prototype.clone = function () {
    MOCK.calls.clone++;
    var copy = new MockSequence(this.name + ' Copy', this.sequenceID + '-copie', this._nominal, MOCK.snapshotLayout(this));
    var seqs = app.project.sequences;
    seqs[seqs.numSequences] = copy;
    seqs.numSequences++;
    if (MOCK.config.cloneSwitches) {
        app.project.activeSequence = copy;
        MOCK.seq = copy;
    }
    return true;
};

MOCK.snapshotLayout = function (seq) {
    var layout = { V: [], A: [], zeroFrames: seq._zero / seq._tb };
    var i, j, tr, list;
    for (i = 0; i < seq.videoTracks.numTracks; i++) {
        tr = seq.videoTracks[i];
        list = [];
        for (j = 0; j < tr._items.length; j++) list.push([tr._items[j].s / seq._tb, tr._items[j].e / seq._tb]);
        layout.V.push(list);
    }
    for (i = 0; i < seq.audioTracks.numTracks; i++) {
        tr = seq.audioTracks[i];
        list = [];
        for (j = 0; j < tr._items.length; j++) list.push([tr._items[j].s / seq._tb, tr._items[j].e / seq._tb]);
        layout.A.push(list);
    }
    return layout;
};

// ----------------------------------------------------------------- application

var app = null;
var qe = null;

// ------------------------------------------------------- projet (chutiers, medias)

/** Medias connus du simulateur : chemin en minuscules -> { dur (s), still }. */
MOCK.media = {};

MOCK.newBin = function (name) {
    var bin = { name: name, type: 2, children: { numItems: 0 } };
    bin.createBin = function (n) {
        if (MOCK.config.createBinReturnsNothing) {
            MOCK.addChild(bin, MOCK.newBin(n));
            return undefined;
        }
        return MOCK.addChild(bin, MOCK.newBin(n));
    };
    return bin;
};

MOCK.addChild = function (bin, child) {
    bin.children[bin.children.numItems] = child;
    bin.children.numItems++;
    child._parent = bin;
    return child;
};

/** Element de projet : media importe (video ou image fixe) ou sous-clip. */
MOCK.newMediaItem = function (path, media, subOf) {
    var name = String(path).replace(/^.*[\\\/]/, '');
    var it = {
        name: name,
        type: 1,
        _path: path,
        _dur: media.dur,
        _still: !!media.still,
        _in: 0,
        _out: media.still ? 5 : media.dur, // image fixe : 5 s par defaut, comme Premiere
        _sub: !!subOf,
        getMediaPath: function () { return this._path; },
        setInPoint: function (sec, type) { this._in = typeof sec === 'number' ? sec : sec.seconds; },
        setOutPoint: function (sec, type) { this._out = typeof sec === 'number' ? sec : sec.seconds; },
        createSubClip: function (n, a, b, hard, takeVideo, takeAudio) {
            MOCK.calls.subclip = (MOCK.calls.subclip || 0) + 1;
            if (MOCK.config.subclipNeedsTicks && typeof a !== 'string') throw new Error('ticks attendus');
            var s = typeof a === 'string' ? Number(a) / MOCK.TPS : a.seconds;
            var e = typeof b === 'string' ? Number(b) / MOCK.TPS : b.seconds;
            if (!(e > s) || e > this._dur + 1e-6) throw new Error('bornes du sous-clip invalides');
            var sub = MOCK.newMediaItem(this._path, { dur: this._dur }, this);
            sub.name = n;
            sub._in = s;
            sub._out = e;
            sub._takeVideo = takeVideo;
            sub._takeAudio = takeAudio;
            MOCK.addChild(this._parent, sub);
            return sub;
        }
    };
    return it;
};

/** Pose un element du projet sur une piste en ecrasant ce qui s'y trouve deja. */
MockTrack.prototype.overwriteClip = function (projectItem, time) {
    MOCK.calls.overwrite = (MOCK.calls.overwrite || 0) + 1;
    if (MOCK.config.overwriteNeedsTime && typeof time === 'number') throw new Error('objet Time attendu');
    if (this._kind !== 'V') throw new Error('mock : pistes video seulement');
    var startSec = typeof time === 'number' ? time : (time.ticks !== null ? Number(time.ticks) / MOCK.TPS : time.seconds);
    var tb = this._seq._tb;
    var s = Math.round(startSec * MOCK.TPS / tb) * tb;
    var e = s + Math.round((projectItem._out - projectItem._in) * MOCK.TPS / tb) * tb;
    var keep = [];
    for (var i = 0; i < this._items.length; i++) {
        var o = this._items[i];
        if (o.e <= s || o.s >= e) keep.push(o);
        else {
            if (o.s < s) keep.push({ s: o.s, e: s });
            if (o.e > e) keep.push({ s: e, e: o.e });
        }
    }
    keep.push({ s: s, e: e, media: projectItem._path, srcIn: projectItem._in, audio: projectItem._takeAudio !== 0 && !projectItem._still,
                baseScale: 100 });
    this._items = keep;
    this._rebuild();
    return true;
};

/** Installe une sequence simulee comme sequence active. */
MOCK.install = function (fps, layout) {
    var seq = new MockSequence('Rush', 'seq-1', fps, layout);
    MOCK.seq = seq;
    app = {
        version: '26.0.0-mock',
        path: 'C:\\Mock\\',
        enableQE: function () {},
        project: {
            activeSequence: seq,
            path: 'C:\\Projets\\Rush.prproj',
            rootItem: MOCK.newBin('Racine'),
            importFiles: function (paths, suppress, bin, numbered) {
                MOCK.calls.importFiles = (MOCK.calls.importFiles || 0) + 1;
                if (MOCK.config.importFails) throw new Error('import refuse');
                for (var i = 0; i < paths.length; i++) {
                    var media = MOCK.media[String(paths[i]).toLowerCase()] || { dur: 10 };
                    MOCK.addChild(bin || app.project.rootItem, MOCK.newMediaItem(paths[i], media));
                }
                return true;
            },
            sequences: { numSequences: 1, 0: seq },
            openSequence: function (id) {
                for (var i = 0; i < this.sequences.numSequences; i++) {
                    if (this.sequences[i].sequenceID === id) {
                        this.activeSequence = this.sequences[i];
                        MOCK.seq = this.sequences[i];
                        return true;
                    }
                }
                return false;
            }
        }
    };
    qe = {
        project: {
            getActiveSequence: function () {
                var s = app.project.activeSequence;
                function wrap(track) {
                    return {
                        razor: function (tc) {
                            var frame = MOCK.parseTc(tc, s._nominal);
                            if (frame < 0) return;
                            track._razor(frame * s._tb - s._zero);
                        }
                    };
                }
                return {
                    name: s.name,
                    numVideoTracks: s.videoTracks.numTracks,
                    numAudioTracks: s.audioTracks.numTracks,
                    getVideoTrackAt: function (i) { return wrap(s.videoTracks[i]); },
                    getAudioTrackAt: function (i) { return wrap(s.audioTracks[i]); }
                };
            }
        }
    };
    return seq;
};
