/**
 * DEVELOPMENT SEED ONLY. Refuses to run in production.
 * All products/ingredients below are clearly labelled demo data, not real brand claims.
 */
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { env, isProd } from './config/env';
import { Brand, Category, Ingredient, Listing, Product, Variant } from './models/catalog';
import { SellerProfile, User } from './models/user';
import { slugify } from './utils/slug';

async function main() {
  if (isProd) throw new Error('Seeding is disabled in production. Create admins via a secure invite process.');
  await mongoose.connect(env.MONGODB_URI);
  const pw = await bcrypt.hash('Demo@12345', 12);
  const mk = async (email: string, name: string, role: 'ADMIN' | 'SHOP_OWNER' | 'BUYER') =>
    (await User.findOneAndUpdate({ email }, { $setOnInsert: { email, name, role, passwordHash: pw, emailVerifiedAt: new Date(), adult18Confirmed: true, status: 'active' } }, { upsert: true, new: true }))!;
  await mk('admin@darpana.local', 'Demo Admin', 'ADMIN');
  await mk('buyer@darpana.local', 'Demo Buyer', 'BUYER');
  const so = await mk('seller@darpana.local', 'Demo Seller', 'SHOP_OWNER');
  const seller = await SellerProfile.findOneAndUpdate({ userId: so._id }, { $setOnInsert: { userId: so._id, shopName: 'Demo Beauty House', slug: 'demo-beauty-house', legalName: 'Demo Beauty House Pvt Ltd', status: 'approved', contactEmail: 'seller@darpana.local' } }, { upsert: true, new: true });

  const cats = ['Makeup', 'Foundation & Concealer', 'Lips', 'Eyes', 'Face', 'Skincare', 'Fragrance', 'Hair Care', 'Nail Care', 'Beauty Sets', 'Beauty Tools'];
  const catDocs: Record<string, any> = {};
  for (const [i, n] of cats.entries()) catDocs[n] = await Category.findOneAndUpdate({ slug: slugify(n) }, { $setOnInsert: { name: n, slug: slugify(n), sort: i } }, { upsert: true, new: true });
  const brandA = await Brand.findOneAndUpdate({ slug: 'aurelia-demo' }, { $setOnInsert: { name: 'Aurelia (Demo)', slug: 'aurelia-demo', verified: true, description: 'Demo brand for development.' } }, { upsert: true, new: true });
  const brandB = await Brand.findOneAndUpdate({ slug: 'nila-demo' }, { $setOnInsert: { name: 'Nila (Demo)', slug: 'nila-demo', verified: true, description: 'Demo brand for development.' } }, { upsert: true, new: true });

  const kb = [
    { canonicalName: 'parfum', aliases: ['fragrance', 'aroma', 'perfume'], flags: ['fragrance', 'allergen'], function: 'Scent', explanation: 'Adds scent. Fragrance can bother some sensitive skin.' },
    { canonicalName: 'alcohol denat.', aliases: ['alcohol denat', 'denatured alcohol'], flags: ['drying_alcohol', 'irritant'], function: 'Solvent', explanation: 'Helps products dry quickly; can feel drying for some skin.' },
    { canonicalName: 'retinol', aliases: ['retinyl palmitate'], flags: ['active_retinoid', 'pregnancy_caution', 'irritant'], function: 'Skin-renewing active', explanation: 'A vitamin A derivative used in night routines.' },
    { canonicalName: 'glycolic acid', aliases: [], flags: ['active_acid', 'irritant'], function: 'Exfoliant', explanation: 'An exfoliating acid that can make skin feel sensitive to sun.' },
    { canonicalName: 'coconut oil', aliases: ['cocos nucifera oil'], flags: ['comedogenic'], function: 'Emollient', explanation: 'A rich oil that may clog pores for some skin.' },
    { canonicalName: 'glycerin', aliases: [], flags: [], function: 'Humectant', explanation: 'Draws water into the skin surface.' },
    { canonicalName: 'niacinamide', aliases: [], flags: [], function: 'Skin-conditioning', explanation: 'A form of vitamin B3 used for tone and texture.' },
    { canonicalName: 'hyaluronic acid', aliases: ['sodium hyaluronate'], flags: [], function: 'Humectant', explanation: 'Holds water on the skin surface.' },
  ];
  for (const k of kb) await Ingredient.findOneAndUpdate({ canonicalName: k.canonicalName }, { $setOnInsert: { ...k, verified: true, source: 'Demo seed' } }, { upsert: true });

  const defs = [
    { t: 'Silk Skin Foundation (Demo)', b: brandA, c: 'Foundation & Concealer', ing: ['Aqua', 'Glycerin', 'Niacinamide', 'Hyaluronic Acid'], st: ['all'], concerns: ['dullness'], ff: true, shades: [['Porcelain 110', 2, 'cool'], ['Natural Beige 220', 4, 'neutral'], ['Warm Honey 320', 5, 'warm'], ['Golden Wheat 340', 6, 'warm'], ['Olive Sand 360', 6, 'olive'], ['Deep Cocoa 480', 9, 'warm']], price: 899 },
    { t: 'Skin Fit Serum Foundation (Demo)', b: brandB, c: 'Foundation & Concealer', ing: ['Aqua', 'Alcohol Denat.', 'Parfum', 'Glycerin'], st: ['oily', 'combination'], concerns: ['pores'], ff: false, shades: [['N1 Light', 2, 'neutral'], ['N4 Medium', 5, 'neutral'], ['W5 Tan', 6, 'warm'], ['O6 Olive Tan', 7, 'olive'], ['D9 Deep', 9, 'neutral']], price: 1099 },
    { t: 'Barrier Cream (Demo)', b: brandA, c: 'Skincare', ing: ['Aqua', 'Glycerin', 'Coconut Oil', 'Hyaluronic Acid'], st: ['dry', 'normal'], concerns: ['dryness'], ff: true, shades: [['50 ml', null, null]], price: 649 },
    { t: 'Night Renewal Serum (Demo)', b: brandB, c: 'Skincare', ing: ['Aqua', 'Retinol', 'Glycerin'], st: ['normal', 'combination'], concerns: ['ageing', 'dullness'], ff: true, shades: [['30 ml', null, null]], price: 1299 },
    { t: 'Rose Velvet Lipstick (Demo)', b: brandA, c: 'Lips', ing: ['Ricinus Communis Seed Oil', 'Parfum'], st: ['all'], concerns: [], ff: false, shades: [['Rose 01', null, null], ['Berry 02', null, null]], price: 499 },
  ];
  for (const d of defs) {
    const slug = slugify(d.t);
    if (await Product.exists({ slug })) continue;
    const p = await Product.create({ brandId: d.b._id, categoryId: catDocs[d.c]._id, createdBySeller: seller!._id, title: d.t, slug, shortDescription: 'Demo listing for development. Not a real product.', description: 'DEMO DATA. Replace with real, verified product information before launch.', ingredients: d.ing, ingredientsVerified: true, skinTypes: d.st, concerns: d.concerns, fragranceFree: d.ff, approvalStatus: 'approved', claims: [] });
    for (const [i, s] of d.shades.entries()) {
      const isShade = s[1] != null;
      const v = await Variant.create({ productId: p._id, name: s[0], kind: isShade ? 'shade' : 'size', depth: s[1] ?? undefined, undertone: s[2] ?? undefined, swatchVerified: isShade });
      await Listing.create({ sellerId: seller!._id, productId: p._id, variantId: v._id, sku: `${slug.slice(0, 8).toUpperCase()}-${i + 1}`, mrp: Math.round(d.price * 1.2), price: d.price, availableQty: 50, status: 'approved' });
    }
  }
  console.log('Seed complete.\n  admin@darpana.local / buyer@darpana.local / seller@darpana.local  (password: Demo@12345, DEV ONLY)');
  await mongoose.disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
