import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { demoPayments, env, razorpayEnabled } from '../../config/env';
import { authenticate, requireRole } from '../../middleware/auth';
import { Listing, Product } from '../../models/catalog';
import { Address, Cart, Order, ReturnRequest, Review, SubOrder, Wishlist } from '../../models/commerce';
import { Session, User } from '../../models/user';
import { SkinProfile } from '../../models/skin';
import { AppError, badRequest, conflict, forbidden, notFound, parse, wrap } from '../../utils/errors';
import { depthGroup } from '../skin/skin.service';
import { buildLines, computeTotals, createOrderWithSubOrders, finalizePaid, recomputeParentStatus, releaseUnpaid, reserveStock, restockSubOrder } from './order.service';
import { razorpay, refundPayment, toPaise, verifyPaymentSignature } from './payments';
import { getSetting } from './settings';

const r = Router();
r.use(authenticate, requireRole('BUYER'));
const oid = z.string().refine((s) => Types.ObjectId.isValid(s), 'Invalid id');

// ---------------- Account ----------------
r.get('/me/profile', wrap(async (req, res) => {
  const u = await User.findById(req.user!.id).select('name email phone emailVerifiedAt createdAt').lean(); res.json({ user: u });
}));
r.patch('/me/profile', wrap(async (req, res) => {
  const b = parse(z.object({ name: z.string().min(2).max(100).optional(), phone: z.string().regex(/^[6-9]\d{9}$/, 'Enter a 10-digit mobile number').optional() }).strict(), req.body);
  await User.updateOne({ _id: req.user!.id }, { $set: b }); res.json({ ok: true });
}));
r.get('/me/sessions', wrap(async (req, res) => {
  const items = await Session.find({ userId: req.user!.id, revokedAt: { $exists: false }, expiresAt: { $gt: new Date() } }).select('userAgent ip createdAt').lean();
  res.json({ items: items.map((s) => ({ ...s, current: String(s._id) === req.user!.sid })) });
}));
r.post('/me/delete-request', wrap(async (req, res) => {
  await User.updateOne({ _id: req.user!.id }, { status: 'deletion_requested' });
  await SkinProfile.deleteOne({ userId: req.user!.id });
  await Session.updateMany({ userId: req.user!.id }, { revokedAt: new Date() });
  res.json({ ok: true, message: 'Your deletion request is recorded and your skin profile is erased.' });
}));

const addressSchema = z.object({ fullName: z.string().min(2).max(100), phone: z.string().regex(/^[6-9]\d{9}$/, 'Enter a 10-digit mobile number'), line1: z.string().min(3).max(200), line2: z.string().max(200).optional(), city: z.string().min(2).max(80), state: z.string().min(2).max(80), pincode: z.string().regex(/^[1-9][0-9]{5}$/, 'Enter a valid 6-digit pincode'), isDefault: z.boolean().optional() }).strict();
r.get('/me/addresses', wrap(async (req, res) => { res.json({ items: await Address.find({ buyerId: req.user!.id }).sort('-isDefault -createdAt').lean() }); }));
r.post('/me/addresses', wrap(async (req, res) => {
  const b = parse(addressSchema, req.body);
  const first = !(await Address.exists({ buyerId: req.user!.id }));
  if (b.isDefault || first) await Address.updateMany({ buyerId: req.user!.id }, { isDefault: false });
  res.status(201).json(await Address.create({ ...b, buyerId: req.user!.id, isDefault: b.isDefault || first }));
}));
r.put('/me/addresses/:id', wrap(async (req, res) => {
  const b = parse(addressSchema, req.body);
  if (b.isDefault) await Address.updateMany({ buyerId: req.user!.id }, { isDefault: false });
  const a = await Address.findOneAndUpdate({ _id: parse(oid, req.params.id), buyerId: req.user!.id }, b, { new: true });
  if (!a) throw notFound(); res.json(a);
}));
r.delete('/me/addresses/:id', wrap(async (req, res) => { await Address.deleteOne({ _id: parse(oid, req.params.id), buyerId: req.user!.id }); res.json({ ok: true }); }));

