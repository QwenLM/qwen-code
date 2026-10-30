/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const TARGETS = new Map([
  ['darwin-arm64', ['Darwin', 'aarch64']],
  ['darwin-x64', ['Darwin', 'x86_64']],
  ['linux-arm64', ['Linux', 'aarch64']],
  ['linux-x64', ['Linux', 'x86_64']],
]);

export function copyManagedLocalRuntime({
  destination,
  serverJar,
  jreHome,
  version,
  target,
  runtime,
}) {
  const expected = TARGETS.get(target);
  if (!expected || runtime !== 'node') {
    throw new Error(
      'Managed local packages require native Linux/macOS and the Node runtime.',
    );
  }
  let javaVersion;
  if (jreHome) {
    const release = fs.readFileSync(path.join(jreHome, 'release'), 'utf8');
    const field = (name) =>
      release.match(new RegExp(`^${name}="([^"]+)"$`, 'm'))?.[1];
    javaVersion = field('JAVA_VERSION');
    const architecture = field('OS_ARCH');
    if (
      !/^21(?:[.\-+]|$)/u.test(javaVersion ?? '') ||
      field('OS_NAME') !== expected[0] ||
      (architecture !== expected[1] &&
        !(expected[1] === 'x86_64' && architecture === 'amd64'))
    ) {
      throw new Error(`Managed JRE must be Java 21 for ${target}.`);
    }
    for (const required of ['bin/java', 'lib/modules', 'legal']) {
      if (!fs.existsSync(path.join(jreHome, required))) {
        throw new Error(
          `Managed JRE is missing ${required}; include the complete runtime and licenses.`,
        );
      }
    }
  }
  const jarBytes = fs.readFileSync(serverJar);
  if (jarBytes.subarray(0, 4).toString('hex') !== '504b0304') {
    throw new Error(
      'Managed server input must be the packaged Spring Boot JAR.',
    );
  }
  fs.mkdirSync(destination, { recursive: true });
  fs.copyFileSync(serverJar, path.join(destination, 'server.jar'));
  if (jreHome) {
    fs.cpSync(jreHome, path.join(destination, 'jre'), {
      recursive: true,
      dereference: true,
      // Node's native recursive copy can preserve links despite dereference.
      // A filter selects the JavaScript traversal that follows them.
      filter: () => true,
    });
  }
  const manifest = {
    schemaVersion: 1,
    cliVersion: version,
    target,
    javaMajor: 21,
    javaSource: jreHome ? 'bundled' : 'system',
    javaVersion,
    serverSha256: crypto.createHash('sha256').update(jarBytes).digest('hex'),
  };
  fs.writeFileSync(
    path.join(destination, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}
