<script lang="ts">
  // Panneau « Rétroliens » sous la note : quelles notes pointent vers celle-ci,
  // avec la ligne où apparaît le lien. Plus les tags de la note.
  import { store } from '../lib/store.svelte.ts';
  import { dirname, noteTitle } from '../../../shared/paths.ts';

  let { path }: { path: string } = $props();

  // Recalculé à chaque changement de l'index (sauvegarde, renommage, modification externe).
  const backlinks = $derived.by(() => {
    store.indexVersion;
    return store.index.links.backlinks(path);
  });
  const tags = $derived.by(() => {
    store.indexVersion;
    return store.index.links.tagsOf(path);
  });

  /** Remplace [[cible|alias]] par le texte affiché, pour un contexte lisible. */
  const clean = (line: string) =>
    line.replace(/!?\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2').replace(/!?\[\[([^\]]+)\]\]/g, '$1');
</script>

<section class="backlinks" class:closed={!store.backlinksOpen}>
  <button class="head" onclick={() => store.toggleBacklinks()} aria-expanded={store.backlinksOpen}>
    <span class="chev">{store.backlinksOpen ? '▾' : '▸'}</span>
    Rétroliens <span class="count">{backlinks.length}</span>
    {#if tags.length}
      <span class="tags">
        {#each tags as t (t)}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <span class="tag" role="link" tabindex="-1" onclick={(e) => { e.stopPropagation(); store.openTag(t); }}>#{t}</span>
        {/each}
      </span>
    {/if}
  </button>

  {#if store.backlinksOpen}
    <div class="list">
      {#if backlinks.length === 0}
        <p class="empty">Aucune note ne pointe vers celle-ci. Écrivez <code>[[{noteTitle(path)}]]</code> dans une autre note.</p>
      {/if}
      {#each backlinks as b (b.source)}
        <button class="item" onclick={() => store.open(b.source)}>
          <span class="title">{noteTitle(b.source)}</span>
          {#if dirname(b.source)}<span class="folder">{dirname(b.source)}</span>{/if}
          {#each b.lines as line}
            <span class="line">{clean(line)}</span>
          {/each}
        </button>
      {/each}
    </div>
  {/if}
</section>

<style>
  .backlinks {
    border-top: 1px solid var(--border);
    background: var(--bg-alt);
    max-height: 38%;
    display: flex;
    flex-direction: column;
    flex: none;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 8px 16px;
    border: none;
    background: none;
    color: var(--fg-soft);
    font: inherit;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    text-align: left;
  }
  .chev {
    color: var(--muted);
    width: 12px;
  }
  .count {
    font-weight: 400;
    color: var(--muted);
    background: var(--hover);
    border-radius: 8px;
    padding: 0 7px;
  }
  .tags {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-left: auto;
    overflow: hidden;
  }
  .tag {
    font-weight: 400;
    color: var(--accent);
    background: var(--accent-soft);
    border-radius: 10px;
    padding: 0 8px;
    cursor: pointer;
  }
  .list {
    overflow: auto;
    padding: 0 10px 10px;
  }
  .empty {
    margin: 4px 8px 8px;
    color: var(--muted);
    font-size: 13px;
  }
  .item {
    display: flex;
    flex-direction: column;
    gap: 2px;
    width: 100%;
    padding: 8px;
    border: none;
    border-radius: 6px;
    background: none;
    color: var(--fg);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .item:hover {
    background: var(--hover);
  }
  .title {
    font-weight: 600;
    font-size: 14px;
  }
  .folder {
    font-size: 11px;
    color: var(--muted);
  }
  .line {
    font-size: 12px;
    color: var(--fg-soft);
    border-left: 2px solid var(--border);
    padding-left: 8px;
    margin-top: 2px;
  }
</style>
