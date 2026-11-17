/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import { ToolMode } from '../tools/code-mode.js';
import { ToolNames } from '../tools/tool-names.js';
import type { WorkflowAuthoringSurface } from '../skills/workflow-authoring-skill.js';
import { subagentNameContext } from '../utils/subagentNameContext.js';
import {
  buildWorkflowSteeringNotice,
  detectUltracodeKeyword,
  detectWorkflowKeyword,
  resolveWorkflowIntent,
} from './workflow-intent.js';

const logDebug = vi.hoisted(() => vi.fn());
vi.mock('../utils/debugLogger.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../utils/debugLogger.js')>();
  return {
    ...actual,
    createDebugLogger: (tag?: string) => ({
      ...actual.createDebugLogger(tag),
      ...(tag === 'WORKFLOW_INTENT' ? { debug: logDebug } : {}),
    }),
  };
});

beforeEach(() => logDebug.mockClear());

function fixture(
  options: {
    enabled?: boolean;
    keywordEnabled?: boolean;
    nameOnly?: boolean;
    names?: string[];
    deferred?: string[];
    revealed?: string[];
    surface?: WorkflowAuthoringSurface;
    lazy?: boolean;
    toolMode?: ToolMode;
  } = {},
) {
  const names = options.names ?? [ToolNames.WORKFLOW, ToolNames.SKILL];
  const getTool = vi.fn(() =>
    options.lazy
      ? undefined
      : { authoringSurface: options.surface ?? 'pointer' },
  );
  const registry = {
    getAllToolNames: () => names,
    getTool,
    isPermissionDeferred: (name: string) => options.deferred?.includes(name),
    isDeferredToolRevealed: (name: string) => options.revealed?.includes(name),
    ensureTool: vi.fn(),
  };
  const config = {
    isWorkflowsEnabled: () => options.enabled ?? true,
    getWorkflowKeywordTriggerEnabled: () => options.keywordEnabled ?? true,
    isWorkflowNameOnly: () => options.nameOnly ?? false,
    getToolRegistry: () => registry,
    getVisibleTools: () => new Set(),
    getToolMode: () => options.toolMode ?? ToolMode.Direct,
    getSkillManager: () => ({}),
    getDisabledSkillLevels: () => new Set(),
    isSkillEnabled: () => true,
  } as unknown as Config;
  return { config, registry };
}

