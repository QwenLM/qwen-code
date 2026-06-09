/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFile } from 'node:fs/promises';
import { expect, test } from 'vitest';

const WORKFLOW = '.github/workflows/qwen-code-pr-review.yml';

test('PR review workflow runs on Windows with a bash-compatible command wrapper', async () => {
  const workflow = await readFile(WORKFLOW, 'utf8');

  expect(workflow).toContain(
    "runs-on: ['self-hosted', 'windows', 'x64', 'ecs-qwen']",
  );
  expect(workflow).toContain("default: '90'");
  expect(workflow).toContain('timeout-minutes: 90');
  expect(workflow).toContain("github.event.inputs.timeout_minutes || '90'");
  expect(workflow).toContain(
    'timeout_minutes must not exceed the 90 minute job timeout',
  );
  expect(workflow).toContain(
    "${{ github.event_name == 'workflow_dispatch' && github.ref || github.event.repository.default_branch }}",
  );
  expect(workflow).toContain('shell: bash');
  expect(workflow).toContain("shell: 'powershell'");
  expect(workflow).toContain("$gitBash = 'C:\\Program Files\\Git\\bin'");
  expect(workflow).toContain('$gitBash | Out-File -FilePath $env:GITHUB_PATH');
  expect(workflow).toContain("GH_VERSION: '2.93.0'");
  expect(workflow).toContain(
    "GH_WINDOWS_AMD64_SHA256: '77aa01ed7317295ad550de0ad04f3f276b1ef0e9272e3d002ac28dd99853d211'",
  );
  expect(workflow).toContain(
    'https://github.com/cli/cli/releases/download/v${env:GH_VERSION}/$asset',
  );
  expect(workflow).toContain('Get-FileHash -Path $zipPath -Algorithm SHA256');
  expect(workflow).toContain(
    'Get-ChildItem -Path $installRoot -Recurse -Filter gh.exe -File',
  );
  expect(workflow).not.toContain("cache: 'npm'");
  expect(workflow).toContain("QWEN_CLI_PACKAGE: '@qwen-code/qwen-code'");
  expect(workflow).toContain(
    'QWEN_CLI_VERSION: "${{ vars.QWEN_PR_REVIEW_CLI_VERSION || \'0.17.1\' }}"',
  );
  expect(workflow).toContain(
    'npm install -g "${QWEN_CLI_PACKAGE}@${QWEN_CLI_VERSION}"',
  );
  expect(workflow).toContain('qwen --version');
  expect(workflow).not.toContain('npm ci still running...');
  expect(workflow).not.toContain('QWEN_BIN="${RUNNER_TEMP}/qwen-bin"');
  expect(workflow).not.toContain(
    'exec node "$GITHUB_WORKSPACE/dist/cli.js" "$@"',
  );
  expect(workflow).toContain('git worktree remove --force "$review_path"');
  expect(workflow).toContain('git branch -D "qwen-review/pr-${PR_NUMBER}"');
  expect(workflow).toContain("MSYSTEM: 'MINGW64'");
  expect(workflow).toContain('QWEN_TIMEOUT=$((TIMEOUT_MINUTES - 10))');
  expect(workflow).toContain('node scripts/run-qwen-pr-review.js');
  expect(workflow).toContain('-- qwen \\');
  expect(workflow).toContain('--quiet');
  expect(workflow).toContain('--heartbeat-seconds 15');
  expect(workflow).not.toContain('timeout --kill-after');
  expect(workflow).not.toContain('PIPESTATUS');
});
