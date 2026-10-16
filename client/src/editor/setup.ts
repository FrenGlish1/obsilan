// Configuration de l'éditeur CodeMirror 6.
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView, drawSelection, keymap, placeholder, highlightActiveLine } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { HighlightStyle, syntaxHighlighting, indentUnit } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { livePreview } from './livePreview.ts';
import { wikiLinks, type WikiCallbacks } from './wikilinks.ts';

// Couleurs via variables CSS : le thème clair/sombre s'applique automatiquement.
const mdHighlight = HighlightStyle.define([
  { tag: t.heading, fontWeight: '700', color: 'var(--heading)' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through', color: 'var(--muted)' },
  { tag: t.link, color: 'var(--accent)', textDecoration: 'underline' },
  { tag: t.url, color: 'var(--muted)' },
  { tag: t.monospace, fontFamily: 'var(--mono)', color: 'var(--code-fg)', backgroundColor: 'var(--code-bg)', borderRadius: '3px' },
  { tag: t.quote, color: 'var(--muted)', fontStyle: 'italic' },
  { tag: [t.processingInstruction, t.meta, t.contentSeparator], color: 'var(--faint)' },
  // Coloration du code dans les blocs ```langage
  { tag: t.keyword, color: 'var(--tok-keyword)' },
  { tag: [t.string, t.regexp], color: 'var(--tok-string)' },
  { tag: [t.number, t.bool, t.null], color: 'var(--tok-number)' },
  { tag: t.comment, color: 'var(--faint)', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.typeName, t.className], color: 'var(--tok-func)' },
  { tag: t.propertyName, color: 'var(--tok-prop)' },
]);

const baseTheme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'transparent', color: 'var(--fg)' },
  '.cm-scroller': { fontFamily: 'var(--text-font)', lineHeight: '1.65', overflow: 'auto' },
  '.cm-content': {
    maxWidth: 'var(--line-width)',
    margin: '0 auto',
    padding: '24px 28px 40vh',
    caretColor: 'var(--accent)',
  },
  '.cm-cursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '&.cm-focused': { outline: 'none' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'var(--selection) !important',
  },
  '.cm-activeLine': { backgroundColor: 'var(--active-line)' },
  '.cm-placeholder': { color: 'var(--faint)' },
  '.cm-searchMatch': { backgroundColor: 'var(--search-hit)' },
  '.cm-panels': { backgroundColor: 'var(--bg-alt)', color: 'var(--fg)', borderColor: 'var(--border)' },
});

export interface EditorCallbacks extends WikiCallbacks {
  onChange: (text: string) => void;
}

export function createEditorState(doc: string, cb: EditorCallbacks): EditorState {
  const extensions: Extension[] = [
    history(),
    drawSelection(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    EditorView.lineWrapping,
    indentUnit.of('    '),
    EditorState.tabSize.of(4),
    placeholder('Commencez à écrire…'),
    markdown({ base: markdownLanguage, codeLanguages: languages, addKeymap: true }),
    syntaxHighlighting(mdHighlight),
    livePreview,
    wikiLinks(cb),
    baseTheme,
    keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
    EditorView.contentAttributes.of({ spellcheck: 'true', autocorrect: 'on', autocapitalize: 'sentences', lang: 'fr' }),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) cb.onChange(u.state.doc.toString());
    }),
  ];
  return EditorState.create({ doc, extensions });
}
