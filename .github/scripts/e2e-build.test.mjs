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
// Three roots, two entries sharing one of them, one negated entry: the
// script must scan every non-negated root once, not a list of its own.
const WORKSPACES = [
  'packages/*',
  'packages/channels/base',
  'integrations/*',
  'plugins/*',
  '!packages/skip',
];

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

function writeWorkspaces(root, workspaces = WORKSPACES) {
  write(root, 'package.json', JSON.stringify({ workspaces }));
}

function members(archive) {
  return spawnSync('tar', ['-tzf', archive], { encoding: 'utf8' })
    .stdout.split('\n')
    .filter(Boolean);
}

describe('e2e build archive', () => {
  let scratch;
  let built;
  let archive;

  before(() => {
    scratch = mkdtempSync(join(tmpdir(), 'e2e-build-'));
    built = join(scratch, 'built');
    archive = join(scratch, 'e2e-build.tar.gz');
    // What a built tree looks like: the bundle, workspace dist/ trees under
    // three roots and at two depths, a dist/ nested inside a dist/, and a
    // dependency's own dist/ under node_modules, which the tests never
    // resolve and must not ride along.
    writeWorkspaces(built);
    chmodSync(write(built, 'dist/cli.js', '#!/usr/bin/env node\n'), 0o755);
    write(built, 'dist/chunks/a.js');
    write(built, 'packages/core/dist/index.js');
    write(built, 'packages/core/dist/nested/dist/deep.js');
    write(built, 'packages/channels/base/dist/index.js');
    write(built, 'integrations/external-context/dist/index.js');
    write(built, 'plugins/foo/dist/index.js');
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

    const list = members(archive);
    for (const expected of [
      'e2e-build.sha',
      'dist/cli.js',
      'dist/chunks/a.js',
      'packages/core/dist/index.js',
      'packages/core/dist/nested/dist/deep.js',
      'packages/channels/base/dist/index.js',
      'integrations/external-context/dist/index.js',
      'plugins/foo/dist/index.js',
    ]) {
      // Exactly once: two workspace entries share the `packages` root, and
      // a root scanned twice would list every dist/ under it twice.
      assert.equal(
        list.filter((m) => m === expected).length,
        1,
        `expected ${expected} exactly once`,
      );
    }
    assert.ok(
      !list.some((m) => m.includes('node_modules')),
      'a dependency dist/ leaked into the archive',
    );
    assert.ok(
      !list.some((m) => m.includes('packages/core/src')),
      'sources are not build outputs',
    );
    // A dist/ nested in a dist/ is reached through its parent, not listed
    // again as its own root.
    assert.equal(
      list.filter((m) => m === 'packages/core/dist/nested/dist/deep.js').length,
      1,
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

  it('refuses to pack a tree without a bundle, and says so', () => {
    // Every root exists and holds a dist/, and dist/ itself exists: only the
    // bundle is missing, so only the cli.js gate can refuse.
    const noBundle = mkdtempSync(join(scratch, 'nobundle-'));
    writeWorkspaces(noBundle);
    write(noBundle, 'dist/chunks/a.js');
    write(noBundle, 'packages/core/dist/index.js');
    write(noBundle, 'integrations/external-context/dist/index.js');
    write(noBundle, 'plugins/foo/dist/index.js');
    const target = join(scratch, 'never-nobundle.tar.gz');
    const result = run(PACK, [target], { cwd: noBundle });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /::error::dist\/cli\.js not found/);
    assert.ok(!existsSync(target));
  });

  it('refuses to pack a tree with a bundle but no workspace dist/', () => {
    // The fail-closed under-pack contract: a find expression that matches
    // nothing must not ship an archive of just the stamp and the bundle.
    const bundleOnly = mkdtempSync(join(scratch, 'bundleonly-'));
    writeWorkspaces(bundleOnly);
    write(bundleOnly, 'dist/cli.js');
    mkdirSync(join(bundleOnly, 'packages/core/src'), { recursive: true });
    mkdirSync(join(bundleOnly, 'integrations'), { recursive: true });
    mkdirSync(join(bundleOnly, 'plugins'), { recursive: true });
    const target = join(scratch, 'never-bundleonly.tar.gz');
    const result = run(PACK, [target], { cwd: bundleOnly });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /::error::.*found no workspace dist\//);
    assert.ok(!existsSync(target));
  });

  it('refuses to pack when package.json declares no workspaces', () => {
    // Without this gate `find` runs with no path and defaults to `.`, so
    // the under-pack check counts ./dist and a stamp+bundle-only archive
    // ships silently.
    const bare = mkdtempSync(join(scratch, 'noworkspaces-'));
    writeWorkspaces(bare, []);
    write(bare, 'dist/cli.js');
    const target = join(scratch, 'never-noworkspaces.tar.gz');
    const result = run(PACK, [target], { cwd: bare });
    assert.notEqual(result.status, 0);
    assert.match(
      result.stdout,
      /::error::package\.json declares no workspaces/,
    );
    assert.ok(!existsSync(target));
  });

  it('names a workspace root that is missing on disk', () => {
    // npm installs fine with a glob whose directory is gone, and build.js
    // walks its own list, so pack is the first step that would notice —
    // as a bare `find:` error unless it checks first.
    const gone = mkdtempSync(join(scratch, 'missingroot-'));
    writeWorkspaces(gone, ['packages/*', 'missing/*']);
    write(gone, 'dist/cli.js');
    write(gone, 'packages/core/dist/index.js');
    const target = join(scratch, 'never-missingroot.tar.gz');
    const result = run(PACK, [target], { cwd: gone });
    assert.notEqual(result.status, 0);
    assert.match(
      result.stdout,
      /::error::.*workspace root 'missing' from package\.json does not exist/,
    );
    assert.ok(!existsSync(target));
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
    assert.ok(existsSync(join(leg, 'plugins/foo/dist/index.js')));
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
    assert.ok(existsSync(copy), 'a refused archive is left for inspection');
  });

  it('refuses an archive without the bundle, before extracting anything', () => {
    // Correctly stamped, so the stamp branch passes and only the bundle
    // check can refuse; it must refuse before any file lands in the tree.
    const src = mkdtempSync(join(scratch, 'bundleless-src-'));
    write(src, 'e2e-build.sha', SHA);
    write(src, 'packages/core/dist/index.js');
    const bundleless = join(scratch, 'bundleless.tar.gz');
    const packed = spawnSync(
      'tar',
      ['-czf', bundleless, 'e2e-build.sha', 'packages/core/dist'],
      { cwd: src, encoding: 'utf8' },
    );
    assert.equal(packed.status, 0, packed.stderr);

    const leg = mkdtempSync(join(scratch, 'bundleless-leg-'));
    const copy = join(leg, 'downloaded.tar.gz');
    writeFileSync(copy, readFileSync(bundleless));
    const result = run(UNPACK, [copy], { cwd: leg });
    assert.notEqual(result.status, 0);
    assert.match(
      result.stdout,
      /::error::build artifact holds no dist\/cli\.js/,
    );
    assert.ok(!existsSync(join(leg, 'packages')), 'nothing is extracted');
    assert.ok(existsSync(copy), 'a refused archive is left for inspection');
  });

  it('accepts an archive whose listing outruns a pipe buffer', () => {
    // The real archive lists ~14k members with dist/cli.js near the top. A
    // `tar -t | grep -q` check would let grep exit at that first match
    // while tar still writes; tar then dies of SIGPIPE, pipefail turns
    // that into 141, and a valid archive is refused. A few thousand
    // members with long names push the listing well past 64 KiB.
    const big = mkdtempSync(join(scratch, 'big-'));
    writeWorkspaces(big);
    write(big, 'dist/cli.js');
    mkdirSync(join(big, 'integrations'), { recursive: true });
    mkdirSync(join(big, 'plugins'), { recursive: true });
    for (let i = 0; i < 3000; i += 1) {
      write(
        big,
        `packages/big/dist/chunk-${String(i).padStart(5, '0')}-${'x'.repeat(60)}.js`,
      );
    }
    const bigArchive = join(scratch, 'big.tar.gz');
    const packed = run(PACK, [bigArchive], { cwd: big });
    assert.equal(packed.status, 0, packed.stdout + packed.stderr);
    const listing = spawnSync('tar', ['-tzf', bigArchive], {
      encoding: 'utf8',
    }).stdout;
    assert.ok(
      listing.length > 65536,
      'fixture listing must exceed a pipe buffer',
    );
    assert.ok(listing.indexOf('dist/cli.js\n') < 4096, 'bundle listed early');

    const leg = mkdtempSync(join(scratch, 'big-leg-'));
    const copy = join(leg, 'downloaded.tar.gz');
    writeFileSync(copy, readFileSync(bigArchive));
    const result = run(UNPACK, [copy], { cwd: leg });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.ok(existsSync(join(leg, 'dist/cli.js')));
    assert.ok(
      existsSync(
        join(leg, `packages/big/dist/chunk-02999-${'x'.repeat(60)}.js`),
      ),
    );
  });

  it('refuses a workspace-level cli.js standing in for the bundle', () => {
    // Correct stamp, no root dist/, but a member ending in dist/cli.js:
    // only a whole-line match may pass the pre-extraction check.
    const src = mkdtempSync(join(scratch, 'decoy-src-'));
    write(src, 'e2e-build.sha', SHA);
    write(src, 'packages/core/dist/cli.js');
    write(src, 'packages/core/dist/index.js');
    const decoy = join(scratch, 'decoy.tar.gz');
    const packed = spawnSync(
      'tar',
      ['-czf', decoy, 'e2e-build.sha', 'packages/core/dist'],
      { cwd: src, encoding: 'utf8' },
    );
    assert.equal(packed.status, 0, packed.stderr);

    const leg = mkdtempSync(join(scratch, 'decoy-leg-'));
    const copy = join(leg, 'downloaded.tar.gz');
    writeFileSync(copy, readFileSync(decoy));
    const result = run(UNPACK, [copy], { cwd: leg });
    assert.notEqual(result.status, 0);
    assert.match(
      result.stdout,
      /::error::build artifact holds no dist\/cli\.js/,
    );
    assert.ok(!existsSync(join(leg, 'packages')), 'nothing is extracted');
    assert.ok(existsSync(copy), 'a refused archive is left for inspection');
  });

  it('refuses an archive without a stamp, and says so', () => {
    const src = mkdtempSync(join(scratch, 'nostamp-src-'));
    write(src, 'dist/cli.js');
    const nostamp = join(scratch, 'nostamp.tar.gz');
    const packed = spawnSync('tar', ['-czf', nostamp, 'dist'], {
      cwd: src,
      encoding: 'utf8',
    });
    assert.equal(packed.status, 0, packed.stderr);

    const leg = mkdtempSync(join(scratch, 'nostamp-leg-'));
    const copy = join(leg, 'downloaded.tar.gz');
    writeFileSync(copy, readFileSync(nostamp));
    const result = run(UNPACK, [copy], { cwd: leg });
    assert.notEqual(result.status, 0);
    assert.match(
      result.stdout,
      /::error::cannot read the e2e-build\.sha stamp from .*downloaded\.tar\.gz — the archive is corrupt, truncated, or not one e2e-build-pack\.sh produced/,
    );
    assert.ok(!existsSync(join(leg, 'dist')), 'nothing is extracted');
    assert.ok(existsSync(copy), 'a refused archive is left for inspection');
  });

  it('names a download that never landed, apart from a bad archive', () => {
    // The download step's path and this script's argument are a string
    // pair nothing else cross-checks; a drift must read as "file missing",
    // not as a pack-side problem.
    const leg = mkdtempSync(join(scratch, 'nofile-'));
    const missing = join(leg, 'never-downloaded.tar.gz');
    const result = run(UNPACK, [missing], { cwd: leg });
    assert.notEqual(result.status, 0);
    assert.match(
      result.stdout,
      /::error::build artifact not found at .*never-downloaded\.tar\.gz — check the Download build artifact step's path/,
    );
    assert.doesNotMatch(result.stdout, /stamp/);
  });

  it('treats a directory at the archive path as a download that never landed', () => {
    // A drifted unpack argument that resolves to the download directory
    // must read as the same drift, not as a corrupt archive.
    const leg = mkdtempSync(join(scratch, 'dirpath-'));
    const dir = join(leg, 'e2e-build');
    mkdirSync(dir, { recursive: true });
    const result = run(UNPACK, [dir], { cwd: leg });
    assert.notEqual(result.status, 0);
    assert.match(
      result.stdout,
      /::error::build artifact not found at .*e2e-build — check the Download build artifact step's path/,
    );
    assert.doesNotMatch(result.stdout, /stamp/);
  });

  it("reports a download cut off before its stamp with tar's diagnostic", () => {
    // 20 bytes is a gzip header and little else: no tar can read the
    // first member from it, on either platform. There is no "cut after
    // the stamp" sibling: extracting the stamp runs the whole stream, so
    // a later cut is reported by this same branch (verified with a 60%
    // cut of the fixture and of a real 85 MB archive, GNU tar and bsdtar).
    const leg = mkdtempSync(join(scratch, 'corrupt-'));
    const copy = join(leg, 'downloaded.tar.gz');
    writeFileSync(copy, readFileSync(archive).subarray(0, 20));
    const result = run(UNPACK, [copy], { cwd: leg });
    assert.notEqual(result.status, 0);
    assert.match(
      result.stdout,
      /::error::cannot read the e2e-build\.sha stamp from .*downloaded\.tar\.gz — the archive is corrupt, truncated/,
    );
    // No `truncated` alternative: the script's own static text says
    // "corrupt, truncated", so it would match without any tar output.
    // GNU tar says "gzip: stdin: unexpected end of file", bsdtar says
    // "truncated gzip input"; both carry "gzip".
    assert.match(result.stdout, /gzip|unexpected end|Unexpected EOF/i);
    assert.ok(!existsSync(join(leg, 'dist')), 'nothing is extracted');
    assert.ok(existsSync(copy), 'a refused archive is left for inspection');
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
