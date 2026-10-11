/** Offline characterization only. Never imported by an adapter or the controller.
 * Executes selected trusted pinned functions, not the vendor CLI entry point.
 * Node VM is a test fixture, not an OS sandbox or admission authority. */
import fs from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import vm from "node:vm";

const BUNDLE_SHA = "d976c2ad89f93a2b81af4d150dca99aeedfd679f15e8b8c032314e61e484da7b";
const PARSER_SHA = "953573b8fdab71599749ea5f2b33d3e760c2116178f9423ee7458dbe39d59453";
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
async function boundedRead(file, limit) {
  if (typeof file !== "string" || !file) throw new Error("native_audit_path_required");
  const before = await fs.lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size > limit) throw new Error("native_audit_file_invalid");
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit || stat.ino !== before.ino || stat.dev !== before.dev) throw new Error("native_audit_file_invalid");
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > limit) throw new Error("native_audit_file_invalid");
    return buffer.subarray(0, length);
  } finally { await handle.close(); }
}
export function extractNamedFunctions(source, parser) {
  const ast = parser.parse(source, { ecmaVersion: "latest", sourceType: "module" });
  const functions = new Map();
  const ranges = [];
  for (const name of ["createModHost", "anchorPathPattern"]) {
    const matches = ast.body.filter(node => node.type === "FunctionDeclaration" && node.id?.name === name);
    if (matches.length !== 1) throw new Error("native_audit_function_missing");
    const node = matches[0], text = source.slice(node.start, node.end);
    functions.set(name, text);
    ranges.push({ name, start: node.start, end: node.end, sha256: sha256(text) });
  }
  functions.provenance = { functions: ranges };
  return functions;
}
export async function readPinnedFunctions({ bundlePath, parserPath }) {
  const bundle = await boundedRead(bundlePath, 8 * 1024 * 1024);
  if (sha256(bundle) !== BUNDLE_SHA) throw new Error("native_audit_bundle_mismatch");
  const parserBytes = await boundedRead(parserPath, 1024 * 1024);
  if (sha256(parserBytes) !== PARSER_SHA) throw new Error("native_audit_parser_mismatch");
  // Import the verified bytes, not a filesystem path that could change after
  // hashing. Acorn's pinned standalone module has no external imports.
  const parser = await import("data:text/javascript;base64," + parserBytes.toString("base64"));
  if (parser.version !== "8.18.0") throw new Error("native_audit_parser_mismatch");
  const functions = extractNamedFunctions(bundle.toString("utf8"), parser);
  functions.provenance = { bundleSha256: BUNDLE_SHA, parserSha256: PARSER_SHA,
    parserVersion: parser.version, ...functions.provenance };
  return functions;
}
export function createOfflineModHost(functionSource) {
  const context = vm.createContext({
    __name: value => value,
    createModEventBus: () => ({ emit() {}, on: () => () => {} }),
    toDisposable: dispose => ({ dispose }),
    Ka: undefined, ja: "offline:", Va: 64,
    publishModStatus() {}, sanitizeStatusText: value => String(value),
    isModStatusRendered: () => false,
  }, { codeGeneration: { strings: false, wasm: false } });
  vm.runInContext(`${functionSource}; globalThis.host = createModHost({
    cwd: '/offline/project', runtime: { cwd: () => '/offline/project' }
  });`, context, { timeout: 1000 });
  return { host: context.host, context };
}
