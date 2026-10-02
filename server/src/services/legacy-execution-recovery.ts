import { normalizeMaxTurnStopReason } from "./heartbeat-stop-metadata.js";
import { hasConversationContinuationPolicy } from "./conversation-continuation.js";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, eq, inArray, sql } from "drizzle-orm";
import { heartbeatRuns, issueRecoveryActions, issues, type Db } from "@paperclipai/db";
import { issueRecoveryActionService } from "./issue-recovery-actions.js";
import { parseIssueExecutionState } from "./issue-execution-policy.js";
import { executionFailureRetryCount } from "./execution-recovery-attempt.js";
import { isSupersededConversationRun } from "./agent-conversations.js";
import { hasAcknowledgedNativeReassignmentStopIntent } from "./acknowledged-native-stop.js";

type Run = typeof heartbeatRuns.$inferSelect;
export const LEGACY_RECOVERY_CAUSE = "legacy_execution_requires_reconciliation";

type HandoffIssue = Pick<typeof issues.$inferSelect,
  "id" | "companyId" | "status" | "statusVersion" | "assigneeAgentId" | "assigneeUserId" |
  "executionState" | "executionPolicy" | "executionRunId" | "checkoutRunId">;

export function issueHandoffStillOwned(expected: HandoffIssue, current: HandoffIssue, runId: string) {
  return current.id === expected.id && current.companyId === expected.companyId &&
    current.status === expected.status && current.statusVersion === expected.statusVersion &&
    current.assigneeAgentId === expected.assigneeAgentId && current.assigneeUserId === expected.assigneeUserId &&
    isDeepStrictEqual(current.executionState, expected.executionState) &&
    isDeepStrictEqual(current.executionPolicy, expected.executionPolicy) &&
    (!current.executionRunId || current.executionRunId === runId) &&
    (!current.checkoutRunId || current.checkoutRunId === runId);
}

/** Late provider accounting must not overwrite a newer control-plane receipt. */
export function preserveIssueHandoff(result: Record<string, unknown> | null | undefined) {
  return sql`${JSON.stringify(result ?? {})}::jsonb || case
    when ${heartbeatRuns.resultJson} ? 'issueHandoff'
    then jsonb_build_object('issueHandoff', ${heartbeatRuns.resultJson}->'issueHandoff')
    else '{}'::jsonb end`;
}

/** Error families describe availability, not whether earlier actions happened. */
export function legacyExecutionNeedsReconciliation(
  run: Pick<Run, "runtimeMode" | "status" | "errorCode" | "resultJson"> & Partial<Pick<Run, "id" | "companyId" | "agentId" | "scheduledRetryAttempt" | "scheduledRetryReason" | "contextSnapshot">>,
): boolean {
  if (
    run.runtimeMode === "native" ||
    !["failed", "timed_out", "interrupted", "cancelled"].includes(run.status)
  )
    return false;
  const handoff = run.resultJson?.issueHandoff as Record<string, unknown> | undefined;
  if (run.status === "cancelled" && run.errorCode === "issue_reassigned" &&
      run.resultJson?.reassignmentStopConfirmed === true && run.id && run.companyId && run.agentId &&
      (run.resultJson?.executionCancellation as Record<string, unknown> | undefined)?.state === "acknowledged" &&
      handoff?.runId === run.id && handoff.companyId === run.companyId &&
      handoff.agentId === run.agentId && typeof handoff.issueId === "string" &&
      handoff.issueId === run.contextSnapshot?.issueId) return false;
  // A fresh conversation turn lets the agent decide what remains. The retry
  // scheduler, not an action-outcome hold, owns the automatic attempt limit.
  if (hasConversationContinuationPolicy(run.resultJson)) return false;
  // Productive turn-budget continuation is not a failed provider session.
  if (normalizeMaxTurnStopReason(run.resultJson?.stopReason) ?? normalizeMaxTurnStopReason(run.errorCode)) return false;
  const evidence = run.resultJson?.executionRecovery as
    Record<string, unknown> | undefined;
  if (run.status === "cancelled" && evidence?.kind === "interrupted"
      && evidence.providerStopped === true && evidence.sessionPreserved === true
      && evidence.actionOutcomes === "settled"
      && (run.resultJson?.executionCancellation as Record<string, unknown> | undefined)?.state === "acknowledged") return false;
  // Waiting for a subscription or workspace precedes provider execution. It is
  // a resource wait, not a failed provider attempt or permission to replay work.
  if (run.status === "cancelled" && run.errorCode === "ai_connection_busy" &&
      evidence?.kind === "ai_connection_wait" && evidence.providerWorkStarted === false) return false;
  if (run.status === "cancelled" && run.errorCode === "workspace_busy" &&
      evidence?.kind === "workspace_wait" && evidence.providerWorkStarted === false) return false;
  // Setup owns the bounded retry budget for temporary workspace scans. Its
  // exhaustion needs workspace repair, not reconciliation of provider actions
  // that the bootstrap evidence proves never started. Keep unknown outcomes held.
  if ((run.errorCode === "workspace_git_scan_timeout" || run.errorCode === "workspace_git_scan_saturated") &&
      evidence?.kind === "bootstrap" && evidence.providerWorkStarted === false) return false;
  if (executionFailureRetryCount(run) >= 2) return true;
  return !(
    evidence?.kind === "bootstrap" && evidence.providerWorkStarted === false
  );
}

