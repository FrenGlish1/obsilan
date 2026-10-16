<script lang="ts">
  // Barre latérale : actions, onglets Fichiers / Recherche, arborescence.
  import { store } from '../lib/store.svelte.ts';
  import { buildTree } from '../lib/tree.ts';
  import TreeItem from './TreeItem.svelte';
  import SearchPanel from './SearchPanel.svelte';
  import TagsPanel from './TagsPanel.svelte';
  import { sync } from '../lib/sync/engine.svelte.ts';
  import { basename } from '../../../shared/paths.ts';
  import { open } from '@tauri-apps/plugin-dialog';

  // Nom du dossier du coffre (Windows utilise la barre oblique inverse comme séparateur).
  const vaultName = $derived(basename((store.vaultRoot ?? '').replace(/\\/g, '/')));

  /** Changer de dossier de notes (application PC uniquement). */
  async function changeVault() {
    const dir = await open({ directory: true, multiple: false, title: 'Dossier de vos notes' });
    if (typeof dir === 'string' && dir !== store.vaultRoot) store.chooseVault(dir);
  }

  const tree = $derived(buildTree(store.entries));
  const noteCount = $derived(store.entries.filter((e) => e.type === 'file').length);
  let rootDrop = $state(false);

  // Clic droit dans le vide : création à la racine.
  function rootMenu(e: MouseEvent) {
    e.preventDefault();
    store.menu = {
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: 'Nouvelle note', action: () => store.createNote('') },
        { label: 'Nouveau dossier', action: () => store.createFolder('') },
      ],
    };
  }

  // Déposer dans le vide = déplacer à la racine du coffre.
  function rootDragOver(e: DragEvent) {
    if (!e.dataTransfer?.types.includes('text/x-obsilan-path')) return;
    e.preventDefault();
    rootDrop = true;
  }
  function rootDropHandler(e: DragEvent) {
    rootDrop = false;
    const src = e.dataTransfer?.getData('text/x-obsilan-path');
    if (src) {
      e.preventDefault();
      store.moveInto(src, '');
    }
  }
</script>

