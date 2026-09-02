/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const scriptPath = path.join(repoRoot, 'scripts', 'build_sandbox.js');

// The marker stands in for whatever the Dockerfile prints before it fails —
// the packaging size guard, an apt error, a killed process. The script must
// put it in front of the operator either way.
const FAILURE_MARKER = 'FAKE-DOCKER-BUILD-FAILURE-MARKER';

let fakeBinDir;

/**
 * Installs a `docker` on PATH that echoes a marker and exits non-zero for
 * `build`, and succeeds for everything else (`image prune`, version probes).
 */
function installFakeDocker() {
  const fakeDocker = path.join(fakeBinDir, 'docker');
  writeFileSync(
    fakeDocker,
    [
      '#!/bin/sh',
      'if [ "$1" = "build" ]; then',
      `  echo "${FAILURE_MARKER}"`,
      '  echo "ERROR: process did not complete successfully: exit code: 1" >&2',
      '  exit 1',
      'fi',
      'exit 0',
      '',
    ].join('\n'),
  );
  chmodSync(fakeDocker, 0o755);
}

/** Runs build_sandbox.js with the fake docker, never throwing on failure. */
function runBuildSandbox(env) {
  try {
    const stdout = execFileSync(
      process.execPath,
      [scriptPath, '-s', '--no-prune'],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH}`,
          QWEN_SANDBOX: 'docker',
          VERBOSE: '',
          CI: '',
          ...env,
        },
      },
    );
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    return {
      status: err.status ?? 1,
      stdout: err.stdout?.toString() ?? '',
      stderr: err.stderr?.toString() ?? '',
    };
  }
}

describe.skipIf(os.platform() === 'win32')(
  'build_sandbox.js image build output',
  () => {
    beforeEach(() => {
      fakeBinDir = mkdtempSync(path.join(os.tmpdir(), 'qwen-fake-docker-'));
      installFakeDocker();
    });

    afterEach(() => {
      rmSync(fakeBinDir, { recursive: true, force: true });
    });

    it('prints the captured build output when a quiet build fails', () => {
      const { status, stdout, stderr } = runBuildSandbox({});
      const combined = `${stdout}${stderr}`;

      expect(status).not.toBe(0);
      // Without this the failure is an execSync stack trace with
      // `stdout: null`, and the only way to learn why the build failed is to
      // run the whole thing again by hand.
      expect(combined).toContain(FAILURE_MARKER);
      expect(combined).toContain(
        'ERROR: process did not complete successfully',
      );
    });

    it('streams the build output under CI without waiting for a failure', () => {
      const { status, stdout, stderr } = runBuildSandbox({ CI: 'true' });
      const combined = `${stdout}${stderr}`;

      expect(status).not.toBe(0);
      expect(combined).toContain(FAILURE_MARKER);
      // Streamed output is not re-printed from a capture buffer.
      expect(combined).not.toContain('end of build output');
    });
  },
);
