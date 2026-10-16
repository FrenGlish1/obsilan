# ObsiLan

Application de prise de notes Markdown, compatible Obsidian, pour **Windows (.exe)** et **Android (.apk)**.
Vos notes sont de simples fichiers `.md` rangés dans un dossier de l'appareil (le « coffre ») : aucun format propriétaire, tout marche hors ligne.

**État actuel : Phases 1 et 2 terminées** (notes, dossiers, recherche, liens `[[…]]`, rétroliens, tags). La synchronisation PC ↔ téléphone (via votre serveur Pterodactyl) arrive en Phase 3.

---

## Installer les applications

### Windows
Lancez `livrables/ObsiLan_0.3.0_x64-setup.exe` : l'installation se fait sans droits administrateur.
Au premier lancement, choisissez le dossier des notes : `Documents\ObsiLan`, ou un coffre Obsidian existant.
Pour changer de dossier plus tard, cliquez sur son nom en bas de la barre latérale.

### Android
1. Copiez `livrables/ObsiLan.apk` sur le téléphone et ouvrez-le. Autorisez l'installation d'applications inconnues si Android le demande.
2. Au premier lancement, Android ouvre le réglage **« Accès à tous les fichiers »** : activez-le pour ObsiLan, puis revenez dans l'application.
   Vos notes seront dans `Documents/ObsiLan`, visibles dans l'application « Fichiers ».
3. Si vous refusez, ObsiLan propose son stockage interne, invisible depuis les autres applications.

## Compiler

Prérequis, déjà installés sur votre PC : Node.js 20.19+, Rust (rustup), Visual Studio C++, Android Studio (SDK + NDK), JDK 17+.

```bash
npm install
npm run app:build        # → installeur Windows .exe
npm run android:build    # → APK Android signé (arm64)
```

Autres commandes :

| Commande | Rôle |
|---|---|
| `npm run app:dev` | application Windows en mode développement (rechargement à chaud) |
| `npm run dev` | interface dans un navigateur + serveur Node (développement rapide) |
| `npm test` / `npm run test:rust` | tests TypeScript / tests Rust |
| `npm run check` | vérification des types |

L'APK sort dans `src-tauri/gen/android/app/build/outputs/apk/universal/release/` et l'installeur dans `src-tauri/target/release/bundle/nsis/` ; les dernières versions sont copiées dans `livrables/`.

### ⚠️ Clé de signature Android
L'APK est signé avec `C:\Users\<vous>\.android\obsilan-release.jks`. Le mot de passe est dans `src-tauri/gen/android/keystore.properties`, qui n'est jamais versionné.
**Sauvegardez ces deux fichiers** : sans eux, impossible d'installer une mise à jour par-dessus l'application existante. Il faudrait la désinstaller, ce qui n'efface pas les notes de `Documents/ObsiLan`.

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

## Synchronisation (Phase 3)

Le serveur de `livrables/serveur/` tourne sur Pterodactyl, chez vous. Il gère :
- l'**HTTPS automatique** (Let's Encrypt via DuckDNS) et la mise à jour de l'IP ;
- la **connexion Discord**, réservée aux identifiants listés dans `allowedUserIds` ;
- un **espace séparé par compte Discord** (`data/users/<identifiant>/`) : notes, versions archivées, état de synchro.
  Un utilisateur ne voit jamais les notes d'un autre ;
- l'**archive** de chaque version remplacée ou supprimée (`data/users/<identifiant>/versions/`).

Mise en service :
1. Remplissez `livrables/serveur/obsilan.config.json` (DuckDNS, Discord).
2. Déposez ce fichier et `server.mjs` dans le serveur Pterodactyl (egg Node.js 22, fichier principal `server.mjs`).
3. Démarrez-le. La console affiche le certificat obtenu et l'adresse de redirection Discord à déclarer.

**Inviter quelqu'un** : demandez-lui son identifiant Discord, ajoutez-le à `allowedUserIds` dans `obsilan.config.json`, puis redémarrez le serveur.
Son espace est créé à sa première connexion. Pour retirer un accès, enlevez son identifiant : ses appareils ne pourront plus se connecter.

## Site web (GitHub Pages)

Le dossier `site/` contient le site public : présentation, installation, notes de version, conditions d'utilisation et confidentialité.

1. Remplacez les champs `[NOM ET PRÉNOM DE L'ÉDITEUR]` dans `site/conditions.html` et `site/confidentialite.html`.
2. Mettez à jour `site/config.js` : pseudo GitHub, adresse de contact, version.
3. Poussez le dépôt sur GitHub, puis dans *Settings → Pages*, choisissez la source **GitHub Actions**.
   Le workflow `.github/workflows/site.yml` publie le site à chaque modification de `site/`.
4. Pour chaque version, créez une **Release** GitHub avec deux fichiers nommés exactement
   `ObsiLan_x64-setup.exe` et `ObsiLan.apk`. Les boutons du site pointent toujours vers la dernière version.
