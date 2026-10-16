// État global de l'application et logique métier côté client.
//
// Sauvegarde automatique :
//   - chaque frappe marque la note « modifiée » et programme un enregistrement
//     700 ms plus tard (regroupe les frappes rapides) ;
//   - un brouillon est aussi gardé dans le navigateur (localStorage) tant que
//     le serveur n'a pas confirmé : une coupure ou un onglet fermé ne perd rien ;
//   - en cas de conflit (note modifiée ailleurs), notre version est enregistrée
//     dans une copie « (conflit …) » et la version du serveur est affichée.
import type { NoteData, TreeEntry } from '../../../shared/types.ts';
import { basename, dirname, INVALID_NAME_HELP, joinPath, normalizePath, noteTitle } from '../../../shared/paths.ts';
import { newNotePathForLink, rewriteLinks } from '../../../shared/links.ts';
import { VaultIndex } from './vaultIndex.ts';
import { backend, BackendError, isTauri } from './backend/index.ts';
import { vaultConfig } from './backend/tauri.ts';

export type SaveStatus = 'saved' | 'dirty' | 'saving' | 'error';
export type Theme = 'light' | 'dark';

export interface OpenNote {
  path: string;
  /** Contenu actuel dans l'éditeur. */
  content: string;
  /** Empreinte de la dernière version connue du serveur. */
  baseHash: string;
  dirty: boolean;
  /** Incrémenté quand le contenu est remplacé de l'extérieur : l'éditeur se recharge. */
  loadId: number;
}

export interface MenuItem {
  label: string;
  action: () => void;
  danger?: boolean;
}

interface Draft {
  content: string;
  baseHash: string;
}

const SAVE_DELAY = 700;
const RETRY_DELAY = 5000;

// ------------------------------------------------- stockage local (préférences)

function load<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem('obsilan:' + key);
    return v === null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}

function persist(key: string, value: unknown): void {
  try {
    if (value === undefined) localStorage.removeItem('obsilan:' + key);
    else localStorage.setItem('obsilan:' + key, JSON.stringify(value));
  } catch {
    // Stockage plein ou désactivé : sans gravité pour les préférences.
  }
}

const draftKey = (path: string) => 'draft:' + path;

