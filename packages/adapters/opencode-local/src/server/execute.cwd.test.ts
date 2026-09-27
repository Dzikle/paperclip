import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execute } from "./execute.js";

// A real child process models OpenCode's PWD-first session directory selection.
// No model, credentials, network, or process-spawn mock is involved.
describe.skipIf(process.platform === "win32")("OpenCode task directory binding", () => {
  let root: string;
  let workspace: string;
  let command: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-cwd-"));
    workspace = path.join(root, "task workspace");
    command = path.join(root, "opencode-fixture");
    await fs.mkdir(workspace);
    await fs.writeFile(command, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.HOME + "/invocations.jsonl", JSON.stringify(args) + "\\n");
if (args.includes("missing-session")) {
  console.error("Session not found");
  process.exit(1);
}
const directory = args.includes("--dir") ? args[args.indexOf("--dir") + 1] : process.env.PWD;
console.log(JSON.stringify({type: "text", sessionID: "fixture-session", part: {
  text: JSON.stringify({directory, cwd: process.cwd(), args})
}}));
`, { mode: 0o755 });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function run(options: { extraArgs?: string[]; sessionId?: string; noWorkspace?: boolean } = {}) {
    return execute({
      runId: "cwd-regression",
      agent: { id: "cwd-agent", companyId: "cwd-company", name: "OpenCode", adapterType: "opencode_local", adapterConfig: {} },
      runtime: { sessionId: options.sessionId ?? null, sessionParams: options.sessionId ? { sessionId: options.sessionId, cwd: workspace } : null, sessionDisplayId: null, taskKey: null },
      config: {
        command,
        cwd: options.noWorkspace ? workspace : root,
        model: "fixture/no-inference",
        dangerouslySkipPermissions: false,
        paperclipRuntimeSkills: [],
        extraArgs: options.extraArgs ?? [],
        env: { HOME: root, XDG_CONFIG_HOME: path.join(root, "config"), PWD: "/controller", OPENCODE_ALLOW_ALL_MODELS: "1" },
      },
      context: options.noWorkspace ? {} : { paperclipWorkspace: { cwd: workspace, source: "project_primary" } },
      onLog: async () => {},
    });
  }

  it("uses the assigned task worktree instead of inherited PWD or configured cwd", async () => {
    const result = await run();
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.summary!)).toMatchObject({ directory: workspace, cwd: workspace });
    expect(result.sessionParams).toMatchObject({ cwd: workspace });
  });

  it("uses configured cwd when there is no task workspace", async () => {
    const result = await run({ noWorkspace: true });
    expect(JSON.parse(result.summary!)).toMatchObject({ directory: workspace, cwd: workspace });
  });

  it.each(["separate", "equals"])("normalizes an existing matching --dir (%s) without duplicate flags", async (style) => {
    const result = await run({ extraArgs: style === "separate" ? ["--dir", workspace, "--thinking"] : [`--dir=${workspace}`, "--thinking"] });
    const observed = JSON.parse(result.summary!);
    expect(observed.directory).toBe(workspace);
    expect(observed.args.filter((arg: string) => arg === "--dir")).toHaveLength(1);
    expect(observed.args).toContain("--thinking");
    expect(observed.args.some((arg: string) => arg.startsWith("--dir="))).toBe(false);
  });

  it.each([["--dir", "/other-task"], ["--dir=/other-task"], ["--dir"], ["--dir="]])("rejects a conflicting or missing directory before native invocation (%j)", async (...extraArgs) => {
    await expect(run({ extraArgs })).rejects.toThrow("OpenCode --dir must match the resolved execution workspace");
    await expect(fs.stat(path.join(root, "invocations.jsonl"))).rejects.toThrow();
  });

  it("preserves literal message arguments after the option separator", async () => {
    const result = await run({ extraArgs: ["--", "--dir", "/literal-message"] });
    const observed = JSON.parse(result.summary!);
    expect(observed.directory).toBe(workspace);
    expect(observed.args.slice(-3)).toEqual(["--", "--dir", "/literal-message"]);
  });

  it("keeps directory binding on resume and missing-session retry", async () => {
    const result = await run({ sessionId: "missing-session" });
    expect(result.exitCode).toBe(0);
    const invocations = (await fs.readFile(path.join(root, "invocations.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
    expect(invocations).toHaveLength(2);
    expect(invocations[0]).toContain("--session");
    expect(invocations[1]).not.toContain("--session");
    for (const args of invocations) expect(args[args.indexOf("--dir") + 1]).toBe(workspace);
    expect(JSON.parse(result.summary!)).toMatchObject({ directory: workspace });
  });
});
