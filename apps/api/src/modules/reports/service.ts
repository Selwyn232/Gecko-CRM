import { sql, type SQL } from "drizzle-orm";
import type { DbOrTx } from "../../db/client.js";
import { todayIso } from "../../lib/dates.js";
import { addDays } from "../planning/service.js";
import { getSetting } from "../settings/service.js";
import { formatProjectNumber } from "../projects/service.js";
import { openItems } from "../selfbilling/service.js";

/**
 * Rapportages (alleen lezen). Bewust in SQL: aggregaties over alle projecten blijven zo snel bij groei.
 * Bedragen in centen; "excl. btw" tenzij anders vermeld.
 */
export interface ReportFilter {
  /** Periode op ingangsdatum (statuswissel, offerte-akkoord of rapport). */
  from?: string;
  to?: string;
  productGroupId?: string;
}

const rows = async <T>(db: DbOrTx, query: SQL) => (await db.execute(query)).rows as T[];
const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const periodOn = (column: SQL, f: ReportFilter) =>
  sql`${f.from ? sql`AND ${column} >= ${f.from}::date` : sql``} ${f.to ? sql`AND ${column} < (${f.to}::date + 1)` : sql``}`;
const groupOn = (column: SQL, f: ReportFilter) => (f.productGroupId ? sql`AND ${column} = ${f.productGroupId}::uuid` : sql``);

// ---------------------------------------------------------------- Doorlooptijd

/**
 * Per status: hoe lang projecten er gemiddeld (en mediaan) in bleven, en hoeveel er nu in staan en hoe lang al.
 * Plus de totale doorlooptijd van opdracht tot afgerond.
 */
export async function leadTimes(db: DbOrTx, f: ReportFilter) {
  const perStatus = await rows<Record<string, unknown>>(
    db,
    sql`
    WITH stays AS (
      SELECT h.project_id, h.to_status_id AS status_id, h.changed_at,
             lead(h.changed_at) OVER (PARTITION BY h.project_id ORDER BY h.changed_at, h.id) AS left_at
      FROM project_status_history h
      JOIN projects p ON p.id = h.project_id
      WHERE true ${groupOn(sql`p.product_group_id`, f)}
    )
    SELECT s.id, s.name, s.phase, s.color, s.sort_order, s.is_final, s.product_group_id, g.name AS group_name,
           count(*) FILTER (WHERE st.left_at IS NOT NULL ${periodOn(sql`st.left_at`, f)}) AS done,
           avg(extract(epoch FROM st.left_at - st.changed_at) / 86400) FILTER (WHERE st.left_at IS NOT NULL ${periodOn(sql`st.left_at`, f)}) AS avg_days,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM st.left_at - st.changed_at) / 86400)
             FILTER (WHERE st.left_at IS NOT NULL ${periodOn(sql`st.left_at`, f)}) AS median_days,
           count(*) FILTER (WHERE st.project_id IS NOT NULL AND st.left_at IS NULL AND NOT s.is_final) AS current,
           avg(extract(epoch FROM now() - st.changed_at) / 86400) FILTER (WHERE st.project_id IS NOT NULL AND st.left_at IS NULL AND NOT s.is_final) AS current_avg_days
    FROM journey_statuses s
    JOIN product_groups g ON g.id = s.product_group_id
    LEFT JOIN stays st ON st.status_id = s.id
    WHERE g.is_active ${groupOn(sql`s.product_group_id`, f)}
    GROUP BY s.id, g.name, g.sort_order
    ORDER BY g.sort_order, g.name, s.sort_order`,
  );
  const total = await rows<Record<string, unknown>>(
    db,
    sql`
    SELECT p.product_group_id, count(*) AS projects,
           avg(extract(epoch FROM h.changed_at - p.created_at) / 86400) AS avg_days,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM h.changed_at - p.created_at) / 86400) AS median_days
    FROM projects p
    JOIN journey_statuses s ON s.id = p.status_id AND s.is_final AND s.key <> 'geannuleerd'
    JOIN LATERAL (SELECT changed_at FROM project_status_history WHERE project_id = p.id AND to_status_id = p.status_id ORDER BY changed_at DESC LIMIT 1) h ON true
    WHERE true ${groupOn(sql`p.product_group_id`, f)} ${periodOn(sql`h.changed_at`, f)}
    GROUP BY p.product_group_id`,
  );
  const groups = new Map<string, { productGroup: { id: string; name: string }; total: { projects: number; avgDays: number | null; medianDays: number | null }; statuses: unknown[] }>();
  for (const r of perStatus) {
    const gid = String(r.product_group_id);
    if (!groups.has(gid)) {
      const t = total.find((x) => String(x.product_group_id) === gid);
      groups.set(gid, {
        productGroup: { id: gid, name: String(r.group_name) },
        total: { projects: Number(t?.projects ?? 0), avgDays: n(t?.avg_days), medianDays: n(t?.median_days) },
        statuses: [],
      });
    }
    groups.get(gid)!.statuses.push({
      id: r.id,
      name: r.name,
      phase: r.phase,
      color: r.color,
      isFinal: r.is_final,
      done: Number(r.done),
      avgDays: n(r.avg_days),
      medianDays: n(r.median_days),
      current: Number(r.current),
      currentAvgDays: n(r.current_avg_days),
    });
  }
  return [...groups.values()];
}

