<script lang="ts">
  // Menu contextuel (clic droit) positionné sous le pointeur.
  import { store } from '../lib/store.svelte.ts';

  const menu = $derived(store.menu!);
  // Évite que le menu déborde de l'écran.
  const x = $derived(Math.min(menu.x, window.innerWidth - 220));
  const y = $derived(Math.min(menu.y, window.innerHeight - menu.items.length * 36 - 16));

  function run(action: () => void) {
    store.menu = null;
    action();
  }
</script>

<svelte:window onclick={() => (store.menu = null)} onkeydown={(e) => e.key === 'Escape' && (store.menu = null)} onblur={() => (store.menu = null)} />

<div class="menu" style="left: {x}px; top: {y}px" role="menu">
  {#each menu.items as item}
    <button role="menuitem" class:danger={item.danger} onclick={(e) => { e.stopPropagation(); run(item.action); }}>
      {item.label}
    </button>
  {/each}
</div>

<style>
  .menu {
    position: fixed;
    z-index: 100;
    min-width: 200px;
    padding: 4px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: var(--shadow);
  }
  button {
    display: block;
    width: 100%;
    padding: 8px 10px;
    border: none;
    border-radius: 5px;
    background: none;
    color: var(--fg);
    text-align: left;
    font: inherit;
    font-size: 14px;
    cursor: pointer;
  }
  button:hover {
    background: var(--hover);
  }
  .danger {
    color: var(--danger);
  }
</style>
