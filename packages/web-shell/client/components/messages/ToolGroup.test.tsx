import { describe, expect, it, vi } from 'vitest';
import type { DaemonSettingDescriptor } from '@qwen-code/webui/daemon-react-sdk';
import type { ACPToolCall } from '../../adapters/types';

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
  formatToolGroupSummary,
  getActiveTool,
  getRawFileDiff,
  getToolHeaderKind,
  hasActiveTool,
  isActiveToolStatus,
  isWebFetchToolName,
  resolveShellOutputMaxLines,
  shouldAutoExpand,
} = await import('./ToolGroup');

function makeTool(overrides: Partial<ACPToolCall> = {}): ACPToolCall {
  return {
    callId: 'call-1',
    toolName: 'Shell',
    status: 'completed',
    ...overrides,
  };
}

const t = (key: string, values?: Record<string, string | number>): string => {
  if (key === 'toolGroup.running') {
    return `Running ${values?.name ?? 'tool'}${
      Number(values?.count ?? 0) > 1 ? ` · ${values?.count ?? 0} tools` : ''
    }`;
  }
  if (key === 'toolGroup.summary') {
    return `Ran ${values?.count ?? 0} tool${values?.count === 1 ? '' : 's'}`;
  }
  return key;
};

const zhT = (key: string, values?: Record<string, string | number>): string => {
  if (key === 'toolName.readfile') return '读取文件';
  return t(key, values);
};

function setting(value: unknown): DaemonSettingDescriptor {
  return {
    key: 'ui.shellOutputMaxLines',
    type: 'number',
    label: 'Shell output max lines',
    category: 'ui',
    requiresRestart: false,
    default: 5,
    values: { effective: value },
  };
}

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

  it('falls back to a completed summary without tool names', () => {
    const tools = [
      makeTool({ callId: 'shell', status: 'completed' }),
      makeTool({ callId: 'read', toolName: 'ReadFile', status: 'completed' }),
    ];

    expect(hasActiveTool(tools)).toBe(false);
    expect(getActiveTool(tools).callId).toBe('read');
    expect(formatToolGroupSummary(tools, t)).toBe('Ran 2 tools');
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

describe('tool output logic', () => {
  it('resolves shell output max lines from settings', () => {
    expect(resolveShellOutputMaxLines([])).toBe(5);
    expect(resolveShellOutputMaxLines([setting(12)])).toBe(12);
    expect(resolveShellOutputMaxLines([setting(2.8)])).toBe(2);
    expect(resolveShellOutputMaxLines([setting(-1)])).toBe(0);
    expect(resolveShellOutputMaxLines([setting('bad')])).toBe(5);
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

  it('builds a unified diff for changed content blocks', () => {
    expect(buildUnifiedDiff('same\nold', 'same\nnew')).toBe(
      ' same\n-old\n+new',
    );
  });
});
