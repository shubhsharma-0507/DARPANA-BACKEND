import { Router } from 'express';
import { v2 as cloudinary } from 'cloudinary';
import { z } from 'zod';
import { cloudinaryEnabled, env } from '../../config/env';
import { authenticate, requireRole } from '../../middleware/auth';
import { AppError, forbidden, parse, wrap } from '../../utils/errors';
import { SellerProfile } from '../../models/user';

if (cloudinaryEnabled) cloudinary.config({ cloud_name: env.CLOUDINARY_CLOUD_NAME, api_key: env.CLOUDINARY_API_KEY, api_secret: env.CLOUDINARY_API_SECRET, secure: true });
const r = Router();
r.use(authenticate);

const KINDS = {
  product: { folder: 'products', roles: ['SHOP_OWNER', 'ADMIN'], priv: false, maxBytes: 5_000_000, formats: 'jpg,jpeg,png,webp' },
  shop: { folder: 'shops', roles: ['SHOP_OWNER', 'ADMIN'], priv: false, maxBytes: 3_000_000, formats: 'jpg,jpeg,png,webp' },
  kyc: { folder: 'kyc', roles: ['SHOP_OWNER'], priv: true, maxBytes: 8_000_000, formats: 'jpg,jpeg,png,pdf' },
  review: { folder: 'reviews', roles: ['BUYER'], priv: false, maxBytes: 3_000_000, formats: 'jpg,jpeg,png,webp' },
  avatar: { folder: 'avatars', roles: ['BUYER'], priv: false, maxBytes: 1_000_000, formats: 'jpg,jpeg,png,webp' },
} as const;

/** Returns short-lived signed params. API secret never leaves the server. KYC is uploaded as `authenticated` (no public URL). */
r.post('/signature', requireRole('BUYER', 'SHOP_OWNER', 'ADMIN'), wrap(async (req, res) => {
  if (!cloudinaryEnabled) throw new AppError(503, 'UPLOADS_DISABLED', 'Image uploads are not configured yet');
  const { kind } = parse(z.object({ kind: z.enum(['product', 'shop', 'kyc', 'review', 'avatar']) }), req.body);
  const k = KINDS[kind];
  if (!(k.roles as readonly string[]).includes(req.user!.role)) throw forbidden();
  let owner = req.user!.id;
  if (req.user!.role === 'SHOP_OWNER') { const s = await SellerProfile.findOne({ userId: req.user!.id }).select('_id'); if (!s) throw forbidden(); owner = String(s._id); }
  const timestamp = Math.round(Date.now() / 1000);
  const folder = `darpana/${k.folder}/${owner}`;
  const params: Record<string, string | number> = { timestamp, folder, type: k.priv ? 'authenticated' : 'upload', allowed_formats: k.formats, ...(kind === 'review' || kind === 'avatar' ? { transformation: 'a_exif' } : {}) };
  const signature = cloudinary.utils.api_sign_request(params, env.CLOUDINARY_API_SECRET);
  res.json({ cloudName: env.CLOUDINARY_CLOUD_NAME, apiKey: env.CLOUDINARY_API_KEY, signature, params, maxBytes: k.maxBytes, resourceType: kind === 'kyc' ? 'auto' : 'image', expiresInSeconds: 600 });
}));

/** Frontend reports the uploaded public_id; we verify it lives under the caller's own folder before accepting it. */
r.post('/confirm', wrap(async (req, res) => {
  const b = parse(z.object({ publicId: z.string().min(5).max(200), kind: z.enum(['product', 'shop', 'kyc', 'review', 'avatar']) }), req.body);
  let owner = req.user!.id;
  if (req.user!.role === 'SHOP_OWNER') { const s = await SellerProfile.findOne({ userId: req.user!.id }).select('_id'); owner = String(s?._id); }
  if (!b.publicId.startsWith(`darpana/${KINDS[b.kind].folder}/${owner}/`) && req.user!.role !== 'ADMIN') throw forbidden('This file does not belong to you');
  if (!cloudinaryEnabled) throw new AppError(503, 'UPLOADS_DISABLED', 'Image uploads are not configured yet');
  const info = await cloudinary.api.resource(b.publicId, { resource_type: b.kind === 'kyc' ? 'image' : 'image', type: KINDS[b.kind].priv ? 'authenticated' : 'upload' }).catch(() => null);
  if (!info) throw new AppError(404, 'NOT_FOUND', 'We could not find that upload');
  res.json({ publicId: info.public_id, url: KINDS[b.kind].priv ? undefined : info.secure_url, width: info.width, height: info.height, bytes: info.bytes, format: info.format });
}));
export default r;
