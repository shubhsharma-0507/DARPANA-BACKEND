import { env, isProd } from '../../config/env';
// Transactional email adapter. Plug Resend/SES here. Without credentials, emails are logged in development only.
export async function sendMail(to: string, subject: string, text: string) {
  if (!isProd) { console.log(`[mail:dev] to=${to} subject="${subject}"\n${text}`); return; }
  if (!process.env.RESEND_API_KEY) { console.warn('[mail] RESEND_API_KEY missing; email not sent'); return; }
  await fetch('https://api.resend.com/emails', {
    method: 'POST', headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: process.env.MAIL_FROM || 'Darpana <no-reply@example.com>', to, subject, text }),
  }).catch((e) => console.error('[mail] failed', e));
  void env;
}