/** Lopende projecten die het langst in hun huidige status staan (vanaf `minDays`). */
export async function stuckProjects(db: DbOrTx, f: ReportFilter, minDays = 14) {
  const list = await rows<Record<string, unknown>>(
    db,
    sql`
    SELECT p.id, p.number, s.name AS status_name, s.color, g.name AS group_name,
           trim(coalesce(c.first_name, '') || ' ' || c.last_name) AS customer_name,
           extract(epoch FROM now() - p.status_changed_at) / 86400 AS days
    FROM projects p
    JOIN journey_statuses s ON s.id = p.status_id AND NOT s.is_final
    JOIN product_groups g ON g.id = p.product_group_id
    JOIN customers c ON c.id = p.customer_id
    WHERE p.status_changed_at < now() - make_interval(days => ${minDays}) ${groupOn(sql`p.product_group_id`, f)}
    ORDER BY p.status_changed_at
    LIMIT 50`,
  );
  return list.map((r) => ({
    projectId: String(r.id),
    projectNumber: formatProjectNumber(Number(r.number)),
    customerName: String(r.customer_name),
    productGroupName: String(r.group_name),
    status: { name: String(r.status_name), color: String(r.color) },
    days: Math.floor(Number(r.days)),
  }));
}

// ---------------------------------------------------------------- Marge

/**
 * Voorcalculatie per geaccepteerde offerte (incl. meerwerk), op het moment van akkoord vastgelegd:
 * omzet, kostprijs (inkoop + partnertarieven), fee verkoopkanaal en marge. Offertes met een onbekende kostprijs
 * tellen mee in de omzet maar worden apart gemeld (marge dan onvolledig).
 * Daarnaast wat er via selfbilling werkelijk is afgerekend (fee, partner, boetes) — de basis voor nacalculatie.
 */
