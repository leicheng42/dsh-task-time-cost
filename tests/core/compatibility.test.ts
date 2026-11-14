import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import semver from 'semver';

const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
// DSH app-boot evaluates engines.dsh with includePrerelease:true. npm peer
// resolution also needs to admit the individual rc releases without that option.
test('DSH admission accepts the supported release family and excludes older and next-minor APIs', () => {
  assert.equal(semver.satisfies('0.2.2-rc.3', '0.2.2-rc.2', { includePrerelease: true }), false, 'reproduce 0.3.0 installation rejection');
  for (const version of ['0.2.2-rc.1', '0.2.2-rc.2', '0.2.2-rc.3', '0.2.2-rc.10', '0.2.2', '0.2.3', '0.2.99']) {
    assert.equal(semver.satisfies(version, manifest.engines.dsh, { includePrerelease: true }), true, version);
  }
  for (const version of ['0.2.1', '0.2.2-alpha.3', '0.3.0-alpha.1', '0.3.0', '1.0.0']) {
    assert.equal(semver.satisfies(version, manifest.engines.dsh, { includePrerelease: true }), false, version);
  }
});

test('npm protocol peers admit rc.1 through rc.3 and compatible stable patches', () => {
  const range = manifest.peerDependencies['@deepseek-ai/dsh-typert-protocol'];
  for (const version of ['0.2.2-rc.1', '0.2.2-rc.2', '0.2.2-rc.3', '0.2.2', '0.2.3']) assert.equal(semver.satisfies(version, range), true, version);
  assert.equal(semver.satisfies('0.3.0', range), false);
});

test('bundle declares the three supported Node Host platforms', () => {
  assert.deepEqual([...manifest.dsh.bundle.platforms].sort(), ['darwin', 'linux', 'win32']);
  assert.equal(manifest.dsh.client.platform, 'web', 'the shared browser Client is independent of Host OS');
});
