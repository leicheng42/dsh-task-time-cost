import assert from 'node:assert/strict';
import { readdir, readFile, writeFile, realpath } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const storage = await realpath('C:\\Users\\admin\\.dsh\\storages\\dsh_task_time_cost');
assert.equal(storage.toLowerCase(), resolve('C:\\Users\\admin\\.dsh\\storages\\dsh_task_time_cost').toLowerCase());
const beforePath = join(root, 'artifacts/desktop-retention-before.json');
const reportPath = join(root, 'artifacts/desktop-retention.json');
async function inventory(directory) {
  const result = {};
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, item.name);
    assert.ok(!item.isSymbolicLink(), 'Owned storage must not escape through a symlink');
    if (item.isDirectory()) Object.assign(result, await inventory(path));
    else if (item.isFile()) result[relative(storage, path).replaceAll('\\', '/')] = createHash('sha256').update(await readFile(path)).digest('hex');
  }
  return result;
}
const current = await inventory(storage);
const mode = process.argv[2];
if (mode === 'before') {
  assert.ok(Object.keys(current).some(key => key.startsWith('calls/')), 'Must contain actual prior metadata');
  await writeFile(beforePath, JSON.stringify(current, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify({ mode, capturedFiles: Object.keys(current).length, content: 'Hashes only; no record values.' }));
} else {
  assert.ok(mode === 'after-remove' || mode === 'after-install');
  const before = JSON.parse(await readFile(beforePath, 'utf8'));
  const missing = Object.keys(before).filter(key => current[key] === undefined);
  const changed = Object.keys(before).filter(key => current[key] !== undefined && current[key] !== before[key]);
  assert.equal(missing.length, 0, 'Uninstall/reinstall must retain prior data files');
  if (mode === 'after-remove') assert.equal(changed.length, 0, 'Uninstall must not change stored metadata');
  const priorCalls = Object.keys(before).filter(key => key.startsWith('calls/'));
  assert.ok(priorCalls.every(key => current[key] === before[key]), 'Reinstall must preserve recorded usage and prices');
  let report = {};
  if (mode === 'after-install') report = JSON.parse(await readFile(reportPath, 'utf8'));
  report[mode] = { checkedAt: new Date().toISOString(), priorFiles: Object.keys(before).length,
    missingFiles: missing.length, changedFiles: changed.length, priorCallFiles: priorCalls.length,
    callBytesPreserved: true, scope: 'Actual Desktop plugin metadata; hashes only, no exported record values.' };
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify(report, null, 2));
}
