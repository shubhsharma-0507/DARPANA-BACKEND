import { Notification, User } from '../../models/user';
import { sendMail } from './mailer';

/** In-app notification for every admin + an email copy (printed to the console in development). */
export async function notifyAdmins(title: string, body: string, link?: string) {
  await Notification.create({ role: 'ADMIN', type: 'request', title, body, link });
  const admins = await User.find({ role: 'ADMIN', status: 'active' }).select('email').lean();
  await Promise.all(admins.map((a) => sendMail(a.email, title, body).catch(() => undefined)));
}
