<script lang="ts">
  // Fenêtre « Synchronisation » : connexion au serveur, état, synchro manuelle.
  import { onMount } from 'svelte';
  import { sync } from '../lib/sync/engine.svelte.ts';
  import { normalizeServerUrl, SyncClient } from '../lib/sync/client.ts';

  let url = $state(sync.serverUrl);
  let token = $state('');
  /** Le serveur saisi n'accepte que la connexion par jeton (test local). */
  let tokenLogin = $state(false);

  onMount(() => {
    if (url) checkServer();
  });

  async function checkServer() {
    try {
      const info = await new SyncClient(normalizeServerUrl(url)).info();
      tokenLogin = info.login === 'token';
    } catch {
      tokenLogin = false;
    }
  }

  const close = () => (sync.panelOpen = false);

  function ago(t: number | null): string {
    if (!t) return 'jamais';
    const s = Math.round((Date.now() - t) / 1000);
    if (s < 10) return 'à l’instant';
    if (s < 60) return `il y a ${s} s`;
    if (s < 3600) return `il y a ${Math.round(s / 60)} min`;
    return new Date(t).toLocaleString('fr-FR');
  }

  const statusText: Record<string, string> = {
    off: 'Non connecté',
    idle: 'À jour',
    syncing: 'Synchronisation en cours…',
    offline: 'Hors ligne',
    error: 'Erreur',
  };
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && close()} />

<div class="overlay" role="presentation" onclick={(e) => e.target === e.currentTarget && close()}>
  <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="sync-title">
    <header>
      <h2 id="sync-title">Synchronisation</h2>
      <button class="icon" onclick={close} aria-label="Fermer">✕</button>
    </header>

    {#if sync.connected}
      <div class="state state-{sync.status}">
        <span class="dot"></span>
        <div>
          <strong>{statusText[sync.status]}</strong>
          <div class="sub">Dernière synchro : {ago(sync.lastSync)}</div>
        </div>
      </div>
      <dl>
        <dt>Serveur</dt>
        <dd>{sync.serverUrl}</dd>
        {#if sync.username}<dt>Compte</dt><dd>{sync.username}</dd>{/if}
      </dl>
      {#if sync.message}<p class="msg">{sync.message}</p>{/if}
      <div class="actions">
        <button class="primary" disabled={sync.status === 'syncing'} onclick={() => sync.sync()}>
          {sync.status === 'syncing' ? 'Synchronisation…' : 'Synchroniser maintenant'}
        </button>
        <button class="secondary" onclick={() => confirm('Déconnecter cet appareil ? Vos notes restent sur l’appareil.') && sync.disconnect()}>
          Se déconnecter
        </button>
      </div>
      <p class="hint">
        La synchro est automatique : à l'ouverture, toutes les minutes et quelques secondes après chaque modification.
        Si une note a été modifiée des deux côtés, les modifications sont fusionnées ; sinon les deux versions sont gardées.
      </p>
    {:else}
      <p>
        Synchronisez vos notes entre vos appareils via votre serveur ObsiLan (Pterodactyl).
        Vos notes restent aussi sur l'appareil : tout fonctionne hors ligne.
      </p>
      <label>
        Adresse du serveur
        <input
          bind:value={url}
          onblur={checkServer}
          placeholder="https://obsilan-vous.duckdns.org:25600"
          autocomplete="url"
          spellcheck="false"
          inputmode="url"
        />
      </label>
      {#if tokenLogin}
        <label>
          Jeton de test (serveur local)
          <input bind:value={token} type="password" />
        </label>
        <button class="primary" disabled={!url || !token} onclick={() => sync.connectWithToken(url, token)}>Se connecter</button>
      {:else if sync.connecting}
        <p class="msg">{sync.message}</p>
        <button class="secondary" onclick={() => sync.cancelConnect()}>Annuler</button>
      {:else}
        <button class="primary discord" disabled={!url} onclick={() => sync.connect(url)}>Se connecter avec Discord</button>
      {/if}
      {#if sync.message && !sync.connecting}<p class="msg error">{sync.message}</p>{/if}
    {/if}
  </div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    z-index: 150;
    background: rgb(0 0 0 / 0.45);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
  }
  .dialog {
    width: min(460px, 100%);
    max-height: 100%;
    overflow: auto;
    background: var(--bg);
    color: var(--fg);
    border-radius: 14px;
    padding: 18px 20px 20px;
    box-shadow: var(--shadow);
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  h2 {
    margin: 0;
    font-size: 19px;
  }
  p {
    margin: 0;
    line-height: 1.5;
    color: var(--fg-soft);
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 13px;
    font-weight: 600;
    color: var(--fg-soft);
  }
  input {
    padding: 9px 10px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg-alt);
    color: var(--fg);
    font: inherit;
    font-weight: 400;
  }
  input:focus {
    outline: 2px solid var(--accent);
    border-color: transparent;
  }
  .discord {
    background: #5865f2;
  }
  button:disabled {
    opacity: 0.55;
    cursor: default;
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
  .actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .state {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px;
    border-radius: 10px;
    background: var(--bg-alt);
  }
  .dot {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: var(--ok);
    flex: none;
  }
  .state-syncing .dot {
    background: var(--accent);
    animation: pulse 1s infinite alternate;
  }
  .state-offline .dot {
    background: var(--warn);
  }
  .state-error .dot {
    background: var(--danger);
  }
  @keyframes pulse {
    to {
      opacity: 0.3;
    }
  }
  .sub {
    font-size: 12px;
    color: var(--muted);
  }
  dl {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 4px 12px;
    margin: 0;
    font-size: 13px;
  }
  dt {
    color: var(--muted);
  }
  dd {
    margin: 0;
    word-break: break-all;
  }
  .msg {
    font-size: 13px;
    padding: 8px 10px;
    border-radius: 8px;
    background: var(--bg-alt);
  }
  .msg.error {
    color: var(--danger);
  }
  .hint {
    font-size: 12px;
    color: var(--muted);
  }
</style>
