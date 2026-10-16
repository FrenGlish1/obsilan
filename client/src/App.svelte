<script lang="ts">
  // Composant racine : mise en page, raccourcis clavier globaux, notifications.
  import { onMount } from 'svelte';
  import { store } from './lib/store.svelte.ts';
  import Sidebar from './components/Sidebar.svelte';
  import NoteView from './components/NoteView.svelte';
  import ContextMenu from './components/ContextMenu.svelte';
  import VaultPicker from './components/VaultPicker.svelte';
  import SyncPanel from './components/SyncPanel.svelte';
  import { sync } from './lib/sync/engine.svelte.ts';

  onMount(async () => {
    await store.init();
    if (store.started) sync.init();
  });

  function shortcuts(e: KeyboardEvent) {
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (mod && key === 's') {
      e.preventDefault();
      store.flush();
    } else if (mod && key === 'e') {
      e.preventDefault();
      store.toggleMode();
    } else if (mod && e.shiftKey && key === 'f') {
      e.preventDefault();
      store.openSearch();
    } else if (e.altKey && key === 'n') {
      e.preventDefault();
      store.createNote();
    }
  }
</script>

<svelte:window onkeydown={shortcuts} />

{#if store.needsVault}
  <VaultPicker />
{:else}
<div class="layout">
  <Sidebar />
  {#if store.sidebarOpen}
    <!-- Voile sombre derrière la barre latérale sur mobile -->
    <div class="backdrop only-mobile" role="presentation" onclick={() => (store.sidebarOpen = false)}></div>
  {/if}
  <main class="main">
    {#if store.loading}
      <div class="empty"><p>Indexation des notes…</p></div>
    {:else if store.note}
      <NoteView />
    {:else}
      <div class="empty">
        <button class="icon only-mobile corner" title="Afficher les notes" onclick={() => (store.sidebarOpen = true)}>☰</button>
        <p>Aucune note ouverte.</p>
        <button class="primary" onclick={() => store.createNote()}>Créer une note</button>
      </div>
    {/if}
  </main>
</div>

{/if}

{#if !store.sidebarOpen && !store.needsVault}
  <button class="icon show-sidebar only-desktop" title="Afficher la barre latérale" onclick={() => (store.sidebarOpen = true)}>☰</button>
{/if}

{#if store.menu}<ContextMenu />{/if}
{#if sync.panelOpen}<SyncPanel />{/if}

{#if store.toast}
  <div class="toast toast-{store.toast.kind}" role="status">
    {store.toast.text}
    <button class="icon" onclick={() => (store.toast = null)} aria-label="Fermer">✕</button>
  </div>
{/if}

<style>
  .layout {
    display: flex;
    height: 100%;
  }
  .main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    background: var(--bg);
  }
  .empty {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    color: var(--muted);
    position: relative;
  }
  .corner {
    position: absolute;
    top: 10px;
    left: 10px;
  }
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 10;
    background: rgb(0 0 0 / 0.35);
  }
  .show-sidebar {
    position: fixed;
    left: 8px;
    bottom: 8px;
    z-index: 5;
  }
  .toast {
    position: fixed;
    right: 16px;
    bottom: 16px;
    z-index: 200;
    display: flex;
    align-items: center;
    gap: 10px;
    max-width: min(480px, calc(100vw - 32px));
    padding: 10px 10px 10px 14px;
    border-radius: 8px;
    background: var(--bg);
    color: var(--fg);
    border: 1px solid var(--border);
    border-left: 4px solid var(--accent);
    box-shadow: var(--shadow);
    font-size: 14px;
  }
  .toast-warn {
    border-left-color: var(--warn);
  }
  .toast-error {
    border-left-color: var(--danger);
  }
</style>
