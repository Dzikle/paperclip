import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
const names = ["LICENSE", "PROVENANCE.md"];
// Read all required inputs before changing any existing build output.
const inputs = names.map(name => readFileSync(path.join(root, "src/cliplab", name)));
for (const relative of ["dist", "dist/cliplab", ...names.map(name => `dist/cliplab/${name}`)]) {
  try {
    if (lstatSync(path.join(root, relative)).isSymbolicLink()) throw new Error(`Refusing linked build output: ${relative}`);
  } catch (error) { if (error.code !== "ENOENT") throw error; }
}
const output = path.join(root, "dist/cliplab");
mkdirSync(output, { recursive: true });
names.forEach((name, index) => writeFileSync(path.join(output, name), inputs[index]));
