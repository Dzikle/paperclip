import { createHash } from "node:crypto";
import { and, asc, eq, isNull, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  heartbeatRuns,
  pluginCompanySettings,
  plugins,
} from "@paperclipai/db";
import type {
  RunContextEnrichmentArtifact,
  RunContextEnrichmentResult,
} from "@paperclipai/plugin-sdk";
import type { AdapterRuntimeMcpServer } from "@paperclipai/adapter-utils";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";

export const RUN_CONTEXT_ENRICHMENT_KEY = "paperclipRunContextEnrichment";

const MAX_ENRICHERS = 8;
const MAX_PROMPT_BYTES_PER_ENRICHER = 64 * 1024;
const MAX_METADATA_BYTES_PER_ENRICHER = 16 * 1024;
const MAX_ARTIFACT_REF_CHARS = 2_048;
const MAX_MEDIA_TYPE_CHARS = 255;

interface DurableRunContextEnrichmentEntry {
  pluginId: string;
  pluginKey: string;
  pluginVersion: string;
  promptSha256: string | null;
  artifact: RunContextEnrichmentArtifact;
  metadata: Record<string, unknown> | null;
}

interface DurableRunContextEnrichment {
  version: 1;
  entries: DurableRunContextEnrichmentEntry[];
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateArtifact(value: unknown): RunContextEnrichmentArtifact {
  if (!plainObject(value)) throw new Error("run_context_enrichment_artifact_invalid");
  const ref = typeof value.ref === "string" ? value.ref.trim() : "";
  const sha256 = typeof value.sha256 === "string" ? value.sha256.toLowerCase() : "";
  const mediaType = value.mediaType == null ? null : String(value.mediaType).trim();
  const byteSize = value.byteSize == null ? null : Number(value.byteSize);
  if (!ref || ref.length > MAX_ARTIFACT_REF_CHARS) {
    throw new Error("run_context_enrichment_artifact_ref_invalid");
  }
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    throw new Error("run_context_enrichment_artifact_sha256_invalid");
  }
  if (mediaType !== null && (!mediaType || mediaType.length > MAX_MEDIA_TYPE_CHARS)) {
    throw new Error("run_context_enrichment_artifact_media_type_invalid");
  }
  if (
    byteSize !== null &&
    (!Number.isSafeInteger(byteSize) || byteSize < 0)
  ) {
    throw new Error("run_context_enrichment_artifact_byte_size_invalid");
  }
  return {
    ref,
    sha256,
    ...(mediaType === null ? {} : { mediaType }),
    ...(byteSize === null ? {} : { byteSize }),
  };
}

function validateResult(value: unknown): RunContextEnrichmentResult {
  if (!plainObject(value)) throw new Error("run_context_enrichment_result_invalid");
  const promptMarkdown =
    value.promptMarkdown == null ? null : String(value.promptMarkdown);
  if (
    promptMarkdown !== null &&
    byteLength(promptMarkdown) > MAX_PROMPT_BYTES_PER_ENRICHER
  ) {
    throw new Error("run_context_enrichment_prompt_too_large");
  }
  const metadata = value.metadata == null ? null : value.metadata;
  if (metadata !== null && !plainObject(metadata)) {
    throw new Error("run_context_enrichment_metadata_invalid");
  }
  if (
    metadata !== null &&
    byteLength(JSON.stringify(metadata)) > MAX_METADATA_BYTES_PER_ENRICHER
  ) {
    throw new Error("run_context_enrichment_metadata_too_large");
  }
  return {
    artifact: validateArtifact(value.artifact),
    ...(promptMarkdown === null ? {} : { promptMarkdown }),
    ...(metadata === null ? {} : { metadata }),
  };
}

function existingEnrichment(
  context: Record<string, unknown>,
): DurableRunContextEnrichment | null {
  const value = context[RUN_CONTEXT_ENRICHMENT_KEY];
  if (!plainObject(value) || value.version !== 1 || !Array.isArray(value.entries)) {
    return null;
  }
  return value as unknown as DurableRunContextEnrichment;
}

/**
 * Invoke explicitly capability-bearing, company-enabled enrichers in stable
 * install order. Results are validated and durably attached to the same run
 * before the selected adapter is allowed to execute. A persisted snapshot is
 * an idempotency marker during same-run restart recovery.
 */
