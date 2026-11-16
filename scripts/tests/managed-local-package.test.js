/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'vitest';
import { copyManagedLocalRuntime } from '../managed-local-package.js';

let temporary;
let options;
beforeEach(() => {
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-package-'));
  const jreHome = path.join(temporary, 'jre');
  fs.mkdirSync(path.join(jreHome, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(jreHome, 'lib'));
  fs.mkdirSync(path.join(jreHome, 'legal'));
  fs.writeFileSync(
    path.join(jreHome, 'release'),
    'JAVA_VERSION="21.0.12"\nOS_NAME="Darwin"\nOS_ARCH="aarch64"\n',
  );
  fs.writeFileSync(path.join(jreHome, 'bin/java'), 'test runtime', {
    mode: 0o755,
  });
  fs.writeFileSync(path.join(jreHome, 'lib/modules'), 'modules');
  fs.writeFileSync(path.join(jreHome, 'legal/LICENSE'), 'license');
  if (process.platform === 'win32') {
    fs.copyFileSync(
      path.join(jreHome, 'legal/LICENSE'),
      path.join(jreHome, 'legal/COPYING'),
    );
  } else {
    fs.symlinkSync('LICENSE', path.join(jreHome, 'legal/COPYING'));
  }
  const serverJar = path.join(temporary, 'server.jar');
  fs.writeFileSync(serverJar, Buffer.from('504b03040000', 'hex'));
  options = {
    destination: path.join(temporary, 'package', 'lib', 'managed-runtime'),
    jreHome,
    serverJar,
    version: '0.25.3',
    target: 'darwin-arm64',
    runtime: 'node',
  };
});
afterEach(() => fs.rmSync(temporary, { recursive: true, force: true }));

test('packages the complete JRE and server with version, target and digest', () => {
  const manifest = copyManagedLocalRuntime(options);
  const output = options.destination;
  assert.equal(manifest.cliVersion, options.version);
  assert.equal(manifest.target, options.target);
  assert.match(manifest.serverSha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(output, 'manifest.json'))),
    manifest,
  );
  assert.equal(
    fs.readFileSync(path.join(output, 'jre/legal/LICENSE'), 'utf8'),
    'license',
  );
  assert.equal(
    fs.lstatSync(path.join(output, 'jre/legal/COPYING')).isSymbolicLink(),
    false,
  );
  assert.equal(
    fs.readFileSync(path.join(output, 'jre/legal/COPYING'), 'utf8'),
    'license',
  );
  assert.equal(
    fs.statSync(path.join(output, 'jre/bin/java')).mode & 0o777,
    0o755,
  );
});

test('rejects incompatible target, Java, and missing runtime licenses', () => {
  assert.throws(
    () => copyManagedLocalRuntime({ ...options, target: 'linux-x64' }),
    /Java 21 for linux-x64/u,
  );
  assert.throws(
    () => copyManagedLocalRuntime({ ...options, runtime: 'bun' }),
    /Node runtime/u,
  );
  assert.throws(
    () => copyManagedLocalRuntime({ ...options, target: 'win-x64' }),
    /native Linux/u,
  );
  fs.rmSync(path.join(options.jreHome, 'legal'), { recursive: true });
  assert.throws(
    () => copyManagedLocalRuntime(options),
    /complete runtime and licenses/u,
  );
});
