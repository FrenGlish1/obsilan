// Configuration du serveur de synchronisation, lue dans « obsilan.config.json »
// (à déposer à côté de server.mjs dans le gestionnaire de fichiers Pterodactyl).
// Sans ce fichier, le serveur démarre en mode développement (HTTP local, interface web).
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export interface ServerConfig {
  /** Sous-domaine DuckDNS (sans « .duckdns.org ») et son token. */
  duckdns?: { domain: string; token: string };
  /** Application Discord (portail développeur) et comptes autorisés. */
  discord?: { clientId: string; clientSecret: string; allowedUserIds: string[] };
  /** Adresse publique ; par défaut https://<domaine>.duckdns.org:<port>. */
  publicUrl?: string;
  /** HTTPS automatique (Let's Encrypt via DuckDNS). Vrai par défaut si duckdns est renseigné. */
  https?: boolean;
  /** E-mail facultatif pour Let's Encrypt (avertissements d'expiration). */
  acmeEmail?: string;
  /** Serveur de test Let's Encrypt (certificat non reconnu, pour essais). */
  acmeStaging?: boolean;
  /** Dossier des données (notes, versions, appareils, certificats). */
  dataDir?: string;
  /** TESTS LOCAUX UNIQUEMENT : jeton accepté sans passer par Discord. */
  devToken?: string;
}

export const CONFIG_FILE = path.resolve(process.env.OBSILAN_CONFIG ?? 'obsilan.config.json');

/** Lit la configuration ; null si le fichier n'existe pas (mode développement). */
export function loadServerConfig(): ServerConfig | null {
  if (!existsSync(CONFIG_FILE)) return null;
  let cfg: ServerConfig;
  try {
    cfg = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
  } catch (err) {
    throw new Error(`obsilan.config.json illisible (JSON invalide) : ${(err as Error).message}`);
  }
  const problems: string[] = [];
  if (cfg.duckdns && (!cfg.duckdns.domain || !cfg.duckdns.token)) problems.push('duckdns.domain et duckdns.token sont requis');
  if (cfg.duckdns?.domain?.includes('.')) problems.push('duckdns.domain : mettez seulement le sous-domaine (ex. "obsilan-mathis")');
  if (cfg.discord) {
    const d = cfg.discord;
    if (!d.clientId || !d.clientSecret) problems.push('discord.clientId et discord.clientSecret sont requis');
    if (!Array.isArray(d.allowedUserIds) || d.allowedUserIds.length === 0) {
      problems.push('discord.allowedUserIds doit contenir au moins votre identifiant Discord');
    }
  }
  if (!cfg.discord && !cfg.devToken) problems.push('renseignez la section discord (ou devToken pour un test local)');
  if (problems.length) throw new Error('Configuration incomplète :\n  - ' + problems.join('\n  - '));
  return cfg;
}

/** Adresse publique du serveur. */
export function publicUrl(cfg: ServerConfig, port: number): string {
  if (cfg.publicUrl) return cfg.publicUrl.replace(/\/+$/, '');
  if (cfg.duckdns) return `https://${cfg.duckdns.domain}.duckdns.org:${port}`;
  return `http://localhost:${port}`;
}
