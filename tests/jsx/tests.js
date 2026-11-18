/* Scenarios de decoupe sur la timeline simulee. Lancer : cscript //nologo tests\jsx\run.wsf */

var T_fso = new ActiveXObject('Scripting.FileSystemObject');
var T_tmp = T_fso.GetSpecialFolder(2).Path + '\\firstcut-plan-test.txt';
var T_pass = 0;
var T_fail = 0;
var T_current = '';

function T_check(cond, what) {
    if (cond) {
        T_pass++;
    } else {
        T_fail++;
        WScript.Echo('  ECHEC [' + T_current + '] ' + what);
    }
}

function T_eq(actual, expected, what) {
    T_check(String(actual) === String(expected),
        what + '\n      obtenu  : ' + actual + '\n      attendu : ' + expected);
}

function T_writePlan(p) {
    var lines = [];
    lines.push('mode=' + (p.mode || 'delete'));
    lines.push('sequenceId=' + (p.seqId || 'seq-1'));
    lines.push('timebase=' + MOCK.seq.timebase);
    lines.push('backup=' + (p.backup ? '1' : '0'));
    lines.push('backupName=' + (p.backupName || 'Rush - sauvegarde'));
    lines.push('detectTracks=' + (p.detect || '0'));
    lines.push('outFrame=' + (p.outFrame === undefined ? -1 : p.outFrame));
    var i;
    var V = p.V || p.A;
    for (i = 0; i < V.length; i++) lines.push('V ' + V[i][0] + ' ' + V[i][1]);
    for (i = 0; i < p.A.length; i++) lines.push('A ' + p.A[i][0] + ' ' + p.A[i][1]);
    var f = T_fso.CreateTextFile(T_tmp, true, false);
    f.Write(lines.join('\r\n') + '\r\n');
    f.Close();
}

/** Deroule une decoupe complete et rend { begin, finish }. */
function T_run(p) {
    T_writePlan(p);
    var begin = eval('(' + ADR_begin(T_tmp) + ')');
    if (!begin.ok) return { begin: begin, finish: null };
    var guard = 0;
    var step;
    do {
        step = eval('(' + ADR_step(5) + ')');
        guard++;
    } while (step.ok && !step.finished && guard < 100000);
    var finish = eval('(' + ADR_finish() + ')');
    return { begin: begin, finish: finish };
}

function T_scenario(name, fn) {
    T_current = name;
    MOCK.resetConfig();
    var before = T_fail;
    try {
        fn();
    } catch (e) {
        T_fail++;
        WScript.Echo('  ECHEC [' + name + '] exception : ' + (e.message || e));
    }
    T_check(MOCK.errors.length === 0, 'erreurs du simulateur : ' + MOCK.errors.join(' ; '));
    WScript.Echo((T_fail === before ? 'ok   ' : 'KO   ') + name);
}

var SIL = [[0, 59], [120, 179], [300, 360]];

// ---------------------------------------------------------------------------

T_scenario('timecode : images compensees (drop frame)', function () {
    T_eq(adr_manualTc(0, 29.97, true), '00;00;00;00', 'image 0');
    T_eq(adr_manualTc(1799, 29.97, true), '00;00;59;29', 'image 1799');
    T_eq(adr_manualTc(1800, 29.97, true), '00;01;00;02', 'image 1800');
    T_eq(adr_manualTc(17982, 29.97, true), '00;10;00;00', 'image 17982');
    T_eq(adr_manualTc(107892, 29.97, true), '01;00;00;00', 'une heure');
    T_eq(adr_manualTc(3600, 59.94, true), '00;01;00;04', '59,94 : image 3600');
    T_eq(adr_manualTc(90, 30, false), '00:00:03:00', 'sans compensation');
    T_eq(adr_manualTc(86400, 23.976, false), '01:00:00:00', '23,976 : une heure de timecode');
});

T_scenario('lecture de la sequence', function () {
    MOCK.install(30, { V: [[[0, 1800]]], A: [[[0, 1800]], []] });
    MOCK.seq.audioTracks[1]._muted = true;
    var info = eval('(' + ADR_getInfo() + ')');
    T_check(info.ok, 'getInfo ok');
    T_eq(info.sequence.id, 'seq-1', 'identifiant');
    T_eq(info.sequence.timebase, MOCK.TPS / 30, 'timebase');
    T_eq(info.sequence.contentEndTicks, 1800 * (MOCK.TPS / 30), 'fin du contenu');
    T_eq(info.sequence.inSec, -400000, 'point d entree non pose');
    T_eq(info.audio.length, 2, 'pistes audio');
    T_check(info.audio[1].muted === true && info.audio[0].muted === false, 'etat muet');
    T_eq(info.sequence.fingerprint, 'V0:1:' + 1800 * (MOCK.TPS / 30) + '|A0:1:' + 1800 * (MOCK.TPS / 30) + '|A1:0:0', 'empreinte');
});

T_scenario('plan de la timeline : couverture des pistes et clips selectionnes', function () {
    var tb = MOCK.TPS / 30;
    MOCK.install(30, {
        V: [[[0, 300], [300, 600], [700, 900]]],
        A: [[[0, 300], [300, 600], [700, 900]], []]
    });
    // un clip video et son audio (meme plage), plus un clip isole plus loin
    MOCK.seq.videoTracks[0]._items[1].sel = true;
    MOCK.seq.audioTracks[0]._items[1].sel = true;
    MOCK.seq.audioTracks[0]._items[2].sel = true;
    var l = eval('(' + ADR_getLayout() + ')');
    T_check(l.ok, 'getLayout ok');
    T_eq(l.audio[0].spans.join(' | '), [0, 600 * tb].join(',') + ' | ' + [700 * tb, 900 * tb].join(','), 'clips contigus fusionnes');
    T_eq(l.audio[1].spans.length, 0, 'piste vide');
    T_eq(l.selectedCount, 3, 'clips selectionnes');
    T_eq(l.selection.join(' | '), [300 * tb, 600 * tb].join(',') + ' | ' + [700 * tb, 900 * tb].join(','), 'plages selectionnees');

    // meme resultat quand getSelection n'existe pas (on interroge chaque clip)
    MOCK.config.noGetSelection = true;
    var l2 = eval('(' + ADR_getLayout() + ')');
    T_eq(l2.selection.join(' | '), l.selection.join(' | '), 'repli isSelected');
});

T_scenario('supprimer : deux sections separees (clips selectionnes)', function () {
    MOCK.install(30, { V: [[[0, 1800]]], A: [[[0, 1800]]] });
    // sections 300-600 et 900-1200 : rien n'est coupe en dehors
    var r = T_run({ mode: 'delete', A: [[300, 330], [450, 480], [900, 960], [1170, 1200]] });
    T_check(r.finish && r.finish.ok, 'finish : ' + (r.finish && r.finish.error));
    T_eq(MOCK.seq.videoTracks[0].frames(), '0-300 300-420 420-840 840-1050 1050-1650', 'V1');
    T_eq(MOCK.seq.audioTracks[0].frames(), MOCK.seq.videoTracks[0].frames(), 'A1');
    T_eq(r.finish.mismatch, 0, 'controle final');
});

