// Tests du serveur de synchronisation : révisions, conflits, versions archivées, jetons.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { Vault } from '../server/src/vault.ts';
import { buildApp } from '../server/src/app.ts';
import { Auth, type Device } from '../server/src/sync/auth.ts';
import { UserSpaces } from '../server/src/sync/users.ts';
import { registerSyncRoutes } from '../server/src/sync/routes.ts';

let dir: string;
let app: FastifyInstance;
let spaces: UserSpaces;
const TOKEN = 'jeton-de-test';

/** Deux comptes Discord de test, chacun avec son jeton. */
class TestAuth extends Auth {
  verify(header: string | undefined): Device {
    const users: Record<string, string> = { 'Bearer alice': '111', 'Bearer bob': '222' };
    const id = header ? users[header] : undefined;
    if (id) return { id, userId: id, username: id, name: 'test', created: 0, lastSeen: 0 };
    return super.verify(header);
  }
}

async function api(method: 'GET' | 'POST' | 'PUT', url: string, body?: object, token: string | null = TOKEN) {
  const res = await app.inject({
    method,
    url,
    payload: body,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return { status: res.statusCode, json: res.json() };
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'obsilan-sync-'));
  spaces = new UserSpaces(dir);
  app = await buildApp(null, { logger: false, devApi: false });
  await registerSyncRoutes(app, spaces, new TestAuth({ devToken: TOKEN }, dir, 'http://localhost'), { version: 't', discord: false });
});

