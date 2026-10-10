import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentConfigRevisions,
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
  vi.fn(async (_ctx?: unknown) => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Project task intake route test run.",
    provider: "test",
    model: "test-model",
  })),
);
const issueReadRace = vi.hoisted(() => ({ afterRead: null as null | (() => Promise<void>) }));
vi.mock("../services/issues.js", async () => {
  const actual = await vi.importActual<typeof import("../services/issues.js")>("../services/issues.js");
  return { ...actual, issueService: (db: Parameters<typeof actual.issueService>[0]) => {
    const service = actual.issueService(db);
    return { ...service, getById: async (...args: Parameters<typeof service.getById>) => {
      const observed = await service.getById(...args);
      const hook = issueReadRace.afterRead;
      issueReadRace.afterRead = null;
      if (hook) await hook();
      return observed;
    } };
  } };
});

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
  }, 60_000);

  afterEach(async () => {
    issueReadRace.afterRead = null;
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
    await db.delete(agentConfigRevisions);
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
      isInstanceAdmin: true,
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

  it.each(["project", "policy"])("invalidates a handoff snapshot when the owner changes %s without changing status", async (change) => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const firstProject = await seedProject(companyId, agentId);
    const secondProject = await seedProject(companyId, agentId);
    const issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Owner-controlled workflow",
      status: "backlog", assigneeAgentId: agentId, projectId: firstProject, statusVersion: 4 });
    const app = createApp(boardActor(companyId));
    const changed = await request(app).patch(`/api/issues/${issueId}`)
      .send(change === "project" ? { projectId: secondProject } : { executionPolicy: {
        mode: "normal", stages: [{ type: "review", participants: [{ type: "agent", agentId }] }],
      } })
      .expect(200);
    expect(changed.body.status).toBe("backlog");
    expect(changed.body.statusVersion).toBe(5);
    await request(app).patch(`/api/issues/${issueId}`)
      .send({ title: "Stale handoff", expectedStatusVersion: 4 }).expect(409);
    const [stored] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(stored?.title).toBe("Owner-controlled workflow");
  });

  it("does not cancel a replacement run after an A-to-B-to-A ownership race", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const targetId = await seedAgent(companyId);
    const issueId = randomUUID(), oldRunId = randomUUID(), replacementId = randomUUID();
    await db.insert(heartbeatRuns).values([oldRunId, replacementId].map(id => ({
      id, companyId, agentId, status: "running", invocationSource: "manual",
      contextSnapshot: { issueId }, startedAt: new Date(),
    })));
    await db.insert(issues).values({ id: issueId, companyId, title: "Ownership race", status: "in_progress",
      assigneeAgentId: agentId, executionRunId: oldRunId, statusVersion: 4 });
    issueReadRace.afterRead = async () => {
      await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(eq(heartbeatRuns.id, oldRunId));
      await db.update(issues).set({ executionRunId: replacementId, statusVersion: 6 }).where(eq(issues.id, issueId));
    };
    await request(createApp(boardActor(companyId))).patch(`/api/issues/${issueId}`)
      .send({ assigneeAgentId: targetId, expectedStatusVersion: 4 }).expect(409);
    const [replacement] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, replacementId));
    expect(replacement?.status).toBe("running");
    const [stored] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(stored?.executionRunId).toBe(replacementId);
  });

  async function seedProviderLoss() {
    const companyId = await seedCompany(), agentId = await seedAgent(companyId), proofAgentId = await seedAgent(companyId);
    const issueId = randomUUID(), qualificationRunId = randomUUID();
    await db.insert(heartbeatRuns).values({id:qualificationRunId,companyId,agentId:proofAgentId,status:"succeeded",
      invocationSource:"manual",runnerProfileJson:{adapterDispatch:{adapterType:"codex_local"}},usageJson:{model:"gpt-5.6-sol"},finishedAt:new Date()});
    const profile = {adapterType:"codex_local",model:"gpt-5.6-sol",extraArgs:["--sandbox","read-only"],qualificationRunId};
    const runtimeConfig = {heartbeat:{enabled:false,wakeOnDemand:true,maxConcurrentRuns:1},providerFallback:profile};
    await db.update(agents).set({adapterType:"opencode_local",adapterConfig:{cwd:"/tmp",model:"opencode/free"},runtimeConfig}).where(eq(agents.id,agentId));
    await db.insert(agentConfigRevisions).values({companyId,agentId,createdByUserId:"board-user",afterConfig:{runtimeConfig},beforeConfig:{},changedKeys:["runtimeConfig"]});
    await db.insert(issues).values({id:issueId,companyId,title:"Provider-loss canary",status:"in_progress",assigneeAgentId:agentId,responsibleUserId:"board-user"});
    return {companyId,agentId,issueId,qualificationRunId,profile};
  }
  const providerRejected = () => ({exitCode:1,signal:null,timedOut:false,errorMessage:"Provider access rejected",summary:"",
    provider:"opencode",model:"opencode/free",errorCode:"provider_unavailable_bootstrap",executionRecovery:{kind:"bootstrap",providerWorkStarted:false}});
  it("uses a durable, qualified cross-provider retry without changing the logical agent", async () => {
    const {agentId,issueId} = await seedProviderLoss();
    mockAdapterExecute.mockImplementationOnce(async () => ({exitCode:1,signal:null,timedOut:false,errorMessage:"Provider access rejected",summary:"",
      provider:"opencode",model:"opencode/free",errorCode:"provider_unavailable_bootstrap",executionRecovery:{kind:"bootstrap",providerWorkStarted:false}}));
    const heartbeat = heartbeatService(db);
    const source = await heartbeat.invoke(agentId,"on_demand",{issueId},"manual");
    expect(source).toBeTruthy();
    await heartbeat.drainActiveRunExecutions();
    const successors = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId,source!.id));
    expect(successors).toHaveLength(1);
    expect(successors[0]).toMatchObject({agentId,status:"scheduled_retry",scheduledRetryReason:"provider_fallback"});
    expect(successors[0].runnerProfileJson?.providerFallback).toMatchObject({sourceRunId:source!.id,switchCount:1});
    // Recreate the service before promotion: the selected adapter must survive restart.
    mockAdapterExecute.mockImplementationOnce(async (ctx) => {
      expect((ctx as {agent:{adapterType:string}}).agent.adapterType).toBe("codex_local");
      await db.update(issues).set({status:"done"}).where(eq(issues.id,issueId));
      return {exitCode:0,signal:null,timedOut:false,errorMessage:null,summary:"Recovered",provider:"openai",model:"gpt-5.6-sol"};
    });
    const restarted = heartbeatService(db);
    await restarted.promoteDueScheduledRetries(new Date(Date.now()+5000));
    await restarted.resumeQueuedRuns();
    await drainHeartbeatRunsToQuiescence(db,restarted);
    const [completed] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,successors[0].id));
    expect(completed.status).toBe("succeeded");
    expect(completed.runnerProfileJson?.adapterDispatch).toEqual({adapterType:"codex_local"});
    // Direct native harnesses use runtimeMode legacy. Their initialization
    // must retain the sealed receipt, not just the claimed adapter identity.
    expect(completed.runnerProfileJson?.providerFallback).toEqual(successors[0].runnerProfileJson?.providerFallback);
    const [principal] = await db.select().from(agents).where(eq(agents.id,agentId));
    expect(principal.adapterType).toBe("opencode_local");
  },30_000);

  it.each(["approval", "qualification"])("does not launch an unqualified fallback (%s)",async (invalid) => {
    const {agentId,issueId,qualificationRunId} = await seedProviderLoss();
    if (invalid === "approval") await db.update(agentConfigRevisions).set({createdByUserId:null,createdByAgentId:agentId}).where(eq(agentConfigRevisions.agentId,agentId));
    else await db.update(heartbeatRuns).set({usageJson:{model:"unproven-model"}}).where(eq(heartbeatRuns.id,qualificationRunId));
    mockAdapterExecute.mockImplementationOnce(async () => providerRejected());
    const heartbeat = heartbeatService(db);
    const source = await heartbeat.invoke(agentId,"on_demand",{issueId},"manual");
    await heartbeat.drainActiveRunExecutions();
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId,source!.id))).toHaveLength(0);
  });

  it("exhausts the one provider switch without returning to the primary provider",async () => {
    const {agentId,issueId} = await seedProviderLoss();
    mockAdapterExecute.mockImplementationOnce(async () => providerRejected());
    const heartbeat = heartbeatService(db);
    const source = await heartbeat.invoke(agentId,"on_demand",{issueId},"manual");
    await heartbeat.drainActiveRunExecutions();
    const [successor] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId,source!.id));
    mockAdapterExecute.mockImplementationOnce(async () => providerRejected());
    await heartbeat.promoteDueScheduledRetries(new Date(Date.now()+5000));
    await heartbeat.resumeQueuedRuns();
    await drainHeartbeatRunsToQuiescence(db,heartbeat);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId,successor.id))).toHaveLength(0);
    const remaining = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.agentId,agentId),eq(heartbeatRuns.status,"queued")));
    expect(remaining).toHaveLength(0);
  });

  it("recovers the failure-to-scheduling crash window once through the native retry sweep",async () => {
    const {companyId,agentId,issueId} = await seedProviderLoss(), sourceRunId = randomUUID();
    await db.insert(heartbeatRuns).values({id:sourceRunId,companyId,agentId,status:"failed",invocationSource:"manual",
      contextSnapshot:{issueId},errorCode:"provider_unavailable_bootstrap",resultJson:{executionRecovery:{kind:"bootstrap",providerWorkStarted:false}},finishedAt:new Date()});
    await db.update(issues).set({executionRunId:sourceRunId}).where(eq(issues.id,issueId));
    const restarted = heartbeatService(db);
    await Promise.all([restarted.promoteDueScheduledRetries(),restarted.promoteDueScheduledRetries()]);
    const successors = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId,sourceRunId));
    expect(successors).toHaveLength(1);
    expect(successors[0]).toMatchObject({status:"scheduled_retry",scheduledRetryReason:"provider_fallback"});
  });
});
