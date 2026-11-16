import { and, asc, eq, sql } from "drizzle-orm";
import type { Db, DbOrTx } from "../../db/client.js";
import type { ActorContext } from "../../lib/context.js";
import { emitEvent } from "../events/service.js";
import { projects } from "../projects/schema.js";
import { changeStatus } from "../projects/service.js";
import type { JourneyEvent } from "./events.js";
import { journeyStatuses, journeyTransitions } from "./schema.js";

/** Meldt een klantreis-gebeurtenis; de outbox-verwerker voert de eventuele statuswissel uit. */
export const emitJourneyEvent = (tx: DbOrTx, projectId: string, event: JourneyEvent) =>
  emitEvent(tx, "journey.event", { type: "project", id: projectId }, { projectId, event });

/**
 * Zet het project in de volgende status die op deze gebeurtenis reageert, mits die overgang vanuit de
 * huidige status is toegestaan. Geen passende status = niets doen (bewust: de klantreis is leidend).
 */
export async function applyJourneyEvent(db: Db, projectId: string, event: JourneyEvent) {
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!project) return null;
  const [target] = await db
    .select({ id: journeyStatuses.id })
    .from(journeyTransitions)
    .innerJoin(journeyStatuses, eq(journeyStatuses.id, journeyTransitions.toStatusId))
    .where(
      and(
        eq(journeyTransitions.fromStatusId, project.statusId),
        eq(journeyStatuses.isActive, true),
        sql`${event} = ANY(${journeyStatuses.autoOnEvents})`,
      ),
    )
    .orderBy(asc(journeyStatuses.sortOrder))
    .limit(1);
  if (!target) return null;
  const system: ActorContext = { userId: null, organizationId: null, permissions: new Set() };
  return changeStatus(db, system, projectId, { toStatusId: target.id, expectedStatusId: project.statusId, note: `Automatisch: ${event}` });
}
