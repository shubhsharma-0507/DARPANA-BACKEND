import crypto from 'crypto';
import { Types } from 'mongoose';
import { Listing, Product, StockMovement, Variant } from '../../models/catalog';
import { Cart, Order, SubOrder } from '../../models/commerce';
import { SellerProfile } from '../../models/user';
import { AppError } from '../../utils/errors';
import { matchForUser } from '../skin/skin.service';
import { getSetting } from './settings';

export interface Line { listing: any; product: any; variant: any; seller: any; qty: number; unit: number; total: number; matchLevel?: string }

/** Re-reads everything from the DB. NEVER trusts browser-sent price/stock/totals. */
export async function buildLines(userId: string, items: { listingId: string; qty: number }[]): Promise<{ lines: Line[]; problems: string[] }> {
  const problems: string[] = []; const lines: Line[] = [];
  for (const it of items) {
    const listing = await Listing.findById(it.listingId).lean();
    if (!listing) { problems.push('An item in your cart is no longer available.'); continue; }
    const [product, variant, seller] = await Promise.all([Product.findById(listing.productId).lean(), Variant.findById(listing.variantId).lean(), SellerProfile.findById(listing.sellerId).lean()]);
    const title = product?.title ?? 'Item';
    if (!product || product.approvalStatus !== 'approved' || listing.status !== 'approved' || seller?.status !== 'approved') { problems.push(`${title} is no longer available.`); continue; }
    const free = listing.availableQty - listing.reservedQty;
    if (free < it.qty) { problems.push(free <= 0 ? `${title} is out of stock.` : `Only ${free} left of ${title}.`); continue; }
    const m = await matchForUser(userId, String(product._id), false).catch(() => null);
    lines.push({ listing, product, variant, seller, qty: it.qty, unit: listing.price, total: listing.price * it.qty, matchLevel: m?.level });
  }
  return { lines, problems };
}

export async function computeTotals(lines: Line[], couponCode?: string) {
  const ship = await getSetting('shipping');
  const bySeller = new Map<string, number>();
  for (const l of lines) bySeller.set(String(l.seller._id), (bySeller.get(String(l.seller._id)) ?? 0) + l.total);
  const shipping = [...bySeller.values()].reduce((s, sub) => s + (sub >= ship.freeAbove ? 0 : ship.flatPerSeller), 0);
  const subtotal = lines.reduce((s, l) => s + l.total, 0);
  let discount = 0; let applied: string | undefined;
  if (couponCode) {
    const c = (await getSetting('coupons')).find((x) => x.active && x.code === couponCode.toUpperCase());
    if (!c) throw new AppError(422, 'COUPON_INVALID', 'This coupon code is not valid');
    if (subtotal < c.minSubtotal) throw new AppError(422, 'COUPON_MIN', `Add items worth ₹${c.minSubtotal - subtotal} more to use this coupon`);
    discount = Math.round(subtotal * c.percent) / 100; applied = c.code;
  }
  return { subtotal, shipping, discount, total: Math.max(0, subtotal + shipping - discount), couponCode: applied, bySeller };
}

export async function reserveStock(lines: Line[]) {
  const done: Line[] = [];
  for (const l of lines) {
    const r = await Listing.updateOne({ _id: l.listing._id, status: 'approved', $expr: { $gte: [{ $subtract: ['$availableQty', '$reservedQty'] }, l.qty] } }, { $inc: { reservedQty: l.qty } });
    if (r.modifiedCount !== 1) { await releaseLines(done); throw new AppError(409, 'STOCK_CHANGED', `${l.product.title} just went out of stock. Please review your cart.`); }
    done.push(l);
  }
}
const releaseLines = async (lines: { listing: any; qty: number }[]) => { for (const l of lines) await Listing.updateOne({ _id: l.listing._id, reservedQty: { $gte: l.qty } }, { $inc: { reservedQty: -l.qty } }); };

export const orderNumber = () => 'DP' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(2).toString('hex').toUpperCase();

