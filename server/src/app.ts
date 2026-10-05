import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { config } from './config';
import { AppError } from './lib/errors';
import { uploadRoot } from './lib/uploads';
import authRoutes from './routes/auth';
import kioskRoutes from './routes/kiosk';
import publicRoutes from './routes/public';
import orderRoutes from './routes/orders';
import paymentRoutes from './routes/payments';
import kitchenRoutes from './routes/kitchen';
import menuRoutes from './routes/menu';
import stockRoutes from './routes/stock';
import printerRoutes from './routes/printers';
import deviceRoutes from './routes/devices';
import staffRoutes from './routes/staff';
import settingsRoutes from './routes/settings';
import reportRoutes from './routes/reports';

export async function buildApp(opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger === false ? false : { level: config.logLevel },
    trustProxy: true,
    bodyLimit: 2 * 1024 * 1024,
  });

  await app.register(cors, {
    origin: config.corsOrigins.length ? config.corsOrigins : false,
    credentials: true,
  });
  await app.register(jwt, { secret: config.jwtSecret, sign: { expiresIn: config.jwtTtl } });
  await app.register(multipart, { limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 1 } });
  await app.register(rateLimit, { global: false });

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.status).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err.validation) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: err.message } });
    if (err.statusCode === 429) return reply.status(429).send({ error: { code: 'RATE_LIMITED', message: 'Too many requests' } });
    if (err.statusCode && err.statusCode < 500) return reply.status(err.statusCode).send({ error: { code: err.code ?? 'BAD_REQUEST', message: err.message } });
    if (err.code === '23505') return reply.status(409).send({ error: { code: 'DUPLICATE', message: err.detail ?? 'Duplicate value' } });
    if (err.code === '23503') return reply.status(409).send({ error: { code: 'IN_USE', message: 'Record is referenced by other data' } });
    if (err.code === '22P02' || err.code === '23514') return reply.status(400).send({ error: { code: 'INVALID_VALUE', message: err.message } });
    req.log.error(err);
    return reply.status(500).send({ error: { code: 'INTERNAL', message: 'Internal server error' } });
  });

  app.get('/api/health', async () => ({ ok: true, time: new Date().toISOString(), version: process.env.npm_package_version ?? '1.0.0' }));

  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(kioskRoutes, { prefix: '/api/kiosk' });
  await app.register(publicRoutes, { prefix: '/api/public' });
  await app.register(orderRoutes, { prefix: '/api/orders' });
  await app.register(paymentRoutes, { prefix: '/api/payments' });
  await app.register(kitchenRoutes, { prefix: '/api/kitchen' });
  await app.register(menuRoutes, { prefix: '/api/menu' });
  await app.register(stockRoutes, { prefix: '/api/stock' });
  await app.register(printerRoutes, { prefix: '/api/print' });
  await app.register(deviceRoutes, { prefix: '/api/devices' });
  await app.register(staffRoutes, { prefix: '/api/staff' });
  await app.register(settingsRoutes, { prefix: '/api/settings' });
  await app.register(reportRoutes, { prefix: '/api/reports' });

  fs.mkdirSync(uploadRoot(), { recursive: true });
  await app.register(fastifyStatic, {
    root: uploadRoot(),
    prefix: '/uploads/',
    decorateReply: false,
    maxAge: '30d',
    immutable: true,
    setHeaders: (res: any) => {
      const set = (k: string, v: string) => (typeof res.setHeader === 'function' ? res.setHeader(k, v) : res.header(k, v));
      set('X-Content-Type-Options', 'nosniff');
      set('Access-Control-Allow-Origin', '*');
    },
  });

  // Production: serve the built PWA with SPA fallback.
  const webDist = path.resolve(config.webDist);
  if (fs.existsSync(path.join(webDist, 'index.html'))) {
    await app.register(fastifyStatic, { root: webDist, prefix: '/', wildcard: false, decorateReply: true });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.url.startsWith('/uploads/') || req.url.startsWith('/socket.io')) {
        return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
      }
      return reply.type('text/html').sendFile('index.html');
    });
  }
  return app;
}
