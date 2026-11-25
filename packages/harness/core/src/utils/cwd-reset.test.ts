/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { realpathSync } from 'node:fs';
import { WorkspaceContext } from './workspaceContext.js';
import {
  getCwd,
  getOriginalCwd,
  setCwd,
  resetForTest,
  runWithCwdContext,
} from './Shell.js';
import {
  resetCwdIfOutsideWorkspace,
  stdErrAppendShellResetMessage,
} from './cwd-reset.js';

describe('stdErrAppendShellResetMessage', () => {
  beforeEach(() => {
    resetForTest('/tmp');
  });

  it('appends reset notice with originalCwd to empty stderr', () => {
    const out = stdErrAppendShellResetMessage('');
    expect(out).toBe(`\nShell cwd was reset to ${getOriginalCwd()}`);
  });

  it('appends reset notice to existing stderr (trimmed)', () => {
    const out = stdErrAppendShellResetMessage('warning: foo\n');
    expect(out).toBe(
      `warning: foo\nShell cwd was reset to ${getOriginalCwd()}`,
    );
  });
});

describe('resetCwdIfOutsideWorkspace', () => {
  let tmpRoot: string;
  let outsideDir: string;

  beforeEach(() => {
    tmpRoot = realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'cwd-reset-')),
    );
    outsideDir = realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'outside-')),
    );
    resetForTest(tmpRoot);
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  it('returns false and does not reset when CWD === originalCwd (fast path)', () => {
    const ws = new WorkspaceContext(tmpRoot, []);
    const before = getCwd();
    const reset = resetCwdIfOutsideWorkspace(ws);
    expect(reset).toBe(false);
    expect(getCwd()).toBe(before);
  });

  it('returns false and does not reset when CWD is within workspace', () => {
    const ws = new WorkspaceContext(tmpRoot, []);
    const subdir = realpathSync(fs.mkdtempSync(path.join(tmpRoot, 'sub-')));
    setCwd(subdir);
    const reset = resetCwdIfOutsideWorkspace(ws);
    expect(reset).toBe(false);
    expect(getCwd()).toBe(subdir);
  });

  it('returns true and resets CWD when outside workspace', () => {
    const ws = new WorkspaceContext(tmpRoot, []);
    const onCwdChanged = vi.fn();
    runWithCwdContext(
      { cwd: outsideDir, originalCwd: tmpRoot, onCwdChanged },
      () => {
        const reset = resetCwdIfOutsideWorkspace(ws);
        expect(reset).toBe(true);
        expect(getCwd()).toBe(tmpRoot);
      },
    );
    expect(onCwdChanged).toHaveBeenCalledExactlyOnceWith(outsideDir, tmpRoot);
  });

  it('honors additional workspace directories', () => {
    const ws = new WorkspaceContext(tmpRoot, [outsideDir]);
    setCwd(outsideDir);
    const reset = resetCwdIfOutsideWorkspace(ws);
    expect(reset).toBe(false);
    expect(getCwd()).toBe(outsideDir);
  });
});
