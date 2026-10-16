// Accès aux notes stockées localement sur l'appareil (application Tauri).
// Les opérations sur les fichiers sont faites en Rust (src-tauri/src/vault.rs) ;
// la recherche et les liens sont gérés par l'index local de l'interface (vaultIndex.ts).
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { NoteData, SaveResult, TreeEntry, VaultEvent } from '../../../../shared/types.ts';
import { INVALID_NAME_HELP, normalizePath } from '../../../../shared/paths.ts';
import { BackendError, type Backend, type NoteContent } from './types.ts';

/** Forme des erreurs renvoyées par les commandes Rust. */
interface RustError {
  status: number;
  code: string;
  message: string;
  current?: NoteData;
}

/** Appelle une commande Rust en convertissant ses erreurs en BackendError. */
async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (err) {
    const e = err as RustError | string;
    if (typeof e === 'string') throw new BackendError(500, 'error', e);
    throw new BackendError(e.status, e.code, e.message, e.current ? { current: e.current } : {});
  }
}

/** Valide un chemin avant de l'envoyer au Rust (qui revérifie de son côté). */
function check(path: string | undefined): string | undefined {
  if (path === undefined || path === '') return undefined;
  const p = normalizePath(path);
  if (!p) throw new BackendError(400, 'bad_path', INVALID_NAME_HELP);
  return p;
}

/** Gestion du dossier du coffre (choix au premier lancement). */
export const vaultConfig = {
  /** Dossier enregistré, ou null au premier lancement. */
  current: () => call<string | null>('vault_root'),
  /** Dossier proposé par défaut (Documents/ObsiLan). */
  suggested: () => call<string>('vault_default_root'),
  /** Stockage privé de l'application (Android, si l'accès aux fichiers est refusé). */
  privateRoot: () => call<string>('vault_private_root'),
  /** Ouvre (et crée si besoin) le coffre, puis le mémorise. */
  open: (root: string) => call<string>('vault_open', { root }),
  /** Vrai sur Android/iOS. */
  isMobile: () => call<boolean>('is_mobile'),
};

export class TauriBackend implements Backend {
  readonly kind = 'tauri' as const;

  loadAll(): Promise<NoteContent[]> {
    return call<NoteContent[]>('vault_load_all');
  }

  tree(): Promise<TreeEntry[]> {
    return call<TreeEntry[]>('vault_tree');
  }

  read(path: string): Promise<NoteData> {
    return call<NoteData>('note_read', { path: check(path) });
  }

  save(path: string, content: string, baseHash?: string): Promise<SaveResult> {
    return call<SaveResult>('note_save', { path: check(path), content, baseHash: baseHash ?? null });
  }

  createNote(opts: { path?: string; folder?: string; content?: string }): Promise<SaveResult> {
    return call<SaveResult>('note_create', {
      path: check(opts.path) ?? null,
      folder: check(opts.folder) ?? null,
      content: opts.content ?? '',
    });
  }

  createFolder(opts: { path?: string; parent?: string }): Promise<{ path: string }> {
    return call<{ path: string }>('folder_create', {
      path: check(opts.path) ?? null,
      parent: check(opts.parent) ?? null,
    });
  }

  async rename(from: string, to: string): Promise<void> {
    await call('entry_rename', { from: check(from), to: check(to) });
  }

  async trash(path: string): Promise<void> {
    await call('entry_trash', { path: check(path) });
  }

  subscribe(onEvent: (e: VaultEvent) => void, onStatus: (ok: boolean) => void): void {
    onStatus(true); // Les fichiers locaux sont toujours « connectés ».
    // Modifications externes (Obsidian, gestionnaire de fichiers, future synchro).
    listen<VaultEvent>('vault-event', ({ payload }) => onEvent(payload));
  }
}
