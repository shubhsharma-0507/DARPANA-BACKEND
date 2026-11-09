import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { authenticate, requireApprovedSeller, requireRole } from '../../middleware/auth';
import { Brand, Category, Listing, Product, StockMovement, Variant } from '../../models/catalog';
import { Order, ReturnRequest, SubOrder } from '../../models/commerce';
import { SellerProfile } from '../../models/user';
import { AppError, badRequest, conflict, forbidden, notFound, parse, wrap } from '../../utils/errors';
import { slugify } from '../../utils/slug';
import { recomputeParentStatus, restockSubOrder } from '../commerce/order.service';
import { refundPayment } from '../commerce/payments';
import { getSetting } from '../commerce/settings';
import { notifyAdmins } from '../notifications/notify';

const r = Router();
r.use(authenticate, requireRole('SHOP_OWNER'));
const oid = z.string().refine((s) => Types.ObjectId.isValid(s), 'Invalid id');

// ---------- Onboarding (works before approval) ----------
const applySchema = z.object({
  shopName: z.string().min(2).max(120), legalName: z.string().min(2).max(160), contactEmail: z.string().email(), contactPhone: z.string().regex(/^[6-9]\d{9}$/, 'Enter a 10-digit mobile number'),
  address: z.object({ line1: z.string().min(3), city: z.string().min(2), state: z.string().min(2), pincode: z.string().regex(/^[1-9][0-9]{5}$/) }),
  gstin: z.string().regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, 'Enter a valid GSTIN').optional().or(z.literal('')),
  pan: z.string().regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, 'Enter a valid PAN'),
  bank: z.object({ holder: z.string().min(2), accountLast4: z.string().length(4), ifsc: z.string().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'Enter a valid IFSC') }),
  kycDocs: z.array(z.object({ type: z.enum(['pan', 'gst', 'address_proof', 'identity', 'cancelled_cheque']), publicId: z.string().min(3) })).min(1).max(8),
  brandAuthProof: z.array(z.object({ brand: z.string().min(1), publicId: z.string().min(3) })).max(10).optional(),
  description: z.string().max(1000).optional(), returnPolicy: z.string().max(1500).optional(), shippingPolicy: z.string().max(1500).optional(),
}).strict();

r.get('/profile', wrap(async (req, res) => {
  const p = await SellerProfile.findOne({ userId: req.user!.id }).select('-kycDocs.publicId -brandAuthProof.publicId').lean();
  res.json({ profile: p });
}));
r.post('/apply', wrap(async (req, res) => {
  const b = parse(applySchema, req.body);
  const p = await SellerProfile.findOne({ userId: req.user!.id });
  if (!p) throw notFound();
  if (['under_review', 'approved'].includes(p.status)) throw conflict(`Your application is ${p.status.replace('_', ' ')} and can't be edited now`);
  const firstKyc = !p.kycDocs?.length;
  Object.assign(p, { shopName: b.shopName, legalName: b.legalName, contactEmail: b.contactEmail, contactPhone: b.contactPhone, address: b.address, gstin: b.gstin || undefined, pan: b.pan, description: b.description, returnPolicy: b.returnPolicy, shippingPolicy: b.shippingPolicy,
    bankRef: { holder: b.bank.holder, last4: b.bank.accountLast4, ifsc: b.bank.ifsc }, kycDocs: b.kycDocs.map((d) => ({ ...d, uploadedAt: new Date() })), brandAuthProof: b.brandAuthProof ?? [], status: 'submitted', adminComment: undefined });
  p.slug ??= slugify(b.shopName) + '-' + String(p._id).slice(-4);
  await p.save();
  if (firstKyc) await notifyAdmins('Seller KYC submitted', `${p.shopName} has submitted KYC details and is ready for review.`, '/admin/sellers');
  res.json({ ok: true, status: p.status });
}));
r.patch('/profile', requireApprovedSeller, wrap(async (req, res) => {
  const b = parse(z.object({ description: z.string().max(1000).optional(), logo: z.string().url().optional(), banner: z.string().url().optional(), returnPolicy: z.string().max(1500).optional(), shippingPolicy: z.string().max(1500).optional(), contactPhone: z.string().optional() }).strict(), req.body);
  await SellerProfile.updateOne({ userId: req.user!.id }, { $set: b }); res.json({ ok: true });
}));

// Drafts are allowed while under review (client-configurable); publishing needs approval.
async function mySeller(req: any) { const s = await SellerProfile.findOne({ userId: req.user.id }); if (!s) throw forbidden(); return s; }

