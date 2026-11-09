/**
 * Deterministic Skin Match engine. NO generative AI is involved here (PRD 6.2).
 * Pure functions => fully unit-testable.
 */
export const RULES_VERSION = 'v1.0.0';
export const WEIGHTS = { skinType: 30, concern: 25, sensitivity: 25, twin: 10, climate: 5, preferences: 5 } as const;

export const DISCLAIMER =
  "Based on the information you shared and the product's listed ingredients. Not medical advice. Patch-test new products and stop use if irritation occurs.";
export const DOCTOR_NOTE = 'Please check with your doctor.';

export type Flag = 'fragrance' | 'irritant' | 'comedogenic' | 'pregnancy_caution' | 'active_retinoid' | 'active_acid' | 'drying_alcohol' | 'allergen';
export interface KbEntry { canonicalName: string; aliases: string[]; flags: Flag[] }

export interface MatchProfile {
  skinType?: string; concerns?: string[]; sensitivity?: 'none' | 'mild' | 'high';
  climate?: string; ageBand?: string;
  preferences?: { fragranceFree?: boolean; vegan?: boolean; crueltyFree?: boolean };
  // sensitive (decrypted) – optional, consent-based
  allergies?: string[]; conditions?: string[]; pregnant?: boolean | null; treatments?: string[];
  shelfIngredients?: string[][]; // ingredient lists of products on My Shelf
}
export interface MatchProduct {
  ingredients: string[]; ingredientsVerified: boolean;
  skinTypes: string[]; concerns: string[];
  fragranceFree?: boolean; vegan?: boolean; crueltyFree?: boolean;
}
export interface TwinSignal { count: number; avgRating: number }
export type Level = 'great' | 'good' | 'caution' | 'not_recommended';
export interface MatchOutput {
  score: number; level: Level; confidence: 'High' | 'Medium' | 'Low';
  reasons: string[]; warnings: string[]; blocks: string[];
  disclaimer: string; doctorNote?: string; rulesVersion: string; generatedAt: string;
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
const FRAGRANCE_TERMS = ['fragrance', 'parfum', 'aroma', 'perfume'];

export function buildKbIndex(kb: KbEntry[]) {
  const idx = new Map<string, KbEntry>();
  for (const e of kb) { idx.set(norm(e.canonicalName), e); e.aliases.forEach((a) => idx.set(norm(a), e)); }
  return idx;
}

export function resolveIngredient(name: string, idx: Map<string, KbEntry>) {
  const n = norm(name);
  const hit = idx.get(n);
  const flags = new Set<Flag>(hit?.flags ?? []);
  if (FRAGRANCE_TERMS.some((t) => n === t || n.startsWith(t + ' '))) flags.add('fragrance');
  return { name: hit?.canonicalName ?? n, flags };
}

function allergenMatches(allergy: string, ingredient: { name: string; flags: Set<Flag> }, raw: string) {
  const a = norm(allergy);
  if (!a) return false;
  if (FRAGRANCE_TERMS.includes(a) && ingredient.flags.has('fragrance')) return true;
  const r = norm(raw);
  return ingredient.name === a || r === a || r.includes(a) || ingredient.name.includes(a);
}

export function profileCompleteness(p: MatchProfile): number {
  const fields = [p.skinType && p.skinType !== 'not_sure', p.concerns?.length, p.sensitivity, p.climate, p.ageBand, p.preferences && Object.keys(p.preferences).length];
  return fields.filter(Boolean).length / fields.length;
}

export function computeMatch(profile: MatchProfile, product: MatchProduct, kb: KbEntry[], twin?: TwinSignal, now = new Date()): MatchOutput {
  const idx = buildKbIndex(kb);
  const resolved = product.ingredients.map((raw) => ({ raw, ...resolveIngredient(raw, idx) }));
  const reasons: string[] = []; const warnings: string[] = []; const blocks: string[] = [];
  const hasIngredients = resolved.length > 0;

  // ---- 1. Hard blocks ----
  for (const allergy of profile.allergies ?? []) {
    const hit = resolved.find((r) => allergenMatches(allergy, r, r.raw));
    if (hit) blocks.push(`Contains "${hit.raw}", which matches "${allergy}" on your avoid list.`);
  }
  if (profile.pregnant === true) {
    const hit = resolved.find((r) => r.flags.has('pregnancy_caution'));
    if (hit) blocks.push(`Contains "${hit.raw}", an ingredient often flagged for caution during pregnancy.`);
  }

  // ---- 2. Warnings ----
  const irritants = resolved.filter((r) => r.flags.has('irritant') || r.flags.has('drying_alcohol'));
  const hasFragrance = resolved.some((r) => r.flags.has('fragrance'));
  const comedogenic = resolved.filter((r) => r.flags.has('comedogenic'));
  if (profile.sensitivity && profile.sensitivity !== 'none' && (irritants.length || hasFragrance)) {
    warnings.push('May be irritating for sensitive skin: ' + [...irritants.map((i) => i.raw), ...(hasFragrance ? ['fragrance'] : [])].slice(0, 4).join(', ') + '.');
  }
  if (profile.concerns?.includes('acne') && comedogenic.length) {
    warnings.push(`Contains ingredients that can clog pores for some acne-prone skin: ${comedogenic.slice(0, 3).map((c) => c.raw).join(', ')}.`);
  }
  // My Shelf conflict: retinoid + acid / duplicate actives
  const productFlags = new Set(resolved.flatMap((r) => [...r.flags]));
  for (const shelf of profile.shelfIngredients ?? []) {
    const sf = new Set(shelf.flatMap((n) => [...resolveIngredient(n, idx).flags]));
    if ((productFlags.has('active_retinoid') && sf.has('active_acid')) || (productFlags.has('active_acid') && sf.has('active_retinoid'))) {
      warnings.push('Possible routine conflict: this product and an item on My Shelf contain strong actives (retinoid + exfoliating acid). Check product instructions or ask a qualified professional.');
      break;
    }
  }
  if (!hasIngredients) warnings.push('Full ingredient list is missing, so we could not check this product against your profile.');
  else if (!product.ingredientsVerified) warnings.push('Ingredient list has not been verified by our team yet.');

  // ---- 3. Score (missing data is NEVER treated as a positive) ----
  let skinType = WEIGHTS.skinType / 2;
  if (profile.skinType && profile.skinType !== 'not_sure' && product.skinTypes.length) {
    if (product.skinTypes.includes('all') || product.skinTypes.includes(profile.skinType)) { skinType = WEIGHTS.skinType; reasons.push(`Listed as suitable for ${profile.skinType} skin.`); }
    else { skinType = 0; reasons.push(`Not listed as suitable for ${profile.skinType} skin.`); }
  } else reasons.push('Skin type fit could not be fully checked (missing profile or product data).');

  let concern = WEIGHTS.concern / 2;
  if (profile.concerns?.length && product.concerns.length) {
    const covered = profile.concerns.filter((c) => product.concerns.includes(c));
    concern = Math.round((covered.length / profile.concerns.length) * WEIGHTS.concern);
    if (covered.length) reasons.push(`Targets your concern${covered.length > 1 ? 's' : ''}: ${covered.join(', ')}.`);
    else reasons.push('Does not list any of your selected concerns.');
  }

  let sensitivity = WEIGHTS.sensitivity / 2;
  if (profile.sensitivity && hasIngredients) {
    const pen = profile.sensitivity === 'none' ? 0 : profile.sensitivity === 'mild' ? 6 : 10;
    sensitivity = Math.max(0, WEIGHTS.sensitivity - pen * (irritants.length + (hasFragrance ? 1 : 0)));
    if (sensitivity === WEIGHTS.sensitivity) reasons.push('No common irritants found in the listed ingredients.');
  }

  let twinScore = WEIGHTS.twin / 2;
  if (twin && twin.count >= 5) { twinScore = Math.round((twin.avgRating / 5) * WEIGHTS.twin); reasons.push(`${twin.count} shoppers with a similar profile rated this ${twin.avgRating.toFixed(1)}/5.`); }
  else reasons.push('Not enough reviews from similar profiles yet.');

  let climate = WEIGHTS.climate / 2;
  if (profile.climate) climate = profile.climate === 'hot_humid' && comedogenic.length ? 0 : WEIGHTS.climate;

  let prefs = WEIGHTS.preferences / 2;
  const wants: boolean[] = [];
  if (profile.preferences?.fragranceFree) wants.push(!!product.fragranceFree && !hasFragrance);
  if (profile.preferences?.vegan) wants.push(!!product.vegan);
  if (profile.preferences?.crueltyFree) wants.push(!!product.crueltyFree);
  if (wants.length) {
    prefs = Math.round((wants.filter(Boolean).length / wants.length) * WEIGHTS.preferences);
    if (wants.some((w) => !w)) reasons.push('Does not meet all of your preferences.');
  }

  const score = Math.max(0, Math.min(100, Math.round(skinType + concern + sensitivity + twinScore + climate + prefs)));

  // ---- 4. Level ----
  let level: Level;
  if (blocks.length || score < 40) level = 'not_recommended';
  else if (warnings.length || score < 60) level = 'caution';
  else if (score < 80) level = 'good';
  else level = 'great';

  // ---- 5. Confidence ----
  const completeness = profileCompleteness(profile);
  const confidence: MatchOutput['confidence'] =
    !hasIngredients || !product.ingredientsVerified || completeness < 0.3 ? 'Low'
      : completeness >= 0.7 ? 'High' : 'Medium';

  const doctor = (profile.conditions?.some((c) => c && c !== 'none' && c !== 'prefer_not_to_say')) || profile.pregnant === true || !!profile.treatments?.length;
  return {
    score, level, confidence, reasons, warnings, blocks, disclaimer: DISCLAIMER,
    doctorNote: doctor ? DOCTOR_NOTE : undefined, rulesVersion: RULES_VERSION, generatedAt: now.toISOString(),
  };
}
