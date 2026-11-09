import { Router, Response, Request } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { OAuth2Client } from 'google-auth-library';
import { authenticator } from 'otplib';
import { env, isProd } from '../../config/env';
import { Session, SellerProfile, User } from '../../models/user';
import { ACCESS_COOKIE, REFRESH_COOKIE, authenticate, signAccess } from '../../middleware/auth';
import { AppError, badRequest, conflict, parse, unauthorized, wrap } from '../../utils/errors';
import { decryptField, encryptField, randomToken, sha256 } from '../../utils/crypto';
import { sendMail } from '../notifications/mailer';
import { notifyAdmins } from '../notifications/notify';

const r = Router();
const REFRESH_DAYS = 14;
const cookieBase = { httpOnly: true, secure: isProd, sameSite: 'lax' as const, path: '/' };

async function issueSession(req: Request, res: Response, userId: string, role: any, family = randomToken(8), mfaPassed = false) {
  const refresh = randomToken(48);
  const session = await Session.create({
    userId, family, refreshHash: sha256(refresh), mfaPassed,
    expiresAt: new Date(Date.now() + REFRESH_DAYS * 864e5), userAgent: req.headers['user-agent'], ip: req.ip,
  });
  res.cookie(ACCESS_COOKIE, signAccess({ id: userId, role, sid: String(session._id), mfa: mfaPassed }), { ...cookieBase, maxAge: 15 * 60e3 });
  res.cookie(REFRESH_COOKIE, `${session._id}.${refresh}`, { ...cookieBase, path: '/api/v1/auth', maxAge: REFRESH_DAYS * 864e5 });
  return session;
}

const pwd = z.string().min(8).max(100).regex(/[A-Za-z]/, 'Include a letter').regex(/[0-9]/, 'Include a number');
const registerSchema = z.object({
  name: z.string().min(2).max(100), email: z.string().email(), password: pwd,
  accountType: z.enum(['BUYER', 'SHOP_OWNER']).default('BUYER'), // ADMIN is never accepted
  adult18Confirmed: z.literal(true, { errorMap: () => ({ message: 'You must be 18 or older' }) }),
  shopName: z.string().min(2).max(120).optional(),
}).strict();

const publicUser = (u: any) => ({ id: String(u._id), name: u.name, email: u.email, role: u.role, emailVerified: !!u.emailVerifiedAt, mfaEnabled: !!u.mfa?.enabled });

r.post('/register', wrap(async (req, res) => {
  const body = parse(registerSchema, req.body);
  if (await User.findOne({ email: body.email.toLowerCase() })) throw conflict('An account with this email already exists');
  if (body.accountType === 'SHOP_OWNER' && !body.shopName) throw new AppError(422, 'VALIDATION_ERROR', 'Shop name is required', { shopName: ['Required'] });
  const verifyToken = randomToken(24);
  const user = await User.create({
    name: body.name, email: body.email, passwordHash: await bcrypt.hash(body.password, 12),
    role: body.accountType, adult18Confirmed: true, emailVerifyHash: sha256(verifyToken),
  });
  if (body.accountType === 'SHOP_OWNER') {
    // The signup itself is the seller request: it appears in the admin queue right away.
    await SellerProfile.create({ userId: user._id, shopName: body.shopName, contactEmail: user.email, status: 'submitted' });
    await notifyAdmins('New seller request', `${body.shopName} (${user.email}) wants to sell on Darpana. Review it under Admin → Sellers & KYC.`, '/admin/sellers');
  }
  await sendMail(user.email, 'Verify your Darpana account', `Verify your email: ${env.WEB_ORIGIN}/verify-email?token=${verifyToken}`);
  await issueSession(req, res, String(user._id), user.role);
  res.status(201).json({ user: publicUser(user), ...(isProd ? {} : { devVerifyToken: verifyToken }) });
}));

r.post('/verify-email', wrap(async (req, res) => {
  const { token } = parse(z.object({ token: z.string().min(10) }), req.body);
  const u = await User.findOneAndUpdate({ emailVerifyHash: sha256(token) }, { $set: { emailVerifiedAt: new Date() }, $unset: { emailVerifyHash: 1 } });
  if (!u) throw badRequest('This verification link is invalid or already used');
  res.json({ ok: true });
}));