// ---------- Products (create product + variants + listings in one guided form) ----------
const variantSchema = z.object({
  name: z.string().min(1).max(80), kind: z.enum(['shade', 'size']).default('size'),
  depth: z.number().int().min(1).max(10).optional(), undertone: z.enum(['cool', 'neutral', 'warm', 'olive']).optional(),
  swatchHex: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(), swatchImage: z.string().url().optional(), barcode: z.string().max(40).optional(),
  sku: z.string().min(1).max(40), mrp: z.number().positive(), price: z.number().positive(), taxPercent: z.number().min(0).max(40).default(18),
  stock: z.number().int().min(0), lowStockThreshold: z.number().int().min(0).default(5), dispatchDays: z.number().int().min(0).max(30).default(2), weightGrams: z.number().positive().optional(),
}).refine((v) => v.price <= v.mrp, { message: 'Selling price cannot be higher than MRP', path: ['price'] });

const productSchema = z.object({
  brandId: oid, categoryId: oid, title: z.string().min(3).max(200), productType: z.string().max(80).optional(), subcategory: z.string().max(80).optional(),
  manufacturer: z.string().max(160).optional(), countryOfOrigin: z.string().max(80).optional(), barcode: z.string().max(40).optional(),
  shortDescription: z.string().max(300).optional(), description: z.string().max(10000).optional(), benefits: z.array(z.string().max(200)).max(12).optional(),
  usage: z.string().max(2000).optional(), precautions: z.string().max(2000).optional(), targetAudience: z.string().max(300).optional(),
  ingredients: z.array(z.string().min(1).max(120)).max(200).default([]), allergens: z.array(z.string().max(60)).max(30).optional(), fragranceFree: z.boolean().optional(),
  skinTypes: z.array(z.enum(['oily', 'dry', 'combination', 'normal', 'all'])).optional(), concerns: z.array(z.string().max(40)).max(10).optional(),
  finish: z.string().max(60).optional(), coverage: z.string().max(60).optional(), texture: z.string().max(60).optional(), formulation: z.string().max(60).optional(), spf: z.number().min(0).max(100).optional(),
  claims: z.array(z.string().max(160)).max(10).optional(), vegan: z.boolean().optional(), crueltyFree: z.boolean().optional(),
  regulatory: z.object({ licence: z.string().max(120).optional(), importer: z.string().max(160).optional(), batchNote: z.string().max(200).optional() }).optional(),
  media: z.array(z.object({ publicId: z.string(), url: z.string().url(), alt: z.string().min(3).max(200), kind: z.enum(['front', 'back', 'texture', 'in_use', 'other']).default('other') })).max(10).optional(),
  variants: z.array(variantSchema).min(1).max(40),
}).strict();

function sanitiseClaims(texts?: string[]) { return (texts ?? []).map((text) => ({ text, verified: false })); } // only admin can verify

r.post('/products', wrap(async (req, res) => {
  const seller = await mySeller(req);
  const { variants, claims, media, ...p } = parse(productSchema, req.body);
  const [brand, cat] = await Promise.all([Brand.exists({ _id: p.brandId }), Category.exists({ _id: p.categoryId })]);
  if (!brand || !cat) throw badRequest('Choose a valid brand and category');
  const skus = new Set(variants.map((v) => v.sku));
  if (skus.size !== variants.length) throw badRequest('Each variant needs a unique SKU');
  if (await Listing.exists({ sellerId: seller._id, sku: { $in: [...skus] } })) throw conflict('One of these SKUs already exists in your catalogue');
  const product = await Product.create({ ...p, slug: slugify(p.title) + '-' + Math.random().toString(36).slice(2, 6), claims: sanitiseClaims(claims), media: (media ?? []).map((m, i) => ({ ...m, sort: i })), createdBySeller: seller._id, approvalStatus: 'draft', ingredientsVerified: false });
  for (const v of variants) {
    const variant = await Variant.create({ productId: product._id, name: v.name, kind: v.kind, depth: v.depth, undertone: v.undertone, swatchHex: v.swatchHex, swatchImage: v.swatchImage, barcode: v.barcode, swatchVerified: false });
    const l = await Listing.create({ sellerId: seller._id, productId: product._id, variantId: variant._id, sku: v.sku, mrp: v.mrp, price: v.price, taxPercent: v.taxPercent, availableQty: v.stock, lowStockThreshold: v.lowStockThreshold, dispatchDays: v.dispatchDays, weightGrams: v.weightGrams, status: 'draft' });
    if (v.stock) await StockMovement.create({ listingId: l._id, delta: v.stock, reason: 'initial_stock', actorId: req.user!.id });
  }
  res.status(201).json({ id: String(product._id), slug: product.slug });
}));

