import { forbidden } from "../../lib/errors.js";
import { ownCustomersOnly } from "../specialists/service.js";
import { sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import { requirePermission } from "../../http/auth-plugin.js";
import { recordAudit } from "../audit/service.js";

/** Cel voor CSV (puntkomma, Excel NL); cellen die met = + - @ beginnen krijgen een ' (geen formules). */
export const csvCell = (v: unknown) => {
  const raw = v === null || v === undefined ? "" : v instanceof Date ? v.toISOString() : String(v);
  const safe = /^[=+\-@\t\r]/.test(raw) && !/^-?\d/.test(raw) ? `'${raw}` : raw;
  return `"${safe.replace(/"/g, '""')}"`;
};
const euro = (cents: unknown) => (cents === null || cents === undefined ? "" : (Number(cents) / 100).toFixed(2).replace(".", ","));

const EXPORTS = {
  klanten: {
    permission: "customers.read",
    query: sql`SELECT 'K-' || lpad(c.number::text, 6, '0') AS "Klantnummer", c.first_name AS "Voornaam", c.last_name AS "Achternaam",
      c.email AS "E-mail", c.phone AS "Telefoon", p.street || ' ' || p.house_number || coalesce('-' || p.house_number_addition, '') AS "Adres",
      p.postal_code AS "Postcode", p.city AS "Plaats", ch.name AS "Kanaal", c.created_at AS "Aangemaakt"
      FROM customers c
      LEFT JOIN LATERAL (SELECT * FROM properties WHERE customer_id = c.id ORDER BY created_at LIMIT 1) p ON true
      LEFT JOIN sales_channels ch ON ch.id = c.sales_channel_id
      ORDER BY c.number`,
  },
  projecten: {
    permission: "projects.read",
    query: sql`SELECT 'P-' || lpad(pr.number::text, 6, '0') AS "Project", trim(coalesce(c.first_name, '') || ' ' || c.last_name) AS "Klant",
      g.name AS "Productgroep", s.phase AS "Fase", s.name AS "Status", pr.status_changed_at AS "Sinds",
      o.name AS "Installateur", ch.name AS "Kanaal", p.postal_code AS "Postcode", p.city AS "Plaats", pr.created_at AS "Aangemaakt"
      FROM projects pr
      JOIN customers c ON c.id = pr.customer_id
      JOIN properties p ON p.id = pr.property_id
      JOIN product_groups g ON g.id = pr.product_group_id
      JOIN journey_statuses s ON s.id = pr.status_id
      LEFT JOIN organizations o ON o.id = pr.installation_partner_id
      LEFT JOIN sales_channels ch ON ch.id = pr.sales_channel_id
      ORDER BY pr.number`,
  },
  offertes: {
    permission: "quotes.read",
    query: sql`SELECT 'O-' || lpad(q.number::text, 6, '0') AS "Offerte", q.kind AS "Soort", q.status AS "Status",
      trim(coalesce(c.first_name, '') || ' ' || c.last_name) AS "Klant", g.name AS "Productgroep", ch.name AS "Kanaal", a.name AS "Adviseur",
      (SELECT sum(round(l.quantity * l.unit_price_cents)) FROM quote_lines l WHERE l.quote_id = q.id) AS "__excl",
      q.sent_at AS "Verstuurd", q.valid_until AS "Geldig tot", q.accepted_at AS "Geaccepteerd"
      FROM quotes q
      JOIN customers c ON c.id = q.customer_id
      JOIN product_groups g ON g.id = q.product_group_id
      JOIN sales_channels ch ON ch.id = q.sales_channel_id
      LEFT JOIN advisors a ON a.id = q.advisor_id
      ORDER BY q.number`,
  },
} as const;

export const exportRoutes: FastifyPluginAsyncZod<{ db: Db }> = async (app, { db }) => {
  app.get("/exports/:kind", { schema: { params: z.object({ kind: z.enum(["klanten.csv", "projecten.csv", "offertes.csv"]) }) } }, async (req, reply) => {
    if (ownCustomersOnly(req.actor)) throw forbidden("export_not_allowed", "Exporteren kan alleen met toegang tot alle klanten");
    const kind = req.params.kind.replace(".csv", "") as keyof typeof EXPORTS;
    const def = EXPORTS[kind];
    await requirePermission(def.permission)(req, reply);
    const rows = (await db.execute(def.query)).rows as Record<string, unknown>[];
    const cols = rows[0] ? Object.keys(rows[0]) : [];
    const header = cols.map((c) => (c === "__excl" ? "Bedrag excl. btw" : c));
    const lines = [header.map(csvCell).join(";"), ...rows.map((r) => cols.map((c) => csvCell(c === "__excl" ? euro(r[c]) : r[c])).join(";"))];
    await recordAudit(db, req.actor, { action: "export.downloaded", entityType: "export", entityId: kind, metadata: { rows: rows.length } });
    reply.header("content-type", "text/csv; charset=utf-8").header("content-disposition", `attachment; filename="${kind}-${new Date().toISOString().slice(0, 10)}.csv"`);
    return `﻿${lines.join("\r\n")}`;
  });
};
