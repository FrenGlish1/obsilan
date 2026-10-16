// Liens [[…]] et tags #…, avec la même syntaxe qu'Obsidian.
// Code partagé : utilisé par l'application et, plus tard, par le serveur de synchro.
//
//   [[Note]]              lien simple
//   [[Dossier/Note]]      lien avec chemin (utile si deux notes ont le même nom)
//   [[Note|Texte]]        lien avec texte affiché
//   [[Note#Titre]]        lien vers un titre de la note
//   ![[Note]]             intégration (comptée comme un lien)
//   #projet  #projet/web  tags (imbriqués avec « / »)
//   tags: [a, b]          tags dans l'en-tête YAML (frontmatter)
import { basename, dirname, isNote, joinPath, noteTitle } from './paths.ts';

export interface WikiLink {
  /** Cible telle qu'écrite (« Dossier/Note »), sans titre ni alias. */
  target: string;
  heading?: string;
  alias?: string;
  /** Position du lien complet « [[…]] » dans le texte. */
  from: number;
  to: number;
  /** Position de la cible seule (pour la réécrire au renommage). */
  targetFrom: number;
  targetTo: number;
}

export interface TagMatch {
  /** Tag sans « # », tel qu'écrit. */
  tag: string;
  from: number;
  to: number;
}

// --------------------------------------------------------------- analyse

/** Fin de l'en-tête YAML (« --- … --- » en tout début de note), ou 0. */
export function frontmatterEnd(text: string): number {
  if (!text.startsWith('---')) return 0;
  const m = /^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(text);
  return m ? m[0].length : 0;
}

/**
 * Remplace par des espaces le code (blocs ``` / ~~~ et `code en ligne`),
 * en conservant les positions : on n'y cherche ni liens ni tags.
 */
