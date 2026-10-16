// Types partagés entre le serveur et le client.
// Toute la communication passe par ces structures : les modifier ici
// garantit que les deux côtés restent cohérents.

/** Une entrée de l'arborescence du coffre (note ou dossier). */
export interface TreeEntry {
  /** Chemin relatif au coffre, toujours avec des « / » (ex. « Projets/Idées.md »). */
  path: string;
  type: 'file' | 'folder';
  /** Date de dernière modification (ms depuis l'époque Unix). Absente pour les dossiers. */
  mtime?: number;
  size?: number;
}

/** Contenu complet d'une note. */
export interface NoteData {
  path: string;
  content: string;
  mtime: number;
  /** Empreinte du contenu : sert à détecter qu'une note a changé entre-temps. */
  hash: string;
}

/** Réponse à une sauvegarde réussie. */
export interface SaveResult {
  path: string;
  mtime: number;
  hash: string;
}

/** Réponse 409 : la note a été modifiée ailleurs depuis notre dernière lecture. */
export interface ConflictResponse {
  error: 'conflict';
  current: NoteData;
}

/** Un résultat de recherche plein texte. */
export interface SearchHit {
  path: string;
  title: string;
  score: number;
  /** Extrait de texte autour de la première occurrence trouvée. */
  snippet: string;
}

/** Erreur renvoyée par l'API. */
export interface ApiError {
  error: string;
  message: string;
}

/**
 * Événements de changement du coffre, poussés vers l'interface :
 *  - tree    : l'arborescence a changé (à recharger) ;
 *  - note    : une note a été créée ou modifiée (nouvelle empreinte) ;
 *  - removed : une note ou un dossier a disparu.
 */
export type VaultEvent =
  | { type: 'tree' }
  | { type: 'note'; path: string; hash: string }
  | { type: 'removed'; path: string };