// ---------------- Wishlist ----------------
r.get('/wishlist', wrap(async (req, res) => {
  const w = await Wishlist.findOne({ userId: req.user!.id }).lean();
  const items = await Product.find({ _id: { $in: w?.productIds ?? [] } }).select('title slug media approvalStatus').lean();
  res.json({ items: items.map((p) => ({ id: String(p._id), title: p.title, slug: p.slug, image: p.media?.[0]?.url, unavailable: p.approvalStatus !== 'approved' })) });
}));
r.post('/wishlist/:productId', wrap(async (req, res) => { await Wishlist.updateOne({ userId: req.user!.id }, { $addToSet: { productIds: parse(oid, req.params.productId) } }, { upsert: true }); res.json({ ok: true }); }));
r.delete('/wishlist/:productId', wrap(async (req, res) => { await Wishlist.updateOne({ userId: req.user!.id }, { $pull: { productIds: parse(oid, req.params.productId) } }); res.json({ ok: true }); }));

// ---------------- Cart (server authoritative) ----------------
async function cartView(userId: string) {
  const cart = await Cart.findOne({ userId }).lean();
  const { lines, problems } = await buildLines(userId, (cart?.items ?? []).map((i) => ({ listingId: String(i.listingId), qty: i.qty ?? 1 })));
  const totals = await computeTotals(lines);
  const groups = new Map<string, any>();
  for (const l of lines) {
    const k = String(l.seller._id);
    const g = groups.get(k) ?? { seller: { id: k, shopName: l.seller.shopName }, items: [], dispatchDays: 0 };
    g.items.push({ listingId: String(l.listing._id), productId: String(l.product._id), slug: l.product.slug, title: l.product.title, variant: l.variant?.name, image: l.product.media?.[0]?.url, qty: l.qty, price: l.unit, mrp: l.listing.mrp, lineTotal: l.total, stock: l.listing.availableQty - l.listing.reservedQty, matchLevel: l.matchLevel ?? null });
    g.dispatchDays = Math.max(g.dispatchDays, l.listing.dispatchDays); groups.set(k, g);
  }
  const hasNotRecommended = lines.some((l) => l.matchLevel === 'not_recommended');
  return { groups: [...groups.values()], problems, subtotal: totals.subtotal, shipping: totals.shipping, total: totals.total, hasNotRecommended, itemCount: lines.reduce((s, l) => s + l.qty, 0) };
}
r.get('/cart', wrap(async (req, res) => { res.json(await cartView(req.user!.id)); }));
r.post('/cart/items', wrap(async (req, res) => {
  const { listingId, qty } = parse(z.object({ listingId: oid, qty: z.number().int().min(1).max(10).default(1) }), req.body);
  const l = await Listing.findOne({ _id: listingId, status: 'approved' }).lean();
  if (!l) throw notFound('This item is not available');
  const cart = (await Cart.findOne({ userId: req.user!.id })) ?? new Cart({ userId: req.user!.id, items: [] });
  const ex = cart.items.find((i) => String(i.listingId) === listingId);
  const next = Math.min(10, (ex?.qty ?? 0) + qty);
  if (next > l.availableQty - l.reservedQty) throw conflict(`Only ${Math.max(0, l.availableQty - l.reservedQty)} available`);
  if (ex) ex.qty = next; else cart.items.push({ listingId: new Types.ObjectId(listingId), qty: next });
  await cart.save(); res.json(await cartView(req.user!.id));
}));
r.patch('/cart/items/:listingId', wrap(async (req, res) => {
  const { qty } = parse(z.object({ qty: z.number().int().min(0).max(10) }), req.body);
  const lid = parse(oid, req.params.listingId);
  if (qty === 0) await Cart.updateOne({ userId: req.user!.id }, { $pull: { items: { listingId: lid } } });
  else await Cart.updateOne({ userId: req.user!.id, 'items.listingId': lid }, { $set: { 'items.$.qty': qty } });
  res.json(await cartView(req.user!.id));
}));
r.post('/cart/merge', wrap(async (req, res) => {
  const { items } = parse(z.object({ items: z.array(z.object({ listingId: oid, qty: z.number().int().min(1).max(10) })).max(30) }), req.body);
  const cart = (await Cart.findOne({ userId: req.user!.id })) ?? new Cart({ userId: req.user!.id, items: [] });
  for (const it of items) {
    if (!(await Listing.exists({ _id: it.listingId, status: 'approved' }))) continue;
    const ex = cart.items.find((i) => String(i.listingId) === it.listingId);
    if (ex) ex.qty = Math.min(10, (ex.qty ?? 0) + it.qty); else cart.items.push({ listingId: new Types.ObjectId(it.listingId), qty: it.qty });
  }
  await cart.save(); res.json(await cartView(req.user!.id));
}));

