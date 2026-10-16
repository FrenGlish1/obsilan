// Moteur de synchronisation de l'application.
//
// À chaque synchro :
//   1. on enregistre la note en cours d'édition ;
//   2. on demande au serveur ce qui a changé depuis la dernière fois ;
//   3. on compare avec l'état local et la « base » (état au dernier synchro)
//      grâce à planSync (shared/syncPlan.ts, testé) ;
//   4. on applique les actions : envoi, téléchargement, suppression, fusion.
// Toutes les écritures locales vérifient que la note n'a pas changé entre-temps
// (sinon elles sont reportées au synchro suivant) : jamais d'écrasement silencieux.
import { backend, BackendError, isTauri } from '../backend/index.ts';
import { store } from '../store.svelte.ts';
import { planSync, type SyncAction } from '../../../../shared/syncPlan.ts';
import { mergeText } from '../../../../shared/merge.ts';
import { dirname, joinPath, noteTitle } from '../../../../shared/paths.ts';
import { normalizeServerUrl, SyncClient, SyncError } from './client.ts';

export type SyncStatus = 'off' | 'idle' | 'syncing' | 'offline' | 'error';

/** Ce qui est mémorisé sur l'appareil (par coffre). */
interface Saved {
  serverUrl: string;
  token: string | null;
  username: string;
  epoch: string | null;
  rev: number;
  /** État au dernier synchro : chemin → empreinte. */
  base: Record<string, string>;
  lastSync: number | null;
}