export function maskCode(text: string): string {
  const blank = (s: string) => s.replace(/[^\n]/g, ' ');
  return text
    .replace(/^([ \t]*)(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^\1?\2[ \t]*$|(?![\s\S]))/gm, blank)
    .replace(/(`+)(?!`)[\s\S]*?[^`]\1(?!`)|(`+)[^`\n]\2(?!`)/g, blank);
}

const LINK_RE = /!?\[\[([^\[\]\n]+?)\]\]/g;

/** Tous les liens [[…]] d'une note (hors code et en-tête YAML). */
export function parseLinks(text: string): WikiLink[] {
  const masked = maskCode(text);
  const start = frontmatterEnd(text);
  const out: WikiLink[] = [];
  for (const m of masked.matchAll(LINK_RE)) {
    if (m.index! < start) continue;
    const inner = m[1];
    const innerFrom = m.index! + m[0].indexOf('[[') + 2;
    const bar = inner.indexOf('|');
    const ref = bar === -1 ? inner : inner.slice(0, bar);
    const alias = bar === -1 ? undefined : inner.slice(bar + 1).trim() || undefined;
    const hash = ref.search(/[#^]/);
    const rawTarget = hash === -1 ? ref : ref.slice(0, hash);
    const heading = hash === -1 ? undefined : ref.slice(hash + 1).trim() || undefined;
    const lead = rawTarget.length - rawTarget.trimStart().length;
    const target = rawTarget.trim();
    out.push({
      target,
      heading,
      alias,
      from: m.index!,
      to: m.index! + m[0].length,
      targetFrom: innerFrom + lead,
      targetTo: innerFrom + lead + target.length,
    });
  }
  return out;
}

const TAG_RE = /(^|[\s(,;])#([\p{L}\p{N}_\-/]+)/gu;

/** Tous les tags #… du texte (hors code), positions comprises. */
export function parseTagMatches(text: string): TagMatch[] {
  const masked = maskCode(text);
  const start = frontmatterEnd(text);
  const out: TagMatch[] = [];
  for (const m of masked.matchAll(TAG_RE)) {
    const from = m.index! + m[1].length;
    if (from < start) continue;
    const tag = m[2].replace(/\/+$/, '');
    // « #123 » n'est pas un tag (comme dans Obsidian) ; il faut au moins un caractère non numérique.
    if (!tag || /^[\p{N}/]+$/u.test(tag)) continue;
    out.push({ tag, from, to: from + 1 + tag.length });
  }
  return out;
}

/** Tags de l'en-tête YAML : « tags: [a, b] », « tags: a, b » ou liste « - a ». */
export function parseFrontmatterTags(text: string): string[] {
  const end = frontmatterEnd(text);
  if (!end) return [];
  const yaml = text.slice(0, end);
  const m = /^(?:tags|tag)[ \t]*:[ \t]*(.*)$/m.exec(yaml);
  if (!m) return [];
  let items: string[];
  if (m[1].trim()) {
    items = m[1].replace(/^\[|\]$/g, '').split(/[,\s]+/);
  } else {
    // Liste YAML sur les lignes suivantes.
    items = [];
    for (const line of yaml.slice(m.index + m[0].length).split(/\r?\n/).slice(1)) {
      const li = /^[ \t]*-[ \t]+(.+)$/.exec(line);
      if (!li) break;
      items.push(li[1]);
    }
  }
  return items.map((t) => t.trim().replace(/^["']|["']$/g, '').replace(/^#/, '')).filter(Boolean);
}

/** Liste des tags d'une note (sans doublon, casse d'origine). */
export function parseTags(text: string): string[] {
  const seen = new Map<string, string>();
  for (const t of [...parseFrontmatterTags(text), ...parseTagMatches(text).map((m) => m.tag)]) {
    if (!seen.has(t.toLowerCase())) seen.set(t.toLowerCase(), t);
  }
  return [...seen.values()];
}

// --------------------------------------------------------------- résolution

const key = (s: string) => s.normalize('NFC').toLowerCase();
const stripMd = (p: string) => (isNote(p) ? p.slice(0, -3) : p);

export type Resolver = (target: string, sourcePath: string) => string | null;

/**
 * Prépare la résolution des liens pour un ensemble de notes (tables de
 * correspondance construites une fois : rapide même avec des milliers de notes).
 *
 * Règles, comme dans Obsidian :
 *   1. chemin exact (« Dossier/Note ») ;
 *   2. sinon, note portant ce nom n'importe où ; en cas d'homonymes,
 *      on préfère celle du dossier de la note source, puis le chemin le plus court.
 * Le résolveur renvoie null si aucune note ne correspond (lien « non résolu »).
 */
export function makeResolver(paths: Iterable<string>): Resolver {
  const byPath = new Map<string, string>();
  const byTitle = new Map<string, string[]>();
  for (const p of paths) {
    byPath.set(key(stripMd(p)), p);
    const t = key(noteTitle(p));
    const list = byTitle.get(t);
    if (list) list.push(p);
    else byTitle.set(t, [p]);
  }
  return (target, sourcePath) => {
    const t = key(stripMd(target.replace(/\\/g, '/').replace(/^\/+/, '')));
    if (!t) return null;
    const exact = byPath.get(t);
    if (exact) return exact;
    const title = t.slice(t.lastIndexOf('/') + 1);
    let candidates = byTitle.get(title) ?? [];
    if (t.includes('/')) candidates = candidates.filter((p) => key(stripMd(p)).endsWith('/' + t));
    if (candidates.length <= 1) return candidates[0] ?? null;
    const dir = dirname(sourcePath);
    const same = candidates.find((p) => dirname(p) === dir);
    if (same) return same;
    return [...candidates].sort(
      (a, b) => a.split('/').length - b.split('/').length || a.length - b.length || a.localeCompare(b),
    )[0];
  };
}

/** Résout un seul lien (pour des appels ponctuels ; sinon utiliser makeResolver). */
export function resolveLink(target: string, sourcePath: string, paths: Iterable<string>): string | null {
  return makeResolver(paths)(target, sourcePath);
}

/**
 * Texte de lien le plus court possible pour viser `path` :
 * le nom seul s'il est unique, sinon le chemin complet (sans .md).
 */
export function linkTextFor(path: string, paths: Iterable<string>, preferPath = false): string {
  const title = noteTitle(path);
  if (!preferPath) {
    let same = 0;
    for (const p of paths) if (key(noteTitle(p)) === key(title)) same++;
    if (same <= 1) return title;
  }
  return stripMd(path);
}

/** Chemin de la note à créer quand on suit un lien vers une note inexistante. */
export function newNotePathForLink(target: string, sourcePath: string): string {
  const t = stripMd(target.replace(/\\/g, '/').replace(/^\/+/, '').trim());
  // « [[Dossier/Note]] » : chemin depuis la racine ; « [[Note]] » : à côté de la note source.
  return (t.includes('/') ? t : joinPath(dirname(sourcePath), t)) + '.md';
}

// --------------------------------------------------------------- renommage

/**
 * Réécrit les liens d'une note après un renommage/déplacement.
 * `moves` associe ancien chemin → nouveau chemin pour chaque note déplacée.
 * `oldPaths` / `newPaths` : toutes les notes avant / après le renommage.
 * Renvoie le nouveau texte et le nombre de liens modifiés.
 */
export function rewriteLinks(
  text: string,
  sourceOld: string,
  sourceNew: string,
  moves: Map<string, string>,
  oldPaths: string[],
  newPaths: string[],
): { text: string; changed: number } {
  const resolveOld = makeResolver(oldPaths);
  const resolveNew = makeResolver(newPaths);
  let out = '';
  let last = 0;
  let changed = 0;
  for (const link of parseLinks(text)) {
    const resolved = resolveOld(link.target, sourceOld);
    if (!resolved || !moves.has(resolved)) continue;
    const dest = moves.get(resolved)!;
    // On garde le style d'origine : chemin complet si l'utilisateur en avait écrit un.
    let replacement = linkTextFor(dest, newPaths, link.target.includes('/'));
    // Vérifie que le nouveau texte vise bien la bonne note depuis la note source.
    if (resolveNew(replacement, sourceNew) !== dest) replacement = stripMd(dest);
    if (replacement === link.target) continue;
    out += text.slice(last, link.targetFrom) + replacement;
    last = link.targetTo;
    changed++;
  }
  return { text: out + text.slice(last), changed };
}

// --------------------------------------------------------------- index

export interface Backlink {
  /** Note qui contient le lien. */
  source: string;
  /** Lignes contenant le lien (contexte affiché). */
  lines: string[];
}

/**
 * Index des liens et tags de toutes les notes, mis à jour note par note.
 * La résolution des liens est faite à la demande (elle dépend de l'ensemble des notes).
 */
export class LinkIndex {
  private links = new Map<string, WikiLink[]>();
  private tags = new Map<string, string[]>();
  private texts = new Map<string, string>();
  /** Résolveur en cache, invalidé quand la liste des notes change. */
  private cached: Resolver | null = null;

  private get resolver(): Resolver {
    return (this.cached ??= makeResolver(this.links.keys()));
  }

  get paths(): string[] {
    return [...this.links.keys()];
  }

  has(path: string): boolean {
    return this.links.has(path);
  }

  set(path: string, content: string): void {
    if (!this.links.has(path)) this.cached = null;
    this.links.set(path, parseLinks(content));
    this.tags.set(path, parseTags(content));
    this.texts.set(path, content);
  }

  remove(path: string): void {
    if (this.links.has(path)) this.cached = null;
    this.links.delete(path);
    this.tags.delete(path);
    this.texts.delete(path);
  }

  removeFolder(folder: string): void {
    for (const p of this.paths) if (p.startsWith(folder + '/')) this.remove(p);
  }

  move(from: string, to: string): void {
    const text = this.texts.get(from);
    if (text === undefined) return;
    this.remove(from);
    this.set(to, text);
  }

  moveFolder(from: string, to: string): void {
    for (const p of this.paths) if (p.startsWith(from + '/')) this.move(p, to + p.slice(from.length));
  }

  content(path: string): string | undefined {
    return this.texts.get(path);
  }

  linksOf(path: string): WikiLink[] {
    return this.links.get(path) ?? [];
  }

  resolve(target: string, source: string): string | null {
    return this.resolver(target, source);
  }

  /** Notes qui contiennent un lien vers `path`, avec les lignes concernées. */
  backlinks(path: string): Backlink[] {
    const resolve = this.resolver;
    const out: Backlink[] = [];
    for (const [source, links] of this.links) {
      if (source === path) continue;
      const hits = links.filter((l) => resolve(l.target, source) === path);
      if (!hits.length) continue;
      const text = this.texts.get(source) ?? '';
      const lines = [...new Set(hits.map((l) => lineAround(text, l.from)))];
      out.push({ source, lines });
    }
    return out.sort((a, b) => a.source.localeCompare(b.source, 'fr'));
  }

  /** Notes dont au moins un lien vise une des notes de `targets`. */
  sourcesLinkingTo(targets: Set<string>): string[] {
    const resolve = this.resolver;
    const out: string[] = [];
    for (const [source, links] of this.links) {
      if (links.some((l) => targets.has(resolve(l.target, source) ?? ''))) out.push(source);
    }
    return out;
  }

  tagsOf(path: string): string[] {
    return this.tags.get(path) ?? [];
  }

  /** Tous les tags avec le nombre de notes (casse de la première occurrence). */
  allTags(): { tag: string; count: number }[] {
    const counts = new Map<string, { tag: string; count: number }>();
    for (const tags of this.tags.values()) {
      for (const t of tags) {
        const k = t.toLowerCase();
        const c = counts.get(k);
        if (c) c.count++;
        else counts.set(k, { tag: t, count: 1 });
      }
    }
    return [...counts.values()].sort((a, b) => a.tag.localeCompare(b.tag, 'fr'));
  }

  /** Notes portant le tag (ou un sous-tag : #projet inclut #projet/web). */
  notesWithTag(tag: string): string[] {
    const k = tag.toLowerCase();
    const out: string[] = [];
    for (const [path, tags] of this.tags) {
      if (tags.some((t) => t.toLowerCase() === k || t.toLowerCase().startsWith(k + '/'))) out.push(path);
    }
    return out.sort((a, b) => basename(a).localeCompare(basename(b), 'fr'));
  }
}

/** Ligne de texte contenant la position `pos`, nettoyée. */
function lineAround(text: string, pos: number): string {
  const start = text.lastIndexOf('\n', pos - 1) + 1;
  const end = text.indexOf('\n', pos);
  return text.slice(start, end === -1 ? undefined : end).trim().slice(0, 200);
}
