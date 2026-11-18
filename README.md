<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/scissors-dark.png">
    <img src="docs/scissors.png" width="160" alt="Ciseaux en pixel art">
  </picture>
</p>

<h1 align="center">FirstCut</h1>

<p align="center">
  <b>Le dérush automatique pour Premiere Pro.</b><br>
  Silences, caméras, zooms et B-rolls, en un clic.
</p>

<p align="center">Créé par <a href="https://github.com/quentiinct">@quentiinct</a></p>

## Installer (Windows)

1. Télécharge `FirstCut-Setup-<version>.exe` dans les [Releases](https://github.com/quentiinct/firstcut/releases/latest).
2. Double-clique dessus, puis **Installer**.
3. Redémarre Premiere Pro, puis **Fenêtre › Extensions › FirstCut**.

> **« Windows a protégé votre ordinateur » ?** Clique **Informations complémentaires**, puis
> **Exécuter quand même**. Le message vient du fait que l'installateur n'est pas signé.

- Ni droits administrateur, ni compte.
- Une présentation guidée s'ouvre au premier lancement.
- Désinstaller : **Paramètres › Applications › FirstCut**.

## Les outils

| Outil | Ce qu'il fait |
| --- | --- |
| **Montage express** | Silences, POV et Zoom enchaînés en un clic. |
| **Silences** | Coupe les blancs, en gardant le lien image / son. |
| **POV** | Affiche la caméra de la personne qui parle (un micro par personne). |
| **Zoom** | Ajoute des zooms au hasard, vers le centre ou vers un point choisi. |
| **B-roll** | Illustre ce qui est dit, depuis une banque en ligne ou ton dossier. |

Chaque outil travaille sur toute la timeline, entre l'entrée et la sortie, ou sur les
clips sélectionnés. Avant chaque modification, ta séquence est dupliquée.

## Configuration requise

- Windows 10 ou 11, Premiere Pro 2021 (15.0) ou plus récent.
- Pour B-roll, en option : une clé Pexels (vidéos en ligne), une clé Claude (choix par IA)
  et ffmpeg (pour ton dossier de vidéos). La transcription se télécharge au premier usage.
- Tes clés API restent sur ton PC, chiffrées avec ta session Windows.
- Mac : pas d'installateur pour l'instant.

## Développer

```powershell
.\install.ps1 -ActiverModeDebug     # copie extension\ dans Premiere
node --test tests/                   # détection, plans, transcription
cscript //nologo tests\jsx\run.wsf   # logique Premiere sur une timeline simulée
.\installer\build.ps1               # fabrique dist\FirstCut-Setup-<version>.exe
```

Aperçu sans Premiere : ouvre `extension/index.html?demo` dans Chrome.
Réglages, limites et organisation du code : [docs/GUIDE.md](docs/GUIDE.md).

## Licence

[MIT](LICENSE) : libre d'utiliser, modifier et redistribuer FirstCut, en gardant la mention de copyright.
