// « Aperçu en direct » façon Obsidian : les symboles Markdown (#, **, `, [](…))
// sont masqués sur toutes les lignes SAUF celles où se trouve le curseur.
// On voit donc le texte mis en forme, et la syntaxe réapparaît dès qu'on
// revient sur la ligne pour la modifier.
import { syntaxTree } from '@codemirror/language';
import type { EditorState, Range } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';

/** Marqueurs masqués hors de la ligne active. */
const HIDDEN_MARKS = new Set(['HeaderMark', 'EmphasisMark', 'CodeMark', 'StrikethroughMark', 'QuoteMark']);

const hide = Decoration.replace({});

/** Numéros des lignes touchées par la sélection (où la syntaxe reste visible). */
function activeLines(state: EditorState): Set<number> {
  const lines = new Set<number>();
  for (const r of state.selection.ranges) {
    const from = state.doc.lineAt(r.from).number;
    const to = state.doc.lineAt(r.to).number;
    for (let l = from; l <= to; l++) lines.add(l);
  }
  return lines;
}

function build(view: EditorView): DecorationSet {
  const { state } = view;
  const active = view.hasFocus ? activeLines(state) : new Set<number>();
  const decos: Range<Decoration>[] = [];
  const isActive = (pos: number) => active.has(state.doc.lineAt(pos).number);

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        const name = node.name;

        // Classe de ligne pour les titres, citations et blocs de code (mise en forme CSS).
        const heading = /^(?:ATX|Setext)Heading(\d)$/.exec(name);
        if (heading) {
          decos.push(Decoration.line({ class: `cm-h cm-h${heading[1]}` }).range(state.doc.lineAt(node.from).from));
        } else if (name === 'Blockquote') {
          for (let pos = node.from; pos <= node.to; ) {
            const line = state.doc.lineAt(pos);
            decos.push(Decoration.line({ class: 'cm-quote' }).range(line.from));
            pos = line.to + 1;
          }
        } else if (name === 'FencedCode') {
          for (let pos = node.from; pos <= node.to; ) {
            const line = state.doc.lineAt(pos);
            decos.push(Decoration.line({ class: 'cm-codeblock' }).range(line.from));
            pos = line.to + 1;
          }
          return false; // On ne masque rien à l'intérieur d'un bloc de code.
        }

        if (isActive(node.from)) return;

        if (HIDDEN_MARKS.has(name)) {
          // Les marques de bloc de code (```) restent visibles.
          if (name === 'CodeMark' && node.node.parent?.name === 'FencedCode') return;
          let end = node.to;
          // « # Titre » / « > citation » : on masque aussi l'espace qui suit.
          if ((name === 'HeaderMark' || name === 'QuoteMark') && state.doc.sliceString(end, end + 1) === ' ') end++;
          if (end > node.from) decos.push(hide.range(node.from, end));
        } else if (name === 'Link') {
          // [texte](url) → seul « texte » reste affiché, stylé comme un lien.
          const cursor = node.node.cursor();
          if (cursor.firstChild()) {
            do {
              if (cursor.name === 'LinkMark' || cursor.name === 'URL' || cursor.name === 'LinkTitle') {
                decos.push(hide.range(cursor.from, cursor.to));
              }
            } while (cursor.nextSibling());
          }
        }
      },
    });
  }
  return Decoration.set(decos, true);
}

export const livePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = build(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.selectionSet || u.viewportChanged || u.focusChanged ||
          syntaxTree(u.state) !== syntaxTree(u.startState)) {
        this.decorations = build(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);
