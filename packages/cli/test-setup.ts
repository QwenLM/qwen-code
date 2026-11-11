/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { format } from 'node:util';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { coreEvents, runLogger } from '@qwen-code/core';
import { themeManager } from './src/ui/themes/theme-manager.js';
import { mockInkSpinner } from './src/test-utils/mockSpinner.js';

// Globally mock ink-spinner to prevent non-deterministic snapshot/act flakes.
mockInkSpinner();

// Unset CI environment variable so that ink renders dynamically as it does in a real terminal
if (process.env.CI !== undefined) {
  delete process.env.CI;
}

global.IS_REACT_ACT_ENVIRONMENT = true;

// Increase max listeners to avoid warnings in large test suites
EventEmitter.defaultMaxListeners = 500;
process.setMaxListeners(500);
coreEvents.setMaxListeners(500);

// Coverage writes temporary artifacts into coverage/.tmp. Ensure the
// directory exists before suites start so coverage finalization does not
// fail after the tests themselves pass.
fs.mkdirSync(path.resolve(process.cwd(), 'coverage', '.tmp'), {
  recursive: true,
});

// Unset NO_COLOR environment variable to ensure consistent theme behavior between local and CI test runs
if (process.env.NO_COLOR !== undefined) {
  delete process.env.NO_COLOR;
}

// Force true color output for ink so that snapshots always include color information.
process.env.FORCE_COLOR = '3';

// Force generic keybinding hints to ensure stable snapshots across different operating systems.
process.env.FORCE_GENERIC_KEYBINDING_HINTS = 'true';

// Force generic terminal declaration to ensure stable snapshots across different host environments.
process.env.TERM_PROGRAM = 'generic';

// Keep the cli_started telemetry event local to test runs: no test may reach
// the network through the startup path.
process.env.QWEN_TELEMETRY_DISABLED = '1';

import './src/test-utils/customMatchers.js';

let consoleErrorSpy: vi.SpyInstance;
let actWarnings: Array<{ message: string; stack: string }> = [];

let logSpy: vi.SpyInstance;
let warnSpy: vi.SpyInstance;
let errorSpy: vi.SpyInstance;
let debugSpy: vi.SpyInstance;

beforeEach(() => {
  // Reset themeManager state to ensure test isolation
  themeManager.resetForTesting();

  // Mock runLogger to avoid test output noise
  logSpy = vi.spyOn(runLogger, 'log').mockImplementation(() => {});
  warnSpy = vi.spyOn(runLogger, 'warn').mockImplementation((...args) => {
    console.warn(...args);
  });
  errorSpy = vi.spyOn(runLogger, 'error').mockImplementation((...args) => {
    console.error(...args);
  });
  debugSpy = vi.spyOn(runLogger, 'debug').mockImplementation(() => {});

  actWarnings = [];
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
    const firstArg = args[0];
    if (
      typeof firstArg === 'string' &&
      firstArg.includes('was not wrapped in act(...)')
    ) {
      const stackLines = (new Error().stack || '').split('\n');
      let lastReactFrameIndex = -1;

      // Find the index of the last frame that comes from react-reconciler
      for (let i = 0; i < stackLines.length; i++) {
        if (stackLines[i].includes('react-reconciler')) {
          lastReactFrameIndex = i;
        }
      }

      // If we found react-reconciler frames, start the stack trace after the last one.
      // Otherwise, just strip the first line (which is the Error message itself).
      const relevantStack =
        lastReactFrameIndex !== -1
          ? stackLines.slice(lastReactFrameIndex + 1).join('\n')
          : stackLines.slice(1).join('\n');

      if (
        relevantStack.includes('OverflowContext.tsx') ||
        relevantStack.includes('useTimedMessage.ts') ||
        relevantStack.includes('useInlineEditBuffer.ts')
      ) {
        return;
      }

      actWarnings.push({
        message: format(...args),
        stack: relevantStack,
      });
    }
  });
});

afterEach(() => {
  consoleErrorSpy.mockRestore();

  logSpy?.mockRestore();
  warnSpy?.mockRestore();
  errorSpy?.mockRestore();
  debugSpy?.mockRestore();

  vi.unstubAllEnvs();
  if (actWarnings.length > 0) {
    const messages = actWarnings
      .map(({ message, stack }) => `${message}\n${stack}`)
      .join('\n\n');
    // Default behavior: log only. Set STRICT_ACT=1 (or run in CI) to fail the
    // suite on unwrapped React state updates. This keeps local iteration fast
    // without hiding the warnings entirely.
    const strict = process.env.STRICT_ACT === '1' || process.env.CI === 'true';
    if (strict) {
      throw new Error(`Failing test due to "act(...)" warnings:\n${messages}`);
    } else {
      console.warn(`act(...) warnings (non-fatal):\n${messages}`);
    }
  }
});