// ---------------- Checkout ----------------
r.post('/checkout/prepare', wrap(async (req, res) => {
  const { couponCode } = parse(z.object({ couponCode: z.string().max(30).optional() }), req.body ?? {});
  const cart = await Cart.findOne({ userId: req.user!.id }).lean();
  const { lines, problems } = await buildLines(req.user!.id, (cart?.items ?? []).map((i) => ({ listingId: String(i.listingId), qty: i.qty ?? 1 })));
  const t = await computeTotals(lines, couponCode);
  res.json({ problems, subtotal: t.subtotal, shipping: t.shipping, discount: t.discount, total: t.total, couponCode: t.couponCode, notRecommended: lines.filter((l) => l.matchLevel === 'not_recommended').map((l) => l.product.title), paymentMode: razorpayEnabled ? 'razorpay' : demoPayments ? 'demo' : 'unavailable' });
}));

const orderLimiter = rateLimit({ windowMs: 60e3, limit: 10, standardHeaders: true, legacyHeaders: false });
r.post('/orders', orderLimiter, wrap(async (req, res) => {
  const b = parse(z.object({ addressId: oid, couponCode: z.string().max(30).optional(), acknowledgeNotRecommended: z.boolean().optional(), idempotencyKey: z.string().min(8).max(80) }), req.body);
  const existing = await Order.findOne({ buyerId: req.user!.id, idempotencyKey: b.idempotencyKey });
  if (existing) return res.json({ order: existing, payment: existing.razorpayOrderId ? { keyId: env.RAZORPAY_KEY_ID, razorpayOrderId: existing.razorpayOrderId, amount: toPaise(existing.total ?? 0) } : null, mode: existing.paymentMethod });
  if (!razorpayEnabled && !demoPayments) throw new AppError(503, 'PAYMENTS_UNAVAILABLE', 'Online payments are not available right now');
  const address = await Address.findOne({ _id: b.addressId, buyerId: req.user!.id }).lean();
  if (!address) throw notFound('Choose a delivery address');
  const cart = await Cart.findOne({ userId: req.user!.id }).lean();
  if (!cart?.items.length) throw badRequest('Your cart is empty');
  const { lines, problems } = await buildLines(req.user!.id, cart.items.map((i) => ({ listingId: String(i.listingId), qty: i.qty ?? 1 })));
  if (problems.length) throw new AppError(409, 'CART_CHANGED', problems[0]);
  if (lines.some((l) => l.matchLevel === 'not_recommended') && !b.acknowledgeNotRecommended) throw new AppError(409, 'MATCH_ACK_REQUIRED', 'One or more items are marked Not recommended for your profile. Please review and confirm to continue.');
  const totals = await computeTotals(lines, b.couponCode);
  await reserveStock(lines);
  try {
    const { _id, buyerId, createdAt, updatedAt, __v, ...snap } = address as any; void _id; void buyerId; void createdAt; void updatedAt; void __v;
    const mode = razorpayEnabled ? 'razorpay' : 'demo';
    const order = await createOrderWithSubOrders(req.user!.id, lines, totals, snap, { idempotencyKey: b.idempotencyKey, method: mode });
    let payment: unknown = null;
    if (mode === 'razorpay') {
      const rp = await razorpay().orders.create({ amount: toPaise(totals.total), currency: 'INR', receipt: order.orderNumber, notes: { orderId: String(order._id) } });
      order.razorpayOrderId = rp.id; order.paymentStatus = 'pending'; await order.save();
      payment = { keyId: env.RAZORPAY_KEY_ID, razorpayOrderId: rp.id, amount: rp.amount, currency: 'INR' };
    }
    res.status(201).json({ order: { id: String(order._id), orderNumber: order.orderNumber, total: order.total }, payment, mode });
  } catch (e) {
    // roll back reservations if anything after reserve failed
    for (const l of lines) await Listing.updateOne({ _id: l.listing._id, reservedQty: { $gte: l.qty } }, { $inc: { reservedQty: -l.qty } });
    throw e;
  }
}));

