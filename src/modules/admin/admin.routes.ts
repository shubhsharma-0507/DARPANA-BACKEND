import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { authenticate, requireRole } from '../../middleware/auth';
import { audit } from '../../middleware/audit';
import { Brand, Category, Ingredient, Listing, Product, Variant } from '../../models/catalog';
import { Order, ReturnRequest, Review, SubOrder } from '../../models/commerce';
import { MatchFeedback, MatchRule } from '../../models/skin';
import { AuditLog, Notification, SellerProfile, Session, User } from '../../models/user';
import { badRequest, conflict, notFound, parse, wrap } from '../../utils/errors';
import { slugify } from '../../utils/slug';
import { recomputeParentStatus, restockSubOrder } from '../commerce/order.service';
import { refundPayment } from '../commerce/payments';
import { SETTING_KEYS, getSetting, setSetting } from '../commerce/settings';
import { sendMail } from '../notifications/mailer';
import { RULES_VERSION, WEIGHTS } from '../matching/engine';

const r = Router();
r.use(authenticate, requireRole('ADMIN'));
const oid = z.string().refine((s) => Types.ObjectId.isValid(s), 'Invalid id');
const reasonSchema = z.object({ reason: z.string().min(3).max(500) });

r.get('/dashboard', wrap(async (_req, res) => {
  const [gmv, orders, buyers, sellers, pendingSellers, pendingProducts, pendingListings, refunds, openReturns, pendingReviews, payable] = await Promise.all([
    Order.aggregate([{ $match: { paymentStatus: { $in: ['captured', 'partially_refunded'] } } }, { $group: { _id: null, gmv: { $sum: '$total' }, n: { $sum: 1 } } }]),
    Order.countDocuments({ status: { $ne: 'pending_payment' } }),
    User.countDocuments({ role: 'BUYER', status: 'active' }), SellerProfile.countDocuments({ status: 'approved' }),
    SellerProfile.countDocuments({ status: { $in: ['submitted', 'under_review'] } }), Product.countDocuments({ approvalStatus: 'submitted' }), Listing.countDocuments({ status: 'submitted' }),
    Order.countDocuments({ paymentStatus: { $in: ['refunded', 'partially_refunded'] } }), ReturnRequest.countDocuments({ status: { $in: ['requested', 'under_review'] } }),
    Review.countDocuments({ 'reports.0': { $exists: true }, moderation: 'approved' }),
    SubOrder.aggregate([{ $match: { status: 'delivered' } }, { $group: { _id: null, payable: { $sum: '$sellerPayable' }, commission: { $sum: '$commission' } } }]),
  ]);
  res.json({ gmv: gmv[0]?.gmv ?? 0, paidOrders: gmv[0]?.n ?? 0, orders, activeBuyers: buyers, activeSellers: sellers, pendingSellers, pendingProducts, pendingListings, refunds, openReturns, reportedReviews: pendingReviews, payoutLiability: payable[0]?.payable ?? 0, commissionEarned: payable[0]?.commission ?? 0 });
}));

r.get('/notifications', wrap(async (_req, res) => {
  const items = await Notification.find({ role: 'ADMIN' }).sort('-createdAt').limit(20).lean();
  res.json({ items, unread: items.filter((i) => !i.readAt).length });
}));
r.post('/notifications/read', wrap(async (_req, res) => { await Notification.updateMany({ role: 'ADMIN', readAt: { $exists: false } }, { readAt: new Date() }); res.json({ ok: true }); }));

