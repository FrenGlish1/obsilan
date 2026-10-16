<script lang="ts">
  // Enveloppe Svelte autour de CodeMirror. Le composant est recréé (via {#key})
  // quand le contenu de la note est remplacé de l'extérieur.
  import { onMount } from 'svelte';
  import { EditorView } from '@codemirror/view';
  import { createEditorState, type EditorCallbacks } from '../editor/setup.ts';
  import { refreshWikiLinks } from '../editor/wikilinks.ts';

  let { initial, callbacks, version = 0, autofocus = false }: {
    initial: string;
    callbacks: EditorCallbacks;
    /** Change quand l'index des notes change : les liens sont réévalués (existant / manquant). */
    version?: number;
    autofocus?: boolean;
  } = $props();

  let host: HTMLDivElement;
  let view: EditorView | undefined;

  onMount(() => {
    view = new EditorView({ parent: host, state: createEditorState(initial, callbacks) });
    if (autofocus) view.focus();
    return () => view?.destroy();
  });

  $effect(() => {
    version;
    view?.dispatch({ effects: refreshWikiLinks.of(null) });
  });
</script>

<div class="editor" bind:this={host}></div>

<style>
  .editor {
    height: 100%;
    min-height: 0;
  }
</style>
