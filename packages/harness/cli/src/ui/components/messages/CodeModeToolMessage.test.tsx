/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  CoreToolCallStatus,
  type CodeModeDisplay,
  makeFakeConfig,
} from '@qwen-code/core';
import { renderWithProviders } from '../../../test-utils/render.js';
import { createMockSettings } from '../../../test-utils/settings.js';
import { ToolGroupMessage } from './ToolGroupMessage.js';
import { projectToolCallDisplay } from '../../utils/toolDisplayProjection.js';
import { FoldLevel } from '../../constants/messageLayout.js';
import { FEED_MARKER } from '../../constants/feedGrammar.js';
import type { IndividualToolCallDisplay } from '../../types.js';

function renderTool(
  tool: IndividualToolCallDisplay,
  foldLevel = FoldLevel.GroupExpandedToolCollapsed,
  language: 'en' | 'zh-CN' = 'en',
) {
  return renderWithProviders(
    <ToolGroupMessage
      item={{ type: 'tool_group', tools: [tool] }}
      toolCalls={[tool]}
      terminalWidth={100}
    />,
    {
      config: makeFakeConfig({ useAlternateBuffer: false }),
      settings: createMockSettings({ ui: { useAlternateBuffer: false, language } }),
      initialFoldLevel: foldLevel,
      uiState: { constrainHeight: foldLevel !== FoldLevel.FullyExpanded },
    },
  );
}

