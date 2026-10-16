// Transforme la liste plate renvoyée par le serveur en arbre de dossiers.
import type { TreeEntry } from '../../../shared/types.ts';
import { basename, compareNames, dirname, noteTitle } from '../../../shared/paths.ts';

export interface TreeNode {
  name: string;
  path: string;
  type: 'file' | 'folder';
  children: TreeNode[];
}

export function buildTree(entries: TreeEntry[]): TreeNode[] {
  const root: TreeNode = { name: '', path: '', type: 'folder', children: [] };
  const folders = new Map<string, TreeNode>([['', root]]);

  // Garantit l'existence d'un dossier (et de ses parents) dans l'arbre.
  const folder = (path: string): TreeNode => {
    let node = folders.get(path);
    if (!node) {
      node = { name: basename(path), path, type: 'folder', children: [] };
      folders.set(path, node);
      folder(dirname(path)).children.push(node);
    }
    return node;
  };

  for (const e of entries) {
    if (e.type === 'folder') folder(e.path);
    else folder(dirname(e.path)).children.push({ name: noteTitle(e.path), path: e.path, type: 'file', children: [] });
  }

  // Tri : dossiers d'abord, puis ordre alphabétique naturel.
  const sort = (node: TreeNode) => {
    node.children.sort((a, b) => (a.type !== b.type ? (a.type === 'folder' ? -1 : 1) : compareNames(a.name, b.name)));
    node.children.forEach(sort);
  };
  sort(root);
  return root.children;
}
