import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { captureNativeCanarySource, verifyNativeCanaryCandidate } from "./native-canary-source.js";
const exec = promisify(execFile), roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function fixture() {
  const cwd = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "aif-native-canary-"))); roots.push(cwd);
  const git = async (...args: string[]) => (await exec("git", args, { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } })).stdout.trim();
  await git("init", "-b", "aif-native-canary/00000000-0000-4000-8000-000000000001");
  await git("config", "user.name", "Offline fixture"); await git("config", "user.email", "fixture@example.invalid");
  await git("commit", "--allow-empty", "-m", "Empty trusted canary baseline");
  const baseCommit = await git("rev-parse", "HEAD"), source = await captureNativeCanarySource(cwd, baseCommit);
  const candidate = async (extra = false) => {
    await fs.mkdir(path.join(cwd, "native_canary"));
    await fs.writeFile(path.join(cwd, "native_canary/add.py"), "def add(a, b): return a + b\n");
    await fs.writeFile(path.join(cwd, "native_canary/test_add.py"), "from add import add\nassert add(0, 0) == 0\n");
    if (extra) await fs.writeFile(path.join(cwd, "outside.txt"), "out of scope");
    await git("add", "."); await git("commit", "-m", "Canary candidate");
  };
  return { cwd, git, baseCommit, source, candidate };
}
describe.runIf(process.platform === "linux")("controller canary source proof (offline Git only)", () => {
  it("rejects repository clean filters before any filter executes", async () => {
    const f = await fixture(), marker = path.join(f.cwd, "filter-executed");
    await fs.writeFile(path.join(f.cwd, ".gitattributes"), "probe filter=untrusted\n");
    await fs.writeFile(path.join(f.cwd, "probe"), "initial\n");
    await f.git("add", "."); await f.git("commit", "-m", "Non-canary source");
    await f.git("config", "filter.untrusted.clean", `sh -c 'echo marker > "${marker}"; cat'`);
    await fs.writeFile(path.join(f.cwd, "probe"), "changed\n");
    await expect(captureNativeCanarySource(f.cwd, f.baseCommit)).rejects.toThrow();
    await expect(fs.access(marker)).rejects.toThrow();
  });
  it("captures an empty disposable baseline and verifies one clean confined commit", async () => {
    const f = await fixture(); await f.candidate();
    expect(await verifyNativeCanaryCandidate(f.cwd, f.source)).toBe(await f.git("rev-parse", "HEAD^{tree}"));
  });
  it("rejects unchanged HEAD, missing captured provenance and foreign baseline", async () => {
    const f = await fixture();
    for (const source of [undefined, f.source, { ...f.source, baseCommit: "a".repeat(40) }]) await expect(verifyNativeCanaryCandidate(f.cwd, source)).rejects.toThrow();
  });
  it("rejects committed paths outside the fixture", async () => {
    const f = await fixture(); await f.candidate(true);
    await expect(verifyNativeCanaryCandidate(f.cwd, f.source)).rejects.toThrow("native_qualification_mismatch");
  });
  it("rejects dirty and ignored work after the candidate commit", async () => {
    const f = await fixture(); await f.candidate();
    await fs.appendFile(path.join(f.cwd, ".git/info/exclude"), "ignored-secret\n");
    await fs.writeFile(path.join(f.cwd, "ignored-secret"), "offline placeholder");
    await expect(verifyNativeCanaryCandidate(f.cwd, f.source)).rejects.toThrow("native_qualification_mismatch");
  });
  it("rejects a normal project branch or repository with a remote", async () => {
    const f = await fixture(); await f.git("branch", "-m", "main");
    await expect(captureNativeCanarySource(f.cwd, f.baseCommit)).rejects.toThrow();
    await f.git("branch", "-m", f.source.branch); await f.git("remote", "add", "origin", "https://example.invalid/repo");
    await expect(captureNativeCanarySource(f.cwd, f.baseCommit)).rejects.toThrow();
  });
});
