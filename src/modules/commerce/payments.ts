import crypto from 'crypto';
import Razorpay from 'razorpay';
import { env, razorpayEnabled } from '../../config/env';

let client: Razorpay | null = null;
export const razorpay = () => (client ??= new Razorpay({ key_id: env.RAZORPAY_KEY_ID, key_secret: env.RAZORPAY_KEY_SECRET }));

export const toPaise = (rupees: number) => Math.round(rupees * 100);
const safeEq = (a: string, b: string) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function verifyPaymentSignature(orderId: string, paymentId: string, signature: string) {
  const expected = crypto.createHmac('sha256', env.RAZORPAY_KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex');
  return safeEq(expected, signature);
}
export function verifyWebhookSignature(rawBody: Buffer, signature: string) {
  if (!env.RAZORPAY_WEBHOOK_SECRET) return false;
  const expected = crypto.createHmac('sha256', env.RAZORPAY_WEBHOOK_SECRET).update(rawBody).digest('hex');
  return safeEq(expected, signature);
}
export async function refundPayment(paymentId: string | undefined, amountRupees: number, mode: string) {
  if (mode === 'demo' || !razorpayEnabled || !paymentId) return { id: `demo_rfnd_${Date.now()}`, demo: true };
  return razorpay().payments.refund(paymentId, { amount: toPaise(amountRupees) });
}
