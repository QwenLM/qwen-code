/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DuplicateWorkspaceInputError,
  MissingWorkspaceInputError,
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
  });

  it('rejects an explicit empty workspace array', () => {
    expect(() => resolveSingleWorkspaceInput([])).toThrow(
      MissingWorkspaceInputError,
    );
  });

  it('rejects duplicate canonical explicit workspaces', () => {
    const root = makeScratch();
    const workspace = fs.realpathSync(path.join(root));

    expect(() => resolveSingleWorkspaceInput([workspace, workspace])).toThrow(
      DuplicateWorkspaceInputError,
    );
  });

  it('rejects nested explicit workspaces in either order', () => {
    const root = makeScratch();
    const parent = path.join(root, 'parent');
    const child = path.join(parent, 'child');
    const dotPrefixedChild = path.join(parent, '..foo');
    fs.mkdirSync(child, { recursive: true });
    fs.mkdirSync(dotPrefixedChild);

    expect(() => resolveSingleWorkspaceInput([parent, child])).toThrow(
      NestedWorkspaceInputError,
    );
    expect(() => resolveSingleWorkspaceInput([child, parent])).toThrow(
      NestedWorkspaceInputError,
    );
    expect(() =>
      resolveSingleWorkspaceInput([parent, dotPrefixedChild]),
    ).toThrow(NestedWorkspaceInputError);
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

  it('keeps canonicalization failures on the gated multi-workspace error path', async () => {
    const canonicalizationError = Object.assign(
      new Error('permission denied'),
      { code: 'EACCES' },
    );
    vi.resetModules();
    vi.doMock('@qwen-code/acp-bridge/workspacePaths', () => ({
      canonicalizeWorkspace: (workspace: string) => {
        if (workspace === '/inaccessible') {
          throw canonicalizationError;
        }
        return workspace;
      },
    }));
    try {
      const { MultipleWorkspaceInputError, resolveSingleWorkspaceInput } =
        await import('./workspace-inputs.js');

      expect(() =>
        resolveSingleWorkspaceInput(['/inaccessible', '/other']),
      ).toThrow(MultipleWorkspaceInputError);
    } finally {
      vi.doUnmock('@qwen-code/acp-bridge/workspacePaths');
      vi.resetModules();
    }
  });
});
