import { Schema, model } from 'mongoose';

export const Address = model('Address', new Schema({
  buyerId: { type: Schema.Types.ObjectId, ref: 'User', index: true, required: true },
  fullName: { type: String, required: true }, phone: { type: String, required: true },
  line1: { type: String, required: true }, line2: String,
  city: { type: String, required: true }, state: { type: String, required: true },
  pincode: { type: String, required: true, match: /^[1-9][0-9]{5}$/ },
  isDefault: { type: Boolean, default: false },
}, { timestamps: true }));

export const Cart = model('Cart', new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', unique: true, required: true },
  items: [{ listingId: { type: Schema.Types.ObjectId, ref: 'SellerListing' }, qty: { type: Number, min: 1, max: 10 } }],
}, { timestamps: true }));

export const Wishlist = model('Wishlist', new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', unique: true, required: true },
  productIds: [{ type: Schema.Types.ObjectId, ref: 'Product' }],
}, { timestamps: true }));

const itemSchema = new Schema({
  listingId: Schema.Types.ObjectId, productId: Schema.Types.ObjectId, variantId: Schema.Types.ObjectId,
  title: String, variantName: String, image: String, sku: String,
  qty: Number, unitPrice: Number, lineTotal: Number,
  matchLevel: String,
}, { _id: true });

export const Order = model('Order', new Schema({
  orderNumber: { type: String, unique: true, required: true },
  buyerId: { type: Schema.Types.ObjectId, ref: 'User', index: true, required: true },
  address: Schema.Types.Mixed,
  subtotal: Number, shipping: Number, discount: Number, total: Number,
  couponCode: String,
  paymentMethod: { type: String, enum: ['razorpay', 'demo'], default: 'razorpay' },
  paymentStatus: { type: String, enum: ['created', 'pending', 'authorized', 'captured', 'failed', 'refunded', 'partially_refunded'], default: 'created' },
  status: { type: String, enum: ['pending_payment', 'confirmed', 'processing', 'partially_shipped', 'shipped', 'delivered', 'cancelled', 'partially_cancelled', 'return_requested', 'closed'], default: 'pending_payment' },
  razorpayOrderId: { type: String, index: true },
  razorpayPaymentId: String,
  idempotencyKey: { type: String, index: true, sparse: true },
  reservationExpiresAt: Date,
}, { timestamps: true }));

export const SubOrder = model('SubOrder', new Schema({
  parentOrderId: { type: Schema.Types.ObjectId, ref: 'Order', index: true, required: true },
  buyerId: { type: Schema.Types.ObjectId, index: true },
  sellerId: { type: Schema.Types.ObjectId, ref: 'SellerProfile', index: true, required: true },
  items: [itemSchema],
  subtotal: Number, commissionPercent: Number, commission: Number, sellerPayable: Number,
  status: { type: String, enum: ['pending_acceptance', 'accepted', 'rejected', 'packing', 'ready_to_ship', 'shipped', 'delivered', 'cancellation_requested', 'cancelled', 'return_requested', 'returned'], default: 'pending_acceptance' },
  shipping: { courier: String, trackingId: String, shippedAt: Date, deliveredAt: Date },
  timeline: [{ status: String, at: Date, note: String }],
}, { timestamps: true }));

export const WebhookEvent = model('WebhookEvent', new Schema({
  eventId: { type: String, unique: true, required: true },
  type: String, processedAt: Date,
}, { timestamps: true }));

export const ReturnRequest = model('ReturnRequest', new Schema({
  subOrderId: { type: Schema.Types.ObjectId, ref: 'SubOrder', index: true, required: true },
  orderItemId: Schema.Types.ObjectId,
  buyerId: { type: Schema.Types.ObjectId, index: true },
  sellerId: { type: Schema.Types.ObjectId, index: true },
  reason: { type: String, enum: ['wrong_item', 'damaged_item', 'defective_item', 'missing_item', 'shade_mismatch', 'did_not_suit'], required: true },
  comment: String, evidence: [String],
  status: { type: String, enum: ['requested', 'under_review', 'approved', 'rejected', 'pickup_scheduled', 'received', 'inspected', 'refund_initiated', 'refunded', 'closed'], default: 'requested' },
  sellerResponse: String, adminNote: String,
}, { timestamps: true }));

export const Review = model('Review', new Schema({
  buyerId: { type: Schema.Types.ObjectId, ref: 'User', index: true, required: true },
  productId: { type: Schema.Types.ObjectId, ref: 'Product', index: true, required: true },
  orderItemId: { type: Schema.Types.ObjectId, unique: true, required: true },
  rating: { type: Number, min: 1, max: 5, required: true },
  title: { type: String, maxlength: 120 }, text: { type: String, maxlength: 2000 },
  photos: [String],
  profileSnapshot: { skinType: String, depthGroup: String, undertone: String },
  moderation: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'approved' },
  reports: [{ by: Schema.Types.ObjectId, reason: String }],
}, { timestamps: true }));