export async function createOrderWithSubOrders(userId: string, lines: Line[], totals: Awaited<ReturnType<typeof computeTotals>>, address: unknown, extra: { idempotencyKey?: string; method: 'razorpay' | 'demo' }) {
  const order = await Order.create({
    orderNumber: orderNumber(), buyerId: userId, address, subtotal: totals.subtotal, shipping: totals.shipping, discount: totals.discount, total: totals.total,
    couponCode: totals.couponCode, paymentMethod: extra.method, paymentStatus: 'created', status: 'pending_payment',
    idempotencyKey: extra.idempotencyKey, reservationExpiresAt: new Date(Date.now() + 15 * 60e3),
  });
  const commissionDefault = await getSetting('commissionPercent');
  const groups = new Map<string, Line[]>();
  for (const l of lines) groups.set(String(l.seller._id), [...(groups.get(String(l.seller._id)) ?? []), l]);
  for (const [sellerId, ls] of groups) {
    const subtotal = ls.reduce((s, l) => s + l.total, 0);
    const pct = ls[0].seller.commissionOverridePercent ?? commissionDefault;
    const commission = Math.round(subtotal * pct) / 100;
    await SubOrder.create({
      parentOrderId: order._id, buyerId: userId, sellerId, subtotal, commissionPercent: pct, commission, sellerPayable: subtotal - commission,
      items: ls.map((l) => ({ listingId: l.listing._id, productId: l.product._id, variantId: l.variant._id, title: l.product.title, variantName: l.variant.name, image: l.product.media?.[0]?.url, sku: l.listing.sku, qty: l.qty, unitPrice: l.unit, lineTotal: l.total, matchLevel: l.matchLevel })),
      timeline: [{ status: 'pending_acceptance', at: new Date() }],
    });
  }
  return order;
}

/** Idempotent: safe to call from verify endpoint AND webhook. Converts reservation -> sold. */
export async function finalizePaid(orderId: Types.ObjectId | string, paymentId?: string) {
  const claimed = await Order.findOneAndUpdate({ _id: orderId, paymentStatus: { $ne: 'captured' }, status: 'pending_payment' }, { $set: { paymentStatus: 'captured', status: 'confirmed', razorpayPaymentId: paymentId }, $unset: { reservationExpiresAt: 1 } }, { new: true });
  if (!claimed) return Order.findById(orderId); // already processed
  const subs = await SubOrder.find({ parentOrderId: orderId });
  for (const s of subs) for (const i of s.items) {
    await Listing.updateOne({ _id: i.listingId }, { $inc: { availableQty: -(i.qty ?? 0), reservedQty: -(i.qty ?? 0) } });
    await StockMovement.create({ listingId: i.listingId, delta: -(i.qty ?? 0), reason: 'sale', orderRef: claimed.orderNumber });
  }
  await Cart.updateOne({ userId: claimed.buyerId }, { $set: { items: [] } });
  return claimed;
}

export async function releaseUnpaid(orderId: Types.ObjectId | string, why: 'failed' | 'expired') {
  const o = await Order.findOneAndUpdate({ _id: orderId, status: 'pending_payment' }, { $set: { status: 'cancelled', paymentStatus: 'failed' }, $unset: { reservationExpiresAt: 1 } });
  if (!o) return;
  const subs = await SubOrder.find({ parentOrderId: orderId });
  for (const s of subs) { await releaseLines(s.items.map((i) => ({ listing: { _id: i.listingId }, qty: i.qty ?? 0 }))); s.status = 'cancelled'; s.timeline.push({ status: `cancelled_${why}`, at: new Date(), note: why }); await s.save(); }
}

export async function restockSubOrder(sub: any, reason: string) {
  for (const i of sub.items) {
    await Listing.updateOne({ _id: i.listingId }, { $inc: { availableQty: i.qty ?? 0 } });
    await StockMovement.create({ listingId: i.listingId, delta: i.qty, reason, orderRef: String(sub.parentOrderId) });
  }
}

export async function recomputeParentStatus(orderId: Types.ObjectId | string) {
  const subs = await SubOrder.find({ parentOrderId: orderId }).lean();
  const st = subs.map((s) => s.status);
  const all = (x: string[]) => st.every((s) => x.includes(s));
  let status: string | null = null;
  if (all(['cancelled', 'rejected'])) status = 'cancelled';
  else if (all(['delivered', 'cancelled', 'rejected', 'returned'])) status = st.includes('delivered') ? 'delivered' : 'closed';
  else if (st.some((s) => s === 'return_requested')) status = 'return_requested';
  else if (st.some((s) => s === 'cancelled' || s === 'rejected')) status = 'partially_cancelled';
  else if (all(['shipped', 'delivered'])) status = 'shipped';
  else if (st.some((s) => s === 'shipped' || s === 'delivered')) status = 'partially_shipped';
  else if (st.some((s) => ['accepted', 'packing', 'ready_to_ship'].includes(s))) status = 'processing';
  else status = 'confirmed';
  await Order.updateOne({ _id: orderId, status: { $ne: 'pending_payment' } }, { status });
}
