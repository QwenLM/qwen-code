// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ACPToolCall } from '../../adapters/types';
import { hasActiveAgents } from '../../adapters/toolClassification';
import { I18nProvider } from '../../i18n';
import { WebShellCustomizationProvider } from '../../customization';
import { TranscriptRenderModeProvider } from '../../transcriptRenderMode';
import { SubagentDetailsProvider } from '../../subagentDetailsContext';
import { MonitorDetailsProvider } from '../../monitorDetailsContext';

vi.mock('../../App', async () => {
  const { createContext } = await import('react');
  return {
    TodoTimelineContext: createContext(new Map()),
    TodoDetailContext: createContext(new Map()),
  };
});

const {
  buildUnifiedDiff,
  extractDiff,
  fencedCodeBlock,
  formatSingleToolSummary,
  formatToolGroupSummary,
  getActiveTool,
  getRawFileDiff,
  getToolHeaderKind,
  hasExpandableContent,
  isWebFetchToolName,
  languageForPath,
  shouldAutoExpand,
  ToolGroup,
  ToolLine,
} = await import('./ToolGroup');

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

function makeTool(overrides: Partial<ACPToolCall> = {}): ACPToolCall {
  return {
    callId: 'call-1',
    toolName: 'Shell',
    status: 'completed',
    ...overrides,
  };
}

function renderToolLine(
  tool: ACPToolCall,
  props: Partial<Parameters<typeof ToolLine>[0]> = {},
  customization = {},
): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <I18nProvider language="en">
        <WebShellCustomizationProvider value={customization}>
          <ToolLine tool={tool} {...props} />
        </WebShellCustomizationProvider>
      </I18nProvider>,
    );
  });
  mounted.push({ root, container });
  return container;
}

function renderToolGroup(
  tools: ACPToolCall[],
  customization = {},
  thoughts?: Array<{
    content: string;
    isStreaming?: boolean;
    beforeToolCallId?: string;
  }>,
): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <I18nProvider language="en">
        <WebShellCustomizationProvider value={customization}>
          <ToolGroup tools={tools} thoughts={thoughts} />
        </WebShellCustomizationProvider>
      </I18nProvider>,
    );
  });
  mounted.push({ root, container });
  return container;
}

const t = (key: string, values?: Record<string, string | number>): string => {
  if (key === 'toolGroup.running') {
    return Number(values?.count ?? 0) > 1
      ? `Running ${values?.count ?? 0} tools: ${values?.name ?? 'tool'}`
      : `Running ${values?.name ?? 'tool'}`;
  }
  if (key === 'toolGroup.summary') {
    return `Ran ${values?.count ?? 0} tool${values?.count === 1 ? '' : 's'}`;
  }
  if (key === 'toolGroup.summary.editedFiles') {
    return `Edited ${values?.count ?? 0} files`;
  }
  if (key === 'toolGroup.summary.ranCommands') {
    return `Ran ${values?.count ?? 0} commands`;
  }
  if (key === 'toolGroup.summary.readFiles') {
    return `Read ${values?.count ?? 0} files`;
  }
  if (key === 'toolGroup.summary.searched') {
    return `Searched ${values?.count ?? 0} times`;
  }
  if (key === 'toolGroup.summary.updatedTodos') {
    return `Updated todos ${values?.count ?? 0} times`;
  }
  if (key === 'toolGroup.summary.provideInformation') {
    return 'Provide information';
  }
  if (key === 'toolGroup.summary.askedQuestions') {
    return `Asked ${values?.count ?? 0} question${values?.count === 1 ? '' : 's'}`;
  }
  if (key === 'toolGroup.summary.otherTools') {
    return `Called ${values?.count ?? 0} other tools`;
  }
  return key;
};

const zhT = (key: string, values?: Record<string, string | number>): string => {
  if (key === 'toolName.readfile') return '读取文件';
  return t(key, values);
};

