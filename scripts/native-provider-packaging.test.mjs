import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { registerNativeAdapters } from './register-native-provider-adapters.ts';
import { assertIntegrity, NATIVE_CLI_PINS } from './install-pinned-native-runtimes.mjs';

test('pinned tarball integrity rejects mismatches before installation', () => {
  assert.throws(() => assertIntegrity(Buffer.from('not-a-package'), NATIVE_CLI_PINS[0].integrity), /native_package_integrity_mismatch/);
});
test('registration validates ALL compiled packages before preserving/updating the existing store', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aif-native-packaging-'));
  try {
    const entries = [['cline-local','cline_local'],['commandcode-local','commandcode_local']];
    for (const [name, type] of entries) {
      const dir = path.join(root, 'packages', 'adapters', name);
      await fs.mkdir(path.join(dir,'dist'), {recursive:true});
      await fs.writeFile(path.join(dir,'package.json'), JSON.stringify({name:`@aif/adapter-${name}`,version:'0.1.0',type:'module'}));
      await fs.writeFile(path.join(dir,'dist','index.js'), `export function createServerAdapter(){return {type:${JSON.stringify(type)}}}`);
      await fs.writeFile(path.join(dir,'dist','ui-parser.cjs'), 'module.exports = {}');
    }
    const unrelated = {type:'existing',packageName:'existing',installedAt:'old'};
    const records = [unrelated];
    const store = {listAdapterPlugins:()=>records, addAdapterPlugin:record=>records.push(record)};
    await registerNativeAdapters({root,store});
    assert.equal(records.length,3); assert.equal(records[0],unrelated);
    await registerNativeAdapters({root,store}); assert.equal(records.length,3);
    records[2].packageName='unexpected';
    await assert.rejects(registerNativeAdapters({root,store}), /native_plugin_registration_conflict/);
    assert.equal(records.length,3);
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});
test('Docker source keeps candidate CLIs and baseline tools exact and does not register at startup', async () => {
  const docker = await fs.readFile(new URL('../Dockerfile',import.meta.url),'utf8');
  assert.match(docker,/node:24\.21\.0-trixie-slim/);
  for (const pin of ['@anthropic-ai/claude-code@2.1.293','@openai/codex@0.161.0','opencode-ai@1.18.35']) assert.ok(docker.includes(pin));
  assert.ok(docker.includes('generate-native-runtime-pins.mjs'));
  const entry = await fs.readFile(new URL('./docker-entrypoint.sh',import.meta.url),'utf8');
  assert.ok(!entry.includes('register-native-provider-adapters'));
});
