'use strict';
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, readFileSync, readdirSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

const [root, provenancePath, producer, sourceSha] = process.argv.slice(2);
assert.equal(process.version, 'v22.22.3');
assert.equal(process.platform, 'linux');
assert.equal(process.arch, 'x64');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const provenance = JSON.parse(readFileSync(provenancePath, 'utf8'));
assert.equal(provenance.sourceRevision, sourceSha);
assert.equal(pkg.sourceRevision, sourceSha);
assert.equal(pkg.sourceTreeSha256, provenance.sourceTreeSha256);
assert.equal(pkg.managedPreview, provenance.preview);
assert.equal(pkg.version, provenance.version);
assert.equal(pkg.bin.qwen, 'cli-entry.js');
assert.ok(['worker', 'harness'].includes(producer));
const entry = path.join(root, pkg.bin.qwen);
const home = mkdtempSync(path.join(tmpdir(), 'managed-image-smoke-'));
try {
  function invoke(args) {
    const result = spawnSync(process.execPath, [entry, ...args], {
      cwd: home,
      env: { HOME: home, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
      encoding: 'utf8', timeout: 20000, maxBuffer: 65536,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    return result;
  }
  const version = invoke(['--version']);
  assert.equal(version.status, 0);
  assert.equal(version.stdout.trim(), pkg.version);
  assert.equal(version.stderr, '');
  if (producer === 'worker') {
    const worker = invoke(['managed-runtime-worker', '--container-boot', '/dev/null']);
    assert.equal(worker.status, 1);
    assert.equal(worker.stdout, '');
    assert.equal(worker.stderr, 'Managed Runtime worker boot payload is invalid.\n');
    assert.deepEqual(readdirSync(home), []);
  } else {
    const help = invoke(['serve', '--help']);
    assert.equal(help.status, 0);
    for (const flag of ['hosted-harness', '--hostname', '--port', '--profile', '--no-web', '--require-auth', '--workspace']) {
      assert.ok(help.stdout.includes(flag), flag);
    }
  }
  console.log(`${producer}: ${pkg.version}, ${pkg.managedPreview}, ${sourceSha}, image smoke PASS`);
} finally {
  rmSync(home, { recursive: true, force: true });
}
