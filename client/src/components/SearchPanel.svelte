<script lang="ts">
  // Recherche plein texte dans toutes les notes (accents et casse ignorés).
  import { onMount } from 'svelte';
  import { store } from '../lib/store.svelte.ts';
  import { highlightParts } from '../lib/highlight.ts';
  import { dirname } from '../../../shared/paths.ts';
  import type { SearchHit } from '../../../shared/types.ts';

  let input: HTMLInputElement;
  let hits = $state<SearchHit[]>([]);
  let searching = $state(false);
  let timer: ReturnType<typeof setTimeout>;
  let requestId = 0;

  onMount(() => input.focus());

  // Recherche « au fil de la frappe », avec un petit délai pour ne pas
  // interroger le serveur à chaque touche.
  $effect(() => {
    const q = store.searchQuery;
    clearTimeout(timer);
    if (!q.trim()) {
      hits = [];
      return;
    }
    timer = setTimeout(async () => {
      const id = ++requestId;
      searching = true;
      try {
        const res = store.index.query(q);
        if (id === requestId) hits = res; // ignore les réponses arrivées dans le désordre
      } catch (err) {
        store.fail(err);
      } finally {
        if (id === requestId) searching = false;
      }
    }, 150);
  });
</script>

<div class="search">
  <input
    bind:this={input}
    bind:value={store.searchQuery}
    type="search"
    placeholder="Rechercher dans les notes…"
    aria-label="Rechercher"
    onkeydown={(e) => e.key === 'Enter' && hits[0] && store.open(hits[0].path)}
  />
  {#if store.searchQuery.trim()}
    <div class="count">{searching ? 'Recherche…' : `${hits.length} résultat${hits.length > 1 ? 's' : ''}`}</div>
  {/if}
  <ul>
    {#each hits as hit (hit.path)}
      <li>
        <button class:active={store.note?.path === hit.path} onclick={() => store.open(hit.path)}>
          <span class="title">
            {#each highlightParts(hit.title, store.searchQuery) as p}{#if p.hit}<mark>{p.text}</mark>{:else}{p.text}{/if}{/each}
          </span>
          {#if dirname(hit.path)}<span class="folder">{dirname(hit.path)}</span>{/if}
          <span class="snippet">
            {#each highlightParts(hit.snippet, store.searchQuery) as p}{#if p.hit}<mark>{p.text}</mark>{:else}{p.text}{/if}{/each}
          </span>
        </button>
      </li>
    {/each}
  </ul>
</div>

<style>
  .search {
    display: flex;
    flex-direction: column;
    min-height: 0;
    flex: 1;
  }
  input {
    margin: 8px 10px;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg);
    color: var(--fg);
    font: inherit;
  }
  input:focus {
    outline: 2px solid var(--accent);
    border-color: transparent;
  }
  .count {
    padding: 0 14px 6px;
    font-size: 12px;
    color: var(--muted);
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0 6px;
    overflow: auto;
  }
  button {
    display: flex;
    flex-direction: column;
    gap: 2px;
    width: 100%;
    text-align: left;
    padding: 8px;
    border: none;
    border-radius: 6px;
    background: none;
    color: var(--fg);
    cursor: pointer;
    font: inherit;
  }
  button:hover,
  button.active {
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
  .snippet {
    font-size: 12px;
    color: var(--fg-soft);
    line-height: 1.4;
  }
  mark {
    background: var(--search-hit);
    color: inherit;
    border-radius: 2px;
  }
</style>
