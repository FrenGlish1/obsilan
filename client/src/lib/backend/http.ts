// Accès aux notes via le serveur Node (mode développement dans un navigateur).
import type { NoteData, SaveResult, TreeEntry, VaultEvent } from '../../../../shared/types.ts';
import { BackendError, type Backend, type NoteContent } from './types.ts';

async function request<T>(method: string, url: string, body?: unknown, keepalive = false): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      keepalive,
    });
  } catch {
    throw new BackendError(0, 'network', 'Serveur injoignable');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new BackendError(res.status, data.error ?? 'error', data.message ?? res.statusText, data);
  return data as T;
}

const q = (path: string) => encodeURIComponent(path);

export class HttpBackend implements Backend {
  readonly kind = 'http' as const;

  loadAll(): Promise<NoteContent[]> {
    return request<{ notes: NoteContent[] }>('GET', '/api/all').then((r) => r.notes);
  }

  tree(): Promise<TreeEntry[]> {
    return request<{ entries: TreeEntry[] }>('GET', '/api/tree').then((r) => r.entries);
  }

  read(path: string): Promise<NoteData> {
    return request<NoteData>('GET', `/api/note?path=${q(path)}`);
  }

  save(path: string, content: string, baseHash?: string): Promise<SaveResult> {
    return request<SaveResult>('PUT', '/api/note', { path, content, baseHash });
  }

  saveOnExit(path: string, content: string, baseHash: string): void {
    request('PUT', '/api/note', { path, content, baseHash }, true).catch(() => {});
  }

  createNote(opts: { path?: string; folder?: string; content?: string }): Promise<SaveResult> {
    return request<SaveResult>('POST', '/api/note', opts);
  }

  createFolder(opts: { path?: string; parent?: string }): Promise<{ path: string }> {
    return request<{ path: string }>('POST', '/api/folder', opts);
  }

  async rename(from: string, to: string): Promise<void> {
    await request('POST', '/api/rename', { from, to });
  }

  async trash(path: string): Promise<void> {
    await request('DELETE', `/api/entry?path=${q(path)}`);
  }

  subscribe(onEvent: (e: VaultEvent) => void, onStatus: (ok: boolean) => void): void {
    const es = new EventSource('/api/events');
    es.onopen = () => onStatus(true);
    es.onerror = () => onStatus(false);
    es.onmessage = (m) => onEvent(JSON.parse(m.data));
  }
}
