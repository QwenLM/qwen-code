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

const ctx = { executionMode: 'interactive' } as CommandContext;
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
    // Every mode: outside the interactive UI the command expands to a prompt
    // instead of a tool dispatch, so it no longer restricts itself.
    expect(c.supportedModes).toBeUndefined();
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
    });
    // Without `whenToUse` the author named no condition, so the model does
    // not see the command; the user still runs it in every mode.
    expect(extensionCmd.modelInvocable).toBeUndefined();
    expect(extensionCmd.modelDescription).toBeUndefined();
    expect(extensionCmd.supportedModes).toBeUndefined();
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

  it('treats a context without an execution mode as the interactive UI', async () => {
    listMock.mockResolvedValue([entry()]);
    const [cmd] = await new SavedWorkflowLoader(makeConfig()).loadCommands(
      signal,
    );
    expect(await cmd.action!({} as CommandContext, '')).toMatchObject({
      type: 'tool',
    });
  });

  describe('outside the interactive UI', () => {
    const audit = () =>
      entry({
        name: 'gcp:audit',
        scriptPath: '/home/.qwen/extensions/gcp/workflows/audit.js',
        source: 'extension',
        extensionName: 'gcp',
        description: 'Audits the project',
        whenToUse: 'When the user asks for a dependency audit',
      });

    async function load(e: SavedWorkflowEntry) {
      listMock.mockResolvedValue([e]);
      const [cmd] = await new SavedWorkflowLoader(makeConfig()).loadCommands(
        signal,
      );
      return cmd;
    }

    it('lists an extension workflow that declares whenToUse for the model', async () => {
      const cmd = await load(audit());
      expect(cmd).toMatchObject({
        description: 'Audits the project',
        modelInvocable: true,
        modelDescription:
          'Audits the project — When the user asks for a dependency audit',
        whenToUse: 'When the user asks for a dependency audit',
      });
    });

    // The condition is the third-party author's; a project or user workflow
    // is not listed on the strength of the same field.
    it('does not list a project workflow for the model', async () => {
      const cmd = await load(entry({ whenToUse: 'Whenever' }));
      expect(cmd.modelInvocable).toBeUndefined();
    });

    // The Skill tool and the headless and ACP command paths all build a
    // non-interactive context, and none of them can run a tool dispatch.
    it.each(['non_interactive', 'acp'] as const)(
      'asks the model to run the workflow by name in %s mode',
      async (executionMode) => {
        const cmd = await load(audit());
        expect(
          await cmd.action!({ executionMode } as CommandContext, ''),
        ).toEqual({
          type: 'submit_prompt',
          content: [
            'Run the "gcp:audit" workflow.',
            'Audits the project',
            'When the user asks for a dependency audit',
            'Invoke: Workflow({ name: "gcp:audit" })',
          ].join('\n\n'),
        });
      },
    );

    it('passes JSON args as a value and other text as a string', async () => {
      const cmd = await load(audit());
      const run = async (args: string) =>
        (
          (await cmd.action!(
            { executionMode: 'acp' } as CommandContext,
            args,
          )) as { content: string }
        ).content;
      expect(await run(' {"files":["a.csv"]} ')).toContain(
        'Invoke: Workflow({ name: "gcp:audit", args: {"files":["a.csv"]} })',
      );
      expect(await run('the lockfile')).toContain(
        'Invoke: Workflow({ name: "gcp:audit", args: "the lockfile" })',
      );
    });

    // `CommandService` renames an extension command that collides with its
    // extension's skill; the Workflow tool only knows the qualified name.
    it('names the workflow, not a renamed command', async () => {
      const cmd = await load(audit());
      cmd.name = 'gcp.gcp:audit';
      const result = (await cmd.action!(
        { executionMode: 'non_interactive' } as CommandContext,
        '',
      )) as { content: string };
      expect(result.content).toContain('Workflow({ name: "gcp:audit" })');
    });

    it('asks for a project workflow by name without a description', async () => {
      const cmd = await load(entry());
      expect(
        await cmd.action!(
          { executionMode: 'non_interactive' } as CommandContext,
          '',
        ),
      ).toEqual({
        type: 'submit_prompt',
        content:
          'Run the "deep-research" saved workflow (project).\n\nInvoke: Workflow({ name: "deep-research" })',
      });
    });
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
