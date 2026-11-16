import { boolean, date, index, integer, jsonb, pgEnum, pgTable, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { id, timestamps } from "../../db/columns.js";
import { users } from "../auth/schema.js";
import { files } from "../files/schema.js";
import { organizations } from "../organizations/schema.js";
import { projects } from "../projects/schema.js";

/** Regio = set postcodegebieden (4 cijfers), bv. [[1000,1099],[2100,2199]]. Zelf in te stellen. */
export const regions = pgTable("regions", {
  id: id(),
  name: text("name").notNull().unique(),
  postalRanges: jsonb("postal_ranges").$type<[number, number][]>().notNull(),
  isActive: boolean("is_active").notNull().default(true),
  ...timestamps(),
});

/** Capaciteit die een installatiepartner per dag per regio opgeeft. De partner wordt hieraan gehouden. */
export const availability = pgTable(
  "availability",
  {
    id: id(),
    partnerOrganizationId: uuid("partner_organization_id").notNull().references(() => organizations.id),
    regionId: uuid("region_id").notNull().references(() => regions.id),
    date: date("date").notNull(),
    surveySlots: integer("survey_slots").notNull().default(0),
    installationSlots: integer("installation_slots").notNull().default(0),
    ...timestamps(),
  },
  (t) => [unique("availability_unique").on(t.partnerOrganizationId, t.regionId, t.date), index("availability_date_idx").on(t.date)],
);

export const appointmentType = pgEnum("appointment_type", ["survey", "installation"]);
export const appointmentStatus = pgEnum("appointment_status", ["planned", "completed", "canceled", "partner_no_show"]);
export const timeWindow = pgEnum("time_window", ["morning", "afternoon", "day"]);

export const appointments = pgTable(
  "appointments",
  {
    id: id(),
    projectId: uuid("project_id").notNull().references(() => projects.id),
    partnerOrganizationId: uuid("partner_organization_id").notNull().references(() => organizations.id),
    regionId: uuid("region_id").notNull().references(() => regions.id),
    type: appointmentType("type").notNull(),
    date: date("date").notNull(),
    /** Aantal werkdagen dat de afspraak beslaat (installatie kan meerdere dagen zijn). */
    days: integer("days").notNull().default(1),
    timeWindow: timeWindow("time_window").notNull().default("day"),
    status: appointmentStatus("status").notNull().default("planned"),
    notes: text("notes"),
    cancelReason: text("cancel_reason"),
    createdBy: uuid("created_by").references(() => users.id),
    ...timestamps(),
  },
  (t) => [
    index("appointments_project_idx").on(t.projectId),
    index("appointments_partner_date_idx").on(t.partnerOrganizationId, t.date),
  ],
);

export const reportReview = pgEnum("report_review", ["pending", "approved", "rejected"]);

/**
 * Rapport van de partner bij een afspraak: schouwrapport of opleverrapport.
 * Inhoud (checklist, opmerkingen, serienummers, voorgesteld meerwerk) in `data`; foto's in files.
 */
export const reports = pgTable(
  "reports",
  {
    id: id(),
    appointmentId: uuid("appointment_id").notNull().references(() => appointments.id),
    type: appointmentType("type").notNull(),
    /** Schouw: technisch goedgekeurd? Oplevering: installatie werkt? */
    positive: boolean("positive").notNull(),
    data: jsonb("data").$type<ReportData>().notNull(),
    customerSignedName: text("customer_signed_name"),
    customerSignatureFileId: uuid("customer_signature_file_id").references(() => files.id),
    submittedBy: uuid("submitted_by").references(() => users.id),
    submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
    review: reportReview("review").notNull().default("pending"),
    reviewedBy: uuid("reviewed_by").references(() => users.id),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewNote: text("review_note"),
  },
  (t) => [uniqueIndex("reports_appointment_unique").on(t.appointmentId)],
);

export interface ReportData {
  remarks?: string;
  checklist?: Record<string, boolean>;
  serialNumbers?: string[];
  /** Voorgesteld meerwerk (alleen schouw): producten uit de meerwerkcatalogus. */
  extraWork?: { productId: string; quantity: number; note?: string }[];
}
