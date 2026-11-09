import { Schema, model } from 'mongoose';

export const Brand = model('Brand', new Schema({
  name: { type: String, required: true, unique: true, trim: true },
  slug: { type: String, required: true, unique: true },
  logo: String, description: String, website: String,
  status: { type: String, enum: ['active', 'pending', 'disabled'], default: 'active' },
  verified: { type: Boolean, default: false },
}, { timestamps: true }));

export const Category = model('Category', new Schema({
  name: { type: String, required: true, trim: true },
  slug: { type: String, required: true, unique: true },
  parentId: { type: Schema.Types.ObjectId, ref: 'Category' },
  sort: { type: Number, default: 0 },
  status: { type: String, enum: ['active', 'disabled'], default: 'active' },
}, { timestamps: true }));

const productSchema = new Schema({
  brandId: { type: Schema.Types.ObjectId, ref: 'Brand', required: true, index: true },
  categoryId: { type: Schema.Types.ObjectId, ref: 'Category', required: true, index: true },
  createdBySeller: { type: Schema.Types.ObjectId, ref: 'SellerProfile', index: true },
  title: { type: String, required: true, trim: true, maxlength: 200 },
  slug: { type: String, required: true, unique: true },
  productType: String, subcategory: String, manufacturer: String, countryOfOrigin: String, barcode: String,
  shortDescription: { type: String, maxlength: 300 },
  description: { type: String, maxlength: 10000 },
  benefits: [String], usage: String, precautions: String, targetAudience: String,
  ingredients: [{ type: String, trim: true }], // INCI list, in label order
  ingredientsVerified: { type: Boolean, default: false },
  allergens: [String],
  fragranceFree: { type: Boolean, default: false },
  skinTypes: [{ type: String, enum: ['oily', 'dry', 'combination', 'normal', 'all'] }],
  concerns: [String],
  finish: String, coverage: String, texture: String, formulation: String, spf: Number,
  claims: [{ text: String, verified: { type: Boolean, default: false } }],
  vegan: { type: Boolean, default: false }, crueltyFree: { type: Boolean, default: false },
  regulatory: { licence: String, importer: String, batchNote: String },
  media: [{ publicId: String, url: String, alt: String, kind: String, sort: Number }],
  approvalStatus: { type: String, enum: ['draft', 'submitted', 'approved', 'rejected', 'changes_requested'], default: 'draft', index: true },
  reviewNote: String,
  ratingAvg: { type: Number, default: 0 }, ratingCount: { type: Number, default: 0 },
  popularity: { type: Number, default: 0 },
}, { timestamps: true });
productSchema.index({ title: 'text', shortDescription: 'text' });
export const Product = model('Product', productSchema);

export const Variant = model('ProductVariant', new Schema({
  productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true, index: true },
  name: { type: String, required: true },          // "Warm Beige 220" or "30 ml"
  kind: { type: String, enum: ['shade', 'size'], default: 'size' },
  depth: { type: Number, min: 1, max: 10 },        // 1 = fairest, 10 = deepest
  undertone: { type: String, enum: ['cool', 'neutral', 'warm', 'olive'] },
  swatchHex: String, swatchImage: String,
  swatchVerified: { type: Boolean, default: false },
  barcode: String,
}, { timestamps: true }));

export const Listing = model('SellerListing', new Schema({
  sellerId: { type: Schema.Types.ObjectId, ref: 'SellerProfile', required: true, index: true },
  productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true, index: true },
  variantId: { type: Schema.Types.ObjectId, ref: 'ProductVariant', required: true, index: true },
  sku: { type: String, required: true },
  mrp: { type: Number, required: true, min: 1 },
  price: { type: Number, required: true, min: 1 },
  taxPercent: { type: Number, default: 18 },
  availableQty: { type: Number, default: 0, min: 0 },
  reservedQty: { type: Number, default: 0, min: 0 },
  lowStockThreshold: { type: Number, default: 5 },
  dispatchDays: { type: Number, default: 2 },
  weightGrams: Number, returnEligible: { type: Boolean, default: true },
  status: { type: String, enum: ['draft', 'submitted', 'approved', 'rejected', 'archived'], default: 'draft', index: true },
  reviewNote: String,
}, { timestamps: true }).index({ sellerId: 1, sku: 1 }, { unique: true }));

export const StockMovement = model('StockMovement', new Schema({
  listingId: { type: Schema.Types.ObjectId, ref: 'SellerListing', index: true },
  delta: Number, reason: String, actorId: Schema.Types.ObjectId, orderRef: String,
}, { timestamps: true }));

export const Ingredient = model('Ingredient', new Schema({
  canonicalName: { type: String, required: true, unique: true, lowercase: true, trim: true },
  aliases: [{ type: String, lowercase: true, trim: true }],
  function: String,
  explanation: String,
  flags: [{ type: String, enum: ['fragrance', 'irritant', 'comedogenic', 'pregnancy_caution', 'active_retinoid', 'active_acid', 'drying_alcohol', 'allergen'] }],
  source: String,
  verified: { type: Boolean, default: false },
}, { timestamps: true }));
