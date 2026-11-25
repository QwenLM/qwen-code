/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { isPowerShellReadOnly } from '../shell-permissions/powerShellPermissions.js';
vi.mock('../shell-permissions/powerShellPermissions.js', () => ({
  isPowerShellReadOnly: vi.fn(),
  checkPowerShellPermission: vi.fn().mockResolvedValue({ kind: 'allow' }),
}));
import { PermissionModes, type ToolCheckContext } from '../../permissions/manager/decision/index.js';
import { buildForkCheckerMap } from './fork-restrictions.js';
import type { ToolPermissionReason } from './checker-reasons.js';
import type { HostToolChecker } from './rule-precedence.js';
import {
  EDIT_TOOL_NAME,
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  NOTEBOOK_EDIT_TOOL_NAME,
  READ_FILE_TOOL_NAME,
  SHELL_TOOL_NAME,
  POWERSHELL_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
} from '../tool-names.js';

const CWD = '/repo';
const MEMORY_DIR = '/user/.qwen/projects/project/memory';

function context(): ToolCheckContext<ToolPermissionReason> {
  return {
    mode: PermissionModes.Default,
    rules: { allow: {}, deny: {}, ask: {} },
    cwd: CWD,
    additionalDirectories: [],
    rulesForTool: {
      toolLevel: { allow: {}, deny: {}, ask: {} },
      toolDetailLevel: { allow: {}, deny: {}, ask: {} },
    },
    toolUseId: 'call-1',
  };
}

async function check(
  map: Map<string, HostToolChecker>,
  toolName: string,
  input: Record<string, unknown>,
) {
  const checker = map.get(toolName);
  if (!checker) {
    return { kind: 'absent' as const };
  }
  return checker.check(input, context());
}

describe('buildForkCheckerMap — dream-shaped fork', () => {
  const map = buildForkCheckerMap({
    unrestrictedRead: true,
    readOnlyShell: true,
    writeDirectory: MEMORY_DIR,
  });

  it('refuses every tool it does not list', async () => {
    expect(await check(map, 'Agent', {})).toEqual({ kind: 'absent' });
    expect(await check(map, 'WebFetch', {})).toEqual({ kind: 'absent' });
    expect(await check(map, 'Workflow', {})).toEqual({ kind: 'absent' });
    expect(await check(map, NOTEBOOK_EDIT_TOOL_NAME, {})).toEqual({
      kind: 'absent',
    });
  });

  it('lists reading, searching, shell and writing', () => {
    for (const name of [
      READ_FILE_TOOL_NAME,
      GLOB_TOOL_NAME,
      GREP_TOOL_NAME,
      SHELL_TOOL_NAME,
      POWERSHELL_TOOL_NAME,
      WRITE_FILE_TOOL_NAME,
      EDIT_TOOL_NAME,
    ]) {
      expect(map.has(name)).toBe(true);
    }
  });

  it('denies a shell command that is not read-only', async () => {
    const result = await check(map, SHELL_TOOL_NAME, { command: 'rm -rf /' });

    expect(result.kind).toBe('deny');
  });

  it('enforces the PowerShell read-only classifier in restricted forks', async () => {
    vi.mocked(isPowerShellReadOnly).mockResolvedValueOnce(false);
    expect(
      (await check(map, POWERSHELL_TOOL_NAME, { command: 'Remove-Item file' }))
        .kind,
    ).toBe('deny');
    vi.mocked(isPowerShellReadOnly).mockResolvedValueOnce(true);
    expect(
      (await check(map, POWERSHELL_TOOL_NAME, { command: 'Get-Content file' }))
        .kind,
    ).toBe('allow');
  });

  it('denies a shell call that names no command', async () => {
    const result = await check(map, SHELL_TOOL_NAME, {});

    expect(result.kind).toBe('deny');
  });

  it('allows Read, Glob and Grep outside the workspace', async () => {
    await expect(
      check(map, READ_FILE_TOOL_NAME, {
        file_path: '/outside/transcript.jsonl',
      }),
    ).resolves.toMatchObject({ kind: 'allow' });
    await expect(
      check(map, GLOB_TOOL_NAME, { pattern: '*.jsonl', path: '/outside' }),
    ).resolves.toMatchObject({ kind: 'allow' });
    await expect(
      check(map, GREP_TOOL_NAME, { pattern: 'needle', path: '/outside' }),
    ).resolves.toMatchObject({ kind: 'allow' });
  });

  it('allows a read-only shell command outside the workspace', async () => {
    const result = await check(map, SHELL_TOOL_NAME, {
      command: 'ls -la /outside',
    });

    expect(result).toMatchObject({
      kind: 'allow',
      extra: { decisionPoint: 'fork.shell.read_only.allow' },
    });
  });

  it('denies a write outside the memory directory', async () => {
    const result = await check(map, WRITE_FILE_TOOL_NAME, {
      file_path: '/repo/src/index.ts',
      content: 'x',
    });

    expect(result.kind).toBe('deny');
  });

  it('denies an edit outside the memory directory', async () => {
    const result = await check(map, EDIT_TOOL_NAME, {
      file_path: '/repo/src/index.ts',
      old_string: 'x',
      new_string: 'y',
    });

    expect(result.kind).toBe('deny');
  });

  it('denies a write that escapes the directory by traversal', async () => {
    const result = await check(map, WRITE_FILE_TOOL_NAME, {
      file_path: `${MEMORY_DIR}/../../../etc/passwd`,
      content: 'x',
    });

    expect(result.kind).toBe('deny');
  });

  it('allows Write and Edit inside the memory directory', async () => {
    await expect(
      check(map, WRITE_FILE_TOOL_NAME, {
        file_path: `${MEMORY_DIR}/notes.md`,
        content: 'x',
      }),
    ).resolves.toMatchObject({ kind: 'allow' });
    await expect(
      check(map, EDIT_TOOL_NAME, {
        file_path: `${MEMORY_DIR}/notes.md`,
        old_string: 'x',
        new_string: 'y',
      }),
    ).resolves.toMatchObject({ kind: 'allow' });
  });
});

