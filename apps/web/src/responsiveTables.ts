/**
 * Responsieve tabellen: zet het kopje van elke kolom als `data-label` op de cellen en markeert de tabel
 * met `stack`. Op de telefoon toont de CSS zo'n tabel als kaartjes (per rij een blok, per regel kopje + waarde).
 * Werkt automatisch voor alle tabellen met een kopregel; uitzonderen kan met class `no-stack`
 * (documenten met `print-table` worden altijd overgeslagen).
 */
function labelTables() {
  for (const table of document.querySelectorAll<HTMLTableElement>("table:not(.no-stack):not(.print-table)")) {
    const head = table.tHead?.rows[table.tHead.rows.length - 1];
    if (!head) continue;
    const labels: string[] = [];
    for (const th of Array.from(head.cells)) {
      const text = (th.textContent ?? "").trim();
      for (let i = 0; i < th.colSpan; i++) labels.push(text);
    }
    if (!table.classList.contains("stack")) table.classList.add("stack");
    for (const body of Array.from(table.tBodies)) {
      for (const row of Array.from(body.rows)) {
        let index = 0;
        for (const cell of Array.from(row.cells)) {
          // Een cel over meerdere kolommen (bv. uitklapregel) krijgt geen kopje.
          const label = cell.colSpan > 1 ? "" : (labels[index] ?? "");
          if (cell.getAttribute("data-label") !== label) cell.setAttribute("data-label", label);
          index += cell.colSpan;
        }
      }
    }
  }
}

export function startResponsiveTables() {
  let scheduled = false;
  const run = () => {
    scheduled = false;
    labelTables();
  };
  new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(run);
  }).observe(document.body, { childList: true, subtree: true, characterData: true });
  run();
}
