// Liens [[…]] et tags #… dans l'éditeur :
//   - mise en forme (lien, lien vers une note inexistante, pastille de tag) ;
//   - hors de la ligne active, « [[ ]] » et la cible d'un alias sont masqués ;
//   - clic sur un lien → ouvre la note (Ctrl+clic si le curseur est sur la ligne) ;
//   - auto-complétion des noms de notes après « [[ » et des tags après « # ».
import { StateEffect, type Range } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import { autocompletion, type Completion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { linkTextFor, parseLinks, parseTagMatches, type TagMatch, type WikiLink } from '../../../shared/links.ts';
import { dirname, noteTitle } from '../../../shared/paths.ts';

export interface WikiCallbacks {
  /** Vrai si la cible correspond à une note existante. */
  exists: (target: string) => boolean;
  openLink: (target: string) => void;
  openTag: (tag: string) => void;
  /** Chemins de toutes les notes (auto-complétion). */
  notePaths: () => string[];
  /** Tous les tags connus (auto-complétion). */
  allTags: () => string[];
}

/** Demande de recalcul (ex. : une note vient d'être créée, un lien devient valide). */
export const refreshWikiLinks = StateEffect.define<null>();

const hide = Decoration.replace({});

function activeLines(view: EditorView): Set<number> {
  const lines = new Set<number>();
  if (!view.hasFocus) return lines;
  for (const r of view.state.selection.ranges) {
    const a = view.state.doc.lineAt(r.from).number;
    const b = view.state.doc.lineAt(r.to).number;
    for (let l = a; l <= b; l++) lines.add(l);
  }
  return lines;
}

export function wikiLinks(cb: WikiCallbacks) {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      links: WikiLink[] = [];
      tags: TagMatch[] = [];

      constructor(view: EditorView) {
        this.parse(view);
        this.decorations = this.build(view);
      }

      parse(view: EditorView) {
        const text = view.state.doc.toString();
        this.links = parseLinks(text);
        this.tags = parseTagMatches(text);
      }

      update(u: ViewUpdate) {
        if (u.docChanged) this.parse(u.view);
        const refresh = u.transactions.some((t) => t.effects.some((e) => e.is(refreshWikiLinks)));
        if (u.docChanged || u.selectionSet || u.viewportChanged || u.focusChanged || refresh) {
          this.decorations = this.build(u.view);
        }
      }

      build(view: EditorView): DecorationSet {
        const { doc } = view.state;
        const active = activeLines(view);
        const decos: Range<Decoration>[] = [];
        const visible = (from: number, to: number) => view.visibleRanges.some((r) => to >= r.from && from <= r.to);

        for (const l of this.links) {
          if (!visible(l.from, l.to)) continue;
          const missing = !cb.exists(l.target);
          const mark = Decoration.mark({
            class: missing ? 'cm-wikilink cm-wikilink-missing' : 'cm-wikilink',
            attributes: { 'data-target': l.target, title: missing ? `${l.target} (sera créée au clic)` : l.target },
          });
          const embed = doc.sliceString(l.from, l.from + 1) === '!';
          const open = l.from + (embed ? 3 : 2); // après « [[ »
          const close = l.to - 2; // avant « ]] »
          if (active.has(doc.lineAt(l.from).number)) {
            decos.push(mark.range(l.from, l.to));
            continue;
          }
          // Hors ligne active : seul le texte affiché reste visible.
          const textFrom = l.alias ? doc.sliceString(open, close).indexOf('|') + open + 1 : open;
          decos.push(hide.range(l.from, textFrom));
          if (close > textFrom) decos.push(mark.range(textFrom, close));
          decos.push(hide.range(close, l.to));
        }

        for (const t of this.tags) {
          if (!visible(t.from, t.to)) continue;
          decos.push(
            Decoration.mark({ class: 'cm-tag', attributes: { 'data-tag': t.tag, title: `Notes avec #${t.tag}` } }).range(t.from, t.to),
          );
        }
        return Decoration.set(decos, true);
      }
    },
    { decorations: (v) => v.decorations },
  );

  // Clic sur un lien ou un tag.
  const clicks = EditorView.domEventHandlers({
    mousedown(e, view) {
      const el = (e.target as HTMLElement).closest<HTMLElement>('.cm-wikilink, .cm-tag');
      if (!el || e.button !== 0) return false;
      const pos = view.posAtDOM(el);
      const onActiveLine = activeLines(view).has(view.state.doc.lineAt(pos).number);
      // Sur la ligne en cours d'édition, un simple clic place le curseur ; Ctrl+clic ouvre.
      if (onActiveLine && !(e.ctrlKey || e.metaKey)) return false;
      e.preventDefault();
      if (el.dataset.target !== undefined) cb.openLink(el.dataset.target);
      else if (el.dataset.tag) cb.openTag(el.dataset.tag);
      return true;
    },
  });

  // Auto-complétion après « [[ » : noms des notes.
  const linkSource = (ctx: CompletionContext): CompletionResult | null => {
    const m = ctx.matchBefore(/!?\[\[[^\[\]\n|#]*$/);
    if (!m) return null;
    const from = m.from + m.text.indexOf('[[') + 2;
    const paths = cb.notePaths();
    const options: Completion[] = paths.map((p) => {
      const text = linkTextFor(p, paths);
      return {
        label: noteTitle(p),
        detail: dirname(p) || undefined,
        type: 'text',
        apply: (view, _c, a, b) => {
          // Ferme le lien si « ]] » n'est pas déjà là.
          const after = view.state.doc.sliceString(b, b + 2);
          const insert = after === ']]' ? text : text + ']]';
          view.dispatch({
            changes: { from: a, to: b, insert },
            selection: { anchor: a + text.length + 2 },
          });
        },
      };
    });
    return { from, options, validFor: /^[^\[\]\n|#]*$/ };
  };

  // Auto-complétion après « # » : tags existants.
  const tagSource = (ctx: CompletionContext): CompletionResult | null => {
    const m = ctx.matchBefore(/(?:^|[\s(,;])#[\p{L}\p{N}_\-/]*$/u);
    if (!m) return null;
    const hash = m.from + m.text.lastIndexOf('#');
    const tags = cb.allTags();
    if (!tags.length) return null;
    return {
      from: hash + 1,
      options: tags.map((t) => ({ label: t, type: 'keyword' })),
      validFor: /^[\p{L}\p{N}_\-/]*$/u,
    };
  };

  return [plugin, clicks, autocompletion({ override: [linkSource, tagSource], icons: false })];
}
