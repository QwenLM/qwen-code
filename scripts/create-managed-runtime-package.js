/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { copyManagedLocalRuntime } from './managed-local-package.js';

const { values } = parseArgs({
  options: {
    target: { type: 'string' },
    'server-jar': { type: 'string' },
    'jre-home': { type: 'string' },
    'without-jre': { type: 'boolean' },
    'out-dir': { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

if (values.help) {
  console.log(
    'Usage: npm run package:managed-runtime -- --target TARGET --server-jar PATH (--jre-home DIR | --without-jre) [--out-dir DIR]\n' +
      'Packages the server JAR and manifest, optionally with Java 21. Reuses an installed matching Qwen CLI.\n' +
      '--without-jre builds a lite archive requiring local Java 21.\n' +
      'Targets: darwin-arm64, darwin-x64, linux-arm64, linux-x64.\n' +
      'Default output: packages/managed-agent-server/target/managed-runtime.',
  );
} else {
  for (const option of ['target', 'server-jar']) {
    if (!values[option]) throw new Error(`--${option} is required.`);
  }
  if (Boolean(values['jre-home']) === Boolean(values['without-jre'])) {
    throw new Error('Provide exactly one of --jre-home DIR or --without-jre.');
  }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const { version } = JSON.parse(
    fs.readFileSync(path.join(root, 'package.json'), 'utf8'),
  );
  const target = values.target;
  const outDir = path.resolve(
    values['out-dir'] ??
      path.join(
        root,
        'packages',
        'managed-agent-server',
        'target',
        'managed-runtime',
      ),
  );
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'qwen-managed-runtime-'),
  );
  try {
    copyManagedLocalRuntime({
      destination: path.join(temporary, 'managed-runtime', version, target),
      serverJar: path.resolve(values['server-jar']),
      jreHome: values['jre-home']
        ? path.resolve(values['jre-home'])
        : undefined,
      version,
      target,
      runtime: 'node',
    });
    fs.mkdirSync(outDir, { recursive: true });
    const name = `qwen-code-managed-runtime-${values['without-jre'] ? 'lite-' : ''}${target}.tar.gz`;
    const archive = path.join(outDir, name);
    execFileSync('tar', ['-czf', archive, '-C', temporary, 'managed-runtime'], {
      stdio: 'inherit',
      env: { ...process.env, COPYFILE_DISABLE: '1' },
    });
    const digest = createHash('sha256');
    for await (const chunk of fs.createReadStream(archive))
      digest.update(chunk);
    fs.writeFileSync(`${archive}.sha256`, `${digest.digest('hex')}  ${name}\n`);
    console.log(`Created ${archive}\nCreated ${archive}.sha256`);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
