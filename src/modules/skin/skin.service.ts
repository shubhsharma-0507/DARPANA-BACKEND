import { Types } from 'mongoose';
import { Ingredient, Product } from '../../models/catalog';
import { Review } from '../../models/commerce';
import { MatchResult, SkinProfile } from '../../models/skin';
import { decryptField } from '../../utils/crypto';
import { computeMatch, KbEntry, MatchProfile, MatchOutput } from '../matching/engine';

export const depthGroup = (d?: number | null) => (d == null ? undefined : d <= 3 ? 'fair' : d <= 6 ? 'medium' : 'deep');

export async function loadMatchProfile(userId: string): Promise<{ profile: MatchProfile | null; doc: any }> {
  const doc = await SkinProfile.findOne({ userId }).lean();
  if (!doc) return { profile: null, doc: null };
  let sensitive: any = {};
  if (doc.sensitiveEnc && doc.consent?.sensitiveAcceptedAt && !doc.consent?.withdrawnAt) {
    try { sensitive = JSON.parse(decryptField(doc.sensitiveEnc)); } catch { sensitive = {}; }
  }
  const shelfProducts = doc.shelf?.length ? await Product.find({ _id: { $in: doc.shelf.map((s: any) => s.productId) } }).select('ingredients').lean() : [];
  return {
    doc,
    profile: {
      skinType: doc.skinType ?? undefined, concerns: doc.concerns ?? [], sensitivity: (doc.sensitivity as any) ?? undefined,
      climate: doc.climate ?? undefined, ageBand: doc.ageBand ?? undefined,
      preferences: doc.preferences ? { fragranceFree: doc.preferences.fragranceFree ?? undefined, vegan: doc.preferences.vegan ?? undefined, crueltyFree: doc.preferences.crueltyFree ?? undefined } : undefined,
      allergies: sensitive.allergies ?? [], conditions: sensitive.conditions ?? [], pregnant: sensitive.pregnant ?? null, treatments: sensitive.treatments ?? [],
      shelfIngredients: shelfProducts.map((p) => p.ingredients),
    },
  };
}

export async function twinSignal(productId: Types.ObjectId | string, doc: any) {
  if (!doc) return undefined;
  const filter: Record<string, unknown> = { productId, moderation: 'approved' };
  if (doc.skinType && doc.skinType !== 'not_sure') filter['profileSnapshot.skinType'] = doc.skinType;
  if (doc.undertone) filter['profileSnapshot.undertone'] = doc.undertone;
  const g = depthGroup(doc.depth); if (g) filter['profileSnapshot.depthGroup'] = g;
  const [a] = await Review.aggregate([{ $match: filter }, { $group: { _id: null, count: { $sum: 1 }, avg: { $avg: '$rating' } } }]);
  return a ? { count: a.count as number, avgRating: a.avg as number } : { count: 0, avgRating: 0 };
}

export async function matchForUser(userId: string, productId: string, persist = true): Promise<MatchOutput | null> {
  const [{ profile, doc }, product, kb] = await Promise.all([
    loadMatchProfile(userId), Product.findById(productId).lean(), Ingredient.find().lean(),
  ]);
  if (!profile || !product) return null;
  const out = computeMatch(profile, {
    ingredients: product.ingredients, ingredientsVerified: product.ingredientsVerified, skinTypes: product.skinTypes as string[], concerns: product.concerns,
    fragranceFree: product.fragranceFree, vegan: product.vegan, crueltyFree: product.crueltyFree,
  }, kb.map((k) => ({ canonicalName: k.canonicalName, aliases: k.aliases, flags: k.flags as KbEntry['flags'] })), await twinSignal(productId, doc));
  if (persist) await MatchResult.findOneAndUpdate({ userId, productId }, { ...out, userId, productId, generatedAt: new Date(out.generatedAt) }, { upsert: true });
  return out;
}
