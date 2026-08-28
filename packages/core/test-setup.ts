/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll } from 'vitest';
import { setSimulate429 } from './src/utils/testUtils.js';

// Unset NO_COLOR environment variable to ensure consistent theme behavior between local and CI test runs
if (process.env['NO_COLOR'] !== undefined) {
  delete process.env['NO_COLOR'];
}

// Avoid writing per-session debug log files during tests.
// Unit tests can opt-in by overriding this env var.
if (process.env['QWEN_DEBUG_LOG_FILE'] === undefined) {
  process.env['QWEN_DEBUG_LOG_FILE'] = '0';
}

function isInsidePath(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

function getTestHomeBase(originalHome: string | undefined): string | undefined {
  const candidates =
    process.platform === 'win32'
      ? [
          os.tmpdir(),
          process.env['SystemRoot']
            ? path.join(process.env['SystemRoot'], 'Temp')
            : undefined,
        ]
      : [os.tmpdir(), '/tmp'];

  for (const candidate of candidates) {
    if (!candidate || !existsSync(candidate)) continue;
    if (originalHome && isInsidePath(originalHome, candidate)) continue;
    return candidate;
  }
  return undefined;
}

const originalHome = process.env['HOME'];
const originalUserProfile = process.env['USERPROFILE'];
const originalQwenHome = process.env['QWEN_HOME'];
const testHomeBase =
  process.env['QWEN_RUNTIME_DIR'] === undefined
    ? getTestHomeBase(originalHome ?? originalUserProfile)
    : undefined;
const testHomeDir =
  testHomeBase === undefined
    ? undefined
    : mkdtempSync(path.join(testHomeBase, 'qwen-code-core-test-home-'));

if (testHomeDir !== undefined) {
  process.env['QWEN_CODE_TEST_ORIGINAL_HOME'] =
    originalHome ?? originalUserProfile ?? '';
  delete process.env['QWEN_HOME'];
  process.env['HOME'] = testHomeDir;
  process.env['USERPROFILE'] = testHomeDir;
  afterAll(() => {
    if (originalHome === undefined) {
      delete process.env['HOME'];
    } else {
      process.env['HOME'] = originalHome;
    }
    if (originalUserProfile === undefined) {
      delete process.env['USERPROFILE'];
    } else {
      process.env['USERPROFILE'] = originalUserProfile;
    }
    if (originalQwenHome === undefined) {
      delete process.env['QWEN_HOME'];
    } else {
      process.env['QWEN_HOME'] = originalQwenHome;
    }
    delete process.env['QWEN_CODE_TEST_ORIGINAL_HOME'];
    rmSync(testHomeDir, { recursive: true, force: true });
  });
}

// Disable 429 simulation globally for all tests
setSimulate429(false);

// Some dependencies (e.g., undici) expect a global File constructor in Node.
// Provide a minimal shim for test environment if missing.
if (typeof (globalThis as unknown as { File?: unknown }).File === 'undefined') {
  (globalThis as unknown as { File: unknown }).File = class {} as unknown;
}