/** Called in the task-update transaction, only for its authenticated author run. */
export async function recordCommittedIssueHandoff(db: Db, input: {
  companyId: string; issueId: string; agentId: string; runId: string;
}) {
  const now = new Date();
  const handoff = { ...input, committedAt: now.toISOString() };
  const [recorded] = await db.update(heartbeatRuns).set({
    resultJson: sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) ||
      ${JSON.stringify({ issueHandoff: handoff })}::jsonb`,
    updatedAt: now,
  }).where(and(
    eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId),
    eq(heartbeatRuns.agentId, input.agentId), eq(heartbeatRuns.status, "cancelled"),
    eq(heartbeatRuns.errorCode, "issue_reassigned"),
    sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${input.issueId}`,
    sql`${heartbeatRuns.resultJson}->'reassignmentStopConfirmed' = 'true'::jsonb`,
  )).returning();
  if (!recorded) throw new Error("The task handoff has no confirmed stopped author run");
  if ((recorded.runtimeMode === "native" && !hasAcknowledgedNativeReassignmentStopIntent(recorded)) ||
      (recorded.runtimeMode !== "native" &&
        (recorded.resultJson?.executionCancellation as Record<string, unknown> | undefined)?.state !== "acknowledged")) {
    throw new Error("The task handoff has no provider stop acknowledgement");
  }
  // Stop terminalizes before assignment commits. Retire only that run's hold;
  // preserve unrelated failures and the original cancellation evidence.
  await db.update(issueRecoveryActions).set({
    status: "resolved", outcome: "completed", resolvedAt: now, updatedAt: now,
    resolutionNote: "Confirmed author-run stop and task handoff committed together.",
    evidence: sql`coalesce(${issueRecoveryActions.evidence}, '{}'::jsonb) ||
      ${JSON.stringify({ issueHandoff: handoff })}::jsonb ||
      jsonb_build_object('automaticRecovery',
        coalesce(${issueRecoveryActions.evidence}->'automaticRecovery', '{}'::jsonb) ||
        '{"replay":"not_required"}'::jsonb)`,
  }).where(and(
    eq(issueRecoveryActions.companyId, input.companyId),
    eq(issueRecoveryActions.sourceIssueId, input.issueId),
    eq(issueRecoveryActions.cause, LEGACY_RECOVERY_CAUSE),
    eq(issueRecoveryActions.fingerprint, `legacy-execution:${input.runId}`),
    sql`${issueRecoveryActions.evidence}->>'runId' = ${input.runId}`,
    inArray(issueRecoveryActions.status, ["active", "escalated", "resolved"]),
  ));
}

