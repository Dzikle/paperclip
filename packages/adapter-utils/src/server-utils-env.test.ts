import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runChildProcess, sanitizeInheritedPaperclipEnv } from "./server-utils.js";

afterEach(() => vi.unstubAllEnvs());

describe("sanitizeInheritedPaperclipEnv", () => {
  it("drops the host-only Paperclip CLI command pointer", () => {
    expect(sanitizeInheritedPaperclipEnv({
      PAPERCLIPAI_CMD: "node /missing/paperclipai/dist/index.js",
      PAPERCLIP_RUNTIME_API_URL: "http://127.0.0.1:3100",
      PATH: "/usr/bin",
    })).toEqual({
      PAPERCLIP_RUNTIME_API_URL: "http://127.0.0.1:3100",
      PATH: "/usr/bin",
    });
  });

  it("inherits only runtime identity, locale and certificate settings, case-insensitively", () => {
    const runtimeEnv = {
      Path: "/usr/bin",
      SystemRoot: "C:\\Windows",
      HOME: "/home/agent",
      TMPDIR: "/tmp",
      XDG_CONFIG_HOME: "/home/agent/.config",
      LANG: "en_US.UTF-8",
      LC_ALL: "C",
      NODE_EXTRA_CA_CERTS: "/etc/agent-ca.pem",
      PAPERCLIP_LISTEN_HOST: "localhost",
      PAPERCLIP_LISTEN_PORT: "3100",
    };
    expect(sanitizeInheritedPaperclipEnv({
      ...runtimeEnv,
      DATABASE_URL: "controller-database",
      database_url: "controller-database-lowercase",
      BETTER_AUTH_SECRET: "controller-auth",
      PAPERCLIP_SECRETS_MASTER_KEY: "controller-master-key",
      PAPERCLIP_AGENT_JWT_SECRET: "controller-signing-key",
      OPENAI_API_KEY: "controller-provider-key",
      PRIVATE_BACKEND_CREDENTIAL: "unknown-controller-secret",
      NODE_OPTIONS: "--require=/controller/bootstrap.cjs",
      BASH_ENV: "/controller/startup.sh",
      HTTP_PROXY: "http://controller:password@proxy",
    })).toEqual(runtimeEnv);
  });
});

describe("runChildProcess environment isolation", () => {
  it("does not expose ambient controller secrets to a real child", async () => {
    const secrets = [
      "DATABASE_URL", "database_url", "PGPASSWORD", "BETTER_AUTH_SECRET",
      "PAPERCLIP_SECRETS_MASTER_KEY", "PAPERCLIP_AGENT_JWT_SECRET",
      "OPENAI_API_KEY", "PRIVATE_BACKEND_CREDENTIAL",
    ];
    for (const key of secrets) vi.stubEnv(key, "controller-only-sentinel");
    const result = await runChildProcess(randomUUID(), process.execPath, [
      "-e",
      `process.stdout.write(JSON.stringify(${JSON.stringify(secrets)}.filter(key => process.env[key] !== undefined)))`,
    ], {
      cwd: process.cwd(), env: {}, timeoutSec: 5, graceSec: 1,
      onLog: async () => {},
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([]);
  });

  it("preserves explicitly bound project/provider credentials and governed run tokens", async () => {
    vi.stubEnv("DATABASE_URL", "controller-database");
    vi.stubEnv("OPENAI_API_KEY", "controller-provider-key");
    vi.stubEnv("PAPERCLIP_API_KEY", "controller-api-key");
    const explicitEnv = {
      DATABASE_URL: "project-test-database",
      OPENAI_API_KEY: "assigned-provider-key",
      PAPERCLIP_API_KEY: "run-scoped-jwt",
      PAPERCLIP_RUN_ID: "run-identity",
      PAPERCLIP_RUNTIME_TOOLS_TOKEN: "run-scoped-mcp-token",
      PAPERCLIP_RUNTIME_TOOLS_URL: "http://governed-runtime/mcp",
    };
    const result = await runChildProcess(randomUUID(), process.execPath, [
      "-e",
      `process.stdout.write(JSON.stringify(Object.fromEntries(${JSON.stringify(Object.keys(explicitEnv))}.map(key => [key, process.env[key]]))))`,
    ], {
      cwd: process.cwd(), env: explicitEnv, timeoutSec: 5, graceSec: 1,
      onLog: async () => {},
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(explicitEnv);
  });
});
