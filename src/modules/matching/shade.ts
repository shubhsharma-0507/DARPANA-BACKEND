export type Undertone = 'cool' | 'neutral' | 'warm' | 'olive';
export interface ShadeQuiz { sunReaction: 'burns' | 'burns_then_tans' | 'tans_easily' | 'rarely_burns'; jewellery: 'silver' | 'gold' | 'both'; veins: 'blue' | 'green' | 'mixed'; depth: number }
export interface ShadeCandidate { variantId: string; productId: string; brand: string; product: string; name: string; depth?: number | null; undertone?: Undertone | null; swatchVerified: boolean; swatchHex?: string | null }
export interface ShadeSuggestion extends ShadeCandidate { distance: number; confidence: 'High' | 'Medium' | 'Low' }

export function undertoneFromQuiz(q: Pick<ShadeQuiz, 'sunReaction' | 'jewellery' | 'veins'>): Undertone {
  const votes: Record<Undertone, number> = { cool: 0, neutral: 0, warm: 0, olive: 0 };
  if (q.jewellery === 'silver') votes.cool++; else if (q.jewellery === 'gold') votes.warm++; else votes.neutral++;
  if (q.veins === 'blue') votes.cool++; else if (q.veins === 'green') votes.olive++; else votes.neutral++;
  if (q.sunReaction === 'burns') votes.cool++; else if (q.sunReaction === 'tans_easily') votes.warm++; else if (q.sunReaction === 'rarely_burns') votes.olive++; else votes.neutral++;
  // green veins + gold often reads warm; olive needs two olive-ish votes
  if (q.veins === 'green' && q.jewellery === 'gold') votes.warm++;
  return (Object.entries(votes).sort((a, b) => b[1] - a[1])[0][0]) as Undertone;
}

const NEIGHBOURS: Record<Undertone, Undertone[]> = { cool: ['neutral'], neutral: ['cool', 'warm', 'olive'], warm: ['neutral', 'olive'], olive: ['warm', 'neutral'] };
export function undertoneDistance(a: Undertone, b: Undertone) { return a === b ? 0 : NEIGHBOURS[a].includes(b) ? 0.75 : 1.75; }

export function rankShades(target: { depth: number; undertone: Undertone }, candidates: ShadeCandidate[], exclude: string[] = []): ShadeSuggestion[] {
  return candidates
    .filter((c) => c.depth != null && c.undertone != null && !exclude.includes(c.variantId))
    .map((c) => {
      const distance = Math.abs((c.depth as number) - target.depth) + undertoneDistance(target.undertone, c.undertone as Undertone);
      const confidence: ShadeSuggestion['confidence'] = !c.swatchVerified ? 'Low' : distance <= 0.5 ? 'High' : distance <= 1.5 ? 'Medium' : 'Low';
      return { ...c, distance, confidence };
    })
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 3);
}
