/**
 * Geld is altijd een geheel aantal centen. Hoeveelheden kunnen decimalen hebben (bv. 12,5 m²);
 * vermenigvuldigen gebeurt via duizendsten om afrondingsfouten van floating point te vermijden.
 */
export function multiplyCents(priceCents: number, quantity: string | number): number {
  const milli = Math.round(Number(quantity) * 1000);
  return Math.round((priceCents * milli) / 1000);
}
