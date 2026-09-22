import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  pluginCompanySettings,
  plugins,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { enrichRunContextBeforeDispatch } from "../services/run-context-enrichment.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function waitForRunToFinish(
  heartbeat: ReturnType<typeof heartbeatService>,
  runId: string,
  timeoutMs = 8_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (run && !["queued", "running"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return heartbeat.getRun(runId);
}

describeEmbeddedPostgres("heartbeat pre-run context enrichment", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-enrichment-");
    db = createDb(tempDb.connectionString);
  }, 45_000);

  afterEach(async () => {
    await db.execute(sql.raw(`
      TRUNCATE TABLE
        "environment_leases",
        "environments",
        "activity_log",
        "heartbeat_run_events",
        "heartbeat_runs",
        "agent_wakeup_requests",
        "agent_runtime_state",
        "plugins",
        "company_skills",
        "agents",
        "companies"
      RESTART IDENTITY CASCADE
    `));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("keeps the no-enricher path inert", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `N${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "ProcessAgent",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      status: "running",
      contextSnapshot: { paperclipTaskMarkdown: "Original task" },
    });
    const resolveRuntimeMcpServers = vi.fn(async () => []);

    await expect(enrichRunContextBeforeDispatch({
      db,
      workerManager: {} as PluginWorkerManager,
      run: { id: runId, companyId, agentId, status: "running" },
      issueId: null,
      adapterType: "process",
      context: { paperclipTaskMarkdown: "Original task" },
      workspace: { cwd: tmpdir() },
      resolveRuntimeMcpServers,
      releaseRuntimeMcpServers: async () => {},
    })).resolves.toBeNull();
    expect(resolveRuntimeMcpServers).not.toHaveBeenCalled();
  });

  it("does not treat an ordinary company settings row as enrichment approval", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const pluginId = randomUUID();
    const runId = randomUUID();
    const originalContext = { paperclipTaskMarkdown: "Original task" };
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `D${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "ProcessAgent",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "paperclip.unapproved-enricher-fixture",
      packageName: "@paperclip/unapproved-enricher-fixture",
      version: "1.0.0",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: {
        id: "paperclip.unapproved-enricher-fixture",
        apiVersion: 1,
        version: "1.0.0",
        displayName: "Unapproved Enricher Fixture",
        description: "Must not receive run context without company enablement.",
        author: "Paperclip",
        categories: ["automation"],
        capabilities: ["agent.run.enrich"],
        entrypoints: { worker: "./dist/worker.js" },
      },
      status: "ready",
      installOrder: 1,
    });
    await db.insert(pluginCompanySettings).values({
      companyId,
      pluginId,
      enabled: true,
      settingsJson: { localFolders: { content: { path: "/tmp/content" } } },
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      status: "running",
      contextSnapshot: originalContext,
    });
    const call = vi.fn(async () => ({
      artifact: {
        ref: "artifact://context/unapproved.json",
        sha256: "a".repeat(64),
      },
    }));
    const workerManager = {
      getWorker: () => ({ status: "running", supportedMethods: ["enrichRunContext"] }),
      call,
    } as unknown as PluginWorkerManager;
    const resolveRuntimeMcpServers = vi.fn(async () => [{
      name: "governed-runtime",
      url: "https://example.invalid/mcp",
      token: "run-scoped-token",
      connectionId: "knowledge",
    }]);

    await expect(enrichRunContextBeforeDispatch({
      db,
      workerManager,
      run: { id: runId, companyId, agentId, status: "running" },
      issueId: null,
      adapterType: "process",
      context: { ...originalContext },
      workspace: { cwd: tmpdir() },
      resolveRuntimeMcpServers,
      releaseRuntimeMcpServers: async () => {},
    })).resolves.toBeNull();
    expect(call).not.toHaveBeenCalled();
    expect(resolveRuntimeMcpServers).not.toHaveBeenCalled();
    expect((await db.select({ context: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId)))[0]?.context).toEqual(originalContext);
  });

  it("fails closed when an enabled enricher has no worker manager", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const pluginId = randomUUID();
    const runId = randomUUID();
    const originalContext = { paperclipTaskMarkdown: "Original task" };
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `W${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "ProcessAgent",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "paperclip.unavailable-enricher-fixture",
      packageName: "@paperclip/unavailable-enricher-fixture",
      version: "1.0.0",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: {
        id: "paperclip.unavailable-enricher-fixture",
        apiVersion: 1,
        version: "1.0.0",
        displayName: "Unavailable Enricher Fixture",
        description: "Must fail closed when the plugin worker manager is unavailable.",
        author: "Paperclip",
        categories: ["automation"],
        capabilities: ["agent.run.enrich"],
        entrypoints: { worker: "./dist/worker.js" },
      },
      status: "ready",
      installOrder: 1,
    });
    await db.insert(pluginCompanySettings).values({
      companyId,
      pluginId,
      enabled: true,
      settingsJson: { runContextEnrichmentEnabled: true },
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      status: "running",
      contextSnapshot: originalContext,
    });
    const resolveRuntimeMcpServers = vi.fn(async () => []);

    await expect(enrichRunContextBeforeDispatch({
      db,
      run: { id: runId, companyId, agentId, status: "running" },
      issueId: null,
      adapterType: "process",
      context: { ...originalContext },
      workspace: { cwd: tmpdir() },
      resolveRuntimeMcpServers,
      releaseRuntimeMcpServers: async () => {},
    })).rejects.toThrow("run_context_enrichment_worker_manager_unavailable");
    expect(resolveRuntimeMcpServers).not.toHaveBeenCalled();
    expect((await db.select({ context: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId)))[0]?.context).toEqual(originalContext);
  });

  it("prepends enrichment prompts to full and compact task variants", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const pluginId = randomUUID();
    const runId = randomUUID();
    const context = {
      paperclipTaskMarkdown: "Original full task",
      paperclipTaskMarkdownCompact: "Original compact task",
    };
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `C${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "ProcessAgent",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "paperclip.compact-enricher-fixture",
      packageName: "@paperclip/compact-enricher-fixture",
      version: "1.0.0",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: {
        id: "paperclip.compact-enricher-fixture",
        apiVersion: 1,
        version: "1.0.0",
        displayName: "Compact Enricher Fixture",
        description: "Preserves enrichment across resumed compact dispatch.",
        author: "Paperclip",
        categories: ["automation"],
        capabilities: ["agent.run.enrich"],
        entrypoints: { worker: "./dist/worker.js" },
      },
      status: "ready",
      installOrder: 1,
    });
    await db.insert(pluginCompanySettings).values({
      companyId,
      pluginId,
      enabled: true,
      settingsJson: { runContextEnrichmentEnabled: true },
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      status: "running",
      contextSnapshot: context,
    });
    const workerManager = {
      getWorker: () => ({ status: "running", supportedMethods: ["enrichRunContext"] }),
      call: vi.fn(async () => ({
        promptMarkdown: "Use bounded context.",
        artifact: { ref: "artifact://context/compact.json", sha256: "c".repeat(64) },
      })),
    } as unknown as PluginWorkerManager;

    const releaseRuntimeMcpServers = vi.fn(async () => {});
    await enrichRunContextBeforeDispatch({
      db,
      workerManager,
      run: { id: runId, companyId, agentId, status: "running" },
      issueId: null,
      adapterType: "process",
      context,
      workspace: { cwd: tmpdir() },
      resolveRuntimeMcpServers: async () => [],
      releaseRuntimeMcpServers,
    });

    expect(releaseRuntimeMcpServers).toHaveBeenCalledTimes(1);
    expect(releaseRuntimeMcpServers).toHaveBeenCalledWith({
      pluginId,
      pluginKey: "paperclip.compact-enricher-fixture",
      pluginVersion: "1.0.0",
    });
    expect(context.paperclipTaskMarkdown).toBe("Use bounded context.\n\nOriginal full task");
    expect(context.paperclipTaskMarkdownCompact).toBe(
      "Use bounded context.\n\nOriginal compact task",
    );
  });

  it("rejects invalid enrichment before it changes the durable run context", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const pluginId = randomUUID();
    const runId = randomUUID();
    const originalContext = { paperclipTaskMarkdown: "Original task" };
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `V${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "ProcessAgent",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "paperclip.invalid-enricher-fixture",
      packageName: "@paperclip/invalid-enricher-fixture",
      version: "1.0.0",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: {
        id: "paperclip.invalid-enricher-fixture",
        apiVersion: 1,
        version: "1.0.0",
        displayName: "Invalid Enricher Fixture",
        description: "Returns an invalid digest.",
        author: "Paperclip",
        categories: ["automation"],
        capabilities: ["agent.run.enrich"],
        entrypoints: { worker: "./dist/worker.js" },
      },
      status: "ready",
      installOrder: 1,
    });
    await db.insert(pluginCompanySettings).values({
      companyId,
      pluginId,
      enabled: true,
      settingsJson: { runContextEnrichmentEnabled: true },
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      status: "running",
      contextSnapshot: originalContext,
    });
    const workerManager = {
      getWorker: () => ({ status: "running", supportedMethods: ["enrichRunContext"] }),
      call: vi.fn(async () => ({
        artifact: { ref: "artifact://context/invalid.json", sha256: "not-a-digest" },
      })),
    } as unknown as PluginWorkerManager;

    const releaseRuntimeMcpServers = vi.fn(async () => {});
    await expect(enrichRunContextBeforeDispatch({
      db,
      workerManager,
      run: { id: runId, companyId, agentId, status: "running" },
      issueId: null,
      adapterType: "process",
      context: { ...originalContext },
      workspace: { cwd: tmpdir() },
      resolveRuntimeMcpServers: async () => [],
      releaseRuntimeMcpServers,
    })).rejects.toThrow("run_context_enrichment_artifact_sha256_invalid");
    expect(releaseRuntimeMcpServers).toHaveBeenCalledTimes(1);
    const [persisted] = await db
      .select({ context: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId));
    expect(persisted?.context).toEqual(originalContext);
  });

  it("persists the artifact identity before delegating to the selected adapter", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const pluginId = randomUUID();
    const tempDir = await mkdtemp(join(tmpdir(), "paperclip-enrichment-"));
    const artifactPath = join(tempDir, "context.json");
    const adapterMarkerPath = join(tempDir, "adapter-executed.json");
    const artifactBody = JSON.stringify({ bounded: true, run: "same-run" });
    const artifactSha256 = createHash("sha256").update(artifactBody).digest("hex");
    const enrich = vi.fn(async (_pluginId: string, method: string, params: any) => {
      expect(method).toBe("enrichRunContext");
      expect(params.agentId).toBe(agentId);
      expect(params.adapterType).toBe("process");
      await writeFile(artifactPath, artifactBody, "utf8");
      return {
        promptMarkdown: "Use the deterministic bounded context artifact.",
        artifact: {
          ref: `file://${artifactPath.replaceAll("\\", "/")}`,
          sha256: artifactSha256,
          mediaType: "application/json",
          byteSize: Buffer.byteLength(artifactBody),
        },
        metadata: { fixture: "placeholder-v1" },
      };
    });
    const worker = {
      status: "running",
      supportedMethods: ["enrichRunContext"],
    };
    const workerManager = {
      getWorker: (id: string) => (id === pluginId ? worker : undefined),
      call: enrich,
    } as unknown as PluginWorkerManager;
    const heartbeat = heartbeatService(db, { pluginWorkerManager: workerManager });

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `E${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "paperclip.context-enricher-fixture",
      packageName: "@paperclip/context-enricher-fixture",
      version: "1.0.0",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: {
        id: "paperclip.context-enricher-fixture",
        apiVersion: 1,
        version: "1.0.0",
        displayName: "Context Enricher Fixture",
        description: "Deterministic pre-run enrichment fixture.",
        author: "Paperclip",
        categories: ["automation"],
        capabilities: ["agent.run.enrich"],
        entrypoints: { worker: "./dist/worker.js" },
      },
      status: "ready",
      installOrder: 1,
    });
    await db.insert(pluginCompanySettings).values({
      companyId,
      pluginId,
      enabled: true,
      settingsJson: { runContextEnrichmentEnabled: true },
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "ProcessAgent",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {
        command: process.execPath,
        args: [
          "-e",
          `require("node:fs").writeFileSync(${JSON.stringify(adapterMarkerPath)}, JSON.stringify({ runId: process.env.PAPERCLIP_RUN_ID }))`,
        ],
        cwd: tempDir,
      },
      runtimeConfig: {},
      permissions: {},
    });

    const queued = await heartbeat.invoke(
      agentId,
      "on_demand",
      { paperclipTaskMarkdown: "Original task" },
      "manual",
    );
    expect(queued).not.toBeNull();
    const finished = await waitForRunToFinish(heartbeat, queued!.id);
    await heartbeat.drainActiveRunExecutions();

    expect(finished?.status).toBe("succeeded");
    expect(enrich).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await readFile(adapterMarkerPath, "utf8"))).toEqual({
      runId: queued!.id,
    });
    expect(await readFile(artifactPath, "utf8")).toBe(artifactBody);

    const [persisted] = await db
      .select({ context: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, queued!.id));
    expect(persisted?.context).toMatchObject({
      paperclipTaskMarkdown: "Use the deterministic bounded context artifact.",
      paperclipRunContextEnrichment: {
        version: 1,
        promptMarkdown: "Use the deterministic bounded context artifact.",
        entries: [
          {
            pluginId,
            pluginKey: "paperclip.context-enricher-fixture",
            pluginVersion: "1.0.0",
            promptSha256: createHash("sha256")
              .update("Use the deterministic bounded context artifact.")
              .digest("hex"),
            artifact: {
              ref: `file://${artifactPath.replaceAll("\\", "/")}`,
              sha256: artifactSha256,
              mediaType: "application/json",
              byteSize: Buffer.byteLength(artifactBody),
            },
            metadata: { fixture: "placeholder-v1" },
          },
        ],
      },
    });

    const restarted = heartbeatService(db, { pluginWorkerManager: workerManager });
    expect((await restarted.getRun(queued!.id))?.contextSnapshot).toEqual(
      persisted?.context,
    );
    const recoveredContext = {
      ...persisted!.context!,
      paperclipTaskMarkdown: "Rebuilt full task",
      paperclipTaskMarkdownCompact: "Rebuilt compact task",
    };
    await enrichRunContextBeforeDispatch({
      db,
      workerManager,
      run: {
        id: queued!.id,
        companyId,
        agentId,
        status: "succeeded",
      },
      issueId: null,
      adapterType: "process",
      context: recoveredContext,
      workspace: { cwd: tempDir },
      resolveRuntimeMcpServers: async () => [],
      releaseRuntimeMcpServers: async () => {},
    });
    expect(recoveredContext.paperclipTaskMarkdown).toBe(
      "Use the deterministic bounded context artifact.\n\nRebuilt full task",
    );
    expect(recoveredContext.paperclipTaskMarkdownCompact).toBe(
      "Use the deterministic bounded context artifact.\n\nRebuilt compact task",
    );
    await enrichRunContextBeforeDispatch({
      db,
      workerManager,
      run: { id: queued!.id, companyId, agentId, status: "succeeded" },
      issueId: null,
      adapterType: "process",
      context: recoveredContext,
      workspace: { cwd: tempDir },
      resolveRuntimeMcpServers: async () => [],
      releaseRuntimeMcpServers: async () => {},
    });
    expect(recoveredContext.paperclipTaskMarkdown).toBe(
      "Use the deterministic bounded context artifact.\n\nRebuilt full task",
    );
    expect(enrich).toHaveBeenCalledTimes(1);
  });
});
