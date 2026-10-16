<script lang="ts">
  // Onglet « Tags » : liste de tous les tags (imbriqués avec « / »),
  // puis les notes d'un tag choisi.
  import { store } from '../lib/store.svelte.ts';
  import { dirname, noteTitle } from '../../../shared/paths.ts';

  // Arbre des tags : chaque parent apparaît (même s'il n'est jamais écrit seul)
  // et son compteur inclut les notes de ses sous-tags.
  const tags = $derived.by(() => {
    store.indexVersion;
    const names = new Map<string, string>();
    for (const { tag } of store.index.links.allTags()) {
      const parts = tag.split('/');
      for (let i = 1; i <= parts.length; i++) {
        const prefix = parts.slice(0, i).join('/');
        if (!names.has(prefix.toLowerCase())) names.set(prefix.toLowerCase(), prefix);
      }
    }
    return [...names.values()]
      .sort((a, b) => a.localeCompare(b, 'fr'))
      .map((tag) => ({ tag, count: store.index.links.notesWithTag(tag).length }));
  });
  const notes = $derived.by(() => {
    store.indexVersion;
    return store.selectedTag ? store.index.links.notesWithTag(store.selectedTag) : [];
  });

  /** Profondeur d'un tag imbriqué (#a/b/c → 2) et son dernier segment. */
  const depth = (t: string) => t.split('/').length - 1;
  const leaf = (t: string) => t.slice(t.lastIndexOf('/') + 1);
</script>

<div class="tags-panel">
  {#if store.selectedTag}
    <button class="back" onclick={() => (store.selectedTag = null)}>← Tous les tags</button>
    <h3>#{store.selectedTag} <span class="count">{notes.length}</span></h3>
    <ul>
      {#each notes as p (p)}
        <li>
          <button class="row" class:active={store.note?.path === p} onclick={() => store.open(p)}>
            <span class="name">{noteTitle(p)}</span>
            {#if dirname(p)}<span class="folder">{dirname(p)}</span>{/if}
          </button>
        </li>
      {/each}
    </ul>
    {#if notes.length === 0}<p class="empty">Plus aucune note ne porte ce tag.</p>{/if}
  {:else}
    {#if tags.length === 0}
      <p class="empty">Aucun tag pour l'instant. Écrivez <code>#projet</code> dans une note (ou <code>#projet/web</code> pour un sous-tag).</p>
    {/if}
    <ul>
      {#each tags as t (t.tag)}
        <li>
          <button class="row" style="padding-left: {10 + depth(t.tag) * 14}px" onclick={() => (store.selectedTag = t.tag)}>
            <span class="name">#{depth(t.tag) ? leaf(t.tag) : t.tag}</span>
            <span class="count">{t.count}</span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .tags-panel {
    flex: 1;
    overflow: auto;
    padding: 4px 6px 16px;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 6px 10px;
    border: none;
    border-radius: 6px;
    background: none;
    color: var(--fg-soft);
    font: inherit;
    font-size: 14px;
    text-align: left;
    cursor: pointer;
    flex-wrap: wrap;
  }
  .row:hover,
  .row.active {
    background: var(--hover);
    color: var(--fg);
  }
  .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .folder {
    width: 100%;
    font-size: 11px;
    color: var(--muted);
  }
  .count {
    font-size: 12px;
    color: var(--muted);
    background: var(--hover);
    border-radius: 8px;
    padding: 0 7px;
    font-weight: 400;
  }
  .back {
    border: none;
    background: none;
    color: var(--accent);
    font: inherit;
    font-size: 13px;
    padding: 6px 10px;
    cursor: pointer;
  }
  h3 {
    margin: 4px 10px 8px;
    font-size: 16px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .empty {
    margin: 8px 10px;
    color: var(--muted);
    font-size: 13px;
    line-height: 1.5;
  }
  @media (pointer: coarse) {
    .row {
      min-height: 40px;
    }
  }
</style>