const AUTO_INTERVAL = 60_000;
const AFTER_CHANGE_DELAY = 4_000;

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}h${p(d.getMinutes())}`;
}

class SyncEngine {
  status = $state<SyncStatus>('off');
  message = $state('');
  lastSync = $state<number | null>(null);
  serverUrl = $state('');
  username = $state('');
  /** Connexion Discord en cours (attente du navigateur). */
  connecting = $state(false);
  panelOpen = $state(false);
  /** Appareil connecté au serveur (jeton présent). */
  connected = $state(false);

  private saved: Saved = { serverUrl: '', token: null, username: '', epoch: null, rev: 0, base: {}, lastSync: null };
  private key = '';
  private running: Promise<void> | null = null;
  private again = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private cancelLogin = false;


  private get client(): SyncClient {
    return new SyncClient(this.saved.serverUrl, this.saved.token);
  }

  // ---------------------------------------------------------- démarrage

  /** Appelé une fois le coffre ouvert. */
  init(): void {
    this.key = 'obsilan:sync:' + (store.vaultRoot ?? 'web:' + location.host);
    try {
      const raw = localStorage.getItem(this.key);
      if (raw) this.saved = { ...this.saved, ...JSON.parse(raw) };
    } catch {
      // Rien de mémorisé.
    }
    this.serverUrl = this.saved.serverUrl;
    this.username = this.saved.username;
    this.lastSync = this.saved.lastSync;
    this.connected = !!this.saved.token;
    this.status = this.connected ? 'idle' : 'off';

    // Chaque modification locale déclenche un synchro quelques secondes plus tard.
    store.index.onChange = () => {
      if (this.connected && !this.running) this.soon(AFTER_CHANGE_DELAY);
    };
    // Synchro régulier, et au retour au premier plan (téléphone).
    setInterval(() => this.connected && this.sync(), AUTO_INTERVAL);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.connected) this.soon(500);
    });
    if (this.connected) this.soon(300);
  }

  private persist(): void {
    try {
      localStorage.setItem(this.key, JSON.stringify(this.saved));
    } catch {
      this.message = 'Stockage local plein : l’état de synchro n’a pas pu être enregistré.';
    }
  }

  soon(delay = 0): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.sync(), delay);
  }

  // ---------------------------------------------------------- connexion

  /** Nom de l'appareil affiché côté serveur. */
  private deviceName(): string {
    if (store.mobile || /Android/i.test(navigator.userAgent)) return 'Téléphone Android';
    return isTauri ? 'PC Windows' : 'Navigateur';
  }

  private async openBrowser(url: string): Promise<void> {
    if (isTauri) {
      const { openUrl } = await import('@tauri-apps/plugin-opener');
      await openUrl(url);
    } else {
      window.open(url, '_blank', 'noopener');
    }
  }

  /** Connexion avec Discord : ouvre le navigateur et attend la fin. */
  async connect(url: string): Promise<void> {
    const serverUrl = normalizeServerUrl(url);
    if (!serverUrl) return;
    this.connecting = true;
    this.cancelLogin = false;
    this.message = '';
    try {
      const c = new SyncClient(serverUrl);
      const info = await c.info();
      if (info.name !== 'ObsiLan') throw new Error("Cette adresse n'est pas un serveur ObsiLan.");
      const login = await c.startLogin(this.deviceName());
      await this.openBrowser(login.url);
      this.message = 'Terminez la connexion dans le navigateur qui vient de s’ouvrir…';
      const deadline = Date.now() + 10 * 60 * 1000;
      while (!this.cancelLogin && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2000));
        const r = await c.pollLogin(login.loginId, login.pollSecret);
        if (r.status === 'pending') continue;
        if (r.status === 'denied' || !r.token) throw new Error(r.message ?? 'Connexion refusée.');
        await this.finishLogin(serverUrl, r.token, r.username ?? '');
        return;
      }
      if (!this.cancelLogin) throw new Error('Délai dépassé. Recommencez la connexion.');
    } catch (err) {
      this.message = err instanceof Error ? err.message : String(err);
    } finally {
      this.connecting = false;
    }
  }

  /** Connexion par jeton (serveur de test local uniquement). */
  async connectWithToken(url: string, token: string): Promise<void> {
    const serverUrl = normalizeServerUrl(url);
    try {
      const me = await new SyncClient(serverUrl, token.trim()).me();
      await this.finishLogin(serverUrl, token.trim(), me.username);
    } catch (err) {
      this.message = err instanceof Error ? err.message : String(err);
    }
  }

  cancelConnect(): void {
    this.cancelLogin = true;
    this.connecting = false;
    this.message = '';
  }

  private async finishLogin(serverUrl: string, token: string, username: string): Promise<void> {
    // Nouveau serveur : on repart d'une comparaison complète (aucune perte possible).
    const sameServer = this.saved.serverUrl === serverUrl;
    this.saved = {
      serverUrl,
      token,
      username,
      epoch: sameServer ? this.saved.epoch : null,
      rev: sameServer ? this.saved.rev : 0,
      base: sameServer ? this.saved.base : {},
      lastSync: sameServer ? this.saved.lastSync : null,
    };
    this.serverUrl = serverUrl;
    this.username = username;
    this.message = '';
    this.connected = true;
    this.status = 'idle';
    this.persist();
    store.notify(`Connecté à la synchronisation${username ? ' en tant que ' + username : ''}.`);
    await this.sync();
  }

  async disconnect(): Promise<void> {
    try {
      await this.client.logout();
    } catch {
      // Serveur injoignable : on oublie quand même le jeton localement.
    }
    this.saved.token = null;
    this.saved.username = '';
    this.username = '';
    this.connected = false;
    this.status = 'off';
    this.persist();
  }

  // ---------------------------------------------------------- synchro

  /** Lance un synchro (ou en programme un autre si l'un est déjà en cours). */
  sync(): Promise<void> {
    if (!this.connected || !store.started) return Promise.resolve();
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = this.run().finally(() => {
      this.running = null;
      if (this.again) {
        this.again = false;
        this.soon(500);
      }
    });
    return this.running;
  }

  private async run(): Promise<void> {
    this.status = 'syncing';
    try {
      await store.flush();
      const client = this.client;
      const remote = await client.changes(this.saved.rev, this.saved.epoch);

      const local = new Map<string, string>();
      for (const p of store.index.links.paths) {
        const h = store.index.hashOf(p);
        if (h) local.set(p, h);
      }
      const actions = planSync({
        local,
        base: new Map(Object.entries(this.saved.base)),
        remoteChanges: new Map(remote.changes.map((c) => [c.path, c.hash])),
        full: remote.full,
      });

      const counts = await this.apply(client, actions);

      this.saved.epoch = remote.epoch;
      this.saved.rev = remote.rev;
      this.saved.lastSync = Date.now();
      this.lastSync = this.saved.lastSync;
      this.persist();
      this.status = 'idle';
      this.message = '';
      if (counts.changed) await store.loadTree();
      if (counts.conflicts) {
        store.notify(
          `${counts.conflicts} note(s) modifiée(s) des deux côtés : les deux versions ont été gardées (« … (conflit …) »).`,
          'warn',
          10000,
        );
      }
    } catch (err) {
      if (err instanceof SyncError && err.status === 0) {
        this.status = 'offline';
        this.message = 'Hors ligne : la synchro reprendra automatiquement.';
      } else if (err instanceof SyncError && err.status === 401) {
        this.status = 'error';
        this.message = 'Cet appareil a été déconnecté du serveur. Reconnectez-vous.';
      } else {
        this.status = 'error';
        this.message = err instanceof Error ? err.message : String(err);
      }
    }
  }

  /** Applique les actions ; une erreur sur une note n'arrête pas les autres. */
  private async apply(client: SyncClient, actions: SyncAction[]): Promise<{ changed: number; conflicts: number }> {
    const base = this.saved.base;
    let changed = 0;
    let conflicts = 0;
    const setBase = (p: string, h: string | null) => {
      if (h) base[p] = h;
      else delete base[p];
    };

    // Téléchargements groupés en une fois.
    const toFetch = actions.filter((a) => a.type === 'download' || a.type === 'merge').map((a) => a.path);
    const fetched = toFetch.length ? await client.download(toFetch) : new Map();

    for (const a of actions) {
      try {
        switch (a.type) {
          case 'setBase':
            setBase(a.path, a.hash);
            break;

          case 'upload': {
            const note = await backend.read(a.path);
            try {
              const r = await client.upload(a.path, note.content, a.baseHash);
              setBase(a.path, r.hash);
            } catch (err) {
              // Le serveur a changé entre-temps : on fusionne avec sa version.
              if (!(err instanceof SyncError && err.status === 409)) throw err;
              const cur = err.data.current as { content: string; hash: string };
              if (await this.merge(client, a.path, a.baseHash, note.content, note.hash, cur.content, cur.hash)) conflicts++;
            }
            changed++;
            break;
          }

          case 'deleteRemote':
            try {
              await client.remove(a.path, a.baseHash);
              setBase(a.path, null);
            } catch (err) {
              // Modifiée sur le serveur depuis : on la récupère au lieu de la supprimer.
              if (!(err instanceof SyncError && err.status === 409)) throw err;
              const cur = err.data.current as { content: string; hash: string };
              await this.writeLocal(a.path, cur.content, null);
              setBase(a.path, cur.hash);
              changed++;
            }
            break;

          case 'download': {
            const f = fetched.get(a.path);
            if (!f) break; // supprimée entre-temps : le prochain synchro s'en chargera
            await this.writeLocal(a.path, f.content, a.localHash);
            setBase(a.path, f.hash);
            changed++;
            break;
          }

          case 'deleteLocal':
            // On ne supprime que si la note locale n'a pas bougé depuis le plan.
            if (store.index.hashOf(a.path) === a.localHash) {
              await backend.trash(a.path);
              store.index.remove(a.path);
              if (store.note?.path === a.path) store.note = null;
            }
            setBase(a.path, null);
            changed++;
            break;

          case 'merge': {
            const f = fetched.get(a.path);
            const note = await backend.read(a.path);
            if (!f) {
              // Supprimée sur le serveur entre-temps : on renvoie la nôtre.
              const r = await client.upload(a.path, note.content, null);
              setBase(a.path, r.hash);
            } else if (await this.merge(client, a.path, a.baseHash, note.content, note.hash, f.content, f.hash)) {
              conflicts++;
            }
            changed++;
            break;
          }
        }
      } catch (err) {
        if (err instanceof SyncError && (err.status === 0 || err.status === 401)) throw err;
        // Écriture locale refusée (note modifiée pendant le synchro) : on réessaiera.
        if (err instanceof BackendError && err.status === 409) this.again = true;
        else console.warn('[synchro]', a, err);
      }
    }
    store.indexVersion++;
    return { changed, conflicts };
  }

  /**
   * Fusionne une note modifiée des deux côtés. Renvoie true s'il a fallu
   * garder deux versions (conflit), false si la fusion automatique a réussi.
   */
  private async merge(
    client: SyncClient,
    path: string,
    baseHash: string | null,
    mine: string,
    mineHash: string,
    theirs: string,
    theirsHash: string,
  ): Promise<boolean> {
    const baseText = baseHash ? await client.blob(path, baseHash) : null;
    const merged = baseText !== null ? mergeText(baseText, mine, theirs) : null;
    if (merged !== null) {
      await this.writeLocal(path, merged, mineHash);
      const r = await client.upload(path, merged, theirsHash);
      this.saved.base[path] = r.hash;
      return false;
    }
    // Conflit : notre version part dans une copie, la note garde celle du serveur.
    const copy = await this.conflictCopy(path, mine);
    const r = await client.upload(copy.path, mine, null);
    this.saved.base[copy.path] = r.hash;
    await this.writeLocal(path, theirs, mineHash);
    this.saved.base[path] = theirsHash;
    return true;
  }

  /** Crée « Titre (conflit AAAA-MM-JJ HHhMM appareil).md » avec `content`. */
  private async conflictCopy(path: string, content: string): Promise<{ path: string; hash: string }> {
    const device = this.deviceName().replace(/[^\p{L}\p{N} -]/gu, '');
    const base = joinPath(dirname(path), `${noteTitle(path)} (conflit ${stamp()} ${device})`);
    for (let i = 0; i < 50; i++) {
      const candidate = `${base}${i ? ' ' + i : ''}.md`;
      try {
        const res = await backend.createNote({ path: candidate, content });
        store.index.upsert(candidate, content, res.hash);
        return { path: candidate, hash: res.hash };
      } catch (err) {
        if (!(err instanceof BackendError && err.status === 409)) throw err;
      }
    }
    throw new Error('Impossible de créer la copie de conflit.');
  }

  /**
   * Écrit une note localement, seulement si elle est toujours dans l'état
   * attendu (`expectedHash`, ou absente si null). Sinon : BackendError 409.
   */
  private async writeLocal(path: string, content: string, expectedHash: string | null): Promise<void> {
    const res = expectedHash
      ? await backend.save(path, content, expectedHash)
      : await backend.createNote({ path, content });
    store.index.upsert(path, content, res.hash);
  }
}

export const sync = new SyncEngine();
