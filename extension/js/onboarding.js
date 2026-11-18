/* FirstCut - presentation au premier lancement.
 *
 * Cinq ecrans : bienvenue, comment ca marche, les outils, verification du
 * poste (en direct), et par ou commencer. S'affiche une fois, puis se rouvre
 * avec le bouton « ? » de l'en-tete.
 */
(function (global) {
  'use strict';

  var ctx = null;
  var slide = 0;
  var COUNT = 5;
  var checked = false;

  function $(id) {
    return document.getElementById(id);
  }

  function go(n) {
    slide = Math.max(0, Math.min(COUNT - 1, n));
    var track = $('ob-track');
    track.style.transform = 'translateX(' + -slide * 100 + '%)';
    var slides = document.querySelectorAll('.ob-slide');
    for (var i = 0; i < slides.length; i++) {
      slides[i].classList.toggle('active', i === slide);
      slides[i].setAttribute('aria-hidden', i === slide ? 'false' : 'true');
    }
    var dots = document.querySelectorAll('#ob-dots button');
    for (var j = 0; j < dots.length; j++) dots[j].classList.toggle('on', j === slide);
    $('ob-prev').style.visibility = slide === 0 ? 'hidden' : 'visible';
    $('ob-next').textContent = slide === COUNT - 1 ? 'C\'est parti' : slide === 0 ? 'Découvrir' : 'Suivant';
    $('ob-skip').style.visibility = slide === COUNT - 1 ? 'hidden' : 'visible';
    if (slide === 3) runChecks();
  }

  function open() {
    var el = $('onboarding');
    el.classList.remove('hidden', 'closing');
    document.body.classList.add('ob-open');
    go(0);
    setTimeout(function () {
      $('ob-next').focus();
    }, 50);
  }

  function close() {
    var el = $('onboarding');
    el.classList.add('closing');
    document.body.classList.remove('ob-open');
    setTimeout(function () {
      el.classList.add('hidden');
      el.classList.remove('closing');
    }, 220);
    if (!ctx.store.onboarded) {
      ctx.store.onboarded = true;
      ctx.saveSettings();
    }
  }

  // -------------------------------------------------------------- verification

  function setCheck(id, state, text) {
    var row = $(id);
    if (!row) return;
    row.className = 'ob-check ' + state;
    row.querySelector('.ob-check-text').textContent = text;
  }

  /** Verifie le poste : Premiere, ffmpeg, transcription, cles facultatives. */
  function runChecks() {
    if (checked) return;
    checked = true;
    var info = ctx.appInfo || {};
    if (ctx.DEMO) {
      setCheck('ob-c-premiere', 'ok', 'Mode démonstration (hors Premiere)');
    } else if (info.appVersion) {
      setCheck('ob-c-premiere', 'ok', 'Premiere Pro ' + info.appVersion + ' connecté');
    } else {
      setCheck('ob-c-premiere', 'bad', 'Premiere ne répond pas : rouvre le panneau depuis Fenêtre › Extensions');
    }

    var b = ctx.store.broll || {};
    setCheck('ob-c-pexels', b.pexelsKey ? 'ok' : 'opt', b.pexelsKey ? 'Clé Pexels ajoutée : vidéos et photos en ligne' : 'Facultatif : sans clé, B-roll utilise des photos libres');
    setCheck('ob-c-claude', b.claudeKey ? 'ok' : 'opt', b.claudeKey ? 'Clé Claude ajoutée : choix des B-rolls par IA' : 'Facultatif : choix des B-rolls par IA');

    if (ctx.DEMO) {
      setCheck('ob-c-ffmpeg', 'opt', 'Vérifié dans Premiere seulement');
      setCheck('ob-c-whisper', 'opt', 'Vérifié dans Premiere seulement');
      return;
    }
    // ces verifications lancent des programmes : on laisse d'abord l'ecran s'afficher
    setTimeout(function () {
      var ff = null;
      try {
        ff = global.ADBrollLib.findFfmpeg(ctx.store.ffmpegPath);
      } catch (e) {}
      setCheck('ob-c-ffmpeg', ff ? 'ok' : 'opt', ff ? 'ffmpeg trouvé : B-roll peut lire ton dossier de vidéos' : 'Facultatif : pour B-roll depuis ton dossier (winget install ffmpeg)');
      var W = global.ADWhisper;
      var installed = false;
      try {
        installed = W.isInstalled(ctx.dataDir(), 'base') || W.isInstalled(ctx.dataDir(), 'small');
      } catch (e2) {}
      setCheck('ob-c-whisper', installed ? 'ok' : 'opt', installed
        ? 'Transcription prête, hors ligne'
        : W.supported() ? 'Se télécharge au premier usage de B-roll (8 Mo + 148 Mo)' : 'Sur Mac : utilise un fichier SRT de Premiere');
    }, 250);
  }

  function bind() {
    $('ob-next').addEventListener('click', function () {
      if (slide === COUNT - 1) {
        close();
        if ($('ob-start-express').checked) ctx.openTool('express');
      } else go(slide + 1);
    });
    $('ob-prev').addEventListener('click', function () {
      go(slide - 1);
    });
    $('ob-skip').addEventListener('click', close);
    var dots = document.querySelectorAll('#ob-dots button');
    for (var i = 0; i < dots.length; i++) {
      (function (k) {
        dots[k].addEventListener('click', function () {
          go(k);
        });
      })(i);
    }
    var tools = document.querySelectorAll('.ob-tool[data-open-tool]');
    for (var j = 0; j < tools.length; j++) {
      tools[j].addEventListener('click', function (ev) {
        var t = ev.currentTarget.getAttribute('data-open-tool');
        close();
        ctx.openTool(t);
      });
    }
    $('btn-help').addEventListener('click', function () {
      checked = false;
      open();
    });
    document.addEventListener('keydown', function (ev) {
      if ($('onboarding').classList.contains('hidden')) return;
      if (ev.key === 'ArrowRight') go(slide + 1);
      else if (ev.key === 'ArrowLeft') go(slide - 1);
      else if (ev.key === 'Escape') close();
    });
  }

  function init(c) {
    ctx = c;
    bind();
  }

  global.ADOnboarding = {
    init: init,
    open: open,
    go: go,
    close: close,
    shouldOpen: function () {
      return !ctx.store.onboarded;
    }
  };
})(window);
