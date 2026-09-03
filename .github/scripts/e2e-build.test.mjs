import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const PACK = fileURLToPath(new URL('./e2e-build-pack.sh', import.meta.url));
const UNPACK = fileURLToPath(new URL('./e2e-build-unpack.sh', import.meta.url));
const SHA = 'a'.repeat(40);

function run(script, args, { cwd, env = {} }) {
  return spawnSync('bash', [script, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GITHUB_SHA: SHA, ...env },
  });
}

function write(root, rel, content = '') {
  const path = join(root, rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
  return path;
}

describe('e2e build archive', () => {
  let scratch;
  let built;
  let archive;

  before(() => {
    scratch = mkdtempSync(join(tmpdir(), 'e2e-build-'));
    built = join(scratch, 'built');
    archive = join(scratch, 'e2e-build.tar.gz');
    // What a built tree looks like: the bundle, workspace dist/ trees at
    // two depths, and a dependency's own dist/ under node_modules, which
    // the tests never resolve and must not ride along.
    chmodSync(write(built, 'dist/cli.js', '#!/usr/bin/env node\n'), 0o755);
    write(built, 'dist/chunks/a.js');
    write(built, 'packages/core/dist/index.js');
    write(built, 'packages/channels/base/dist/index.js');
    write(built, 'integrations/external-context/dist/index.js');
    write(built, 'packages/core/node_modules/dep/dist/dep.js');
    write(built, 'packages/core/src/index.ts');
  });

  after(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it('packs the bundle, every workspace dist/, and the commit stamp', () => {
    const result = run(PACK, [archive], { cwd: built });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(existsSync(archive));

    const listing = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8' });
    const members = listing.stdout.split('\n').filter(Boolean);
    for (const expected of [
      'e2e-build.sha',
      'dist/cli.js',
      'dist/chunks/a.js',
      'packages/core/dist/index.js',
      'packages/channels/base/dist/index.js',
      'integrations/external-context/dist/index.js',
    ]) {
      assert.ok(members.includes(expected), `missing ${expected}`);
    }
    assert.ok(
      !members.some((m) => m.includes('node_modules')),
      'a dependency dist/ leaked into the archive',
    );
    assert.ok(
      !members.some((m) => m.includes('packages/core/src')),
      'sources are not build outputs',
    );
    const stamp = spawnSync('tar', ['-xzOf', archive, 'e2e-build.sha'], {
      encoding: 'utf8',
    });
    assert.equal(stamp.stdout, SHA);
    assert.ok(
      !existsSync(join(built, 'e2e-build.sha')),
      'the stamp lives in the archive, not in the tree',
    );
  });

  it('refuses to pack a tree without a bundle', () => {
    const empty = mkdtempSync(join(scratch, 'empty-'));
    const result = run(PACK, [join(scratch, 'never.tar.gz')], { cwd: empty });
    assert.notEqual(result.status, 0);
    assert.ok(!existsSync(join(scratch, 'never.tar.gz')));
  });

  it('unpacks into a fresh tree, keeping file modes', () => {
    const leg = mkdtempSync(join(scratch, 'leg-'));
    const copy = join(leg, 'downloaded.tar.gz');
    writeFileSync(copy, readFileSync(archive));

    const result = run(UNPACK, [copy], { cwd: leg });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(existsSync(join(leg, 'dist/cli.js')));
    assert.ok(existsSync(join(leg, 'packages/core/dist/index.js')));
    assert.ok(
      existsSync(join(leg, 'integrations/external-context/dist/index.js')),
    );
    assert.ok(!existsSync(join(leg, 'packages/core/node_modules')));
    assert.equal(statSync(join(leg, 'dist/cli.js')).mode & 0o111, 0o111);
    assert.ok(!existsSync(copy), 'the downloaded archive is removed after use');
    assert.ok(
      !existsSync(join(leg, 'e2e-build.sha')),
      'the stamp is checked, not extracted',
    );
  });

  it('refuses an archive stamped with another commit', () => {
    const leg = mkdtempSync(join(scratch, 'stale-'));
    const copy = join(leg, 'downloaded.tar.gz');
    writeFileSync(copy, readFileSync(archive));

    const result = run(UNPACK, [copy], {
      cwd: leg,
      env: { GITHUB_SHA: 'b'.repeat(40) },
    });
    assert.notEqual(result.status, 0);
    assert.match(
      result.stdout,
      /::error::build artifact was produced from a{40}, not b{40}/,
    );
    assert.ok(!existsSync(join(leg, 'dist/cli.js')), 'nothing is extracted');
  });

  it('requires the commit to compare against', () => {
    const leg = mkdtempSync(join(scratch, 'nosha-'));
    const copy = join(leg, 'downloaded.tar.gz');
    writeFileSync(copy, readFileSync(archive));
    const result = spawnSync('bash', [UNPACK, copy], {
      cwd: leg,
      encoding: 'utf8',
      env: { ...process.env, GITHUB_SHA: '' },
    });
    assert.notEqual(result.status, 0);
    assert.ok(!existsSync(join(leg, 'dist/cli.js')));
  });
});
