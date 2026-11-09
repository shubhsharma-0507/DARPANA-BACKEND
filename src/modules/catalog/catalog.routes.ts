import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { Brand, Category, Listing, Product, Variant } from '../../models/catalog';
import { Review } from '../../models/commerce';
import { notFound, parse, wrap } from '../../utils/errors';
import { escapeRegex } from '../../utils/slug';
import { getSetting } from '../commerce/settings';

const r = Router();
const inStock = { status: 'approved', $expr: { $gt: ['$availableQty', '$reservedQty'] } };

const listQuery = z.object({
  q: z.string().max(80).optional(), category: z.string().max(60).optional(), brand: z.string().max(60).optional(),
  minPrice: z.coerce.number().min(0).optional(), maxPrice: z.coerce.number().min(0).optional(),
  skinType: z.enum(['oily', 'dry', 'combination', 'normal']).optional(), concern: z.string().max(40).optional(),
  fragranceFree: z.enum(['true']).optional(), vegan: z.enum(['true']).optional(), crueltyFree: z.enum(['true']).optional(),
  depth: z.coerce.number().min(1).max(10).optional(), undertone: z.enum(['cool', 'neutral', 'warm', 'olive']).optional(),
  sort: z.enum(['relevance', 'price_asc', 'price_desc', 'newest', 'popular', 'rating']).default('relevance'),
  page: z.coerce.number().min(1).default(1), limit: z.coerce.number().min(1).max(48).default(24),
});

r.get('/products', wrap(async (req, res) => {
  const q = parse(listQuery, req.query);
  const pf: Record<string, unknown> = { approvalStatus: 'approved' };
  if (q.q) pf.$or = [{ title: new RegExp(escapeRegex(q.q), 'i') }, { shortDescription: new RegExp(escapeRegex(q.q), 'i') }];
  if (q.skinType) pf.skinTypes = { $in: [q.skinType, 'all'] };
  if (q.concern) pf.concerns = q.concern;
  if (q.fragranceFree) pf.fragranceFree = true;
  if (q.vegan) pf.vegan = true;
  if (q.crueltyFree) pf.crueltyFree = true;
  if (q.category) { const c = await Category.findOne({ slug: q.category }); pf.categoryId = { $in: c ? [c._id, ...(await Category.find({ parentId: c._id }).distinct('_id'))] : [] }; }
  if (q.brand) { const b = await Brand.findOne({ slug: q.brand }); pf.brandId = b ? b._id : null; }
  if (q.q) { const bs = await Brand.find({ name: new RegExp(escapeRegex(q.q), 'i') }).distinct('_id'); if (bs.length) pf.$or = [...(pf.$or as any[]), { brandId: { $in: bs } }]; }
  const productIds = await Product.find(pf).distinct('_id');

  let variantFilter: Types.ObjectId[] | null = null;
  if (q.depth || q.undertone) {
    const vf: Record<string, unknown> = { productId: { $in: productIds } };
    if (q.depth) vf.depth = { $gte: q.depth - 1, $lte: q.depth + 1 };
    if (q.undertone) vf.undertone = q.undertone;
    variantFilter = await Variant.find(vf).distinct('_id');
  }
  const lm: Record<string, unknown> = { ...inStock, productId: { $in: productIds } };
  if (variantFilter) lm.variantId = { $in: variantFilter };
  const priceMatch: Record<string, unknown> = {};
  if (q.minPrice != null) priceMatch.$gte = q.minPrice;
  if (q.maxPrice != null) priceMatch.$lte = q.maxPrice;
  if (Object.keys(priceMatch).length) lm.price = priceMatch;

  const sortStage: Record<string, 1 | -1> =
    q.sort === 'price_asc' ? { minPrice: 1 } : q.sort === 'price_desc' ? { minPrice: -1 } :
    q.sort === 'newest' ? { 'p.createdAt': -1 } : q.sort === 'rating' ? { 'p.ratingAvg': -1 } : { 'p.popularity': -1, 'p.createdAt': -1 };

  const [agg] = await Listing.aggregate([
    { $match: lm },
    { $group: { _id: '$productId', minPrice: { $min: '$price' }, minMrp: { $min: '$mrp' }, offers: { $sum: 1 }, minDispatch: { $min: '$dispatchDays' } } },
    { $lookup: { from: 'products', localField: '_id', foreignField: '_id', as: 'p' } }, { $unwind: '$p' },
    { $lookup: { from: 'brands', localField: 'p.brandId', foreignField: '_id', as: 'b' } }, { $unwind: '$b' },
    { $sort: sortStage },
    { $facet: { items: [{ $skip: (q.page - 1) * q.limit }, { $limit: q.limit }], total: [{ $count: 'n' }] } },
  ]);
  const items = agg.items.map((x: any) => ({
    id: String(x._id), slug: x.p.slug, title: x.p.title, brand: { name: x.b.name, slug: x.b.slug },
    image: x.p.media?.[0]?.url ?? null, alt: x.p.media?.[0]?.alt ?? x.p.title,
    price: x.minPrice, mrp: x.minMrp, discountPercent: x.minMrp > x.minPrice ? Math.round((1 - x.minPrice / x.minMrp) * 100) : 0,
    rating: x.p.ratingAvg, ratingCount: x.p.ratingCount, offers: x.offers, dispatchDays: x.minDispatch,
    fragranceFree: x.p.fragranceFree, vegan: x.p.vegan, crueltyFree: x.p.crueltyFree,
  }));
  res.json({ items, total: agg.total[0]?.n ?? 0, page: q.page, limit: q.limit });
}));

