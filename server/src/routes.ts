// Routes de l'API REST. Toutes les routes sont préfixées par /api.
import type { FastifyInstance, FastifyReply } from 'fastify';
import { INVALID_NAME_HELP, normalizePath } from '../../shared/paths.ts';
import { HttpError, type Vault } from './vault.ts';
import type { VaultEvent } from '../../shared/types.ts';

/** Valide un chemin reçu du client, ou lève une erreur 400 explicite. */
function needPath(raw: unknown, field = 'path'): string {
  const p = normalizePath(raw);
  if (!p) throw new HttpError(400, 'bad_path', `${field} : ${INVALID_NAME_HELP}`);
  return p;
}

type Body = Record<string, unknown>;
type Query = Record<string, string | undefined>;

export async function registerRoutes(app: FastifyInstance, vault: Vault): Promise<void> {
  // Arborescence complète du coffre.
  app.get('/api/tree', async () => ({ entries: await vault.walk('') }));

  // Lecture d'une note.
  app.get('/api/note', async (req) => vault.readNote(needPath((req.query as Query).path)));

  // Enregistrement (création implicite si la note n'existe pas).
  app.put('/api/note', async (req) => {
    const b = req.body as Body;
    if (typeof b.content !== 'string') throw new HttpError(400, 'bad_content', 'content manquant');
    const baseHash = typeof b.baseHash === 'string' ? b.baseHash : undefined;
    return vault.saveNote(needPath(b.path), b.content, baseHash);
  });

  // Création d'une note. Sans chemin, on choisit « Sans titre N.md » dans `folder`.
  app.post('/api/note', async (req) => {
    const b = req.body as Body;
    const content = typeof b.content === 'string' ? b.content : '';
    let path: string;
    if (b.path) path = needPath(b.path);
    else {
      const folder = b.folder ? needPath(b.folder, 'folder') : '';
      path = await vault.freeName(folder, 'Sans titre');
    }
    return vault.createNote(path, content);
  });

  // Création d'un dossier.
  app.post('/api/folder', async (req) => {
    const b = req.body as Body;
    let path: string;
    if (b.path) path = needPath(b.path);
    else {
      const parent = b.parent ? needPath(b.parent, 'parent') : '';
      path = await vault.freeName(parent, 'Nouveau dossier', '');
    }
    await vault.createFolder(path);
    return { path };
  });

  // Renommage / déplacement d'une note ou d'un dossier.
  app.post('/api/rename', async (req) => {
    const b = req.body as Body;
    const from = needPath(b.from, 'from');
    const to = needPath(b.to, 'to');
    if (from !== to) await vault.rename(from, to);
    return { from, to };
  });

  // Suppression = mise à la corbeille (.trash/).
  app.delete('/api/entry', async (req) => {
    const trashedTo = await vault.trash(needPath((req.query as Query).path));
    return { trashedTo };
  });

  // Contenu de toutes les notes (index local de l'interface : recherche, liens, tags).
  app.get('/api/all', async () => {
    const files = (await vault.walk('')).filter((e) => e.type === 'file');
    const notes = await Promise.all(
      files.map((f) => vault.readNote(f.path).then((n) => ({ path: n.path, content: n.content, hash: n.hash })).catch(() => null)),
    );
    return { notes: notes.filter(Boolean) };
  });

  // Recherche plein texte.
  app.get('/api/search', async (req) => {
    const q = (req.query as Query).q ?? '';
    return { hits: vault.index.search(q.slice(0, 200)) };
  });

  // Flux d'événements (Server-Sent Events) : le client est prévenu en direct
  // quand l'arborescence ou une note change (autre onglet, Obsidian…).
  app.get('/api/events', (req, reply: FastifyReply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // désactive la mise en tampon si un proxy nginx est devant
    });
    res.write('retry: 3000\n\n');
    const send = (e: VaultEvent) => res.write(`data: ${JSON.stringify(e)}\n\n`);
    const off = vault.on(send);
    // Battement régulier pour garder la connexion ouverte à travers les proxys.
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.raw.on('close', () => {
      clearInterval(ping);
      off();
    });
  });

  app.get('/api/health', async () => ({ ok: true, notes: vault.index.size }));
}