<aside class="sidebar" class:open={store.sidebarOpen}>
  <div class="toolbar">
    <button class="icon" title="Nouvelle note (Alt+N)" onclick={() => store.createNote()}>＋</button>
    <button class="icon" title="Nouveau dossier" onclick={() => store.createFolder()}>🗀</button>
    <span class="spacer"></span>
    <button class="icon" title="Thème clair / sombre" onclick={() => store.toggleTheme()}>
      {store.theme === 'dark' ? '☀' : '☾'}
    </button>
    <button class="icon only-mobile" title="Fermer" onclick={() => (store.sidebarOpen = false)}>✕</button>
  </div>

  <div class="tabs" role="tablist">
    <button role="tab" aria-selected={store.sidebarTab === 'files'} class:on={store.sidebarTab === 'files'}
      onclick={() => (store.sidebarTab = 'files')}>Fichiers</button>
    <button role="tab" aria-selected={store.sidebarTab === 'search'} class:on={store.sidebarTab === 'search'}
      onclick={() => (store.sidebarTab = 'search')} title="Ctrl+Maj+F">Recherche</button>
    <button role="tab" aria-selected={store.sidebarTab === 'tags'} class:on={store.sidebarTab === 'tags'}
      onclick={() => (store.sidebarTab = 'tags')}>Tags</button>
  </div>

  {#if store.sidebarTab === 'files'}
    <div
      class="tree"
      class:drop-target={rootDrop}
      role="tree"
      tabindex="-1"
      oncontextmenu={rootMenu}
      ondragover={rootDragOver}
      ondragleave={() => (rootDrop = false)}
      ondrop={rootDropHandler}
      onclick={(e) => e.target === e.currentTarget && (store.selectedFolder = '')}
      onkeydown={() => {}}
    >
      {#each tree as node (node.path)}
        <TreeItem {node} />
      {/each}
    </div>
  {:else if store.sidebarTab === 'search'}
    <SearchPanel />
  {:else}
    <TagsPanel />
  {/if}

  <footer class="footer">
    <!-- État de la synchronisation : un clic ouvre la fenêtre de synchro -->
    <button class="sync sync-{sync.status}" onclick={() => (sync.panelOpen = true)} title={sync.message || 'Synchronisation'}>
      <span class="sync-dot"></span>
      {#if sync.status === 'off'}Synchronisation : non connecté
      {:else if sync.status === 'syncing'}Synchronisation…
      {:else if sync.status === 'offline'}Hors ligne (synchro en attente)
      {:else if sync.status === 'error'}Synchro : erreur
      {:else}Synchronisé{/if}
    </button>
    {#if store.vaultRoot}
      <button class="vault" title="{store.vaultRoot} — changer de dossier" onclick={changeVault}>
        🗁 {vaultName}
      </button>
      <span>{noteCount} note{noteCount > 1 ? 's' : ''}</span>
    {:else}
      <span>{noteCount} note{noteCount > 1 ? 's' : ''}</span>
      <span class="live" class:on={store.live} title={store.live ? 'Connecté au serveur' : 'Serveur injoignable'}>
        ● {store.live ? 'connecté' : 'hors ligne'}
      </span>
    {/if}
  </footer>
</aside>

<style>
  .sidebar {
    display: flex;
    flex-direction: column;
    width: var(--sidebar-width);
    flex: none;
    background: var(--bg-alt);
    border-right: 1px solid var(--border);
    min-height: 0;
  }
  .toolbar {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 8px;
  }
  .spacer {
    flex: 1;
  }
  .tabs {
    display: flex;
    gap: 4px;
    padding: 0 10px 6px;
  }
  .tabs button {
    flex: 1;
    padding: 6px;
    border: none;
    border-radius: 6px;
    background: none;
    color: var(--muted);
    cursor: pointer;
    font: inherit;
    font-size: 13px;
  }
  .tabs button.on {
    background: var(--hover);
    color: var(--fg);
    font-weight: 600;
  }
  .tree {
    flex: 1;
    overflow: auto;
    padding-bottom: 24px;
  }
  .tree.drop-target {
    background: var(--accent-soft);
  }
  .footer {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: 4px 8px;
    padding: 8px 14px;
    font-size: 12px;
    color: var(--muted);
    border-top: 1px solid var(--border);
  }
  .sync {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px;
    margin: 0 -8px 2px;
    border: none;
    border-radius: 6px;
    background: none;
    color: var(--fg-soft);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .sync:hover {
    background: var(--hover);
  }
  .sync-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--faint);
    flex: none;
  }
  .sync-idle .sync-dot {
    background: var(--ok);
  }
  .sync-syncing .sync-dot {
    background: var(--accent);
    animation: blink 0.8s infinite alternate;
  }
  .sync-offline .sync-dot {
    background: var(--warn);
  }
  .sync-error .sync-dot {
    background: var(--danger);
  }
  .sync-error {
    color: var(--danger);
  }
  @keyframes blink {
    to {
      opacity: 0.3;
    }
  }
  .vault {
    border: none;
    background: none;
    color: var(--muted);
    font: inherit;
    padding: 0;
    cursor: pointer;
    max-width: 65%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .vault:hover {
    color: var(--fg);
  }
  .live {
    color: var(--danger);
  }
  .live.on {
    color: var(--ok);
  }
  @media (max-width: 800px) {
    .sidebar {
      position: fixed;
      inset: 0 auto 0 0;
      z-index: 20;
      width: min(85vw, 340px);
      transform: translateX(-100%);
      transition: transform 0.2s ease;
      box-shadow: var(--shadow);
    }
    .sidebar.open {
      transform: none;
    }
  }
  @media (min-width: 801px) {
    .sidebar:not(.open) {
      display: none;
    }
  }
</style>