r.post('/payments/verify', wrap(async (req, res) => {
  const b = parse(z.object({ razorpay_order_id: z.string(), razorpay_payment_id: z.string(), razorpay_signature: z.string() }), req.body);
  const order = await Order.findOne({ razorpayOrderId: b.razorpay_order_id, buyerId: req.user!.id });
  if (!order) throw notFound('Order not found');
  if (!verifyPaymentSignature(b.razorpay_order_id, b.razorpay_payment_id, b.razorpay_signature)) throw new AppError(400, 'BAD_SIGNATURE', 'Payment could not be verified');
  const done = await finalizePaid(order._id, b.razorpay_payment_id);
  res.json({ ok: true, orderId: String(done!._id), orderNumber: done!.orderNumber });
}));
/** DEMO mode only: refused in production or when Razorpay keys exist. */
r.post('/payments/demo-confirm', wrap(async (req, res) => {
  if (!demoPayments) throw forbidden('Demo payments are disabled');
  const { orderId } = parse(z.object({ orderId: oid }), req.body);
  const o = await Order.findOne({ _id: orderId, buyerId: req.user!.id, paymentMethod: 'demo' });
  if (!o) throw notFound();
  const done = await finalizePaid(o._id, `demo_pay_${Date.now()}`);
  res.json({ ok: true, orderId: String(done!._id), orderNumber: done!.orderNumber, demo: true });
}));

// ---------------- Orders ----------------
r.get('/orders', wrap(async (req, res) => {
  const orders = await Order.find({ buyerId: req.user!.id, status: { $ne: 'pending_payment' } }).sort('-createdAt').limit(50).lean();
  const subs = await SubOrder.find({ parentOrderId: { $in: orders.map((o) => o._id) } }).select('parentOrderId items.title items.image status').lean();
  res.json({ items: orders.map((o) => ({ id: String(o._id), orderNumber: o.orderNumber, total: o.total, status: o.status, paymentStatus: o.paymentStatus, createdAt: o.createdAt, preview: subs.filter((s) => String(s.parentOrderId) === String(o._id)).flatMap((s) => s.items.map((i) => ({ title: i.title, image: i.image }))).slice(0, 4) })) });
}));
r.get('/orders/:id', wrap(async (req, res) => {
  const o = await Order.findOne({ _id: parse(oid, req.params.id), buyerId: req.user!.id }).lean();
  if (!o) throw notFound('Order not found');
  const subs = await SubOrder.find({ parentOrderId: o._id }).populate('sellerId', 'shopName').lean();
  res.json({ order: o, shipments: subs.map((s: any) => ({ id: String(s._id), seller: s.sellerId?.shopName, status: s.status, shipping: s.shipping, timeline: s.timeline, items: s.items, subtotal: s.subtotal })) });
}));
r.post('/orders/:id/cancel', wrap(async (req, res) => {
  const o = await Order.findOne({ _id: parse(oid, req.params.id), buyerId: req.user!.id });
  if (!o) throw notFound();
  const subs = await SubOrder.find({ parentOrderId: o._id });
  if (subs.some((s) => !['pending_acceptance', 'accepted', 'packing'].includes(s.status))) throw conflict('Some items have already shipped. Please request a return after delivery.');
  if (o.status === 'pending_payment') { await releaseUnpaid(o._id, 'failed'); return res.json({ ok: true }); }
  if (o.status === 'cancelled') return res.json({ ok: true });
  for (const s of subs) { s.status = 'cancelled'; s.timeline.push({ status: 'cancelled', at: new Date(), note: 'Cancelled by buyer' }); await s.save(); await restockSubOrder(s, 'cancellation'); }
  await refundPayment(o.razorpayPaymentId ?? undefined, o.total ?? 0, o.paymentMethod ?? 'demo');
  o.status = 'cancelled'; o.paymentStatus = 'refunded'; await o.save();
  res.json({ ok: true, message: 'Order cancelled. Your refund has been started.' });
}));

