import { createHash } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
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
  promptMarkdown?: string | null;
}

interface EnrichmentPluginIdentity {
  pluginId: string;
  pluginKey: string;
  pluginVersion: string;
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
  const mediaType = value.mediaType == null ? null : value.mediaType;
  let byteSize: number | null = null;
  if (!ref || ref.length > MAX_ARTIFACT_REF_CHARS) {
    throw new Error("run_context_enrichment_artifact_ref_invalid");
  }
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    throw new Error("run_context_enrichment_artifact_sha256_invalid");
  }
  if (
    mediaType !== null &&
    (typeof mediaType !== "string" ||
      !mediaType.trim() ||
      mediaType.length > MAX_MEDIA_TYPE_CHARS)
  ) {
    throw new Error("run_context_enrichment_artifact_media_type_invalid");
  }
  if (value.byteSize != null) {
    if (
      typeof value.byteSize !== "number" ||
      !Number.isSafeInteger(value.byteSize) ||
      value.byteSize < 0
    ) {
      throw new Error("run_context_enrichment_artifact_byte_size_invalid");
    }
    byteSize = value.byteSize;
  }
  return {
    ref,
    sha256,
    ...(mediaType === null ? {} : { mediaType: mediaType.trim() }),
    ...(byteSize === null ? {} : { byteSize }),
  };
}

function validateResult(value: unknown): RunContextEnrichmentResult {
  if (!plainObject(value)) throw new Error("run_context_enrichment_result_invalid");
  const promptMarkdown = value.promptMarkdown == null ? null : value.promptMarkdown;
  if (promptMarkdown !== null && typeof promptMarkdown !== "string") {
    throw new Error("run_context_enrichment_prompt_invalid");
  }
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

function applyEnrichmentPrompt(
  context: Record<string, unknown>,
  promptMarkdown: string | null | undefined,
): void {
  if (!promptMarkdown) return;
  const prepend = (existing: unknown) => {
    const task = typeof existing === "string" ? existing.trim() : "";
    if (task === promptMarkdown || task.startsWith(`${promptMarkdown}\n\n`)) {
      return task;
    }
    return [promptMarkdown, task].filter(Boolean).join("\n\n");
  };
  context.paperclipTaskMarkdown = prepend(context.paperclipTaskMarkdown);
  if (typeof context.paperclipTaskMarkdownCompact === "string") {
    context.paperclipTaskMarkdownCompact = prepend(
      context.paperclipTaskMarkdownCompact,
    );
  }
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
  resolveRuntimeMcpServers: (plugin: EnrichmentPluginIdentity) => Promise<AdapterRuntimeMcpServer[]>;
  releaseRuntimeMcpServers: (plugin: EnrichmentPluginIdentity) => Promise<void>;
}): Promise<DurableRunContextEnrichment | null> {
  const persisted = existingEnrichment(input.context);
  if (persisted) {
    applyEnrichmentPrompt(input.context, persisted.promptMarkdown);
    return persisted;
  }

  const candidates = (
    await input.db
      .select({
        id: plugins.id,
        pluginKey: plugins.pluginKey,
        version: plugins.version,
        manifest: plugins.manifestJson,
        companySettings: pluginCompanySettings.settingsJson,
      })
      .from(plugins)
      .innerJoin(
        pluginCompanySettings,
        and(
          eq(pluginCompanySettings.pluginId, plugins.id),
          eq(pluginCompanySettings.companyId, input.run.companyId),
        ),
      )
      .where(
        and(
          eq(plugins.status, "ready"),
          eq(pluginCompanySettings.enabled, true),
        ),
      )
      .orderBy(asc(plugins.installOrder), asc(plugins.id))
  ).filter((plugin) =>
    plugin.manifest.capabilities.includes("agent.run.enrich") &&
    plugin.companySettings.runContextEnrichmentEnabled === true,
  );

  if (candidates.length === 0) return null;
  if (!input.workerManager) {
    throw new Error("run_context_enrichment_worker_manager_unavailable");
  }
  if (candidates.length > MAX_ENRICHERS) {
    throw new Error("run_context_enrichment_plugin_limit_exceeded");
  }

  // Keep the no-enricher path behaviorally inert. In particular, native runs
  // retain their existing connection-resolution timing and diagnostics.
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
    const pluginIdentity = {
      pluginId: plugin.id,
      pluginKey: plugin.pluginKey,
      pluginVersion: plugin.version,
    };
    let raw: unknown;
    try {
      const runtimeMcpServers = await input.resolveRuntimeMcpServers(pluginIdentity);
      raw = await input.workerManager.call(
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
          runtimeMcpServers: runtimeMcpServers.map((server) => ({ ...server })),
        },
      );
    } finally {
      await input.releaseRuntimeMcpServers(pluginIdentity);
    }
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

  const promptMarkdown = promptParts.length > 0 ? promptParts.join("\n\n") : null;
  const durable: DurableRunContextEnrichment = { version: 1, entries, promptMarkdown };
  applyEnrichmentPrompt(input.context, promptMarkdown);
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
