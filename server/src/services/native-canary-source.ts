import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execute = promisify(execFile);
export interface NativeCanarySource { baseCommit: string; branch: string }
const oid = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const allowed = ["native_canary/add.py", "native_canary/test_add.py"];
const fail = (): never => { throw new Error("native_qualification_mismatch"); };
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execute("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...args], {
    cwd, timeout: 10_000, maxBuffer: 65_536,
    // No caller Git config, external filter or credential helper participates.
    env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" },
  });
  return stdout;
}
async function isolated(cwd: string): Promise<string> {
  if (process.platform !== "linux" || await fs.realpath(cwd) !== cwd) fail();
  const directory = path.join(cwd, ".git");
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(directory) !== directory) fail();
  // Inspect the plain bounded local configuration before status can invoke a
  // clean filter. Includes and filters are rejected, never executed as a probe.
  const configFile = path.join(directory, "config"), configStat = await fs.lstat(configFile);
  if (!configStat.isFile() || configStat.isSymbolicLink() || configStat.size > 32_768 || await fs.realpath(configFile) !== configFile) fail();
  const config = await git(cwd, ["-C", "/", "config", "--file", configFile, "--no-includes", "--name-only", "--list"]);
  if (config.trim().split("\n").some(key => !["core.repositoryformatversion", "core.filemode", "core.bare", "core.logallrefupdates", "user.name", "user.email"].includes(key))) fail();
  // Linked worktrees, shared repositories and live remotes are not canaries.
  if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(directory) !== directory
      || (await git(cwd, ["rev-parse", "--show-toplevel"])).trim() !== cwd
      || (await git(cwd, ["remote"])).trim()
      || (await git(cwd, ["status", "--porcelain=v1", "--untracked-files=all", "--ignored"])).trim()) fail();
  for (const name of ["objects/info/alternates", "commondir"]) {
    if (await fs.lstat(path.join(directory, name)).then(() => true).catch(error => { if (error.code === "ENOENT") return false; throw error; })) fail();
  }
  if ((await git(cwd, ["config", "--local", "--get", "core.bare"])).trim() !== "false") fail();
  const branch = (await git(cwd, ["symbolic-ref", "--short", "HEAD"])).trim();
  if (!/^aif-native-canary\/[a-f0-9-]{36}$/.test(branch)) fail();
  return branch;
}
/** Read-only readiness for an owner-prepared, empty committed standalone copy.
 * This proves source scope, not OS isolation or native tool containment. */
export async function captureNativeCanarySource(cwd: string, baseCommit: unknown): Promise<NativeCanarySource> {
  if (typeof baseCommit !== "string" || !oid.test(baseCommit)) fail();
  const branch = await isolated(cwd);
  if ((await git(cwd, ["rev-parse", "HEAD"])).trim() !== baseCommit
      || (await git(cwd, ["ls-tree", "-r", "--name-only", "HEAD"])).trim()) fail();
  return { baseCommit: baseCommit as string, branch };
}
export async function verifyNativeCanaryCandidate(cwd: string, source: NativeCanarySource | undefined): Promise<string> {
  if (!source || !oid.test(source.baseCommit) || await isolated(cwd) !== source.branch) fail();
  const head = (await git(cwd, ["rev-parse", "HEAD"])).trim();
  if (!oid.test(head) || head === source!.baseCommit || (await git(cwd, ["rev-list", "--parents", "-n", "1", "HEAD"])).trim() !== `${head} ${source!.baseCommit}`
      || (await git(cwd, ["ls-tree", "-r", "--name-only", source!.baseCommit])).trim()) fail();
  const entries = (await git(cwd, ["ls-tree", "-r", "HEAD"])).trim().split("\n");
  if (entries.length !== 2 || entries.some((entry, index) => !entry.startsWith("100644 blob ") || entry.split("\t")[1] !== allowed[index])) fail();
  for (const name of allowed) {
    const file = path.join(cwd, name), stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0 || stat.size > 65_536 || await fs.realpath(file) !== file) fail();
  }
  const tree = (await git(cwd, ["rev-parse", "HEAD^{tree}"])).trim();
  if (!oid.test(tree)) fail();
  return tree;
}
