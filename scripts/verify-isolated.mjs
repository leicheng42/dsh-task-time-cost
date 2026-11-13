import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve, join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const artifacts = join(root, 'artifacts');
const packageReport = JSON.parse(await readFile(join(artifacts, 'package-verification.json'), 'utf8'));
const extracted = resolve(packageReport.extracted);
assert.equal(dirname(extracted), resolve(artifacts));
assert.ok(basename(extracted).startsWith('package-check-'));
const archive = await readFile(packageReport.archive);
assert.equal(createHash('sha256').update(archive).digest('hex'), packageReport.sha256);
const tar = spawnSync('tar', ['-tzf', packageReport.archive], { encoding: 'utf8', windowsHide: true });
assert.equal(tar.status, 0, tar.error?.message ?? tar.stderr);
const files = tar.stdout.trim().split(/\r?\n/).filter(Boolean);
const installed = join(artifacts, 'isolated-dsh/profiles/estimator-verify/node_modules/dsh-task-time-cost');
let matched = 0;
for (const file of files) {
  assert.ok(file.startsWith('package/') && !file.includes('\\') && !file.split('/').includes('..'));
  const relative = file.slice('package/'.length);
  assert.deepEqual(await readFile(join(installed, relative)), await readFile(join(extracted, file)), `Installed archive mismatch: ${relative}`);
  matched++;
}
assert.equal(matched, packageReport.files);
const decode = bytes => bytes.toString(bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf16le' : 'utf8').replace(/^\uFEFF/, '').replace(/\u001b\[[0-9;]*m/g, '');
const outputs = {};
for (const name of ['isolated-enabled.yml', 'isolated-disabled.yml', 'isolated-config-schema.json']) {
  outputs[name] = decode(await readFile(join(artifacts, name)));
  await writeFile(join(artifacts, name.replace(/(\.[^.]+)$/, '.utf8$1')), outputs[name], 'utf8');
}
function entry(text) {
  const lines = text.split(/\r?\n/);
  const index = lines.findIndex(line => /^\s*- id: task-time-cost\s*$/.test(line));
  assert.ok(index >= 0, 'Estimator entry is missing from the composition');
  const indentation = /^\s*/.exec(lines[index])[0].length;
  let end = index + 1;
  while (end < lines.length && !new RegExp(`^\\s{0,${indentation}}- `).test(lines[end])) end++;
  const selected = lines.slice(index, end).join('\n');
  assert.match(selected, /name: dsh-task-time-cost\s*(?:\n|$)/);
  return selected;
}
assert.doesNotMatch(entry(outputs['isolated-enabled.yml']), /disabled: true/);
assert.match(entry(outputs['isolated-disabled.yml']), /disabled: true/);
const schema = JSON.parse(outputs['isolated-config-schema.json']);
const serialized = JSON.stringify(schema);
assert.ok(serialized.includes('"routeOverrides"') && serialized.includes('"dsh-task-time-cost"'));
const profile = JSON.parse(await readFile(join(artifacts, 'isolated-dsh/profiles/estimator-verify/package.json'), 'utf8'));
assert.ok(profile.dsh.profile.bundles.includes('dsh-task-time-cost'));
const report = {
  verifiedAt: new Date().toISOString(),
  profile: 'estimator-verify',
  archiveSha256: packageReport.sha256,
  byteMatchedFiles: matched,
  configImport: 'passed',
  enabledComposition: 'passed',
  disabledComposition: 'passed',
  boundary: 'CLI composition and installed bytes; no model task, real Client mount or historical-data uninstall acceptance.',
};
await writeFile(join(artifacts, 'isolated-verification.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
console.log(JSON.stringify(report, null, 2));