// ---------------- Returns ----------------
r.post('/returns', wrap(async (req, res) => {
  const b = parse(z.object({ subOrderId: oid, orderItemId: oid, reason: z.enum(['wrong_item', 'damaged_item', 'defective_item', 'missing_item', 'shade_mismatch', 'did_not_suit']), comment: z.string().max(1000).optional(), evidence: z.array(z.string().url()).max(5).optional() }), req.body);
  const sub = await SubOrder.findOne({ _id: b.subOrderId, buyerId: req.user!.id });
  if (!sub || sub.status !== 'delivered') throw badRequest('Returns can only be requested after delivery');
  const item = sub.items.find((i) => String(i._id) === b.orderItemId);
  if (!item) throw notFound('Item not found');
  const days = await getSetting('returnWindowDays');
  if (sub.shipping?.deliveredAt && Date.now() - sub.shipping.deliveredAt.getTime() > days * 864e5) throw badRequest(`The ${days}-day return window has ended`);
  if (await ReturnRequest.exists({ subOrderId: sub._id, orderItemId: b.orderItemId })) throw conflict('A return was already requested for this item');
  const rr = await ReturnRequest.create({ ...b, buyerId: req.user!.id, sellerId: sub.sellerId });
  sub.status = 'return_requested'; sub.timeline.push({ status: 'return_requested', at: new Date(), note: b.reason }); await sub.save();
  await recomputeParentStatus(sub.parentOrderId);
  res.status(201).json(rr);
}));
r.get('/returns', wrap(async (req, res) => { res.json({ items: await ReturnRequest.find({ buyerId: req.user!.id }).sort('-createdAt').lean() }); }));

// ---------------- Reviews ----------------
const reviewLimiter = rateLimit({ windowMs: 3600e3, limit: 10, standardHeaders: true, legacyHeaders: false });
r.post('/products/:id/reviews', reviewLimiter, wrap(async (req, res) => {
  const b = parse(z.object({ orderItemId: oid, rating: z.number().int().min(1).max(5), title: z.string().max(120).optional(), text: z.string().max(2000).optional(), includeProfileSnapshot: z.boolean().default(false) }), req.body);
  const productId = parse(oid, req.params.id);
  const sub = await SubOrder.findOne({ buyerId: req.user!.id, status: 'delivered', 'items._id': b.orderItemId, 'items.productId': productId });
  if (!sub) throw forbidden('Only verified buyers can review a delivered product');
  if (await Review.exists({ orderItemId: b.orderItemId })) throw conflict('You already reviewed this item');
  let snapshot: Record<string, string | undefined> | undefined;
  if (b.includeProfileSnapshot) {
    const p = await SkinProfile.findOne({ userId: req.user!.id }).lean();
    if (p) snapshot = { skinType: p.skinType ?? undefined, undertone: p.undertone ?? undefined, depthGroup: depthGroup(p.depth) };
  }
  const rv = await Review.create({ buyerId: req.user!.id, productId, orderItemId: b.orderItemId, rating: b.rating, title: b.title, text: b.text, profileSnapshot: snapshot });
  const [agg] = await Review.aggregate([{ $match: { productId: new Types.ObjectId(productId), moderation: 'approved' } }, { $group: { _id: null, avg: { $avg: '$rating' }, n: { $sum: 1 } } }]);
  await Product.updateOne({ _id: productId }, { ratingAvg: Math.round((agg?.avg ?? 0) * 10) / 10, ratingCount: agg?.n ?? 0 });
  res.status(201).json({ id: String(rv._id) });
}));
r.post('/reviews/:id/report', wrap(async (req, res) => {
  const { reason } = parse(z.object({ reason: z.string().min(3).max(200) }), req.body);
  await Review.updateOne({ _id: parse(oid, req.params.id) }, { $push: { reports: { by: req.user!.id, reason } } }); res.json({ ok: true });
}));

export default r;
