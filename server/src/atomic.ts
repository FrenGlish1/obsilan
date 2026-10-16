// Écriture atomique de fichiers : un fichier n'est JAMAIS laissé à moitié écrit.
//
// Principe :
//   1. on écrit le contenu dans un fichier temporaire caché, dans le même dossier ;
//   2. on force l'écriture physique sur le disque (fsync) ;
//   3. on remplace le fichier final par un renommage, opération atomique
//      sur un même système de fichiers : un lecteur voit soit l'ancienne
//      version complète, soit la nouvelle, jamais un mélange ;
//   4. on synchronise le dossier pour que le renommage survive à une coupure.
import { open, rename, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

/** Préfixe/suffixe des fichiers temporaires (cachés, donc ignorés par l'index). */
export const TMP_SUFFIX = '.obsilan-tmp';

export function isTempFile(name: string): boolean {
  return name.startsWith('.') && name.endsWith(TMP_SUFFIX);
}

export async function writeFileAtomic(file: string, data: string | Uint8Array): Promise<void> {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.${randomBytes(6).toString('hex')}${TMP_SUFFIX}`);

  // « wx » : échoue si le fichier existe déjà (évite d'écraser un autre temporaire).
  const fh = await open(tmp, 'wx');
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }

  try {
    await renameWithRetry(tmp, file);
  } catch (err) {
    // En cas d'échec, on nettoie le temporaire ; l'original reste intact.
    await rm(tmp, { force: true });
    throw err;
  }
  await fsyncDir(dir);
}

/**
 * Renommage avec quelques nouvelles tentatives : sous Windows, un antivirus
 * ou un autre programme (Obsidian, indexeur…) peut verrouiller brièvement le fichier.
 */
export async function renameWithRetry(from: string, to: string, attempts = 8): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const retryable = code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
      if (!retryable || i >= attempts - 1) throw err;
      await new Promise((r) => setTimeout(r, 40 * (i + 1)));
    }
  }
}

/** Synchronise l'entrée de dossier (inutile et non supporté sous Windows). */
async function fsyncDir(dir: string): Promise<void> {
  if (process.platform === 'win32') return;
  try {
    const fh = await open(dir, 'r');
    try {
      await fh.sync();
    } finally {
      await fh.close();
    }
  } catch {
    // Certains systèmes de fichiers (montages réseau) refusent : sans gravité.
  }
}
