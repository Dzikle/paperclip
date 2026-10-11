import fs from "node:fs/promises";
import { expect, it } from "vitest";
it("ships a self-contained external-worker parser", async () => {
  const source = await fs.readFile(new URL("../dist/ui-parser.cjs", import.meta.url), "utf8");
  const exports = {}, module = { exports };
  new Function("exports", "module", "self", "globalThis", source)(exports, module, undefined, undefined);
  expect(typeof (module.exports as { parseStdoutLine: unknown }).parseStdoutLine).toBe("function");
});
