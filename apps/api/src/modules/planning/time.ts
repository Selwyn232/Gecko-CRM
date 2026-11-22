/** B87: werkdag 08:00–16:00, tijden in minuten na middernacht. Los bestand zodat berichten en planning het delen. */
export const DAY_START = 480;
export const DAY_END = 960;

export const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

/** Tijd voor de klant: de eerste klus van de dag begint om 08:00; daarna een schatting met 2 uur marge. */
export function arrivalText(startMinute: number | null | undefined) {
  if (startMinute == null) return null;
  if (startMinute <= DAY_START) return "om 08:00 uur";
  const from = Math.max(DAY_START, startMinute - 60);
  return `tussen ${hhmm(from)} en ${hhmm(from + 120)} uur (verwachte aankomst)`;
}