r.post('/login', wrap(async (req, res) => {
  const { email, password, mfaCode } = parse(z.object({ email: z.string().email(), password: z.string().min(1), mfaCode: z.string().optional() }), req.body);
  const user = await User.findOne({ email: email.toLowerCase() }).select('+passwordHash +mfa.secretEnc');
  const generic = unauthorized('Incorrect email or password');
  if (!user || !user.passwordHash) throw generic;
  if (user.lockedUntil && user.lockedUntil > new Date()) throw new AppError(429, 'LOCKED', 'Too many attempts. Try again in a few minutes.');
  if (!(await bcrypt.compare(password, user.passwordHash))) {
    user.failedLogins += 1;
    if (user.failedLogins >= 5) { user.lockedUntil = new Date(Date.now() + 15 * 60e3); user.failedLogins = 0; }
    await user.save(); throw generic;
  }
  if (user.status !== 'active') throw unauthorized('This account is not active');
  user.failedLogins = 0; await user.save();
  let mfaPassed = false;
  if (user.mfa?.enabled) {
    if (!mfaCode) return res.status(200).json({ mfaRequired: true });
    if (!user.mfa.secretEnc || !authenticator.check(mfaCode, decryptField(user.mfa.secretEnc))) throw unauthorized('Incorrect verification code');
    mfaPassed = true;
  }
  await issueSession(req, res, String(user._id), user.role, undefined, mfaPassed);
  res.json({ user: publicUser(user), mfaSetupRequired: isProd && user.role !== 'BUYER' && !user.mfa?.enabled });
}));

const google = new OAuth2Client(env.GOOGLE_CLIENT_ID || undefined);
r.post('/google', wrap(async (req, res) => {
  if (!env.GOOGLE_CLIENT_ID) throw new AppError(503, 'GOOGLE_NOT_CONFIGURED', 'Google sign-in is not configured yet');
  const { idToken, adult18Confirmed } = parse(z.object({ idToken: z.string().min(20), adult18Confirmed: z.boolean().optional() }), req.body);
  const ticket = await google.verifyIdToken({ idToken, audience: env.GOOGLE_CLIENT_ID });
  const p = ticket.getPayload();
  if (!p?.email || !p.email_verified || !p.sub) throw unauthorized('Google account email is not verified');
  let user = await User.findOne({ $or: [{ googleSubject: p.sub }, { email: p.email.toLowerCase() }] });
  if (user && !user.googleSubject) { user.googleSubject = p.sub; user.emailVerifiedAt ??= new Date(); await user.save(); } // safe link: verified email only
  if (!user) {
    if (!adult18Confirmed) throw new AppError(422, 'ADULT_REQUIRED', 'Please confirm you are 18 or older to create an account');
    user = await User.create({ email: p.email, name: p.name || p.email.split('@')[0], googleSubject: p.sub, role: 'BUYER', emailVerifiedAt: new Date(), adult18Confirmed: true });
  }
  if (user.status !== 'active') throw unauthorized('This account is not active');
  await issueSession(req, res, String(user._id), user.role);
  res.json({ user: publicUser(user) });
}));

/** Rotating refresh token with reuse detection (revokes whole family). */
r.post('/refresh', wrap(async (req, res) => {
  const raw = req.cookies?.[REFRESH_COOKIE] as string | undefined;
  if (!raw || !raw.includes('.')) throw unauthorized();
  const [sid, token] = raw.split('.');
  const s = await Session.findById(sid).catch(() => null);
  if (!s || s.refreshHash !== sha256(token)) {
    if (s) await Session.updateMany({ family: s.family }, { $set: { revokedAt: new Date() } }); // reuse detected
    throw unauthorized();
  }
  if (s.revokedAt || s.expiresAt < new Date()) throw unauthorized();
  const user = await User.findById(s.userId);
  if (!user || user.status !== 'active') throw unauthorized();
  s.revokedAt = new Date(); await s.save();
  await issueSession(req, res, String(user._id), user.role, s.family, s.mfaPassed);
  res.json({ user: publicUser(user) });
}));

