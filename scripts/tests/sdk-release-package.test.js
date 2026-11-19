/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { parse } from 'yaml';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  packSdk,
  validateSdkTarball,
} from '../../.github/scripts/sdk-release-package.mjs';

const dirs = [];
afterEach(() =>
  dirs
    .splice(0)
    .forEach((dir) => rmSync(dir, { recursive: true, force: true })),
);
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'sdk-release-'));
  dirs.push(root);
  mkdirSync(join(root, 'dist/cli/vendor'), { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      name: '@qwen-code/sdk',
      version: '1.2.3',
      files: ['dist'],
      exports: { '.': './dist/index.mjs' },
      scripts: { prepack: 'exit 91', prepublishOnly: 'exit 92' },
    }),
  );
  writeFileSync(join(root, 'dist/index.mjs'), 'export const sdk = true;');
  writeFileSync(join(root, 'dist/cli/cli.js'), 'selected CLI bytes');
  writeFileSync(join(root, 'dist/cli/vendor/tool'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(root, 'dist/cli/vendor/tool'), 0o755);
  writeFileSync(join(root, 'dist/BUNDLED_CLI_VERSION'), '0.26.3\n');
  return { root, out: join(root, 'handoff') };
}
it.skipIf(process.platform === 'win32')(
  'packs existing bytes without hooks, preserving CLI metadata and executable modes',
  () => {
    const { root, out } = fixture();
    packSdk(root, out, '1.2.3', '0.26.3');
    const tarball = join(out, 'sdk.tgz');
    expect(validateSdkTarball(tarball, '1.2.3', '0.26.3').name).toBe(
      '@qwen-code/sdk',
    );
    expect(
      execFileSync('tar', ['-xOf', tarball, 'package/dist/cli/cli.js'], {
        encoding: 'utf8',
      }),
    ).toBe('selected CLI bytes');
    expect(
      execFileSync('tar', ['-tvzf', tarball], { encoding: 'utf8' }),
    ).toMatch(/-rwxr-xr-x.*package\/dist\/cli\/vendor\/tool/);
    expect(() => validateSdkTarball(tarball, '1.2.4', '0.26.3')).toThrow(
      /name\/version/,
    );
    expect(() => validateSdkTarball(tarball, '1.2.3', '0.26.4')).toThrow(
      /CLI version/,
    );
  },
);
it.skipIf(process.platform === 'win32')(
  'rejects an incomplete SDK instead of handing it to the publisher',
  () => {
    const { root, out } = fixture();
    rmSync(join(root, 'dist/index.mjs'));
    expect(() => packSdk(root, out, '1.2.3', '0.26.3')).toThrow(/missing/);
  },
);

it.skipIf(process.platform === 'win32').each([
  ['same', 'false', true, 0],
  ['different', 'false', false, 0],
  ['missing', 'false', true, 1],
  ['offline', 'false', false, 0],
  ['offline', 'true', true, 1],
])(
  'SDK publication retry: %s, dry-run=%s',
  (mode, dryRun, succeeds, publishCount) => {
    const { root } = fixture();
    const bin = join(root, 'bin');
    mkdirSync(bin);
    mkdirSync(join(root, 'sdk-release'));
    const tarball = join(root, 'sdk-release/sdk.tgz');
    const bytes = Buffer.from('immutable tested package bytes');
    writeFileSync(tarball, bytes);
    const log = join(root, 'calls');
    writeFileSync(log, '');
    writeFileSync(
      join(bin, 'npm'),
      `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.NPM_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'view') {
  if (process.env.NPM_CASE === 'same') console.log(JSON.stringify(process.env.LOCAL_INTEGRITY));
  else if (process.env.NPM_CASE === 'different') console.log(JSON.stringify('sha512-different'));
  else { console.error(process.env.NPM_CASE === 'missing' ? 'npm error code E404' : 'npm error code ENOTFOUND'); process.exit(1); }
} else if (args[0] !== 'publish') process.exit(92);
`,
    );
    chmodSync(join(bin, 'npm'), 0o755);
    const workflow = parse(
      readFileSync('.github/workflows/release-sdk.yml', 'utf8'),
    );
    const publish = workflow.jobs['release-sdk'].steps.find(
      (s) => s.name === 'Publish @qwen-code/sdk',
    );
    const result = spawnSync('bash', ['-eo', 'pipefail', '-c', publish.run], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        RUNNER_TEMP: root,
        RELEASE_VERSION: '1.2.3',
        NPM_TAG: 'latest',
        DRY_RUN: dryRun,
        NPM_CASE: mode,
        LOCAL_INTEGRITY:
          'sha512-' + createHash('sha512').update(bytes).digest('base64'),
        NPM_LOG: log,
      },
    });
    expect(result.status === 0, result.stderr).toBe(succeeds);
    const calls = readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const publishes = calls.filter((args) => args[0] === 'publish');
    expect(publishes).toHaveLength(publishCount);
    for (const args of publishes) {
      expect(args[1]).toBe(tarball);
      expect(args).toContain('--ignore-scripts');
      expect(args).toContain('--provenance');
      expect(args.includes('--dry-run')).toBe(dryRun === 'true');
    }
    if (dryRun === 'true')
      expect(calls.some((args) => args[0] === 'view')).toBe(false);
    expect(readFileSync(tarball)).toEqual(bytes);
  },
);
