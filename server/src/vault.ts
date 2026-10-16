// Accès au coffre : toutes les opérations sur les fichiers .md passent ici.
//
// Règles de sécurité des données :
//   - toute écriture est atomique (voir atomic.ts) ;
//   - aucune opération n'écrase un fichier existant par erreur
//     (création et renommage échouent si la cible existe) ;
//   - la suppression déplace dans « .trash/ » (même convention qu'Obsidian),
//     rien n'est effacé définitivement ;
//   - les modifications sont sérialisées par un verrou global pour éviter
//     que deux requêtes simultanées ne se marchent dessus.
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { NoteData, SaveResult, TreeEntry, VaultEvent } from '../../shared/types.ts';
import { basename, isNote, joinPath, noteTitle } from '../../shared/paths.ts';
import { isTempFile, renameWithRetry, writeFileAtomic } from './atomic.ts';
import { NoteIndex } from '../../shared/search.ts';

export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string, public extra?: object) {
    super(message);
  }
}

export function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 20);
}


export class Vault {
  readonly index = new NoteIndex();
  private listeners = new Set<(e: VaultEvent) => void>();
  /** File d'attente des opérations d'écriture (verrou global). */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(readonly root: string) {}

  // ---------------------------------------------------------------- outils

  /** Chemin absolu sur le disque ; vérifie qu'on reste bien dans le coffre. */
  abs(rel: string): string {
    const full = path.resolve(this.root, ...rel.split('/'));
    if (full !== this.root && !full.startsWith(this.root + path.sep)) {
      throw new HttpError(400, 'bad_path', 'Chemin hors du coffre.');
    }
    return full;
  }