describe('DW03: keyword matching', () => {
  it.each([
    ['workflow', true],
    ['WORKFLOW: audit', true],
    ['(workflow)?', true],
    ['workflows', false],
    ['workflow2', false],
    ['my-workflow-runner', false],
    ['', false],
  ])('retains the workflow compatibility rule: %s', (text, expected) => {
    expect(detectWorkflowKeyword(text)).toBe(expected);
  });

  // Frozen behavioral cases, not a runtime dependency on another CLI.
  const ultracodeCases: Array<[string, string, boolean]> = [
    ['plain', 'ultracode', true],
    ['case', 'ULTRACODE: audit', true],
    ['sentence', 'Please ultracode audit this.', true],
    ['workflow-is-not-keyword', 'use a workflow', false],
    ['word-suffix', 'ultracodes', false],
    ['word-prefix', 'xultracode', false],
    ['underscore-before', '_ultracode', false],
    ['underscore-after', 'ultracode_task', false],
    ['digit-before', '7ultracode', false],
    ['digit-after', 'ultracode7', false],
    ['hyphen-before', 'x-ultracode', false],
    ['hyphen-after', 'ultracode-task', false],
    ['hyphen-separated', '- ultracode', true],
    ['non-ascii-han', '中文ultracode中文', true],
    ['non-ascii-latin', 'éultracodeé', true],
    ['single-quoted', "'ultracode'", false],
    ['double-quoted', '"ultracode"', false],
    ['inline-code', '`ultracode`', false],
    ['fenced', '```\nultracode\n```', false],
    ['unclosed-single', "'ultracode", true],
    ['unclosed-double', '"ultracode', true],
    ['unclosed-backtick', '`ultracode', true],
    ['unclosed-fence', '```\nultracode', true],
    ['parentheses', '(ultracode)', false],
    ['brackets', '[ultracode]', false],
    ['braces', '{ultracode}', false],
    ['angle', '<ultracode>', false],
    ['angle-space', '< ultracode >', true],
    ['unclosed-parenthesis', '(ultracode', true],
    ['unclosed-bracket', '[ultracode', true],
    ['unclosed-brace', '{ultracode', true],
    ['apostrophe-word', "don't ultracode this", true],
    ['apostrophe-suffix', "'ultracode's", true],
    ['slash-command', '/say ultracode', false],
    ['slash-before', 'read /ultracode', false],
    ['backslash-before', 'read \\ultracode', false],
    ['slash-after', 'ultracode/file', false],
    ['backslash-after', 'ultracode\\file', false],
    ['question-after', 'ultracode?', false],
    ['dot-extension', 'ultracode.js', false],
    ['dot-underscore', 'ultracode._', false],
    ['dot-digit', 'ultracode.1', false],
    ['dot-non-ascii', 'ultracode.中文', false],
    ['dot-ending', 'ultracode.', true],
    ['dot-space', 'ultracode. audit', true],
    ['dot-before', '.ultracode', true],
    ['colon-ending', 'ultracode: audit', true],
    ['quoted-and-bare', '`ultracode` then ultracode', true],
    ['leading-space-slash-helper-only', ' /say ultracode', true],
  ];

  it.each(ultracodeCases)('%s', (_id, text, expected) => {
    expect(detectUltracodeKeyword(text)).toBe(expected);
  });

  it('handles many closed spans and a keyword before or after them', () => {
    const quoted = '(ultracode) '.repeat(4096);
    expect(detectUltracodeKeyword(quoted)).toBe(false);
    expect(detectUltracodeKeyword(`${quoted}ultracode`)).toBe(true);
    expect(detectUltracodeKeyword(`ultracode ${quoted}`)).toBe(true);
  });
});

