<script lang="ts">
  // Zone principale : titre de la note (modifiable = renommage), état de
  // sauvegarde, bascule édition/lecture, puis l'éditeur ou le rendu.
  import { tick } from 'svelte';
  import { store } from '../lib/store.svelte.ts';
  import { renderMarkdown } from '../lib/markdown.ts';
  import { dirname, INVALID_NAME_HELP, joinPath, normalizePath, noteTitle } from '../../../shared/paths.ts';
  import Editor from './Editor.svelte';
  import Backlinks from './Backlinks.svelte';

  const note = $derived(store.note!);
  const folder = $derived(dirname(note.path));
  let titleInput: HTMLInputElement;
  let title = $state('');

  // Le champ titre suit la note ouverte (et ses renommages).
  $effect(() => {
    title = noteTitle(note.path);
  });

  // Après « Nouvelle note », on place le curseur dans le titre, texte sélectionné.
  $effect(() => {
    if (store.focusTitle) {
      store.focusTitle = false;
      tick().then(() => {
        titleInput?.focus();
        titleInput?.select();
      });
    }
  });

  async function commitTitle() {
    const name = title.trim();
    const current = noteTitle(note.path);
    if (!name || name === current) {
      title = current;
      return;
    }
    const to = normalizePath(joinPath(folder, name + '.md'));
    if (!to) {
      store.notify(INVALID_NAME_HELP, 'error', 6000);
      title = current;
      return;
    }
    if (!(await store.rename(note.path, to))) title = current;
  }

  function titleKey(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      titleInput.blur();
      // On enchaîne directement sur l'écriture du contenu.
      (document.querySelector('.cm-content') as HTMLElement | null)?.focus();
    } else if (e.key === 'Escape') {
      title = noteTitle(note.path);
      titleInput.blur();
    }
  }

  const statusLabel: Record<string, string> = {
    saved: 'Enregistré',
    dirty: 'Modifié…',
    saving: 'Enregistrement…',
    error: 'Hors ligne — nouvel essai bientôt',
  };

  // Liens et tags dans l'éditeur : résolution via l'index local.
  const editorCallbacks = {
    onChange: (t: string) => store.edit(t),
    exists: (target: string) => store.index.links.resolve(target, store.note?.path ?? '') !== null,
    openLink: (target: string) => store.openLink(target),
    openTag: (tag: string) => store.openTag(tag),
    notePaths: () => store.index.links.paths,
    allTags: () => store.index.links.allTags().map((t) => t.tag),
  };

  const html = $derived.by(() => {
    if (store.mode !== 'read') return '';
    store.indexVersion; // liens existants / manquants à jour
    return renderMarkdown(note.content, editorCallbacks.exists);
  });

  // Mode lecture : clic sur un lien [[…]] ou un tag.
  function readingClick(e: MouseEvent) {
    const a = (e.target as HTMLElement).closest<HTMLAnchorElement>('a.wikilink, a.tag');
    if (!a) return;
    e.preventDefault();
    if (a.dataset.target !== undefined) store.openLink(a.dataset.target);
    else if (a.dataset.tag) store.openTag(a.dataset.tag);
  }
</script>

<header class="note-header">
  <button class="icon only-mobile" title="Afficher les notes" onclick={() => (store.sidebarOpen = !store.sidebarOpen)}>☰</button>
  <div class="title-block">
    {#if folder}<div class="breadcrumb">{folder.split('/').join(' › ')}</div>{/if}
    <input
      class="title"
      bind:this={titleInput}
      bind:value={title}
      onblur={commitTitle}
      onkeydown={titleKey}
      spellcheck="false"
      aria-label="Titre de la note"
    />
  </div>
  <span class="status status-{store.status}" title="État de la sauvegarde">
    <span class="dot"></span>{statusLabel[store.status]}
  </span>
  <button class="icon" title="Basculer édition / lecture (Ctrl+E)" onclick={() => store.toggleMode()}>
    {store.mode === 'edit' ? '👁' : '✎'}
  </button>
</header>

<div class="note-body">
  {#if store.mode === 'edit'}
    {#key note.loadId}
      <Editor initial={note.content} callbacks={editorCallbacks} version={store.indexVersion} />
    {/key}
  {:else}
    <!-- HTML nettoyé par DOMPurify dans renderMarkdown -->
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
    <article class="markdown-body" onclick={readingClick}>{@html html}</article>
  {/if}
</div>
<Backlinks path={note.path} />

<style>
  .note-header {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 16px;
    border-bottom: 1px solid var(--border);
    background: var(--bg);
  }
  .title-block {
    flex: 1;
    min-width: 0;
  }
  .breadcrumb {
    font-size: 12px;
    color: var(--muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .title {
    width: 100%;
    font-size: 20px;
    font-weight: 700;
    border: none;
    background: transparent;
    color: var(--fg);
    padding: 2px 0;
    outline: none;
    border-bottom: 2px solid transparent;
  }
  .title:focus {
    border-bottom-color: var(--accent);
  }
  .status {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--muted);
    white-space: nowrap;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--ok);
  }
  .status-dirty .dot,
  .status-saving .dot {
    background: var(--warn);
  }
  .status-error .dot {
    background: var(--danger);
  }
  .status-error {
    color: var(--danger);
  }
  .note-body {
    flex: 1;
    min-height: 0;
    overflow: auto;
  }
  @media (max-width: 800px) {
    .status {
      font-size: 0;
      gap: 0;
    }
  }
</style>
