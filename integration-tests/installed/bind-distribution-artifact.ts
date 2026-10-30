/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkout, sha } from './npm-distribution-fixture.js';

const [directory, destination, ...extra] = process.argv.slice(2);
assert.ok(
  directory && destination && extra.length === 0,
  'usage: bind-distribution-artifact.ts artifactDir outReceipt',
);
const artifactDir = fs.realpathSync(directory);
const output = path.resolve(destination);
assert.equal(
  fs.existsSync(output),
  false,
  'never overwrite an artifact receipt',
);
const canonicalPath = path.join(artifactDir, 'AUDITED-ARTIFACT.json');
const canonicalHash = sha(canonicalPath);
const canonical = JSON.parse(fs.readFileSync(canonicalPath, 'utf8')) as {
  source: { head: string; diff: string };
  tarball: { path: string; sha256: string; bytes: number };
  files: { path: string; sha256: string };
};
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
assert.deepEqual(
  canonical.source,
  checkout(root),
  'canonical artifact belongs to this exact checkout',
);
assert.equal(typeof canonical.tarball.path, 'string');
assert.equal(typeof canonical.files.path, 'string');
assert.equal(path.isAbsolute(canonical.tarball.path), true);
assert.equal(path.isAbsolute(canonical.files.path), true);
assert.match(canonical.tarball.sha256, /^[0-9a-f]{64}$/);
assert.match(canonical.files.sha256, /^[0-9a-f]{64}$/);
assert.ok(
  Number.isSafeInteger(canonical.tarball.bytes) && canonical.tarball.bytes > 0,
);
const tarball = fs.realpathSync(
  path.join(artifactDir, 'tarballs', path.basename(canonical.tarball.path)),
);
const files = fs.realpathSync(
  path.join(artifactDir, path.basename(canonical.files.path)),
);
assert.equal(sha(tarball), canonical.tarball.sha256, 'downloaded tarball hash');
assert.equal(
  fs.statSync(tarball).size,
  canonical.tarball.bytes,
  'downloaded tarball bytes',
);
assert.equal(
  sha(files),
  canonical.files.sha256,
  'downloaded published-file map hash',
);
const bound = {
  ...canonical,
  tarball: { ...canonical.tarball, path: tarball },
  files: { ...canonical.files, path: files },
};
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify(bound, null, 2) + '\n', { flag: 'wx' });
assert.equal(
  sha(canonicalPath),
  canonicalHash,
  'canonical receipt remains unchanged',
);
