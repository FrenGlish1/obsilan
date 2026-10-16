// Fonctions utilitaires sur les chemins de notes, sans dépendance à Node :
// utilisables côté serveur comme côté navigateur.

/** Caractères interdits dans un nom de fichier (Windows + Android + liens Obsidian). */
const FORBIDDEN = /[\\:*?"<>|#^[\]]/;

/** Nom de fichier sans le dossier ni l'extension « .md ». */
export function noteTitle(path: string): string {
  const base = basename(path);
  return base.toLowerCase().endsWith('.md') ? base.slice(0, -3) : base;
}

/** Dernier segment du chemin. */
export function basename(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

/** Dossier parent (« » pour la racine). */
export function dirname(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

/** Assemble des segments en ignorant les segments vides. */
export function joinPath(...parts: string[]): string {
  return parts.filter(Boolean).join('/');
}

/** Vrai si le chemin désigne une note Markdown. */
export function isNote(path: string): boolean {
  return path.toLowerCase().endsWith('.md');
}

/**
 * Normalise un chemin reçu de l'extérieur : remplace « \ » par « / »,
 * retire les « / » en trop et rejette tout ce qui pourrait sortir du coffre
 * ou viser un dossier caché (.obsidian, .trash…).
 * Renvoie null si le chemin est invalide.
 */
export function normalizePath(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const parts = raw.replace(/\\/g, '/').split('/').filter((p) => p !== '' && p !== '.');
  if (parts.length === 0) return null;
  for (const p of parts) {
    if (p === '..' || p.startsWith('.')) return null;
    if (p.length > 200 || FORBIDDEN.test(p)) return null;
    // Caractères de contrôle interdits.
    if (/[\x00-\x1f]/.test(p)) return null;
    // Windows refuse les noms terminés par un espace ou un point.
    if (/[ .]$/.test(p)) return null;
  }
  return parts.join('/');
}

/** Message d'aide expliquant pourquoi un nom est refusé. */
export const INVALID_NAME_HELP =
  'Nom invalide : évitez \\ : * ? " < > | # ^ [ ], les noms commençant par « . » et ceux finissant par un espace ou un point.';

/** Compare deux noms « à la française », avec les nombres dans l'ordre naturel. */
export function compareNames(a: string, b: string): number {
  return a.localeCompare(b, 'fr', { numeric: true, sensitivity: 'base' });
}