describe('tool group summary logic', () => {
  it('uses the active tool in running summaries', () => {
    const tools = [
      makeTool({ callId: 'done', status: 'completed' }),
      makeTool({
        callId: 'active',
        toolName: 'ReadFile',
        status: 'in_progress',
      }),
    ];

    expect(hasActiveAgents(tools)).toBe(true);
    expect(getActiveTool(tools).callId).toBe('active');
    expect(formatToolGroupSummary(tools, t)).toBe('Running ReadFile');
  });

  it('uses a static summary when only background agents remain active', () => {
    const tools = [
      makeTool({ callId: 'done', status: 'completed' }),
      makeTool({
        callId: 'background',
        toolName: 'agent',
        status: 'pending',
        args: { run_in_background: true },
        rawOutput: { type: 'task_execution', status: 'background' },
      }),
    ];

    expect(formatToolGroupSummary(tools, t)).toBe('subagent.background');
  });

  it('keeps a foreground active tool ahead of a background agent', () => {
    const tools = [
      makeTool({
        callId: 'background',
        toolName: 'agent',
        status: 'pending',
        args: { run_in_background: true },
      }),
      makeTool({
        callId: 'foreground',
        toolName: 'ReadFile',
        status: 'in_progress',
      }),
    ];

    expect(formatToolGroupSummary(tools, t)).toBe('Running ReadFile');
  });

  it('describes every active foreground tool until all tools finish', () => {
    const tools = [
      makeTool({
        callId: 'read',
        toolName: 'ReadFile',
        status: 'in_progress',
        args: { file_path: 'package.json' },
      }),
      makeTool({
        callId: 'search',
        toolName: 'grep',
        status: 'pending',
        args: { pattern: 'ToolGroup' },
      }),
      makeTool({ callId: 'done', status: 'completed' }),
    ];

    const summary = formatToolGroupSummary(tools, t);
    expect(summary).toContain('ReadFile package.json');
    expect(summary).toContain('ToolGroup');
    expect(summary).toContain('Running 2 tools:');
  });

  it('keeps workspace-relative paths in multi-tool summaries', () => {
    const tools = [
      makeTool({
        callId: 'first',
        toolName: 'ReadFile',
        status: 'in_progress',
        args: { file_path: '/workspace/src/index.ts' },
      }),
      makeTool({
        callId: 'second',
        toolName: 'ReadFile',
        status: 'pending',
        args: { file_path: '/workspace/test/index.ts' },
      }),
    ];

    expect(formatToolGroupSummary(tools, t, '/workspace')).toBe(
      'Running 2 tools: ReadFile src/index.ts · ReadFile test/index.ts',
    );
  });

  it('excludes a running background agent from a multi-tool summary', () => {
    const tools = [
      makeTool({
        callId: 'agent',
        toolName: 'agent',
        status: 'in_progress',
        args: { run_in_background: true },
      }),
      makeTool({
        callId: 'read',
        toolName: 'ReadFile',
        status: 'in_progress',
        args: { file_path: 'package.json' },
      }),
      makeTool({
        callId: 'search',
        toolName: 'grep',
        status: 'pending',
        args: { pattern: 'ToolGroup' },
      }),
    ];

    const summary = formatToolGroupSummary(tools, t);
    expect(summary).toBe(
      "Running 2 tools: ReadFile package.json · Grep 'ToolGroup' in path './'",
    );
  });

  it('localizes active tool names in running summaries', () => {
    const tools = [
      makeTool({
        callId: 'active',
        toolName: 'ReadFile',
        status: 'in_progress',
      }),
    ];

    expect(formatToolGroupSummary(tools, zhT)).toBe('Running 读取文件');
  });

  it('asks for information while AskUserQuestion is running', () => {
    const tools = [
      makeTool({
        toolName: 'ask_user_question',
        status: 'in_progress',
        args: { questions: [{}, {}] },
      }),
    ];

    expect(formatToolGroupSummary(tools, t)).toBe('Provide information');
  });

  it('summarizes completed tool groups by common action type', () => {
    const tools = [
      makeTool({ callId: 'shell', status: 'completed' }),
      makeTool({ callId: 'read', toolName: 'ReadFile', status: 'completed' }),
      makeTool({ callId: 'edit', toolName: 'edit', status: 'completed' }),
      makeTool({ callId: 'grep', toolName: 'grep', status: 'completed' }),
      makeTool({
        callId: 'todo',
        toolName: 'todo_write',
        status: 'completed',
      }),
      makeTool({
        callId: 'ask',
        toolName: 'ask_user_question',
        status: 'completed',
        args: { questions: [{}, {}] },
      }),
    ];

    expect(hasActiveAgents(tools)).toBe(false);
    expect(getActiveTool(tools).callId).toBe('ask');
    expect(formatToolGroupSummary(tools, t)).toBe(
      'Edited 1 files Ran 1 commands Read 1 files Searched 1 times Updated todos 1 times Asked 2 questions',
    );
  });

  it('formats a single shell summary as only the semantic description', () => {
    expect(
      formatSingleToolSummary(
        makeTool({
          toolName: 'run_shell_command',
          args: {
            command: 'dataworks-infra workspace list',
            description: '查询用户工作空间列表',
            timeout: 30000,
          },
        }),
        t,
      ),
    ).toBe('查询用户工作空间列表');
  });

  it('falls back to command text for shell summaries without descriptions', () => {
    expect(
      formatSingleToolSummary(
        makeTool({
          toolName: 'Shell',
          args: { command: 'npm run build', timeout: 30000 },
        }),
        t,
      ),
    ).toBe('Shell npm run build');
  });

  it('uses only skill names in single tool summaries', () => {
    expect(
      formatSingleToolSummary(
        makeTool({
          toolName: 'skill',
          title:
            'Skill: Use skill: "qc-helper" with args: "weather in Hangzhou next 5 days"',
          args: {
            skill: 'qc-helper',
            args: 'weather in Hangzhou next 5 days',
          },
        }),
        t,
      ),
    ).toBe('Skill qc-helper');
  });

  it('uses action summaries for single todo and ask-user tools', () => {
    expect(
      formatSingleToolSummary(makeTool({ toolName: 'todo_write' }), t),
    ).toBe('Updated todos 1 times');
    expect(
      formatSingleToolSummary(
        makeTool({
          toolName: 'ask_user_question',
          args: { questions: [{}, {}, {}] },
        }),
        t,
      ),
    ).toBe('Asked 3 questions');
    expect(
      formatSingleToolSummary(
        makeTool({
          toolName: 'ask_user_question',
          status: 'in_progress',
          args: { questions: [{}, {}, {}] },
        }),
        t,
      ),
    ).toBe('Provide information');
  });

  it('counts legacy or empty AskUserQuestion inputs as one question', () => {
    expect(
      formatSingleToolSummary(makeTool({ toolName: 'ask_user_question' }), t),
    ).toBe('Asked 1 question');
    expect(
      formatSingleToolSummary(
        makeTool({
          toolName: 'ask_user_question',
          args: { questions: [] },
        }),
        t,
      ),
    ).toBe('Asked 1 question');
  });

  it('truncates long single tool descriptions in the chat summary', () => {
    const summary = formatSingleToolSummary(
      makeTool({
        toolName: 'Shell',
        args: { command: 'x'.repeat(200) },
      }),
      t,
    );

    expect(summary.length).toBeLessThan(140);
    expect(summary).toContain('...');
  });

  it('lets custom tool header extras render single-tool chat summaries', () => {
    const container = renderToolGroup(
      [
        makeTool({
          toolName: 'run_shell_command',
          args: {
            command: 'dataworks-infra workspace list',
            description: '查询用户工作空间列表',
            timeout: 30000,
          },
        }),
      ],
      {
        renderToolHeaderExtra: (info) => (
          <span data-testid="custom-summary">
            {info.kind}:{info.description}
          </span>
        ),
      },
    );

    const summary = container.querySelector('button');
    expect(summary?.textContent).not.toContain('Shell');
    expect(summary?.textContent).toContain('shell:查询用户工作空间列表');
    expect(summary?.textContent).not.toContain('timeout: 30000ms');
  });

  it('uses action descriptions for shell rows inside grouped summaries', () => {
    const container = renderToolGroup([
      makeTool({
        callId: 'shell',
        toolName: 'run_shell_command',
        title:
          'Shell: dataworks-infra workspace list [timeout: 30000ms] (查询用户工作空间列表)',
        args: {
          command: 'dataworks-infra workspace list',
          description: '查询用户工作空间列表',
          timeout: 30000,
        },
      }),
      makeTool({
        callId: 'read',
        toolName: 'read_file',
        args: { file_path: 'README.md' },
      }),
    ]);

    expect(container.textContent).toContain('Shell');
    expect(container.textContent).toContain('查询用户工作空间列表');
    expect(container.textContent).not.toContain(
      'dataworks-infra workspace list',
    );
    expect(container.textContent).not.toContain('timeout: 30000ms');
  });
});

