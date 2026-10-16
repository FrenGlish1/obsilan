// Tests des cas critiques de la synchronisation : plan d'actions et fusion.
import { describe, expect, it } from 'vitest';
import { planSync, type SyncAction } from '../shared/syncPlan.ts';
import { mergeText } from '../shared/merge.ts';

const m = (o: Record<string, string>) => new Map(Object.entries(o));
const changes = (o: Record<string, string | null>) => new Map(Object.entries(o));
const plan = (local: Record<string, string>, base: Record<string, string>, remote: Record<string, string | null>, full = false) =>
  planSync({ local: m(local), base: m(base), remoteChanges: changes(remote), full });
const types = (a: SyncAction[]) => a.map((x) => `${x.type}:${x.path}`);

describe('plan de synchronisation', () => {
  it('rien à faire quand tout est identique', () => {
    expect(plan({ a: '1' }, { a: '1' }, {})).toEqual([]);
  });

  it('envoie une modification locale', () => {
    expect(plan({ a: '2' }, { a: '1' }, {})).toEqual([{ type: 'upload', path: 'a', baseHash: '1' }]);
  });

  it('envoie une nouvelle note locale', () => {
    expect(plan({ n: '1' }, {}, {})).toEqual([{ type: 'upload', path: 'n', baseHash: null }]);
  });

  it('télécharge une modification du serveur', () => {
    expect(plan({ a: '1' }, { a: '1' }, { a: '2' })).toEqual([{ type: 'download', path: 'a', localHash: '1' }]);
  });

  it('propage les suppressions dans les deux sens', () => {
    expect(types(plan({}, { a: '1' }, {}))).toEqual(['deleteRemote:a']);
    expect(types(plan({ a: '1' }, { a: '1' }, { a: null }))).toEqual(['deleteLocal:a']);
  });

  it('modifiée des deux côtés → fusion', () => {
    expect(plan({ a: 'L' }, { a: 'B' }, { a: 'R' })).toEqual([
      { type: 'merge', path: 'a', baseHash: 'B', localHash: 'L', remoteHash: 'R' },
    ]);
  });

  it('même modification des deux côtés → simple mise à jour de la base', () => {
    expect(plan({ a: 'X' }, { a: 'B' }, { a: 'X' })).toEqual([{ type: 'setBase', path: 'a', hash: 'X' }]);
  });

  it('jamais de perte : suppression d’un côté, modification de l’autre', () => {
    // Supprimée ici, modifiée sur le serveur → on la récupère.
    expect(plan({}, { a: 'B' }, { a: 'R' })).toEqual([{ type: 'download', path: 'a', localHash: null }]);
    // Supprimée sur le serveur, modifiée ici → on la renvoie.
    expect(plan({ a: 'L' }, { a: 'B' }, { a: null })).toEqual([{ type: 'upload', path: 'a', baseHash: null }]);
  });

  it('supprimée des deux côtés → on oublie la base', () => {
    expect(plan({}, { a: '1' }, { a: null })).toEqual([{ type: 'setBase', path: 'a', hash: null }]);
  });

  it('premier synchro : liste complète du serveur', () => {
    const a = plan({ same: '1', mine: '2', diff: 'L' }, {}, { same: '1', theirs: '3', diff: 'R' }, true);
    expect(types(a)).toEqual(['merge:diff', 'upload:mine', 'setBase:same', 'download:theirs']);
  });

  it('liste complète : une note absente du serveur mais connue est renvoyée si modifiée', () => {
    expect(types(plan({ a: 'L' }, { a: 'B' }, {}, true))).toEqual(['upload:a']);
    // Non modifiée localement et absente du serveur → supprimée ailleurs.
    expect(types(plan({ a: 'B' }, { a: 'B' }, {}, true))).toEqual(['deleteLocal:a']);
  });
});

describe('fusion à 3 voies', () => {
  const base = 'Titre\n\nLigne 1\nLigne 2\nLigne 3\nLigne 4\nLigne 5\n';

  it('combine des modifications à des endroits différents', () => {
    const pc = base.replace('Ligne 1', 'Ligne 1 (PC)');
    const tel = base.replace('Ligne 5', 'Ligne 5 (téléphone)');
    expect(mergeText(base, pc, tel)).toBe(base.replace('Ligne 1', 'Ligne 1 (PC)').replace('Ligne 5', 'Ligne 5 (téléphone)'));
  });

  it('refuse quand les mêmes lignes ont changé', () => {
    expect(mergeText(base, base.replace('Ligne 3', 'A'), base.replace('Ligne 3', 'B'))).toBeNull();
  });

  it('ajouts en fin de note des deux côtés → conflit (on garde les deux versions)', () => {
    expect(mergeText('a\n', 'a\nb\n', 'a\nc\n')).toBeNull();
  });

  it('cas triviaux', () => {
    expect(mergeText('a', 'a', 'b')).toBe('b');
    expect(mergeText('a', 'b', 'a')).toBe('b');
    expect(mergeText('a', 'x', 'x')).toBe('x');
  });
});
