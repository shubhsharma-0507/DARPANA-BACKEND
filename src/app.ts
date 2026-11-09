import cookieParser from 'cookie-parser';
import cors from 'cors';
import crypto from 'crypto';
import express, { NextFunction, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { env, isProd } from './config/env';
import { errorHandler } from './utils/errors';
import authRoutes from './modules/auth/auth.routes';
import catalogRoutes from './modules/catalog/catalog.routes';
import skinRoutes, { ingredientGuide } from './modules/skin/skin.routes';
import buyerRoutes from './modules/commerce/buyer.routes';
import sellerRoutes from './modules/seller/seller.routes';
import adminRoutes from './modules/admin/admin.routes';
import uploadRoutes from './modules/uploads/uploads.routes';
import aiRoutes from './modules/ai/ai.routes';
import { razorpayWebhook } from './modules/commerce/webhook';
import { wrap } from './utils/errors';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use((req, _res, next) => { req.requestId = crypto.randomUUID(); next(); });
  app.use(helmet());
  app.use(cors({ origin: [env.WEB_ORIGIN], credentials: true, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] }));
  app.use(rateLimit({ windowMs: 60e3, limit: 300, standardHeaders: true, legacyHeaders: false }));

  // Razorpay webhook needs the raw body for signature verification, so it is mounted before express.json().
  app.post('/api/v1/webhooks/razorpay', express.raw({ type: '*/*', limit: '1mb' }), wrap(razorpayWebhook as any));

  app.use(express.json({ limit: '200kb' }));
  app.use(cookieParser());

  // CSRF defence: state-changing requests must come from the allow-listed Origin (cookies are SameSite=Lax too).
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || req.path.startsWith('/api/v1/webhooks/')) return next();
    const origin = req.headers.origin ?? (req.headers.referer ? new URL(req.headers.referer).origin : undefined);
    if (origin && origin !== env.WEB_ORIGIN) return res.status(403).json({ code: 'BAD_ORIGIN', message: 'Request origin not allowed', requestId: req.requestId });
    if (!origin && isProd) return res.status(403).json({ code: 'BAD_ORIGIN', message: 'Request origin required', requestId: req.requestId });
    next();
  });

  app.get('/api/v1/health', (_req, res) => res.json({ ok: true, service: 'darpana-api', time: new Date().toISOString() }));
  const authLimiter = rateLimit({ windowMs: 15 * 60e3, limit: 40, standardHeaders: true, legacyHeaders: false });
  app.use('/api/v1/auth', authLimiter, authRoutes);
  app.use('/api/v1/seller', sellerRoutes);
  app.use('/api/v1/admin', adminRoutes);
  app.use('/api/v1/uploads', uploadRoutes);
  app.use('/api/v1/ai', aiRoutes);
  app.use('/api/v1', catalogRoutes);
  app.use('/api/v1', ingredientGuide);
  app.use('/api/v1/me', skinRoutes);          // /me/skin-profile, /me/shelf, /me/shade-finder/*, /me/skin-match/*
  app.use('/api/v1', buyerRoutes);            // MUST stay last: its router-level guard is BUYER-only
  app.use('/api/v1', (_req, res) => res.status(404).json({ code: 'NOT_FOUND', message: 'Route not found' }));
  app.use(errorHandler);
  return app;
}
