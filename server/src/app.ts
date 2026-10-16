// Construction de l'application Fastify (séparée du démarrage pour pouvoir
// la tester sans ouvrir de port réseau).
import Fastify, { type FastifyInstance } from 'fastify';
import { config } from './config.ts';
import { HttpError, type Vault } from './vault.ts';
import { registerRoutes } from './routes.ts';

export interface AppOptions {
  logger?: boolean;
  /** Certificat HTTPS (sinon HTTP). */
  https?: { key: string; cert: string };
  /** API sans authentification pour l'interface web de développement. */
  devApi?: boolean;
}

export async function buildApp(vault: Vault | null, opts: AppOptions | boolean = {}): Promise<FastifyInstance> {
  const o: AppOptions = typeof opts === 'boolean' ? { logger: opts, devApi: true } : { devApi: true, logger: true, ...opts };
  const app = Fastify({
    bodyLimit: config.bodyLimit,
    logger: o.logger ? { level: process.env.LOG_LEVEL ?? 'info' } : false,
    ...(o.https ? { https: o.https } : {}),
  }) as unknown as FastifyInstance;

  // Erreurs : format JSON uniforme { error, message } compris par le client.
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      reply.status(err.status).send({ error: err.code, message: err.message, ...err.extra });
      return;
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) req.log.error(err);
    reply.status(status).send({ error: 'server_error', message: (err as Error).message });
  });

  if (o.devApi && vault) await registerRoutes(app, vault);
  return app;
}