r.get('/products/:slug', wrap(async (req, res) => {
  const p = await Product.findOne({ slug: req.params.slug, approvalStatus: 'approved' }).lean();
  if (!p) throw notFound('Product not found');
  const [brand, category, variants, listings] = await Promise.all([
    Brand.findById(p.brandId).lean(), Category.findById(p.categoryId).lean(), Variant.find({ productId: p._id }).lean(),
    Listing.aggregate([{ $match: { ...inStock, productId: p._id } },
      { $lookup: { from: 'sellerprofiles', localField: 'sellerId', foreignField: '_id', as: 's' } }, { $unwind: '$s' }]),
  ]);
  const verifiedClaims = (p.claims ?? []).filter((c) => c.verified).map((c) => c.text);
  const { createdBySeller: _c, reviewNote: _r, ...safe } = p as any;
  res.json({
    product: { ...safe, claims: verifiedClaims, id: String(p._id) }, brand, category,
    variants: variants.map((v) => ({ ...v, id: String(v._id), swatchHex: v.swatchVerified ? v.swatchHex : undefined, unverifiedShade: v.kind === 'shade' && !v.swatchVerified })),
    offers: listings.map((l: any) => ({
      listingId: String(l._id), variantId: String(l.variantId), price: l.price, mrp: l.mrp, stock: l.availableQty - l.reservedQty,
      dispatchDays: l.dispatchDays, seller: { id: String(l.s._id), shopName: l.s.shopName, verified: l.s.status === 'approved' },
    })).sort((a: any, b: any) => a.price - b.price),
  });
}));

r.get('/site-config', wrap(async (_req, res) => {
  const [ship, coupons] = await Promise.all([getSetting('shipping'), getSetting('coupons')]);
  const offers = coupons.filter((c) => c.active).map((c) => ({ code: c.code, percent: c.percent, minSubtotal: c.minSubtotal }));
  res.json({ freeShippingAbove: ship.freeAbove, flatShipping: ship.flatPerSeller, offers });
}));

r.get('/brands', wrap(async (_req, res) => { res.json({ items: await Brand.find({ status: 'active' }).sort('name').lean() }); }));
r.get('/categories', wrap(async (_req, res) => { res.json({ items: await Category.find({ status: 'active' }).sort('sort').lean() }); }));

r.get('/search/suggest', wrap(async (req, res) => {
  const { q } = parse(z.object({ q: z.string().min(1).max(60) }), req.query);
  const rx = new RegExp('^' + escapeRegex(q), 'i');
  const [products, brands] = await Promise.all([
    Product.find({ approvalStatus: 'approved', title: new RegExp(escapeRegex(q), 'i') }).limit(6).select('title slug').lean(),
    Brand.find({ name: rx }).limit(3).select('name slug').lean(),
  ]);
  res.json({ products, brands });
}));

r.get('/products/:id/reviews', wrap(async (req, res) => {
  const q = parse(z.object({ skinType: z.string().optional(), undertone: z.string().optional(), depthGroup: z.string().optional(), page: z.coerce.number().min(1).default(1) }), req.query);
  if (!Types.ObjectId.isValid(String(req.params.id))) throw notFound();
  const f: Record<string, unknown> = { productId: req.params.id, moderation: 'approved' };
  if (q.skinType) f['profileSnapshot.skinType'] = q.skinType;
  if (q.undertone) f['profileSnapshot.undertone'] = q.undertone;
  if (q.depthGroup) f['profileSnapshot.depthGroup'] = q.depthGroup;
  const [items, count] = await Promise.all([
    Review.find(f).sort('-createdAt').skip((q.page - 1) * 10).limit(10).select('rating title text profileSnapshot createdAt photos').lean(),
    Review.countDocuments(f),
  ]);
  res.json({ items: items.map((x) => ({ ...x, verifiedPurchase: true })), count, twinFilterActive: !!(q.skinType || q.undertone || q.depthGroup), limitedEvidence: count < 5 });
}));

export default r;
