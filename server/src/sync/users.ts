// Un espace séparé par compte Discord : chaque utilisateur a ses propres notes,
// ses versions archivées et son état de synchro, invisibles des autres.
//
//   data/users/<identifiant Discord>/vault/          notes .md
//   data/users/<identifiant Discord>/versions/       versions archivées
//   data/users/<identifiant Discord>/sync-state.json révisions
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { Vault } from '../vault.ts';
import { watchVault } from '../watcher.ts';
import { SyncStore } from './store.ts';
import { HttpError } from '../vault.ts';

interface Space {
  store: SyncStore;
  stop: () => Promise<void>;
}

export class UserSpaces {
  private spaces = new Map<string, Promise<Space>>();
  private readonly root: string;

  constructor(dataDir: string) {
    this.root = path.join(dataDir, 'users');
  }

  /** Espace de synchro d'un utilisateur (créé à sa première connexion). */
  async get(userId: string): Promise<SyncStore> {
    // Identifiants Discord : uniquement des chiffres (« dev » pour les tests locaux).
    if (!/^(\d{1,30}|dev)$/.test(userId)) throw new HttpError(400, 'bad_user', 'Identifiant de compte invalide.');
    let space = this.spaces.get(userId);
    if (!space) {
      space = this.open(userId);
      this.spaces.set(userId, space);
      space.catch(() => this.spaces.delete(userId));
    }
    return (await space).store;
  }

  private async open(userId: string): Promise<Space> {
    const dir = path.join(this.root, userId);
    const vault = new Vault(path.join(dir, 'vault'));
    await vault.init({ welcome: false });
    const store = new SyncStore(vault, dir);
    await store.init();
    // Surveillance : modifications faites à la main dans le dossier de l'utilisateur.
    const stop = watchVault(vault);
    return { store, stop };
  }

  /** Nombre de comptes ayant déjà un espace (pour le journal de démarrage). */
  async count(): Promise<number> {
    if (!existsSync(this.root)) return 0;
    return (await readdir(this.root, { withFileTypes: true })).filter((d) => d.isDirectory()).length;
  }

  async close(): Promise<void> {
    for (const s of this.spaces.values()) await (await s).stop().catch(() => undefined);
  }
}