export async function margins(db: DbOrTx, f: ReportFilter) {
  const base = sql`
    WITH q AS (
      SELECT qt.id, qt.project_id, qt.product_group_id, qt.sales_channel_id, p.installation_partner_id,
             sum(round(l.quantity * l.unit_price_cents)) AS revenue,
             sum(round(l.quantity * l.unit_cost_cents)) AS cost,
             bool_or(l.unit_cost_cents IS NULL) AS cost_missing,
             coalesce(qt.fee_basis_points, 0) AS fee_bp
      FROM quotes qt
      JOIN projects p ON p.id = qt.project_id
      JOIN quote_lines l ON l.quote_id = qt.id
      WHERE qt.status = 'accepted' ${groupOn(sql`qt.product_group_id`, f)} ${periodOn(sql`qt.accepted_at`, f)}
      GROUP BY qt.id, p.installation_partner_id
    ), pq AS (
      SELECT *, round(revenue * fee_bp / 10000.0) AS fee FROM q
    )`;
  const by = async (dimension: SQL, nameJoin: SQL) =>
    rows<Record<string, unknown>>(
      db,
      sql`${base}
      SELECT ${dimension} AS key, ${nameJoin} AS name,
             count(DISTINCT pq.project_id) AS projects, sum(pq.revenue) AS revenue,
             sum(pq.cost) FILTER (WHERE NOT pq.cost_missing) AS cost,
             sum(pq.revenue) FILTER (WHERE NOT pq.cost_missing) AS revenue_known,
             sum(pq.fee) AS fee,
             sum(pq.fee) FILTER (WHERE NOT pq.cost_missing) AS fee_known,
             count(*) FILTER (WHERE pq.cost_missing) AS incomplete
      FROM pq
      GROUP BY 1, 2
      ORDER BY sum(pq.revenue) DESC`,
    );
  const shape = (list: Record<string, unknown>[]) =>
    list.map((r) => {
      const revenueKnown = Number(r.revenue_known ?? 0);
      const marginCents = r.cost === null ? null : revenueKnown - Number(r.cost) - Number(r.fee_known ?? 0);
      return {
        key: r.key === null ? null : String(r.key),
        name: r.name === null ? "Nog geen partner" : String(r.name),
        projects: Number(r.projects),
        revenueCents: Number(r.revenue),
        /** Omzet van offertes met bekende kostprijs: de basis van marge en marge %. */
        revenueKnownCents: revenueKnown,
        costCents: n(r.cost),
        feeCents: Number(r.fee ?? 0),
        marginCents,
        marginBasisPoints: marginCents !== null && revenueKnown > 0 ? Math.round((marginCents * 10_000) / revenueKnown) : null,
        incompleteQuotes: Number(r.incomplete),
      };
    });
  const [productGroups, channels, partners] = await Promise.all([
    by(sql`pq.product_group_id`, sql`(SELECT name FROM product_groups WHERE id = pq.product_group_id)`),
    by(sql`pq.sales_channel_id`, sql`(SELECT name FROM sales_channels WHERE id = pq.sales_channel_id)`),
    by(sql`pq.installation_partner_id`, sql`(SELECT name FROM organizations WHERE id = pq.installation_partner_id)`),
  ]);

  // Werkelijk afgerekend via definitieve selfbilling, per partner.
  const settled = await rows<Record<string, unknown>>(
    db,
    sql`
    SELECT i.partner_organization_id AS key, o.name, o.type,
           sum(l.amount_cents) FILTER (WHERE l.kind = 'fee') AS fee,
           sum(l.amount_cents) FILTER (WHERE l.kind IN ('installation', 'extra_work')) AS partner,
           -sum(l.amount_cents) FILTER (WHERE l.kind = 'penalty') AS penalties,
           sum(l.amount_cents) FILTER (WHERE l.kind = 'correction') AS corrections
    FROM self_billing_lines l
    JOIN self_billing_invoices i ON i.id = l.invoice_id AND i.status <> 'draft'
    JOIN organizations o ON o.id = i.partner_organization_id
    WHERE true ${periodOn(sql`i.invoice_date`, f)}
    GROUP BY 1, 2, 3
    ORDER BY 2`,
  );
  return {
    productGroups: shape(productGroups),
    channels: shape(channels),
    partners: shape(partners),
    settled: settled.map((r) => ({
      partnerId: String(r.key),
      name: String(r.name),
      type: String(r.type),
      feeCents: Number(r.fee ?? 0),
      partnerCents: Number(r.partner ?? 0),
      penaltiesCents: Number(r.penalties ?? 0),
      correctionsCents: Number(r.corrections ?? 0),
    })),
  };
}

// ---------------------------------------------------------------- Installateurs

/**
 * Per installatiepartner: rapporten, first-time-right (opleverrapport in één keer goedgekeurd — nooit afgekeurd),
 * niet-gekomen afspraken en boetes.
 */
