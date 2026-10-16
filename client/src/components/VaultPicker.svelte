<script lang="ts">
  // Écran du premier lancement (PC) : choix du dossier où sont rangées les notes.
  import { open } from '@tauri-apps/plugin-dialog';
  import { store } from '../lib/store.svelte.ts';

  async function browse() {
    const dir = await open({ directory: true, multiple: false, title: 'Dossier de vos notes' });
    if (typeof dir === 'string') store.chooseVault(dir);
  }
</script>

<div class="picker">
  <div class="card">
    <img src="/favicon.svg" alt="" width="56" height="56" />
    <h1>Bienvenue dans ObsiLan</h1>
    {#if store.mobile}
      <p>
        Pour ranger vos notes dans <b>Documents/ObsiLan</b> (visibles dans le gestionnaire de fichiers),
        ObsiLan a besoin de l'autorisation <b>« Accès à tous les fichiers »</b>.
        Activez-la dans l'écran de réglages qui s'est ouvert, puis revenez ici.
      </p>
      <button class="primary" onclick={() => store.chooseVault(store.suggestedRoot)}>J'ai autorisé, continuer</button>
      <button class="secondary" onclick={() => store.chooseVault(store.privateRoot)}>
        Utiliser le stockage interne de l'application
      </button>
    {:else}
    <p>
      Vos notes sont de simples fichiers <code>.md</code> rangés dans un dossier de votre PC.
      Vous pouvez choisir un coffre Obsidian existant : ObsiLan utilise la même syntaxe.
    </p>
    {#if store.suggestedRoot}
      <button class="primary" onclick={() => store.chooseVault(store.suggestedRoot)}>
        Utiliser <span class="path">{store.suggestedRoot}</span>
      </button>
    {/if}
    <button class="secondary" onclick={browse}>Choisir un autre dossier…</button>
    {/if}
  </div>
</div>

<style>
  .picker {
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    background: var(--bg-alt);
  }
  .card {
    max-width: 460px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 14px;
    text-align: center;
    padding: 32px;
    border-radius: 14px;
    background: var(--bg);
    box-shadow: var(--shadow);
  }
  h1 {
    margin: 0;
    font-size: 22px;
  }
  p {
    margin: 0;
    color: var(--fg-soft);
    line-height: 1.5;
  }
  .primary,
  .secondary {
    width: 100%;
  }
  .path {
    display: block;
    font-weight: 400;
    font-size: 12px;
    opacity: 0.85;
    word-break: break-all;
  }
  .secondary {
    padding: 8px 16px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: none;
    color: var(--fg);
    font: inherit;
    cursor: pointer;
  }
  .secondary:hover {
    background: var(--hover);
  }
</style>
