import { env } from '../../config/env';
import { Setting } from '../../models/user';

export interface Coupon { code: string; percent: number; minSubtotal: number; active: boolean }
const defaults = {
  commissionPercent: env.DEFAULT_COMMISSION_PERCENT,
  shipping: { flatPerSeller: 49, freeAbove: 999 },
  returnWindowDays: 7,
  payoutHoldDays: 7,
  coupons: [{ code: 'WELCOME10', percent: 10, minSubtotal: 499, active: true }] as Coupon[],
};
export type Settings = typeof defaults;
export async function getSetting<K extends keyof Settings>(key: K): Promise<Settings[K]> {
  const s = await Setting.findOne({ key }).lean();
  return (s?.value as Settings[K]) ?? defaults[key];
}
export const setSetting = (key: keyof Settings, value: unknown) => Setting.findOneAndUpdate({ key }, { value }, { upsert: true, new: true });
export const SETTING_KEYS = Object.keys(defaults) as (keyof Settings)[];