/** Horodatage lisible et valide dans un nom de fichier : « 2026-10-16 14h05 ». */
function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}h${p(d.getMinutes())}`;
}

class Store {
  entries = $state<TreeEntry[]>([]);
  note = $state<OpenNote | null>(null);
  status = $state<SaveStatus>('saved');
  /** Vrai quand le flux d'événements est connecté (toujours vrai en local). */
  live = $state(false);
  /** Dossier du coffre (application uniquement). */
  vaultRoot = $state<string | null>(null);
  /** Premier lancement sur PC : il faut choisir le dossier des notes. */
  needsVault = $state(false);
  suggestedRoot = $state('');
  /** Android : stockage privé de repli. */
  privateRoot = $state('');
  mobile = $state(false);
  /** Indexation initiale en cours. */
  loading = $state(false);
  /** Vrai une fois le coffre ouvert et indexé. */
  started = false;
  toast = $state<{ text: string; kind: 'info' | 'warn' | 'error' } | null>(null);

  mode = $state<'edit' | 'read'>(load('mode', 'edit'));
  theme = $state<Theme>((document.documentElement.dataset.theme as Theme) ?? 'light');
  sidebarTab = $state<'files' | 'search' | 'tags'>('files');
  /** Tag affiché dans l'onglet Tags (null = liste de tous les tags). */
  selectedTag = $state<string | null>(null);
  /** Panneau des rétroliens déplié sous la note. */
  backlinksOpen = $state<boolean>(load('backlinksOpen', true));

  /** Index local : recherche, liens, tags (non réactif, voir indexVersion). */
  readonly index = new VaultIndex();
  /** Incrémenté à chaque changement de l'index : les panneaux se recalculent. */
  indexVersion = $state(0);
  sidebarOpen = $state(window.innerWidth > 800);
  expanded = $state<Record<string, boolean>>(load('expanded', {}));
  /** Dossier dans lequel « Nouvelle note » crée la note. */
  selectedFolder = $state('');
  /** Chemin de l'élément en cours de renommage dans l'arbre. */
  renaming = $state<string | null>(null);
  menu = $state<{ x: number; y: number; items: MenuItem[] } | null>(null);
  /** Demande ponctuelle de focus sur le titre de la note (après création). */
  focusTitle = $state(false);
  searchQuery = $state('');

  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private saving = false;
  private saveChain: Promise<void> = Promise.resolve();
  private loadCounter = 0;
  private toastTimer: ReturnType<typeof setTimeout> | undefined;
  private treeTimer: ReturnType<typeof setTimeout> | undefined;

  // ------------------------------------------------------------ démarrage

  /**
   * Démarrage. Dans l'application, il faut d'abord savoir où sont les notes :
   * au premier lancement sur PC, on affiche l'écran de choix du dossier ;
   * sur Android, on utilise directement Documents/ObsiLan.
   */
  async init(): Promise<void> {
    if (isTauri) {
      try {
        const root = await vaultConfig.current();
        if (root) {
          this.vaultRoot = await vaultConfig.open(root);
        } else if ((this.mobile = await vaultConfig.isMobile())) {
          // Android : Documents/ObsiLan, si l'accès aux fichiers est autorisé.
          this.suggestedRoot = await vaultConfig.suggested();
          this.privateRoot = await vaultConfig.privateRoot();
          try {
            this.vaultRoot = await vaultConfig.open(this.suggestedRoot);
          } catch {
            this.needsVault = true;
            // Au retour des réglages Android, on réessaie automatiquement.
            document.addEventListener('visibilitychange', () => {
              if (document.visibilityState === 'visible' && this.needsVault) this.retryVault();
            });
            return;
          }
        } else {
          this.suggestedRoot = await vaultConfig.suggested();
          this.needsVault = true;
          return;
        }
      } catch (err) {
        // Dossier introuvable (disque débranché…) : on redemande.
        this.fail(err);
        this.suggestedRoot = await vaultConfig.suggested().catch(() => '');
        this.needsVault = true;
        return;
      }
    }
    await this.start();
  }

  /** Android : nouvel essai silencieux après que l'utilisateur a accordé l'accès. */
  private async retryVault(): Promise<void> {
    try {
      await vaultConfig.open(this.suggestedRoot);
      location.reload();
    } catch {
      // Toujours pas autorisé : on reste sur l'écran d'explication.
    }
  }

  /** Choisit (ou change) le dossier des notes, puis redémarre l'interface. */
  async chooseVault(root: string): Promise<void> {
    try {
      await this.flush();
      await vaultConfig.open(root);
      persist('lastNote', undefined);
      location.reload();
    } catch (err) {
      this.fail(err);
    }
  }

  private async start(): Promise<void> {
    this.loading = true;
    try {
      // Indexation de tout le coffre (recherche, liens, tags) au démarrage.
      for (const n of await backend.loadAll()) this.index.upsert(n.path, n.content, n.hash);
      this.indexVersion++;
      await this.loadTree();
    } catch (err) {
      this.fail(err);
    } finally {
      this.loading = false;
    }
    backend.subscribe(
      (e) => {
        if (e.type === 'tree') this.refreshTreeSoon();
        if (e.type === 'removed') {
          this.index.remove(e.path);
          this.indexVersion++;
          this.refreshTreeSoon();
        }
        if (e.type === 'note') this.onRemoteChange(e.path, e.hash);
      },
      (ok) => {
        // À chaque (re)connexion on resynchronise : des événements ont pu être manqués.
        if (ok && !this.live) this.refreshTreeSoon();
        this.live = ok;
      },
    );
    this.started = true;
    const last = load<string | null>('lastNote', null);
    const first = this.entries.find((e) => e.type === 'file');
    const target = last && this.entries.some((e) => e.path === last) ? last : first?.path;
    if (target) await this.open(target);

    // Application mise en arrière-plan (Android) ou onglet masqué : on enregistre
    // tout de suite ; au retour, on relit l'arborescence (changements externes).
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.flush();
      else this.refreshTreeSoon();
    });

    // Navigateur : dernier envoi à la fermeture de l'onglet. Le brouillon local
    // reste de toute façon disponible au prochain lancement.
    window.addEventListener('beforeunload', (ev) => {
      const n = this.note;
      if (n?.dirty && backend.saveOnExit) {
        backend.saveOnExit(n.path, n.content, n.baseHash);
        ev.preventDefault();
      }
    });
  }

  notify(text: string, kind: 'info' | 'warn' | 'error' = 'info', ms = 4000): void {
    this.toast = { text, kind };
    clearTimeout(this.toastTimer);
    if (ms > 0) this.toastTimer = setTimeout(() => (this.toast = null), ms);
  }

  /** Affiche un message d'erreur lisible. */
  fail(err: unknown): void {
    this.notify(err instanceof Error ? err.message : String(err), 'error', 6000);
  }

  async loadTree(): Promise<void> {
    try {
      this.entries = await backend.tree();
      await this.reconcileIndex();
    } catch (err) {
      this.fail(err);
    }
  }

  /**
   * Aligne l'index sur l'arborescence réelle : retire les notes disparues et
   * indexe les nouvelles (événements manqués, copie de fichiers en masse…).
   */
  private async reconcileIndex(): Promise<void> {
    const files = new Set(this.entries.filter((e) => e.type === 'file').map((e) => e.path));
    let changed = false;
    for (const p of this.index.links.paths) {
      if (!files.has(p)) {
        this.index.remove(p);
        changed = true;
      }
    }
    const missing = [...files].filter((p) => this.index.hashOf(p) === undefined);
    for (const p of missing) {
      try {
        const n = await backend.read(p);
        this.index.upsert(n.path, n.content, n.hash);
        changed = true;
      } catch {
        // Fichier disparu entre-temps.
      }
    }
    if (changed) this.indexVersion++;
  }

  /** Recharge l'arbre, en regroupant les demandes rapprochées. */
  refreshTreeSoon(): void {
    clearTimeout(this.treeTimer);
    this.treeTimer = setTimeout(() => this.loadTree(), 150);
  }

  // ------------------------------------------------- changements externes

  /** Une note a changé en dehors de l'éditeur (Obsidian, autre onglet, copie de fichiers…). */
  private async onRemoteChange(path: string, hash: string): Promise<void> {
    // L'index suit toutes les notes, ouvertes ou non.
    if (this.index.hashOf(path) !== hash) {
      try {
        const fresh = await backend.read(path);
        this.index.upsert(fresh.path, fresh.content, fresh.hash);
        this.indexVersion++;
      } catch {
        // Note déjà supprimée : l'événement « removed » ou l'arbre s'en chargera.
      }
    }
    const n = this.note;
    if (!n || n.path !== path || n.baseHash === hash) return;
    // Si on est en train d'écrire, la prochaine sauvegarde détectera le conflit.
    if (n.dirty || this.saving) return;
    try {
      const fresh = await backend.read(path);
      if (this.note?.path === path && !this.note.dirty) {
        this.replaceNote(fresh);
        this.notify('Note mise à jour depuis l’extérieur.');
      }
    } catch {
      // Note supprimée ou renommée ailleurs : l'arbre se mettra à jour.
    }
  }

  // ---------------------------------------------------------- notes

  private replaceNote(data: NoteData, content = data.content, dirty = false): void {
    this.note = { path: data.path, content, baseHash: data.hash, dirty, loadId: ++this.loadCounter };
    this.status = dirty ? 'dirty' : 'saved';
  }

  async open(path: string): Promise<void> {
    if (this.note?.path === path) return;
    await this.flush();
    try {
      const data = await backend.read(path);
      this.replaceNote(data);
      this.selectedFolder = dirname(path);
      this.revealInTree(path);
      persist('lastNote', path);
      await this.recoverDraft(data);
      if (window.innerWidth <= 800) this.sidebarOpen = false;
    } catch (err) {
      this.fail(err);
    }
  }

  /** Restaure un brouillon non enregistré (onglet fermé, coupure réseau…). */
  private async recoverDraft(data: NoteData): Promise<void> {
    const draft = load<Draft | null>(draftKey(data.path), null);
    if (!draft) return;
    if (draft.content === data.content) {
      persist(draftKey(data.path), undefined);
    } else if (draft.baseHash === data.hash) {
      // Le serveur n'a pas bougé : on reprend simplement la saisie là où elle était.
      this.replaceNote(data, draft.content, true);
      this.notify('Modifications non enregistrées restaurées.', 'info');
      this.scheduleSave();
    } else {
      // Le serveur a changé entre-temps : on garde les deux versions.
      await this.saveConflictCopy(data.path, draft.content);
      persist(draftKey(data.path), undefined);
    }
  }

  /** Appelé par l'éditeur à chaque modification. */
  edit(content: string): void {
    const n = this.note;
    if (!n || n.content === content) return;
    n.content = content;
    n.dirty = true;
    this.status = 'dirty';
    persist(draftKey(n.path), { content, baseHash: n.baseHash } satisfies Draft);
    this.scheduleSave();
  }

  private scheduleSave(delay = SAVE_DELAY): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), delay);
  }

  /**
   * Enregistre immédiatement la note courante si elle a été modifiée.
   * Les enregistrements sont mis à la file : jamais deux envois simultanés,
   * sinon le second partirait d'une version de base périmée (faux conflit).
   */
  flush(): Promise<void> {
    clearTimeout(this.saveTimer);
    this.saveChain = this.saveChain.then(async () => {
      const n = this.note;
      if (!n || !n.dirty) return;
      this.saving = true;
      try {
        await this.doSave(n.path, n.content, n.baseHash);
      } finally {
        this.saving = false;
      }
    });
    return this.saveChain;
  }

  private async doSave(path: string, content: string, baseHash: string): Promise<void> {
    this.status = 'saving';
    try {
      const res = await backend.save(path, content, baseHash);
      this.index.upsert(path, content, res.hash);
      this.indexVersion++;
      const n = this.note;
      if (n?.path === path) {
        n.baseHash = res.hash;
        // Si l'utilisateur a continué à taper pendant l'envoi, on reste « modifié ».
        if (n.content === content) {
          n.dirty = false;
          persist(draftKey(path), undefined);
          this.status = 'saved';
        } else {
          persist(draftKey(path), { content: n.content, baseHash: res.hash } satisfies Draft);
          this.status = 'dirty';
          this.scheduleSave();
        }
      } else {
        persist(draftKey(path), undefined);
      }
    } catch (err) {
      if (err instanceof BackendError && err.status === 409 && err.data.current) {
        await this.handleConflict(path, err.data.current as NoteData);
      } else {
        // Réseau coupé ou serveur arrêté : le brouillon local est conservé, on réessaie.
        this.status = 'error';
        this.scheduleSave(RETRY_DELAY);
      }
    }
  }

  /** La note a changé ailleurs : on conserve les deux versions, jamais de perte. */
  private async handleConflict(path: string, current: NoteData): Promise<void> {
    const mine = this.note?.path === path ? this.note.content : null;
    if (mine === null) return;
    const copy = await this.saveConflictCopy(path, mine);
    if (!copy) {
      // Copie impossible (serveur indisponible) : on garde la saisie et on réessaiera.
      this.status = 'error';
      this.scheduleSave(RETRY_DELAY);
      return;
    }
    persist(draftKey(path), undefined);
    if (this.note?.path === path) this.replaceNote(current);
  }

  /** Enregistre `content` dans « Titre (conflit AAAA-MM-JJ HHhMM).md ». Renvoie son chemin. */
  private async saveConflictCopy(path: string, content: string): Promise<string | null> {
    const base = joinPath(dirname(path), `${noteTitle(path)} (conflit ${stamp()})`);
    for (let i = 0; i < 50; i++) {
      const candidate = `${base}${i ? ' ' + i : ''}.md`;
      try {
        const res = await backend.createNote({ path: candidate, content });
        this.index.upsert(candidate, content, res.hash);
        this.indexVersion++;
        this.notify(
          `Conflit : la note a été modifiée ailleurs. Votre version a été gardée dans « ${noteTitle(candidate)} ».`,
          'warn',
          10000,
        );
        this.refreshTreeSoon();
        return candidate;
      } catch (err) {
        if (!(err instanceof BackendError && err.status === 409)) return null;
      }
    }
    return null;
  }

  // ---------------------------------------------- fichiers et dossiers

  async createNote(folder = this.selectedFolder): Promise<void> {
    try {
      const res = await backend.createNote({ folder: folder || undefined });
      this.index.upsert(res.path, '', res.hash);
      await this.loadTree();
      await this.open(res.path);
      this.mode = 'edit';
      this.focusTitle = true;
    } catch (err) {
      this.fail(err);
    }
  }

  async createFolder(parent = this.selectedFolder): Promise<void> {
    try {
      const res = await backend.createFolder({ parent: parent || undefined });
      if (parent) this.expanded[parent] = true;
      await this.loadTree();
      this.renaming = res.path;
    } catch (err) {
      this.fail(err);
    }
  }

  /**
   * Renomme ou déplace une note ou un dossier, puis met à jour tous les liens
   * [[…]] qui y menaient. Renvoie false en cas d'échec (nom déjà pris…).
   */
  async rename(from: string, to: string): Promise<boolean> {
    if (from === to) return true;
    await this.flush();

    // Avant le renommage : quelles notes bougent, et qui pointe vers elles ?
    const oldPaths = this.index.links.paths;
    const moves = new Map<string, string>();
    for (const p of oldPaths) {
      if (p === from) moves.set(p, to);
      else if (p.startsWith(from + '/')) moves.set(p, to + p.slice(from.length));
    }
    const sources = moves.size ? this.index.links.sourcesLinkingTo(new Set(moves.keys())) : [];

    try {
      await backend.rename(from, to);
    } catch (err) {
      this.fail(err);
      return false;
    }
    this.index.move(from, to);
    this.indexVersion++;

    const remap = (p: string) => (p === from ? to : p.startsWith(from + '/') ? to + p.slice(from.length) : p);
    // Note ouverte, dossiers dépliés et dossier sélectionné suivent le renommage.
    if (this.note) {
      const newPath = remap(this.note.path);
      if (newPath !== this.note.path) {
        this.note.path = newPath;
        persist('lastNote', newPath);
      }
    }
    const exp: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(this.expanded)) exp[remap(k)] = v;
    this.expanded = exp;
    this.selectedFolder = remap(this.selectedFolder);

    if (sources.length) await this.updateLinks(sources, moves, oldPaths, this.index.links.paths);
    await this.loadTree();
    return true;
  }

  /** Réécrit les liens des notes `sources` après un renommage. */
  private async updateLinks(
    sources: string[],
    moves: Map<string, string>,
    oldPaths: string[],
    newPaths: string[],
  ): Promise<void> {
    let notes = 0;
    let links = 0;
    let failed = 0;
    for (const srcOld of sources) {
      const srcNew = moves.get(srcOld) ?? srcOld;
      const open = this.note?.path === srcNew ? this.note : null;
      // Note ouverte : on part du texte de l'éditeur (il peut contenir une saisie en cours).
      const text = open ? open.content : this.index.links.content(srcNew);
      if (text === undefined) continue;
      const r = rewriteLinks(text, srcOld, srcNew, moves, oldPaths, newPaths);
      if (!r.changed) continue;
      if (open) {
        open.content = r.text;
        open.dirty = true;
        open.loadId = ++this.loadCounter; // l'éditeur affiche le nouveau texte
        this.status = 'dirty';
        this.scheduleSave(0);
      } else {
        try {
          const res = await backend.save(srcNew, r.text, this.index.hashOf(srcNew));
          this.index.upsert(srcNew, r.text, res.hash);
        } catch {
          failed++; // note modifiée ailleurs entre-temps : on n'écrase rien
          continue;
        }
      }
      notes++;
      links += r.changed;
    }
    this.indexVersion++;
    if (links) {
      this.notify(`${links} lien${links > 1 ? 's' : ''} mis à jour dans ${notes} note${notes > 1 ? 's' : ''}.`);
    }
    if (failed) {
      this.notify(`${failed} note(s) n'ont pas pu être mises à jour (modifiées ailleurs).`, 'warn', 8000);
    }
  }

  /**
   * Suit un lien [[cible]] depuis la note `source` : ouvre la note visée,
   * ou la crée si elle n'existe pas encore (comme Obsidian).
   */
  async openLink(target: string, source = this.note?.path ?? ''): Promise<void> {
    const t = target.trim();
    if (!t) return;
    const found = this.index.links.resolve(t, source);
    if (found) return this.open(found);
    const path = normalizePath(newNotePathForLink(t, source));
    if (!path) {
      this.notify(INVALID_NAME_HELP, 'error', 6000);
      return;
    }
    try {
      await this.flush();
      const res = await backend.createNote({ path, content: '' });
      this.index.upsert(res.path, '', res.hash);
      this.indexVersion++;
      await this.loadTree();
      await this.open(res.path);
      this.notify(`Note « ${noteTitle(res.path)} » créée.`);
    } catch (err) {
      this.fail(err);
    }
  }

  /** Affiche les notes portant un tag (onglet Tags). */
  openTag(tag: string): void {
    this.selectedTag = tag;
    this.sidebarTab = 'tags';
    this.sidebarOpen = true;
  }

  toggleBacklinks(): void {
    this.backlinksOpen = !this.backlinksOpen;
    persist('backlinksOpen', this.backlinksOpen);
  }

  /** Déplace une note ou un dossier dans `folder` (glisser-déposer). */
  async moveInto(src: string, folder: string): Promise<void> {
    if (dirname(src) === folder || src === folder) return;
    if (folder.startsWith(src + '/')) {
      this.notify('Impossible de déplacer un dossier dans lui-même.', 'error');
      return;
    }
    if (await this.rename(src, joinPath(folder, basename(src)))) {
      if (folder) this.expanded[folder] = true;
    }
  }

  /** Met à la corbeille après confirmation. */
  async remove(path: string, isFolder: boolean): Promise<void> {
    const name = isFolder ? path : noteTitle(path);
    const msg = isFolder
      ? `Mettre le dossier « ${name} » et tout son contenu à la corbeille ?`
      : `Mettre « ${name} » à la corbeille ?`;
    if (!confirm(msg)) return;
    await this.flush();
    try {
      await backend.trash(path);
      this.index.remove(path);
      this.indexVersion++;
      const n = this.note;
      if (n && (n.path === path || n.path.startsWith(path + '/'))) {
        this.note = null;
        persist('lastNote', undefined);
      }
      this.notify(`« ${name} » a été mis à la corbeille (dossier .trash du coffre).`);
      await this.loadTree();
    } catch (err) {
      this.fail(err);
    }
  }

  // ---------------------------------------------------------- interface

  toggleFolder(path: string): void {
    this.expanded[path] = !this.expanded[path];
    persist('expanded', this.expanded);
  }

  /** Déplie les dossiers parents pour rendre une note visible. */
  revealInTree(path: string): void {
    let dir = dirname(path);
    while (dir) {
      this.expanded[dir] = true;
      dir = dirname(dir);
    }
    persist('expanded', this.expanded);
  }

  toggleTheme(): void {
    this.theme = this.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = this.theme;
    persist('theme', this.theme);
  }

  toggleMode(): void {
    this.mode = this.mode === 'edit' ? 'read' : 'edit';
    persist('mode', this.mode);
  }

  openSearch(): void {
    this.sidebarOpen = true;
    this.sidebarTab = 'search';
  }
}

export const store = new Store();