// ---------- Users & sellers ----------
r.get('/users', wrap(async (req, res) => {
  const q = parse(z.object({ role: z.enum(['BUYER', 'SHOP_OWNER', 'ADMIN']).optional(), status: z.string().max(30).optional(), search: z.string().max(80).optional(), page: z.coerce.number().min(1).default(1) }), req.query);
  const f: Record<string, unknown> = {};
  if (q.role) f.role = q.role; if (q.status) f.status = q.status;
  if (q.search) f.$or = [{ email: new RegExp(q.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }, { name: new RegExp(q.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }];
  const [items, total] = await Promise.all([User.find(f).sort('-createdAt').skip((q.page - 1) * 25).limit(25).select('name email role status createdAt emailVerifiedAt').lean(), User.countDocuments(f)]);
  res.json({ items, total });
}));
r.post('/users/:id/status', wrap(async (req, res) => {
  const b = parse(reasonSchema.extend({ status: z.enum(['active', 'suspended']) }), req.body);
  const u = await User.findById(parse(oid, req.params.id)); if (!u) throw notFound();
  if (u.role === 'ADMIN') throw badRequest('Admin accounts are managed through the secure provisioning process');
  const before = u.status; u.status = b.status; await u.save();
  if (b.status === 'suspended') await Session.updateMany({ userId: u._id }, { revokedAt: new Date() });
  await audit(req, 'user.status', 'User', String(u._id), { before, after: b.status, reason: b.reason }); res.json({ ok: true });
}));

r.get('/sellers', wrap(async (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  const items = await SellerProfile.find(status ? { status } : {}).sort('-updatedAt').limit(100).populate('userId', 'email name').lean();
  res.json({ items: items.map((s) => ({ ...s, kycComplete: (s.kycDocs?.length ?? 0) > 0 })) });
}));
r.post('/sellers/:id/decision', wrap(async (req, res) => {
  const b = parse(z.object({ decision: z.enum(['under_review', 'approved', 'rejected', 'suspended']), comment: z.string().max(500).optional(), commissionOverridePercent: z.number().min(0).max(60).nullable().optional() }), req.body);
  if (['rejected', 'suspended'].includes(b.decision) && !b.comment) throw badRequest('Add a reason for the seller');
  const s = await SellerProfile.findById(parse(oid, req.params.id)).populate('userId', 'email'); if (!s) throw notFound();
  if (b.decision === 'approved' && !s.kycDocs?.length) throw badRequest('This seller has not submitted KYC documents yet. Ask them to complete the application first.');
  const before = s.status; s.status = b.decision; s.adminComment = b.comment;
  if (b.commissionOverridePercent !== undefined) s.commissionOverridePercent = b.commissionOverridePercent ?? undefined;
  await s.save();
  if (b.decision === 'suspended') { await Listing.updateMany({ sellerId: s._id, status: 'approved' }, { status: 'archived' }); await Session.updateMany({ userId: s.userId }, { revokedAt: new Date() }); }
  await audit(req, 'seller.decision', 'SellerProfile', String(s._id), { before, after: b.decision, reason: b.comment });
  await sendMail((s.userId as any).email, `Your Darpana seller application: ${b.decision.replace('_', ' ')}`, b.comment ?? 'Open your seller dashboard for details.');
  res.json({ ok: true });
}));

// ---------- Catalogue governance ----------
r.get('/products', wrap(async (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : 'submitted';
  const items = await Product.find({ approvalStatus: status }).sort('-updatedAt').limit(100).populate('brandId', 'name').populate('createdBySeller', 'shopName').lean();
  res.json({ items });
}));
r.get('/products/:id', wrap(async (req, res) => {
  const p = await Product.findById(parse(oid, req.params.id)).lean(); if (!p) throw notFound();
  res.json({ product: p, variants: await Variant.find({ productId: p._id }).lean(), listings: await Listing.find({ productId: p._id }).lean() });
}));
r.post('/products/:id/decision', wrap(async (req, res) => {
  const b = parse(z.object({
    decision: z.enum(['approved', 'rejected', 'changes_requested']), note: z.string().max(800).optional(), ingredientsVerified: z.boolean().optional(),
    verifiedClaims: z.array(z.string()).optional(), verifiedSwatchVariantIds: z.array(oid).optional(),
  }), req.body);
  if (b.decision !== 'approved' && !b.note) throw badRequest('Tell the seller what to fix');
  const p = await Product.findById(parse(oid, req.params.id)); if (!p) throw notFound();
  if (b.decision === 'approved' && !p.ingredients.length) throw badRequest('Cannot approve without a full ingredient list');
  const before = p.approvalStatus; p.approvalStatus = b.decision; p.reviewNote = b.note;
  if (b.decision === 'approved') {
    p.ingredientsVerified = !!b.ingredientsVerified;
    p.claims.forEach((c) => { c.verified = !!b.verifiedClaims?.includes(c.text ?? ''); });
    if (b.verifiedSwatchVariantIds?.length) await Variant.updateMany({ _id: { $in: b.verifiedSwatchVariantIds }, productId: p._id }, { swatchVerified: true });
    await Listing.updateMany({ productId: p._id, status: 'submitted' }, { status: 'approved' });
  } else await Listing.updateMany({ productId: p._id, status: 'submitted' }, { status: b.decision === 'rejected' ? 'rejected' : 'draft', reviewNote: b.note });
  await p.save();
  await audit(req, 'product.decision', 'Product', String(p._id), { before, after: b.decision, reason: b.note }); res.json({ ok: true });
}));
r.post('/products/:id/delist', wrap(async (req, res) => {
  const { reason } = parse(reasonSchema, req.body);
  const p = await Product.findByIdAndUpdate(parse(oid, req.params.id), { approvalStatus: 'rejected', reviewNote: reason }); if (!p) throw notFound();
  await Listing.updateMany({ productId: p._id }, { status: 'archived' });
  await audit(req, 'product.delist', 'Product', String(p._id), { reason }); res.json({ ok: true });
}));
r.get('/listings', wrap(async (_req, res) => { res.json({ items: await Listing.find({ status: 'submitted' }).populate('productId', 'title approvalStatus').populate('sellerId', 'shopName').limit(100).lean() }); }));
r.post('/listings/:id/decision', wrap(async (req, res) => {
  const { decision } = parse(z.object({ decision: z.enum(['approved', 'rejected']) }), req.body);
  const l = await Listing.findByIdAndUpdate(parse(oid, req.params.id), { status: decision }); if (!l) throw notFound();
  await audit(req, 'listing.decision', 'SellerListing', String(l._id), { after: decision }); res.json({ ok: true });
}));

const nameSchema = z.object({ name: z.string().min(2).max(80), description: z.string().max(500).optional(), logo: z.string().url().optional(), website: z.string().url().optional(), verified: z.boolean().optional() });
r.post('/brands', wrap(async (req, res) => { const b = parse(nameSchema, req.body); const x = await Brand.create({ ...b, slug: slugify(b.name) }); await audit(req, 'brand.create', 'Brand', String(x._id)); res.status(201).json(x); }));
r.patch('/brands/:id', wrap(async (req, res) => { const b = parse(nameSchema.partial().extend({ status: z.enum(['active', 'pending', 'disabled']).optional() }), req.body); const x = await Brand.findByIdAndUpdate(parse(oid, req.params.id), b, { new: true }); if (!x) throw notFound(); await audit(req, 'brand.update', 'Brand', String(x._id), { after: b }); res.json(x); }));
r.post('/categories', wrap(async (req, res) => {
  const b = parse(z.object({ name: z.string().min(2).max(60), parentId: oid.optional(), sort: z.number().optional() }), req.body);
  const x = await Category.create({ ...b, slug: slugify(b.name) }); await audit(req, 'category.create', 'Category', String(x._id)); res.status(201).json(x);
}));
r.patch('/categories/:id', wrap(async (req, res) => { const b = parse(z.object({ name: z.string().min(2).max(60).optional(), status: z.enum(['active', 'disabled']).optional(), sort: z.number().optional() }), req.body); const x = await Category.findByIdAndUpdate(parse(oid, req.params.id), b, { new: true }); if (!x) throw notFound(); res.json(x); }));

// ---------- Skin Match governance ----------
r.get('/ingredients', wrap(async (_req, res) => { res.json({ items: await Ingredient.find().sort('canonicalName').limit(500).lean() }); }));
const ingSchema = z.object({ canonicalName: z.string().min(2).max(120), aliases: z.array(z.string().max(120)).max(30).default([]), function: z.string().max(200).optional(), explanation: z.string().max(800).optional(), flags: z.array(z.enum(['fragrance', 'irritant', 'comedogenic', 'pregnancy_caution', 'active_retinoid', 'active_acid', 'drying_alcohol', 'allergen'])).default([]), source: z.string().max(300).optional(), verified: z.boolean().default(false), reason: z.string().min(3).max(300) });
r.post('/ingredients', wrap(async (req, res) => { const { reason, ...b } = parse(ingSchema, req.body); const x = await Ingredient.create(b); await audit(req, 'ingredient.create', 'Ingredient', String(x._id), { after: b, reason }); res.status(201).json(x); }));
r.put('/ingredients/:id', wrap(async (req, res) => {
  const { reason, ...b } = parse(ingSchema, req.body);
  const before = await Ingredient.findById(parse(oid, req.params.id)).lean(); if (!before) throw notFound();
  const x = await Ingredient.findByIdAndUpdate(req.params.id, b, { new: true }); await audit(req, 'ingredient.update', 'Ingredient', String(req.params.id), { before, after: b, reason }); res.json(x);
}));
r.get('/match-rules', wrap(async (_req, res) => { res.json({ current: { version: RULES_VERSION, weights: WEIGHTS }, stored: await MatchRule.find().sort('-createdAt').lean(), feedback: await MatchFeedback.aggregate([{ $group: { _id: '$kind', n: { $sum: 1 } } }]) }); }));

// ---------- Orders / returns / reviews ----------
r.get('/orders', wrap(async (_req, res) => { res.json({ items: await Order.find({ status: { $ne: 'pending_payment' } }).sort('-createdAt').limit(100).populate('buyerId', 'email name').lean() }); }));
r.get('/orders/:id', wrap(async (req, res) => { const o = await Order.findById(parse(oid, req.params.id)).lean(); if (!o) throw notFound(); res.json({ order: o, subOrders: await SubOrder.find({ parentOrderId: o._id }).populate('sellerId', 'shopName').lean() }); }));
r.get('/returns', wrap(async (_req, res) => { res.json({ items: await ReturnRequest.find().sort('-createdAt').limit(100).lean() }); }));
r.post('/returns/:id/decision', wrap(async (req, res) => {
  const b = parse(z.object({ decision: z.enum(['approved', 'rejected']), note: z.string().min(3).max(500), refund: z.boolean().default(false) }), req.body);
  const rr = await ReturnRequest.findById(parse(oid, req.params.id)); if (!rr) throw notFound();
  if (['refunded', 'closed'].includes(rr.status ?? '')) throw conflict('This return is already closed');
  rr.adminNote = b.note; rr.status = b.decision === 'rejected' ? 'rejected' : 'approved';
  const sub = await SubOrder.findById(rr.subOrderId);
  if (b.decision === 'approved' && b.refund && sub) {
    const item = sub.items.find((i) => String(i._id) === String(rr.orderItemId));
    const parent = await Order.findById(sub.parentOrderId);
    await refundPayment(parent?.razorpayPaymentId ?? undefined, item?.lineTotal ?? 0, parent?.paymentMethod ?? 'demo');
    rr.status = 'refunded';
    if (parent) { parent.paymentStatus = 'partially_refunded'; await parent.save(); }
    sub.status = 'returned'; sub.timeline.push({ status: 'returned', at: new Date(), note: 'Refunded' }); await sub.save(); await recomputeParentStatus(sub.parentOrderId);
  } else if (b.decision === 'rejected' && sub) { sub.status = 'delivered'; await sub.save(); await recomputeParentStatus(sub.parentOrderId); }
  await rr.save(); await audit(req, 'return.decision', 'ReturnRequest', String(rr._id), { after: rr.status, reason: b.note }); void restockSubOrder;
  res.json(rr);
}));
r.get('/reviews', wrap(async (_req, res) => { res.json({ items: await Review.find({ $or: [{ 'reports.0': { $exists: true } }, { moderation: 'pending' }] }).sort('-updatedAt').limit(100).lean() }); }));
r.post('/reviews/:id/moderate', wrap(async (req, res) => {
  const b = parse(reasonSchema.extend({ moderation: z.enum(['approved', 'rejected']) }), req.body);
  const x = await Review.findByIdAndUpdate(parse(oid, req.params.id), { moderation: b.moderation, ...(b.moderation === 'approved' ? { reports: [] } : {}) }, { new: true }); if (!x) throw notFound();
  const [agg] = await Review.aggregate([{ $match: { productId: x.productId, moderation: 'approved' } }, { $group: { _id: null, avg: { $avg: '$rating' }, n: { $sum: 1 } } }]);
  await Product.updateOne({ _id: x.productId }, { ratingAvg: Math.round((agg?.avg ?? 0) * 10) / 10, ratingCount: agg?.n ?? 0 });
  await audit(req, 'review.moderate', 'Review', String(x._id), { after: b.moderation, reason: b.reason }); res.json({ ok: true });
}));

// ---------- Settlements, settings, audit ----------
r.get('/settlements', wrap(async (_req, res) => {
  const rows = await SubOrder.aggregate([{ $match: { status: 'delivered' } }, { $group: { _id: '$sellerId', gross: { $sum: '$subtotal' }, commission: { $sum: '$commission' }, payable: { $sum: '$sellerPayable' }, orders: { $sum: 1 } } },
    { $lookup: { from: 'sellerprofiles', localField: '_id', foreignField: '_id', as: 's' } }, { $unwind: '$s' }, { $project: { shopName: '$s.shopName', gross: 1, commission: 1, payable: 1, orders: 1 } }]);
  res.json({ items: rows, note: 'Razorpay Route transfers are not enabled. Settle manually and record adjustments with a reason.' });
}));
r.get('/settings', wrap(async (_req, res) => { const out: Record<string, unknown> = {}; for (const k of SETTING_KEYS) out[k] = await getSetting(k); res.json(out); }));
r.put('/settings/:key', wrap(async (req, res) => {
  const key = parse(z.enum(SETTING_KEYS as [string, ...string[]]), req.params.key) as (typeof SETTING_KEYS)[number];
  const { value, reason } = parse(z.object({ value: z.any(), reason: z.string().min(3).max(300) }), req.body);
  const schemas: Record<string, z.ZodTypeAny> = {
    commissionPercent: z.number().min(0).max(60), returnWindowDays: z.number().int().min(0).max(60), payoutHoldDays: z.number().int().min(0).max(60),
    shipping: z.object({ flatPerSeller: z.number().min(0), freeAbove: z.number().min(0) }),
    coupons: z.array(z.object({ code: z.string().min(3).max(30).transform((s) => s.toUpperCase()), percent: z.number().min(1).max(90), minSubtotal: z.number().min(0), active: z.boolean() })).max(50),
  };
  const before = await getSetting(key); const v = parse(schemas[key], value);
  await setSetting(key, v); await audit(req, `settings.${key}`, 'Setting', key, { before, after: v, reason }); res.json({ ok: true });
}));
r.get('/audit-logs', wrap(async (_req, res) => { res.json({ items: await AuditLog.find().sort('-timestamp').limit(200).lean() }); }));

export default r;
