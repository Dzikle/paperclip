import fs from "node:fs/promises";
import { expect, it } from "vitest";
it("ships a self-contained parser usable by the external-parser worker", async () => {
  const source = await fs.readFile(new URL("../dist/ui-parser.cjs", import.meta.url), "utf8");
  const exports = {}, module = { exports };
  new Function("exports", "module", "self", "globalThis", source)(exports, module, undefined, undefined);
  const parser = module.exports as { parseStdoutLine: (line: string, ts: string) => unknown[] };
  expect(typeof parser.parseStdoutLine).toBe("function");
  expect(Array.isArray(parser.parseStdoutLine("plain governed output", "fixture-ts"))).toBe(true);
});
