// Index de recherche plein texte, tenu en mémoire et mis à jour note par note
// (indexation incrémentale) : une modification ne réindexe que la note concernée.
// Utilisé par le serveur ET par l'application (recherche locale, hors ligne).
import MiniSearch from 'minisearch';
import type { SearchHit } from './types.ts';
import { noteTitle } from './paths.ts';

/** Minuscules + suppression des accents : « Été » trouve « ete » et inversement. */
export function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
}

interface IndexedNote {
  path: string;
  title: string;
  content: string;
  hash: string;
}

export class NoteIndex {
  /** Contenu de chaque note, conservé pour construire les extraits. */
  private notes = new Map<string, IndexedNote>();

  private ms = new MiniSearch<IndexedNote>({
    idField: 'path',
    fields: ['title', 'content'],
    storeFields: ['title'],
    processTerm: (term) => {
      const t = fold(term);
      return t.length > 0 ? t : null;
    },
    searchOptions: {
      boost: { title: 3 },
      prefix: true,
      fuzzy: (term) => (term.length > 4 ? 0.2 : 0),
      combineWith: 'AND',
    },
  });

  get size(): number {
    return this.notes.size;
  }

  hashOf(path: string): string | undefined {
    return this.notes.get(path)?.hash;
  }

  /** Ajoute ou remplace une note. Ne fait rien si son contenu n'a pas changé. */
  upsert(path: string, content: string, hash: string): boolean {
    const prev = this.notes.get(path);
    if (prev && prev.hash === hash) return false;
    const doc: IndexedNote = { path, title: noteTitle(path), content: content.normalize('NFC'), hash };
    if (prev) this.ms.discard(path);
    this.ms.add(doc);
    this.notes.set(path, doc);
    return true;
  }

  remove(path: string): boolean {
    if (!this.notes.has(path)) return false;
    this.ms.discard(path);
    this.notes.delete(path);
    return true;
  }

  /** Retire toutes les notes d'un dossier (dossier supprimé ou renommé). */
  removeFolder(folder: string): string[] {
    const prefix = folder + '/';
    const removed = [...this.notes.keys()].filter((p) => p.startsWith(prefix));
    for (const p of removed) this.remove(p);
    return removed;
  }

  /** Déplace toutes les notes d'un dossier renommé, sans relire le disque. */
  moveFolder(from: string, to: string): void {
    const prefix = from + '/';
    for (const p of [...this.notes.keys()]) {
      if (p.startsWith(prefix)) this.move(p, to + p.slice(from.length));
    }
  }

  /** Déplace une note dans l'index sans relire le disque. */
  move(from: string, to: string): void {
    const n = this.notes.get(from);
    if (!n) return;
    this.remove(from);
    this.upsert(to, n.content, n.hash);
  }

  search(query: string, limit = 50): SearchHit[] {
    const q = query.trim();
    if (!q) return [];
    const results = this.ms.search(q).slice(0, limit);
    const terms = q.split(/\s+/).map(fold).filter(Boolean);
    return results.map((r) => {
      const note = this.notes.get(r.id as string)!;
      return { path: note.path, title: note.title, score: r.score, snippet: makeSnippet(note.content, terms) };
    });
  }
}

/** Extrait d'environ 160 caractères autour de la première occurrence d'un terme. */
function makeSnippet(content: string, terms: string[]): string {
  const folded = fold(content);
  let pos = -1;
  for (const t of terms) {
    const i = folded.indexOf(t);
    if (i !== -1 && (pos === -1 || i < pos)) pos = i;
  }
  // « fold » conserve normalement la longueur d'un texte NFC ; sinon on se rabat sur le début.
  if (folded.length !== content.length) pos = -1;
  const start = Math.max(0, pos === -1 ? 0 : pos - 60);
  const raw = content.slice(start, start + 160).replace(/\s+/g, ' ').trim();
  return (start > 0 ? '…' : '') + raw + (start + 160 < content.length ? '…' : '');
}
