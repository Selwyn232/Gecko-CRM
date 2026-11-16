import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import { requirePermission } from "../../http/auth-plugin.js";
import { isIsoDate } from "../../lib/dates.js";
import { cashflow, leadTimes, margins, partnerQuality, stuckProjects } from "./service.js";

const IsoDate = z.string().refine(isIsoDate, "Datum moet YYYY-MM-DD zijn");

/**
 * Eén overzicht; elk onderdeel alleen met het bijbehorende recht:
 * marge alleen met inkoopprijzen (B24), cashflow alleen met factuurrechten.
 */
export const reportRoutes: FastifyPluginAsyncZod<{ db: Db }> = async (app, { db }) => {
  app.get(
    "/reports/overview",
    {
      preValidation: requirePermission("projects.read"),
      schema: {
        querystring: z.object({
          from: IsoDate.optional(),
          to: IsoDate.optional(),
          productGroupId: z.string().uuid().optional(),
          stuckDays: z.coerce.number().int().min(1).max(365).default(14),
        }),
      },
    },
    async (req) => {
      const { stuckDays, ...f } = req.query;
      const can = (p: string) => req.actor.permissions.has(p as never);
      const [lead, stuck, quality, margin, cash] = await Promise.all([
        leadTimes(db, f),
        stuckProjects(db, f, stuckDays),
        can("planning.read") ? partnerQuality(db, f) : null,
        can("purchase_prices.read") ? margins(db, f) : null,
        can("invoices.read") ? cashflow(db, f) : null,
      ]);
      return { leadTimes: lead, stuck, partners: quality, margins: margin, cashflow: cash };
    },
  );
};