async function ownProduct(req: any, id: string) {
  const seller = await mySeller(req);
  const p = await Product.findOne({ _id: parse(oid, id), createdBySeller: seller._id }); // ownership check, role alone is not enough
  if (!p) throw notFound('Product not found');
  return { seller, p };
}
r.get('/products', wrap(async (req, res) => {
  const seller = await mySeller(req);
  const items = await Product.find({ createdBySeller: seller._id }).sort('-updatedAt').select('title slug approvalStatus reviewNote media updatedAt ingredients').lean();
  res.json({ items: items.map((p) => ({ id: String(p._id), title: p.title, slug: p.slug, status: p.approvalStatus, reviewNote: p.reviewNote, image: p.media?.[0]?.url, incompleteIngredients: !p.ingredients?.length, updatedAt: p.updatedAt })) });
}));
r.get('/products/:id', wrap(async (req, res) => {
  const { seller, p } = await ownProduct(req, String(req.params.id));
  const [variants, listings] = await Promise.all([Variant.find({ productId: p._id }).lean(), Listing.find({ sellerId: seller._id, productId: p._id }).lean()]);
  res.json({ product: p, variants, listings });
}));
r.patch('/products/:id', wrap(async (req, res) => {
  const { p } = await ownProduct(req, String(req.params.id));
  const { claims, media, ...b } = parse(productSchema.omit({ variants: true }).partial(), req.body);
  const same = (a: unknown, c: unknown) => JSON.stringify(a ?? null) === JSON.stringify(c ?? null);
  const sensitive = (b.ingredients !== undefined && !same(b.ingredients, [...p.ingredients]))
    || (claims !== undefined && !same(claims, p.claims.map((c) => c.text)))
    || (b.regulatory !== undefined && !same(b.regulatory, { licence: p.regulatory?.licence, importer: p.regulatory?.importer, batchNote: p.regulatory?.batchNote }))
    || (b.allergens !== undefined && !same(b.allergens, [...(p.allergens ?? [])]));
  Object.assign(p, b);
  if (claims && !same(claims, p.claims.map((c) => c.text))) p.set('claims', sanitiseClaims(claims));
  if (media) p.set('media', media.map((m, i) => ({ ...m, sort: i })));
  if (sensitive) p.ingredientsVerified = false; // any ingredient/claim edit forces admin re-verification
  if (p.approvalStatus === 'approved' && sensitive) p.approvalStatus = 'submitted';
  else if (p.approvalStatus === 'rejected' || p.approvalStatus === 'changes_requested') p.approvalStatus = 'draft';
  await p.save(); res.json({ ok: true, status: p.approvalStatus, sentForReview: sensitive });
}));
r.post('/products/:id/submit', wrap(async (req, res) => {
  const { p } = await ownProduct(req, String(req.params.id));
  if (!['draft', 'changes_requested', 'rejected'].includes(p.approvalStatus)) throw conflict('This product is already submitted');
  const missing: string[] = [];
  if (!p.ingredients?.length) missing.push('Full ingredient list (INCI) is required for Skin Match');
  if (!p.description && !p.shortDescription) missing.push('Add a description');
  if ((p.media?.length ?? 0) < 1) missing.push('Add at least one product image');
  if (missing.length) throw new AppError(422, 'INCOMPLETE', 'Complete these before submitting', { form: missing });
  p.approvalStatus = 'submitted'; await p.save();
  await Listing.updateMany({ productId: p._id, sellerId: p.createdBySeller, status: { $in: ['draft', 'rejected'] } }, { status: 'submitted' });
  res.json({ ok: true });
}));