describe('buildForkCheckerMap — fork-owned rules', () => {
  it('keeps an explicit fork-owned deny for an unrestricted read tool', async () => {
    const map = buildForkCheckerMap({ unrestrictedRead: true });
    const checker = map.get(READ_FILE_TOOL_NAME);

    const result = await checker!.check(
      { file_path: '/outside/transcript.jsonl' },
      {
        ...context(),
        rules: {
          allow: {},
          deny: { session: [READ_FILE_TOOL_NAME] },
          ask: {},
        },
        rulesForTool: {
          toolLevel: {
            allow: {},
            deny: {
              session: [
                {
                  source: 'session',
                  ruleBehavior: 'deny',
                  ruleValue: { toolName: READ_FILE_TOOL_NAME },
                },
              ],
            },
            ask: {},
          },
          toolDetailLevel: { allow: {}, deny: {}, ask: {} },
        },
      },
    );

    expect(result.kind).toBe('deny');
  });

  it('honours a fork-owned deny for a permitted write path', async () => {
    const map = buildForkCheckerMap({ writeDirectory: MEMORY_DIR });
    const checker = map.get(WRITE_FILE_TOOL_NAME);

    const result = await checker!.check(
      { file_path: `${MEMORY_DIR}/notes.md`, content: 'x' },
      {
        ...context(),
        rules: {
          allow: {},
          deny: { session: [WRITE_FILE_TOOL_NAME] },
          ask: {},
        },
        rulesForTool: {
          toolLevel: {
            allow: {},
            deny: {
              session: [
                {
                  source: 'session',
                  ruleBehavior: 'deny',
                  ruleValue: { toolName: WRITE_FILE_TOOL_NAME },
                },
              ],
            },
            ask: {},
          },
          toolDetailLevel: { allow: {}, deny: {}, ask: {} },
        },
      },
    );

    expect(result.kind).toBe('deny');
  });
});

describe('fork injected paths', () => {
  it('uses injected paths inside confinement without widening its roots', async () => {
    const map = buildForkCheckerMap({
      readWriteDirectories: ['/runtime/inside'],
      internalPaths: {
        resolve: () => ({ projectStorageDir: '/runtime' }),
      },
    });
    for (const name of [READ_FILE_TOOL_NAME, WRITE_FILE_TOOL_NAME]) {
      expect(
        (await check(map, name, { file_path: '/runtime/inside/file.txt' }))
          .kind,
      ).toBe('allow');
      expect(
        (await check(map, name, { file_path: '/runtime/outside/file.txt' }))
          .kind,
      ).toBe('deny');
    }
  });
});