T_scenario('supprimer : rush simple V1 + A1', function () {
    MOCK.install(30, { V: [[[0, 1800]]], A: [[[0, 1800]]] });
    var r = T_run({ mode: 'delete', A: SIL });
    T_check(r.begin.ok, 'begin : ' + r.begin.error);
    T_check(r.finish && r.finish.ok, 'finish : ' + (r.finish && r.finish.error));
    T_eq(MOCK.seq.videoTracks[0].frames(), '0-61 61-182 182-1622', 'V1');
    T_eq(MOCK.seq.audioTracks[0].frames(), '0-61 61-182 182-1622', 'A1');
    T_eq(r.finish.mismatch, 0, 'controle final');
    T_eq(r.finish.removed, 6, 'clips retires');
    // 5 points de coupe par piste : 59, 120, 179, 300, 360 (0 est deja un bord de clip)
    T_eq(r.finish.razorDone, 10, 'coupes posees');
    T_eq(MOCK.calls.move, 0, 'aucun deplacement manuel');
    T_check(Math.abs(r.finish.removedSeconds - 178 / 30) < 1e-9, 'duree retiree');
});

T_scenario('supprimer : plusieurs clips, coupes deja presentes', function () {
    // un point de montage existe deja a 120 et a 300 : pas de rasoir a cet endroit
    MOCK.install(30, { V: [[[0, 120], [120, 300], [300, 900]]], A: [[[0, 120], [120, 300], [300, 900]]] });
    var r = T_run({ mode: 'delete', A: SIL });
    T_check(r.finish && r.finish.ok, 'finish');
    T_eq(MOCK.seq.videoTracks[0].frames(), '0-61 61-182 182-722', 'V1');
    T_eq(MOCK.seq.audioTracks[0].frames(), '0-61 61-182 182-722', 'A1');
    // restent 59, 179 et 360 sur chacune des deux pistes
    T_eq(r.finish.razorDone, 6, 'seulement les coupes necessaires');
});

T_scenario('supprimer : piste a trous (B-roll) resynchronisee', function () {
    MOCK.install(30, {
        V: [[[0, 1800]], [[150, 320], [500, 560]]],
        A: [[[0, 1800]]]
    });
    var r = T_run({ mode: 'delete', A: SIL });
    T_check(r.finish && r.finish.ok, 'finish : ' + (r.finish && r.finish.error));
    T_eq(MOCK.seq.videoTracks[0].frames(), '0-61 61-182 182-1622', 'V1');
    // B-roll 150-320 : coupe a 179 et 300 ; 179-300 garde, recule de 118 images
    T_eq(MOCK.seq.videoTracks[1].frames(), '61-182 322-382', 'V2');
    T_eq(MOCK.seq.audioTracks[0].frames(), '0-61 61-182 182-1622', 'A1');
    T_eq(r.finish.mismatch, 0, 'controle final');
    T_check(MOCK.calls.move > 0, 'deplacement manuel utilise sur la piste a trous');
});

T_scenario('supprimer : titre place dans un silence, piste plus courte', function () {
    MOCK.install(30, { V: [[[0, 900]], [[130, 170]]], A: [[[0, 900]]] });
    var r = T_run({ mode: 'delete', A: SIL });
    T_check(r.finish && r.finish.ok, 'finish');
    T_eq(MOCK.seq.videoTracks[1].frames(), '', 'V2 : le titre etait dans un silence');
    T_eq(MOCK.seq.videoTracks[0].frames(), '0-61 61-182 182-722', 'V1');
    T_eq(r.finish.mismatch, 0, 'controle final');
});

T_scenario('supprimer : Premiere ne resserre pas (repli deplacement)', function () {
    MOCK.install(30, { V: [[[0, 1800]]], A: [[[0, 1800]]] });
    MOCK.config.rippleWorks = false;
    var r = T_run({ mode: 'delete', A: SIL });
    T_check(r.finish && r.finish.ok, 'finish : ' + (r.finish && r.finish.error));
    T_eq(MOCK.seq.videoTracks[0].frames(), '0-61 61-182 182-1622', 'V1');
    T_eq(MOCK.seq.audioTracks[0].frames(), '0-61 61-182 182-1622', 'A1');
    T_eq(r.finish.mismatch, 0, 'controle final');
});

T_scenario('supprimer : move() n accepte que des secondes', function () {
    MOCK.install(30, { V: [[[0, 1800]], [[500, 560]]], A: [[[0, 1800]]] });
    MOCK.config.moveAccepts = 'seconds';
    var r = T_run({ mode: 'delete', A: SIL });
    T_check(r.finish && r.finish.ok, 'finish : ' + (r.finish && r.finish.error));
    T_eq(MOCK.seq.videoTracks[1].frames(), '322-382', 'V2');
    T_eq(r.finish.mismatch, 0, 'controle final');
});

T_scenario('supprimer : move() indisponible -> arret explicite', function () {
    MOCK.install(30, { V: [[[0, 1800]], [[500, 560]]], A: [[[0, 1800]]] });
    MOCK.config.moveAccepts = 'aucun';
    var r = T_run({ mode: 'delete', A: SIL });
    T_check(r.finish && !r.finish.ok, 'la decoupe doit se declarer en echec');
    T_eq(r.finish.code, 'MOVE_FAILED', 'code d erreur');
});

T_scenario('supprimer en laissant les espaces', function () {
    MOCK.install(30, { V: [[[0, 900]]], A: [[[0, 900]]] });
    var r = T_run({ mode: 'delete_keep_spaces', A: SIL });
    T_check(r.finish && r.finish.ok, 'finish');
    T_eq(MOCK.seq.videoTracks[0].frames(), '59-120 179-300 360-900', 'V1');
    T_eq(MOCK.seq.audioTracks[0].frames(), '59-120 179-300 360-900', 'A1');
    T_eq(r.finish.removedSeconds, 0, 'la duree ne change pas');
});

T_scenario('garder : coupes seulement', function () {
    MOCK.install(30, { V: [[[0, 900]]], A: [[[0, 900]]] });
    var r = T_run({ mode: 'keep', A: SIL });
    T_check(r.finish && r.finish.ok, 'finish');
    T_eq(MOCK.seq.videoTracks[0].frames(), '0-59 59-120 120-179 179-300 300-360 360-900', 'V1');
    T_eq(r.finish.removed, 0, 'rien de retire');
    T_eq(MOCK.calls.remove, 0, 'aucun appel de suppression');
});

T_scenario('rendre muet : seules les pistes analysees perdent leur son', function () {
    MOCK.install(30, { V: [[[0, 900]]], A: [[[0, 900]], [[0, 900]]] });
    var r = T_run({ mode: 'mute', A: SIL, detect: '0' });
    T_check(r.finish && r.finish.ok, 'finish');
    T_eq(MOCK.seq.videoTracks[0].frames(), '0-900', 'V1 intacte');
    T_eq(MOCK.seq.audioTracks[0].frames(), '59-120 179-300 360-900', 'A1');
    T_eq(MOCK.seq.audioTracks[1].frames(), '0-900', 'A2 intacte');
});

T_scenario('piste verrouillee : ignoree et signalee', function () {
    MOCK.install(30, { V: [[[0, 900]], [[0, 900]]], A: [[[0, 900]]] });
    MOCK.seq.videoTracks[1]._locked = true;
    var r = T_run({ mode: 'delete', A: SIL });
    T_check(r.finish && r.finish.ok, 'finish');
    T_eq(r.begin.lockedSkipped.join(','), 'V2', 'piste signalee');
    T_eq(MOCK.seq.videoTracks[1].frames(), '0-900', 'V2 non touchee');
    T_eq(MOCK.seq.videoTracks[0].frames(), '0-61 61-182 182-722', 'V1');
});

T_scenario('J-cut : image et son coupes a des instants differents, meme duree', function () {
    MOCK.install(30, { V: [[[0, 900]]], A: [[[0, 900]]] });
    var r = T_run({ mode: 'delete', A: [[120, 180], [300, 360]], V: [[132, 192], [312, 372]] });
    T_check(r.finish && r.finish.ok, 'finish : ' + (r.finish && r.finish.error));
    T_eq(MOCK.seq.audioTracks[0].frames(), '0-120 120-240 240-780', 'A1');
    T_eq(MOCK.seq.videoTracks[0].frames(), '0-132 132-252 252-780', 'V1');
    T_eq(r.finish.mismatch, 0, 'controle final');
});

