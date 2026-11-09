import { Request, Response } from 'express';
import { Order, WebhookEvent } from '../../models/commerce';
import { finalizePaid, releaseUnpaid } from './order.service';
import { verifyWebhookSignature } from './payments';

/** Mounted with express.raw BEFORE express.json so the signature is checked on the exact bytes. */
export async function razorpayWebhook(req: Request, res: Response) {
  const sig = String(req.headers['x-razorpay-signature'] ?? '');
  const body = req.body as Buffer;
  if (!Buffer.isBuffer(body) || !sig || !verifyWebhookSignature(body, sig)) return res.status(400).json({ code: 'BAD_SIGNATURE', message: 'Invalid signature' });
  const eventId = String(req.headers['x-razorpay-event-id'] ?? '');
  if (!eventId) return res.status(400).json({ code: 'NO_EVENT_ID', message: 'Missing event id' });
  try { await WebhookEvent.create({ eventId, processedAt: new Date() }); }
  catch (e: any) { if (e?.code === 11000) return res.json({ ok: true, duplicate: true }); throw e; } // dedupe
  const evt = JSON.parse(body.toString('utf8'));
  const payment = evt?.payload?.payment?.entity;
  const rpOrderId: string | undefined = payment?.order_id;
  if (rpOrderId) {
    const order = await Order.findOne({ razorpayOrderId: rpOrderId });
    if (order) {
      if (evt.event === 'payment.captured' || evt.event === 'order.paid') await finalizePaid(order._id, payment?.id);
      else if (evt.event === 'payment.failed') await releaseUnpaid(order._id, 'failed');
    }
  }
  res.json({ ok: true });
}
