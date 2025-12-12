/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Unset NO_COLOR environment variable to ensure consistent theme behavior between local and CI test runs
if (process.env['NO_COLOR'] !== undefined) {
  delete process.env['NO_COLOR'];
}

import {
  mkdir,
  readdir,
  rm,
  readFile,
  writeFile,
  unlink,
} from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as os from 'node:os';

import {
  QWEN_CONFIG_DIR,
  DEFAULT_CONTEXT_FILENAME,
} from '../packages/core/src/tools/memoryTool.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const integrationTestsDir = join(rootDir, '.integration-tests');
let runDir = ''; // Make runDir accessible in teardown
let sdkE2eRunDir = ''; // SDK E2E test run directory

const memoryFilePath = join(
  os.homedir(),
  QWEN_CONFIG_DIR,
  DEFAULT_CONTEXT_FILENAME,
);
let originalMemoryContent: string | null = null;

export async function setup() {
  try {
    originalMemoryContent = await readFile(memoryFilePath, 'utf-8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw e;
    }
    // File doesn't exist, which is fine.
  }

  // Setup for CLI integration tests
  runDir = join(integrationTestsDir, `${Date.now()}`);
  await mkdir(runDir, { recursive: true });

  // Setup for SDK E2E tests (separate directory with prefix)
  sdkE2eRunDir = join(integrationTestsDir, `sdk-e2e-${Date.now()}`);
  await mkdir(sdkE2eRunDir, { recursive: true });

  // Clean up old test runs, but keep the latest few for debugging
  try {
    const testRuns = await readdir(integrationTestsDir);

    // Clean up old CLI integration test runs (without sdk-e2e- prefix)
    const cliTestRuns = testRuns.filter((run) => !run.startsWith('sdk-e2e-'));
    if (cliTestRuns.length > 5) {
      const oldRuns = cliTestRuns.sort().slice(0, cliTestRuns.length - 5);
      await Promise.all(
        oldRuns.map((oldRun) =>
          rm(join(integrationTestsDir, oldRun), {
            recursive: true,
            force: true,
          }),
        ),
      );
    }

    // Clean up old SDK E2E test runs (with sdk-e2e- prefix)
    const sdkTestRuns = testRuns.filter((run) => run.startsWith('sdk-e2e-'));
    if (sdkTestRuns.length > 5) {
      const oldRuns = sdkTestRuns.sort().slice(0, sdkTestRuns.length - 5);
      await Promise.all(
        oldRuns.map((oldRun) =>
          rm(join(integrationTestsDir, oldRun), {
            recursive: true,
            force: true,
          }),
        ),
      );
    }
  } catch (e) {
    console.error('Error cleaning up old test runs:', e);
  }

  // Environment variables for CLI integration tests
  process.env['INTEGRATION_TEST_FILE_DIR'] = runDir;
  process.env['GEMINI_CLI_INTEGRATION_TEST'] = 'true';
  process.env['TELEMETRY_LOG_FILE'] = join(runDir, 'telemetry.log');

  // Environment variables for SDK E2E tests
  process.env['E2E_TEST_FILE_DIR'] = sdkE2eRunDir;
  process.env['TEST_CLI_PATH'] = join(rootDir, 'dist/cli.js');

  if (process.env['KEEP_OUTPUT']) {
    console.log(`Keeping output for test run in: ${runDir}`);
    console.log(`Keeping output for SDK E2E test run in: ${sdkE2eRunDir}`);
  }
  process.env['VERBOSE'] = process.env['VERBOSE'] ?? 'false';

  console.log(`\nIntegration test output directory: ${runDir}`);
  console.log(`SDK E2E test output directory: ${sdkE2eRunDir}`);
  console.log(`CLI path: ${process.env['TEST_CLI_PATH']}`);
}

export async function teardown() {
  // Cleanup the CLI test run directory unless KEEP_OUTPUT is set
  if (process.env['KEEP_OUTPUT'] !== 'true' && runDir) {
    await rm(runDir, { recursive: true, force: true });
  }

  // Cleanup the SDK E2E test run directory unless KEEP_OUTPUT is set
  if (process.env['KEEP_OUTPUT'] !== 'true' && sdkE2eRunDir) {
    await rm(sdkE2eRunDir, { recursive: true, force: true });
  }

  if (originalMemoryContent !== null) {
    await mkdir(dirname(memoryFilePath), { recursive: true });
    await writeFile(memoryFilePath, originalMemoryContent, 'utf-8');
  } else {
    try {
      await unlink(memoryFilePath);
    } catch {
      // File might not exist if the test failed before creating it.
    }
  }
}
