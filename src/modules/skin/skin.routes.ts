import { Router } from 'express';
import { z } from 'zod';
import { Ingredient, Product, Variant } from '../../models/catalog';
import { MatchFeedback, SkinProfile } from '../../models/skin';
import { authenticate, requireRole } from '../../middleware/auth';
import { encryptField, decryptField } from '../../utils/crypto';
import { parse, wrap, notFound } from '../../utils/errors';
import { matchForUser, loadMatchProfile } from './skin.service';
import { rankShades, undertoneFromQuiz, ShadeCandidate } from '../matching/shade';
import { profileCompleteness } from '../matching/engine';

const r = Router();
const CONSENT_VERSION = '2026-11-v1';
r.use(authenticate, requireRole('BUYER'));

const profileSchema = z.object({
  skinType: z.enum(['oily', 'dry', 'combination', 'normal', 'not_sure']).optional(),
  concerns: z.array(z.enum(['acne', 'pigmentation', 'dryness', 'redness', 'dullness', 'ageing', 'pores'])).max(7).optional(),
  sensitivity: z.enum(['none', 'mild', 'high']).optional(),
  ageBand: z.enum(['18-24', '25-34', '35-44', '45+']).optional(),
  climate: z.enum(['hot_humid', 'hot_dry', 'temperate', 'cold']).optional(),
  preferences: z.object({ fragranceFree: z.boolean().optional(), vegan: z.boolean().optional(), crueltyFree: z.boolean().optional(), budgetMax: z.number().min(0).optional() }).optional(),
  undertone: z.enum(['cool', 'neutral', 'warm', 'olive']).optional(), depth: z.number().min(1).max(10).optional(),
  consentAccepted: z.literal(true, { errorMap: () => ({ message: 'Please accept the profile consent to save' }) }),
  sensitive: z.object({
    consentAccepted: z.literal(true),
    allergies: z.array(z.string().max(60)).max(30).optional(),
    pastReactions: z.string().max(500).optional(),
    conditions: z.array(z.enum(['eczema', 'rosacea', 'psoriasis', 'active_acne', 'none', 'prefer_not_to_say'])).optional(),
    pregnant: z.boolean().nullable().optional(),
    treatments: z.array(z.string().max(80)).max(10).optional(),
  }).optional(),
}).strict();

r.get('/skin-profile', wrap(async (req, res) => {
  const { profile, doc } = await loadMatchProfile(req.user!.id);
  if (!doc) return res.json({ exists: false });
  const { sensitiveEnc, shelf, ...visible } = doc;
  let sensitive: unknown = null;
  if (sensitiveEnc && !doc.consent?.withdrawnAt) { try { sensitive = JSON.parse(decryptField(sensitiveEnc)); } catch { sensitive = null; } }
  res.json({ exists: true, profile: visible, sensitive, completion: Math.round(profileCompleteness(profile!) * 100), shelfCount: shelf?.length ?? 0 });
}));

r.put('/skin-profile', wrap(async (req, res) => {
  const b = parse(profileSchema, req.body);
  const { sensitive, consentAccepted: _c, ...plain } = b;
  const update: Record<string, unknown> = { ...plain, 'consent.version': CONSENT_VERSION, 'consent.acceptedAt': new Date() };
  if (sensitive) {
    const { consentAccepted: _s, ...data } = sensitive;
    update.sensitiveEnc = encryptField(JSON.stringify(data));
    update['consent.sensitiveAcceptedAt'] = new Date(); update['consent.withdrawnAt'] = null;
  }
  await SkinProfile.findOneAndUpdate({ userId: req.user!.id }, { $set: update }, { upsert: true, new: true });
  res.json({ ok: true });
}));

r.delete('/skin-profile', wrap(async (req, res) => { await SkinProfile.deleteOne({ userId: req.user!.id }); res.json({ ok: true }); }));
r.post('/skin-profile/withdraw-sensitive', wrap(async (req, res) => {
  await SkinProfile.updateOne({ userId: req.user!.id }, { $unset: { sensitiveEnc: 1 }, $set: { 'consent.withdrawnAt': new Date() } });
  res.json({ ok: true });
}));

