/**
 * Buitengerechtelijke incassokosten volgens het Besluit vergoeding voor buitengerechtelijke
 * incassokosten (WIK). Staffel over de hoofdsom; minimaal €40, maximaal €6.775. Bedragen in centen.
 */
const BRACKETS: [upTo: number, rate: number][] = [
  [250_000, 0.15],
  [500_000, 0.1],
  [1_000_000, 0.05],
  [20_000_000, 0.01],
  [Infinity, 0.005],
];

export function wikCollectionCosts(principalCents: number): number {
  let remaining = principalCents;
  let lower = 0;
  let costs = 0;
  for (const [upTo, rate] of BRACKETS) {
    if (remaining <= 0) break;
    const slice = Math.min(remaining, upTo - lower);
    costs += slice * rate;
    remaining -= slice;
    lower = upTo;
  }
  return Math.min(Math.max(Math.round(costs), 4_000), 677_500);
}