// ---------- Listings / inventory ----------
r.post('/listings', wrap(async (req, res) => {
  const seller = await mySeller(req);
  const b = parse(z.object({ productId: oid, variantId: oid, sku: z.string().min(1).max(40), mrp: z.number().positive(), price: z.number().positive(), stock: z.number().int().min(0), dispatchDays: z.number().int().min(0).max(30).default(2) }).refine((v) => v.price <= v.mrp, { message: 'Selling price cannot be higher than MRP', path: ['price'] }), req.body);
  const v = await Variant.findOne({ _id: b.variantId, productId: b.productId }).lean();
  const prod = await Product.findOne({ _id: b.productId, approvalStatus: 'approved' }).lean();
  if (!v || !prod) throw notFound('Product not found');
  const l = await Listing.create({ sellerId: seller._id, productId: b.productId, variantId: b.variantId, sku: b.sku, mrp: b.mrp, price: b.price, availableQty: b.stock, dispatchDays: b.dispatchDays, status: 'submitted' });
  res.status(201).json({ id: String(l._id) });
}));
r.get('/listings', wrap(async (req, res) => {
  const seller = await mySeller(req);
  const items = await Listing.find({ sellerId: seller._id }).populate('productId', 'title').populate('variantId', 'name').sort('-updatedAt').lean();
  res.json({ items: items.map((l: any) => ({ id: String(l._id), product: l.productId?.title, variant: l.variantId?.name, sku: l.sku, mrp: l.mrp, price: l.price, available: l.availableQty, reserved: l.reservedQty, low: l.availableQty - l.reservedQty <= l.lowStockThreshold, status: l.status })) });
}));
r.patch('/listings/:id', wrap(async (req, res) => {
  const seller = await mySeller(req);
  const b = parse(z.object({ price: z.number().positive().optional(), mrp: z.number().positive().optional(), dispatchDays: z.number().int().min(0).max(30).optional(), lowStockThreshold: z.number().int().min(0).optional() }).strict(), req.body);
  const l = await Listing.findOne({ _id: parse(oid, req.params.id), sellerId: seller._id });
  if (!l) throw notFound();
  const price = b.price ?? l.price, mrp = b.mrp ?? l.mrp;
  if (price > mrp) throw badRequest('Selling price cannot be higher than MRP');
  Object.assign(l, b); await l.save(); res.json({ ok: true });
}));
r.post('/listings/:id/stock', wrap(async (req, res) => {
  const seller = await mySeller(req);
  const b = parse(z.object({ delta: z.number().int().min(-100000).max(100000), reason: z.string().min(3).max(120) }), req.body);
  const l = await Listing.findOneAndUpdate({ _id: parse(oid, req.params.id), sellerId: seller._id, availableQty: { $gte: b.delta < 0 ? -b.delta + 0 : 0 } }, { $inc: { availableQty: b.delta } }, { new: true });
  if (!l) throw conflict('Stock cannot go below zero');
  if (l.availableQty < l.reservedQty) { await Listing.updateOne({ _id: l._id }, { $inc: { availableQty: -b.delta } }); throw conflict('Stock cannot go below reserved quantity'); }
  await StockMovement.create({ listingId: l._id, delta: b.delta, reason: b.reason, actorId: req.user!.id });
  res.json({ availableQty: l.availableQty });
}));
r.get('/listings/:id/movements', wrap(async (req, res) => {
  const seller = await mySeller(req);
  if (!(await Listing.exists({ _id: parse(oid, req.params.id), sellerId: seller._id }))) throw notFound();
  res.json({ items: await StockMovement.find({ listingId: req.params.id }).sort('-createdAt').limit(100).lean() });
}));

// ---------- Orders (own sub-orders only) ----------
r.get('/orders', wrap(async (req, res) => {
  const seller = await mySeller(req);
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  const f: Record<string, unknown> = { sellerId: seller._id };
  if (status) f.status = status;
  // sub-orders of unpaid parents are never visible
  const subs = await SubOrder.find(f).sort('-createdAt').limit(100).populate('parentOrderId', 'orderNumber address paymentStatus createdAt').lean();
  res.json({ items: subs.filter((s: any) => s.parentOrderId?.paymentStatus === 'captured' || s.parentOrderId?.paymentStatus === 'refunded' || s.parentOrderId?.paymentStatus === 'partially_refunded').map((s: any) => ({
    id: String(s._id), orderNumber: s.parentOrderId.orderNumber, createdAt: s.createdAt, status: s.status, items: s.items, subtotal: s.subtotal, commission: s.commission, payable: s.sellerPayable, shipping: s.shipping,
    ship_to: { name: s.parentOrderId.address?.fullName, city: s.parentOrderId.address?.city, state: s.parentOrderId.address?.state, pincode: s.parentOrderId.address?.pincode, line1: s.parentOrderId.address?.line1, phone: s.parentOrderId.address?.phone },
  })) });
}));
const NEXT: Record<string, string[]> = { pending_acceptance: ['accepted', 'rejected'], accepted: ['packing'], packing: ['ready_to_ship'], ready_to_ship: ['shipped'], shipped: ['delivered'] };
r.post('/orders/:id/status', wrap(async (req, res) => {
  const seller = await mySeller(req);
  const b = parse(z.object({ status: z.enum(['accepted', 'rejected', 'packing', 'ready_to_ship', 'shipped', 'delivered']), courier: z.string().max(60).optional(), trackingId: z.string().max(60).optional(), note: z.string().max(300).optional() }), req.body);
  const s = await SubOrder.findOne({ _id: parse(oid, req.params.id), sellerId: seller._id });
  if (!s) throw notFound();
  if (!NEXT[s.status]?.includes(b.status)) throw conflict(`Cannot move from ${s.status.replace(/_/g, ' ')} to ${b.status.replace(/_/g, ' ')}`);
  if (b.status === 'shipped' && (!b.courier || !b.trackingId)) throw badRequest('Add courier and tracking ID to mark as shipped');
  s.status = b.status as any; s.timeline.push({ status: b.status, at: new Date(), note: b.note });
  if (b.status === 'shipped') { s.shipping = { ...(s.shipping ?? {}), courier: b.courier, trackingId: b.trackingId, shippedAt: new Date() } as any; }
  if (b.status === 'delivered') { s.shipping = { ...(s.shipping ?? {}), deliveredAt: new Date() } as any; }
  if (b.status === 'rejected') {
    await restockSubOrder(s, 'seller_rejected');
    const parent = await Order.findById(s.parentOrderId);
    await refundPayment(parent?.razorpayPaymentId ?? undefined, s.subtotal ?? 0, parent?.paymentMethod ?? 'demo');
    if (parent) { parent.paymentStatus = 'partially_refunded'; await parent.save(); }
  }
  await s.save(); await recomputeParentStatus(s.parentOrderId); res.json({ ok: true, status: s.status });
}));

