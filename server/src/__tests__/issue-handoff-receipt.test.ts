import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentWakeupRequests, agents, companies, createDb, environmentLeases, heartbeatRuns, issueRecoveryActions, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { LEGACY_RECOVERY_CAUSE, preserveIssueHandoff, recordCommittedIssueHandoff } from "../services/legacy-execution-recovery.js";
import { getExecutionBlocker } from "../services/execution-blocker.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping handoff receipt database tests: ${support.reason}`);

describeDatabase("committed issue handoff receipts", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-handoff-receipt-");
    db = createDb(tempDb.connectionString);
  }, 120_000);
  afterAll(async () => { await tempDb?.cleanup(); });

  async function seed(acknowledged = true) {
    const input = { companyId: randomUUID(), agentId: randomUUID(), issueId: randomUUID(), runId: randomUUID() };
    await db.insert(companies).values({ id: input.companyId, name: "Handoff test", issuePrefix: input.companyId.slice(0, 8) });
    await db.insert(agents).values({ id: input.agentId, companyId: input.companyId, name: "Developer", role: "engineer", adapterType: "process" });
    await db.insert(issues).values({ id: input.issueId, companyId: input.companyId, title: "Candidate", status: "in_progress", assigneeAgentId: input.agentId });
    await db.insert(heartbeatRuns).values({
      id: input.runId, companyId: input.companyId, agentId: input.agentId,
      invocationSource: "manual", status: "cancelled", runtimeMode: "legacy", errorCode: "issue_reassigned",
      contextSnapshot: { issueId: input.issueId },
      resultJson: { reassignmentStopConfirmed: true, executionCancellation: { state: acknowledged ? "acknowledged" : "requested" } },
    });
    const [action] = await db.insert(issueRecoveryActions).values({
      companyId: input.companyId, sourceIssueId: input.issueId, kind: "active_run_watchdog", ownerType: "board",
      cause: LEGACY_RECOVERY_CAUSE, fingerprint: `legacy-execution:${input.runId}`,
      evidence: { runId: input.runId, originalFailureCode: "issue_reassigned" }, nextAction: "Reconcile",
    }).returning();
    return { ...input, actionId: action!.id };
  }

  async function read(input: Awaited<ReturnType<typeof seed>>) {
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, input.runId));
    const [issue] = await db.select().from(issues).where(eq(issues.id, input.issueId));
    const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, input.actionId));
    return { run: run!, issue: issue!, action: action! };
  }

  async function handoffWithWake() {
    const input = await seed();
    const reviewerId = randomUUID();
    await db.insert(agents).values({ id: reviewerId, companyId: input.companyId, name: "Reviewer", role: "engineer", adapterType: "process" });
    return { ...input, nextWakeup: { agentId: reviewerId, statusVersion: 1, executionState: { currentStageId: "review" },
      wakeup: { source: "assignment", triggerDetail: "system", reason: "execution_review_requested",
        payload: { issueId: input.issueId }, contextSnapshot: { issueId: input.issueId },
        requestedByActorType: "agent", requestedByActorId: input.agentId } } };
  }

  it("persists exactly one next-stage wake and stable receipt across repeated recovery", async () => {
    const input = await handoffWithWake();
    await db.transaction(tx => recordCommittedIssueHandoff(tx as unknown as typeof db, input));
    const receipt = (await read(input)).run.resultJson?.issueHandoff;
    for (let attempt = 0; attempt < 3; attempt++) {
      await db.transaction(tx => recordCommittedIssueHandoff(tx as unknown as typeof db, input));
    }
    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, input.companyId));
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({ id: (receipt as { wakeupRequestId: string }).wakeupRequestId,
      status: "deferred_issue_execution", agentId: input.nextWakeup.agentId,
      payload: { issueHandoffSourceRunId: input.runId, issueHandoffStatusVersion: 1 } });
    expect((await read(input)).run.resultJson?.issueHandoff).toEqual(receipt);
  });

  it("rolls back the deferred wake together with its receipt and task decision", async () => {
    const input = await handoffWithWake();
    await expect(db.transaction(async tx => {
      await recordCommittedIssueHandoff(tx as unknown as typeof db, input);
      throw new Error("later decision write failed");
    })).rejects.toThrow("later decision write failed");
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, input.companyId))).toHaveLength(0);
    expect((await read(input)).run.resultJson?.issueHandoff).toBeUndefined();
    expect((await read(input)).action.status).toBe("active");
  });

  it("reuses the pending handoff receipt when the daily admission cap blocks repeated attempts", async () => {
    const input = await handoffWithWake();
    await db.update(agents).set({ status: "active", runtimeConfig: { heartbeat: { wakeOnDemand: true, maxDailyRuns: 0 } } })
      .where(eq(agents.id, input.nextWakeup.agentId));
    await db.update(issues).set({ assigneeAgentId: input.nextWakeup.agentId, statusVersion: 1,
      executionState: input.nextWakeup.executionState }).where(eq(issues.id, input.issueId));
    await db.transaction(tx => recordCommittedIssueHandoff(tx as unknown as typeof db, input));
    const { heartbeatService } = await import("../services/heartbeat.js");
    const heartbeat = heartbeatService(db, { runtimeEnv: { PAPERCLIP_IN_WORKTREE: "false" } });
    for (let attempt = 0; attempt < 3; attempt++) await heartbeat.resumeCommittedIssueHandoffs({ runId: input.runId });
    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, input.companyId));
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({ status: "deferred_issue_execution", runId: null,
      payload: { issueHandoffSourceRunId: input.runId, executionWait: { reason: "heartbeat.daily_run_limit" } } });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, input.companyId))).toHaveLength(1);
  }, 120_000);

  it("does not waive a conversation source's active lease when the next wake is durable", async () => {
    const input = await handoffWithWake();
    await db.update(agents).set({ status: "active", runtimeConfig: { heartbeat: { wakeOnDemand: true, maxDailyRuns: 0 } } })
      .where(eq(agents.id, input.nextWakeup.agentId));
    await db.update(issues).set({ assigneeAgentId: input.nextWakeup.agentId, statusVersion: 1,
      executionState: input.nextWakeup.executionState }).where(eq(issues.id, input.issueId));
    await db.update(heartbeatRuns).set({ runnerProfileJson: { adapterDispatch: { adapterType: "opencode_local" } } })
      .where(eq(heartbeatRuns.id, input.runId));
    const [lease] = await db.insert(environmentLeases).values({ companyId: input.companyId, heartbeatRunId: input.runId,
      provider: "local", leasePolicy: "ephemeral", status: "active" }).returning();
    await db.transaction(tx => recordCommittedIssueHandoff(tx as unknown as typeof db, input));
    const receipt = (await read(input)).run.resultJson?.issueHandoff;
    const { heartbeatService } = await import("../services/heartbeat.js");
    for (let attempt = 0; attempt < 2; attempt++) {
      // A fresh service has no in-memory knowledge of the earlier attempt.
      await heartbeatService(db, { runtimeEnv: { PAPERCLIP_IN_WORKTREE: "false" } })
        .resumeCommittedIssueHandoffs({ runId: input.runId });
    }
    expect(await getExecutionBlocker(db, input.companyId, input.issueId)).toMatchObject({ runId: input.runId, cause: "execution_owner_active" });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, input.companyId))).toHaveLength(1);
    await db.update(environmentLeases).set({ status: "released", releasedAt: new Date(), cleanupStatus: "success" })
      .where(eq(environmentLeases.id, lease!.id));
    expect(await getExecutionBlocker(db, input.companyId, input.issueId)).toBeNull();
    await heartbeatService(db, { runtimeEnv: { PAPERCLIP_IN_WORKTREE: "false" } })
      .resumeCommittedIssueHandoffs({ runId: input.runId });
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, input.companyId))).toHaveLength(1);
    expect((await read(input)).run.resultJson?.issueHandoff).toEqual(receipt);
  }, 120_000);

  it.each(["version", "workflow", "assignee"])("cancels an obsolete handoff after %s changes without starting a successor", async (change) => {
    const input = await handoffWithWake();
    await db.update(agents).set({ status: "active", runtimeConfig: { heartbeat: { wakeOnDemand: true } } })
      .where(eq(agents.id, input.nextWakeup.agentId));
    await db.update(issues).set({ assigneeAgentId: input.nextWakeup.agentId, statusVersion: 1,
      executionState: input.nextWakeup.executionState }).where(eq(issues.id, input.issueId));
    await db.transaction(tx => recordCommittedIssueHandoff(tx as unknown as typeof db, input));
    await db.update(issues).set(change === "version" ? { statusVersion: 2 }
      : change === "workflow" ? { executionState: { currentStageId: "another-stage" } }
      : { assigneeAgentId: input.agentId }).where(eq(issues.id, input.issueId));
    const { heartbeatService } = await import("../services/heartbeat.js");
    await heartbeatService(db, { runtimeEnv: { PAPERCLIP_IN_WORKTREE: "false" } })
      .resumeCommittedIssueHandoffs({ runId: input.runId });
    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, input.companyId));
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({ status: "cancelled", runId: null });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, input.companyId))).toHaveLength(1);
  }, 120_000);

  it("commits the task, receipt and exact source hold together and preserves an unrelated blocked record", async () => {
    const input = await seed();
    const [unrelated] = await db.insert(issueRecoveryActions).values({
      companyId: input.companyId, sourceIssueId: input.issueId, kind: "active_run_watchdog", ownerType: "board",
      cause: LEGACY_RECOVERY_CAUSE, status: "resolved", fingerprint: "legacy-execution:another-run",
      evidence: { runId: "another-run", automaticRecovery: { replay: "blocked" } }, nextAction: "Inspect old crash",
    }).returning();
    await db.transaction(async (tx) => {
      await tx.update(issues).set({ title: "Committed candidate" }).where(eq(issues.id, input.issueId));
      await recordCommittedIssueHandoff(tx as unknown as typeof db, input);
    });
    const current = await read(input);
    expect(current.issue.title).toBe("Committed candidate");
    expect(current.run.resultJson?.issueHandoff).toMatchObject({ runId: input.runId, issueId: input.issueId });
    expect(current.action).toMatchObject({ status: "resolved", outcome: "completed", evidence: { automaticRecovery: { replay: "not_required" } } });
    const [old] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, unrelated!.id));
    expect(old!.evidence).toEqual(unrelated!.evidence);
  });

  it("rolls back task mutation, receipt and hold retirement if a later transaction operation fails", async () => {
    const input = await seed();
    await expect(db.transaction(async (tx) => {
      await tx.update(issues).set({ title: "Must roll back" }).where(eq(issues.id, input.issueId));
      await recordCommittedIssueHandoff(tx as unknown as typeof db, input);
      throw new Error("decision insert failed");
    })).rejects.toThrow("decision insert failed");
    const current = await read(input);
    expect(current.issue.title).toBe("Candidate");
    expect(current.run.resultJson?.issueHandoff).toBeUndefined();
    expect(current.action.status).toBe("active");
  });

  it("does not accept the caller's stop flag without a provider acknowledgement", async () => {
    const input = await seed(false);
    await expect(db.transaction(tx => recordCommittedIssueHandoff(tx as unknown as typeof db, input))).rejects.toThrow("provider stop acknowledgement");
    const current = await read(input);
    expect(current.run.resultJson?.issueHandoff).toBeUndefined();
    expect(current.action.status).toBe("active");
  });

  it.each(["runId", "issueId", "agentId", "companyId"] as const)("rejects a mismatched %s without changing either record", async (field) => {
    const input = await seed();
    await expect(db.transaction(tx => recordCommittedIssueHandoff(tx as unknown as typeof db, { ...input, [field]: randomUUID() }))).rejects.toThrow("confirmed stopped author run");
    const current = await read(input);
    expect(current.run.resultJson?.issueHandoff).toBeUndefined();
    expect(current.action.status).toBe("active");
  });

  it.each(["accounting", "presentation"])("preserves a concurrently committed receipt during late %s persistence", async (writer) => {
    const input = await seed();
    const stale = (await read(input)).run.resultJson;
    await db.transaction(tx => recordCommittedIssueHandoff(tx as unknown as typeof db, input));
    const receipt = (await read(input)).run.resultJson?.issueHandoff;
    const metadata = writer === "accounting" ? { usageCompleteness: "partial" } : { presentationDecision: { commentAction: "none" } };
    await db.update(heartbeatRuns).set({ resultJson: preserveIssueHandoff({ ...stale, ...metadata }) }).where(eq(heartbeatRuns.id, input.runId));
    const current = await read(input);
    expect(current.run.resultJson?.issueHandoff).toEqual(receipt);
    expect(current.run.resultJson).toMatchObject(metadata);
  });
});