describe('tool output session links', () => {
  function renderSessionLinkTool(readonly: boolean): HTMLElement {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const toolLine = (
      <ToolLine
        tool={makeTool({
          toolName: 'custom_tool',
          rawOutput: '[child](qwen-session://child-session)',
        })}
        forceExpanded
      />
    );
    act(() => {
      root.render(
        <I18nProvider language="en">
          {readonly ? (
            <TranscriptRenderModeProvider value="readonly">
              {toolLine}
            </TranscriptRenderModeProvider>
          ) : (
            toolLine
          )}
        </I18nProvider>,
      );
    });
    mounted.push({ root, container });
    return container;
  }

  it('keeps interactive tool session links clickable by default', () => {
    const handler = vi.fn();
    window.addEventListener('qwen:open-session', handler);
    const container = renderSessionLinkTool(false);
    const link = container.querySelector('a[role="button"]');
    expect(link?.textContent).toBe('child');
    act(() => {
      link?.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      );
    });
    expect(handler).toHaveBeenCalledOnce();
    window.removeEventListener('qwen:open-session', handler);
  });

  it('renders tool session links as inert text in readonly mode', () => {
    const handler = vi.fn();
    window.addEventListener('qwen:open-session', handler);
    const container = renderSessionLinkTool(true);
    expect(container.querySelector('a[role="button"]')).toBeNull();
    expect(container.textContent).toContain('child');
    expect(handler).not.toHaveBeenCalled();
    window.removeEventListener('qwen:open-session', handler);
  });
});

describe('tool expandability', () => {
  it('only marks tools with actual detail views as expandable by output', () => {
    expect(
      hasExpandableContent(
        makeTool({
          toolName: 'Shell',
          content: [{ type: 'content', content: { text: 'first\nsecond' } }],
        }),
      ),
    ).toBe(true);
    expect(
      hasExpandableContent(
        makeTool({
          toolName: 'list_directory',
          rawOutput: 'a\nb',
        }),
      ),
    ).toBe(false);
  });

  it('does not expand skill rows that only have the skill name', () => {
    expect(
      hasExpandableContent(
        makeTool({
          toolName: 'skill',
          title: 'Skill: Use skill: "review"',
          args: { skill: 'review' },
        }),
      ),
    ).toBe(false);
    expect(
      hasExpandableContent(
        makeTool({
          toolName: 'skill',
          args: { skill: 'review' },
          content: [
            {
              type: 'content',
              content: { type: 'text', text: '# Code Review' },
            },
          ],
        }),
      ),
    ).toBe(true);
  });
});

describe('tool kind logic', () => {
  it('classifies common tool names for summary icons', () => {
    expect(getToolHeaderKind(makeTool({ toolName: 'Shell' }))).toBe('shell');
    expect(getToolHeaderKind(makeTool({ toolName: 'web_fetch' }))).toBe(
      'fetch',
    );
    expect(getToolHeaderKind(makeTool({ toolName: 'ReadFile' }))).toBe('read');
    expect(getToolHeaderKind(makeTool({ toolName: 'edit' }))).toBe('edit');
    expect(getToolHeaderKind(makeTool({ toolName: 'write_file' }))).toBe(
      'write',
    );
    expect(getToolHeaderKind(makeTool({ toolName: 'todo_write' }))).toBe(
      'todo',
    );
    expect(getToolHeaderKind(makeTool({ toolName: 'ask_user_question' }))).toBe(
      'ask',
    );
  });

  it('recognizes web fetch aliases', () => {
    expect(isWebFetchToolName('web_fetch')).toBe(true);
    expect(isWebFetchToolName('WebFetch')).toBe(true);
    expect(isWebFetchToolName('fetch')).toBe(true);
    expect(isWebFetchToolName('ReadFile')).toBe(false);
  });

  it('auto-expands verbose tools only while active or failed', () => {
    expect(
      shouldAutoExpand(makeTool({ toolName: 'Shell', status: 'in_progress' })),
    ).toBe(true);
    expect(
      shouldAutoExpand(makeTool({ toolName: 'edit', status: 'failed' })),
    ).toBe(true);
    expect(
      shouldAutoExpand(makeTool({ toolName: 'Shell', status: 'completed' })),
    ).toBe(false);
    expect(
      shouldAutoExpand(makeTool({ toolName: 'glob', status: 'in_progress' })),
    ).toBe(false);
  });
});

