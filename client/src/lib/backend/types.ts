// Contrat commun aux deux façons d'accéder aux notes :
//   - TauriBackend : fichiers locaux de l'appareil (application .exe / .apk) ;
//   - HttpBackend  : serveur Node via HTTP (développement de l'interface dans un navigateur).
// Le reste de l'interface ne connaît que cette interface.
import type { NoteData, SaveResult, TreeEntry, VaultEvent } from '../../../../shared/types.ts';

/** Contenu brut d'une note, pour construire l'index local. */
export interface NoteContent {
  path: string;
  content: string;
  hash: string;
}

/** Erreur d'accès au coffre. `status` suit les codes HTTP (0 = injoignable). */
export class BackendError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public data: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export interface Backend {
  readonly kind: 'tauri' | 'http';
  /** Toutes les notes, pour construire l'index local (recherche, liens, tags). */
  loadAll(): Promise<NoteContent[]>;
  tree(): Promise<TreeEntry[]>;
  read(path: string): Promise<NoteData>;
  /** Enregistre. Lève une BackendError 409 (data.current) si la note a changé ailleurs. */
  save(path: string, content: string, baseHash?: string): Promise<SaveResult>;
  createNote(opts: { path?: string; folder?: string; content?: string }): Promise<SaveResult>;
  createFolder(opts: { path?: string; parent?: string }): Promise<{ path: string }>;
  rename(from: string, to: string): Promise<void>;
  trash(path: string): Promise<void>;
  /** Abonnement aux changements ; `onStatus` signale la connexion (HTTP). */
  subscribe(onEvent: (e: VaultEvent) => void, onStatus: (ok: boolean) => void): void;
  /** Dernière chance d'enregistrer à la fermeture (navigateur uniquement). */
  saveOnExit?(path: string, content: string, baseHash: string): void;
}
