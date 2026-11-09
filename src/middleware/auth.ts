import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { AppError, forbidden, unauthorized } from '../utils/errors';
import { Role, Session, SellerProfile, User } from '../models/user';

export interface AuthUser { id: string; role: Role; sid: string; mfa: boolean; sellerId?: string }
declare global { namespace Express { interface Request { user?: AuthUser; requestId?: string } } }

export const ACCESS_COOKIE = 'dp_access';
export const REFRESH_COOKIE = 'dp_refresh';

export function signAccess(p: { id: string; role: Role; sid: string; mfa: boolean }) {
  return jwt.sign(p, env.JWT_ACCESS_SECRET, { expiresIn: '15m' });
}

/** Verifies JWT, then re-checks live user + session status in DB (role is never trusted from the client). */
export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  try {
    const token = req.cookies?.[ACCESS_COOKIE];
    if (!token) throw unauthorized();
    let payload: any;
    try { payload = jwt.verify(token, env.JWT_ACCESS_SECRET); } catch { throw unauthorized('Session expired'); }
    const [user, session] = await Promise.all([User.findById(payload.id).lean(), Session.findById(payload.sid).lean()]);
    if (!user || !session || session.revokedAt || user.status !== 'active') throw unauthorized('Session is no longer valid');
    req.user = { id: String(user._id), role: user.role, sid: payload.sid, mfa: !!session.mfaPassed };
    next();
  } catch (e) { next(e); }
}

export const optionalAuth = (req: Request, res: Response, next: NextFunction) =>
  req.cookies?.[ACCESS_COOKIE] ? authenticate(req, res, (err?: unknown) => (err ? next() : next())) : next();

/** Default-deny role guard. Admin & seller operational access also requires MFA in production. */
export const requireRole = (...roles: Role[]) => (req: Request, _res: Response, next: NextFunction) => {
  if (!req.user) return next(unauthorized());
  if (!roles.includes(req.user.role)) return next(forbidden());
  if (env.NODE_ENV === 'production' && (req.user.role === 'ADMIN' || req.user.role === 'SHOP_OWNER') && !req.user.mfa) {
    return next(new AppError(403, 'MFA_REQUIRED', 'Two-step verification is required to continue'));
  }
  next();
};

/** Loads the approved seller profile for the signed-in SHOP_OWNER; all seller routes use req.seller.id for ownership. */
export async function requireApprovedSeller(req: Request, _res: Response, next: NextFunction) {
  try {
    const sp = await SellerProfile.findOne({ userId: req.user!.id });
    if (!sp) throw forbidden('Please submit your seller application first');
    if (sp.status !== 'approved') throw forbidden(`Your seller account is ${sp.status.replace('_', ' ')}`);
    (req as any).seller = sp;
    next();
  } catch (e) { next(e); }
}
