// Point d'entrée du serveur ObsiLan.
//
// Deux modes :
//   - PRODUCTION (fichier obsilan.config.json présent) : serveur de synchronisation
//     en HTTPS, connexion Discord, aucune interface web ;
//   - DÉVELOPPEMENT (pas de fichier) : HTTP local, interface web et API ouverte.
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.ts';
import { Vault } from './vault.ts';
import { buildApp } from './app.ts';
import { watchVault } from './watcher.ts';
import { CONFIG_FILE, loadServerConfig, publicUrl } from './sync/config.ts';
import { UserSpaces } from './sync/users.ts';
import { Auth } from './sync/auth.ts';
import { registerSyncRoutes } from './sync/routes.ts';
import { ensureCertificate, scheduleRenewal, startDuckDnsUpdater } from './sync/tls.ts';

const VERSION = '0.4.0';
const log = (msg: string) => console.log(`[ObsiLan] ${msg}`);

async function main(): Promise<void> {
  const cfg = loadServerConfig();
  const production = cfg !== null;
  const dataDir = path.resolve(cfg?.dataDir ?? 'data');
  // Interface web et API sans connexion : développement uniquement (jamais en ligne,
  // puisque chaque compte a ses propres notes).
  const devApi = !production;

  await mkdir(dataDir, { recursive: true });
  log(`version ${VERSION} — mode ${production ? 'PRODUCTION (' + CONFIG_FILE + ')' : 'développement'}`);

  // HTTPS automatique si un sous-domaine DuckDNS est configuré.
  let https: { key: string; cert: string } | undefined;
  if (cfg?.duckdns) startDuckDnsUpdater(cfg, log);
  if (cfg?.duckdns && cfg.https !== false) https = await ensureCertificate(cfg, dataDir, log);

  // Coffre de l'interface web de développement (./vault).
  let vault: Vault | null = null;
  if (devApi) {
    vault = new Vault(config.vaultDir);
    const t0 = Date.now();
    await vault.init();
    log(`notes (développement) : ${config.vaultDir} — ${vault.index.size} notes indexées en ${Date.now() - t0} ms`);
  }

  const app = await buildApp(vault, { https, devApi, logger: !production || process.env.LOG_LEVEL !== undefined });
  const stopWatching = vault ? watchVault(vault) : async () => undefined;

  // Synchronisation : un espace de notes séparé par compte (data/users/<id>/).
  // Disponible dans les deux modes ; en développement il faut un devToken.
  const spaces = new UserSpaces(dataDir);
  const base = publicUrl(cfg ?? {}, config.port);
  const auth = new Auth(cfg ?? { devToken: process.env.OBSILAN_DEV_TOKEN }, dataDir, base);
  await registerSyncRoutes(app, spaces, auth, { version: VERSION, discord: !!cfg?.discord });

  if (https && cfg) {
    scheduleRenewal(cfg, dataDir, (c) => (app.server as unknown as import('node:tls').Server).setSecureContext(c), log);
  }

  // Interface web compilée : seulement pour le développement.
  const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
  if (devApi && existsSync(publicDir)) {
    await app.register(fastifyStatic, { root: publicDir, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.sendFile('index.html');
      reply.status(404).send({ error: 'not_found', message: 'Route inconnue' });
    });
  } else {
    app.get('/', async (_req, reply) =>
      reply.type('text/html').send('<meta charset="utf-8"><p style="font-family:sans-serif">Serveur de synchronisation ObsiLan : en ligne ✅</p>'),
    );
  }

  // Arrêt propre (Ctrl+C, arrêt du serveur Pterodactyl).
  const shutdown = async () => {
    await stopWatching();
    await spaces.close();
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await app.listen({ port: config.port, host: config.host });
  log(`prêt : ${base}`);
  if (production && cfg.discord) log(`adresse de redirection Discord à déclarer : ${auth.redirectUri}`);
  if (production) log(`${await spaces.count()} compte(s), ${auth.list().length} appareil(s) connecté(s).`);
}

main().catch((err) => {
  console.error(`[ObsiLan] ERREUR AU DÉMARRAGE :\n${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
