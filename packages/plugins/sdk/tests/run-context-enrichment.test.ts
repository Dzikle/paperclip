import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { definePlugin } from "../src/define-plugin.js";
import {
  createRequest,
  isJsonRpcResponse,
  parseMessage,
  serializeMessage,
  type JsonRpcResponse,
  type RunContextEnrichmentParams,
} from "../src/protocol.js";
import { startWorkerRpcHost } from "../src/worker-rpc-host.js";

const MANIFEST = {
  id: "paperclip.run-context-enrichment-test",
  apiVersion: 1,
  version: "1.0.0",
  displayName: "Run Context Enrichment Test",
  description: "Test plugin",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: ["agent.run.enrich"],
  entrypoints: {},
} as const;

function startTestWorker(plugin: ReturnType<typeof definePlugin>) {
  const hostToWorker = new PassThrough();
  const workerToHost = new PassThrough();
  const hostReadline = createInterface({ input: workerToHost });
  const pending = new Map<string, (response: JsonRpcResponse) => void>();
  let nextRequestId = 1;

  hostReadline.on("line", (line) => {
    const message = parseMessage(line);
    if (!isJsonRpcResponse(message)) return;
    pending.get(String(message.id))?.(message);
    pending.delete(String(message.id));
  });

  const worker = startWorkerRpcHost({ plugin, stdin: hostToWorker, stdout: workerToHost });

  function callWorker<T = unknown>(method: string, params: unknown): Promise<T> {
    const id = `host-${nextRequestId++}`;
    const result = new Promise<T>((resolve, reject) => {
      pending.set(id, (response) => {
        if ("error" in response && response.error) {
          reject(Object.assign(new Error(response.error.message), { code: response.error.code }));
          return;
        }
        resolve((response as { result?: T }).result as T);
      });
    });
    hostToWorker.write(serializeMessage(createRequest(method, params, id)));
    return result;
  }

  function stop() {
    worker.stop();
    hostReadline.close();
    hostToWorker.destroy();
    workerToHost.destroy();
  }

  return { callWorker, stop };
}

describe("run context enrichment RPC", () => {
  it("advertises and routes the optional enrichment hook", async () => {
    const seen: RunContextEnrichmentParams[] = [];
    const worker = startTestWorker(
      definePlugin({
        async setup() {},
        async onRunContextEnrich(params) {
          seen.push(params);
          return {
            promptMarkdown: "Use the bounded context artifact.",
            artifact: {
              ref: "artifact://context/run-1.json",
              sha256: "a".repeat(64),
              mediaType: "application/json",
              byteSize: 42,
            },
            metadata: { source: "test" },
          };
        },
      }),
    );

    try {
      const initialized = await worker.callWorker<{ supportedMethods: string[] }>(
        "initialize",
        { manifest: MANIFEST, config: {}, databaseNamespace: null },
      );
      expect(initialized.supportedMethods).toContain("enrichRunContext");

      const params: RunContextEnrichmentParams = {
        companyId: "company-1",
        runId: "run-1",
        agentId: "agent-1",
        issueId: "issue-1",
        adapterType: "process",
        taskContext: { paperclipTaskMarkdown: "Original task" },
        workspace: { cwd: "/workspace" },
        runtimeMcpServers: [
          {
            name: "Knowledge",
            url: "http://gateway.example/mcp",
            token: "run-scoped-token",
            connectionId: "knowledge",
          },
        ],
      };
      const result = await worker.callWorker("enrichRunContext", params);

      expect(seen).toEqual([params]);
      expect(result).toMatchObject({
        promptMarkdown: "Use the bounded context artifact.",
        artifact: { ref: "artifact://context/run-1.json", sha256: "a".repeat(64) },
      });
    } finally {
      worker.stop();
    }
  });

  it("does not advertise the hook when it is absent", async () => {
    const worker = startTestWorker(definePlugin({ async setup() {} }));
    try {
      const initialized = await worker.callWorker<{ supportedMethods: string[] }>(
        "initialize",
        { manifest: MANIFEST, config: {}, databaseNamespace: null },
      );
      expect(initialized.supportedMethods).not.toContain("enrichRunContext");
    } finally {
      worker.stop();
    }
  });
});
