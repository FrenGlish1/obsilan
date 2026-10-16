// Plan de synchronisation : décide, note par note, ce qu'il faut faire.
// Fonction pure (sans réseau ni disque) : facile à tester et à relire.
//
// Trois états sont comparés pour chaque note :
//   L = version locale actuelle        (empreinte, ou null si absente)
//   B = version au dernier synchro     (la « base » commune)
//   R = version actuelle sur le serveur
//
// Règle d'or : on ne supprime jamais une modification. Si un côté a supprimé
// une note que l'autre a modifiée, la version modifiée est conservée.

export type SyncAction =
  /** Envoyer la version locale (création si baseHash est null). */
  | { type: 'upload'; path: string; baseHash: string | null }
  /** Supprimer la note sur le serveur (mise à sa corbeille). */
  | { type: 'deleteRemote'; path: string; baseHash: string }
  /** Écrire localement la version du serveur. */
  | { type: 'download'; path: string; localHash: string | null }
  /** Mettre la note locale à la corbeille. */
  | { type: 'deleteLocal'; path: string; localHash: string }
  /** Les deux côtés ont modifié : fusion, ou conservation des deux versions. */
  | { type: 'merge'; path: string; baseHash: string | null; localHash: string; remoteHash: string }
  /** Déjà identiques des deux côtés : on retient simplement la nouvelle base. */
  | { type: 'setBase'; path: string; hash: string | null };

export interface PlanInput {
  /** Notes présentes sur l'appareil : chemin → empreinte. */
  local: Map<string, string>;
  /** État au dernier synchro : chemin → empreinte. */
  base: Map<string, string>;
  /**
   * Changements côté serveur depuis le dernier synchro (hash null = supprimée).
   * Une note absente de cette liste n'a pas changé sur le serveur.
   */
  remoteChanges: Map<string, string | null>;
  /**
   * Vrai si `remoteChanges` est la liste COMPLÈTE du serveur (premier synchro,
   * ou serveur réinitialisé) : une note absente n'existe alors pas sur le serveur.
   */
  full: boolean;
}

export function planSync({ local, base, remoteChanges, full }: PlanInput): SyncAction[] {
  const paths = new Set<string>([...local.keys(), ...base.keys(), ...remoteChanges.keys()]);
  const actions: SyncAction[] = [];

  for (const path of [...paths].sort()) {
    const L = local.get(path) ?? null;
    const B = base.get(path) ?? null;
    const R = remoteChanges.has(path) ? remoteChanges.get(path)! : full ? null : B;

    if (L === R) {
      // Identiques (ou absentes) des deux côtés : rien à transférer.
      if (B !== L) actions.push({ type: 'setBase', path, hash: L });
      continue;
    }

    const localChanged = L !== B;
    const remoteChanged = R !== B;

    if (!localChanged && remoteChanged) {
      if (R === null) actions.push({ type: 'deleteLocal', path, localHash: L! });
      else actions.push({ type: 'download', path, localHash: L });
    } else if (localChanged && !remoteChanged) {
      if (L === null) actions.push({ type: 'deleteRemote', path, baseHash: R! });
      else actions.push({ type: 'upload', path, baseHash: R });
    } else if (L === null) {
      // Supprimée ici mais modifiée sur le serveur : on récupère la version modifiée.
      actions.push({ type: 'download', path, localHash: null });
    } else if (R === null) {
      // Supprimée sur le serveur mais modifiée ici : on la renvoie.
      actions.push({ type: 'upload', path, baseHash: null });
    } else {
      actions.push({ type: 'merge', path, baseHash: B, localHash: L, remoteHash: R });
    }
  }
  return actions;
}
