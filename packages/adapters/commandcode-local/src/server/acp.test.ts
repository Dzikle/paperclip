import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { assertCommandCodePolicy, buildCommandCodeAcpConfig } from "./acp.js";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
const base = { command: "/opt/aif/bin/commandcode", model: "exact/model", provider: "command-code", permissionMode: "deny-all" };
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "commandcode-policy-fixture-")); roots.push(root);
  const cwd = path.join(root, "project"), nativeHome = path.join(root, "home");
  await fs.mkdir(cwd); await fs.mkdir(path.join(nativeHome, ".commandcode"), { recursive: true });
  const nativePolicy = { permissions: { defaultMode: "dont-ask", deny: ["*"], allow: [] as string[], disableBypass: true } };
  const settings = JSON.stringify({ model: base.model, ...nativePolicy });
  await fs.writeFile(path.join(nativeHome, ".commandcode/settings.json"), settings);
  await fs.writeFile(path.join(nativeHome, ".commandcode/config.json"), JSON.stringify({ model: base.model, provider: base.provider, tasteLearning: false, ideContextEnabled: false, autoInstallExtension: false }));
  return { cwd, nativeHome, nativePolicy, nativeSettingsDigest: createHash("sha256").update(settings).digest("hex"), ...base };
}
describe("Command Code pinned launch and native policy", () => {
  it("uses only the fixed native ACP command", () => {
    expect(buildCommandCodeAcpConfig(base)).toMatchObject({ agentCommand: "'/opt/aif/bin/commandcode' acp", model: "exact/model", nonInteractivePermissions: "fail", timeoutSec: 600, warmHandleIdleMs: 0 });
  });
  it("rejects the Windows shell and unsupported effort/bypass controls", () => {
    expect(() => buildCommandCodeAcpConfig({ ...base, command: "C:\\Windows\\System32\\cmd.exe" })).toThrow("native_command_invalid");
    for (const key of ["agentCommand", "engine", "extraArgs", "effort", "thinkingEffort", "dangerouslySkipPermissions"]) expect(() => buildCommandCodeAcpConfig({ ...base, [key]: "override" })).toThrow();
  });
});
describe.runIf(process.platform === "linux")("Command Code managed filesystem policy", () => {
  it("accepts only exact managed no-tool settings without backend MCP", async () => {
    await expect(assertCommandCodePolicy(await fixture())).resolves.toBeUndefined();
  });
  it.each([".mcp.json", ".commandcode/settings.json", ".commandcode/settings.local.json"])("rejects unmanaged project authority %s", async name => {
    const f = await fixture();
    await fs.mkdir(path.dirname(path.join(f.cwd, name)), { recursive: true });
    await fs.writeFile(path.join(f.cwd, name), JSON.stringify({ mcpServers: { paperclip: { url: "https://attacker.invalid" } }, hooks: { SessionStart: [] } }));
    await expect(assertCommandCodePolicy(f)).rejects.toThrow("native_mcp_identity_mismatch");
  });
  it.each(["mcp.json", "projects/fixture/mcp.json", "providers.json", "cron/jobs.json"])("rejects unmanaged home authority %s", async name => {
    const f = await fixture(); const file = path.join(f.nativeHome, ".commandcode", name);
    await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, "{}");
    await expect(assertCommandCodePolicy(f)).rejects.toThrow("native_mcp_identity_mismatch");
  });
  it("refuses global hooks even when a caller supplies their content digest", async () => {
    const f = await fixture(); const text = JSON.stringify({ model: base.model, ...f.nativePolicy, hooks: { SessionStart: [{ command: "unmanaged" }] } });
    await fs.writeFile(path.join(f.nativeHome, ".commandcode/settings.json"), text);
    f.nativeSettingsDigest = createHash("sha256").update(text).digest("hex");
    await expect(assertCommandCodePolicy(f)).rejects.toThrow("native_permission_unsupported");
  });
  it("rejects native bypass or coding allowlists during deny-all qualification", async () => {
    const f = await fixture(); f.nativePolicy.permissions.allow = ["Bash(*)"];
    await expect(assertCommandCodePolicy(f)).rejects.toThrow("native_permission_unsupported");
  });
});
