import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { nativeArtifactDigest } from '../packages/adapter-utils/dist/native-runtime-artifacts.js';

// Immutable build output: exact installed CLI, compiled plugin, shared execution
// boundary and controller bytes. Missing/incompatible candidates abort image build.
const adapters = {};
for (const [type,cli,version,binary,plugin] of [
  ['cline_local','cline','3.0.70','cline','cline-local'],
  ['commandcode_local','command-code','1.79.2','commandcode','commandcode-local'],
  ['claude_local','@anthropic-ai/claude-code','2.1.293','claude','claude-local'],
]) {
  const cliRoot = `/usr/local/lib/node_modules/${cli}`;
  const installed = JSON.parse(await fs.readFile(path.join(cliRoot,'package.json'),'utf8'));
  if (installed.version !== version) throw new Error('native_runtime_pin_mismatch');
  const command = `/usr/local/bin/${binary}`;
  const executableDigest = createHash('sha256').update(await fs.readFile(await fs.realpath(command))).digest('hex');
  const pluginDist = `/app/packages/adapters/${plugin}/dist`;
  const artifacts = [];
  for (const artifactPath of [cliRoot,pluginDist,'/app/packages/adapter-utils/dist','/app/server/dist']) artifacts.push({path:artifactPath,digest:await nativeArtifactDigest(artifactPath)});
  const adapterDigest = artifacts[1].digest;
  const runtimePin = `${cli}@${version}+sha256:${createHash('sha256').update(JSON.stringify(artifacts)).digest('hex')}`;
  adapters[type] = {runtimePin,command,executableDigest,adapterDigest,artifacts};
}
await fs.mkdir('/opt/aif',{recursive:true});
await fs.writeFile('/opt/aif/native-runtime-pins.json',JSON.stringify({schemaVersion:1,adapters})+'\n',{mode:0o444});
