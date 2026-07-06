/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DuplicateWorkspaceInputError,
  MultipleWorkspaceInputError,
  NestedWorkspaceInputError,
  resolveSingleWorkspaceInput,
} from './workspace-inputs.js';

let scratch: string | undefined;

function makeScratch(): string {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'qws-workspaces-'));
  return scratch;
}

afterEach(() => {
  if (scratch) {
    fs.rmSync(scratch, { recursive: true, force: true });
    scratch = undefined;
  }
});

describe('resolveSingleWorkspaceInput', () => {
  it('preserves single-workspace inputs', () => {
    expect(resolveSingleWorkspaceInput('/repo/primary')).toBe('/repo/primary');
    expect(resolveSingleWorkspaceInput(['/repo/primary'])).toBe(
      '/repo/primary',
    );
  });

  it('falls back to process.cwd() when no workspace is supplied', () => {
    expect(resolveSingleWorkspaceInput(undefined)).toBe(process.cwd());
    expect(resolveSingleWorkspaceInput([])).toBe(process.cwd());
  });

  it('rejects duplicate canonical explicit workspaces', () => {
    const root = makeScratch();
    const workspace = fs.realpathSync(path.join(root));

    expect(() => resolveSingleWorkspaceInput([workspace, workspace])).toThrow(
      DuplicateWorkspaceInputError,
    );
  });

  it('rejects nested explicit workspaces', () => {
    const root = makeScratch();
    const parent = path.join(root, 'parent');
    const child = path.join(parent, 'child');
    fs.mkdirSync(child, { recursive: true });

    expect(() => resolveSingleWorkspaceInput([parent, child])).toThrow(
      NestedWorkspaceInputError,
    );
  });

  it('rejects distinct non-nested explicit workspaces while Phase 2a is gated', () => {
    const root = makeScratch();
    const primary = path.join(root, 'primary');
    const secondary = path.join(root, 'secondary');
    fs.mkdirSync(primary);
    fs.mkdirSync(secondary);

    expect(() => resolveSingleWorkspaceInput([primary, secondary])).toThrow(
      MultipleWorkspaceInputError,
    );
  });
});
