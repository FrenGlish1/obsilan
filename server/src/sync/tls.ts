// HTTPS automatique avec Let's Encrypt, sans rien installer d'autre.
//
// Let's Encrypt doit vérifier que le domaine nous appartient : on utilise le
// défi « DNS-01 », en publiant une valeur temporaire dans un enregistrement TXT
// via l'API DuckDNS. Aucun port supplémentaire (80) n'est nécessaire.
// Le certificat (valable 90 jours) est renouvelé automatiquement à 30 jours de l'échéance.
import * as acme from 'acme-client';
import { Resolver } from 'node:dns/promises';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { writeFileAtomic } from '../atomic.ts';
import type { ServerConfig } from './config.ts';

export interface Certificate {
  key: string;
  cert: string;
}

type Log = (msg: string) => void;

const RENEW_BEFORE_DAYS = 30;

/** Appel de l'API DuckDNS. */
async function duck(params: Record<string, string>): Promise<string> {
  const res = await fetch(`https://www.duckdns.org/update?${new URLSearchParams(params)}`);
  const text = (await res.text()).trim();
  if (!text.startsWith('OK')) throw new Error(`DuckDNS a répondu « ${text} » : vérifiez duckdns.domain et duckdns.token.`);
  return text;
}

/** Met à jour l'IP publique du sous-domaine (DuckDNS détecte l'IP de la requête). */
export async function updateDuckDnsIp(cfg: ServerConfig): Promise<string> {
  const d = cfg.duckdns!;
  const r = await duck({ domains: d.domain, token: d.token, ip: '', verbose: 'true' });
  return r.split('\n')[1] ?? '';
}

/** Mise à jour de l'IP toutes les 5 minutes (box avec IP qui change). */
export function startDuckDnsUpdater(cfg: ServerConfig, log: Log): void {
  let lastIp = '';
  const tick = async () => {
    try {
      const ip = await updateDuckDnsIp(cfg);
      if (ip && ip !== lastIp) log(`DuckDNS : ${cfg.duckdns!.domain}.duckdns.org → ${ip}`);
      lastIp = ip;
    } catch (err) {
      log(`DuckDNS : mise à jour de l'IP impossible (${(err as Error).message})`);
    }
  };
  tick();
  setInterval(tick, 5 * 60 * 1000).unref();
}

/** Attend que l'enregistrement TXT soit visible sur des DNS publics. */
async function waitForTxt(name: string, value: string, log: Log): Promise<void> {
  const resolver = new Resolver();
  resolver.setServers(['1.1.1.1', '8.8.8.8']);
  for (let i = 0; i < 40; i++) {
    try {
      const records = (await resolver.resolveTxt(name)).map((r) => r.join(''));
      if (records.includes(value)) return;
    } catch {
      // Pas encore visible.
    }
    if (i === 0) log('Let\'s Encrypt : attente de la propagation DNS…');
    await new Promise((r) => setTimeout(r, 5000));
  }
  log('Let\'s Encrypt : enregistrement DNS toujours invisible, on tente quand même.');
}

function daysLeft(certPem: string): number {
  const info = acme.crypto.readCertificateInfo(certPem);
  return (info.notAfter.getTime() - Date.now()) / 86_400_000;
}

/** Demande un nouveau certificat à Let's Encrypt. */
async function issue(cfg: ServerConfig, dir: string, log: Log): Promise<Certificate> {
  const d = cfg.duckdns!;
  const host = `${d.domain}.duckdns.org`;
  const accountFile = path.join(dir, 'account.pem');
  const accountKey = existsSync(accountFile) ? readFileSync(accountFile) : await acme.crypto.createPrivateKey();
  if (!existsSync(accountFile)) await writeFileAtomic(accountFile, accountKey);

  const client = new acme.Client({
    directoryUrl: cfg.acmeStaging ? acme.directory.letsencrypt.staging : acme.directory.letsencrypt.production,
    accountKey,
  });
  const [key, csr] = await acme.crypto.createCsr({ commonName: host });
  log(`Let's Encrypt : demande d'un certificat pour ${host}${cfg.acmeStaging ? ' (serveur de TEST)' : ''}…`);

  const cert = await client.auto({
    csr,
    email: cfg.acmeEmail,
    termsOfServiceAgreed: true,
    challengePriority: ['dns-01'],
    challengeCreateFn: async (_authz, _challenge, keyAuthorization) => {
      // Pour le défi DNS-01, keyAuthorization est la valeur à publier.
      await duck({ domains: d.domain, token: d.token, txt: keyAuthorization });
      await waitForTxt(`_acme-challenge.${host}`, keyAuthorization, log);
    },
    challengeRemoveFn: async () => {
      await duck({ domains: d.domain, token: d.token, txt: '', clear: 'true' }).catch(() => undefined);
    },
  });

  const out = { key: key.toString(), cert };
  await writeFileAtomic(path.join(dir, 'key.pem'), out.key);
  await writeFileAtomic(path.join(dir, 'cert.pem'), out.cert);
  log(`Let's Encrypt : certificat obtenu, valable ${Math.floor(daysLeft(cert))} jours.`);
  return out;
}

/** Certificat valide : celui sur le disque s'il expire dans plus de 30 jours, sinon un nouveau. */
export async function ensureCertificate(cfg: ServerConfig, dataDir: string, log: Log): Promise<Certificate> {
  const dir = path.join(dataDir, 'certs');
  await mkdir(dir, { recursive: true });
  const keyFile = path.join(dir, 'key.pem');
  const certFile = path.join(dir, 'cert.pem');
  if (existsSync(keyFile) && existsSync(certFile)) {
    const cert = readFileSync(certFile, 'utf8');
    try {
      if (daysLeft(cert) > RENEW_BEFORE_DAYS) return { key: readFileSync(keyFile, 'utf8'), cert };
    } catch {
      // Certificat illisible : on en redemande un.
    }
  }
  return issue(cfg, dir, log);
}

/** Vérifie chaque jour et renouvelle le certificat sans redémarrer le serveur. */
export function scheduleRenewal(
  cfg: ServerConfig,
  dataDir: string,
  apply: (c: Certificate) => void,
  log: Log,
): void {
  setInterval(async () => {
    try {
      const cert = readFileSync(path.join(dataDir, 'certs', 'cert.pem'), 'utf8');
      if (daysLeft(cert) > RENEW_BEFORE_DAYS) return;
      apply(await issue(cfg, path.join(dataDir, 'certs'), log));
      log('Certificat renouvelé.');
    } catch (err) {
      log(`Renouvellement du certificat impossible : ${(err as Error).message} (nouvel essai demain)`);
    }
  }, 24 * 3600 * 1000).unref();
}
