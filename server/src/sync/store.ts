// Stockage de référence de la synchronisation.
//
// Les notes restent de simples fichiers .md (data/vault/), ouvrables avec Obsidian.
// En plus, le serveur tient :
//   - un numéro de révision par note : un appareil demande « ce qui a changé
//     depuis la révision N » au lieu de tout retélécharger ;
//   - une archive de chaque version écrasée ou supprimée (data/versions/) :
//     aucune version n'est jamais perdue, et elle sert de base aux fusions.
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { writeFileAtomic } from '../atomic.ts';
import { hashContent, HttpError, type Vault } from '../vault.ts';
import { isNote } from '../../../shared/paths.ts';

interface Entry {
  /** Empreinte actuelle ; null = note supprimée (« pierre tombale »). */
  hash: string | null;
  rev: number;
}

interface StateFile {
  epoch: string;
  rev: number;
  entries: Record<string, Entry>;
}

export interface Change {
  path: string;
  hash: string | null;
}

export class SyncStore {
  /** Identifiant de cet historique : s'il change, les appareils repartent de zéro. */
  epoch = randomBytes(8).toString('hex');
  rev = 0;
  private entries = new Map<string, Entry>();
  private saveTimer: NodeJS.Timeout | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly stateFile: string;
  private readonly versionsDir: string;

  constructor(
    private vault: Vault,
    dataDir: string,
  ) {
    this.stateFile = path.join(dataDir, 'sync-state.json');
    this.versionsDir = path.join(dataDir, 'versions');
  }

  /** Charge l'état et le compare au contenu réel du dossier (modifs faites hors ligne). */
  async init(): Promise<void> {
    if (existsSync(this.stateFile)) {
      try {
        const s = JSON.parse(readFileSync(this.stateFile, 'utf8')) as StateFile;
        this.epoch = s.epoch;
        this.rev = s.rev;
        this.entries = new Map(Object.entries(s.entries));
      } catch {
        // Fichier abîmé : nouvel historique, les appareils feront une synchro complète (sans perte).
      }
    }
    const files = (await this.vault.walk('')).filter((e) => e.type === 'file').map((e) => e.path);
    const present = new Set(files);
    for (const p of files) {
      const h = this.vault.index.hashOf(p);
      if (h) this.touch(p, h);
    }
    for (const [p, e] of this.entries) if (e.hash !== null && !present.has(p)) this.touch(p, null);
    this.persistSoon(0);

    // Changements faits directement dans le dossier du serveur (Obsidian, SFTP…).
    this.vault.on((e) => {
      if (e.type === 'note') this.touch(e.path, e.hash);
      if (e.type === 'removed') {
        for (const [p, entry] of this.entries) {
          if ((p === e.path || p.startsWith(e.path + '/')) && entry.hash !== null) this.touch(p, null);
        }
      }
    });
  }

  /** Enregistre l'état d'une note ; ne crée une révision que s'il a changé. */
  touch(p: string, hash: string | null): number {
    const cur = this.entries.get(p);
    if (cur && cur.hash === hash) return cur.rev;
    if (!cur && hash === null) return this.rev;
    const entry = { hash, rev: ++this.rev };
    this.entries.set(p, entry);
    this.persistSoon();
    return entry.rev;
  }

  private persistSoon(delay = 500): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      const state: StateFile = { epoch: this.epoch, rev: this.rev, entries: Object.fromEntries(this.entries) };
      writeFileAtomic(this.stateFile, JSON.stringify(state)).catch((err) => console.error('[synchro] état non enregistré', err));
    }, delay);
  }

  /** Exécute les écritures l'une après l'autre. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  // -------------------------------------------------------------- lecture

  /** Changements depuis `since`, ou liste complète (full) si l'appareil repart de zéro. */
  changes(since: number, epoch: string | undefined): { full: boolean; changes: Change[] } {
    // Liste complète si l'appareil ne connaît pas encore cet historique (premier
    // synchro, ou historique recréé) ; sinon seulement ce qui a changé.
    const full = !epoch || epoch !== this.epoch || since > this.rev;
    const changes: Change[] = [];
    for (const [p, e] of this.entries) {
      if (full ? e.hash !== null : e.rev > since) changes.push({ path: p, hash: e.hash });
    }
    return { full, changes };
  }

  async read(p: string): Promise<{ path: string; content: string; hash: string } | null> {
    try {
      const n = await this.vault.readNote(p);
      return { path: n.path, content: n.content, hash: n.hash };
    } catch {
      return null;
    }
  }

  /** Contenu d'une version précise (actuelle ou archivée), pour les fusions. */
  async blob(p: string, hash: string): Promise<string | null> {
    const cur = await this.read(p);
    if (cur?.hash === hash) return cur.content;
    const dir = this.versionDir(p);
    try {
      const file = (await readdir(dir)).find((f) => f.endsWith(`__${hash}.md`));
      return file ? await readFile(path.join(dir, file), 'utf8') : null;
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------ écriture

  /**
   * Écrit une note envoyée par un appareil. `baseHash` est la version sur laquelle
   * l'appareil s'est basé (null = création). Si le serveur a changé depuis : 409.
   */
  put(p: string, content: string, baseHash: string | null): Promise<{ hash: string; rev: number }> {
    if (!isNote(p)) throw new HttpError(400, 'not_a_note', 'Seuls les fichiers .md sont synchronisés.');
    return this.exclusive(async () => {
      const cur = await this.read(p);
      const hash = hashContent(content);
      if (cur && cur.hash !== baseHash && cur.hash !== hash) {
        throw new HttpError(409, 'conflict', 'La note a changé sur le serveur.', { current: cur });
      }
      if (cur && cur.hash !== hash) await this.archive(p, cur.content, cur.hash);
      await this.vault.saveNote(p, content);
      return { hash, rev: this.touch(p, hash) };
    });
  }

  /** Supprime (corbeille du serveur) une note, si elle n'a pas changé depuis `baseHash`. */
  remove(p: string, baseHash: string): Promise<{ rev: number }> {
    return this.exclusive(async () => {
      const cur = await this.read(p);
      if (!cur) return { rev: this.touch(p, null) };
      if (cur.hash !== baseHash) {
        throw new HttpError(409, 'conflict', 'La note a changé sur le serveur.', { current: cur });
      }
      await this.archive(p, cur.content, cur.hash);
      await this.vault.trash(p);
      return { rev: this.touch(p, null) };
    });
  }

  private versionDir(p: string): string {
    return path.join(this.versionsDir, ...p.split('/'));
  }

  /** Archive une version : data/versions/<chemin>/<date>__<empreinte>.md */
  private async archive(p: string, content: string, hash: string): Promise<void> {
    const dir = this.versionDir(p);
    await mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await writeFileAtomic(path.join(dir, `${stamp}__${hash}.md`), content);
  }
}
