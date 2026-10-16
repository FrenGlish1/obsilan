// Rendu Markdown → HTML pour le mode lecture.
// Le HTML produit est toujours nettoyé (DOMPurify) : une note ne peut pas
// exécuter de script, même si elle contient du HTML malveillant.
// Extensions : liens [[…]] et tags #…, comme dans Obsidian.
import { Marked, type TokenizerAndRendererExtension } from 'marked';
import DOMPurify from 'dompurify';

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Les liens externes s'ouvrent dans un nouvel onglet / le navigateur.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A' && /^https?:/i.test(node.getAttribute('href') ?? '')) {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

/** Construit le moteur de rendu ; `exists` dit si une cible de lien existe. */
function makeMarked(exists: (target: string) => boolean): Marked {
  const wikilink: TokenizerAndRendererExtension = {
    name: 'wikilink',
    level: 'inline',
    start: (src) => src.match(/!?\[\[/)?.index,
    tokenizer(src) {
      const m = /^!?\[\[([^\[\]\n]+?)\]\]/.exec(src);
      if (!m) return undefined;
      const [ref, alias] = m[1].split(/\|(.*)/s);
      const target = ref.split(/[#^]/)[0].trim();
      return { type: 'wikilink', raw: m[0], target, text: (alias ?? ref).trim() };
    },
    renderer(token) {
      const missing = !exists(token.target);
      return `<a href="#" class="wikilink${missing ? ' missing' : ''}" data-target="${esc(token.target)}">${esc(token.text)}</a>`;
    },
  };

  const tag: TokenizerAndRendererExtension = {
    name: 'tag',
    level: 'inline',
    // Un tag commence après un espace (ou en début de texte), jamais au milieu d'un mot.
    start: (src) => {
      const m = /(^|[\s(,;])#[\p{L}\p{N}_\-/]/u.exec(src);
      return m ? m.index + m[1].length : undefined;
    },
    tokenizer(src) {
      const m = /^#([\p{L}\p{N}_\-/]+)/u.exec(src);
      if (!m) return undefined;
      const name = m[1].replace(/\/+$/, '');
      if (!name || /^[\p{N}/]+$/u.test(name)) return undefined;
      return { type: 'tag', raw: '#' + name, tag: name };
    },
    renderer(token) {
      return `<a href="#" class="tag" data-tag="${esc(token.tag)}">#${esc(token.tag)}</a>`;
    },
  };

  return new Marked({ gfm: true, breaks: false, extensions: [wikilink, tag] });
}

export function renderMarkdown(source: string, exists: (target: string) => boolean = () => true): string {
  // L'en-tête YAML n'est pas affiché en mode lecture.
  const body = source.replace(/^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/, '');
  return DOMPurify.sanitize(makeMarked(exists).parse(body, { async: false }) as string);
}