export async function partnerQuality(db: DbOrTx, f: ReportFilter) {
  const list = await rows<Record<string, unknown>>(
    db,
    sql`
    WITH r AS (
      SELECT a.partner_organization_id AS partner_id, r.type, r.review,
             EXISTS (SELECT 1 FROM audit_log al WHERE al.action = 'report.rejected'
               AND (al.metadata->>'reportId' = r.id::text OR al.metadata->>'appointmentId' = r.appointment_id::text)) AS was_rejected
      FROM reports r
      JOIN appointments a ON a.id = r.appointment_id
      JOIN projects p ON p.id = a.project_id
      WHERE true ${groupOn(sql`p.product_group_id`, f)} ${periodOn(sql`r.submitted_at`, f)}
    ), ap AS (
      SELECT a.partner_organization_id AS partner_id,
             count(*) FILTER (WHERE a.status = 'completed') AS completed,
             count(*) FILTER (WHERE a.status = 'partner_no_show') AS no_shows
      FROM appointments a
      JOIN projects p ON p.id = a.project_id
      WHERE true ${groupOn(sql`p.product_group_id`, f)} ${periodOn(sql`a.date`, f)}
      GROUP BY 1
    ), pen AS (
      SELECT partner_organization_id AS partner_id, sum(amount_cents) FILTER (WHERE status <> 'waived') AS amount
      FROM partner_penalties WHERE true ${periodOn(sql`created_at`, f)}
      GROUP BY 1
    )
    SELECT o.id, o.name,
           count(r.*) FILTER (WHERE r.type = 'survey') AS surveys,
           count(r.*) FILTER (WHERE r.type = 'installation' AND r.review <> 'pending') AS installations_reviewed,
           count(r.*) FILTER (WHERE r.type = 'installation' AND r.review = 'approved' AND NOT r.was_rejected) AS installations_ftr,
           count(r.*) FILTER (WHERE r.was_rejected) AS rejected_reports,
           coalesce(max(ap.completed), 0) AS completed, coalesce(max(ap.no_shows), 0) AS no_shows,
           coalesce(max(pen.amount), 0) AS penalties
    FROM organizations o
    LEFT JOIN r ON r.partner_id = o.id
    LEFT JOIN ap ON ap.partner_id = o.id
    LEFT JOIN pen ON pen.partner_id = o.id
    WHERE o.type = 'installation_partner' AND o.is_active
    GROUP BY o.id, o.name
    ORDER BY o.name`,
  );
  return list.map((r) => {
    const reviewed = Number(r.installations_reviewed);
    const ftr = Number(r.installations_ftr);
    return {
      partnerId: String(r.id),
      name: String(r.name),
      surveyReports: Number(r.surveys),
      installationsReviewed: reviewed,
      firstTimeRight: ftr,
      firstTimeRightBasisPoints: reviewed ? Math.round((ftr * 10_000) / reviewed) : null,
      rejectedReports: Number(r.rejected_reports),
      completedAppointments: Number(r.completed),
      noShows: Number(r.no_shows),
      penaltiesCents: Number(r.penalties),
    };
  });
}

// ---------------------------------------------------------------- Cashflow

const mondayOf = (iso: string) => {
  const d = new Date(`${iso}T12:00:00Z`);
  return addDays(iso, -((d.getUTCDay() + 6) % 7));
};

/**
 * Prognose per week (incl. btw), 8 weken vooruit:
 * - in: openstaande facturen op vervaldatum (achterstallig in de eerste week), en nog te factureren bedragen
 *   van lopende projecten op geplande installatiedatum + betaaltermijn ("nog niet gepland" apart);
 * - uit: selfbilling — geaccordeerd of wachtend op akkoord nu, en wat klaarstaat om uit te betalen (excl. btw).
 */
