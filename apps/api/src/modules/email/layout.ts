/** Eenvoudige, robuuste e-mailopmaak (tabellen en inline stijlen, zoals e-mailprogramma's dat willen). */

export const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export interface Company {
  name: string;
  street?: string | null;
  houseNumber?: string | null;
  postalCode?: string | null;
  city?: string | null;
  email?: string | null;
  phone?: string | null;
  kvkNumber?: string | null;
  vatNumber?: string | null;
}

export function companyFooter(c: Company) {
  const address = [c.street && `${c.street} ${c.houseNumber ?? ""}`.trim(), [c.postalCode, c.city].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  return [c.name, address, [c.email, c.phone].filter(Boolean).join(" · "), [c.kvkNumber && `KvK ${c.kvkNumber}`, c.vatNumber && `btw ${c.vatNumber}`].filter(Boolean).join(" · ")]
    .filter(Boolean)
    .join("\n");
}

/** Markeringen waarmee de verzending (sendEmail) kop en klantreis per klant kan invullen. */
export const HEAD_START = "<!--gk:head-->";
export const HEAD_END = "<!--/gk:head-->";
export const JOURNEY_SLOT = "<!--gk:journey-->";

export function layout(company: Company, bodyHtml: string) {
  const footer = escapeHtml(companyFooter(company)).replace(/\n/g, "<br>");
  const logo = process.env.APP_BASE_URL ? `${process.env.APP_BASE_URL.replace(/\/$/, "")}/gecko-logo-64.png` : null;
  const head = `${HEAD_START}<tr><td style="padding:18px 28px;border-bottom:3px solid #fc8801;font-size:19px;font-weight:bold">${
    logo ? `<img src="${escapeHtml(logo)}" width="28" height="28" alt="" style="vertical-align:-7px;margin-right:8px;border:0">` : ""
  }${escapeHtml(brandOf(company.name))}</td></tr>${HEAD_END}`;
  return `<!doctype html><html lang="nl"><head><meta name="color-scheme" content="light only"><meta name="format-detection" content="address=no,telephone=no,date=no"></head><body style="margin:0;padding:0;background:#f1f3ef;font-family:-apple-system,'Segoe UI',Arial,Helvetica,sans-serif;color:#1c211d">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f3ef;padding:24px 0"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;border:1px solid #e1e5df;overflow:hidden">
${head}
<tr><td style="padding:24px 28px 8px;font-size:15px;line-height:1.6">${bodyHtml}</td></tr>
${JOURNEY_SLOT}
<tr><td style="padding:16px 28px;background:#f7f8f6;border-top:1px solid #e1e5df;font-size:12px;line-height:1.6;color:#6b746d">${footer}</td></tr>
</table></td></tr></table></body></html>`;
}

const brandOf = (name: string) => name.replace(/\s+(B\.?V\.?|N\.?V\.?)$/i, "").trim() || name;

const initials = (name: string) =>
  name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase())
    .slice(0, 2)
    .join("");

/** Kop "Bericht van je klantspecialist" met foto (of initialen), B81/B84. */
export function specialistHead(sp: { name: string; photoUrl: string | null; brand: string }) {
  const first = sp.name.trim().split(/\s+/)[0] ?? sp.name;
  const avatar = sp.photoUrl
    ? `<img src="${escapeHtml(sp.photoUrl)}" width="52" height="52" alt="${escapeHtml(first)}" style="display:block;width:52px;height:52px;border-radius:26px;border:3px solid #fc8801;object-fit:cover">`
    : `<div style="width:52px;height:52px;line-height:52px;border-radius:26px;border:3px solid #fc8801;background:#2f7a4f;color:#ffffff;text-align:center;font-weight:bold;font-size:17px">${escapeHtml(initials(sp.name))}</div>`;
  return `<tr><td style="background:#1f3b2c;padding:20px 28px"><table role="presentation" cellpadding="0" cellspacing="0"><tr>
<td style="padding-right:14px;vertical-align:middle">${avatar}</td>
<td style="vertical-align:middle;color:#ffffff"><div style="font-size:13px;color:#c9d6cd">Bericht van uw klantspecialist</div><div style="font-size:17px;font-weight:bold">${escapeHtml(first)} van ${escapeHtml(sp.brand)}</div></td>
</tr></table></td></tr>`;
}

/** Ondertekening door de specialist (als de tekst zelf geen afsluiting heeft). */
export function specialistSignature(sp: { name: string; brand: string }) {
  return `<tr><td style="padding:0 28px 12px;font-size:15px;line-height:1.6">Met vriendelijke groet,<br><strong>${escapeHtml(sp.name.trim().split(/\s+/)[0] ?? sp.name)}</strong><br><span style="color:#6b746d;font-size:13px">Klantspecialist ${escapeHtml(sp.brand)}</span></td></tr>`;
}

/** Subtiele voortgang onderaan: waar staat de klant in de klantreis. */
export function journeyBar(steps: string[], current: number) {
  if (steps.length < 2 || current < 0) return "";
  const cells = steps
    .map((label, i) => {
      const done = i < current;
      const now = i === current;
      const bar = done || now ? "#2f7a4f" : "#e1e5df";
      const color = now ? "#1c211d" : done ? "#2f7a4f" : "#9aa39c";
      return `<td style="padding:0 3px;vertical-align:top;width:${Math.floor(100 / steps.length)}%"><div style="height:4px;border-radius:2px;background:${now ? "#fc8801" : bar};font-size:0;line-height:0">&nbsp;</div><div style="padding-top:6px;font-size:11px;line-height:1.3;color:${color};${now ? "font-weight:bold;" : ""}text-align:center">${done ? "✓ " : ""}${escapeHtml(label)}</div></td>`;
    })
    .join("");
  return `<tr><td style="padding:8px 25px 20px"><div style="font-size:11px;color:#6b746d;padding:0 3px 8px;letter-spacing:.04em;text-transform:uppercase">Waar u nu staat</div><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>${cells}</tr></table></td></tr>`;
}

export const button = (href: string, label: string) =>
  `<p style="margin:24px 0"><a href="${escapeHtml(href)}" style="background:#fc8801;color:#1c1712;text-decoration:none;padding:12px 22px;border-radius:6px;font-weight:bold;display:inline-block">${escapeHtml(label)}</a></p>`;