describe('tool row rendering', () => {
  it('renders the aggregate summary for a multi-tool group', () => {
    const container = renderToolGroup([
      makeTool({
        callId: 'read',
        toolName: 'ReadFile',
        status: 'in_progress',
        args: { file_path: 'package.json' },
      }),
      makeTool({
        callId: 'search',
        toolName: 'grep',
        status: 'pending',
        args: { pattern: 'ToolGroup' },
      }),
    ]);

    expect(container.querySelector('button')?.textContent).toContain(
      'package.json',
    );
    expect(container.querySelector('button')?.textContent).toContain(
      'ToolGroup',
    );
  });

  it('does not show elapsed time in a running summary', () => {
    const container = renderToolGroup([
      makeTool({ status: 'in_progress', startTime: 1_000 }),
      makeTool({ callId: 'done', status: 'completed' }),
    ]);

    expect(container.querySelector('button')?.textContent).not.toMatch(
      /\d+[sm]/,
    );
  });

  it('keeps elapsed time updating in a running tool row', () => {
    vi.useFakeTimers();
    vi.setSystemTime(6_000);

    try {
      const container = renderToolLine(
        makeTool({
          toolName: 'ReadFile',
          status: 'in_progress',
          startTime: 1_000,
        }),
      );
      expect(container.textContent).toContain('5s');

      act(() => {
        vi.advanceTimersByTime(1_000);
      });
      expect(container.textContent).toContain('6s');
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows live elapsed time after expanding a single-tool group', () => {
    vi.useFakeTimers();
    vi.setSystemTime(6_000);

    try {
      const container = renderToolGroup(
        [
          makeTool({
            toolName: 'ReadFile',
            status: 'in_progress',
            startTime: 1_000,
          }),
        ],
        {
          renderToolHeaderExtra: (info) =>
            info.elapsed ? <span>custom {info.elapsed}</span> : null,
        },
      );
      const summary = container.querySelector('button');
      expect(summary?.textContent).not.toContain('5s');

      act(() => summary?.click());
      const content = container.querySelector(
        '[class*="chatSummaryContentClip"]',
      );
      expect(content?.className).not.toContain('chatSummaryContentCollapsed');
      expect(content?.textContent).toContain('custom 5s');

      act(() => {
        vi.advanceTimersByTime(1_000);
      });
      expect(content?.textContent).toContain('custom 6s');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not show elapsed time after a tool completes', () => {
    const container = renderToolLine(
      makeTool({
        toolName: 'ReadFile',
        status: 'completed',
        startTime: 1_000,
        endTime: 6_000,
      }),
    );

    expect(container.textContent).not.toContain('5s');
  });

  it('keeps completed elapsed data available to custom header renderers', () => {
    const container = renderToolLine(
      makeTool({
        toolName: 'ReadFile',
        status: 'completed',
        startTime: 1_000,
        endTime: 6_000,
      }),
      {},
      { renderToolHeaderExtra: (info) => <span>{info.elapsed}</span> },
    );

    expect(container.textContent).toContain('5s');
  });

  it.each([
    ['completed', undefined],
    ['failed', 'Agent process failed'],
  ] as const)('shows meta for a %s agent', (status, reason) => {
    const container = renderToolLine(
      makeTool({
        toolName: 'Task',
        status,
        startTime: 1_000,
        endTime: 6_000,
        rawOutput: {
          type: 'task_execution',
          executionSummary: { outputTokens: 1_200 },
          reason,
        },
      }),
    );

    expect(container.textContent).toContain('5s');
    expect(container.textContent).toContain('1.2k tokens');
    if (reason) expect(container.textContent).toContain(reason);
  });

  it('shows a tool-kind icon on every expanded group row', () => {
    const container = renderToolGroup([
      makeTool({ callId: 'read', toolName: 'ReadFile' }),
      makeTool({ callId: 'edit', toolName: 'edit' }),
    ]);
    const summary = container.querySelector('button');
    act(() => summary?.click());

    const rows = container.querySelectorAll(
      '[class*="chatSummaryGroup"] [class*="lineMain"]',
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(
        row.querySelector('svg[class*="chatSummaryToolIcon"]'),
      ).not.toBeNull();
    }
  });

  it('keeps the failed label out of the collapsed chat summary', () => {
    const container = renderToolGroup([
      makeTool({ toolName: 'Shell', status: 'failed' }),
    ]);

    const summary = container.querySelector('button');
    expect(summary?.textContent).toContain('Shell');
    expect(summary?.textContent).not.toContain('Failed');
    expect(summary?.querySelector('[class*="iconError"]')).toBeNull();
  });

  it('shows the error icon in a failed tool line header', () => {
    const container = renderToolLine(
      makeTool({ toolName: 'Shell', status: 'failed' }),
    );

    const errorIcon = container.querySelector('[class*="iconError"]');
    expect(errorIcon).not.toBeNull();
    expect(errorIcon?.getAttribute('role')).toBe('img');
    expect(errorIcon?.getAttribute('aria-label')).toBe('Failed');
    expect(errorIcon?.querySelector('svg')).not.toBeNull();
    expect(container.textContent).not.toContain('Failed');
  });

  it('shows an error icon instead of the failed label on expanded tool rows', () => {
    const container = renderToolGroup([
      makeTool({
        toolName: 'Shell',
        status: 'failed',
        content: [{ type: 'content', content: { text: 'boom' } }],
      }),
      makeTool({ callId: 'call-2', toolName: 'Grep', status: 'completed' }),
    ]);

    const summary = container.querySelector('button') as HTMLButtonElement;
    act(() => summary.click());

    const errorIcon = container.querySelector('[class*="iconError"]');
    expect(errorIcon).not.toBeNull();
    expect(errorIcon?.querySelector('svg')).not.toBeNull();
    expect(errorIcon?.textContent).not.toContain('Failed');
  });

  it('shows an error icon in the expanded single-tool card title', () => {
    const container = renderToolGroup([
      makeTool({
        toolName: 'Shell',
        status: 'failed',
        content: [{ type: 'content', content: { text: 'boom' } }],
      }),
    ]);

    const summary = container.querySelector('button') as HTMLButtonElement;
    act(() => summary.click());

    const titleRow = container.querySelector('[class*="expandedCardTitleRow"]');
    expect(titleRow).not.toBeNull();
    expect(titleRow?.querySelector('[class*="iconError"] svg')).not.toBeNull();
    expect(titleRow?.textContent).not.toContain('Failed');
  });

  it('renders no status icon in the expanded completed tool card title', () => {
    const container = renderToolGroup([
      makeTool({
        toolName: 'Shell',
        status: 'completed',
        content: [{ type: 'content', content: { text: 'ok' } }],
      }),
    ]);

    const summary = container.querySelector('button') as HTMLButtonElement;
    act(() => summary.click());

    const titleRow = container.querySelector('[class*="expandedCardTitleRow"]');
    expect(titleRow).not.toBeNull();
    expect(titleRow?.querySelector('[class*="iconError"]')).toBeNull();
  });

  it('shows an error icon in the expanded failed todo card title', () => {
    const container = renderToolGroup([
      makeTool({
        toolName: 'todo_write',
        status: 'failed',
        args: {
          todos: [{ id: '1', content: 'Check UI', status: 'in_progress' }],
        },
      }),
    ]);

    const titleRow = container.querySelector('[class*="expandedCardTitleRow"]');
    expect(titleRow).not.toBeNull();
    expect(titleRow?.querySelector('[class*="iconError"] svg')).not.toBeNull();
  });

  it('shows an error icon for a single failed read tool', () => {
    const container = renderToolGroup([
      makeTool({
        toolName: 'read_file',
        status: 'failed',
        content: [{ type: 'content', content: { text: 'Permission denied' } }],
      }),
    ]);

    const titleRow = container.querySelector('[class*="expandedCardTitleRow"]');
    expect(titleRow).not.toBeNull();
    expect(titleRow?.querySelector('[class*="iconError"] svg')).not.toBeNull();
  });

  it('shows an error icon for a single failed tool without result text', () => {
    const container = renderToolGroup([
      makeTool({ toolName: 'glob', status: 'failed' }),
    ]);

    const titleRow = container.querySelector('[class*="expandedCardTitleRow"]');
    expect(titleRow).not.toBeNull();
    expect(titleRow?.querySelector('[class*="iconError"] svg')).not.toBeNull();
  });

  it('renders ANSI shell output as styled spans instead of escape text', () => {
    const container = renderToolLine(
      makeTool({
        toolName: 'Shell',
        status: 'failed',
        content: [
          {
            type: 'content',
            content: { text: '\u001b[31mfailed\u001b[0m\nplain' },
          },
        ],
      }),
    );

    expect(container.textContent).toContain('failed');
    expect(container.textContent).not.toContain('\u001b[31m');
    expect(container.querySelector('pre span[style*="color"]')).not.toBeNull();
  });

  it('wraps a single expanded agent body in a headerless card', () => {
    const container = renderToolGroup([
      makeTool({
        toolName: 'Task',
        status: 'in_progress',
        args: { description: 'Investigate build failure' },
        subContent: 'working through the issue',
      }),
    ]);
    const summary = container.querySelector('button') as HTMLButtonElement;

    act(() => summary.click());

    const card = container.querySelector('[class*="expandedAgentCard"]');
    expect(card).not.toBeNull();
    expect(card?.textContent).toContain('working through the issue');
    expect(container.querySelector('[class*="expandedCardHeader"]')).toBeNull();
  });

  it('opens a single foreground agent from the tool summary', () => {
    const onOpen = vi.fn();
    const tool = makeTool({
      toolName: 'agent',
      status: 'completed',
      args: {
        subagent_type: 'Explore',
        run_in_background: false,
      },
      subContent: 'investigation complete',
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <I18nProvider language="en">
          <SubagentDetailsProvider onOpen={onOpen}>
            <ToolGroup tools={[tool]} />
          </SubagentDetailsProvider>
        </I18nProvider>,
      );
    });
    mounted.push({ root, container });

    const summary = container.querySelector('button') as HTMLButtonElement;
    expect(summary.hasAttribute('aria-expanded')).toBe(false);
    act(() => summary.click());

    expect(onOpen).toHaveBeenCalledWith(tool);
  });

  it('opens a running background agent from the tool summary', () => {
    const onOpen = vi.fn();
    const tool = makeTool({
      toolName: 'agent',
      status: 'pending',
      args: {
        subagent_type: 'Explore',
        run_in_background: true,
      },
      rawOutput: { type: 'task_execution', status: 'background' },
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <I18nProvider language="en">
          <SubagentDetailsProvider onOpen={onOpen}>
            <ToolGroup tools={[tool]} />
          </SubagentDetailsProvider>
        </I18nProvider>,
      );
    });
    mounted.push({ root, container });

    expect(container.textContent).toContain('background task');
    expect(container.textContent).not.toContain('running');
    expect(container.textContent).not.toMatch(/\b\d+s\b/);
    expect(
      container.querySelector('[class*="chatSummaryTextActive"]'),
    ).toBeNull();
    act(() => (container.querySelector('button') as HTMLButtonElement).click());

    expect(onOpen).toHaveBeenCalledWith(tool);
  });

  it('opens a single monitor from the tool summary', async () => {
    const onOpen = vi.fn().mockResolvedValue(true);
    const tool = makeTool({
      toolName: 'monitor',
      status: 'completed',
      args: { description: 'watch logs' },
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <I18nProvider language="en">
          <MonitorDetailsProvider onOpen={onOpen}>
            <ToolGroup tools={[tool]} />
          </MonitorDetailsProvider>
        </I18nProvider>,
      );
    });
    mounted.push({ root, container });

    const summary = container.querySelector('button') as HTMLButtonElement;
    expect(summary.hasAttribute('aria-expanded')).toBe(false);
    await act(async () => {
      summary.click();
      await Promise.resolve();
    });

    expect(onOpen).toHaveBeenCalledWith(tool);
    expect(summary.hasAttribute('aria-expanded')).toBe(false);
    expect(container.querySelector('[class*="chatChevronDown"]')).toBeNull();
    expect(
      container.querySelector('[class*="chatChevronRight"]'),
    ).not.toBeNull();
  });

  it('opens a monitor tool line from a mixed tool group', async () => {
    const onOpen = vi.fn().mockResolvedValue(true);
    const tool = makeTool({
      toolName: 'monitor',
      status: 'completed',
      args: { description: 'watch logs' },
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <I18nProvider language="en">
          <MonitorDetailsProvider onOpen={onOpen}>
            <ToolLine tool={tool} />
          </MonitorDetailsProvider>
        </I18nProvider>,
      );
    });
    mounted.push({ root, container });

    const line = container.querySelector(
      '[class*="lineExpandable"]',
    ) as HTMLElement;
    await act(async () => {
      line.click();
      await Promise.resolve();
    });

    expect(onOpen).toHaveBeenCalledWith(tool);
    expect(line.getAttribute('aria-expanded')).toBeNull();
    expect(container.querySelector('[class*="lineChevronDown"]')).toBeNull();
    expect(
      container.querySelector('[class*="lineChevronRight"]'),
    ).not.toBeNull();
  });

  it('falls back to the original summary expansion when monitor details are unavailable', async () => {
    const onOpen = vi.fn().mockResolvedValue(false);
    const tool = makeTool({
      toolName: 'monitor',
      status: 'completed',
      args: { description: 'watch logs' },
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <I18nProvider language="en">
          <MonitorDetailsProvider onOpen={onOpen}>
            <ToolGroup tools={[tool]} />
          </MonitorDetailsProvider>
        </I18nProvider>,
      );
    });
    mounted.push({ root, container });

    const summary = container.querySelector('button') as HTMLButtonElement;
    await act(async () => {
      summary.click();
      await Promise.resolve();
    });

    expect(onOpen).toHaveBeenCalledWith(tool);
    expect(summary.getAttribute('aria-expanded')).toBe('true');

    act(() => summary.click());

    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(summary.getAttribute('aria-expanded')).toBe('false');
  });

  it('resets summary expansion when the monitor identity changes', async () => {
    const onOpen = vi.fn().mockResolvedValue(false);
    const tool = makeTool({
      toolName: 'monitor',
      status: 'completed',
      args: { description: 'watch logs' },
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <I18nProvider language="en">
          <MonitorDetailsProvider onOpen={onOpen}>
            <ToolGroup tools={[tool]} />
          </MonitorDetailsProvider>
        </I18nProvider>,
      );
    });
    mounted.push({ root, container });

    const summary = container.querySelector('button') as HTMLButtonElement;
    await act(async () => {
      summary.click();
      await Promise.resolve();
    });
    expect(
      container.querySelector('[class*="chatChevronDown"]'),
    ).not.toBeNull();

    const nextTool = makeTool({
      callId: 'call-2',
      toolName: 'monitor',
      status: 'completed',
      args: { description: 'watch logs' },
    });
    act(() => {
      root.render(
        <I18nProvider language="en">
          <MonitorDetailsProvider onOpen={onOpen}>
            <ToolGroup tools={[nextTool]} />
          </MonitorDetailsProvider>
        </I18nProvider>,
      );
    });

    expect(container.querySelector('[class*="chatChevronDown"]')).toBeNull();
    expect(
      container.querySelector('[class*="chatChevronRight"]'),
    ).not.toBeNull();
  });

  it('deduplicates monitor summary clicks while details are loading', async () => {
    let resolveOpen: ((opened: boolean) => void) | undefined;
    const onOpen = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveOpen = resolve;
        }),
    );
    const tool = makeTool({
      toolName: 'monitor',
      status: 'completed',
      args: { description: 'watch logs' },
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <I18nProvider language="en">
          <MonitorDetailsProvider onOpen={onOpen}>
            <ToolGroup tools={[tool]} />
          </MonitorDetailsProvider>
        </I18nProvider>,
      );
    });
    mounted.push({ root, container });

    const summary = container.querySelector('button') as HTMLButtonElement;
    act(() => {
      summary.click();
      summary.click();
    });
    expect(onOpen).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveOpen?.(false);
      await Promise.resolve();
    });

    expect(summary.getAttribute('aria-expanded')).toBe('true');
  });

  it('falls back to the original tool-line expansion when monitor details are unavailable', async () => {
    const onOpen = vi.fn().mockResolvedValue(false);
    const tool = makeTool({
      toolName: 'monitor',
      status: 'completed',
      rawOutput: 'Monitor started',
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <I18nProvider language="en">
          <MonitorDetailsProvider onOpen={onOpen}>
            <ToolLine tool={tool} forceExpandable />
          </MonitorDetailsProvider>
        </I18nProvider>,
      );
    });
    mounted.push({ root, container });

    const line = container.querySelector(
      '[class*="lineExpandable"]',
    ) as HTMLElement;
    await act(async () => {
      line.click();
      await Promise.resolve();
    });

    expect(onOpen).toHaveBeenCalledWith(tool);
    expect(line.getAttribute('aria-expanded')).toBe('true');
  });

  it('deduplicates monitor tool-line clicks while details are loading', async () => {
    let resolveOpen: ((opened: boolean) => void) | undefined;
    const onOpen = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveOpen = resolve;
        }),
    );
    const tool = makeTool({
      toolName: 'monitor',
      status: 'completed',
      rawOutput: 'Monitor started',
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <I18nProvider language="en">
          <MonitorDetailsProvider onOpen={onOpen}>
            <ToolLine tool={tool} forceExpandable />
          </MonitorDetailsProvider>
        </I18nProvider>,
      );
    });
    mounted.push({ root, container });

    const line = container.querySelector(
      '[class*="lineExpandable"]',
    ) as HTMLElement;
    act(() => {
      line.click();
      line.click();
    });
    expect(onOpen).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveOpen?.(false);
      await Promise.resolve();
    });

    expect(line.getAttribute('aria-expanded')).toBe('true');
  });

  it('keeps a non-expandable monitor tool line static when details are unavailable', async () => {
    const onOpen = vi.fn().mockResolvedValue(false);
    const tool = makeTool({
      toolName: 'monitor',
      status: 'completed',
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <I18nProvider language="en">
          <MonitorDetailsProvider onOpen={onOpen}>
            <ToolLine tool={tool} />
          </MonitorDetailsProvider>
        </I18nProvider>,
      );
    });
    mounted.push({ root, container });

    const line = container.querySelector(
      '[class*="lineExpandable"]',
    ) as HTMLElement;
    await act(async () => {
      line.click();
      await Promise.resolve();
    });

    expect(onOpen).toHaveBeenCalledWith(tool);
    expect(line.getAttribute('role')).toBeNull();
    expect(line.getAttribute('aria-expanded')).toBeNull();
  });

  it('keeps a mixed group static when only its background agent is active', () => {
    const container = renderToolGroup([
      makeTool({ callId: 'done', toolName: 'ReadFile', status: 'completed' }),
      makeTool({
        callId: 'background',
        toolName: 'agent',
        status: 'pending',
        args: { run_in_background: true },
        rawOutput: { type: 'task_execution', status: 'background' },
      }),
    ]);

    expect(container.textContent).toContain('background task');
    expect(container.textContent).not.toContain('Running');
    expect(container.textContent).not.toMatch(/\b\d+s\b/);
    expect(
      container.querySelector('[class*="chatSummaryTextActive"]'),
    ).toBeNull();
  });

  it('keeps a mixed group animated while a foreground tool is active', () => {
    const container = renderToolGroup([
      makeTool({
        callId: 'background',
        toolName: 'agent',
        status: 'pending',
        args: { run_in_background: true },
      }),
      makeTool({
        callId: 'foreground',
        toolName: 'ReadFile',
        status: 'in_progress',
      }),
    ]);

    expect(container.textContent).toContain('Running ReadFile');
    expect(
      container.querySelector('[class*="chatSummaryTextActive"]'),
    ).not.toBeNull();
  });

  it('opens on-demand agent details without mounting inline content', () => {
    const onOpen = vi.fn();
    const tool = makeTool({
      toolName: 'agent',
      status: 'completed',
      subContent: 'large hidden result',
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <I18nProvider language="en">
          <SubagentDetailsProvider onOpen={onOpen}>
            <ToolLine tool={tool} />
          </SubagentDetailsProvider>
        </I18nProvider>,
      );
    });
    mounted.push({ root, container });

    expect(container.textContent).not.toContain('large hidden result');
    expect(container.querySelector('[class*="lineExpandable"]')?.tagName).toBe(
      'BUTTON',
    );
    act(() => {
      (
        container.querySelector('[class*="lineExpandable"]') as HTMLElement
      ).click();
    });
    expect(onOpen).toHaveBeenCalledWith(tool);
  });

  it('respects hideHeader for agent tools inside SubagentDetailsProvider', () => {
    const onOpen = vi.fn();
    const tool = makeTool({
      toolName: 'agent',
      status: 'completed',
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <I18nProvider language="en">
          <SubagentDetailsProvider onOpen={onOpen}>
            <ToolLine tool={tool} hideHeader forceExpanded />
          </SubagentDetailsProvider>
        </I18nProvider>,
      );
    });
    mounted.push({ root, container });

    expect(container.querySelector('button[class*="lineButton"]')).toBeNull();
  });

  it('keeps glob details visible in the header after expanding', () => {
    const pattern =
      '**/very-long-component-pattern-that-crosses-the-expand-threshold-*.tsx';
    const container = renderToolLine(
      makeTool({
        toolName: 'glob',
        args: {
          pattern,
          path: 'packages/web-shell/client',
        },
        content: [
          {
            type: 'content',
            content: {
              text: 'packages/web-shell/client/App.tsx',
            },
          },
        ],
      }),
    );
    const header = container.querySelector('[role="button"]') as HTMLElement;

    expect(header.textContent).toContain(pattern);
    act(() => header.click());
    expect(header.textContent).toContain(pattern);
    expect(header.textContent).toContain('packages/web-shell/client');
  });

  it('uses the shell tool name for expanded cards from action summaries', () => {
    const container = renderToolLine(
      makeTool({
        toolName: 'run_shell_command',
        args: {
          command: 'dataworks-infra workspace list',
          description: '查询用户工作空间列表',
          timeout: 30000,
        },
        content: [
          {
            type: 'content',
            content: { type: 'text', text: 'failed\nwith details' },
          },
        ],
      }),
      { summaryOnly: true },
    );
    const header = container.querySelector('[role="button"]') as HTMLElement;

    expect(header.textContent).toContain('Shell');
    expect(header.textContent).toContain('查询用户工作空间列表');

    act(() => header.click());

    const cardTitle = container.querySelector(
      '[class*="expandedCardTitleRow"] [class*="expandedCardTitle"]',
    );
    expect(cardTitle?.textContent).toBe('Shell');
  });

  it('shows complete skill content in the expanded card body', () => {
    const container = renderToolLine(
      makeTool({
        toolName: 'skill',
        title: 'Skill: Use skill: "review" with args: "check the current diff"',
        args: {
          skill: 'review',
        },
        content: [
          {
            type: 'content',
            content: {
              type: 'text',
              text: 'Base directory for this skill: /repo\n# Code Review',
            },
          },
        ],
      }),
    );
    const header = container.querySelector('[role="button"]') as HTMLElement;

    expect(header.textContent).toContain('Skill');
    expect(header.textContent).toContain('review');
    expect(header.textContent).not.toContain('check the current diff');

    act(() => header.click());

    const output = container.querySelector('pre');
    expect(output?.textContent).toBe(
      'Base directory for this skill: /repo\n# Code Review',
    );
  });

  it('keeps running state for single todo summaries', () => {
    const container = renderToolGroup([
      makeTool({
        toolName: 'todo_write',
        status: 'in_progress',
        args: {
          todos: [{ id: '1', content: 'Check UI', status: 'in_progress' }],
        },
      }),
    ]);
    const summary = container.querySelector('button');

    expect(summary?.textContent).toContain('Running');
    expect(summary?.textContent).toContain('Updated task list');
  });
});

