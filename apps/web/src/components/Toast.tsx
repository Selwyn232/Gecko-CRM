import { useEffect, useState } from "react";

/**
 * Korte bevestiging rechtsonder ("Opgeslagen ✓") na een geslaagde actie. Wordt automatisch getoond voor
 * elke geslaagde mutatie (zie main.tsx); een mutatie kan via `meta: { toast: "Tekst" }` een eigen tekst
 * geven of met `meta: { toast: false }` de melding overslaan.
 */
interface ToastItem {
  id: number;
  text: string;
}

let items: ToastItem[] = [];
let nextId = 1;
const listeners = new Set<(t: ToastItem[]) => void>();
const emit = () => listeners.forEach((l) => l(items));

export function toast(text: string) {
  // Dezelfde tekst niet stapelen: vervang de vorige.
  items = [...items.filter((t) => t.text !== text), { id: nextId++, text }].slice(-3);
  emit();
  const id = items[items.length - 1]!.id;
  setTimeout(() => {
    items = items.filter((t) => t.id !== id);
    emit();
  }, 3200);
}

/** Alleen geplaatst in de ingelogde schermen; op publieke pagina's (klant, offerte) geen meldingen. */
export function Toaster() {
  const [list, setList] = useState<ToastItem[]>(items);
  useEffect(() => {
    listeners.add(setList);
    return () => {
      listeners.delete(setList);
    };
  }, []);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className="toast">
          <span className="toast-check" aria-hidden="true">
            <svg width="12" height="12" viewBox="0 0 12 12"><path d="M2.5 6.2 5 8.5l4.5-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </span>
          {t.text}
        </div>
      ))}
    </div>
  );
}
