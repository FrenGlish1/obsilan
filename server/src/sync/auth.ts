// Connexion des appareils avec Discord.
//
// Déroulé (aucun mot de passe ne transite par ObsiLan) :
//   1. l'application demande une connexion : POST /api/auth/start ;
//   2. elle ouvre le navigateur sur /auth/discord?login=… → page de Discord ;
//   3. Discord renvoie vers /auth/discord/callback ; le serveur vérifie que
//      le compte fait partie des comptes autorisés ;
//   4. pendant ce temps l'application interroge /api/auth/poll et reçoit
//      un jeton d'appareil, valable jusqu'à sa révocation.
// Les jetons sont stockés sous forme d'empreinte (SHA-256) : même un vol du
// fichier devices.json ne permet pas de se connecter.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '../atomic.ts';
import { HttpError } from '../vault.ts';
import type { ServerConfig } from './config.ts';

export interface Device {
  id: string;
  userId: string;
  username: string;
  name: string;
  created: number;
  lastSeen: number;
}

interface PendingLogin {
  secret: string;
  deviceName: string;
  created: number;
  state: 'pending' | 'ok' | 'denied';
  token?: string;
  username?: string;
  message?: string;
}

const LOGIN_TTL = 10 * 60 * 1000;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const random = (n = 32) => randomBytes(n).toString('base64url');

export class Auth {
  /** Appareils connectés, indexés par empreinte de jeton. */
  private devices = new Map<string, Device>();
  private pending = new Map<string, PendingLogin>();
  private readonly file: string;
  private saveTimer: NodeJS.Timeout | undefined;

  constructor(
    private cfg: ServerConfig,
    dataDir: string,
    private baseUrl: string,
  ) {
    this.file = path.join(dataDir, 'devices.json');
    if (existsSync(this.file)) {
      try {
        this.devices = new Map(Object.entries(JSON.parse(readFileSync(this.file, 'utf8'))));
      } catch {
        console.error('[connexion] devices.json illisible : les appareils devront se reconnecter.');
      }
    }
  }

  get redirectUri(): string {
    return `${this.baseUrl}/auth/discord/callback`;
  }