describe('DW03: workflow intent capability', () => {
  it('traces a failed capability read without logging the human text', () => {
    const { config } = fixture();
    const error = new Error('registry unavailable');
    vi.spyOn(config, 'getToolRegistry').mockImplementation(() => {
      throw error;
    });
    const text = 'ultracode private human text';
    expect(resolveWorkflowIntent(config, { text })).toBeNull();
    expect(logDebug).toHaveBeenCalledWith(
      'Workflow keyword intent unavailable:',
      error,
    );
    expect(JSON.stringify(logDebug.mock.calls)).not.toContain(text);
  });
  it('requires an explicit nonempty human input', () => {
    const { config } = fixture();
    expect(resolveWorkflowIntent(config, undefined)).toBeNull();
    expect(resolveWorkflowIntent(config, { text: '  ' })).toBeNull();
    expect(
      resolveWorkflowIntent(config, { text: 'ordinary request' }),
    ).toBeNull();
  });

  it.each([
    { enabled: false },
    { keywordEnabled: false },
    { names: [] },
    { names: [ToolNames.SKILL] },
  ])('fails closed when the capability is unavailable: %j', (options) => {
    const { config } = fixture(options);
    expect(resolveWorkflowIntent(config, { text: 'ultracode' })).toBeNull();
  });

  it('does not turn a subagent request into a human main turn', () => {
    const { config } = fixture();
    expect(
      subagentNameContext.run('child', () =>
        resolveWorkflowIntent(config, { text: 'ultracode' }),
      ),
    ).toBeNull();
  });

  it.each(['getAllToolNames', 'getTool'] as const)(
    'does not guess after %s fails',
    (method) => {
      const { config, registry } = fixture();
      vi.spyOn(registry, method).mockImplementation(() => {
        throw new Error('unavailable');
      });
      expect(resolveWorkflowIntent(config, { text: 'ultracode' })).toBeNull();
    },
  );

  it('does not lose a name-only lock when its read fails', () => {
    const { config } = fixture({ nameOnly: true });
    vi.spyOn(config, 'isWorkflowNameOnly').mockImplementation(() => {
      throw new Error('unavailable');
    });
    expect(resolveWorkflowIntent(config, { text: 'workflow' })).toBeNull();
  });

  it('chooses ultracode when both words occur, without mutating the source', () => {
    const { config } = fixture();
    const input = Object.freeze({ text: 'workflow and ultracode' });
    const intent = resolveWorkflowIntent(config, input);
    expect(intent?.trigger).toBe('ultracode');
    expect(intent?.reminder).toContain('"ultracode" keyword');
    expect(intent?.reminder.match(/<system-reminder>/g)).toHaveLength(1);
    expect(input.text).toBe('workflow and ultracode');
  });

  it.each([[], [ToolNames.TOOL_SEARCH], [ToolNames.TOOL_CALL]])(
    'requires both hidden-tool bridge halves: %j',
    (...halves: string[]) => {
      const { config } = fixture({
        names: [ToolNames.WORKFLOW, ...halves],
        deferred: [ToolNames.WORKFLOW],
      });
      expect(resolveWorkflowIntent(config, { text: 'workflow' })).toBeNull();
    },
  );

  it('names both bridge halves when a lazy Workflow is hidden', () => {
    const { config, registry } = fixture({
      names: [ToolNames.WORKFLOW, ToolNames.TOOL_SEARCH, ToolNames.TOOL_CALL],
      deferred: [ToolNames.WORKFLOW],
      lazy: true,
    });
    const notice = resolveWorkflowIntent(config, { text: 'workflow' });
    expect(notice?.reminder).toContain('`tool_search`');
    expect(notice?.reminder).toContain('`tool_call`');
    expect(registry.ensureTool).not.toHaveBeenCalled();
  });

  it('allows a revealed tool without suggesting an unavailable bridge', () => {
    const { config } = fixture({
      deferred: [ToolNames.WORKFLOW],
      revealed: [ToolNames.WORKFLOW],
    });
    const intent = resolveWorkflowIntent(config, { text: 'workflow' });
    expect(intent).not.toBeNull();
    expect(intent?.reminder).not.toContain('`tool_call`');
  });

  it('keeps the CodeModeOnly route instead of naming the Direct bridge', () => {
    const { config } = fixture({
      toolMode: ToolMode.CodeModeOnly,
      names: [ToolNames.WORKFLOW, ToolNames.EXEC],
      deferred: [ToolNames.WORKFLOW],
    });
    const intent = resolveWorkflowIntent(config, { text: 'workflow' });
    expect(intent).not.toBeNull();
    expect(intent?.reminder).not.toContain('`tool_call`');
  });

  it.each([
    'pointer',
    'pointer-via-tool-search',
    'inline',
    'withheld',
  ] as const)('uses the recorded authoring surface: %s', (surface) => {
    const { config } = fixture({ surface });
    const reminder = resolveWorkflowIntent(config, {
      text: 'workflow',
    })?.reminder;
    expect(reminder).toBeDefined();
    expect(reminder?.includes('load the `workflow-authoring`')).toBe(
      surface === 'pointer' || surface === 'pointer-via-tool-search',
    );
    expect(reminder?.includes('If the Skill tool')).toBe(
      surface === 'pointer-via-tool-search',
    );
    expect(reminder).not.toContain('# Workflow authoring');
  });

  it('resolves a registered lazy tool surface without constructing it', () => {
    const { config, registry } = fixture({ lazy: true });
    expect(
      resolveWorkflowIntent(config, { text: 'ultracode' })?.reminder,
    ).toContain('load the `workflow-authoring`');
    expect(registry.ensureTool).not.toHaveBeenCalled();
  });

  it.each([
    'pointer',
    'pointer-via-tool-search',
    'inline',
    'withheld',
  ] as const)(
    'name-only never asks for a script or authoring skill: %s',
    (surface) => {
      const { config } = fixture({ surface, nameOnly: true });
      const reminder = resolveWorkflowIntent(config, {
        text: 'workflow',
      })?.reminder;
      expect(reminder).toContain('{ name, args }');
      expect(reminder).toContain('do not write a workflow script');
      expect(reminder).not.toContain('author a script');
      expect(reminder).not.toContain('workflow-authoring');
    },
  );

  it('keeps the reminder a soft nudge', () => {
    expect(buildWorkflowSteeringNotice()).toContain('proceed normally');
  });
});
