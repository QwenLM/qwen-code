/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { cdCommand } from './cdCommand.js';
import {
  CommandKind,
  type CommandContext,
  type ConfirmActionReturn,
  type MessageActionReturn,
} from './types.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import type { Config } from '@qwen-code/qwen-code-core';
import {
  loadTrustedFolders,
  resetTrustedFoldersForTesting,
} from '../../config/trustedFolders.js';

describe('cdCommand', () => {
  let tmpDir: string;
  let currentDir: string;
  let nextDir: string;
  let context: CommandContext;
  let relocateWorkingDirectory: ReturnType<typeof vi.fn>;
  let addWorkingDirectoryChangedContext: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-cd-command-'));
    currentDir = path.join(tmpDir, 'current');
    nextDir = path.join(tmpDir, 'next');
    fs.mkdirSync(currentDir);
    fs.mkdirSync(nextDir);
    process.env['QWEN_CODE_TRUSTED_FOLDERS_PATH'] = path.join(
      tmpDir,
      'trustedFolders.json',
    );
    resetTrustedFoldersForTesting();

    relocateWorkingDirectory = vi.fn().mockResolvedValue({});
    addWorkingDirectoryChangedContext = vi.fn().mockResolvedValue(undefined);
    context = createMockCommandContext({
      services: {
        config: {
          getTargetDir: () => currentDir,
          getWorkingDir: () => currentDir,
          isRestrictiveSandbox: () => false,
          relocateWorkingDirectory,
          getGeminiClient: () => ({
            addWorkingDirectoryChangedContext,
          }),
        } as unknown as Config,
      },
    });
  });

  afterEach(() => {
    delete process.env['QWEN_CODE_TRUSTED_FOLDERS_PATH'];
    resetTrustedFoldersForTesting();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('has command metadata', () => {
    expect(cdCommand.name).toBe('cd');
    expect(cdCommand.description).toBe(
      'Move this session to a new working directory',
    );
    expect(cdCommand.argumentHint).toBe('<path>');
    expect(cdCommand.kind).toBe(CommandKind.BUILT_IN);
    expect(cdCommand.supportedModes).toEqual(['interactive']);
  });

  it('shows usage when no path is provided', async () => {
    const result = (await cdCommand.action?.(
      context,
      '   ',
    )) as MessageActionReturn;

    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'Usage: /cd <path>',
    });
  });

  it('does not use comma-separated path completion semantics', async () => {
    const completions = await cdCommand.completion?.(
      context,
      `${currentDir}, ${nextDir.slice(0, -1)}`,
    );

    expect(completions).toEqual([]);
  });

  it('rejects a missing directory', async () => {
    const result = (await cdCommand.action?.(
      context,
      'missing',
    )) as MessageActionReturn;

    expect(result.type).toBe('message');
    expect(result.messageType).toBe('error');
    expect(result.content).toContain("Couldn't find a directory");
    expect(relocateWorkingDirectory).not.toHaveBeenCalled();
  });

  it('rejects a file target', async () => {
    const filePath = path.join(currentDir, 'file.txt');
    fs.writeFileSync(filePath, 'not a directory');

    const result = (await cdCommand.action?.(
      context,
      'file.txt',
    )) as MessageActionReturn;

    expect(result.type).toBe('message');
    expect(result.messageType).toBe('error');
    expect(result.content).toContain('is not a directory');
    expect(relocateWorkingDirectory).not.toHaveBeenCalled();
  });

  it('leaves the session unchanged when already in the target directory', async () => {
    const result = (await cdCommand.action?.(
      context,
      '.',
    )) as MessageActionReturn;

    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: `Already in ${fs.realpathSync(currentDir)}.`,
    });
    expect(relocateWorkingDirectory).not.toHaveBeenCalled();
  });

  it('rejects switching while a response is in progress', async () => {
    context.ui.isIdleRef.current = false;

    const result = (await cdCommand.action?.(
      context,
      nextDir,
    )) as MessageActionReturn;

    expect(result.type).toBe('message');
    expect(result.messageType).toBe('error');
    expect(result.content).toContain('Cannot change directory while');
    expect(relocateWorkingDirectory).not.toHaveBeenCalled();
  });

  it('rejects restrictive sandbox sessions', async () => {
    context = createMockCommandContext({
      services: {
        config: {
          getTargetDir: () => currentDir,
          getWorkingDir: () => currentDir,
          isRestrictiveSandbox: () => true,
          relocateWorkingDirectory,
          getGeminiClient: () => ({
            addWorkingDirectoryChangedContext,
          }),
        } as unknown as Config,
      },
    });

    const result = (await cdCommand.action?.(
      context,
      nextDir,
    )) as MessageActionReturn;

    expect(result.type).toBe('message');
    expect(result.messageType).toBe('error');
    expect(result.content).toContain('restrictive sandbox');
    expect(relocateWorkingDirectory).not.toHaveBeenCalled();
  });

  it('moves to a relative path resolved from the current target directory', async () => {
    const result = (await cdCommand.action?.(
      context,
      '../next',
    )) as MessageActionReturn;
    const realNextDir = fs.realpathSync(nextDir);

    expect(relocateWorkingDirectory).toHaveBeenCalledWith(
      realNextDir,
      realNextDir,
    );
    expect(addWorkingDirectoryChangedContext).toHaveBeenCalledWith(
      fs.realpathSync(currentDir),
      realNextDir,
    );
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: `Moved to ${realNextDir}.`,
    });
  });

  it('moves to a path with escaped spaces', async () => {
    const spacedDir = path.join(tmpDir, 'space dir');
    fs.mkdirSync(spacedDir);

    const result = (await cdCommand.action?.(
      context,
      '../space\\ dir',
    )) as MessageActionReturn;
    const realSpacedDir = fs.realpathSync(spacedDir);

    expect(relocateWorkingDirectory).toHaveBeenCalledWith(
      realSpacedDir,
      realSpacedDir,
    );
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: `Moved to ${realSpacedDir}.`,
    });
  });

  it('moves to a quoted path with repeated spaces', async () => {
    const spacedDir = path.join(tmpDir, 'space  dir');
    fs.mkdirSync(spacedDir);

    const result = (await cdCommand.action?.(
      context,
      '"../space  dir"',
    )) as MessageActionReturn;
    const realSpacedDir = fs.realpathSync(spacedDir);

    expect(relocateWorkingDirectory).toHaveBeenCalledWith(
      realSpacedDir,
      realSpacedDir,
    );
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: `Moved to ${realSpacedDir}.`,
    });
  });

  it('reports a successful move when model context refresh fails afterward', async () => {
    addWorkingDirectoryChangedContext.mockRejectedValue(
      new Error('context failed'),
    );

    const result = (await cdCommand.action?.(
      context,
      '../next',
    )) as MessageActionReturn;
    const realNextDir = fs.realpathSync(nextDir);

    expect(relocateWorkingDirectory).toHaveBeenCalledWith(
      realNextDir,
      realNextDir,
    );
    expect(result).toEqual({
      type: 'message',
      messageType: 'warning',
      content: `Moved to ${realNextDir}. Model context refresh failed: context failed`,
    });
  });

  it('reports a successful move when memory refresh fails afterward', async () => {
    relocateWorkingDirectory.mockResolvedValue({
      memoryRefreshError: new Error('memory failed'),
    });

    const result = (await cdCommand.action?.(
      context,
      '../next',
    )) as MessageActionReturn;
    const realNextDir = fs.realpathSync(nextDir);

    expect(relocateWorkingDirectory).toHaveBeenCalledWith(
      realNextDir,
      realNextDir,
    );
    expect(result).toEqual({
      type: 'message',
      messageType: 'warning',
      content: `Moved to ${realNextDir}. Memory refresh failed: memory failed`,
    });
  });

  it('asks for confirmation before moving to an untrusted directory', async () => {
    context = createMockCommandContext({
      invocation: {
        raw: '/cd ../next',
        name: 'cd',
        args: '../next',
      },
      services: {
        config: context.services.config,
        settings: {
          merged: {
            security: {
              folderTrust: {
                enabled: true,
              },
            },
          },
        },
      },
    });

    const result = (await cdCommand.action?.(
      context,
      '../next',
    )) as ConfirmActionReturn;

    expect(result.type).toBe('confirm_action');
    expect(result.prompt).toContain(fs.realpathSync(nextDir));
    expect(result.prompt).toContain('trusted for future sessions');
    expect(result.originalInvocation.raw).toBe('/cd ../next');
    expect(relocateWorkingDirectory).not.toHaveBeenCalled();
  });

  it('asks again when confirmed path resolves to a different directory', async () => {
    const changedDir = path.join(tmpDir, 'changed');
    fs.mkdirSync(changedDir);
    const originalRealPath = fs.realpathSync(nextDir);
    context = createMockCommandContext({
      invocation: {
        raw: '/cd ../next',
        name: 'cd',
        args: '../next',
      },
      services: {
        config: context.services.config,
        settings: {
          merged: {
            security: {
              folderTrust: {
                enabled: true,
              },
            },
          },
        },
      },
    });

    await cdCommand.action?.(context, '../next');
    fs.rmSync(nextDir, { recursive: true, force: true });
    fs.symlinkSync(changedDir, nextDir);
    context.overwriteConfirmed = true;

    const result = (await cdCommand.action?.(
      context,
      '../next',
    )) as ConfirmActionReturn;

    expect(result.type).toBe('confirm_action');
    expect(result.prompt).not.toContain(originalRealPath);
    expect(result.prompt).toContain(fs.realpathSync(changedDir));
    expect(relocateWorkingDirectory).not.toHaveBeenCalled();
    expect(
      loadTrustedFolders().isPathTrusted(fs.realpathSync(changedDir)),
    ).toBe(undefined);
  });

  it('trusts the target directory after confirmation before moving', async () => {
    context = createMockCommandContext({
      invocation: {
        raw: '/cd ../next',
        name: 'cd',
        args: '../next',
      },
      services: {
        config: context.services.config,
        settings: {
          merged: {
            security: {
              folderTrust: {
                enabled: true,
              },
            },
          },
        },
      },
    });
    await cdCommand.action?.(context, '../next');
    context.overwriteConfirmed = true;

    const result = (await cdCommand.action?.(
      context,
      '../next',
    )) as MessageActionReturn;
    const realNextDir = fs.realpathSync(nextDir);

    expect(loadTrustedFolders().isPathTrusted(realNextDir)).toBe(true);
    expect(relocateWorkingDirectory).toHaveBeenCalledWith(
      realNextDir,
      realNextDir,
    );
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: `Moved to ${realNextDir}.`,
    });
  });

  it('does not trust the target directory when moving after confirmation fails', async () => {
    context = createMockCommandContext({
      invocation: {
        raw: '/cd ../next',
        name: 'cd',
        args: '../next',
      },
      services: {
        config: context.services.config,
        settings: {
          merged: {
            security: {
              folderTrust: {
                enabled: true,
              },
            },
          },
        },
      },
    });
    await cdCommand.action?.(context, '../next');
    context.overwriteConfirmed = true;
    relocateWorkingDirectory.mockRejectedValue(new Error('move failed'));

    const result = (await cdCommand.action?.(
      context,
      '../next',
    )) as MessageActionReturn;
    const realNextDir = fs.realpathSync(nextDir);

    expect(result.type).toBe('message');
    expect(result.messageType).toBe('error');
    expect(result.content).toContain(`Couldn't move to ${realNextDir}`);
    expect(loadTrustedFolders().isPathTrusted(realNextDir)).toBe(undefined);
  });
});
