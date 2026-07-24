/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Request } from 'express';
import { resolveContainedCwd } from './workspace-route-runtime.js';

function fakeReq(cwd?: unknown): Request {
  return { query: cwd !== undefined ? { cwd } : {} } as Request;
}

describe('resolveContainedCwd', () => {
  let workspace: string;
  let outside: string;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-'));
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('returns workspaceCwd when cwd is absent', () => {
    expect(resolveContainedCwd(fakeReq(), workspace)).toBe(workspace);
  });

  it('returns workspaceCwd when cwd is an empty string', () => {
    expect(resolveContainedCwd(fakeReq(''), workspace)).toBe(workspace);
  });

  it('returns workspaceCwd when cwd is not a string (array)', () => {
    expect(resolveContainedCwd(fakeReq(['a', 'b']), workspace)).toBe(workspace);
  });

  it('returns the resolved path for a valid subdirectory', () => {
    const sub = path.join(workspace, 'sub');
    fs.mkdirSync(sub);
    expect(resolveContainedCwd(fakeReq(sub), workspace)).toBe(sub);
  });

  it('accepts the workspace root itself', () => {
    expect(resolveContainedCwd(fakeReq(workspace), workspace)).toBe(workspace);
  });

  it('returns workspaceCwd for a path outside the workspace', () => {
    expect(resolveContainedCwd(fakeReq(outside), workspace)).toBe(workspace);
  });

  it('returns workspaceCwd for a symlink escaping the workspace', () => {
    const link = path.join(workspace, 'link');
    fs.symlinkSync(outside, link);
    expect(resolveContainedCwd(fakeReq(link), workspace)).toBe(workspace);
  });

  it('returns workspaceCwd when the path does not exist', () => {
    const missing = path.join(workspace, 'missing');
    expect(resolveContainedCwd(fakeReq(missing), workspace)).toBe(workspace);
  });
});
