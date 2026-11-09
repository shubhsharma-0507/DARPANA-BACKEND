import { Schema, model, Types } from 'mongoose';

export const ROLES = ['BUYER', 'SHOP_OWNER', 'ADMIN'] as const;
export type Role = (typeof ROLES)[number];

const userSchema = new Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  name: { type: String, required: true, trim: true, maxlength: 100 },
  phone: { type: String, trim: true, maxlength: 20 },
  passwordHash: { type: String, select: false },
  googleSubject: { type: String, index: true, sparse: true },
  role: { type: String, enum: ROLES, default: 'BUYER', required: true },
  status: { type: String, enum: ['active', 'suspended', 'deletion_requested', 'deleted', 'disabled'], default: 'active' },
  emailVerifiedAt: Date,
  adult18Confirmed: { type: Boolean, default: false },
  mfa: { enabled: { type: Boolean, default: false }, secretEnc: { type: String, select: false } },
  emailVerifyHash: { type: String, select: false },
  resetHash: { type: String, select: false },
  resetExpires: { type: Date, select: false },
  failedLogins: { type: Number, default: 0 },
  lockedUntil: Date,
}, { timestamps: true });

export const User = model('User', userSchema);

const sessionSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', index: true, required: true },
  family: { type: String, index: true, required: true },
  refreshHash: { type: String, index: true, required: true },
  expiresAt: { type: Date, required: true },
  revokedAt: Date,
  userAgent: String,
  ip: String,
  mfaPassed: { type: Boolean, default: false },
}, { timestamps: true });
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const Session = model('Session', sessionSchema);

const sellerSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', unique: true, required: true },
  shopName: { type: String, required: true, trim: true, maxlength: 120 },
  slug: { type: String, unique: true, sparse: true },
  legalName: { type: String, trim: true },
  contactEmail: String, contactPhone: String,
  address: { line1: String, city: String, state: String, pincode: String },
  gstin: String, pan: String,
  bankRef: { holder: String, last4: String, ifsc: String },
  kycDocs: [{ type: { type: String }, publicId: String, uploadedAt: Date }],
  brandAuthProof: [{ publicId: String, brand: String }],
  description: String, logo: String, banner: String,
  returnPolicy: String, shippingPolicy: String,
  status: { type: String, enum: ['draft', 'submitted', 'under_review', 'approved', 'rejected', 'suspended'], default: 'draft' },
  adminComment: String,
  commissionOverridePercent: Number,
}, { timestamps: true });
export const SellerProfile = model('SellerProfile', sellerSchema);

export const AuditLog = model('AuditLog', new Schema({
  actorId: { type: Schema.Types.ObjectId, ref: 'User', index: true },
  role: String, action: { type: String, index: true }, target: String, targetId: String,
  before: Schema.Types.Mixed, after: Schema.Types.Mixed, reason: String, ip: String, userAgent: String,
}, { timestamps: { createdAt: 'timestamp', updatedAt: false } }));

export const Notification = model('Notification', new Schema({
  role: { type: String, index: true },            // audience, e.g. ADMIN
  type: String, title: String, body: String, link: String,
  readAt: Date,
}, { timestamps: true }));

export const Setting = model('Setting', new Schema({
  key: { type: String, unique: true, required: true },
  value: Schema.Types.Mixed,
}, { timestamps: true }));

export type ObjectId = Types.ObjectId;
