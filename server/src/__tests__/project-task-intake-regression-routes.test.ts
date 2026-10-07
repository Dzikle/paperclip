import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agents,
  agentWakeupRequests,
  companies,
  companySkills,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issueThreadInteractions,
  issues,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { runningProcesses } from "../adapters/index.ts";
import { issueRoutes } from "../routes/issues.js";
import { heartbeatService } from "../services/heartbeat.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Project task intake route test run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping project task intake regression route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("project task intake and issue update version routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-project-task-intake-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    mockAdapterExecute.mockClear();
    runningProcesses.clear();
    await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));
    await db.delete(activityLog);
    await db.delete(issueThreadInteractions);
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function boardActor(companyId: string): Express.Request["actor"] {
    return {
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "admin", status: "active" }],
      isInstanceAdmin: false,
      source: "session",
    };
  }

  function createApp(actor: Express.Request["actor"]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `P${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(companyId: string, input: { name?: string; intake?: boolean } = {}) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: input.name ?? "Project lead",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
      metadata: input.intake ? { taskIntake: true } : null,
    });
    return agentId;
  }

  async function seedProject(companyId: string, leadAgentId: string) {
    const projectId = randomUUID();
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Intake project",
      leadAgentId,
    });
    return projectId;
  }

  it("wires opt-in project lead intake into board root todo creation", async () => {
    const companyId = await seedCompany();
    const leadAgentId = await seedAgent(companyId, { intake: true });
    const projectId = await seedProject(companyId, leadAgentId);

    const created = await request(createApp(boardActor(companyId)))
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Unassigned project work", projectId, status: "todo" })
      .expect(201);

    expect(created.body.assigneeAgentId).toBe(leadAgentId);
    const [stored] = await db.select().from(issues).where(eq(issues.id, created.body.id));
    expect(stored?.assigneeAgentId).toBe(leadAgentId);
  });

  it("keeps backlog work unassigned, then assigns the opted-in lead when the board starts it", async () => {
    const companyId = await seedCompany();
    const leadAgentId = await seedAgent(companyId, { intake: true });
    const projectId = await seedProject(companyId, leadAgentId);
    const app = createApp(boardActor(companyId));

    const created = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Deferred project work", projectId })
      .expect(201);

    expect(created.body.status).toBe("backlog");
    expect(created.body.assigneeAgentId).toBeNull();

    const started = await request(app)
      .patch(`/api/issues/${created.body.id}`)
      .send({ status: "todo" })
      .expect(200);

    expect(started.body.status).toBe("todo");
    expect(started.body.assigneeAgentId).toBe(leadAgentId);
    const [stored] = await db.select().from(issues).where(eq(issues.id, created.body.id));
    expect(stored?.assigneeAgentId).toBe(leadAgentId);
  });

  it.each([
    { assigneeAgentId: null },
    { assigneeAgentId: "explicit" },
  ])("preserves an explicit project issue assignment (%o)", async (assignment) => {
    const companyId = await seedCompany();
    const leadAgentId = await seedAgent(companyId, { name: "Project lead", intake: true });
    const otherAgentId = assignment.assigneeAgentId === "explicit"
      ? await seedAgent(companyId, { name: "Explicit assignee" })
      : null;
    const projectId = await seedProject(companyId, leadAgentId);
    const requestedAssignee = assignment.assigneeAgentId === "explicit" ? otherAgentId : null;

    const created = await request(createApp(boardActor(companyId)))
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Explicitly assigned project work", projectId, assigneeAgentId: requestedAssignee })
      .expect(201);

    expect(created.body.assigneeAgentId).toBe(requestedAssignee);
    expect(created.body.assigneeAgentId).not.toBe(leadAgentId);
  });

  it("rejects an agent assignment without tasks:assign permission", async () => {
    const companyId = await seedCompany();
    const ownerAgentId = await seedAgent(companyId, { name: "Issue owner" });
    const targetAgentId = await seedAgent(companyId, { name: "Requested assignee" });
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Agent-owned task",
      status: "todo",
      assigneeAgentId: ownerAgentId,
    });

    const response = await request(createApp({
      type: "agent",
      agentId: ownerAgentId,
      companyId,
      runId: randomUUID(),
      source: "agent_jwt",
    }))
      .patch(`/api/issues/${issueId}`)
      .send({ assigneeAgentId: targetAgentId });

    expect(response.status, JSON.stringify(response.body)).toBe(403);
    const [stored] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(stored?.assigneeAgentId).toBe(ownerAgentId);
  });

  it("rejects a stale status version without cancelling the live runner", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const issueId = randomUUID();
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "manual",
      startedAt: new Date(),
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Live task",
      status: "in_progress",
      assigneeAgentId: agentId,
      executionRunId: runId,
      statusVersion: 4,
    });

    const response = await request(createApp(boardActor(companyId)))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "cancelled", expectedStatusVersion: 3 });

    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect(response.body.details).toMatchObject({
      code: "issue_update_version_conflict",
      expectedStatusVersion: 3,
      statusVersion: 4,
    });
    const [storedIssue] = await db.select().from(issues).where(eq(issues.id, issueId));
    const [storedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(storedIssue?.status).toBe("in_progress");
    expect(storedRun?.status).toBe("running");
  });
});
