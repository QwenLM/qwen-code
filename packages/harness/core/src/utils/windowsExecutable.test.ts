/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { isWindowsShellScriptWrapper } from './windowsExecutable.js';

describe('isWindowsShellScriptWrapper', () => {
  it.each([
    'C:\\scoop\\shims\\bash.cmd',
    'C:\\tools\\bash.BAT',
    'C:\\tools\\bash.ps1',
    'C:\\tools\\bash.cmd. ',
  ])('rejects %s', (candidate) => {
    expect(isWindowsShellScriptWrapper(candidate)).toBe(true);
  });

  it.each([
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\msys64\\usr\\bin\\bash',
  ])('accepts %s', (candidate) => {
    expect(isWindowsShellScriptWrapper(candidate)).toBe(false);
  });
});
