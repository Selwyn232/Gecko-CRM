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

export function layout(company: Company, bodyHtml: string) {
  const footer = escapeHtml(companyFooter(company)).replace(/\n/g, "<br>");
  return `<!doctype html><html lang="nl"><body style="margin:0;padding:0;background:#f6f7f5;font-family:Arial,Helvetica,sans-serif;color:#1c211d">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f7f5;padding:24px 0"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:8px;border:1px solid #dfe3dd">
<tr><td style="padding:20px 28px;border-bottom:3px solid #1f7a4d;font-size:18px;font-weight:bold">${escapeHtml(company.name)}</td></tr>
<tr><td style="padding:24px 28px;font-size:15px;line-height:1.55">${bodyHtml}</td></tr>
<tr><td style="padding:16px 28px;border-top:1px solid #dfe3dd;font-size:12px;color:#5f6b62">${footer}</td></tr>
</table></td></tr></table></body></html>`;
}

export const button = (href: string, label: string) =>
  `<p style="margin:24px 0"><a href="${escapeHtml(href)}" style="background:#1f7a4d;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:6px;font-weight:bold;display:inline-block">${escapeHtml(label)}</a></p>`;
