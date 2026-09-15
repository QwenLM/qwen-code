/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>();
  return {
    ...actual,
    listSavedWorkflows: vi.fn(),
  };
});

import {
  listSavedWorkflows,
  type Config,
  type SavedWorkflowEntry,
} from '@qwen-code/qwen-code-core';
import { SavedWorkflowLoader } from './saved-workflow-loader.js';
import {
  extensionOwnerLabel,
  getCommandSourceBadge,
} from './commandMetadata.js';
import { CommandKind, type CommandContext } from '../ui/commands/types.js';

const listMock = vi.mocked(listSavedWorkflows);

function makeConfig(overrides: Partial<Record<string, unknown>> = {}): Config {
  return {
    isWorkflowsEnabled: () => true,
    getBareMode: () => false,
    getFolderTrustFeature: () => false,
    getFolderTrust: () => false,
    ...overrides,
  } as unknown as Config;
}

const ctx = {} as CommandContext;
const signal = new AbortController().signal;

function entry(
  overrides: Partial<SavedWorkflowEntry> = {},
): SavedWorkflowEntry {
  return {
    name: 'deep-research',
    scriptPath: '/proj/.qwen/workflows/deep-research.js',
    source: 'project',
    ...overrides,
  };
}

describe('SavedWorkflowLoader', () => {
  beforeEach(() => {
    listMock.mockReset();
    listMock.mockResolvedValue([]);
  });

  it('builds one tool-dispatch command per discovered workflow', async () => {
    listMock.mockResolvedValue([
      entry({ name: 'deep-research', source: 'project' }),
      entry({
        name: 'triage',
        scriptPath: '/home/.qwen/workflows/triage.js',
        source: 'user',
      }),
    ]);
    const cmds = await new SavedWorkflowLoader(makeConfig()).loadCommands(
      signal,
    );
    expect(cmds.map((c) => c.name)).toEqual(['deep-research', 'triage']);
    const c = cmds[0];
    expect(c.kind).toBe(CommandKind.FILE);
    expect(c.source).toBe('workflow-command');
    expect(c.sourceDetail).toBe('project');
    // Interactive only — the tool-dispatch action can't run in headless / ACP,
    // so advertising those modes would surface a command that then fails.
    expect(c.supportedModes).toEqual(['interactive']);
  });

  it('builds an extension workflow command tagged with its extension', async () => {
    listMock.mockResolvedValue([
      entry({
        name: 'gcp:audit',
        scriptPath: '/home/.qwen/extensions/gcp/workflows/audit.js',
        source: 'extension',
        extensionName: 'gcp',
        extensionDisplayName: 'Google Cloud',
        description: 'Audits the project',
      }),
      entry({ name: 'deep-research', source: 'project' }),
    ]);
    const [extensionCmd, projectCmd] = await new SavedWorkflowLoader(
      makeConfig(),
    ).loadCommands(signal);

    expect(extensionCmd).toMatchObject({
      name: 'gcp:audit',
      description: 'Audits the project',
      kind: CommandKind.FILE,
      source: 'workflow-command',
      sourceLabel: extensionOwnerLabel({
        name: 'gcp',
        displayName: 'Google Cloud',
      }),
      sourceDetail: 'extension',
      supportedModes: ['interactive'],
    });
    expect(extensionCmd.modelInvocable).toBeUndefined();
    // An extension command, renamed on a collision, that still answers to its
    // documented name in the denylist.
    expect(extensionCmd).toMatchObject({
      extensionName: 'gcp',
      workflowName: 'gcp:audit',
    });
    expect(getCommandSourceBadge(extensionCmd)).toBe(
      `[${extensionOwnerLabel({ name: 'gcp', displayName: 'Google Cloud' })}]`,
    );
    expect(await extensionCmd.action!(ctx, '')).toEqual({
      type: 'tool',
      toolName: 'workflow',
      toolArgs: { scriptPath: '/home/.qwen/extensions/gcp/workflows/audit.js' },
    });
    // Project and user workflows keep their existing shape.
    expect(projectCmd.description).toBe(
      'Run the "deep-research" saved workflow (project)',
    );
    expect('extensionName' in projectCmd).toBe(false);
    expect('workflowName' in projectCmd).toBe(false);
    expect(projectCmd.sourceLabel).toBe('Workflow');
    expect(getCommandSourceBadge(projectCmd)).toBeNull();
  });

  it('names the owner once, in the capped badge, even for a long display name', async () => {
    listMock.mockResolvedValue([
      entry({
        name: 'gcp:audit',
        source: 'extension',
        extensionName: 'gcp',
        extensionDisplayName:
          'Alibaba Cloud Database Suite for Production Workloads',
        description: 'Audits the project',
      }),
    ]);
    const [cmd] = await new SavedWorkflowLoader(makeConfig()).loadCommands(
      signal,
    );
    expect(cmd.description).toBe('Audits the project');
    expect(getCommandSourceBadge(cmd)).toBe(
      '[Extension: Alibaba Cloud Database …]',
    );
  });

  it('falls back to the manifest name for the owner badge', async () => {
    listMock.mockResolvedValue([
      entry({
        name: 'gcp:audit',
        source: 'extension',
        extensionName: 'gcp',
        description: 'Audits the project',
      }),
    ]);
    const [cmd] = await new SavedWorkflowLoader(makeConfig()).loadCommands(
      signal,
    );
    expect(getCommandSourceBadge(cmd)).toBe(
      `[${extensionOwnerLabel({ name: 'gcp' })}]`,
    );
  });

  it('action dispatches the workflow tool with the scriptPath', async () => {
    listMock.mockResolvedValue([entry()]);
    const [cmd] = await new SavedWorkflowLoader(makeConfig()).loadCommands(
      signal,
    );
    const result = await cmd.action!(ctx, '');
    expect(result).toEqual({
      type: 'tool',
      toolName: 'workflow',
      toolArgs: { scriptPath: '/proj/.qwen/workflows/deep-research.js' },
    });
  });

  it('parses JSON args and forwards them as the `args` global', async () => {
    listMock.mockResolvedValue([entry()]);
    const [cmd] = await new SavedWorkflowLoader(makeConfig()).loadCommands(
      signal,
    );
    const result = await cmd.action!(ctx, '{"topic":"llms","depth":3}');
    expect(result).toMatchObject({
      type: 'tool',
      toolName: 'workflow',
      toolArgs: {
        scriptPath: '/proj/.qwen/workflows/deep-research.js',
        args: { topic: 'llms', depth: 3 },
      },
    });
  });

  it('forwards non-JSON args as a raw string', async () => {
    listMock.mockResolvedValue([entry()]);
    const [cmd] = await new SavedWorkflowLoader(makeConfig()).loadCommands(
      signal,
    );
    const result = await cmd.action!(ctx, 'just some text');
    expect(result).toMatchObject({
      toolArgs: { args: 'just some text' },
    });
  });

  it('omits `args` when no input is supplied', async () => {
    listMock.mockResolvedValue([entry()]);
    const [cmd] = await new SavedWorkflowLoader(makeConfig()).loadCommands(
      signal,
    );
    const result = (await cmd.action!(ctx, '   ')) as {
      toolArgs: Record<string, unknown>;
    };
    expect('args' in result.toolArgs).toBe(false);
  });

  it('returns [] when workflows are disabled (tool not registered)', async () => {
    listMock.mockResolvedValue([entry()]);
    const cmds = await new SavedWorkflowLoader(
      makeConfig({ isWorkflowsEnabled: () => false }),
    ).loadCommands(signal);
    expect(cmds).toEqual([]);
    expect(listMock).not.toHaveBeenCalled();
  });

  it('returns [] in bare mode', async () => {
    listMock.mockResolvedValue([entry()]);
    const cmds = await new SavedWorkflowLoader(
      makeConfig({ getBareMode: () => true }),
    ).loadCommands(signal);
    expect(cmds).toEqual([]);
    expect(listMock).not.toHaveBeenCalled();
  });

  it('returns [] when folder trust is enabled but the folder is untrusted', async () => {
    listMock.mockResolvedValue([entry()]);
    const cmds = await new SavedWorkflowLoader(
      makeConfig({
        getFolderTrustFeature: () => true,
        getFolderTrust: () => false,
      }),
    ).loadCommands(signal);
    expect(cmds).toEqual([]);
    expect(listMock).not.toHaveBeenCalled();
  });

  it('returns [] for a null config', async () => {
    const cmds = await new SavedWorkflowLoader(null).loadCommands(signal);
    expect(cmds).toEqual([]);
  });

  it('swallows enumeration errors and returns []', async () => {
    listMock.mockRejectedValue(new Error('readdir blew up'));
    const cmds = await new SavedWorkflowLoader(makeConfig()).loadCommands(
      signal,
    );
    expect(cmds).toEqual([]);
  });

  it('returns [] when the signal aborts during enumeration', async () => {
    listMock.mockResolvedValue([entry()]);
    const aborted = AbortSignal.abort();
    const cmds = await new SavedWorkflowLoader(makeConfig()).loadCommands(
      aborted,
    );
    expect(cmds).toEqual([]);
  });
});