export async function enrichRunContextBeforeDispatch(input: {
  db: Db;
  workerManager?: PluginWorkerManager;
  run: {
    id: string;
    companyId: string;
    agentId: string;
    status: string;
  };
  issueId: string | null;
  adapterType: string;
  context: Record<string, unknown>;
  workspace: {
    cwd: string;
    repoUrl?: string | null;
    repoRef?: string | null;
    branchName?: string | null;
  };
  runtimeMcpServers: AdapterRuntimeMcpServer[];
}): Promise<DurableRunContextEnrichment | null> {
  const persisted = existingEnrichment(input.context);
  if (persisted) return persisted;
  if (!input.workerManager) return null;

  const candidates = (
    await input.db
      .select({
        id: plugins.id,
        pluginKey: plugins.pluginKey,
        version: plugins.version,
        manifest: plugins.manifestJson,
        companyEnabled: pluginCompanySettings.enabled,
      })
      .from(plugins)
      .leftJoin(
        pluginCompanySettings,
        and(
          eq(pluginCompanySettings.pluginId, plugins.id),
          eq(pluginCompanySettings.companyId, input.run.companyId),
        ),
      )
      .where(
        and(
          eq(plugins.status, "ready"),
          or(
            isNull(pluginCompanySettings.enabled),
            eq(pluginCompanySettings.enabled, true),
          ),
        ),
      )
      .orderBy(asc(plugins.installOrder), asc(plugins.id))
  ).filter((plugin) =>
    plugin.manifest.capabilities.includes("agent.run.enrich"),
  );

  if (candidates.length === 0) return null;
  if (candidates.length > MAX_ENRICHERS) {
    throw new Error("run_context_enrichment_plugin_limit_exceeded");
  }

  const entries: DurableRunContextEnrichmentEntry[] = [];
  const promptParts: string[] = [];
  for (const plugin of candidates) {
    const worker = input.workerManager.getWorker(plugin.id);
    if (
      !worker ||
      worker.status !== "running" ||
      !worker.supportedMethods.includes("enrichRunContext")
    ) {
      throw new Error(
        `run_context_enrichment_plugin_unavailable:${plugin.pluginKey}`,
      );
    }
    const raw = await input.workerManager.call(
      plugin.id,
      "enrichRunContext",
      {
        companyId: input.run.companyId,
        runId: input.run.id,
        agentId: input.run.agentId,
        issueId: input.issueId,
        adapterType: input.adapterType,
        taskContext: { ...input.context },
        workspace: input.workspace,
        runtimeMcpServers: input.runtimeMcpServers.map((server) => ({ ...server })),
      },
    );
    const result = validateResult(raw);
    const promptMarkdown = result.promptMarkdown?.trim() || null;
    if (promptMarkdown) promptParts.push(promptMarkdown);
    entries.push({
      pluginId: plugin.id,
      pluginKey: plugin.pluginKey,
      pluginVersion: plugin.version,
      promptSha256: promptMarkdown
        ? createHash("sha256").update(promptMarkdown).digest("hex")
        : null,
      artifact: result.artifact,
      metadata: result.metadata ?? null,
    });
  }

  const durable: DurableRunContextEnrichment = { version: 1, entries };
  if (promptParts.length > 0) {
    const existingTask =
      typeof input.context.paperclipTaskMarkdown === "string"
        ? input.context.paperclipTaskMarkdown.trim()
        : "";
    input.context.paperclipTaskMarkdown = [
      promptParts.join("\n\n"),
      existingTask,
    ]
      .filter(Boolean)
      .join("\n\n");
  }
  input.context[RUN_CONTEXT_ENRICHMENT_KEY] = durable;

  const updated = await input.db
    .update(heartbeatRuns)
    .set({ contextSnapshot: input.context, updatedAt: new Date() })
    .where(
      and(
        eq(heartbeatRuns.id, input.run.id),
        eq(heartbeatRuns.companyId, input.run.companyId),
        eq(heartbeatRuns.agentId, input.run.agentId),
        eq(heartbeatRuns.status, "running"),
      ),
    )
    .returning({ id: heartbeatRuns.id });
  if (updated.length !== 1) {
    throw new Error("run_context_enrichment_persist_race");
  }
  return durable;
}