afterEach(async () => {
  await spaces.close();
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

describe('serveur de synchro', () => {
  it('refuse les requêtes sans jeton valide', async () => {
    expect((await api('GET', '/api/sync/changes', undefined, null)).status).toBe(401);
    expect((await api('GET', '/api/sync/changes', undefined, 'faux')).status).toBe(401);
    expect((await api('GET', '/api/sync/info', undefined, null)).status).toBe(200);
  });

  it('liste complète puis changements incrémentaux', async () => {
    const first = await api('GET', '/api/sync/changes?since=0');
    expect(first.json.full).toBe(true);
    // Espace neuf : vide (pas de note de bienvenue côté serveur, l'application a la sienne).
    expect(first.json.changes).toEqual([]);

    await api('PUT', '/api/sync/file', { path: 'A.md', content: 'a', baseHash: null });
    const next = await api('GET', `/api/sync/changes?since=${first.json.rev}&epoch=${first.json.epoch}`);
    expect(next.json.full).toBe(false);
    expect(next.json.changes).toEqual([{ path: 'A.md', hash: expect.any(String) }]);
  });

  it('refuse une écriture basée sur une version périmée (409) et renvoie la version actuelle', async () => {
    const v1 = await api('PUT', '/api/sync/file', { path: 'n.md', content: 'v1', baseHash: null });
    await api('PUT', '/api/sync/file', { path: 'n.md', content: 'v2 téléphone', baseHash: v1.json.hash });
    const res = await api('PUT', '/api/sync/file', { path: 'n.md', content: 'v2 PC', baseHash: v1.json.hash });
    expect(res.status).toBe(409);
    expect(res.json.current.content).toBe('v2 téléphone');
  });

  it('une création ne peut pas écraser une note existante', async () => {
    await api('PUT', '/api/sync/file', { path: 'n.md', content: 'A', baseHash: null });
    expect((await api('PUT', '/api/sync/file', { path: 'n.md', content: 'B', baseHash: null })).status).toBe(409);
  });

  it('archive chaque version écrasée, retrouvable pour les fusions', async () => {
    const v1 = await api('PUT', '/api/sync/file', { path: 'Dossier/n.md', content: 'version 1', baseHash: null });
    await api('PUT', '/api/sync/file', { path: 'Dossier/n.md', content: 'version 2', baseHash: v1.json.hash });
    const blob = await api('GET', `/api/sync/blob?path=${encodeURIComponent('Dossier/n.md')}&hash=${v1.json.hash}`);
    expect(blob.json.content).toBe('version 1');
    expect(await readdir(path.join(dir, 'users', 'dev', 'versions', 'Dossier', 'n.md'))).toHaveLength(1);
  });

  it('suppression : corbeille + version archivée + pierre tombale', async () => {
    const r0 = (await api('GET', '/api/sync/changes?since=0')).json;
    const v1 = await api('PUT', '/api/sync/file', { path: 'x.md', content: 'x', baseHash: null });
    expect((await api('POST', '/api/sync/delete', { path: 'x.md', baseHash: 'mauvais' })).status).toBe(409);
    await api('POST', '/api/sync/delete', { path: 'x.md', baseHash: v1.json.hash });
    const ch = (await api('GET', `/api/sync/changes?since=${r0.rev}&epoch=${r0.epoch}`)).json;
    expect(ch.changes).toEqual([{ path: 'x.md', hash: null }]);
    expect(await readdir(path.join(dir, 'users', 'dev', 'vault', '.trash'))).toContain('x.md');
  });

  it('détecte les modifications faites directement dans le dossier du serveur', async () => {
    const r0 = (await api('GET', '/api/sync/changes?since=0')).json;
    await writeFile(path.join(dir, 'users', 'dev', 'vault', 'externe.md'), 'ajouté par SFTP');
    // Simule la détection par la surveillance du dossier.
    const store = await spaces.get('dev');
    await (store as unknown as { vault: Vault }).vault.reindex('externe.md');
    const ch = (await api('GET', `/api/sync/changes?since=${r0.rev}&epoch=${r0.epoch}`)).json;
    expect(ch.changes.map((c: { path: string }) => c.path)).toEqual(['externe.md']);
  });

  it('autre historique (epoch) → liste complète', async () => {
    const ch = (await api('GET', '/api/sync/changes?since=5&epoch=ancien')).json;
    expect(ch.full).toBe(true);
  });

  it('chaque compte a ses propres notes, invisibles des autres', async () => {
    const asAlice = (m: 'GET' | 'POST' | 'PUT', u: string, b?: object) => api(m, u, b, 'alice');
    const asBob = (m: 'GET' | 'POST' | 'PUT', u: string, b?: object) => api(m, u, b, 'bob');

    await asAlice('PUT', '/api/sync/file', { path: 'Journal intime.md', content: 'secret d’Alice', baseHash: null });
    await asBob('PUT', '/api/sync/file', { path: 'Journal intime.md', content: 'secret de Bob', baseHash: null });

    // Même chemin, deux notes distinctes : aucune collision, aucun conflit.
    const a = (await asAlice('POST', '/api/sync/download', { paths: ['Journal intime.md'] })).json.files;
    const b = (await asBob('POST', '/api/sync/download', { paths: ['Journal intime.md'] })).json.files;
    expect(a[0].content).toBe('secret d’Alice');
    expect(b[0].content).toBe('secret de Bob');

    // Bob ne voit pas les notes d'Alice dans ses changements.
    await asAlice('PUT', '/api/sync/file', { path: 'Seulement Alice.md', content: 'x', baseHash: null });
    const bobList = (await asBob('GET', '/api/sync/changes?since=0')).json.changes.map((c: { path: string }) => c.path);
    expect(bobList).toEqual(['Journal intime.md']);

    // Ni ses anciennes versions.
    const aliceHash = a[0].hash;
    expect((await asBob('GET', `/api/sync/blob?path=${encodeURIComponent('Journal intime.md')}&hash=${aliceHash}`)).status).toBe(404);

    // Les fichiers sont dans deux dossiers séparés.
    expect(await readdir(path.join(dir, 'users'))).toEqual(expect.arrayContaining(['111', '222']));
  });

  it('refuse un identifiant de compte anormal', async () => {
    await expect(spaces.get('../autre')).rejects.toThrow();
  });
});