T_scenario('sauvegarde : la copie reste intacte, meme si Premiere bascule dessus', function () {
    MOCK.install(30, { V: [[[0, 900]]], A: [[[0, 900]]] });
    MOCK.config.cloneSwitches = true;
    var r = T_run({ mode: 'delete', A: SIL, backup: true, backupName: 'Rush - avant derush' });
    T_check(r.finish && r.finish.ok, 'finish : ' + (r.begin.error || (r.finish && r.finish.error)));
    T_eq(app.project.sequences.numSequences, 2, 'une copie creee');
    T_eq(app.project.sequences[1].name, 'Rush - avant derush', 'nom de la copie');
    T_eq(app.project.sequences[1].videoTracks[0].frames(), '0-900', 'copie intacte');
    T_eq(app.project.sequences[0].videoTracks[0].frames(), '0-61 61-182 182-722', 'originale coupee');
    T_eq(r.finish.backupName, 'Rush - avant derush', 'nom rendu au panneau');
});

T_scenario('timecode de depart non nul et getFormatted absent', function () {
    MOCK.install(30, { V: [[[0, 900]]], A: [[[0, 900]]], zeroFrames: 108000 });
    MOCK.config.formattedThrows = true;
    var r = T_run({ mode: 'delete', A: SIL });
    T_check(r.finish && r.finish.ok, 'finish : ' + (r.finish && r.finish.error));
    T_eq(MOCK.seq.videoTracks[0].frames(), '0-61 61-182 182-722', 'V1');
});

T_scenario('rasoir sans effet : arret avant toute suppression', function () {
    MOCK.install(30, { V: [[[0, 900]]], A: [[[0, 900]]] });
    MOCK.config.razorDead = true;
    var r = T_run({ mode: 'delete', A: SIL });
    T_check(r.finish && !r.finish.ok, 'echec declare');
    T_eq(r.finish.code, 'RAZOR_FAILED', 'code d erreur');
    T_eq(MOCK.seq.videoTracks[0].frames(), '0-900', 'timeline intacte');
    T_eq(MOCK.calls.remove, 0, 'aucune suppression tentee');
});

T_scenario('sequence changee depuis l analyse : refus', function () {
    MOCK.install(30, { V: [[[0, 900]]], A: [[[0, 900]]] });
    var r = T_run({ mode: 'delete', A: SIL, seqId: 'autre-sequence' });
    T_check(!r.begin.ok, 'begin refuse');
    T_eq(r.begin.code, 'SEQ_CHANGED', 'code d erreur');
    T_eq(MOCK.seq.videoTracks[0].frames(), '0-900', 'timeline intacte');
});

T_scenario('point de sortie recale apres resserrement', function () {
    MOCK.install(30, { V: [[[0, 900]]], A: [[[0, 900]]] });
    var r = T_run({ mode: 'delete', A: [[120, 179], [300, 360]], outFrame: 600 });
    T_check(r.finish && r.finish.ok && r.finish.outMoved, 'sortie recalee');
    T_check(Math.abs(MOCK.seq._out - (600 - 119) / 30) < 1e-9, 'nouvelle sortie : ' + MOCK.seq._out);
});

T_scenario('annulation en cours de route', function () {
    MOCK.install(30, { V: [[[0, 900]]], A: [[[0, 900]]] });
    T_writePlan({ mode: 'delete', A: SIL });
    var b = eval('(' + ADR_begin(T_tmp) + ')');
    T_check(b.ok, 'begin');
    var c = eval('(' + ADR_cancel() + ')');
    T_check(!c.ok && c.code === 'CANCELLED', 'annulation rendue comme telle');
    T_eq(eval('(' + ADR_step(5) + ')').code, 'NO_STATE', 'plus de decoupe en cours');
});

T_scenario('long rush : 400 silences sur 3 pistes', function () {
    var sil = [];
    var f = 30;
    for (var i = 0; i < 400; i++) {
        sil.push([f, f + 20 + (i % 7)]);
        f += 20 + (i % 7) + 45 + (i % 11);
    }
    var end = f + 100;
    MOCK.install(30, { V: [[[0, end]]], A: [[[0, end]], [[0, end]]] });
    var r = T_run({ mode: 'delete', A: sil });
    T_check(r.finish && r.finish.ok, 'finish : ' + (r.finish && r.finish.error));
    T_eq(r.finish.mismatch, 0, 'controle final');
    T_eq(r.finish.removed, 1200, 'clips retires');
    var removed = 0;
    for (var k = 0; k < sil.length; k++) removed += sil[k][1] - sil[k][0];
    var tr = MOCK.seq.videoTracks[0];
    T_eq(tr._items[tr._items.length - 1].e / MOCK.seq._tb, end - removed, 'duree finale');
    T_eq(MOCK.seq.audioTracks[1].frames(), MOCK.seq.videoTracks[0].frames(), 'pistes identiques');
});

// =========================================================== ZOOM

var F = MOCK.TPS / 30; // une image a 30 i/s, en ticks

/** Change les proprietes d'un clip simule (echelle, point d'entree...) puis le reconstruit. */
function T_setClip(kind, track, clip, props) {
    var tr = kind === 'V' ? MOCK.seq.videoTracks[track] : MOCK.seq.audioTracks[track];
    var item = tr._items[clip];
    for (var k in props) if (props.hasOwnProperty(k)) item[k] = props[k];
    delete item.scale;
    delete item.position;
    tr._rebuild();
    return item;
}

/** Echelle simulee d'un clip video. */
function T_scale(track, clip) {
    return MOCK.seq.videoTracks[track]._items[clip].scale;
}

function T_writeZoomPlan(items, opts) {
    opts = opts || {};
    var lines = ['sequenceId=' + (opts.seqId || 'seq-1'), 'backup=' + (opts.backup ? '1' : '0'),
                 'backupName=' + (opts.backupName || 'Rush - avant Zoom')];
    for (var i = 0; i < items.length; i++) {
        var z = items[i];
        lines.push('Z ' + z[0] + ' ' + z[1] + ' ' + z[2] * F + ' ' + z[3] * F + ' ' + z[4] + ' ' + z[5] + ' ' +
                   (z[6] || 0) + ' ' + (z[7] === 0 ? '0' : '1'));
    }
    var f = T_fso.CreateTextFile(T_tmp, true, false);
    f.Write(lines.join('\r\n') + '\r\n');
    f.Close();
}

/** Deroule un Zoom complet : { begin, finish }. */
function T_zoom(items, opts) {
    T_writeZoomPlan(items, opts);
    var begin = eval('(' + ADZ_begin(T_tmp) + ')');
    if (!begin.ok) return { begin: begin, finish: null };
    var guard = 0;
    var step;
    do {
        step = eval('(' + ADZ_step(5) + ')');
        guard++;
    } while (step.ok && !step.finished && guard < 100000);
    return { begin: begin, finish: eval('(' + ADZ_finish() + ')') };
}

function T_near(a, b) {
    return Math.abs(a - b) < 1e-6;
}

function T_keys(sc) {
    var out = [];
    for (var i = 0; i < sc._keys.length; i++) out.push(sc._keys[i].t.toFixed(4) + '=' + sc._keys[i].v);
    return out.join(' ');
}

var LAYOUT_Z = { V: [[[0, 60], [60, 150], [150, 300]], [[30, 90]]], A: [[[0, 300]]] };