r.get('/skin-match/products/:productId', wrap(async (req, res) => {
  const out = await matchForUser(req.user!.id, String(req.params.productId));
  if (!out) return res.json({ available: false, message: 'Complete your skin profile to see how this product fits you.' });
  res.json({ available: true, match: out });
}));
r.post('/skin-match/feedback', wrap(async (req, res) => {
  const b = parse(z.object({ productId: z.string(), kind: z.enum(['wrong_too_strict', 'wrong_too_lenient', 'other']), note: z.string().max(300).optional() }), req.body);
  await MatchFeedback.create({ ...b, userId: req.user!.id }); res.json({ ok: true });
}));

// ---- My Shelf (P1) ----
r.post('/shelf', wrap(async (req, res) => {
  const { productId } = parse(z.object({ productId: z.string() }), req.body);
  if (!(await Product.exists({ _id: productId, approvalStatus: 'approved' }))) throw notFound('Product not found');
  await SkinProfile.updateOne({ userId: req.user!.id }, { $addToSet: { shelf: { productId } } }, { upsert: true });
  res.json({ ok: true });
}));
r.delete('/shelf/:productId', wrap(async (req, res) => {
  await SkinProfile.updateOne({ userId: req.user!.id }, { $pull: { shelf: { productId: req.params.productId } } }); res.json({ ok: true });
}));
r.get('/shelf', wrap(async (req, res) => {
  const d = await SkinProfile.findOne({ userId: req.user!.id }).lean();
  const items = d?.shelf?.length ? await Product.find({ _id: { $in: d.shelf.map((s: any) => s.productId) } }).select('title slug media').lean() : [];
  res.json({ items });
}));

// ---- Shade finder ----
async function candidates(): Promise<ShadeCandidate[]> {
  const vs = await Variant.find({ kind: 'shade' }).populate({ path: 'productId', select: 'title brandId approvalStatus', populate: { path: 'brandId', select: 'name' } }).lean();
  return vs.filter((v: any) => v.productId?.approvalStatus === 'approved').map((v: any) => ({
    variantId: String(v._id), productId: String(v.productId._id), brand: v.productId.brandId?.name ?? '', product: v.productId.title,
    name: v.name, depth: v.depth, undertone: v.undertone, swatchVerified: v.swatchVerified, swatchHex: v.swatchVerified ? v.swatchHex : null,
  }));
}
r.post('/shade-finder/quiz', wrap(async (req, res) => {
  const q = parse(z.object({ sunReaction: z.enum(['burns', 'burns_then_tans', 'tans_easily', 'rarely_burns']), jewellery: z.enum(['silver', 'gold', 'both']), veins: z.enum(['blue', 'green', 'mixed']), depth: z.number().min(1).max(10), save: z.boolean().optional() }), req.body);
  const undertone = undertoneFromQuiz(q);
  const suggestions = rankShades({ depth: q.depth, undertone }, await candidates());
  if (q.save) await SkinProfile.updateOne({ userId: req.user!.id }, { $set: { undertone, depth: q.depth } }, { upsert: true });
  res.json({ undertone, depth: q.depth, suggestions, note: 'Colours vary by screen. These are suggestions, not a guarantee.' });
}));
r.post('/shade-finder/reference', wrap(async (req, res) => {
  const { variantId } = parse(z.object({ variantId: z.string() }), req.body);
  const ref = await Variant.findById(variantId).lean();
  if (!ref?.depth || !ref.undertone) throw notFound('That shade has no verified depth/undertone data yet');
  const suggestions = rankShades({ depth: ref.depth, undertone: ref.undertone }, await candidates(), [variantId]);
  await SkinProfile.updateOne({ userId: req.user!.id }, { $set: { 'currentFoundation.variantId': ref._id, undertone: ref.undertone, depth: ref.depth } }, { upsert: true });
  res.json({ suggestions, note: 'Colours vary by screen. These are suggestions, not a guarantee.' });
}));

// Ingredient guide is public-ish but lives here for convenience
export const ingredientGuide = Router();
ingredientGuide.get('/ingredients/:name', wrap(async (req, res) => {
  const n = String(req.params.name).toLowerCase();
  const i = await Ingredient.findOne({ $or: [{ canonicalName: n }, { aliases: n }], verified: true }).select('canonicalName function explanation flags').lean();
  if (!i) throw notFound('We do not have a verified explanation for this ingredient yet');
  res.json(i);
}));
export default r;
