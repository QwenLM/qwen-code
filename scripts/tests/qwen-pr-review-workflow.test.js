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
  expect(workflow).toContain("MSYSTEM: 'MINGW64'");
  expect(workflow).toContain('QWEN_TIMEOUT=$((TIMEOUT_MINUTES - 10))');
  expect(workflow).toContain('node scripts/run-qwen-pr-review.js');
  expect(workflow).not.toContain('timeout --kill-after');
  expect(workflow).not.toContain('PIPESTATUS');
});
