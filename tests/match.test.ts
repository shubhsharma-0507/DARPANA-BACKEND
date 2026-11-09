import { describe, it, expect } from 'vitest';
import { computeMatch, KbEntry } from '../src/modules/matching/engine';
import { rankShades, undertoneFromQuiz } from '../src/modules/matching/shade';

const kb: KbEntry[] = [
  { canonicalName: 'parfum', aliases: ['fragrance'], flags: ['fragrance', 'allergen'] },
  { canonicalName: 'retinol', aliases: [], flags: ['active_retinoid', 'pregnancy_caution'] },
  { canonicalName: 'glycolic acid', aliases: [], flags: ['active_acid', 'irritant'] },
  { canonicalName: 'coconut oil', aliases: [], flags: ['comedogenic'] },
];
const base = { ingredients: ['Aqua', 'Glycerin'], ingredientsVerified: true, skinTypes: ['all'], concerns: ['dryness'] };
const full = { skinType: 'dry', concerns: ['dryness'], sensitivity: 'none' as const, climate: 'temperate', ageBand: '25-34', preferences: { vegan: true } };

describe('match engine', () => {
  it('hard-blocks a declared allergen', () => {
    const r = computeMatch({ ...full, allergies: ['fragrance'] }, { ...base, ingredients: ['Aqua', 'Parfum'] }, kb);
    expect(r.level).toBe('not_recommended'); expect(r.blocks.length).toBe(1);
  });
  it('hard-blocks pregnancy-caution ingredient only when user declared pregnancy', () => {
    const p = { ...base, ingredients: ['Retinol'] };
    expect(computeMatch({ ...full, pregnant: true }, p, kb).level).toBe('not_recommended');
    expect(computeMatch({ ...full, pregnant: null }, p, kb).blocks).toHaveLength(0);
  });
  it('gives great match for a clean complete fit', () => {
    const r = computeMatch(full, { ...base, vegan: true }, kb, { count: 10, avgRating: 4.8 });
    expect(r.level).toBe('great'); expect(r.confidence).toBe('High'); expect(r.score).toBeGreaterThanOrEqual(80);
  });
  it('never treats missing ingredient data as a positive', () => {
    const r = computeMatch(full, { ...base, ingredients: [] }, kb);
    expect(r.level).toBe('caution'); expect(r.confidence).toBe('Low'); expect(r.warnings.join(' ')).toMatch(/missing/);
  });
  it('warns on unverified ingredients and lowers confidence', () => {
    const r = computeMatch(full, { ...base, ingredientsVerified: false }, kb);
    expect(r.confidence).toBe('Low'); expect(r.level).toBe('caution');
  });
  it('flags acne + comedogenic and sensitive + irritant', () => {
    const r = computeMatch({ ...full, concerns: ['acne'], sensitivity: 'high' }, { ...base, ingredients: ['Coconut Oil', 'Glycolic Acid'], concerns: ['acne'] }, kb);
    expect(r.warnings.length).toBe(2); expect(r.level).not.toBe('great');
  });
  it('detects retinoid + acid shelf conflict', () => {
    const r = computeMatch({ ...full, shelfIngredients: [['Glycolic Acid']] }, { ...base, ingredients: ['Retinol'] }, kb);
    expect(r.warnings.join(' ')).toMatch(/routine conflict/);
  });
  it('adds doctor note for disclosed conditions', () => {
    expect(computeMatch({ ...full, conditions: ['eczema'] }, base, kb).doctorNote).toBe('Please check with your doctor.');
    expect(computeMatch(full, base, kb).doctorNote).toBeUndefined();
  });
  it('uses level boundaries', () => {
    const low = computeMatch({ skinType: 'oily', concerns: ['acne'], sensitivity: 'high' }, { ...base, skinTypes: ['dry'], concerns: ['dryness'], ingredients: ['Parfum', 'Glycolic Acid'] }, kb);
    expect(low.score).toBeLessThan(40); expect(low.level).toBe('not_recommended');
  });
});

describe('shade finder', () => {
  const c = (id: string, depth: number, undertone: any, v = true) => ({ variantId: id, productId: 'p', brand: 'B', product: 'P', name: id, depth, undertone, swatchVerified: v });
  it('returns top 3 nearest with confidence', () => {
    const r = rankShades({ depth: 5, undertone: 'warm' }, [c('a', 5, 'warm'), c('b', 6, 'warm'), c('c', 5, 'cool'), c('d', 9, 'warm'), c('e', 5, 'neutral', false)]);
    expect(r).toHaveLength(3); expect(r[0].variantId).toBe('a'); expect(r[0].confidence).toBe('High');
    expect(r.find((x) => x.variantId === 'e')?.confidence).toBe('Low');
  });
  it('derives undertone from quiz', () => {
    expect(undertoneFromQuiz({ sunReaction: 'tans_easily', jewellery: 'gold', veins: 'green' })).toBe('warm');
    expect(undertoneFromQuiz({ sunReaction: 'burns', jewellery: 'silver', veins: 'blue' })).toBe('cool');
  });
});