  private persist(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      writeFileAtomic(this.file, JSON.stringify(Object.fromEntries(this.devices), null, 2)).catch((e) =>
        console.error('[connexion] devices.json non enregistré', e),
      );
    }, 200);
  }

  /** Nettoie les demandes de connexion expirées. */
  private sweep(): void {
    const now = Date.now();
    for (const [id, p] of this.pending) if (now - p.created > LOGIN_TTL) this.pending.delete(id);
  }

  /** Étape 1 : nouvelle demande de connexion. */
  start(deviceName: string): { loginId: string; pollSecret: string; url: string } {
    if (!this.cfg.discord) throw new HttpError(503, 'no_discord', 'Connexion Discord non configurée sur le serveur.');
    this.sweep();
    const loginId = random(18);
    const pollSecret = random(24);
    this.pending.set(loginId, {
      secret: pollSecret,
      deviceName: deviceName.slice(0, 60) || 'Appareil',
      created: Date.now(),
      state: 'pending',
    });
    return { loginId, pollSecret, url: `${this.baseUrl}/auth/discord?login=${loginId}` };
  }

  /** Étape 2 : adresse de la page d'autorisation Discord. */
  discordUrl(loginId: string): string {
    const d = this.cfg.discord;
    if (!d || !this.pending.has(loginId)) throw new HttpError(400, 'expired', 'Demande de connexion expirée. Relancez-la depuis ObsiLan.');
    const q = new URLSearchParams({
      client_id: d.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: 'identify',
      state: loginId,
      prompt: 'none',
    });
    return `https://discord.com/oauth2/authorize?${q}`;
  }

  /** Étape 3 : retour de Discord. Renvoie le message à afficher dans le navigateur. */
  async callback(code: string | undefined, state: string | undefined, error?: string): Promise<{ ok: boolean; message: string }> {
    const d = this.cfg.discord!;
    const login = state ? this.pending.get(state) : undefined;
    if (!login) return { ok: false, message: 'Demande de connexion expirée. Relancez-la depuis ObsiLan.' };
    if (error || !code) {
      login.state = 'denied';
      login.message = 'Connexion annulée sur Discord.';
      return { ok: false, message: login.message };
    }
    try {
      const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: d.clientId,
          client_secret: d.clientSecret,
          grant_type: 'authorization_code',
          code,
          redirect_uri: this.redirectUri,
        }),
      });
      if (!tokenRes.ok) throw new Error(`Discord a refusé le code (${tokenRes.status}). Vérifiez le Client Secret et l'adresse de redirection.`);
      const { access_token } = (await tokenRes.json()) as { access_token: string };
      const userRes = await fetch('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${access_token}` } });
      if (!userRes.ok) throw new Error(`Profil Discord illisible (${userRes.status}).`);
      const user = (await userRes.json()) as { id: string; username: string; global_name?: string };

      if (!d.allowedUserIds.map(String).includes(user.id)) {
        login.state = 'denied';
        login.message = `Le compte Discord « ${user.username} » (${user.id}) n'est pas autorisé sur ce serveur.`;
        console.warn('[connexion] refusée :', login.message);
        return { ok: false, message: login.message };
      }

      const token = random(32);
      const now = Date.now();
      this.devices.set(sha(token), {
        id: random(8),
        userId: user.id,
        username: user.global_name || user.username,
        name: login.deviceName,
        created: now,
        lastSeen: now,
      });
      this.persist();
      login.state = 'ok';
      login.token = token;
      login.username = user.global_name || user.username;
      console.log(`[connexion] nouvel appareil « ${login.deviceName} » pour ${user.username}`);
      return { ok: true, message: `Connecté en tant que ${login.username}. Vous pouvez revenir dans ObsiLan.` };
    } catch (err) {
      login.state = 'denied';
      login.message = (err as Error).message;
      console.error('[connexion] échec :', login.message);
      return { ok: false, message: login.message };
    }
  }

  /** Étape 4 : l'application récupère son jeton (une seule fois). */
  poll(loginId: string, secret: string): { status: 'pending' | 'ok' | 'denied'; token?: string; username?: string; message?: string } {
    const login = this.pending.get(loginId);
    if (!login) return { status: 'denied', message: 'Demande de connexion expirée.' };
    const a = Buffer.from(login.secret);
    const b = Buffer.from(String(secret));
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new HttpError(403, 'forbidden', 'Secret invalide.');
    if (login.state === 'pending') return { status: 'pending' };
    this.pending.delete(loginId);
    return { status: login.state, token: login.token, username: login.username, message: login.message };
  }

  /** Vérifie l'en-tête « Authorization: Bearer … ». */
  verify(header: string | undefined): Device {
    const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) throw new HttpError(401, 'unauthorized', 'Connexion requise.');
    if (this.cfg.devToken && token === this.cfg.devToken) {
      return { id: 'dev', userId: 'dev', username: 'dev', name: 'test', created: 0, lastSeen: Date.now() };
    }
    const device = this.devices.get(sha(token));
    if (!device) throw new HttpError(401, 'unauthorized', 'Appareil non reconnu ou déconnecté. Reconnectez-vous.');
    // Mise à jour de « vu pour la dernière fois », au plus une fois par heure.
    if (Date.now() - device.lastSeen > 3600_000) {
      device.lastSeen = Date.now();
      this.persist();
    }
    return device;
  }

  /** Déconnecte l'appareil qui présente ce jeton. */
  revoke(header: string | undefined): void {
    const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (this.devices.delete(sha(token))) this.persist();
  }

  list(): Device[] {
    return [...this.devices.values()];
  }
}