  /** Exécute une modification après toutes celles déjà en cours. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  on(listener: (e: VaultEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(e: VaultEvent): void {
    for (const l of this.listeners) l(e);
  }

  private async exists(rel: string): Promise<boolean> {
    try {
      await stat(this.abs(rel));
      return true;
    } catch {
      return false;
    }
  }

  // ------------------------------------------------------------- démarrage

  /** Crée le coffre si besoin, nettoie les temporaires orphelins, indexe tout. */
  async init(opts: { welcome?: boolean } = {}): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const entries = await this.walk('');
    // Note de bienvenue dans un coffre vide (pas pour les espaces de synchro :
    // l'application crée déjà la sienne, cela éviterait un faux conflit).
    if (entries.length === 0 && opts.welcome !== false) {
      await this.createNote('Bienvenue.md', WELCOME);
      return;
    }
    // Lecture en parallèle par paquets pour rester rapide avec des milliers de notes.
    const files = entries.filter((e) => e.type === 'file').map((e) => e.path);
    const BATCH = 64;
    for (let i = 0; i < files.length; i += BATCH) {
      await Promise.all(files.slice(i, i + BATCH).map((p) => this.reindex(p)));
    }
  }

  /** (Re)lit une note depuis le disque et met l'index à jour. */
  async reindex(rel: string): Promise<boolean> {
    try {
      const content = await readFile(this.abs(rel), 'utf8');
      const hash = hashContent(content);
      const changed = this.index.upsert(rel, content, hash);
      if (changed) this.emit({ type: 'note', path: rel, hash });
      return changed;
    } catch {
      return false;
    }
  }

  // --------------------------------------------------------------- lecture

  /** Parcourt récursivement le coffre (dossiers + notes .md, hors éléments cachés). */
  async walk(dirRel: string): Promise<TreeEntry[]> {
    const out: TreeEntry[] = [];
    let items;
    try {
      items = await readdir(this.abs(dirRel || '.'), { withFileTypes: true });
    } catch {
      return out;
    }
    for (const item of items) {
      const rel = joinPath(dirRel, item.name);
      if (item.name.startsWith('.')) {
        // Temporaire orphelin d'une écriture interrompue (coupure, crash) : on le retire.
        if (item.isFile() && isTempFile(item.name)) await rm(this.abs(rel), { force: true });
        continue;
      }
      if (item.isDirectory()) {
        out.push({ path: rel, type: 'folder' });
        out.push(...(await this.walk(rel)));
      } else if (item.isFile() && isNote(item.name)) {
        try {
          const s = await stat(this.abs(rel));
          out.push({ path: rel, type: 'file', mtime: s.mtimeMs, size: s.size });
        } catch {
          // Fichier disparu entre-temps : on l'ignore.
        }
      }
    }
    return out;
  }

  async readNote(rel: string): Promise<NoteData> {
    if (!isNote(rel)) throw new HttpError(400, 'not_a_note', 'Seuls les fichiers .md sont gérés.');
    try {
      const file = this.abs(rel);
      const [content, s] = await Promise.all([readFile(file, 'utf8'), stat(file)]);
      return { path: rel, content, mtime: s.mtimeMs, hash: hashContent(content) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new HttpError(404, 'not_found', `Note introuvable : ${rel}`);
      }
      throw err;
    }
  }

  // ------------------------------------------------------------- écriture

  /**
   * Enregistre une note.
   * Si `baseHash` est fourni et que la note a changé sur le disque depuis
   * (autre appareil, Obsidian…), on refuse avec une erreur 409 contenant la
   * version actuelle : le client décide alors quoi faire, rien n'est écrasé.
   */
  saveNote(rel: string, content: string, baseHash?: string): Promise<SaveResult> {
    if (!isNote(rel)) throw new HttpError(400, 'not_a_note', 'Seuls les fichiers .md sont gérés.');
    return this.exclusive(async () => {
      if (baseHash) {
        let current: NoteData | null = null;
        try {
          current = await this.readNote(rel);
        } catch {
          // Note supprimée ailleurs : on la recrée avec notre contenu (aucune perte).
        }
        if (current && current.hash !== baseHash && current.hash !== hashContent(content)) {
          throw new HttpError(409, 'conflict', 'La note a été modifiée ailleurs.', { current });
        }
      }
      return this.writeNote(rel, content);
    });
  }

  private async writeNote(rel: string, content: string): Promise<SaveResult> {
    const file = this.abs(rel);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFileAtomic(file, content);
    const s = await stat(file);
    const hash = hashContent(content);
    const isNew = this.index.hashOf(rel) === undefined;
    this.index.upsert(rel, content, hash);
    if (isNew) this.emit({ type: 'tree' });
    this.emit({ type: 'note', path: rel, hash });
    return { path: rel, mtime: s.mtimeMs, hash };
  }

  /** Crée une nouvelle note ; échoue si elle existe déjà. */
  createNote(rel: string, content = ''): Promise<SaveResult> {
    if (!isNote(rel)) throw new HttpError(400, 'not_a_note', 'Le nom doit se terminer par .md');
    return this.exclusive(async () => {
      if (await this.exists(rel)) throw new HttpError(409, 'exists', `« ${noteTitle(rel)} » existe déjà.`);
      return this.writeNote(rel, content);
    });
  }

  createFolder(rel: string): Promise<void> {
    return this.exclusive(async () => {
      if (await this.exists(rel)) throw new HttpError(409, 'exists', `« ${basename(rel)} » existe déjà.`);
      await mkdir(this.abs(rel), { recursive: true });
      this.emit({ type: 'tree' });
    });
  }

  /** Renomme ou déplace une note ou un dossier, sans jamais écraser la cible. */
  rename(from: string, to: string): Promise<void> {
    return this.exclusive(async () => {
      const src = this.abs(from);
      let s;
      try {
        s = await stat(src);
      } catch {
        throw new HttpError(404, 'not_found', `Introuvable : ${from}`);
      }
      if (s.isFile() && !isNote(to)) throw new HttpError(400, 'not_a_note', 'Une note doit garder l’extension .md');
      if (s.isDirectory() && (to + '/').startsWith(from + '/')) {
        throw new HttpError(400, 'bad_move', 'Impossible de déplacer un dossier dans lui-même.');
      }
      // La cible ne doit pas exister… sauf s'il s'agit du même fichier, ce qui
      // arrive quand on change seulement la casse (« note » → « Note ») sur un
      // système de fichiers insensible à la casse (Windows).
      const target = await stat(this.abs(to)).catch(() => null);
      if (target && !(target.ino === s.ino && target.dev === s.dev)) {
        throw new HttpError(409, 'exists', `« ${basename(to)} » existe déjà à cet endroit.`);
      }
      await mkdir(path.dirname(this.abs(to)), { recursive: true });
      await renameWithRetry(src, this.abs(to));

      // Un renommage = disparition de l'ancien chemin + apparition du nouveau.
      this.emit({ type: 'removed', path: from });
      if (s.isFile()) {
        this.index.move(from, to);
        const hash = this.index.hashOf(to);
        if (hash) this.emit({ type: 'note', path: to, hash });
      } else {
        // Dossier : on déplace dans l'index toutes les notes qu'il contenait.
        const moved = this.index.removeFolder(from);
        await Promise.all(moved.map((p) => this.reindex(to + p.slice(from.length))));
      }
      this.emit({ type: 'tree' });
    });
  }

  /** Met une note ou un dossier à la corbeille (.trash/), sans rien effacer. */
  trash(rel: string): Promise<string> {
    return this.exclusive(async () => {
      const src = this.abs(rel);
      let s;
      try {
        s = await stat(src);
      } catch {
        throw new HttpError(404, 'not_found', `Introuvable : ${rel}`);
      }
      // Si un élément du même nom est déjà à la corbeille, on ajoute un horodatage.
      let target = joinPath('.trash', rel);
      if (await this.exists(target)) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const ext = s.isFile() ? '.md' : '';
        const base = ext ? target.slice(0, -3) : target;
        target = `${base} (${stamp})${ext}`;
      }
      await mkdir(path.dirname(this.abs(target)), { recursive: true });
      await renameWithRetry(src, this.abs(target));
      if (s.isFile()) this.index.remove(rel);
      else this.index.removeFolder(rel);
      this.emit({ type: 'removed', path: rel });
      this.emit({ type: 'tree' });
      return target;
    });
  }

  /** Propose un nom libre : « Sans titre.md », « Sans titre 1.md »… */
  async freeName(folder: string, base: string, ext = '.md'): Promise<string> {
    for (let i = 0; i < 10000; i++) {
      const candidate = joinPath(folder, `${base}${i === 0 ? '' : ' ' + i}${ext}`);
      if (!(await this.exists(candidate))) return candidate;
    }
    throw new HttpError(500, 'no_name', 'Impossible de trouver un nom libre.');
  }
}

const WELCOME = `# Bienvenue dans ObsiLan

Vos notes sont de simples fichiers **Markdown** dans un dossier : vous pouvez
les ouvrir avec n'importe quel éditeur, ou avec Obsidian.

## Pour commencer

- Créez une note avec le bouton **+** de la barre latérale
- Faites un clic droit sur une note ou un dossier pour le renommer ou le supprimer
- Glissez-déposez une note sur un dossier pour l'y déplacer
- Cherchez dans toutes vos notes avec **Ctrl+Maj+F**
- Basculez entre édition et lecture avec **Ctrl+E**

> Les notes supprimées vont dans le dossier caché \`.trash\` du coffre :
> rien n'est jamais effacé définitivement.
`;