/** Persist the failed legacy run, owned lock release and operator decision together. */
export async function terminalizeLegacyExecution(input: {
  db: Db;
  run: Run;
  status: string;
  patch?: Partial<typeof heartbeatRuns.$inferInsert>;
  fromStatuses?: string[];
}) {
  const { db, run, status, patch } = input;
  const issueId =
    run.nativeIssueId ??
    (typeof run.contextSnapshot?.issueId === "string"
      ? run.contextSnapshot.issueId
      : null);
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('statement_timeout', '15000', true), set_config('lock_timeout', '1000', true)`,
    );
    const [task] = issueId
      ? await tx
          .select()
          .from(issues)
          .where(
            and(eq(issues.companyId, run.companyId), eq(issues.id, issueId)),
          )
          .for("update")
      : [];
    const [updated] = await tx
      .update(heartbeatRuns)
      .set({
        status,
        ...patch,
        executionStatusDeliveryId: randomUUID(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(heartbeatRuns.id, run.id),
          eq(heartbeatRuns.companyId, run.companyId),
          inArray(heartbeatRuns.status, input.fromStatuses ?? [run.status]),
        ),
      )
      .returning();
    if (!updated) return null;
    if (task?.executionRunId === run.id)
      await tx
        .update(issues)
        .set({
          executionRunId: null,
          executionAgentNameKey: null,
          executionLockedAt: null,
        })
        .where(eq(issues.id, task.id));
    if (task?.checkoutRunId === run.id)
      await tx
        .update(issues)
        .set({ checkoutRunId: null })
        .where(eq(issues.id, task.id));
    const review = task?.status === "in_review" ? parseIssueExecutionState(task.executionState) : null;
    const isCurrentReviewer = review?.status === "pending" &&
      review.currentParticipant?.type === "agent" && review.currentParticipant.agentId === run.agentId;
    if (
      task &&
      !isSupersededConversationRun(task, updated) &&
      (task.assigneeAgentId === run.agentId || isCurrentReviewer) &&
      !["done", "cancelled"].includes(task.status)
    ) {
      // Periodic stranded-work checks may revisit this terminal run before its
      // reconciled continuation is dispatched. Preserve the recorded decision.
      const [reconciled] = await tx.select({ id: issueRecoveryActions.id })
        .from(issueRecoveryActions).where(and(
          eq(issueRecoveryActions.companyId, run.companyId),
          eq(issueRecoveryActions.sourceIssueId, task.id),
          eq(issueRecoveryActions.status, "resolved"),
          sql`${issueRecoveryActions.evidence}->'executionReconciliation'->>'runId' = ${run.id}`,
        )).limit(1);
      if (reconciled) return updated;
      await issueRecoveryActionService(tx as unknown as Db).upsertSourceScoped({
        companyId: run.companyId,
        sourceIssueId: task.id,
        kind: "active_run_watchdog",
        ownerType: "board",
        returnOwnerAgentId: task.assigneeAgentId,
        cause: LEGACY_RECOVERY_CAUSE,
        fingerprint: `legacy-execution:${run.id}`,
        evidence: {
          runId: run.id,
          ...(isCurrentReviewer ? { reviewParticipantAgentId: run.agentId } : {}),
          originalFailureCode: updated.errorCode,
          adapterRecovery: "unsupported_or_unknown",
          attempt: executionFailureRetryCount(run) + 1,
        },
        nextAction:
          "Inspect the stopped provider and recorded actions, then reconcile their outcomes before continuing. This adapter has not established a safe resume checkpoint.",
        maxAttempts: 3,
        wakePolicy: null,
        supersedeOnIdentityChange: true,
      });
    }
    return updated;
  });
}
