/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(
  '.github/workflows/update-ecs-runner-qwen.yml',
  'utf8',
);

function step(name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = workflow.match(
    new RegExp(
      `\\n\\s+- name:\\s*(['"])${escaped}\\1[\\s\\S]*?(?=\\n\\s+- name:\\s*['"]|\\n\\s{2}[a-zA-Z0-9_-]+:|$)`,
    ),
  );
  return match?.[0] ?? '';
}

// The body of a step's `run: |-` block, dedented to column zero.
function stepBody(name) {
  const body = step(name).match(/run: \|-\n([\s\S]*)$/)?.[1] ?? '';
  return body.replace(/^ {10}/gm, '');
}

// Runs the 'Resolve version' step body against a stubbed `npm` that 404s for
// its first `failures` invocations and then reports `version`.
function runResolve({ failures = 0, version = '0.22.3', env = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ecs-update-'));
  try {
    const counter = join(dir, 'attempts');
    const npmStub = join(dir, 'npm');
    writeFileSync(
      npmStub,
      [
        '#!/usr/bin/env bash',
        `attempt=$(( $(cat ${counter} 2>/dev/null || echo 0) + 1 ))`,
        `echo "$attempt" > ${counter}`,
        `if (( attempt <= ${failures} )); then`,
        '  echo "npm error code E404" >&2',
        '  echo "npm error 404 No match found for version" >&2',
        '  exit 1',
        'fi',
        `echo '${version}'`,
      ].join('\n'),
      { mode: 0o755 },
    );
    chmodSync(npmStub, 0o755);

    const script = join(dir, 'resolve.sh');
    writeFileSync(script, stepBody('Resolve version'));
    const ghOutput = join(dir, 'github-output');
    writeFileSync(ghOutput, '');

    const result = spawnSync('bash', [script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH ?? ''}`,
        GITHUB_OUTPUT: ghOutput,
        INPUT_VERSION: '0.22.3',
        RESOLVE_TIMEOUT_SECONDS: '60',
        RESOLVE_INTERVAL_SECONDS: '0',
        ...env,
      },
    });
    return {
      status: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      output: readFileSync(ghOutput, 'utf8'),
      attempts: Number(readFileSync(counter, 'utf8').trim()),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('ECS runner qwen update workflow', () => {
  it('installs without the selected runner npm prefix', () => {
    expect(workflow).toContain('cd "${RUNNER_TEMP:?}"');
    expect(workflow).toContain('sudo env -u NPM_CONFIG_PREFIX npm install -g');
  });

  it('runs only when this workflow changes on main', () => {
    expect(workflow).toContain(
      "  push:\n    branches: ['main']\n    paths: ['.github/workflows/update-ecs-runner-qwen.yml']",
    );
  });

  it('annotates a retry and a terminal failure distinctly', () => {
    // The final attempt must not log a "retrying" warning that never
    // retries; a sustained failure ends with an explicit exhausted error.
    expect(workflow).toContain(
      'echo "::warning::npm install attempt ${attempt} failed; retrying"',
    );
    expect(workflow).toContain(
      'echo "::error::npm install of @qwen-code/qwen-code@${VERSION} failed after 3 attempts"',
    );
    expect(workflow).toContain('for attempt in 1 2 3; do');
    expect(workflow).toContain('if [[ "${attempt}" -lt 3 ]]; then');
    expect(workflow).toContain('sudo rm -rf "${PKG_DIR}"/.qwen-code-*');
  });

  it('resolves once on a hosted runner and feeds every pool', () => {
    // One resolution shared by the matrix is what keeps pools that start
    // hours apart from installing different versions; it also keeps the
    // registry wait off the ECS runners.
    expect(workflow).toContain("    runs-on: 'ubuntu-latest'");
    expect(workflow).toContain(
      "      version: '${{ steps.version.outputs.version }}'",
    );
    expect(workflow).toContain("    needs: 'resolve'");
    // Both consumers read the job output; a leftover step reference would
    // silently expand to an empty version and install `@qwen-code/qwen-code@`.
    const consumers = workflow.match(
      /VERSION: '\$\{\{ needs\.resolve\.outputs\.version \}\}'/g,
    );
    expect(consumers).toHaveLength(2);
    expect(workflow).not.toContain(
      "VERSION: '${{ steps.version.outputs.version }}'",
    );
  });

  it('waits out npm publish propagation instead of failing the race', () => {
    // `npm publish --provenance` returns before the version is resolvable
    // (~16 minutes for v0.22.3), and release.yml dispatches this workflow as
    // soon as it returns.
    const resolved = runResolve({ failures: 3 });
    expect(resolved.status).toBe(0);
    expect(resolved.attempts).toBe(4);
    expect(resolved.output.trim()).toBe('version=0.22.3');
    expect(resolved.stdout).toContain('is not on the registry yet');
    // The per-attempt 404 noise stays out of the log on the happy path.
    expect(resolved.stderr).not.toContain('E404');
  });

  it('fails with the registry error once the wait budget is spent', () => {
    const resolved = runResolve({
      failures: 99,
      env: { RESOLVE_TIMEOUT_SECONDS: '0' },
    });
    expect(resolved.status).toBe(1);
    expect(resolved.output.trim()).toBe('');
    // The suppressed stderr is replayed, so the log still says *why*.
    expect(resolved.stderr).toContain('npm error code E404');
    // The annotation stays on stdout, where Actions parses workflow commands.
    expect(resolved.stdout).toContain(
      "::error::No published qwen version matches '0.22.3' after 0s.",
    );
  });

  it('resolves the latest dist-tag when dispatched without a version', () => {
    const resolved = runResolve({ env: { INPUT_VERSION: '' } });
    expect(resolved.status).toBe(0);
    expect(resolved.output.trim()).toBe('version=0.22.3');
  });
});