describe('thinking rows in the compact summary', () => {
  it('shows a running summary while a thought is streaming', () => {
    const container = renderToolGroup(
      [
        makeTool({
          callId: 'tool-1',
          toolName: 'ReadFile',
          status: 'completed',
        }),
      ],
      {},
      [{ content: 'thinking about it', isStreaming: true }],
    );

    expect(container.querySelector('button')?.textContent).toContain(
      'Thinking',
    );
  });

  it('renders a completed thought line that expands its content on click', () => {
    const container = renderToolGroup(
      [
        makeTool({
          callId: 'tool-1',
          toolName: 'ReadFile',
          status: 'completed',
        }),
      ],
      {},
      [{ content: 'private chain of thought' }],
    );

    act(() => {
      container.querySelector('button')?.click();
    });
    const thoughtHeader = Array.from(
      container.querySelectorAll('[role="button"]'),
    ).find((el) =>
      (el as HTMLElement).textContent?.includes('Done thinking'),
    ) as HTMLElement;
    expect(thoughtHeader).toBeTruthy();
    // Collapsed by default; content appears on click.
    expect(container.textContent).not.toContain('private chain of thought');
    act(() => thoughtHeader.click());
    expect(container.textContent).toContain('private chain of thought');
  });

  it('keeps the single tool compact when thinking is folded in', () => {
    const container = renderToolGroup(
      [
        makeTool({
          callId: 'tool-1',
          toolName: 'ReadFile',
          status: 'completed',
          content: [
            {
              type: 'content',
              content: { type: 'text', text: 'DUMPED CONTENT' },
            },
          ],
        }),
      ],
      {},
      [{ content: 'thinking' }],
    );

    act(() => {
      container.querySelector('button')?.click();
    });
    // The single tool renders as a compact line, not a force-expanded dump.
    expect(container.textContent).not.toContain('DUMPED CONTENT');
  });

  it('renders thoughts interleaved with their tools in original order', () => {
    const container = renderToolGroup(
      [
        makeTool({
          callId: 'tool-1',
          toolName: 'ReadFile',
          status: 'completed',
        }),
        makeTool({ callId: 'tool-2', toolName: 'Glob', status: 'completed' }),
      ],
      {},
      [
        { content: 'first thought', beforeToolCallId: 'tool-1' },
        { content: 'second thought', beforeToolCallId: 'tool-2' },
      ],
    );

    act(() => {
      container.querySelector('button')?.click();
      for (const header of container.querySelectorAll('[role="button"]')) {
        (header as HTMLElement).click();
      }
    });
    const text = container.textContent ?? '';
    const positions = [
      'first thought',
      'ReadFile',
      'second thought',
      'Glob',
    ].map((marker) => text.indexOf(marker));
    expect(
      positions.every((v, i) => v >= 0 && (i === 0 || v > positions[i - 1]!)),
    ).toBe(true);
  });
});

