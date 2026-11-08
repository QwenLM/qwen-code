/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync, spawn } from 'node:child_process';
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
// the packaging size guard, an apt error, a killed process. BuildKit puts the
// actionable failure on stderr, so the fixture does too.
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
      `  awk 'BEGIN{for(i=0;i<40000;i++) print "PAD-LINE-" i}'`,
      `  echo "${FAILURE_MARKER}" >&2`,
      '  [ "$FAKE_DOCKER_PAUSE" = "true" ] && sleep 1',
      '  exit 1',
      'fi',
      'exit 0',
      '',
    ].join('\n'),
  );
  chmodSync(fakeDocker, 0o755);
}

function buildSandboxEnv(env) {
  return {
    ...process.env,
    PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH}`,
    QWEN_SANDBOX: 'docker',
    VERBOSE: '',
    CI: '',
    ...env,
  };
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
        env: buildSandboxEnv(env),
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
      const blockStart = combined.indexOf('--- last 200 lines of');
      const blockEnd = combined.indexOf('--- end of build output');
      const block = combined.slice(blockStart, blockEnd);

      expect(status).not.toBe(0);
      expect(blockStart).not.toBe(-1);
      expect(blockEnd).toBeGreaterThan(blockStart);
      expect(block).toContain(FAILURE_MARKER);
      expect(block).not.toContain('PAD-LINE-0\n');
      expect(combined.split(FAILURE_MARKER)).toHaveLength(2);
    });

    it('streams the build output under CI without waiting for a failure', async () => {
      const child = spawn(process.execPath, [scriptPath, '-s', '--no-prune'], {
        cwd: repoRoot,
        env: buildSandboxEnv({ CI: 'true', FAKE_DOCKER_PAUSE: 'true' }),
      });
      let combined = '';
      let markOutputSeen;
      const outputSeen = new Promise((resolve) => {
        markOutputSeen = resolve;
      });
      for (const stream of [child.stdout, child.stderr]) {
        stream.on('data', (chunk) => {
          combined += chunk.toString();
          if (combined.includes(FAILURE_MARKER)) markOutputSeen();
        });
      }
      const closed = new Promise((resolve) => {
        child.once('close', (status) => resolve(status ?? 1));
      });

      expect(await Promise.race([outputSeen, closed])).toBeUndefined();
      const status = await closed;
      expect(status).not.toBe(0);
      expect(combined).toContain(FAILURE_MARKER);
      // Streamed output is not re-printed from a capture buffer.
      expect(combined).not.toContain('end of build output');
    });

    it('streams the build output under VERBOSE', () => {
      const { status, stdout, stderr } = runBuildSandbox({ VERBOSE: 'true' });
      const combined = `${stdout}${stderr}`;

      expect(status).not.toBe(0);
      expect(combined).toContain(FAILURE_MARKER);
      expect(combined).not.toContain('end of build output');
    });
  },
);