// ---------- Returns ----------
r.get('/returns', wrap(async (req, res) => { const s = await mySeller(req); res.json({ items: await ReturnRequest.find({ sellerId: s._id }).sort('-createdAt').lean() }); }));
r.post('/returns/:id/respond', wrap(async (req, res) => {
  const s = await mySeller(req);
  const { comment } = parse(z.object({ comment: z.string().min(3).max(1000) }), req.body);
  const rr = await ReturnRequest.findOneAndUpdate({ _id: parse(oid, req.params.id), sellerId: s._id }, { sellerResponse: comment, status: 'under_review' }, { new: true });
  if (!rr) throw notFound(); res.json(rr);
}));

// ---------- Dashboard & earnings ----------
r.get('/dashboard', wrap(async (req, res) => {
  const s = await mySeller(req);
  const [byStatus, low, sales] = await Promise.all([
    SubOrder.aggregate([{ $match: { sellerId: s._id } }, { $group: { _id: '$status', n: { $sum: 1 }, amount: { $sum: '$subtotal' } } }]),
    Listing.countDocuments({ sellerId: s._id, status: 'approved', $expr: { $lte: [{ $subtract: ['$availableQty', '$reservedQty'] }, '$lowStockThreshold'] } }),
    SubOrder.aggregate([{ $match: { sellerId: s._id, status: { $in: ['delivered', 'shipped', 'accepted', 'packing', 'ready_to_ship'] } } }, { $group: { _id: null, gross: { $sum: '$subtotal' }, commission: { $sum: '$commission' }, payable: { $sum: '$sellerPayable' } } }]),
  ]);
  const c = (k: string) => byStatus.find((b) => b._id === k)?.n ?? 0;
  res.json({ status: s.status, orders: byStatus.reduce((a, b) => a + b.n, 0), pendingFulfilment: c('pending_acceptance') + c('accepted') + c('packing') + c('ready_to_ship'), returns: c('return_requested'), lowStock: low, gross: sales[0]?.gross ?? 0, commission: sales[0]?.commission ?? 0, payable: sales[0]?.payable ?? 0 });
}));
r.get('/earnings', wrap(async (req, res) => {
  const s = await mySeller(req);
  const hold = await getSetting('payoutHoldDays');
  const delivered = await SubOrder.find({ sellerId: s._id, status: 'delivered' }).select('parentOrderId subtotal commissionPercent commission sellerPayable shipping.deliveredAt').sort('-updatedAt').limit(200).lean();
  const now = Date.now();
  const rows = delivered.map((d: any) => ({ id: String(d._id), gross: d.subtotal, commissionPercent: d.commissionPercent, commission: d.commission, payable: d.sellerPayable, eligibleOn: d.shipping?.deliveredAt ? new Date(d.shipping.deliveredAt.getTime() + hold * 864e5) : null }));
  res.json({ holdDays: hold, rows, payableNow: rows.filter((x) => x.eligibleOn && x.eligibleOn.getTime() <= now).reduce((a, b) => a + b.payable, 0), onHold: rows.filter((x) => !x.eligibleOn || x.eligibleOn.getTime() > now).reduce((a, b) => a + b.payable, 0) });
}));

export default r;
