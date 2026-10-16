// Routes de la synchronisation et de la connexion.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { INVALID_NAME_HELP, normalizePath } from '../../../shared/paths.ts';
import { HttpError } from '../vault.ts';
import type { Auth } from './auth.ts';
import type { UserSpaces } from './users.ts';

type Body = Record<string, unknown>;

function needPath(raw: unknown): string {
  const p = normalizePath(raw);
  if (!p) throw new HttpError(400, 'bad_path', INVALID_NAME_HELP);
  return p;
}

const optHash = (v: unknown) => (typeof v === 'string' && v ? v : null);

/** Page affichée dans le navigateur à la fin de la connexion Discord. */
function page(ok: boolean, message: string): string {
  const esc = message.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ObsiLan</title><style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#1c1c21;color:#dedee6}
.c{max-width:420px;padding:32px;border-radius:14px;background:#26262d;text-align:center}.i{font-size:42px}p{line-height:1.5}</style></head>
<body><div class="c"><div class="i">${ok ? '✅' : '⛔'}</div><h2>${ok ? 'Connexion réussie' : 'Connexion impossible'}</h2><p>${esc}</p>
${ok ? '<p>Vous pouvez fermer cet onglet.</p>' : ''}</div></body></html>`;
}

export async function registerSyncRoutes(
  app: FastifyInstance,
  spaces: UserSpaces,
  auth: Auth,
  info: { version: string; discord: boolean },
): Promise<void> {
  // L'application (origine tauri://… ou localhost) appelle ce serveur depuis une
  // autre origine : on autorise les requêtes. L'accès reste protégé par le jeton.
  app.addHook('onRequest', async (req, reply) => {
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    reply.header('Access-Control-Max-Age', '86400');
    if (req.method === 'OPTIONS') return reply.status(204).send();
  });

  const device = (req: FastifyRequest) => auth.verify(req.headers.authorization);
  /** Espace de notes du compte connecté : un utilisateur ne voit jamais celui d'un autre. */
  const space = (req: FastifyRequest) => spaces.get(device(req).userId);

  // --------------------------------------------------------------- public

  app.get('/api/sync/info', async () => ({
    name: 'ObsiLan',
    version: info.version,
    login: info.discord ? 'discord' : 'token',
  }));

  app.post('/api/auth/start', async (req) => {
    const b = (req.body ?? {}) as Body;
    return auth.start(typeof b.deviceName === 'string' ? b.deviceName : 'Appareil');
  });

  app.get('/auth/discord', async (req, reply) => {
    const login = (req.query as Record<string, string>).login ?? '';
    try {
      return reply.redirect(auth.discordUrl(login));
    } catch (err) {
      return reply.type('text/html').status(400).send(page(false, (err as Error).message));
    }
  });

  app.get('/auth/discord/callback', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const r = await auth.callback(q.code, q.state, q.error);
    return reply.type('text/html').status(r.ok ? 200 : 403).send(page(r.ok, r.message));
  });

  app.post('/api/auth/poll', async (req) => {
    const b = (req.body ?? {}) as Body;
    return auth.poll(String(b.loginId ?? ''), String(b.pollSecret ?? ''));
  });

  // ---------------------------------------------------------- authentifié

  app.get('/api/auth/me', async (req) => {
    const d = device(req);
    return { username: d.username, device: d.name };
  });

  app.post('/api/auth/logout', async (req) => {
    device(req);
    auth.revoke(req.headers.authorization);
    return { ok: true };
  });

  // Changements depuis une révision (ou liste complète).
  app.get('/api/sync/changes', async (req) => {
    const store = await space(req);
    const q = req.query as Record<string, string | undefined>;
    const since = Number(q.since ?? 0) || 0;
    const { full, changes } = store.changes(since, q.epoch);
    return { epoch: store.epoch, rev: store.rev, full, changes };
  });

  // Téléchargement groupé.
  app.post('/api/sync/download', async (req) => {
    const store = await space(req);
    const paths = ((req.body as Body)?.paths ?? []) as unknown[];
    if (!Array.isArray(paths) || paths.length > 200) throw new HttpError(400, 'bad_request', 'Liste de chemins invalide (200 max).');
    const files = await Promise.all(paths.map((p) => store.read(needPath(p))));
    return { files: files.filter(Boolean) };
  });

  // Envoi d'une note.
  app.put('/api/sync/file', async (req) => {
    const store = await space(req);
    const b = req.body as Body;
    if (typeof b.content !== 'string') throw new HttpError(400, 'bad_content', 'content manquant');
    return store.put(needPath(b.path), b.content, optHash(b.baseHash));
  });

  // Suppression d'une note (corbeille du serveur, version archivée).
  app.post('/api/sync/delete', async (req) => {
    const store = await space(req);
    const b = req.body as Body;
    const base = optHash(b.baseHash);
    if (!base) throw new HttpError(400, 'bad_request', 'baseHash manquant');
    return store.remove(needPath(b.path), base);
  });

  // Ancienne version d'une note (base de fusion).
  app.get('/api/sync/blob', async (req) => {
    const store = await space(req);
    const q = req.query as Record<string, string | undefined>;
    const content = await store.blob(needPath(q.path), String(q.hash ?? ''));
    if (content === null) throw new HttpError(404, 'not_found', 'Version introuvable.');
    return { content };
  });
}