T_scenario('zoom : liste des clips video', function () {
    MOCK.install(30, LAYOUT_Z);
    T_setClip('V', 0, 1, { sel: true });
    T_setClip('V', 0, 2, { animated: true });
    T_setClip('V', 1, 0, { noMotion: true });
    var r = eval('(' + ADZ_listClips('0,1,7') + ')');
    T_check(r.ok, 'listClips ok');
    T_eq(r.tracks.length, 2, 'piste inexistante ignoree');
    var c = r.tracks[0].clips;
    T_eq(c.length, 3, 'clips de V1');
    T_eq(c[1].s + '-' + c[1].e, 60 * F + '-' + 150 * F, 'bornes en ticks');
    T_eq(c[0].sel + ',' + c[1].sel, 'false,true', 'selection');
    T_eq(c[2].animated + ',' + c[0].animated, 'true,false', 'echelle deja animee');
    T_eq(r.tracks[1].clips[0].motion, false, 'clip sans Trajectoire');
    var lay = eval('(' + ADR_getLayout() + ')');
    T_eq(lay.video.length, 2, 'getLayout rend aussi les pistes video');
    T_eq(lay.video[0].spans.join('|'), [0, 300 * F].join(','), 'couverture de V1');
});

T_scenario('zoom : progressif, relatif a l echelle actuelle, temps du media source', function () {
    MOCK.install(30, LAYOUT_Z);
    T_setClip('V', 0, 1, { inP: 10, baseScale: 50 });
    var r = T_zoom([[0, 1, 60, 150, 100, 110, 0, 1]]);
    T_check(r.finish && r.finish.ok, 'finish : ' + (r.finish && r.finish.notes));
    var sc = T_scale(0, 1);
    T_check(sc._varying, 'echelle animee');
    // 3 s de clip : images cles a 10 s (entree du media) et 10 + 3 - 1/30 s
    T_eq(T_keys(sc), '10.0000=50 ' + (10 + 3 - 1 / 30).toFixed(4) + '=55', 'images cles');
    T_eq(sc._interp[10], ADZ_KF_BEZIER, 'courbe douce');
    T_eq(T_scale(0, 0)._varying, false, 'les autres clips ne bougent pas');
});

T_scenario('zoom : zoom fixe, duree courte, lineaire', function () {
    MOCK.install(30, LAYOUT_Z);
    var r = T_zoom([[0, 0, 0, 60, 115, 115, 0, 1], [0, 2, 150, 300, 100, 120, 0.5, 0]]);
    T_check(r.finish && r.finish.ok, 'finish');
    T_eq(T_scale(0, 0)._varying + ' ' + T_scale(0, 0)._value, 'false 115', 'fixe : pas d image cle');
    T_eq(T_keys(T_scale(0, 2)), '0.0000=100 ' + (0.5 - 1 / 30).toFixed(4) + '=120', 'zoom en 0,5 s');
    T_eq(T_scale(0, 2)._interp[0] === undefined, true, 'lineaire : interpolation laissee par defaut');
});

T_scenario('zoom : clip accelere x2', function () {
    MOCK.install(30, LAYOUT_Z);
    T_setClip('V', 0, 2, { inP: 4, speed: 2 });
    var r = T_zoom([[0, 2, 150, 300, 100, 110]]);
    T_check(r.finish && r.finish.ok, 'finish');
    // 5 s de timeline = 10 s de media
    T_eq(T_keys(T_scale(0, 2)), '4.0000=100 ' + (4 + (5 - 1 / 30) * 2).toFixed(4) + '=110', 'images cles');
});

T_scenario('zoom : deja anime ignore, clip disparu signale', function () {
    MOCK.install(30, LAYOUT_Z);
    T_setClip('V', 0, 1, { animated: true });
    var r = T_zoom([[0, 1, 60, 150, 100, 110], [0, 0, 0, 60, 100, 110], [0, 2, 151, 300, 100, 110]]);
    T_eq(r.finish.applied + '/' + r.finish.skipped + '/' + r.finish.failed, '1/1/1', 'pose / ignore / echec');
    T_eq(r.finish.ok, false, 'echec partiel signale');
    T_eq(r.finish.code, 'PARTIAL', 'code');
    T_eq(T_keys(T_scale(0, 1)), '0.0000=100', 'animation existante intacte');
});

T_scenario('zoom : clip retrouve meme si son indice a change', function () {
    MOCK.install(30, LAYOUT_Z);
    var r = T_zoom([[0, 0, 150, 300, 100, 110]]); // indice 0 mais bornes du 3e clip
    T_check(r.finish && r.finish.ok, 'finish');
    T_eq(T_scale(0, 2)._varying + ',' + T_scale(0, 0)._varying, 'true,false', 'le bon clip est zoome');
});

T_scenario('zoom : Premiere en francais, sans matchName, Time obligatoire', function () {
    MOCK.install(30, LAYOUT_Z);
    MOCK.config.noMatchName = true;
    MOCK.config.motionName = 'Trajectoire';
    MOCK.config.scaleName = 'Échelle';
    MOCK.config.keyNeedsTime = true;
    T_setClip('V', 0, 0, {});
    var r = T_zoom([[0, 0, 0, 60, 100, 108]]);
    T_check(r.finish && r.finish.ok, 'finish : ' + (r.finish && r.finish.notes));
    T_eq(T_keys(T_scale(0, 0)), '0.0000=100 ' + (2 - 1 / 30).toFixed(4) + '=108', 'images cles');
});

T_scenario('zoom : sauvegarde puis zoom sur l originale', function () {
    MOCK.install(30, LAYOUT_Z);
    MOCK.config.cloneSwitches = true;
    var r = T_zoom([[0, 0, 0, 60, 100, 110]], { backup: true, backupName: 'Rush - avant Zoom' });
    T_check(r.finish && r.finish.ok, 'finish : ' + (r.begin.error || ''));
    T_eq(app.project.sequences[1].name, 'Rush - avant Zoom', 'copie nommee');
    T_eq(app.project.sequences[1].videoTracks[0]._items[0].scale._varying, false, 'copie intacte');
    T_eq(app.project.sequences[0].videoTracks[0]._items[0].scale._varying, true, 'originale zoomee');
});

/** Ecrit un plan Zoom avec point vise : [piste, indice, debut, fin, de, a, duree, doux, px, py]. */
function T_zoomPoint(items) {
    var lines = ['sequenceId=seq-1', 'backup=0', 'backupName=x'];
    for (var i = 0; i < items.length; i++) {
        var z = items[i];
        lines.push('Z ' + z[0] + ' ' + z[1] + ' ' + z[2] * F + ' ' + z[3] * F + ' ' + z[4] + ' ' + z[5] + ' ' + z[6] + ' ' + z[7] + ' ' + z[8] + ' ' + z[9]);
    }
    var f = T_fso.CreateTextFile(T_tmp, true, false);
    f.Write(lines.join('\r\n') + '\r\n');
    f.Close();
    var begin = eval('(' + ADZ_begin(T_tmp) + ')');
    if (!begin.ok) return { begin: begin, finish: null };
    var step;
    do {
        step = eval('(' + ADZ_step(5) + ')');
    } while (step.ok && !step.finished);
    return { begin: begin, finish: eval('(' + ADZ_finish() + ')') };
}

function T_pos(p) {
    return '[' + Math.round(p[0] * 10000) / 10000 + ',' + Math.round(p[1] * 10000) / 10000 + ']';
}

function T_posKeys(track, clip) {
    var it = MOCK.seq.videoTracks[track]._items[clip];
    var out = [];
    for (var i = 0; i < it.position._keys.length; i++) out.push(it.position._keys[i].t.toFixed(4) + '=' + T_pos(it.position._keys[i].v));
    return out.join(' ');
}

