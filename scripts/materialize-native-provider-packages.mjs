import fs from 'node:fs/promises';
import { materializePublishManifest } from './prepare-bundled-package.mjs';
// Image-build mechanical manifest materialization. Keep existing workspace
// dependency links; select compiled exports exactly as existing publish tooling.
for (const name of ['adapter-utils','adapters/cline-local','adapters/commandcode-local']) {
  const file = new URL(`../packages/${name}/package.json`,import.meta.url);
  const manifest = JSON.parse(await fs.readFile(file,'utf8'));
  const published = materializePublishManifest(manifest);
  for (const key of ['exports','main','types']) if (published[key] !== undefined) manifest[key] = published[key];
  await fs.writeFile(file,JSON.stringify(manifest,null,2)+'\n');
}
