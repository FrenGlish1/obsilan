// Configuration lue depuis les variables d'environnement.
// Pterodactyl fournit SERVER_PORT (le port de l'allocation) : on l'utilise
// automatiquement s'il est présent.
import path from 'node:path';

export const config = {
  port: Number(process.env.PORT ?? process.env.SERVER_PORT ?? 3000),
  host: process.env.HOST ?? '0.0.0.0',
  /** Dossier contenant les notes .md (le « coffre »). */
  vaultDir: path.resolve(process.env.VAULT_DIR ?? './vault'),
  /** Taille maximale d'une requête (contenu d'une note), en octets. */
  bodyLimit: Number(process.env.BODY_LIMIT ?? 20 * 1024 * 1024),
};