T_scenario('zoom : zoom vers un point (la camera en haut a gauche reste en place)', function () {
    MOCK.install(30, LAYOUT_Z);
    T_setClip('V', 0, 1, { inP: 10 });
    // 100 -> 120 % vers (0,25 ; 0,25) : la position glisse de 0,5 vers 0,55
    var r = T_zoomPoint([[0, 1, 60, 150, 100, 120, 0, 1, 0.25, 0.25]]);
    T_check(r.finish && r.finish.ok, 'finish : ' + (r.finish && r.finish.notes));
    var k1 = (10 + 3 - 1 / 30).toFixed(4);
    T_eq(T_posKeys(0, 1), '10.0000=[0.5,0.5] ' + k1 + '=[0.55,0.55]', 'images cles de position');
    T_eq(T_keys(T_scale(0, 1)), '10.0000=100 ' + k1 + '=120', 'images cles d echelle');
    T_eq(MOCK.seq.videoTracks[0]._items[1].position._interp[10], ADZ_KF_BEZIER, 'position adoucie aussi');
});

T_scenario('zoom : point avec Position en pixels, zoom fixe, dezoom', function () {
    MOCK.install(30, LAYOUT_Z);
    MOCK.config.positionPixels = true;
    T_setClip('V', 0, 0, {});
    T_setClip('V', 0, 2, {});
    var r = T_zoomPoint([[0, 0, 0, 60, 150, 150, 0, 0, 0.2, 0.5], [0, 2, 150, 300, 120, 100, 0, 1, 0.8, 0.2]]);
    T_check(r.finish && r.finish.ok, 'finish');
    // fixe 150 % vers x = 0,2 (384 px) : 384 + (960 - 384) * 1,5 = 1248
    T_eq(T_pos(MOCK.seq.videoTracks[0]._items[0].position._value), '[1248,540]', 'position fixe en pixels');
    T_eq(MOCK.seq.videoTracks[0]._items[0].position._varying, false, 'pas d image cle');
    // dezoom 120 -> 100 % vers (1536, 216) : depart (1536 + -576*1,2, 216 + 324*1,2) puis retour au centre
    T_eq(T_posKeys(0, 2), '0.0000=[844.8,604.8] ' + (5 - 1 / 30).toFixed(4) + '=[960,540]', 'dezoom vers le point');
});

T_scenario('zoom : position deja animee -> clip laisse tel quel', function () {
    MOCK.install(30, LAYOUT_Z);
    T_setClip('V', 0, 1, { posAnimated: true });
    var r = T_zoomPoint([[0, 1, 60, 150, 100, 120, 0, 1, 0.25, 0.25], [0, 0, 0, 60, 100, 110, 0, 1, -1, -1]]);
    T_eq(r.finish.applied + '/' + r.finish.skipped, '1/1', 'un pose (sans point), un ignore');
    T_eq(MOCK.seq.videoTracks[0]._items[1].scale._varying, false, 'echelle non touchee sur le clip ignore');
});

T_scenario('zoom : liste des clips signale les clips desactives', function () {
    MOCK.install(30, LAYOUT_Z);
    MOCK.seq.videoTracks[0].clips[1].disabled = true;
    var l = eval('(' + ADZ_listClips('0') + ')');
    T_eq(l.tracks[0].clips[0].disabled + ',' + l.tracks[0].clips[1].disabled, 'false,true', 'etat desactive');
});

T_scenario('zoom : plan vide ou autre sequence refuses', function () {
    MOCK.install(30, LAYOUT_Z);
    T_eq(T_zoom([]).begin.code, 'EMPTY_PLAN', 'plan vide');
    T_eq(T_zoom([[0, 0, 0, 60, 100, 110]], { seqId: 'autre' }).begin.code, 'SEQ_CHANGED', 'autre sequence');
    T_eq(T_scale(0, 0)._varying, false, 'rien de pose');
});

// =========================================================== B-ROLL

var T_dir = T_fso.GetSpecialFolder(2).Path + '\\';
var T_vid = T_dir + 'adr broll video.mp4';
var T_img = T_dir + 'adr-broll-photo.jpg';
(function () {
    var f = T_fso.CreateTextFile(T_vid, true, false);
    f.Write('video');
    f.Close();
    f = T_fso.CreateTextFile(T_img, true, false);
    f.Write('image');
    f.Close();
})();

function T_writeBrollPlan(items, opts) {
    opts = opts || {};
    var lines = ['sequenceId=' + (opts.seqId || 'seq-1'), 'backup=' + (opts.backup ? '1' : '0'),
                 'backupName=Rush - avant B-roll', 'fill=' + (opts.fill === false ? '0' : '1')];
    for (var i = 0; i < items.length; i++) {
        var b = items[i];
        lines.push('B ' + b[0] + ' ' + b[1] * F + ' ' + b[2] * F + ' ' + b[3] + ' ' + b[4] + ' ' + b[5] + ' ' + b[6] + ' ' + b[7]);
    }
    var f = T_fso.CreateTextFile(T_tmp, true, false);
    f.Write(lines.join('\r\n') + '\r\n');
    f.Close();
}

function T_broll(items, opts) {
    T_writeBrollPlan(items, opts);
    var begin = eval('(' + ADB_begin(T_tmp) + ')');
    if (!begin.ok) return { begin: begin, finish: null };
    var guard = 0;
    var step;
    do {
        step = eval('(' + ADB_step(5) + ')');
        guard++;
    } while (step.ok && !step.finished && guard < 10000);
    return { begin: begin, finish: eval('(' + ADB_finish() + ')') };
}

function T_installBroll() {
    MOCK.install(30, { V: [[[0, 900]], []], A: [[[0, 900]]] });
    MOCK.media = {};
    MOCK.media[T_vid.toLowerCase()] = { dur: 20 };
    MOCK.media[T_img.toLowerCase()] = { dur: 0, still: true };
}

T_scenario('broll : infos du projet', function () {
    T_installBroll();
    var r = eval('(' + ADB_projectInfo() + ')');
    T_eq(r.projectPath + ' ' + r.frameW + 'x' + r.frameH, 'C:\\Projets\\Rush.prproj 1920x1080', 'chemin et cadre');
});

T_scenario('broll : video sans son, passage choisi, remplit le cadre', function () {
    T_installBroll();
    var r = T_broll([[1, 60, 90, 4.5, 'v', 1280, 720, T_vid]]);
    T_check(r.finish && r.finish.ok, 'finish : ' + (r.begin.error || (r.finish && r.finish.notes)));
    var v2 = MOCK.seq.videoTracks[1]._items;
    T_eq(v2.length, 1, 'un B-roll sur V2');
    T_eq(v2[0].s / F + '-' + v2[0].e / F, '60-150', 'position et duree');
    T_eq(v2[0].srcIn, 4.5, 'passage de la video');
    T_eq(v2[0].audio, false, 'sous-clip sans son');
    T_eq(v2[0].scale._value, 150, 'echelle pour remplir 1920x1080');
    T_eq(MOCK.seq.videoTracks[0].frames(), '0-900', 'V1 intacte');
    var root = app.project.rootItem;
    T_eq(root.children[0].name, 'FirstCut B-roll', 'chutier cree');
    T_eq(root.children[0].children.numItems, 2, 'media + sous-clip dans le chutier');
});

T_scenario('broll : image fixe, duree reglee, mise a l echelle', function () {
    T_installBroll();
    var r = T_broll([[1, 300, 60, 0, 'i', 4000, 3000, T_img]]);
    T_check(r.finish && r.finish.ok, 'finish');
    var it = MOCK.seq.videoTracks[1]._items[0];
    T_eq(it.s / F + '-' + it.e / F, '300-360', 'image de 2 s');
    T_eq(it.scale._value, 48, 'echelle 4000x3000 -> 1920x1080');
});

