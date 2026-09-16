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
      context: persisted!.context!,
      workspace: { cwd: tempDir },
      runtimeMcpServers: [],
    });
    expect(enrich).toHaveBeenCalledTimes(1);
  });
});
