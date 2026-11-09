import mongoose from 'mongoose';
import { createApp } from './app';
import { env } from './config/env';
import { Order } from './models/commerce';
import { releaseUnpaid } from './modules/commerce/order.service';

async function main() {
  await mongoose.connect(env.MONGODB_URI, { autoIndex: env.NODE_ENV !== 'production' });
  console.log('MongoDB connected');
  const app = createApp();
  app.listen(env.PORT, () => console.log(`Darpana API listening on :${env.PORT}`));
  // Release stock reserved by unpaid checkouts after expiry.
  setInterval(async () => {
    try {
      const stale = await Order.find({ status: 'pending_payment', reservationExpiresAt: { $lt: new Date() } }).select('_id').limit(50).lean();
      for (const o of stale) await releaseUnpaid(o._id, 'expired');
    } catch (e) { console.error('[sweeper]', e); }
  }, 120_000).unref();
}
main().catch((e) => { console.error(e); process.exit(1); });
