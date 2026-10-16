# ObsiLan

Application de prise de notes Markdown, compatible Obsidian, pour **Windows (.exe)** et **Android (.apk)**.
Vos notes sont de simples fichiers `.md` rangés dans un dossier de l'appareil (le « coffre ») : aucun format propriétaire, tout marche hors ligne.

**État actuel : Phases 1 et 2 terminées** (notes, dossiers, recherche, liens `[[…]]`, rétroliens, tags). La synchronisation PC ↔ téléphone (via votre serveur Pterodactyl) arrive en Phase 3.

---

## Installer les applications

### Windows
Lancez `releases/ObsiLan_x64-setup.exe` : l'installation se fait sans droits administrateur.
Au premier lancement, choisissez le dossier des notes : `Documents\ObsiLan`, ou un coffre Obsidian existant.
Pour changer de dossier plus tard, cliquez sur son nom en bas de la barre latérale.

### Android
1. Copiez `releases/ObsiLan.apk` sur le téléphone et ouvrez-le. Autorisez l'installation d'applications inconnues si Android le demande.
2. Au premier lancement, Android ouvre le réglage **« Accès à tous les fichiers »** : activez-le pour ObsiLan, puis revenez dans l'application.
   Vos notes seront dans `Documents/ObsiLan`, visibles dans l'application « Fichiers ».
3. Si vous refusez, ObsiLan propose son stockage interne, invisible depuis les autres applications.

## Liens et tags

Même syntaxe qu'Obsidian : un coffre peut être ouvert indifféremment avec les deux applications.

| Syntaxe | Effet |
|---|---|
| `[[Note]]` | lien vers une note (n'importe où dans le coffre) |
| `[[Dossier/Note]]` | lien avec chemin, utile quand deux notes portent le même nom |
| `[[Note\|texte]]` | lien affiché « texte » |
| `[[Note#Titre]]` | lien vers un titre de la note (la note s'ouvre en haut pour l'instant) |
| `#projet`, `#projet/web` | tags, imbriqués avec `/` |
| `tags: [a, b]` dans l'en-tête `---` | tags dans l'en-tête YAML |

- **Auto-complétion** : tapez `[[` pour choisir une note, `#` pour choisir un tag existant.
- **Clic** sur un lien : ouvre la note. Si elle n'existe pas encore (lien en pointillés), elle est créée à côté de la note courante.
  Sur la ligne en cours d'édition, utilisez **Ctrl+clic**.
- **Rétroliens** : le panneau sous la note liste les notes qui pointent vers elle, avec la ligne concernée.
- **Renommer ou déplacer** une note ou un dossier met à jour automatiquement tous les liens qui y mènent.
  Le nom court est utilisé quand il reste unique, sinon le chemin.
- **Onglet Tags** : tous les tags avec leur nombre de notes ; un tag parent inclut ses sous-tags.
- Les liens et tags écrits dans du code (`` `…` `` ou blocs ```) sont ignorés.

## Garanties sur les données

- **Écriture atomique** : écriture dans un fichier temporaire, `fsync`, puis renommage. Une coupure laisse l'ancienne version ou la nouvelle, jamais un fichier tronqué.
- **Rien n'est écrasé** : la création et le renommage échouent si la cible existe déjà.
- **Corbeille** : supprimer déplace l'élément dans `.trash/` (convention Obsidian).
- **Conflits** : si une note a changé ailleurs (Obsidian, gestionnaire de fichiers…), votre version est gardée dans `Titre (conflit AAAA-MM-JJ HHhMM).md`.
- **Brouillon** : la saisie non encore enregistrée est gardée et restaurée en cas de fermeture brutale.
- **Modifications externes** : le dossier est surveillé, et l'interface et la recherche se mettent à jour seules.

## Importer un coffre Obsidian

Sur PC, choisissez simplement le dossier du coffre au premier lancement (ou via le nom du dossier en bas de la barre latérale). Sur Android, copiez vos fichiers dans `Documents/ObsiLan`.
Les dossiers cachés (`.obsidian`, `.trash`) sont conservés mais ne s'affichent pas.

## Raccourcis

| Raccourci | Action |
|---|---|
| `Ctrl+S` | enregistrer immédiatement |
| `Ctrl+E` | basculer édition / lecture |
| `Ctrl+Maj+F` | rechercher dans toutes les notes |
| `Alt+N` | nouvelle note |
| `Ctrl+F` | chercher dans la note |