describe('tool output logic', () => {
  it('sanitizes read-file languages before building markdown fences', () => {
    expect(languageForPath('src/App.tsx')).toBe('tsx');
    expect(languageForPath('diagram.mermaid')).toBe('text');
    expect(languageForPath('bad.weird\nlang')).toBe('text');
    expect(fencedCodeBlock('tsx', 'const fence = "~~~";')).toBe(
      '~~~~tsx\nconst fence = "~~~";\n~~~~',
    );
  });

  it('suppresses truncated session diffs from raw output', () => {
    const fullDiff = '--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new';

    expect(
      getRawFileDiff(
        makeTool({
          toolName: 'edit',
          rawOutput: { fileDiff: fullDiff },
        }),
      ),
    ).toBe(fullDiff);
    expect(
      getRawFileDiff(
        makeTool({
          toolName: 'edit',
          rawOutput: {
            fileName: '/test/file.ts',
            newContent: 'preview only',
            fileDiff: fullDiff,
            truncatedForSession: true,
          },
        }),
      ),
    ).toBe('');
  });

  it('prefers raw fileDiff over content old/new text', () => {
    const fileDiff =
      'Index: file.ts\n@@ -10,1 +10,2 @@\n old context\n+precise line';

    expect(
      extractDiff(
        makeTool({
          toolName: 'edit',
          content: [
            {
              type: 'diff',
              oldText: 'full old text',
              newText: 'full new text',
            },
          ],
          rawOutput: {
            fileDiff,
            fileName: 'file.ts',
            originalContent: 'full old text',
            newContent: 'full new text',
          },
        }),
      ),
    ).toBe(fileDiff);
  });

  it('builds a unified diff for changed content blocks', () => {
    expect(buildUnifiedDiff('same\nold', 'same\nnew')).toBe(
      ' same\n-old\n+new',
    );
  });
});
