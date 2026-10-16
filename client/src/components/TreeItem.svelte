<script lang="ts">
  // Une ligne de l'arborescence (note ou dossier), affichée récursivement.
  import { tick } from 'svelte';
  import { store } from '../lib/store.svelte.ts';
  import type { TreeNode } from '../lib/tree.ts';
  import { dirname, INVALID_NAME_HELP, joinPath, normalizePath } from '../../../shared/paths.ts';
  import TreeItem from './TreeItem.svelte';

  let { node, depth = 0 }: { node: TreeNode; depth?: number } = $props();

  const isFolder = $derived(node.type === 'folder');
  const open = $derived(isFolder && !!store.expanded[node.path]);
  const active = $derived(store.note?.path === node.path);
  const selected = $derived(isFolder && store.selectedFolder === node.path);
  const renaming = $derived(store.renaming === node.path);

  let dropTarget = $state(false);
  let input: HTMLInputElement | undefined = $state();
  let draft = $state('');

  // Passage en mode renommage : on préremplit et on sélectionne le nom.
  $effect(() => {
    if (renaming) {
      draft = node.name;
      tick().then(() => {
        input?.focus();
        input?.select();
      });
    }
  });

  function click() {
    if (isFolder) {
      store.toggleFolder(node.path);
      store.selectedFolder = node.path;
    } else {
      store.open(node.path);
    }
  }

  function contextMenu(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    openMenu(e.clientX, e.clientY);
  }

  // Appui long (téléphone) : même menu que le clic droit.
  let pressTimer: ReturnType<typeof setTimeout> | undefined;
  let longPressed = false;
  function touchStart(e: TouchEvent) {
    longPressed = false;
    const t = e.touches[0];
    pressTimer = setTimeout(() => {
      longPressed = true;
      navigator.vibrate?.(15);
      openMenu(t.clientX, t.clientY);
    }, 500);
  }
  function touchEnd(e: TouchEvent) {
    clearTimeout(pressTimer);
    // Empêche le « clic » qui suivrait l'appui long (ouverture de la note).
    if (longPressed) e.preventDefault();
  }

  function openMenu(x: number, y: number) {
    const items = [];
    if (isFolder) {
      items.push(
        { label: 'Nouvelle note ici', action: () => store.createNote(node.path) },
        { label: 'Nouveau dossier ici', action: () => store.createFolder(node.path) },
      );
    }
    items.push(
      { label: 'Renommer', action: () => (store.renaming = node.path) },
      { label: 'Mettre à la corbeille', danger: true, action: () => store.remove(node.path, isFolder) },
    );
    store.menu = { x, y, items };
  }

  async function commitRename() {
    if (store.renaming !== node.path) return;
    store.renaming = null;
    const name = draft.trim();
    if (!name || name === node.name) return;
    const to = normalizePath(joinPath(dirname(node.path), isFolder ? name : name + '.md'));
    if (!to) {
      store.notify(INVALID_NAME_HELP, 'error', 6000);
      return;
    }
    await store.rename(node.path, to);
  }

  function renameKey(e: KeyboardEvent) {
    if (e.key === 'Enter') commitRename();
    else if (e.key === 'Escape') store.renaming = null;
  }

  // ----- glisser-déposer : on peut déposer une note ou un dossier sur un dossier
  function dragStart(e: DragEvent) {
    e.dataTransfer?.setData('text/x-obsilan-path', node.path);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  }
  function dragOver(e: DragEvent) {
    if (!isFolder || !e.dataTransfer?.types.includes('text/x-obsilan-path')) return;
    e.preventDefault();
    e.stopPropagation();
    dropTarget = true;
  }
  function drop(e: DragEvent) {
    dropTarget = false;
    if (!isFolder) return;
    const src = e.dataTransfer?.getData('text/x-obsilan-path');
    if (!src) return;
    e.preventDefault();
    e.stopPropagation();
    store.moveInto(src, node.path);
  }
</script>

<div
  class="row"
  class:active
  class:selected
  class:drop-target={dropTarget}
  role="treeitem"
  aria-selected={active}
  aria-expanded={isFolder ? open : undefined}
  tabindex="0"
  draggable={!renaming}
  onclick={click}
  onkeydown={(e) => e.key === 'Enter' && !renaming && click()}
  oncontextmenu={contextMenu}
  ontouchstart={touchStart}
  ontouchend={touchEnd}
  ontouchmove={() => clearTimeout(pressTimer)}
  ondragstart={dragStart}
  ondragover={dragOver}
  ondragleave={() => (dropTarget = false)}
  ondrop={drop}
>
  <span class="chevron">{isFolder ? (open ? '▾' : '▸') : ''}</span>
  {#if renaming}
    <input
      class="rename"
      bind:this={input}
      bind:value={draft}
      onkeydown={renameKey}
      onblur={commitRename}
      onclick={(e) => e.stopPropagation()}
    />
  {:else}
    <span class="name" class:folder={isFolder}>{node.name}</span>
  {/if}
</div>

{#if open}
  <!-- Contenu du dossier : décalé et relié au dossier par un trait vertical -->
  <div class="children" role="group">
    {#each node.children as child (child.path)}
      <TreeItem node={child} depth={depth + 1} />
    {/each}
  </div>
{/if}

<style>
  .row {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 8px;
    margin: 1px 6px;
    border-radius: 6px;
    cursor: pointer;
    user-select: none;
    color: var(--fg-soft);
    font-size: 14px;
    min-height: 28px;
  }
  .row:hover {
    background: var(--hover);
  }
  .row.active {
    background: var(--accent-soft);
    color: var(--fg);
    font-weight: 600;
  }
  .row.selected {
    color: var(--fg);
  }
  .row.drop-target {
    outline: 2px dashed var(--accent);
  }
  .row:focus-visible {
    outline: 2px solid var(--accent);
  }
  .children {
    margin-left: 17px;
    border-left: 1px solid var(--border);
  }
  .children:hover {
    border-left-color: var(--faint);
  }
  .chevron {
    width: 14px;
    flex: none;
    color: var(--muted);
    font-size: 11px;
  }
  .name {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .name.folder {
    font-weight: 500;
  }
  .rename {
    flex: 1;
    min-width: 0;
    font: inherit;
    padding: 1px 4px;
    border: 1px solid var(--accent);
    border-radius: 4px;
    background: var(--bg);
    color: var(--fg);
  }
  @media (pointer: coarse) {
    .row {
      min-height: 40px;
    }
  }
</style>
