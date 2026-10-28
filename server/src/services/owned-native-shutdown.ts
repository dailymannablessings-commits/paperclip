import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { heartbeatRuns, nativeRunFinalizations, type Db } from "@paperclipai/db";

export type OwnedNativeShutdownReceipt = {
  leaseOwner: string;
  attempt: number;
  controllerGeneration: number;
  controllerBootId: string;
  controllerPid: number;
  controllerProcessStartedAt: Date;
};

/** Commit a handoff receipt only while this exact controller still owns it.
 * No provider/transport work occurs while acquiring database authority. */
export async function commitOwnedNativeShutdown(input: {
  db: Db;
  runId: string;
  companyId: string;
  issueId: string;
  receipt: OwnedNativeShutdownReceipt;
  historyEntry: Record<string, unknown>;
  now: Date;
}) {
  const { db, receipt } = input;
  const history = JSON.stringify(input.historyEntry);
  const [updated] = await db.update(nativeRunFinalizations).set({
    recoveryState: "awaiting_runner_reattach",
    recoveryHistory: sql`(
      select coalesce(jsonb_agg(item order by ordinal), '[]'::jsonb)
      from jsonb_array_elements(coalesce(${nativeRunFinalizations.recoveryHistory}, '[]'::jsonb)
        || jsonb_build_array(${history}::jsonb)) with ordinality as history(item, ordinal)
      where ordinal > greatest(jsonb_array_length(coalesce(${nativeRunFinalizations.recoveryHistory}, '[]'::jsonb)
        || jsonb_build_array(${history}::jsonb)) - 20, 0)
    )`,
    updatedAt: input.now,
  }).where(and(
    eq(nativeRunFinalizations.runId, input.runId), eq(nativeRunFinalizations.companyId, input.companyId),
    eq(nativeRunFinalizations.issueId, input.issueId), isNull(nativeRunFinalizations.resultId),
    eq(nativeRunFinalizations.controllerBootId, receipt.controllerBootId),
    eq(nativeRunFinalizations.controllerPid, receipt.controllerPid),
    eq(nativeRunFinalizations.controllerProcessStartedAt, receipt.controllerProcessStartedAt),
    eq(nativeRunFinalizations.leaseOwner, receipt.leaseOwner),
    eq(nativeRunFinalizations.attempt, receipt.attempt),
    eq(nativeRunFinalizations.controllerGeneration, receipt.controllerGeneration),
    gt(nativeRunFinalizations.leaseExpiresAt, sql`clock_timestamp()`),
    sql`exists (select 1 from ${heartbeatRuns} where ${heartbeatRuns.id} = ${input.runId}
      and ${heartbeatRuns.companyId} = ${input.companyId} and ${heartbeatRuns.nativeIssueId} = ${input.issueId}
      and ${heartbeatRuns.runtimeMode} = 'native' and ${heartbeatRuns.status} = 'running')`,
  )).returning();
  return updated ?? null;
}
