// Appels HTTP vers le serveur de synchronisation.
import type { NoteData } from '../../../../shared/types.ts';

export class SyncError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public data: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export interface RemoteFile {
  path: string;
  content: string;
  hash: string;
}

/** Normalise l'adresse saisie : « monserveur.duckdns.org:25600 » → « https://monserveur.duckdns.org:25600 ». */
export function normalizeServerUrl(raw: string): string {
  let url = raw.trim().replace(/\/+$/, '');
  if (url && !/^https?:\/\//i.test(url)) url = 'https://' + url;
  return url;
}

export class SyncClient {
  constructor(
    public baseUrl: string,
    public token: string | null = null,
  ) {}

  private async request<T>(method: string, path: string, body?: unknown, auth = true): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.baseUrl + path, {
        method,
        headers: {
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(auth && this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new SyncError(0, 'network', 'Serveur injoignable (pas de connexion ?)');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new SyncError(res.status, data.error ?? 'error', data.message ?? res.statusText, data);
    return data as T;
  }

  info() {
    return this.request<{ name: string; version: string; login: 'discord' | 'token' }>('GET', '/api/sync/info', undefined, false);
  }

  startLogin(deviceName: string) {
    return this.request<{ loginId: string; pollSecret: string; url: string }>('POST', '/api/auth/start', { deviceName }, false);
  }

  pollLogin(loginId: string, pollSecret: string) {
    return this.request<{ status: 'pending' | 'ok' | 'denied'; token?: string; username?: string; message?: string }>(
      'POST', '/api/auth/poll', { loginId, pollSecret }, false,
    );
  }

  me() {
    return this.request<{ username: string; device: string }>('GET', '/api/auth/me');
  }

  logout() {
    return this.request('POST', '/api/auth/logout', {});
  }

  changes(since: number, epoch: string | null) {
    const q = new URLSearchParams({ since: String(since), epoch: epoch ?? '' });
    return this.request<{ epoch: string; rev: number; full: boolean; changes: { path: string; hash: string | null }[] }>(
      'GET', `/api/sync/changes?${q}`,
    );
  }

  /** Télécharge plusieurs notes (par paquets de 100). */
  async download(paths: string[]): Promise<Map<string, RemoteFile>> {
    const out = new Map<string, RemoteFile>();
    for (let i = 0; i < paths.length; i += 100) {
      const r = await this.request<{ files: RemoteFile[] }>('POST', '/api/sync/download', { paths: paths.slice(i, i + 100) });
      for (const f of r.files) out.set(f.path, f);
    }
    return out;
  }

  /** Envoie une note. Lève une SyncError 409 (data.current) si le serveur a changé. */
  upload(path: string, content: string, baseHash: string | null) {
    return this.request<{ hash: string; rev: number }>('PUT', '/api/sync/file', { path, content, baseHash });
  }

  remove(path: string, baseHash: string) {
    return this.request<{ rev: number }>('POST', '/api/sync/delete', { path, baseHash });
  }

  /** Ancienne version (base de fusion) ; null si le serveur ne l'a plus. */
  async blob(path: string, hash: string): Promise<string | null> {
    try {
      const q = new URLSearchParams({ path, hash });
      return (await this.request<{ content: string }>('GET', `/api/sync/blob?${q}`)).content;
    } catch (err) {
      if (err instanceof SyncError && err.status === 404) return null;
      throw err;
    }
  }
}

export type { NoteData };
