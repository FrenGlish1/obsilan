// Tests des cas critiques du serveur : écritures, conflits, renommages, corbeille,
// sécurité des chemins et recherche. Chaque test travaille dans un coffre temporaire.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { Vault } from '../server/src/vault.ts';
import { buildApp } from '../server/src/app.ts';
import { normalizePath } from '../shared/paths.ts';

let dir: string;
let vault: Vault;
let app: FastifyInstance;

async function api(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, body?: object) {
  const res = await app.inject({ method, url, payload: body });
  return { status: res.statusCode, json: res.json() };
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'obsilan-test-'));
  vault = new Vault(dir);
  await vault.init();
  app = await buildApp(vault, false);
});

afterEach(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

describe('coffre', () => {
  it('crée une note de bienvenue dans un coffre vide', async () => {
    const { json } = await api('GET', '/api/tree');
    expect(json.entries.map((e: { path: string }) => e.path)).toEqual(['Bienvenue.md']);
  });

  it('enregistre une note et la relit à l’identique (UTF-8)', async () => {
    const content = '# Été\n\nCafé, crème brûlée et émojis 🎉\n';
    await api('PUT', '/api/note', { path: 'Dossier/Note.md', content });
    const { json } = await api('GET', '/api/note?path=' + encodeURIComponent('Dossier/Note.md'));
    expect(json.content).toBe(content);
    expect(await readFile(path.join(dir, 'Dossier', 'Note.md'), 'utf8')).toBe(content);
  });

  it('ne laisse aucun fichier temporaire après écriture', async () => {
    for (let i = 0; i < 20; i++) await api('PUT', '/api/note', { path: 'a.md', content: 'v' + i });
    const files = await readdir(dir);
    expect(files.filter((f) => f.includes('tmp'))).toEqual([]);
  });

  it('nomme automatiquement les nouvelles notes sans écraser', async () => {
    const a = await api('POST', '/api/note', {});
    const b = await api('POST', '/api/note', {});
    expect(a.json.path).toBe('Sans titre.md');
    expect(b.json.path).toBe('Sans titre 1.md');
    const c = await api('POST', '/api/note', { path: 'Sans titre.md' });
    expect(c.status).toBe(409);
  });
});

describe('conflits', () => {
  it('refuse une sauvegarde basée sur une version périmée (409) sans rien écraser', async () => {
    const v1 = await api('PUT', '/api/note', { path: 'n.md', content: 'v1' });
    await api('PUT', '/api/note', { path: 'n.md', content: 'v2 (autre appareil)', baseHash: v1.json.hash });
    const res = await api('PUT', '/api/note', { path: 'n.md', content: 'v2 (ici)', baseHash: v1.json.hash });
    expect(res.status).toBe(409);
    expect(res.json.current.content).toBe('v2 (autre appareil)');
    expect(await readFile(path.join(dir, 'n.md'), 'utf8')).toBe('v2 (autre appareil)');
  });

  it('accepte si le contenu envoyé est déjà celui du disque', async () => {
    const v1 = await api('PUT', '/api/note', { path: 'n.md', content: 'v1' });
    await api('PUT', '/api/note', { path: 'n.md', content: 'v2', baseHash: v1.json.hash });
    const res = await api('PUT', '/api/note', { path: 'n.md', content: 'v2', baseHash: v1.json.hash });
    expect(res.status).toBe(200);
  });

  it('détecte une modification externe (ex. Obsidian)', async () => {
    const v1 = await api('PUT', '/api/note', { path: 'n.md', content: 'v1' });
    await writeFile(path.join(dir, 'n.md'), 'modifié par Obsidian');
    const res = await api('PUT', '/api/note', { path: 'n.md', content: 'v2', baseHash: v1.json.hash });
    expect(res.status).toBe(409);
  });

  it('recrée une note supprimée ailleurs plutôt que de perdre la saisie', async () => {
    const v1 = await api('PUT', '/api/note', { path: 'n.md', content: 'v1' });
    await api('DELETE', '/api/entry?path=n.md');
    const res = await api('PUT', '/api/note', { path: 'n.md', content: 'v2', baseHash: v1.json.hash });
    expect(res.status).toBe(200);
  });
});

describe('renommage et corbeille', () => {
  it('refuse d’écraser une note existante', async () => {
    await api('PUT', '/api/note', { path: 'a.md', content: 'A' });
    await api('PUT', '/api/note', { path: 'b.md', content: 'B' });
    const res = await api('POST', '/api/rename', { from: 'a.md', to: 'b.md' });
    expect(res.status).toBe(409);
    expect(await readFile(path.join(dir, 'b.md'), 'utf8')).toBe('B');
  });

  it('autorise un changement de casse seul', async () => {
    await api('PUT', '/api/note', { path: 'note.md', content: 'x' });
    const res = await api('POST', '/api/rename', { from: 'note.md', to: 'Note.md' });
    expect(res.status).toBe(200);
    expect(await readdir(dir)).toContain('Note.md');
  });

  it('déplace un dossier et met l’index de recherche à jour', async () => {
    await api('PUT', '/api/note', { path: 'Projets/Idée.md', content: 'girafe' });
    await api('POST', '/api/rename', { from: 'Projets', to: 'Archives/Projets' });
    const { json } = await api('GET', '/api/search?q=girafe');
    expect(json.hits.map((h: { path: string }) => h.path)).toEqual(['Archives/Projets/Idée.md']);
  });

  it('refuse de déplacer un dossier dans lui-même', async () => {
    await api('POST', '/api/folder', { path: 'A' });
    const res = await api('POST', '/api/rename', { from: 'A', to: 'A/B' });
    expect(res.status).toBe(400);
  });

  it('met à la corbeille au lieu de supprimer, sans collision', async () => {
    await api('PUT', '/api/note', { path: 'n.md', content: '1' });
    await api('DELETE', '/api/entry?path=n.md');
    await api('PUT', '/api/note', { path: 'n.md', content: '2' });
    await api('DELETE', '/api/entry?path=n.md');
    const trash = await readdir(path.join(dir, '.trash'));
    expect(trash).toHaveLength(2);
    const tree = await api('GET', '/api/tree');
    expect(tree.json.entries.some((e: { path: string }) => e.path.startsWith('.trash'))).toBe(false);
  });
});

describe('sécurité des chemins', () => {
  it.each(['../x.md', 'a/../../x.md', '.obsidian/app.json', 'C:\\Windows\\x.md', 'a?.md', ''])(
    'rejette %s',
    (p) => expect(normalizePath(p)).toBeNull(),
  );

  it('normalise les séparateurs', () => {
    expect(normalizePath('a\\b//c.md')).toBe('a/b/c.md');
  });

  it('l’API refuse un chemin hors du coffre', async () => {
    const res = await api('GET', '/api/note?path=' + encodeURIComponent('../secret.md'));
    expect(res.status).toBe(400);
  });
});

describe('recherche', () => {
  it('ignore accents et casse, et cherche par préfixe', async () => {
    await api('PUT', '/api/note', { path: 'Réunion.md', content: 'Préparer la réunion de l’été' });
    const { json } = await api('GET', '/api/search?q=ETE reun');
    expect(json.hits[0].path).toBe('Réunion.md');
    expect(json.hits[0].snippet).toContain('été');
  });

  it('reste rapide avec 5 000 notes', async () => {
    const big = new Vault(dir);
    for (let i = 0; i < 5000; i++) big.index.upsert(`n${i}.md`, `note numéro ${i} sur le thème ${i % 50}`, String(i));
    const t0 = performance.now();
    const hits = big.index.search('thème 42');
    expect(hits.length).toBeGreaterThan(0);
    expect(performance.now() - t0).toBeLessThan(200);
  });
});
