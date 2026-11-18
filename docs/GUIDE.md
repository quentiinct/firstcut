# FirstCut : guide détaillé

Par [@quentiinct](https://github.com/quentiinct).

Pour installer et démarrer : le [README](../README.md). Ce guide détaille chaque outil, ses réglages, ce qu'il fait exactement dans Premiere et ses limites.

## Installer

- **Pour tout le monde** : `FirstCut-Setup-<version>.exe`, voir le [README](../README.md).
- **En développement** : `.\install.ps1` copie le dossier `extension` vers
  `%APPDATA%\Adobe\CEP\extensions\com.firstcut.ppro` (à relancer après chaque
  modification ; ajouter `-ActiverModeDebug` la première fois). `.\uninstall.ps1` le retire.
- **Fabriquer l'installateur** : `.\installer\build.ps1` produit
  `dist\FirstCut-Setup-<version>.exe` (compilateur C# de Windows, rien à installer).

## Utiliser

Au premier lancement, une présentation en cinq écrans s'ouvre ; le bouton
« ? » en haut du panneau la rouvre.

1. À l'ouverture, l'accueil liste les outils. Cliquer sur **Silences**.
2. **Sections** : choisir ce qui sera dérushé.
   - *Toute la timeline*
   - *Entrée / Sortie* : la zone entre les points d'entrée et de sortie
   - *Clips sélectionnés* : uniquement la durée des clips sélectionnés
     (plusieurs zones séparées possibles)

   Après un changement dans Premiere (sélection, points), recliquer sur le
   bouton du mode pour relire la timeline.
3. Cocher les pistes audio à écouter (la voix) ; la case « Tout » au-dessus les
   coche ou les décoche toutes d'un coup. Puis **Valider les sections**.
   Premiere exporte le son et se fige le temps de l'export.
4. **Réglages** : l'aperçu se met à jour à chaque changement. Vert = gardé,
   rouge = coupé, gris = hors section. « Écouter » joue le résultat en sautant
   les silences.
5. **Couper.** Par défaut la séquence est d'abord dupliquée : la copie reste
   intacte dans le projet.

Si la timeline change après l'analyse, le panneau renvoie à l'étape Sections.

## Réglages

| Réglage | Effet |
| --- | --- |
| Niveau de bruit (dB) | Sous ce niveau, c'est du silence. « auto » le propose d'après le signal. |
| Durée min. d'un silence | Un blanc plus court n'est pas coupé (respirations dans une phrase). |
| Durée min. d'une prise de parole | Un son plus court est ignoré (clic, bruit de bouche). |
| Marge avant / après la parole | Silence laissé autour de chaque prise de parole. |
| Temps min. entre deux coupes | Évite deux coupes trop rapprochées : le plus court des deux silences est conservé. |
| Supprimer | Retire les silences, la timeline se resserre. |
| Supprimer, garder les espaces | Retire les silences, les trous restent. |
| Garder | Pose seulement les points de coupe. |
| Rendre muet | Retire le son des silences sur les pistes analysées, l'image ne bouge pas. |
| Transition J-Cut / L-Cut | Décale la coupe image par rapport à la coupe son (mode Supprimer). |

Valeurs de départ : −29 dB, 0,3 s, 0,2 s, 0,005 s, 0 s. Les réglages et préréglages sont
enregistrés dans `%APPDATA%\FirstCut\settings.json`, les journaux de découpe
dans `%APPDATA%\FirstCut\journaux`.

## Zoom

1. Accueil > **Zoom**.
2. **Sections** : toute la timeline, entrée / sortie, ou clips sélectionnés,
   puis cocher les pistes **vidéo** à zoomer (case « Tout » disponible).
   Avec entrée / sortie ou toute la timeline, un clip compte si son milieu est
   dans la zone.
3. **Zooms** :
   - la liste des zooms : « De » et « À » en %, durée du mouvement (tout le
     clip, ou 0,3 s à 3 s depuis le début du clip), courbe douce ou linéaire.
     De = À donne un recadrage fixe, sans image clé ;
   - le point visé : centre, un coin, gauche / droite, ou n'importe où d'un
     clic sur l'aperçu de la ligne (double-clic : centre). Ce point reste en
     place pendant le zoom : pour grossir une caméra posée en haut à gauche,
     vise-la. La position est animée avec l'échelle ;
   - **100 % = taille actuelle du clip** : un clip déjà réduit à 50 % passe de
     50 à 55 pour un zoom de 100 à 110 ;
   - la fréquence : « un clip zoomé tous les 2 à 3 clips » (1 à 1 = tous) ;
   - l'aperçu colore chaque clip zoomé de la couleur de son zoom. Survoler un
     clip affiche son détail. **Nouveau tirage** refait le hasard ; changer un
     réglage garde le même tirage.
4. **Appliquer**. Par défaut la séquence est dupliquée avant.

Clips laissés de côté, et signalés : échelle déjà animée, plus courts que le
minimum réglé, ou sans effet Trajectoire. Les pistes verrouillées ne sont pas
proposées.

## B-roll

1. Accueil > **B-roll**. **Sections** : zone à illustrer, et pistes **audio**
   où l'on parle.
2. **Transcrire** (bouton du bas) :
   - *Automatique* : whisper.cpp tourne sur l'ordinateur. Au premier usage le
     panneau télécharge whisper.cpp v1.9.2 (8 Mo, GitHub officiel) et le modèle
     choisi (148 Mo « rapide » ou 488 Mo « précis », Hugging Face) dans
     `%APPDATA%\FirstCut\whisper`. L'audio ne quitte pas l'ordinateur.
   - *Fichier SRT* : Premiere sait transcrire gratuitement (panneau Texte ›
     Transcription), puis ⋯ › Exporter vers un fichier SRT.
   La transcription est gardée en cache : revenir sur la même zone ne la refait pas.
3. **Sources** :
   - *Banque en ligne* : avec une clé Pexels (gratuite, pexels.com/api) :
     vidéos et photos Pexels. Sans clé : photos Openverse sous licence Creative
     Commons commerciale ; les crédits sont écrits dans `credits-broll.txt`.
   - *Mon dossier de vidéos* : **Analyser** lit chaque vidéo avec ffmpeg et en
     extrait quelques images (cache dans `%APPDATA%\FirstCut\bibliotheques`,
     le dossier n'est jamais modifié). ffmpeg doit être installé.
4. **Choix** :
   - *Mots-clés* (gratuit, hors ligne) : repère les noms concrets de chaque
     phrase et cherche avec. Pour le dossier, s'appuie sur les noms de fichiers
     et de sous-dossiers.
   - *IA Claude* (clé API Anthropic, facturée sur ton compte) : Claude lit la
     transcription, choisit les moments qui s'illustrent et rédige des
     recherches précises ; avec l'IA, **Analyser** fait aussi décrire tes vidéos
     image par image, et Claude choisit le passage exact à montrer. Modèle par
     défaut : Claude Opus 5.5 (Sonnet 5.5 et Haiku 5.5 au choix, moins chers).
     Si le modèle décline une demande, l'API la rejoue sur un autre modèle
     (repli côté serveur).
   - Rythme (un B-roll toutes les X à Y s) et durée d'un B-roll.
5. **Proposer des B-rolls**, puis pour chaque carte : ↻ autre proposition,
   ✕ retirer, ⌖ aller à ce moment dans Premiere.
6. **Placer** : les médias en ligne sont téléchargés dans
   `<dossier du projet>\FirstCut B-roll\`, importés dans le chutier
   « FirstCut B-roll », posés **sans leur son** sur la piste choisie
   (automatique : la première piste libre au-dessus de V1) et agrandis pour
   remplir le cadre. Sauvegarde de la séquence avant, par défaut.

Les clés API restent sur cet ordinateur, dans `%APPDATA%\FirstCut\settings.json`.
Sous Windows, elles y sont chiffrées avec ta session (DPAPI) : copié sur un autre
PC ou ouvert depuis une autre session, le fichier ne permet pas de les relire. Ça
ne protège pas d'un programme qui tourne déjà sous ta session : pour la clé Claude,
fixe une limite de dépense dans la console Anthropic. Sur Mac, elles restent en clair.

## Montage express

Silences, POV et Zoom enchaînés en un clic (accueil > Montage express).

1. **Sections** : la zone et les micros (deux ou plus pour POV).
2. **Recette** : chaque étape s'active ou se coupe ; ses réglages essentiels
   sont modifiables sur place et ce sont les mêmes que dans l'outil séparé
   (la liste des zooms se règle dans Zoom). Par défaut, Zoom zoome les
   caméras d'POV, et ne compte que les clips visibles.
3. **Lancer** : une seule sauvegarde au début, puis coupe des silences, choix
   des caméras et zooms. Entre deux étapes, la séquence est relue et la zone
   recalculée (la coupe la raccourcit). Si une étape échoue, la recette
   s'arrête et dit ce qui a déjà été fait.

## POV

Pour une interview ou un podcast filmé à plusieurs caméras, avec un micro par personne.

1. Accueil > **POV**. **Sections** : la zone, et le micro (piste audio) de
   chaque intervenant, au moins deux. Toutes les pistes avec du son sont
   cochées par défaut.
2. **Valider** : chaque micro est exporté seul et mesuré (un export par micro).
3. **POV** :
   - relier chaque micro à sa caméra (A1 → V1, A2 → V2 par défaut) et choisir
     éventuellement un plan large ;
   - seuil de parole par micro : automatique (valeur affichée), ou à la main ;
   - écart pour changer de plan (6 dB) : la voix d'une personne reprise par le
     micro de l'autre ne fait pas changer de caméra ;
   - durée minimale d'un plan (2 s), anticipation des coupes ;
   - plan large quand plusieurs personnes parlent, et/ou pendant les silences.
   L'aperçu se recalcule à chaque réglage, sans nouvel export.
4. **Appliquer** : les pistes caméra sont coupées à chaque changement de plan,
   puis les clips de la caméra qui parle sont activés et les autres
   **désactivés** (rien n'est supprimé ni déplacé : Clip › Activer les remet).
   L'audio n'est jamais touché. Sauvegarde de la séquence avant, par défaut.
   Relancer POV sur une séquence déjà traitée réactive ce qu'il faut.

## Ce que fait la découpe

- Toutes les pistes déverrouillées sont coupées aux mêmes instants, calés sur
  les images de la séquence. Les pistes verrouillées sont laissées telles
  quelles (le panneau prévient avant de continuer).
- Rien n'est supprimé tant que tous les points de coupe ne sont pas posés et
  vérifiés.
- Une piste qui a des trous (B-roll, titres) est resynchronisée en déplaçant ses
  clips, pour qu'elle recule autant que les autres.
- À la fin, la timeline obtenue est comparée au plan ; tout écart est signalé.
- Le point de sortie est recalé sur la fin de la zone raccourcie.
- Les liens image / son sont conservés : avant de couper, FirstCut note quel
  clip vidéo est lié à quel(s) clip(s) audio ; après, chaque morceau vidéo est
  re-lié aux morceaux audio de mêmes bornes et de même synchro d'origine (un
  morceau déjà bien lié n'est pas touché). Avec un J-Cut / L-Cut, image et son
  ne se coupent pas au même endroit : ces morceaux ne sont pas re-liés.

Une découpe représente beaucoup d'actions pour Premiere : l'annulation
(Ctrl+Z) se fait action par action. Pour revenir en arrière d'un coup, repartir
de la copie de sauvegarde.

## Limites connues

- Silences détecte au niveau sonore, pas par reconnaissance de la parole.
- La transition « Constant Power » et l'option « les deux » (J et L à la fois)
  ne sont pas proposées.
- Une séquence dont le timecode de départ n'est pas 00:00:00:00 est prise en
  charge par le rasoir, mais les points d'entrée / sortie y sont moins éprouvés.
- Zoom : sur un clip avec remappage temporel, les images clés peuvent tomber à côté.
- B-roll : la transcription automatique est réservée à Windows (sur Mac,
  utiliser un SRT). Le lancement de whisper.cpp n'a pas pu être essayé pendant
  le développement : en cas d'échec, le message de whisper s'affiche, et le SRT
  de Premiere reste une alternative. Sans IA, le choix dans ton dossier dépend
  des noms de fichiers : `IMG_1234.MOV` ne dit rien sur son contenu.

## Tests

```powershell
node --test tests/                      # détection et lecture du WAV
cscript //nologo tests\jsx\run.wsf      # logique de découpe sur une timeline simulée
```

`extension/index.html?demo` ouvert dans un navigateur affiche le panneau avec
un signal fabriqué, sans Premiere (`?demo&tool` : écran Sections,
`?demo&auto` : écran Réglages).

Ces tests couvrent le calcul et la logique. Les appels à Premiere eux-mêmes
(rasoir, suppression, export audio) ne peuvent être exercés que dans Premiere :
faire le premier essai sur une séquence sans enjeu.

## Publier une version signée

À chaque envoi, GitHub Actions ([build.yml](../.github/workflows/build.yml)) lance
les tests et compile l'installateur sur une machine GitHub. Sur un tag `v*`, il
l'envoie aussi à SignPath pour signature.

1. Monter la version dans `extension/CSXS/manifest.xml` (deux fois) et dans
   `extension/jsx/firstcut.jsx` (`ADR_VERSION`), puis commit.
2. `git tag v1.0.1` puis `git push origin v1.0.1` (le tag doit être la version du manifeste).
3. Valider la demande de signature dans SignPath (elle attend une heure au plus).
4. L'installateur signé est joint à la release du tag. Si elle n'existe pas encore,
   un brouillon est créé : ajouter les notes et le lien « Code signing policy »,
   puis publier.

Configuration, une seule fois, une fois le projet accepté par SignPath :

- Projet SignPath : système de compilation de confiance « GitHub.com »,
  configuration d'artefact copiée depuis
  [.signpath/artifact-configuration.xml](../.signpath/artifact-configuration.xml),
  politique de signature de publication avec validation manuelle.
- Dépôt GitHub › Settings › Secrets and variables › Actions :
  secret `SIGNPATH_API_TOKEN` ; variables `SIGNPATH_ORGANIZATION_ID`,
  `SIGNPATH_PROJECT_SLUG` et `SIGNPATH_SIGNING_POLICY_SLUG`.

Tant que ces variables manquent, la compilation se fait quand même, sans signature.

## Animations

Toutes les durées et courbes sont réglées en tête de la partie « MOUVEMENT »
de `extension/css/style.css` (`--fast`, `--med`, `--slow`). Si Windows est
réglé pour réduire les animations, le panneau les coupe aussi.

## Ajouter un outil à l'accueil

Dans `extension/index.html`, les cartes « Bientôt » sont les blocs
`soon-card` (accueil) et `side-item soon` (colonne de gauche). Pour activer
un outil : remplacer une carte par un bouton `tool-card` avec un attribut
`data-open`, et brancher son écran dans `js/app.js` (voir `openTool`).

## Organisation

```
extension/
  CSXS/manifest.xml     déclaration du panneau
  index.html, css/      interface
  js/cep.js             pont vers Premiere
  js/wav.js             lecture du WAV exporté
  js/detect.js          détection des silences
  js/app.js             déroulement (analyse, aperçu, découpe)
  js/zoomplan.js        Zoom : tirage des clips et des zooms (calcul pur)
  js/zoom.js            Zoom : écran de réglages et application
  js/brolltext.js       B-roll : transcription (SRT, whisper), mots-clés, moments
  js/brollsrc.js        B-roll : banques en ligne (Pexels, Openverse), téléchargements
  js/brolllib.js        B-roll : analyse du dossier de vidéos (ffmpeg, cache)
  js/brollai.js         B-roll : choix par Claude (SDK officiel Anthropic)
  js/whisper.js         B-roll : installation et lancement de whisper.cpp
  js/broll.js           B-roll : écran de réglages et pose
  js/express.js         Montage express : enchaînement Silences, POV, Zoom
  js/onboarding.js      présentation au premier lancement
  js/secrets.js         clés API chiffrées avec la session Windows (DPAPI)
  js/povplan.js         POV : qui parle, quelle caméra (calcul pur)
  js/pov.js             POV : écran de réglages et application
  node_modules/         SDK Anthropic (@anthropic-ai/sdk 1.9.0), chargé par le panneau
  js/demo.js            mode démonstration hors Premiere
  jsx/firstcut.jsx      actions dans Premiere (ExtendScript)
tests/                  tests automatiques
installer/              installateur .exe (FirstCutSetup.cs, Logo.cs, build.ps1)
docs/GUIDE.md           ce guide
install.ps1             installation / mise à jour (développement)
uninstall.ps1           désinstallation
```
