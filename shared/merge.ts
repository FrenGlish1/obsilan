// Fusion à 3 voies de deux versions d'une note modifiées en parallèle
// (par ex. sur le PC et sur le téléphone hors ligne).
//
// À partir de la version commune (base) et des deux versions modifiées,
// on combine les changements ligne par ligne. Si les deux côtés ont modifié
// les mêmes lignes (ou des lignes voisines), la fusion est refusée (null) :
// l'appelant garde alors les deux versions, rien n'est perdu.
import { diff3Merge } from 'node-diff3';

export function mergeText(base: string, mine: string, theirs: string): string | null {
  if (mine === theirs) return mine;
  if (base === mine) return theirs;
  if (base === theirs) return mine;
  const regions = diff3Merge(mine.split('\n'), base.split('\n'), theirs.split('\n'), {
    excludeFalseConflicts: true,
  });
  const out: string[] = [];
  for (const r of regions) {
    if (r.ok) out.push(...r.ok);
    else return null;
  }
  return out.join('\n');
}
