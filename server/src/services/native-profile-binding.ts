import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { agents, companySecrets, companySkills, companySkillVersions, projectWorkspaces, projects, type Db } from "@paperclipai/db";
import { nativeBindingFingerprint, type NativeBindingIdentity } from "@paperclipai/adapter-utils/native-provider-contract";
import { nativeAbsolutePath, nativeText } from "@paperclipai/adapter-utils/native-provider-adapter";
import { readPaperclipSkillSyncPreference, type PaperclipSkillEntry } from "@paperclipai/adapter-utils/server-utils";
import { toolAccessService } from "./tool-access.js";
import { nativeArtifactDigest } from "@paperclipai/adapter-utils/native-runtime-artifacts";
import { nativeCredentialGeneration } from "./native-credential-generation.js";

export const NATIVE_RUNTIME_MANIFEST_PATH = "/opt/aif/native-runtime-pins.json";
export function nativeDigest(value: unknown): string {
  function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])]));
    return value;
  }
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
async function boundedFile(file: string, limit: number): Promise<Buffer> {
  const handle = await fs.open(file, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error("native_binding_invalid");
    const bytes = Buffer.alloc(limit + 1);
    const read = await handle.read(bytes, 0, bytes.length, 0);
    if (read.bytesRead > limit) throw new Error("native_binding_invalid");
    return bytes.subarray(0, read.bytesRead);
  } finally { await handle.close(); }
}
export interface NativeRuntimePin { runtimePin: string; command: string; executableDigest: string; adapterDigest: string; artifacts: Array<{ path: string; digest: string }> }
/** Fixed immutable-image artifact, never a task-supplied file or version string. */
export async function readNativeRuntimePin(adapterType: string): Promise<NativeRuntimePin> {
  const manifest = JSON.parse((await boundedFile(NATIVE_RUNTIME_MANIFEST_PATH, 32_768)).toString("utf8")) as { schemaVersion?: number; adapters?: Record<string, NativeRuntimePin> };
  const pin = manifest.adapters?.[adapterType];
  if (manifest.schemaVersion !== 1 || !pin || !/^[a-f0-9]{64}$/.test(pin.executableDigest) || !/^[a-f0-9]{64}$/.test(pin.adapterDigest)) throw new Error("native_runtime_pin_missing");
  nativeText(pin.runtimePin); nativeAbsolutePath(pin.command);
  const executable = await fs.realpath(pin.command);
  const content = await boundedFile(executable, 64 * 1024 * 1024);
  if (createHash("sha256").update(content).digest("hex") !== pin.executableDigest) throw new Error("native_runtime_pin_mismatch");
  if (!Array.isArray(pin.artifacts) || !pin.artifacts.length || pin.artifacts.length > 4) throw new Error("native_runtime_pin_missing");
  for (const artifact of pin.artifacts) {
    nativeAbsolutePath(artifact.path);
    if (!/^[a-f0-9]{64}$/.test(artifact.digest) || await nativeArtifactDigest(artifact.path) !== artifact.digest) throw new Error("native_runtime_pin_mismatch");
  }
  return pin;
}
export interface NativeBindingAgent { id: string; companyId: string; adapterType: string; adapterConfig: Record<string, unknown> }
export async function resolveNativeBinding(db: Db, agent: NativeBindingAgent, config: Record<string, unknown>, projectId: string, runtimeSkills?: PaperclipSkillEntry[]): Promise<NativeBindingIdentity> {
  // Persisted agent env is untrusted; controller scratch/Git/network env is added
  // only after this config snapshot. Never fingerprint resolved credential values.
  const ownerEnv = agent.adapterConfig.env;
  if (ownerEnv !== undefined && (!ownerEnv || typeof ownerEnv !== "object" || Array.isArray(ownerEnv))) throw new Error("native_env_invalid");
  // Native login is tied to the dedicated credential file, not an untracked
  // alternate API token, provider URL, or native settings override in env.
  if (Object.keys(ownerEnv as Record<string, unknown> ?? {}).length) throw new Error("native_env_invalid");
  if (!["free", "subscription"].includes(String(config.nativeCostTier)) || config.maxPaidUsd !== 0) throw new Error("native_paid_disallowed");
  const [project] = await db.select({ id: projects.id }).from(projects).where(and(eq(projects.id, projectId), eq(projects.companyId, agent.companyId))).limit(1);
  if (!project) throw new Error("native_project_mismatch");
  const cwd = nativeAbsolutePath(config.cwd);
  if (await fs.realpath(cwd) !== cwd) throw new Error("native_binding_invalid");
  const workspaces = await db.select({ cwd: projectWorkspaces.cwd }).from(projectWorkspaces).where(and(eq(projectWorkspaces.projectId, projectId), eq(projectWorkspaces.companyId, agent.companyId)));
  if (!workspaces.some(workspace => workspace.cwd === cwd)) throw new Error("native_project_mismatch");
  const home = nativeAbsolutePath(config.nativeHome);
  const [sharedHome] = await db.select({ id: agents.id }).from(agents).where(and(sql`${agents.id} <> ${agent.id}`, sql`${agents.adapterConfig} ->> 'nativeHome' = ${home}`)).limit(1);
  if (sharedHome) throw new Error("native_credential_home_shared");
  const pin = await readNativeRuntimePin(agent.adapterType);
  if (config.command !== pin.command || config.nativeExecutableDigest !== pin.executableDigest || config.runtimePin !== pin.runtimePin) throw new Error("native_runtime_pin_mismatch");
  const credentialId = nativeText(config.nativeCredentialSecretId);
  const [credential] = await db.select({ id: companySecrets.id, version: companySecrets.latestVersion, metadata: companySecrets.providerMetadata, creatorAgent: companySecrets.createdByAgentId, creatorUser: companySecrets.createdByUserId }).from(companySecrets).where(and(eq(companySecrets.id, credentialId), eq(companySecrets.companyId, agent.companyId), eq(companySecrets.status, "active"), isNull(companySecrets.deletedAt))).limit(1);
  if (!credential) throw new Error("native_credential_binding_missing");
  const generation = await nativeCredentialGeneration(home, config.nativeCredentialFile);
  const association = credential.metadata;
  if (!credential.creatorUser || credential.creatorAgent || !association || association.nativeHome !== home || association.nativeCredentialFile !== config.nativeCredentialFile || association.accountRef !== config.accountRef || association.adapterType !== agent.adapterType || association.generationRef !== generation) throw new Error("native_credential_binding_missing");
  const credentialVersionRef = `${credential.id}:v${credential.version}:${generation}`;
  if (config.credentialVersionRef !== credentialVersionRef) throw new Error("native_credential_binding_changed");
  const preference = readPaperclipSkillSyncPreference(config);
  if (!preference.explicit || preference.desiredSkillEntries.length > 32) throw new Error("native_skill_unavailable");
  const desired = preference.desiredSkillEntries;
  const skills = desired.length ? await db.select().from(companySkills).where(and(eq(companySkills.companyId, agent.companyId), inArray(companySkills.key, desired.map(entry => entry.key)))) : [];
  const selected: Array<{ key: string; versionId: string; contentDigest: string; inventoryDigest: string }> = [];
  for (const desiredSkill of desired) {
    const skill = skills.find(skill => skill.key === desiredSkill.key);
    const versionId = desiredSkill.versionId ?? skill?.currentVersionId;
    if (!skill || !versionId) throw new Error("native_skill_unavailable");
    const [version] = await db.select().from(companySkillVersions).where(and(eq(companySkillVersions.id, versionId), eq(companySkillVersions.companyId, agent.companyId), eq(companySkillVersions.companySkillId, skill.id))).limit(1);
    const instruction = version?.fileInventory.find(file => file.path === "SKILL.md");
    if (!version || !instruction) throw new Error("native_skill_unavailable");
    const digest = createHash("sha256").update(instruction.content, "utf8").digest("hex");
    if (runtimeSkills) {
      const entry = runtimeSkills.find(entry => entry.key === skill.key);
      if (!entry || entry.sourceStatus === "missing") throw new Error("native_skill_unavailable");
      const actual = await boundedFile(entry.source + "/SKILL.md", 32_768);
      if (createHash("sha256").update(actual).digest("hex") !== digest) throw new Error("native_instructions_changed");
    }
    selected.push({ key: skill.key, versionId, contentDigest: digest, inventoryDigest: nativeDigest(version.fileInventory) });
  }
  let instructions = "";
  if (config.instructionsFilePath) instructions = (await boundedFile(nativeAbsolutePath(config.instructionsFilePath), 32_768)).toString("utf8");
  const effective = await toolAccessService(db).getEffectiveProfilesForAgent(agent.companyId, agent.id);
  const mcpDigest = nativeDigest({ profiles: effective.profiles.map(profile => ({ id: profile.id, defaultAction: profile.defaultAction, entries: profile.entries })).sort((a, b) => a.id.localeCompare(b.id)),
    tools: [...effective.allowedTools].sort((a, b) => a.id.localeCompare(b.id)),
    connections: effective.installedConnections.map(connection => ({ id: connection.id, name: connection.name, status: connection.status, enabled: connection.enabled, transport: connection.transport, config: connection.config, transportConfig: connection.transportConfig, credentialSecretRefs: connection.credentialSecretRefs, credentialRefs: connection.credentialRefs, grants: connection.grants })).sort((a, b) => a.id.localeCompare(b.id)) });
  const binding: NativeBindingIdentity = { companyId: agent.companyId, agentId: agent.id, projectId, cwd, adapterType: agent.adapterType, model: nativeText(config.model), provider: nativeText(config.provider), accountRef: nativeText(config.accountRef), runtimePin: pin.runtimePin,
    policyDigest: nativeDigest({ permissionMode: config.permissionMode, timeoutSec: config.timeoutSec ?? 600, nativePolicy: config.nativePolicy ?? null, nativeHome: config.nativeHome, nativeSettingsDigest: config.nativeSettingsDigest ?? null, nativeCostTier: config.nativeCostTier, maxPaidUsd: 0, nonInteractivePermissions: "fail", warmHandleIdleMs: 0,
      envNames: Object.keys(ownerEnv as Record<string, unknown> ?? {}).sort() }),
    mcpDigest, instructionsDigest: nativeDigest({ instructions, promptTemplate: config.promptTemplate ?? null, bootstrapPromptTemplate: config.bootstrapPromptTemplate ?? null, skills: selected.sort((a, b) => a.key.localeCompare(b.key)) }), credentialVersionRef };
  nativeBindingFingerprint(binding);
  return binding;
}