T_scenario('broll : plusieurs B-rolls, un seul import par fichier, reutilisation ensuite', function () {
    T_installBroll();
    var r = T_broll([[1, 30, 60, 1, 'v', 1920, 1080, T_vid], [1, 200, 60, 8, 'v', 1920, 1080, T_vid], [1, 400, 45, 0, 'i', 1920, 1080, T_img]]);
    T_check(r.finish && r.finish.ok, 'finish');
    T_eq(r.begin.imported, 2, 'deux fichiers importes');
    T_eq(MOCK.calls.importFiles, 1, 'un seul appel d import');
    T_eq(MOCK.seq.videoTracks[1].frames(), '30-90 200-260 400-445', 'V2');
    var r2 = T_broll([[1, 600, 30, 2, 'v', 1920, 1080, T_vid]]);
    T_check(r2.finish && r2.finish.ok, 'deuxieme passage');
    T_eq(r2.begin.imported, 0, 'deja dans le projet : pas de nouvel import');
});

T_scenario('broll : ecrase seulement la zone du B-roll sur la piste choisie', function () {
    MOCK.install(30, { V: [[[0, 900]], [[0, 120], [300, 600]]], A: [[[0, 900]]] });
    MOCK.media = {};
    MOCK.media[T_vid.toLowerCase()] = { dur: 20 };
    var r = T_broll([[1, 90, 60, 0, 'v', 1920, 1080, T_vid]]);
    T_check(r.finish && r.finish.ok, 'finish');
    T_eq(MOCK.seq.videoTracks[1].frames(), '0-90 90-150 300-600', 'V2 : le clip existant est raccourci, pas deplace');
});

T_scenario('broll : Premiere exige ticks et objet Time, chutier non rendu', function () {
    T_installBroll();
    MOCK.config.subclipNeedsTicks = true;
    MOCK.config.overwriteNeedsTime = true;
    MOCK.config.createBinReturnsNothing = true;
    var r = T_broll([[1, 60, 30, 2, 'v', 1920, 1080, T_vid]]);
    T_check(r.finish && r.finish.ok, 'finish : ' + (r.finish && r.finish.notes));
    T_eq(MOCK.seq.videoTracks[1].frames(), '60-90', 'pose');
    T_eq(app.project.rootItem.children[0].name, 'FirstCut B-roll', 'chutier retrouve');
});

T_scenario('broll : erreurs avant toute modification', function () {
    T_installBroll();
    T_eq(T_broll([[1, 60, 30, 0, 'v', 0, 0, T_dir + 'absent.mp4']]).begin.code, 'NO_FILE', 'fichier absent');
    T_eq(T_broll([[5, 60, 30, 0, 'v', 0, 0, T_vid]]).begin.code, 'NO_TRACK', 'piste inexistante');
    MOCK.seq.videoTracks[1]._locked = true;
    T_eq(T_broll([[1, 60, 30, 0, 'v', 0, 0, T_vid]]).begin.code, 'LOCKED', 'piste verrouillee');
    T_eq(T_broll([]).begin.code, 'EMPTY_PLAN', 'plan vide');
    T_eq(MOCK.seq.videoTracks[1].frames(), '', 'rien de pose');
    T_eq(MOCK.calls.importFiles || 0, 0, 'rien d importe');
});

T_scenario('broll : sauvegarde de la sequence avant', function () {
    T_installBroll();
    MOCK.config.cloneSwitches = true;
    var r = T_broll([[1, 60, 30, 0, 'v', 1920, 1080, T_vid]], { backup: true });
    T_check(r.finish && r.finish.ok, 'finish');
    T_eq(app.project.sequences[1].videoTracks[1].frames(), '', 'copie intacte');
    T_eq(app.project.sequences[0].videoTracks[1].frames(), '60-90', 'originale illustree');
});

// ============================================== LIENS IMAGE / SON (silences)

/** Lie le clip n de chaque piste listee : [['V', 0, 0], ['A', 0, 0]] -> meme groupe. */
function T_linkTogether(id, refs) {
    for (var i = 0; i < refs.length; i++) {
        var tr = refs[i][0] === 'V' ? MOCK.seq.videoTracks[refs[i][1]] : MOCK.seq.audioTracks[refs[i][1]];
        tr._items[refs[i][2]]._lk = id;
    }
}

/**
 * Chaque morceau de V1 est-il lie exactement aux morceaux des pistes audio
 * `audioTracks` qui ont les memes bornes, et a rien d'autre ?
 */
function T_pairsExact(audioTracks) {
    var v = MOCK.seq.videoTracks[0]._items;
    var bad = [];
    for (var i = 0; i < v.length; i++) {
        var it = v[i];
        if (!it._lk) {
            bad.push(it.s / F + ' non lie');
            continue;
        }
        var members = 0;
        var groups = [MOCK.seq.videoTracks, MOCK.seq.audioTracks];
        for (var g = 0; g < 2; g++) {
            for (var t = 0; t < groups[g].numTracks; t++) {
                var items = groups[g][t]._items;
                for (var j = 0; j < items.length; j++) if (items[j]._lk === it._lk) members++;
            }
        }
        var want = 1;
        for (var a = 0; a < audioTracks.length; a++) {
            var ai = MOCK.seq.audioTracks[audioTracks[a]]._items;
            var ok = false;
            for (var k = 0; k < ai.length; k++) {
                if (ai[k].s === it.s && ai[k].e === it.e && ai[k]._lk === it._lk) ok = true;
            }
            if (!ok) bad.push(it.s / F + ' sans son A' + (audioTracks[a] + 1));
            want++;
        }
        if (members !== want) bad.push(it.s / F + ' groupe de ' + members + ' au lieu de ' + want);
    }
    return bad.length ? bad.join(', ') : 'ok';
}

T_scenario('liens : Premiere perd le lien en coupant -> chaque morceau est relie', function () {
    MOCK.install(30, { V: [[[0, 1800]]], A: [[[0, 1800]]] });
    MOCK.config.razorLinks = 'break';
    T_linkTogether('rush', [['V', 0, 0], ['A', 0, 0]]);
    var r = T_run({ mode: 'delete', A: SIL });
    T_check(r.finish && r.finish.ok, 'finish : ' + (r.finish && r.finish.error));
    T_eq(MOCK.seq.videoTracks[0].frames(), '0-61 61-182 182-1622', 'coupe inchangee');
    T_eq(T_pairsExact([0]), 'ok', 'liens V1 / A1');
    T_eq(r.finish.relinked + '/' + r.finish.relinkFailed, '3/0', 'liens retablis');
});

T_scenario('liens : tous les morceaux lies ensemble -> regroupes par paire', function () {
    MOCK.install(30, { V: [[[0, 1800]]], A: [[[0, 1800]]] });
    MOCK.config.razorLinks = 'keep';
    T_linkTogether('rush', [['V', 0, 0], ['A', 0, 0]]);
    var r = T_run({ mode: 'delete', A: SIL });
    T_check(r.finish && r.finish.ok, 'finish');
    T_eq(T_pairsExact([0]), 'ok', 'liens par paire');
});

T_scenario('liens : deja corrects -> on n y touche pas', function () {
    MOCK.install(30, { V: [[[0, 1800]]], A: [[[0, 1800]]] });
    MOCK.config.razorLinks = 'pairs';
    T_linkTogether('rush', [['V', 0, 0], ['A', 0, 0]]);
    var r = T_run({ mode: 'delete', A: SIL });
    T_check(r.finish && r.finish.ok, 'finish');
    T_eq(T_pairsExact([0]), 'ok', 'liens');
    T_eq(r.finish.linkOk + '/' + r.finish.relinked, '3/0', 'aucune reliaison necessaire');
    T_eq(MOCK.calls.link || 0, 0, 'aucun appel de liaison');
});

