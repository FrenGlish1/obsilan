// Index local de tout le coffre : recherche plein texte + liens + tags.
// Construit au démarrage, puis mis à jour note par note (indexation incrémentale).
import { NoteIndex } from '../../../shared/search.ts';
import { LinkIndex } from '../../../shared/links.ts';
import type { SearchHit } from '../../../shared/types.ts';

export class VaultIndex {
  readonly search = new NoteIndex();
  readonly links = new LinkIndex();
  /** Appelé après chaque changement (déclenche la synchro). */
  onChange: (() => void) | null = null;

  hashOf(path: string): string | undefined {
    return this.search.hashOf(path);
  }

  upsert(path: string, content: string, hash: string): void {
    if (this.search.hashOf(path) === hash && this.links.has(path)) return;
    this.search.upsert(path, content, hash);
    this.links.set(path, content);
    this.onChange?.();
  }

  remove(path: string): void {
    this.search.remove(path);
    this.links.remove(path);
    // Dossier : on retire tout son contenu.
    this.search.removeFolder(path);
    this.links.removeFolder(path);
    this.onChange?.();
  }

  /** Note ou dossier renommé : l'index suit sans relire le disque. */
  move(from: string, to: string): void {
    this.search.move(from, to);
    this.search.moveFolder(from, to);
    this.links.move(from, to);
    this.links.moveFolder(from, to);
    this.onChange?.();
  }

  query(q: string): SearchHit[] {
    return this.search.search(q.slice(0, 200));
  }
}
