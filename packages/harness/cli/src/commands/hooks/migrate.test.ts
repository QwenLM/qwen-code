/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { resolveCommandSettings as loadSettings } from '../../config/createCliSettingsService.js';
vi.mock('../../config/createCliSettingsService.js', () => ({
  resolveCommandSettings: vi.fn(),
}));
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type Mock,
  type MockInstance,
} from 'vitest';
import * as fs from 'node:fs';
import { SettingScope } from '../../config/settings.js';
import { runLogger, CONFIG_DIR } from '@qwen-code/core';
import { createMigrateCommand, handleMigrateFromClaude } from './migrate.js';
import { exitCli } from '../../utils/exitCli.js';

vi.mock('node:fs');
vi.mock('../../utils/exitCli.js', () => ({
  exitCli: vi.fn(),
}));

vi.mock('../../config/settings.js', async () => {
  const actual = await vi.importActual('../../config/settings.js');
  return {
    ...actual,
    loadSettings: vi.fn(),
  };
});

const mockedLoadSettings = loadSettings as Mock;
const mockedFs = vi.mocked(fs);

describe('migrate command', () => {
  let mockSetValue: Mock;
  let mockMutateScope: Mock;
  let debugLoggerLogSpy: MockInstance;
  let debugLoggerErrorSpy: MockInstance;
  let originalCwd: () => string;

  beforeEach(() => {
    vi.resetAllMocks();

    mockSetValue = vi.fn();
    mockMutateScope = vi.fn((_scope, mutation) => {
      const hooks: Record<string, unknown> = {};
      mutation({
        set: (path: string[], value: unknown) => {
          hooks[path[1]] = value;
        },
      });
      mockSetValue(SettingScope.Project, 'hooks', hooks);
      return true;
    });
    debugLoggerLogSpy = vi.spyOn(runLogger, 'log').mockImplementation(() => {});
    debugLoggerErrorSpy = vi
      .spyOn(runLogger, 'error')
      .mockImplementation(() => {});

    // Mock process.cwd()
    originalCwd = process.cwd;
    process.cwd = vi.fn(() => '/test/project');

    mockedLoadSettings.mockReturnValue({
      merged: {
        hooks: {},
      },
      setValue: mockSetValue,
      mutateScope: mockMutateScope,
      project: { path: `/test/project/${CONFIG_DIR}` },
    });
  });

  afterEach(() => {
    process.cwd = originalCwd;
    vi.restoreAllMocks();
  });

  it.each([
    {
      name: '保存成功',
      source: '{"hooks":{"PreToolUse":[]}}',
      exists: true,
      saved: true,
      code: 0,
    },
    {
      name: '保存失败',
      source: '{"hooks":{"PreToolUse":[]}}',
      exists: true,
      saved: false,
      code: 1,
    },
    {
      name: '没有待迁移内容',
      source: '{}',
      exists: true,
      saved: true,
      code: 0,
    },
    { name: '源文件不存在', source: '{}', exists: false, saved: true, code: 1 },
    {
      name: '源文件解析失败',
      source: '{bad',
      exists: true,
      saved: true,
      code: 1,
    },
  ])('$name 时退出码反映真实结果', async ({ source, exists, saved, code }) => {
    mockedFs.existsSync.mockReturnValue(exists);
    mockedFs.readFileSync.mockReturnValue(source);
    mockMutateScope.mockReturnValue(saved);

    await createMigrateCommand().parseAsync(['--from-claude'], {
      from: 'user',
    });

    expect(exitCli).toHaveBeenCalledWith(code);
    if (code !== 0) {
      expect(debugLoggerLogSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('Migration complete!'),
      );
    }
  });

  it('should log error when no Claude settings files exist', async () => {
    mockedFs.existsSync.mockReturnValue(false);

    await handleMigrateFromClaude();

    expect(debugLoggerErrorSpy).toHaveBeenCalledWith(
      'No Claude Code settings found in .claude directory. Expected settings.json or settings.local.json',
    );
    expect(mockSetValue).not.toHaveBeenCalled();
  });

  it('should migrate hooks from settings.json when it exists', async () => {
    const claudeSettings = {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Edit',
            hooks: [
              {
                type: 'command',
                command: 'echo "Before Edit"',
                timeout: 30,
              },
            ],
          },
        ],
      },
    };

    mockedFs.existsSync.mockImplementation((path) =>
      path.toString().endsWith('settings.json'),
    );

    mockedFs.readFileSync.mockReturnValue(JSON.stringify(claudeSettings));

    await handleMigrateFromClaude();

    expect(mockSetValue).toHaveBeenCalledWith(
      SettingScope.Project,
      'hooks',
      expect.objectContaining({
        PreToolUse: expect.arrayContaining([
          expect.objectContaining({
            matcher: 'Edit',
            hooks: expect.arrayContaining([
              expect.objectContaining({
                command: 'echo "Before Edit"',
                type: 'command',
                timeout: 30,
              }),
            ]),
          }),
        ]),
      }),
    );

    expect(debugLoggerLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('Found Claude Code settings'),
    );
    expect(debugLoggerLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('Migrating 1 hook event'),
    );
    expect(debugLoggerLogSpy).toHaveBeenCalledWith(
      `✓ Hooks successfully migrated to ${CONFIG_DIR}/settings.json`,
    );
  });

  it('should prefer settings.local.json over settings.json', async () => {
    const localSettings = {
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: 'command',
                command: 'echo "Local session start"',
              },
            ],
          },
        ],
      },
    };

    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(localSettings));

    await handleMigrateFromClaude();

    expect(mockedFs.readFileSync).toHaveBeenCalledWith(
      expect.stringContaining('settings.local.json'),
      'utf-8',
    );
    expect(mockSetValue).toHaveBeenCalledWith(
      SettingScope.Project,
      'hooks',
      expect.objectContaining({
        SessionStart: expect.any(Array),
      }),
    );
  });

  it('should migrate all supported event types', async () => {
    const claudeSettings = {
      hooks: {
        PreToolUse: [{ hooks: [{ type: 'command', command: 'echo 1' }] }],
        PostToolUse: [{ hooks: [{ type: 'command', command: 'echo 2' }] }],
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo 3' }] }],
        Stop: [{ hooks: [{ type: 'command', command: 'echo 4' }] }],
        SubAgentStop: [{ hooks: [{ type: 'command', command: 'echo 5' }] }],
        SessionStart: [{ hooks: [{ type: 'command', command: 'echo 6' }] }],
        SessionEnd: [{ hooks: [{ type: 'command', command: 'echo 7' }] }],
        PreCompact: [{ hooks: [{ type: 'command', command: 'echo 8' }] }],
        Notification: [{ hooks: [{ type: 'command', command: 'echo 9' }] }],
      },
    };

    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(claudeSettings));

    await handleMigrateFromClaude();

    const migratedHooks = mockSetValue.mock.calls[0][2];

    expect(migratedHooks).toHaveProperty('PreToolUse');
    expect(migratedHooks).toHaveProperty('PostToolUse');
    expect(migratedHooks).toHaveProperty('UserPromptSubmit');
    expect(migratedHooks).toHaveProperty('Stop');
    expect(migratedHooks).toHaveProperty('SubAgentStop');
    expect(migratedHooks).toHaveProperty('SessionStart');
    expect(migratedHooks).toHaveProperty('SessionEnd');
    expect(migratedHooks).toHaveProperty('PreCompact');
    expect(migratedHooks).toHaveProperty('Notification');
  });

  it('should transform tool names in matchers', async () => {
    const claudeSettings = {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Edit|Bash|Read|Write|Glob|Grep',
            hooks: [{ type: 'command', command: 'echo "test"' }],
          },
        ],
      },
    };

    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(claudeSettings));

    await handleMigrateFromClaude();

    const migratedHooks = mockSetValue.mock.calls[0][2];
    expect(migratedHooks.PreToolUse[0].matcher).toBe(
      'Edit|Bash|Read|Write|Glob|Grep',
    );
  });

  it('should replace $CLAUDE_PROJECT_DIR with $QWEN_PROJECT_DIR during migration', async () => {
    const claudeSettings = {
      hooks: {
        PreToolUse: [
          {
            hooks: [
              {
                type: 'command',
                command: 'cd $CLAUDE_PROJECT_DIR && ls',
              },
            ],
          },
        ],
      },
    };

    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(claudeSettings));

    await handleMigrateFromClaude();

    const migratedHooks = mockSetValue.mock.calls[0][2];
    expect(migratedHooks.PreToolUse[0].hooks[0].command).toBe(
      'cd $QWEN_PROJECT_DIR && ls',
    );
  });

  it('should preserve sequential flag', async () => {
    const claudeSettings = {
      hooks: {
        PreToolUse: [
          {
            sequential: true,
            hooks: [{ type: 'command', command: 'echo "test"' }],
          },
        ],
      },
    };

    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(claudeSettings));

    await handleMigrateFromClaude();

    const migratedHooks = mockSetValue.mock.calls[0][2];
    expect(migratedHooks.PreToolUse[0].sequential).toBe(true);
  });

  it('should preserve timeout values', async () => {
    const claudeSettings = {
      hooks: {
        PreToolUse: [
          {
            hooks: [
              {
                type: 'command',
                command: 'echo "test"',
                timeout: 60,
              },
            ],
          },
        ],
      },
    };

    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(claudeSettings));

    await handleMigrateFromClaude();

    const migratedHooks = mockSetValue.mock.calls[0][2];
    expect(migratedHooks.PreToolUse[0].hooks[0].timeout).toBe(60);
  });

  it('should merge with existing Gemini hooks', async () => {
    const claudeSettings = {
      hooks: {
        PreToolUse: [
          {
            hooks: [{ type: 'command', command: 'echo "claude"' }],
          },
        ],
      },
    };

    mockedLoadSettings.mockReturnValue({
      merged: {
        hooks: {
          PostToolUse: [
            {
              hooks: [{ type: 'command', command: 'echo "existing"' }],
            },
          ],
        },
      },
      setValue: mockSetValue,
      mutateScope: vi.fn((_scope, mutation) => {
        const next: Record<string, unknown> = {
          PostToolUse: [
            {
              hooks: [{ type: 'command', command: 'echo "existing"' }],
            },
          ],
        };
        mutation({
          set: (path: string[], value: unknown) => {
            next[path[1]] = value;
          },
        });
        mockSetValue(SettingScope.Project, 'hooks', next);
        return true;
      }),
      project: { path: `/test/project/${CONFIG_DIR}` },
    });

    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(claudeSettings));

    await handleMigrateFromClaude();

    const migratedHooks = mockSetValue.mock.calls[0][2];
    expect(migratedHooks).toHaveProperty('PreToolUse');
    expect(migratedHooks).toHaveProperty('PostToolUse');
    expect(migratedHooks.PostToolUse[0].hooks[0].command).toBe(
      'echo "existing"',
    );
    expect(migratedHooks.PreToolUse[0].hooks[0].command).toBe('echo "claude"');
  });

  it('should handle JSON with comments', async () => {
    const claudeSettingsWithComments = `{
      // This is a comment
      "hooks": {
        /* Block comment */
        "PreToolUse": [
          {
            "hooks": [
              {
                "type": "command",
                "command": "echo test" // Inline comment
              }
            ]
          }
        ]
      }
    }`;

    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(claudeSettingsWithComments);

    await handleMigrateFromClaude();

    expect(mockSetValue).toHaveBeenCalledWith(
      SettingScope.Project,
      'hooks',
      expect.objectContaining({
        PreToolUse: expect.any(Array),
      }),
    );
  });

  it('should handle malformed JSON gracefully', async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue('{ invalid json }');

    await handleMigrateFromClaude();

    expect(debugLoggerErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Error reading'),
    );
    expect(mockSetValue).not.toHaveBeenCalled();
  });

  it('should log info when no hooks are found in Claude settings', async () => {
    const claudeSettings = {
      someOtherSetting: 'value',
    };

    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(claudeSettings));

    await handleMigrateFromClaude();

    expect(debugLoggerLogSpy).toHaveBeenCalledWith(
      'No hooks found in Claude Code settings to migrate.',
    );
    expect(mockSetValue).not.toHaveBeenCalled();
  });

  it('should handle settings mutation failures gracefully', async () => {
    const claudeSettings = {
      hooks: {
        PreToolUse: [
          {
            hooks: [{ type: 'command', command: 'echo "test"' }],
          },
        ],
      },
    };

    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(claudeSettings));
    mockMutateScope.mockReturnValue(false);

    await handleMigrateFromClaude();

    expect(debugLoggerErrorSpy).toHaveBeenCalledWith(
      'Error saving migrated hooks: settings write failed',
    );
  });

  it('should handle hooks with matcher but no command', async () => {
    const claudeSettings = {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Edit',
            hooks: [
              {
                type: 'command',
              },
            ],
          },
        ],
      },
    };

    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(claudeSettings));

    await handleMigrateFromClaude();

    const migratedHooks = mockSetValue.mock.calls[0][2];
    expect(migratedHooks.PreToolUse[0].matcher).toBe('Edit');
    expect(migratedHooks.PreToolUse[0].hooks[0].type).toBe('command');
  });

  it('should handle empty hooks array', async () => {
    const claudeSettings = {
      hooks: {
        PreToolUse: [
          {
            hooks: [],
          },
        ],
      },
    };

    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(claudeSettings));

    await handleMigrateFromClaude();

    const migratedHooks = mockSetValue.mock.calls[0][2];
    expect(migratedHooks.PreToolUse[0].hooks).toEqual([]);
  });

  it('should handle non-array event config gracefully', async () => {
    const claudeSettings = {
      hooks: {
        PreToolUse: 'not an array',
        PostToolUse: [
          {
            hooks: [{ type: 'command', command: 'echo "test"' }],
          },
        ],
      },
    };

    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(claudeSettings));

    await handleMigrateFromClaude();

    const migratedHooks = mockSetValue.mock.calls[0][2];
    expect(migratedHooks).not.toHaveProperty('PreToolUse');
    expect(migratedHooks).toHaveProperty('PostToolUse');
  });

  it('should display migration instructions after successful migration', async () => {
    const claudeSettings = {
      hooks: {
        PreToolUse: [
          {
            hooks: [{ type: 'command', command: 'echo "test"' }],
          },
        ],
      },
    };

    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(JSON.stringify(claudeSettings));

    await handleMigrateFromClaude();

    expect(debugLoggerLogSpy).toHaveBeenCalledWith(
      `✓ Hooks successfully migrated to ${CONFIG_DIR}/settings.json`,
    );
    expect(debugLoggerLogSpy).toHaveBeenCalledWith(
      `\nMigration complete! Please review the migrated hooks in ${CONFIG_DIR}/settings.json`,
    );
  });
});