T_scenario('liens : son double mono (A1 + A2) et musique non liee sur A3', function () {
    MOCK.install(30, { V: [[[0, 1800]]], A: [[[0, 1800]], [[0, 1800]], [[0, 1800]]] });
    MOCK.config.razorLinks = 'break';
    T_linkTogether('rush', [['V', 0, 0], ['A', 0, 0], ['A', 1, 0]]);
    MOCK.seq.audioTracks[2]._items[0].node = 'musique';
    MOCK.seq.audioTracks[2]._rebuild();
    var r = T_run({ mode: 'delete', A: SIL });
    T_check(r.finish && r.finish.ok, 'finish');
    T_eq(T_pairsExact([0, 1]), 'ok', 'V1 relie a A1 et A2');
    T_eq(MOCK.links(MOCK.seq.audioTracks[2]).indexOf(':L') < 0, true, 'la musique reste independante');
});

T_scenario('liens : B-roll sur V2 lie a son propre son, rush sur V1', function () {
    MOCK.install(30, { V: [[[0, 1800]], [[500, 560]]], A: [[[0, 1800]], [[500, 560]]] });
    MOCK.config.razorLinks = 'break';
    T_linkTogether('rush', [['V', 0, 0], ['A', 0, 0]]);
    T_linkTogether('broll', [['V', 1, 0], ['A', 1, 0]]);
    MOCK.seq.videoTracks[1]._items[0].node = 'broll';
    MOCK.seq.audioTracks[1]._items[0].node = 'broll';
    MOCK.seq.videoTracks[1]._rebuild();
    MOCK.seq.audioTracks[1]._rebuild();
    var r = T_run({ mode: 'delete', A: SIL });
    T_check(r.finish && r.finish.ok, 'finish : ' + (r.finish && r.finish.mismatchNotes));
    T_eq(T_pairsExact([0]), 'ok', 'rush');
    var v2 = MOCK.seq.videoTracks[1]._items[0];
    var a2 = MOCK.seq.audioTracks[1]._items[0];
    T_check(v2._lk && v2._lk === a2._lk && v2.s === a2.s, 'B-roll V2 / A2 toujours lie');
    T_check(v2._lk !== MOCK.seq.videoTracks[0]._items[0]._lk, 'B-roll pas lie au rush');
});

/** Les memes cas de liaison, sous chaque comportement de selection de Premiere. */
var T_SEL_MODES = [
    ['selection simple', {}],
    ['selection liee', { linkedSelect: true }],
    ['selection vue par l interface', { selectionNeedsUI: true }],
    ['les deux', { linkedSelect: true, selectionNeedsUI: true }]
];
var T_RAZOR_MODES = ['break', 'keep', 'pairs'];

(function () {
    for (var m = 0; m < T_SEL_MODES.length; m++) {
        for (var r = 0; r < T_RAZOR_MODES.length; r++) {
            (function (sel, razor) {
                T_scenario('liens multipistes [' + sel[0] + ', rasoir ' + razor + '] : V1 + A1 + A2', function () {
                    MOCK.install(30, { V: [[[0, 1800]]], A: [[[0, 1800]], [[0, 1800]]] });
                    for (var k in sel[1]) if (sel[1].hasOwnProperty(k)) MOCK.config[k] = sel[1][k];
                    MOCK.config.razorLinks = razor;
                    T_linkTogether('rush', [['V', 0, 0], ['A', 0, 0], ['A', 1, 0]]);
                    var res = T_run({ mode: 'delete', A: SIL });
                    T_check(res.finish && res.finish.ok, 'finish : ' + (res.finish && res.finish.mismatchNotes));
                    T_eq(T_pairsExact([0, 1]), 'ok', 'chaque morceau V1 lie a ses morceaux A1 et A2');
                });
                T_scenario('liens multipistes [' + sel[0] + ', rasoir ' + razor + '] : deux cameras V1/A1 et V2/A2', function () {
                    MOCK.install(30, { V: [[[0, 1800]], [[0, 1800]]], A: [[[0, 1800]], [[0, 1800]]] });
                    for (var k in sel[1]) if (sel[1].hasOwnProperty(k)) MOCK.config[k] = sel[1][k];
                    MOCK.config.razorLinks = razor;
                    T_linkTogether('cam1', [['V', 0, 0], ['A', 0, 0]]);
                    T_linkTogether('cam2', [['V', 1, 0], ['A', 1, 0]]);
                    MOCK.seq.videoTracks[1]._items[0].node = 'cam2';
                    MOCK.seq.audioTracks[1]._items[0].node = 'cam2';
                    MOCK.seq.videoTracks[1]._rebuild();
                    MOCK.seq.audioTracks[1]._rebuild();
                    var res = T_run({ mode: 'delete', A: SIL });
                    T_check(res.finish && res.finish.ok, 'finish : ' + (res.finish && res.finish.mismatchNotes));
                    T_eq(T_pairsExact([0]), 'ok', 'V1 lie a A1 seulement');
                    var v2 = MOCK.seq.videoTracks[1]._items;
                    var a2 = MOCK.seq.audioTracks[1]._items;
                    var bad = 0;
                    for (var i = 0; i < v2.length; i++) {
                        if (!v2[i]._lk || v2[i]._lk !== a2[i]._lk || v2[i].s !== a2[i].s) bad++;
                        for (var j = 0; j < v2.length; j++) if (j !== i && v2[i]._lk && v2[j]._lk === v2[i]._lk) bad++;
                    }
                    T_eq(bad, 0, 'V2 lie a A2, morceau par morceau');
                });
            })(T_SEL_MODES[m], T_RAZOR_MODES[r]);
        }
    }
})();

/**
 * Groupes par position : tous les morceaux de memes bornes sur les pistes listees
 * partagent un seul lien, et deux positions differentes n'ont jamais le meme lien.
 */
function T_groupsByPosition(refs) {
    var bad = [];
    var first = refs[0][0] === 'V' ? MOCK.seq.videoTracks[refs[0][1]] : MOCK.seq.audioTracks[refs[0][1]];
    var seenLk = {};
    for (var i = 0; i < first._items.length; i++) {
        var p = first._items[i];
        var lk = p._lk;
        if (!lk) {
            bad.push(p.s / F + ' non lie');
            continue;
        }
        if (seenLk[lk]) bad.push(p.s / F + ' meme lien que ' + seenLk[lk]);
        seenLk[lk] = p.s / F;
        for (var r = 1; r < refs.length; r++) {
            var tr = refs[r][0] === 'V' ? MOCK.seq.videoTracks[refs[r][1]] : MOCK.seq.audioTracks[refs[r][1]];
            var found = false;
            for (var j = 0; j < tr._items.length; j++) {
                if (tr._items[j].s === p.s && tr._items[j].e === p.e) found = tr._items[j]._lk === lk;
            }
            if (!found) bad.push(p.s / F + ' ' + refs[r][0] + (refs[r][1] + 1) + ' hors du groupe');
        }
    }
    return bad.length ? bad.join(', ') : 'ok';
}

