// Offline wire-level proof fixture: legacy model set succeeds with an empty
// acknowledgement. That is deliberately NOT effective backend model evidence.
import fs from "node:fs";
import { createInterface } from "node:readline";
const send = value => process.stdout.write(JSON.stringify(value) + "\n");
const lines = createInterface({ input: process.stdin });
let resumed = false;
const options = () => ({ configOptions: [{ id: "model", name: "Model", type: "select", category: "model", currentValue: "exact/model", options: [{ value: "exact/model", name: "Exact" }] }] });
lines.on("line", line => {
  const request = JSON.parse(line);
  fs.appendFileSync("requests", request.method + "\n");
  let result = {};
  if (request.method === "initialize") result = { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { close: {} } }, agentInfo: { name: "offline-model-proof", version: "1" } };
  if (request.method === "session/new") result = { sessionId: "offline-model-proof", models: { currentModelId: "initial/model", availableModels: [{ modelId: "initial/model", name: "Initial" }, { modelId: "exact/model", name: "Exact" }] } };
  if (request.method === "session/load" || request.method === "session/resume") resumed = true;
  if (process.env.MODEL_PROOF_METADATA === "1" && !resumed && ["session/new", "session/set_config_option", "session/set_model"].includes(request.method)) result = { ...result, ...options() };
  if (request.method === "session/prompt") result = { stopReason: "end_turn" };
  if (request.id !== undefined) send({ jsonrpc: "2.0", id: request.id, result });
});