r.post('/logout', wrap(async (req, res) => {
  const raw = req.cookies?.[REFRESH_COOKIE] as string | undefined;
  if (raw) await Session.findByIdAndUpdate(raw.split('.')[0], { revokedAt: new Date() }).catch(() => null);
  res.clearCookie(ACCESS_COOKIE, cookieBase).clearCookie(REFRESH_COOKIE, { ...cookieBase, path: '/api/v1/auth' }).json({ ok: true });
}));
r.post('/logout-all', authenticate, wrap(async (req, res) => {
  await Session.updateMany({ userId: req.user!.id, revokedAt: { $exists: false } }, { $set: { revokedAt: new Date() } });
  res.clearCookie(ACCESS_COOKIE, cookieBase).clearCookie(REFRESH_COOKIE, { ...cookieBase, path: '/api/v1/auth' }).json({ ok: true });
}));

r.post('/forgot-password', wrap(async (req, res) => {
  const { email } = parse(z.object({ email: z.string().email() }), req.body);
  const u = await User.findOne({ email: email.toLowerCase() });
  let dev: string | undefined;
  if (u) {
    const t = randomToken(24); dev = t;
    await User.updateOne({ _id: u._id }, { resetHash: sha256(t), resetExpires: new Date(Date.now() + 30 * 60e3) });
    await sendMail(u.email, 'Reset your Darpana password', `Reset link (valid 30 min): ${env.WEB_ORIGIN}/reset-password?token=${t}`);
  }
  res.json({ ok: true, message: 'If that email exists, a reset link has been sent.', ...(!isProd && dev ? { devResetToken: dev } : {}) });
}));
r.post('/reset-password', wrap(async (req, res) => {
  const { token, password } = parse(z.object({ token: z.string().min(10), password: pwd }), req.body);
  const u = await User.findOne({ resetHash: sha256(token), resetExpires: { $gt: new Date() } }).select('+resetHash +resetExpires');
  if (!u) throw badRequest('This reset link is invalid or has expired');
  u.passwordHash = await bcrypt.hash(password, 12); u.resetHash = undefined; u.resetExpires = undefined; await u.save();
  await Session.updateMany({ userId: u._id }, { $set: { revokedAt: new Date() } });
  res.json({ ok: true });
}));

// ---- MFA (TOTP) ----
r.post('/mfa/setup', authenticate, wrap(async (req, res) => {
  const secret = authenticator.generateSecret();
  await User.updateOne({ _id: req.user!.id }, { 'mfa.secretEnc': encryptField(secret), 'mfa.enabled': false });
  const u = await User.findById(req.user!.id);
  res.json({ secret, otpauthUrl: authenticator.keyuri(u!.email, 'Darpana', secret) });
}));
r.post('/mfa/verify', authenticate, wrap(async (req, res) => {
  const { code } = parse(z.object({ code: z.string().length(6) }), req.body);
  const u = await User.findById(req.user!.id).select('+mfa.secretEnc');
  if (!u?.mfa?.secretEnc || !authenticator.check(code, decryptField(u.mfa.secretEnc))) throw badRequest('Incorrect code');
  u.mfa.enabled = true; await u.save();
  await Session.updateOne({ _id: req.user!.sid }, { mfaPassed: true });
  res.cookie(ACCESS_COOKIE, signAccess({ id: req.user!.id, role: req.user!.role, sid: req.user!.sid, mfa: true }), { ...cookieBase, maxAge: 15 * 60e3 });
  res.json({ ok: true });
}));

r.get('/me', authenticate, wrap(async (req, res) => {
  const u = await User.findById(req.user!.id);
  const sp = u!.role === 'SHOP_OWNER' ? await SellerProfile.findOne({ userId: u!._id }).select('status shopName adminComment kycDocs').lean() : null;
  const seller = sp ? { status: sp.status, shopName: sp.shopName, adminComment: sp.adminComment, kycComplete: (sp.kycDocs?.length ?? 0) > 0 } : null;
  res.json({ user: publicUser(u), seller });
}));

export default r;
