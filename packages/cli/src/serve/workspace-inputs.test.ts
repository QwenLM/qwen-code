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
  MAX_REGISTERED_WORKSPACES,
  resolveMaxRegisteredWorkspaces,
  resolveSingleWorkspaceInput,
  resolveWorkspaceInputs,
} from './workspace-inputs.js';

vi.mock('@qwen-code/acp-bridge/channelControlTimeouts', () => ({
  MAX_DAEMON_WORKSPACES: 7,
}));

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

  it('rejects distinct non-nested explicit workspaces for single-workspace callers', () => {
    const root = makeScratch();
    const primary = path.join(root, 'primary');
    const secondary = path.join(root, 'secondary');
    fs.mkdirSync(primary);
    fs.mkdirSync(secondary);

    expect(() => resolveSingleWorkspaceInput([primary, secondary])).toThrow(
      MultipleWorkspaceInputError,
    );
  });

  it('lets single-workspace callers reject multiple inputs even if early canonicalization fails', async () => {
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

describe('resolveWorkspaceInputs', () => {
  it('keeps registration independent of the legacy channel-control capacity', () => {
    expect(MAX_REGISTERED_WORKSPACES).toBe(256);
  });

  it('keeps distinct non-nested explicit workspaces in input order', () => {
    const root = makeScratch();
    const primary = path.join(root, 'primary');
    const secondary = path.join(root, 'secondary');
    fs.mkdirSync(primary);
    fs.mkdirSync(secondary);

    expect(resolveWorkspaceInputs([primary, secondary])).toEqual([
      primary,
      secondary,
    ]);
  });

  it('still rejects duplicate and nested explicit workspaces', () => {
    const root = makeScratch();
    const parent = path.join(root, 'parent');
    const child = path.join(parent, 'child');
    fs.mkdirSync(child, { recursive: true });

    expect(() => resolveWorkspaceInputs([parent, parent])).toThrow(
      DuplicateWorkspaceInputError,
    );
    expect(() => resolveWorkspaceInputs([parent, child])).toThrow(
      NestedWorkspaceInputError,
    );
  });
});

describe('resolveMaxRegisteredWorkspaces', () => {
  it('defaults to 256 and lets an explicit option override even invalid environment', () => {
    expect(resolveMaxRegisteredWorkspaces(undefined, {})).toBe(256);
    expect(
      resolveMaxRegisteredWorkspaces(2, {
        QWEN_SERVE_MAX_WORKSPACES: 'invalid',
      }),
    ).toBe(2);
  });
  it.each(['1', '25', '26', '256', ' 00256 '])(
    'accepts decimal capacity %s',
    (raw) => {
      expect(
        resolveMaxRegisteredWorkspaces(undefined, {
          QWEN_SERVE_MAX_WORKSPACES: raw,
        }),
      ).toBe(Number(raw));
    },
  );
  it.each([
    '',
    ' ',
    '0',
    '-1',
    '1.5',
    '1e2',
    '0x10',
    'NaN',
    'Infinity',
    '257',
    '+2',
  ])('rejects invalid environment %j', (raw) => {
    expect(() =>
      resolveMaxRegisteredWorkspaces(undefined, {
        QWEN_SERVE_MAX_WORKSPACES: raw,
      }),
    ).toThrow(/QWEN_SERVE_MAX_WORKSPACES/);
  });
  it.each([0, -1, 1.5, NaN, Infinity, 257])(
    'rejects invalid option %s',
    (value) => {
      expect(() => resolveMaxRegisteredWorkspaces(value, {})).toThrow(
        /integer from 1 to 256/,
      );
    },
  );
  it('names the configuration source that supplied the invalid value', () => {
    expect(() =>
      resolveMaxRegisteredWorkspaces(undefined, {
        QWEN_SERVE_MAX_WORKSPACES: ' abc ',
      }),
    ).toThrow('Invalid QWEN_SERVE_MAX_WORKSPACES=" abc "');
    expect(() => resolveMaxRegisteredWorkspaces(300, {})).toThrow(
      'Invalid maxRegisteredWorkspaces option 300',
    );
    expect(() => resolveMaxRegisteredWorkspaces(300, {})).not.toThrow(
      /QWEN_SERVE_MAX_WORKSPACES/,
    );
  });
});