export async function cashflow(db: DbOrTx, f: ReportFilter) {
  const today = todayIso();
  const thisWeek = mondayOf(today);
  const weeks = Array.from({ length: 8 }, (_, i) => addDays(thisWeek, i * 7));
  const term = await getSetting(db, "invoice.payment_term_days");

  const receivables = await rows<Record<string, unknown>>(
    db,
    sql`
    SELECT i.due_date, sum(i.total_cents - i.paid_cents) AS outstanding
    FROM invoices i
    LEFT JOIN projects p ON p.id = i.project_id
    WHERE i.status = 'open' AND i.total_cents > i.paid_cents ${groupOn(sql`p.product_group_id`, f)}
    GROUP BY 1`,
  );
  const toInvoice = await rows<Record<string, unknown>>(
    db,
    sql`
    SELECT p.id,
           (SELECT coalesce(sum(round(l.quantity * l.unit_price_cents * (1 + l.vat_rate_basis_points / 10000.0))), 0)
              FROM quotes q JOIN quote_lines l ON l.quote_id = q.id
             WHERE q.project_id = p.id AND q.status = 'accepted') AS ordered,
           (SELECT coalesce(sum(i.total_cents), 0) FROM invoices i WHERE i.project_id = p.id AND i.status <> 'draft') AS invoiced,
           (SELECT max(a.date + a.days - 1) FROM appointments a WHERE a.project_id = p.id AND a.type = 'installation' AND a.status IN ('planned', 'completed')) AS install_end
    FROM projects p
    JOIN journey_statuses s ON s.id = p.status_id AND NOT s.is_final
    WHERE true ${groupOn(sql`p.product_group_id`, f)}`,
  );
  const payables = await rows<Record<string, unknown>>(
    db,
    sql`SELECT approval_status, sum(total_cents) AS total FROM self_billing_invoices WHERE status = 'final' GROUP BY 1`,
  );
  const ready = (await openItems(db)).reduce((s, p) => s + Math.max(0, p.readyCents), 0);

  /** Weekindex 0..7; vóór deze week = 0 (achterstallig), na week 8 = -1 ("later"). */
  const bucket = (date: string | null) => {
    if (!date) return 0;
    const i = Math.floor((Date.parse(date) - Date.parse(weeks[0]!)) / (7 * 86_400_000));
    return i < 0 ? 0 : i >= weeks.length ? -1 : i;
  };
  const rowsOut = weeks.map((w) => ({ weekStart: w, receivablesCents: 0, expectedCents: 0, payablesCents: 0 }));
  let overdueCents = 0;
  let laterInCents = 0;
  let unplannedCents = 0;
  for (const r of receivables) {
    const due = r.due_date ? String(r.due_date).slice(0, 10) : null;
    const amount = Number(r.outstanding);
    if (due && due < today) overdueCents += amount;
    const b = bucket(due);
    if (b === -1) laterInCents += amount;
    else rowsOut[b]!.receivablesCents += amount;
  }
  for (const p of toInvoice) {
    const remaining = Number(p.ordered) - Number(p.invoiced);
    if (remaining <= 0) continue;
    if (!p.install_end) {
      unplannedCents += remaining;
      continue;
    }
    const expected = addDays(String(p.install_end).slice(0, 10), term);
    const b = bucket(expected < today ? today : expected);
    if (b === -1) laterInCents += remaining;
    else rowsOut[b]!.expectedCents += remaining;
  }
  const approved = Number(payables.find((p) => p.approval_status === "approved")?.total ?? 0);
  const awaiting = payables.filter((p) => p.approval_status !== "approved").reduce((s, p) => s + Number(p.total), 0);
  rowsOut[0]!.payablesCents = approved + awaiting + ready;

  let cumulative = 0;
  return {
    weeks: rowsOut.map((w) => {
      const net = w.receivablesCents + w.expectedCents - w.payablesCents;
      cumulative += net;
      return { ...w, netCents: net, cumulativeCents: cumulative };
    }),
    overdueCents,
    laterInCents,
    unplannedCents,
    payables: { approvedCents: approved, awaitingApprovalCents: awaiting, readyToBillCents: ready },
  };
}
