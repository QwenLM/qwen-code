/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Verifies the OpenTUI message meta helpers: the tool-card naming/status
 * parity with the original ToolMessage (`Shell echo X (Echo X)` — display
 * name from the shared map, description reconstructed from the invocation
 * args, no generic `· ok` suffix) and the user/assistant/thinking glyphs.
 */

import { describe, it, expect, vi } from 'vitest';

// theme.ts builds a SyntaxStyle at module scope, which needs the OpenTUI
// native FFI — unavailable in the test runtime. Stub the graphics surface.
vi.mock('@opentui/core', () => ({
  SyntaxStyle: { fromStyles: () => ({}) },
  MouseButton: { LEFT: 0 },
}));

import {
  GENERIC_TOOL_SUMMARIES,
  assistantMessageMeta,
  thinkingMeta,
  toolCardDescription,
  toolCardName,
  toolCardSummarySuffix,
  toolStatusMeta,
  userMessageMeta,
} from './messages.js';
import type { LiveToolItem } from './live-session-model.js';

describe('toolCardName (ink ToolDisplayNames parity)', () => {
  it('maps internal tool names to their display names', () => {
    expect(toolCardName('run_shell_command')).toBe('Shell');
    expect(toolCardName('read_file')).toBe('ReadFile');
    expect(toolCardName('write_file')).toBe('WriteFile');
    expect(toolCardName('grep_search')).toBe('Grep');
    expect(toolCardName('glob')).toBe('Glob');
    expect(toolCardName('edit')).toBe('Edit');
  });

  it('passes unknown names through unchanged', () => {
    expect(toolCardName('mcp__server__tool')).toBe('mcp__server__tool');
    expect(toolCardName('Read')).toBe('Read');
  });
});

describe('toolCardDescription (invocation getDescription parity)', () => {
  it('renders shell cards as `command (description)`', () => {
    const args = JSON.stringify({
      command: 'echo PARITY-OK',
      description: 'Echo PARITY-OK',
    });
    expect(toolCardDescription('run_shell_command', args)).toBe(
      'echo PARITY-OK (Echo PARITY-OK)',
    );
  });

  it('renders shell cards without a description as the bare command', () => {
    const args = JSON.stringify({ command: 'git status' });
    expect(toolCardDescription('run_shell_command', args)).toBe('git status');
  });

  it('collapses multi-line commands and descriptions to one line', () => {
    const args = JSON.stringify({
      command: 'echo a\necho b',
      description: 'line one\nline two',
    });
    expect(toolCardDescription('run_shell_command', args)).toBe(
      'echo a echo b (line one line two)',
    );
  });

  it('renders file tools with their path argument', () => {
    expect(
      toolCardDescription(
        'read_file',
        JSON.stringify({ file_path: '/a/b.ts' }),
      ),
    ).toBe('/a/b.ts');
    expect(
      toolCardDescription('edit', JSON.stringify({ file_path: '/a/b.ts' })),
    ).toBe('/a/b.ts');
  });

  it('renders grep with its pattern', () => {
    expect(
      toolCardDescription('grep_search', JSON.stringify({ pattern: 'foo.*' })),
    ).toBe('foo.*');
  });

  it('returns empty without args or for unknown tools', () => {
    expect(toolCardDescription('run_shell_command')).toBe('');
    expect(toolCardDescription('run_shell_command', 'not json')).toBe('');
    expect(toolCardDescription('some_other_tool', '{}')).toBe('');
  });
});

describe('toolCardSummarySuffix (status format parity)', () => {
  it('suppresses the generic summaries the glyph already conveys', () => {
    expect(GENERIC_TOOL_SUMMARIES.has('ok')).toBe(true);
    expect(toolCardSummarySuffix(true, 'ok')).toBe('');
    expect(toolCardSummarySuffix(true, 'error')).toBe('');
    expect(toolCardSummarySuffix(true, 'skipped')).toBe('');
    expect(toolCardSummarySuffix(true, 'interrupted')).toBe('');
  });

  it('keeps informative custom summaries', () => {
    expect(toolCardSummarySuffix(true, '4779 lines')).toBe(' · 4779 lines');
  });

  it('shows nothing while the tool is still running', () => {
    expect(toolCardSummarySuffix(false, 'anything')).toBe('');
    expect(toolCardSummarySuffix(true, undefined)).toBe('');
  });
});

describe('message meta (ink glyph/color parity)', () => {
  it('keeps the user/assistant prefixes', () => {
    expect(userMessageMeta().glyph).toBe('>');
    expect(assistantMessageMeta().glyph).toBe('◆');
  });

  it('keeps the thinking collapse hint semantics', () => {
    const live = thinkingMeta(false, false, true);
    expect(live.icon).toBe('∵');
    expect(live.collapsed).toBe(false);
    const collapsed = thinkingMeta(true, false, true);
    expect(collapsed.icon).toBe('∴');
    expect(collapsed.hint).toContain('ctrl+o');
  });

  it('marks canceled tools for strikethrough', () => {
    const item = {
      kind: 'tool',
      id: 't',
      tool: 'run_shell_command',
      title: 'run_shell_command',
      output: '',
      done: true,
      success: false,
      summary: 'canceled',
    } as unknown as LiveToolItem;
    expect(toolStatusMeta(item).strikethrough).toBe(true);
  });
});
