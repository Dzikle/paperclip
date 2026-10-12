import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
const source = path.join(root, "src/migrations");
const names = readdirSync(source).filter(name => name.endsWith(".sql")).sort();
if (!names.length) throw new Error("No SQL migration assets found");
// Preflight every input so a missing source cannot erase the last good output.
const inputs = names.map(name => readFileSync(path.join(source, name)));
const journal = readFileSync(path.join(source, "meta/_journal.json"));
// The only recursive removal is the package's generated migration directory.
// Reject linked parents/targets before resolving or removing that exact path.
for (const relative of ["dist", "dist/migrations"]) {
  try {
    if (lstatSync(path.join(root, relative)).isSymbolicLink()) throw new Error(`Refusing linked build output: ${relative}`);
  } catch (error) { if (error.code !== "ENOENT") throw error; }
}
const output = path.resolve(root, "dist/migrations");
if (!output.startsWith(root + path.sep)) throw new Error("Build output escapes package root");
rmSync(output, { recursive: true, force: true });
mkdirSync(path.join(output, "meta"), { recursive: true });
names.forEach((name, index) => writeFileSync(path.join(output, name), inputs[index]));
writeFileSync(path.join(output, "meta/_journal.json"), journal);
