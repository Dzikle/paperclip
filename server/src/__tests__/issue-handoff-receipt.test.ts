import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issueRecoveryActions, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { LEGACY_RECOVERY_CAUSE, preserveIssueHandoff, recordCommittedIssueHandoff } from "../services/legacy-execution-recovery.js";

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

  it("preserves a concurrently committed receipt during late provider accounting", async () => {
    const input = await seed();
    const stale = (await read(input)).run.resultJson;
    await db.transaction(tx => recordCommittedIssueHandoff(tx as unknown as typeof db, input));
    const receipt = (await read(input)).run.resultJson?.issueHandoff;
    await db.update(heartbeatRuns).set({ resultJson: preserveIssueHandoff({ ...stale, usageCompleteness: "partial" }) }).where(eq(heartbeatRuns.id, input.runId));
    const current = await read(input);
    expect(current.run.resultJson?.issueHandoff).toEqual(receipt);
    expect(current.run.resultJson?.usageCompleteness).toBe("partial");
  });
});
