// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ACPToolCall } from '../../adapters/types';
import { I18nProvider } from '../../i18n';
import { WebShellCustomizationProvider } from '../../customization';
import { TranscriptRenderModeProvider } from '../../transcriptRenderMode';
import { SubagentDetailsProvider } from '../../subagentDetailsContext';

vi.mock('../../App', async () => {
  const { createContext } = await import('react');
  return {
    CompactModeContext: createContext(false),
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
  hasActiveTool,
  hasExpandableContent,
  isActiveToolStatus,
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
): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <I18nProvider language="en">
        <ToolLine tool={tool} {...props} />
      </I18nProvider>,
    );
  });
  mounted.push({ root, container });
  return container;
}

function renderToolGroup(
  tools: ACPToolCall[],
  customization = {},
): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <I18nProvider language="en">
        <WebShellCustomizationProvider value={customization}>
          <ToolGroup tools={tools} />
        </WebShellCustomizationProvider>
      </I18nProvider>,
    );
  });
  mounted.push({ root, container });
  return container;
}

const t = (key: string, values?: Record<string, string | number>): string => {
  if (key === 'toolGroup.running') {
    return `Running ${values?.name ?? 'tool'}${values?.duration ? ` ${values.duration}` : ''}${
      Number(values?.count ?? 0) > 1 ? ` · ${values?.count ?? 0} tools` : ''
    }`;
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
  it('detects active tool statuses', () => {
    expect(isActiveToolStatus('pending')).toBe(true);
    expect(isActiveToolStatus('in_progress')).toBe(true);
    expect(isActiveToolStatus('running')).toBe(true);
    expect(isActiveToolStatus('completed')).toBe(false);
    expect(isActiveToolStatus('failed')).toBe(false);
  });

  it('uses the active tool in running summaries', () => {
    const tools = [
      makeTool({ callId: 'done', status: 'completed' }),
      makeTool({
        callId: 'active',
        toolName: 'ReadFile',
        status: 'in_progress',
      }),
    ];

    expect(hasActiveTool(tools)).toBe(true);
    expect(getActiveTool(tools).callId).toBe('active');
    expect(formatToolGroupSummary(tools, t)).toBe('Running ReadFile · 2 tools');
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

    expect(hasActiveTool(tools)).toBe(false);
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
  it('shows failed status in the collapsed chat summary', () => {
    const container = renderToolGroup([
      makeTool({ toolName: 'Shell', status: 'failed' }),
    ]);

    expect(container.querySelector('button')?.textContent).toContain('Failed');
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

    const cardTitle = container.querySelector('[class*="expandedCardTitle"]');
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
