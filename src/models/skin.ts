import { Schema, model } from 'mongoose';

export const SkinProfile = model('SkinProfile', new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', unique: true, required: true },
  skinType: { type: String, enum: ['oily', 'dry', 'combination', 'normal', 'not_sure'] },
  concerns: [String],
  sensitivity: { type: String, enum: ['none', 'mild', 'high'] },
  ageBand: { type: String, enum: ['18-24', '25-34', '35-44', '45+'] },
  undertone: { type: String, enum: ['cool', 'neutral', 'warm', 'olive'] },
  depth: { type: Number, min: 1, max: 10 },
  climate: { type: String, enum: ['hot_humid', 'hot_dry', 'temperate', 'cold'] },
  preferences: { fragranceFree: Boolean, vegan: Boolean, crueltyFree: Boolean, budgetMax: Number },
  currentFoundation: { brand: String, product: String, variantId: Schema.Types.ObjectId },
  shelf: [{ productId: Schema.Types.ObjectId }],
  // High-sensitivity fields: AES-256-GCM encrypted JSON blob. Never sent to sellers or analytics.
  sensitiveEnc: String,
  consent: {
    version: String, acceptedAt: Date, sensitiveAcceptedAt: Date, withdrawnAt: Date,
  },
}, { timestamps: true }));

export const MatchRule = model('MatchRule', new Schema({
  version: { type: String, required: true, unique: true },
  weights: Schema.Types.Mixed,
  active: { type: Boolean, default: false },
  approvedBy: Schema.Types.ObjectId, reason: String,
}, { timestamps: true }));

export const MatchResult = model('MatchResult', new Schema({
  userId: { type: Schema.Types.ObjectId, index: true },
  productId: { type: Schema.Types.ObjectId, index: true },
  score: Number, level: String, confidence: String,
  reasons: [String], warnings: [String], blocks: [String],
  rulesVersion: String, generatedAt: Date,
}, { timestamps: true }));

export const MatchFeedback = model('MatchFeedback', new Schema({
  userId: Schema.Types.ObjectId, productId: Schema.Types.ObjectId, kind: String, note: String,
}, { timestamps: true }));
