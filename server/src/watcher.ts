// Surveillance du dossier : détecte les modifications faites EN DEHORS de
// l'application (Obsidian, éditeur de texte, copie par SFTP/Pterodactyl…)
// et met l'index à jour au fil de l'eau.
import chokidar from 'chokidar';
import path from 'node:path';
import { isNote } from '../../shared/paths.ts';
import type { Vault } from './vault.ts';

export function watchVault(vault: Vault): () => Promise<void> {
  const toRel = (abs: string) => path.relative(vault.root, abs).split(path.sep).join('/');

  const watcher = chokidar.watch(vault.root, {
    ignoreInitial: true,
    // Ignore les éléments cachés (.trash, .obsidian, temporaires) et les non-.md.
    ignored: (p, stats) => {
      const rel = toRel(p);
      if (rel === '') return false;
      if (rel.split('/').some((seg) => seg.startsWith('.'))) return true;
      return !!stats?.isFile() && !isNote(p);
    },
    // Attend que le fichier soit stable avant de le lire (copies en cours).
    awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 100 },
  });

  watcher
    .on('add', (p) => {
      vault.reindex(toRel(p)).then(() => vault.emit({ type: 'tree' }));
    })
    .on('change', (p) => {
      vault.reindex(toRel(p));
    })
    .on('unlink', (p) => {
      if (vault.index.remove(toRel(p))) {
        vault.emit({ type: 'removed', path: toRel(p) });
        vault.emit({ type: 'tree' });
      }
    })
    .on('addDir', () => vault.emit({ type: 'tree' }))
    .on('unlinkDir', (p) => {
      vault.index.removeFolder(toRel(p));
      vault.emit({ type: 'removed', path: toRel(p) });
      vault.emit({ type: 'tree' });
    })
    .on('error', (err) => console.error('[surveillance]', err));

  return () => watcher.close();
}
