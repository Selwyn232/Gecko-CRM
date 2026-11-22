/** Lijniconen voor het menu (20×20, kleur volgt de tekst). */
const PATHS = {
  werk: "M3 9.5 10 3.5l7 6M5 8.2V17h10V8.2M8.5 17v-4.5h3V17",
  whatsapp: "M10 2.8a7.2 7.2 0 0 0-6.2 10.9L2.8 17.2l3.6-1a7.2 7.2 0 1 0 3.6-13.4zM7.4 7.2c.2-.4.6-.5.9-.4l.6 1.4-.5.7c.4.9 1.2 1.7 2.1 2.1l.7-.5 1.4.6c.1.3 0 .7-.4.9-1.6.9-5.2-2.6-4.8-4.8z",
  inbox: "M3 11.5 5 4h10l2 7.5V16H3zM3 11.5h4l1 2h4l1-2h4",
  hulp: "M4 4.5C6 3.5 8 3.5 10 5c2-1.5 4-1.5 6-.5v11c-2-1-4-1-6 .5-2-1.5-4-1.5-6-.5zM10 5v10.5",
  klanten: "M7.5 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM2.5 17c0-3 2.2-5.2 5-5.2s5 2.2 5 5.2M13 3.4a3 3 0 0 1 0 5.4M17.5 17c0-2.3-1.2-4-3-4.7",
  offertes: "M5 2.5h7l3.5 3.5v11.5H5zM12 2.5V6h3.5M8 10h5M8 13h4",
  projecten: "M3 3.5h4v13H3zM8.5 3.5h4v9h-4zM14 3.5h3v6h-3z",
  planning: "M3 4.5h14v12.5H3zM3 8.5h14M7 2.5v4M13 2.5v4M6.5 12h2M11.5 12h2",
  facturen: "M5 2.5h10v15l-2.5-1.5-2.5 1.5-2.5-1.5L5 17.5zM8 7h4M8 10h4M8 13h2",
  selfbilling: "M3 6.5h14v9H3zM3 9.5h14M6 13h3M12.5 4l-6 0",
  rapportages: "M3 17h14M5 14V9M9 14V5M13 14v-6M17 14v-3",
  producten: "M10 2.5 17 6v8l-7 3.5L3 14V6zM3 6l7 3.5L17 6M10 9.5v8",
  kanalen: "M3 10h3l2-5 4 10 2-5h3",
  organisaties: "M3 17V6l5-3v14M8 17V8.5l9 2.5v6M3 17h14M5.5 8h0M5.5 11h0M11 13h0M14 13.5h0",
  reizen: "M4 15.5a2 2 0 1 0 0-.1M16 4.5a2 2 0 1 0 0-.1M6 15.5h6a3 3 0 0 0 0-6H8a3 3 0 0 1 0-6h6",
  berichten: "M3 4.5h14v9H8l-4 3v-3H3z",
  checklists: "M8 5.5h9M8 10h9M8 14.5h9M3 5.5l1.2 1.2L6 4.5M3 10l1.2 1.2L6 9M3 14.5l1.2 1.2L6 13.5",
  regios: "M7 3.5 3 5v11.5l4-1.5 6 1.5 4-1.5V3.5L13 5zM7 3.5V15M13 5v11.5",
  beschikbaarheid: "M10 17.5a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15zM10 5.5V10l3 2",
  gebruikers: "M10 9.5a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4zM4 17.5c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5",
  rollen: "M10 2.5 16 5v4.5c0 3.7-2.6 6.6-6 8-3.4-1.4-6-4.3-6-8V5zM7.5 10l2 2 3.5-3.5",
  logboek: "M4 3.5h12v14H4zM7 7h6M7 10h6M7 13h3",
  instellingen: "M10 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4",
  testen: "M7.5 2.5h5M8.5 2.5v5l-4.5 8a1.5 1.5 0 0 0 1.3 2h9.4a1.5 1.5 0 0 0 1.3-2l-4.5-8v-5M6 12.5h8",
} as const;

export type IconName = keyof typeof PATHS;

export function NavIcon({ name }: { name: IconName }) {
  return (
    <svg className="nav-icon" width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">
      <path d={PATHS[name]} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