(function () {
    for (var m = 0; m < T_SEL_MODES.length; m++) {
        for (var r = 0; r < T_RAZOR_MODES.length; r++) {
            (function (sel, razor) {
                T_scenario('liens groupe de quatre [' + sel[0] + ', rasoir ' + razor + '] : webcam V2/A2 + capture V1/A1 lies ensemble', function () {
                    MOCK.install(30, { V: [[[0, 1800]], [[0, 1800]]], A: [[[0, 1800]], [[0, 1800]]] });
                    for (var k in sel[1]) if (sel[1].hasOwnProperty(k)) MOCK.config[k] = sel[1][k];
                    MOCK.config.razorLinks = razor;
                    // V1 + A1 : capture de jeu ; V2 + A2 : webcam ; les quatre lies ensemble
                    MOCK.seq.videoTracks[0]._items[0].node = 'capture';
                    MOCK.seq.audioTracks[0]._items[0].node = 'capture';
                    MOCK.seq.videoTracks[1]._items[0].node = 'webcam';
                    MOCK.seq.audioTracks[1]._items[0].node = 'webcam';
                    for (var t = 0; t < 2; t++) {
                        MOCK.seq.videoTracks[t]._rebuild();
                        MOCK.seq.audioTracks[t]._rebuild();
                    }
                    T_linkTogether('tout', [['V', 0, 0], ['V', 1, 0], ['A', 0, 0], ['A', 1, 0]]);
                    var res = T_run({ mode: 'delete', A: SIL });
                    T_check(res.finish && res.finish.ok, 'finish : ' + (res.finish && res.finish.mismatchNotes));
                    T_eq(T_groupsByPosition([['V', 0], ['V', 1], ['A', 0], ['A', 1]]), 'ok', 'les quatre morceaux de chaque position lies ensemble');
                });
            })(T_SEL_MODES[m], T_RAZOR_MODES[r]);
        }
    }
})();

// ============================================================== POV

function T_pov(tracks, shots, opts) {
    opts = opts || {};
    var lines = ['sequenceId=' + (opts.seqId || 'seq-1'), 'timebase=' + MOCK.seq.timebase, 'backup=' + (opts.backup ? '1' : '0'),
                 'backupName=Rush - avant POV'];
    var i;
    for (i = 0; i < tracks.length; i++) lines.push('T ' + tracks[i]);
    for (i = 0; i < shots.length; i++) lines.push('S ' + shots[i][0] + ' ' + shots[i][1] + ' ' + shots[i][2]);
    var f = T_fso.CreateTextFile(T_tmp, true, false);
    f.Write(lines.join('\r\n') + '\r\n');
    f.Close();
    var begin = eval('(' + ADP_begin(T_tmp) + ')');
    if (!begin.ok) return { begin: begin, finish: null };
    var guard = 0;
    var step;
    do {
        step = eval('(' + ADP_step(5) + ')');
        guard++;
    } while (step.ok && !step.finished && guard < 10000);
    return { begin: begin, finish: eval('(' + ADP_finish() + ')') };
}

T_scenario('pov : deux cameras, chacun son tour', function () {
    MOCK.install(30, { V: [[[0, 900]], [[0, 900]]], A: [[[0, 900]], [[0, 900]]] });
    var r = T_pov([0, 1], [[0, 150, 0], [150, 420, 1], [420, 900, 0]]);
    T_check(r.finish && r.finish.ok, 'finish : ' + (r.begin.error || (r.finish && (r.finish.error + ' ' + r.finish.notes))));
    T_eq(MOCK.seq.videoTracks[0].states(), '0-150 150-420:off 420-900', 'V1');
    T_eq(MOCK.seq.videoTracks[1].states(), '0-150:off 150-420 420-900:off', 'V2');
    T_eq(MOCK.seq.audioTracks[0].frames(), '0-900', 'audio jamais touche');
    T_eq(r.finish.razorDone, 4, 'coupes');
});

T_scenario('pov : plan large sur V3, zone partielle, clips deja coupes', function () {
    MOCK.install(30, {
        V: [[[0, 300], [300, 900]], [[0, 900]], [[0, 900]]],
        A: [[[0, 900]], [[0, 900]]]
    });
    // zone 60-600 seulement ; le plan large (V3) quand les deux parlent
    var r = T_pov([0, 1, 2], [[60, 300, 0], [300, 360, 2], [360, 600, 1]]);
    T_check(r.finish && r.finish.ok, 'finish : ' + (r.finish && r.finish.notes));
    T_eq(MOCK.seq.videoTracks[0].states(), '0-60 60-300 300-360:off 360-600:off 600-900', 'V1 : hors zone intacte');
    T_eq(MOCK.seq.videoTracks[1].states(), '0-60 60-300:off 300-360:off 360-600 600-900', 'V2');
    T_eq(MOCK.seq.videoTracks[2].states(), '0-60 60-300:off 300-360 360-600:off 600-900', 'V3 plan large');
});

T_scenario('pov : relance sur un montage deja traite (reactive ce qu il faut)', function () {
    MOCK.install(30, { V: [[[0, 600]], [[0, 600]]], A: [[[0, 600]]] });
    T_pov([0, 1], [[0, 300, 0], [300, 600, 1]]);
    var r = T_pov([0, 1], [[0, 300, 1], [300, 600, 0]]);
    T_check(r.finish && r.finish.ok, 'finish');
    T_eq(MOCK.seq.videoTracks[0].states(), '0-300:off 300-600', 'V1 inversee');
    T_eq(MOCK.seq.videoTracks[1].states(), '0-300 300-600:off', 'V2 inversee');
    T_eq(r.finish.razorDone, 0, 'coupes deja presentes');
});

T_scenario('pov : refus avant toute modification', function () {
    MOCK.install(30, { V: [[[0, 600]], [[0, 600]]], A: [[[0, 600]]] });
    MOCK.seq.videoTracks[1]._locked = true;
    T_eq(T_pov([0, 1], [[0, 300, 0], [300, 600, 1]]).begin.code, 'LOCKED', 'piste verrouillee');
    T_eq(T_pov([0, 4], [[0, 600, 0]]).begin.code, 'NO_TRACK', 'piste absente');
    T_eq(T_pov([0, 1], [[0, 600, 0]], { seqId: 'x' }).begin.code, 'SEQ_CHANGED', 'autre sequence');
    T_eq(MOCK.seq.videoTracks[0].states(), '0-600', 'rien de touche');
});

T_scenario('pov : rasoir sans effet -> arret, aucun clip desactive', function () {
    MOCK.install(30, { V: [[[0, 600]], [[0, 600]]], A: [[[0, 600]]] });
    MOCK.config.razorDead = true;
    var r = T_pov([0, 1], [[0, 200, 0], [200, 400, 1], [400, 600, 0]]);
    T_eq(r.finish.code, 'RAZOR_FAILED', 'arret');
    T_eq(MOCK.seq.videoTracks[0].states() + ' | ' + MOCK.seq.videoTracks[1].states(), '0-600 | 0-600', 'rien desactive');
});

T_scenario('pov : sauvegarde avant', function () {
    MOCK.install(30, { V: [[[0, 600]], [[0, 600]]], A: [[[0, 600]]] });
    MOCK.config.cloneSwitches = true;
    var r = T_pov([0, 1], [[0, 300, 0], [300, 600, 1]], { backup: true });
    T_check(r.finish && r.finish.ok, 'finish');
    T_eq(app.project.sequences[1].videoTracks[1].states(), '0-600', 'copie intacte');
    T_eq(app.project.sequences[0].videoTracks[1].states(), '0-300:off 300-600', 'originale traitee');
});

try {
    T_fso.DeleteFile(T_vid);
    T_fso.DeleteFile(T_img);
} catch (eDel2) {}

try {
    T_fso.DeleteFile(T_tmp);
} catch (eDel) {}

WScript.Echo('');
WScript.Echo(T_pass + ' verifications reussies, ' + T_fail + ' en echec');
WScript.Quit(T_fail ? 1 : 0);