describe('CodeMode tool header and source', () => {
  const candidate = {
    name: 'mcp__atlas-docs__lookup_revision',
    about: 'Read a document revision.',
    input: '{ title: string; }',
  };
  const candidates = [
    candidate,
    ...Array.from({ length: 14 }, (_, i) => ({
      ...candidate,
      name: `mcp__atlas-docs__archive_${i + 1}`,
    })),
  ];
  const searchCode =
    'return await searchTools("document revision", {namespace: "atlas-docs", format: "compact", limit: 15});';
  function completedTool(
    description: string,
    code: string,
    result: Record<string, unknown>,
  ) {
    return projectToolCallDisplay({
      toolUse: { id: 'exec', name: 'CodeMode', input: { description, code } },
      toolResult: {
        isError: false,
        toolUseResult: {
          type: 'code_mode',
          status: 'completed',
          calls: [],
          totalCalls: 0,
          ...result,
        },
      },
    });
  }

  it.each([
    ['found', candidates],
    ['empty', []],
  ] as const)(
    'collapses a completed search to one line (%s)',
    async (scenario, matches) => {
      const tool = completedTool(
        '在 atlas-docs 中搜索文档校验工具',
        scenario === 'found'
          ? searchCode
          : searchCode.replace('document revision', 'zzznomatch'),
        {
          toolSearch: { count: matches.length, matches },
          output: JSON.stringify(matches),
        },
      );
      const rendered = await renderTool(
        tool,
        FoldLevel.GroupExpandedToolCollapsed,
        'zh-CN',
      );
      try {
        await rendered.waitUntilReady();
        expect(rendered.lastFrame()?.trim().split('\n')).toHaveLength(1);
        expect(rendered.lastFrame()).toContain(
          scenario === 'found' ? '找到 15 个候选工具' : '未找到匹配工具',
        );
        expect(rendered.lastFrame()).toMatchSnapshot();
      } finally {
        rendered.unmount();
      }
    },
  );

  it('shows the actual MCP server, tool and output in the collapsed card', async () => {
    const tool = projectToolCallDisplay({
      toolUse: {
        id: 'exec',
        name: 'CodeMode',
        input: {
          description: '查询 Release Checklist 当前修订版',
          code: `return (await tools["${candidate.name}"]({title: "Release Checklist"})).content[0].text;`,
        },
      },
      toolResult: {
        isError: false,
        toolUseResult: {
          isCodeModeDisplay: true,
          status: 'completed',
          totalCalls: 1,
          summary: 'revision-42',
          children: [{
            name: candidate.name,
            callId: 'lookup',
            args: { title: 'Release Checklist' },
            status: CoreToolCallStatus.Success,
            resultDisplay: 'revision-42',
          }],
        } satisfies CodeModeDisplay,
      },
    });
    const rendered = await renderTool(
      tool,
      FoldLevel.GroupExpandedToolCollapsed,
      'zh-CN',
    );
    try {
      await rendered.waitUntilReady();
      expect(rendered.lastFrame()).toContain('已完成 · 1 次工具调用');
      expect(rendered.lastFrame()).toContain(
        'lookup_revision (atlas-docs MCP Server)',
      );
      expect(rendered.lastFrame()).toMatchSnapshot();
    } finally {
      rendered.unmount();
    }
  });

  it('expands candidate signatures and source while preserving custom script output', async () => {
    const tool = completedTool(
      'Search atlas-docs',
      searchCode.replace('return await', 'const matches = await') +
        '\nreturn matches[0].name;',
      {
        toolSearch: { count: 2, matches: [candidate] },
        output: candidate.name,
      },
    );
    const rendered = await renderTool(tool, FoldLevel.FullyExpanded);
    try {
      await rendered.waitUntilReady();
      const frame = rendered.lastFrame();
      expect(frame).toContain('Found 2 candidate tools');
      expect(frame).toContain(`${candidate.name} ${candidate.input}`);
      expect(frame).toContain('Additional candidates omitted: 1');
      expect(frame).toContain('Output');
      expect(frame).toContain('return matches[0].name;');
    } finally {
      rendered.unmount();
    }
  });

  it.each(['exec', 'wait'] as const)(
    'renders a returned %s with a running script as a neutral receipt',
    async (action) => {
      const tool = projectToolCallDisplay({
        toolUse: {
          id: 'cell-call',
          name: action === 'exec' ? 'CodeMode' : 'CodeModeWait',
          input: action === 'exec' ? {} : { cell_id: 'cell' },
        },
        runtime: { status: CoreToolCallStatus.Success },
        toolResult: {
          isError: false,
          toolUseResult: {
            type: 'code_mode',
            status: 'running',
            output: 'partial output',
            calls: [{ callId: 'grep', name: 'Grep', status: 'pending' }],
          },
        },
      });
      // Returning a cell must not put the finished tool response back in execution.
      expect(tool.status).toBe(CoreToolCallStatus.Success);
      expect(tool.resultDisplay).toMatchObject({
        status: 'running',
        children: [{ status: CoreToolCallStatus.Executing }],
      });
      const rendered = await renderTool(tool);
      try {
        await rendered.waitUntilReady();
        const output = rendered.lastFrame() ?? '';
        expect(output.trimStart().startsWith(FEED_MARKER.toolPending)).toBe(true);
        expect(output).toContain(action === 'exec' ? 'Execute script' : 'Wait for script');
        expect(output).toContain('Script still running · 1 tool call');
        expect(output).toContain('partial output');
        await expect(rendered).toMatchSvgSnapshot();
      } finally {
        rendered.unmount();
      }
    },
  );

  it('counts every script call while listing only those updated since the last poll', async () => {
    const display: CodeModeDisplay = {
      isCodeModeDisplay: true,
      status: 'completed',
      children: [
        {
          callId: 'third',
          name: 'Bash',
          args: { command: 'git status' },
          status: CoreToolCallStatus.Success,
        },
      ],
      totalCalls: 3,
    };
    const rendered = await renderTool({
      ...projectToolCallDisplay({
        toolUse: {
          id: 'wait-call',
          name: 'CodeModeWait',
          input: { cell_id: 'cell' },
        },
        runtime: { status: CoreToolCallStatus.Success },
      }),
      resultDisplay: display,
    });
    try {
      await rendered.waitUntilReady();
      const output = rendered.lastFrame() ?? '';
      expect(output).toContain('Completed · 3 tool calls · 1 updated');
      expect(output.match(/Bash/g)).toHaveLength(1);
    } finally {
      rendered.unmount();
    }
  });

  it('shows live child progress before exec returns', async () => {
    const display: CodeModeDisplay = {
      isCodeModeDisplay: true,
      status: 'running',
      children: [{ callId: 'grep', name: 'Grep', args: { pattern: 'TODO' }, status: CoreToolCallStatus.Executing }],
    };
    const tool = projectToolCallDisplay({
      toolUse: { id: 'exec', name: 'CodeMode', input: { code: 'await tools.Grep({pattern:"TODO"});' } },
      runtime: { status: CoreToolCallStatus.Executing, liveOutput: display },
    });
    const rendered = await renderTool(tool);
    try {
      await rendered.waitUntilReady();
      expect(rendered.lastFrame()).toContain('Execute script · Running · 1 tool call');
      expect(rendered.lastFrame()).toContain("Grep('TODO'");
      expect(rendered.lastFrame()).not.toContain('Completed');
      await expect(rendered).toMatchSvgSnapshot();
    } finally {
      rendered.unmount();
    }
  });

  it.each([FoldLevel.GroupExpandedToolCollapsed, FoldLevel.FullyExpanded])(
    'shows source and child payload only when expanded (fold=%s)',
    async (foldLevel) => {
      const source = 'const result = await tools.Grep({pattern: "TODO"});\ntext(result.content);';
      const display: CodeModeDisplay = {
        isCodeModeDisplay: true,
        status: 'completed',
        children: [{
          callId: 'grep', name: 'Grep', args: { pattern: 'TODO' }, status: CoreToolCallStatus.Success,
          resultDisplay: { mode: 'content', numFiles: 0, filenames: [], numMatches: 1, content: 'src/file.ts:1:TODO' },
        }],
        summary: 'script output',
      };
      const tool = projectToolCallDisplay({
        toolUse: { id: 'exec', name: 'CodeMode', input: { code: source } },
        toolResult: { isError: false, toolUseResult: display },
      });
      const rendered = await renderTool(tool, foldLevel);
      try {
        await rendered.waitUntilReady();
        const output = rendered.lastFrame() ?? '';
        expect(output).toContain('Execute script · Completed · 1 tool call');
        expect(output).toContain('Found 1 match');
        expect(output).toContain('script output');
        expect(output).not.toContain('{"code":');
        if (foldLevel === FoldLevel.FullyExpanded) {
          expect(output).toContain('const result = await tools.Grep');
          expect(output).toContain('text(result.content);');
          expect(output).toContain('src/file.ts:1:TODO');
        } else {
          expect(output).not.toContain('const result =');
          expect(output).not.toContain('src/file.ts:1:TODO');
          expect(output).toContain('Ctrl+O to expand script');
        }
        await expect(rendered).toMatchSvgSnapshot();
      } finally {
        rendered.unmount();
      }
    },
  );

  it('shows cancellation and timeout distinctly from completion', async () => {
    for (const [status, label] of [['cancelled', 'Cancelled'], ['timeout', 'Timed out']] as const) {
      const tool = projectToolCallDisplay({
        toolUse: { id: status, name: 'CodeModeWait', input: { cell_id: 'cell', cancel: status === 'cancelled' } },
        runtime: { status: CoreToolCallStatus.Success },
        toolResult: { isError: true, toolUseResult: { type: 'code_mode', status, calls: [], error: 'execution stopped' } },
      });
      const rendered = await renderTool(tool);
      try {
        await rendered.waitUntilReady();
        expect(rendered.lastFrame()).toContain(`${label} · 0 tool calls`);
        expect(rendered.lastFrame()).toContain('execution stopped');
        expect(rendered.lastFrame()?.trimStart().startsWith(
          status === 'cancelled' ? FEED_MARKER.toolCanceled : FEED_MARKER.toolError,
        )).toBe(true);
      } finally {
        rendered.unmount();
      }
    }
  });
});
