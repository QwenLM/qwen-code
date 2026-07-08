// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '../../../i18n';
import type { ACPToolCall } from '../../../adapters/types';
import { formatTimestamp } from '../../MessageTimestamp';

// SubAgentPanel pulls in ToolGroup, which imports App only for
// CompactModeContext; loading the real App module would drag the whole
// application graph into this unit test.
vi.mock('../../../App', async () => {
  const { createContext } = await import('react');
  return { CompactModeContext: createContext(false) };
});

const { SubAgentPanel } = await import('./SubAgentPanel');

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

function renderPanel(tool: ACPToolCall): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <I18nProvider language="en">
        <SubAgentPanel tool={tool} defaultExpanded inline hideHeader />
      </I18nProvider>,
    );
  });
  mounted.push({ root, container });
  return container;
}

function makeAgentWithSubTool(subTool: ACPToolCall): ACPToolCall {
  return {
    callId: 'agent-1',
    toolName: 'Task',
    status: 'completed',
    args: { description: 'demo agent' },
    subTools: [subTool],
  };
}

describe('SubAgentPanel sub-tool timestamps', () => {
  it('renders completed result content through assistant markdown', () => {
    const container = renderPanel({
      callId: 'agent-1',
      toolName: 'Task',
      status: 'completed',
      rawOutput: {
        type: 'task_execution',
        result: '**done**',
      },
    });
    const markdown = container.querySelector(
      '[data-markdown-source="assistant"]',
    );
    expect(markdown).not.toBeNull();
    expect(markdown?.querySelector('strong')?.textContent).toBe('done');
  });

  it('renders each sub-tool start time, like the main transcript rows', () => {
    // A past date so formatTimestamp always renders the dated form; the
    // expectation is derived from the same formatter, so it matches
    // regardless of the test machine's clock or timezone.
    const startTime = new Date('2020-01-02T03:04:05').getTime();
    const container = renderPanel(
      makeAgentWithSubTool({
        callId: 'sub-1',
        toolName: 'Read',
        status: 'completed',
        startTime,
      }),
    );
    expect(container.textContent).toContain(formatTimestamp(startTime));
  });

  it('renders a sub-tool without a start time unchanged (no time shown)', () => {
    const reference = new Date('2020-01-02T03:04:05').getTime();
    const container = renderPanel(
      makeAgentWithSubTool({
        callId: 'sub-1',
        toolName: 'Read',
        status: 'completed',
      }),
    );
    expect(container.textContent).not.toContain(formatTimestamp(reference));
  });

  it('keeps sub-tools expandable while hiding their collapsed output summary', () => {
    const container = renderPanel(
      makeAgentWithSubTool({
        callId: 'sub-1',
        toolName: 'Shell',
        status: 'completed',
        args: { command: 'npm test' },
        content: [
          {
            type: 'content',
            content: { text: 'first line\nsecond line' },
          },
        ],
      }),
    );
    const row = Array.from(container.querySelectorAll('[role="button"]')).find(
      (el) => el.textContent?.includes('Shell'),
    ) as HTMLElement | undefined;

    expect(row).toBeDefined();
    expect(row!.textContent).toContain('npm test');
    expect(container.textContent).not.toContain('first line');
    act(() => row!.click());
    expect(container.textContent).toContain('first line');
    expect(container.textContent).toContain('second line');
  });

  it('hides non-standard sub-tool summaries until the row is expanded', () => {
    const container = renderPanel(
      makeAgentWithSubTool({
        callId: 'sub-1',
        toolName: 'list_directory',
        status: 'completed',
        rawOutput: 'src\npackage.json',
      }),
    );
    const row = Array.from(container.querySelectorAll('[role="button"]')).find(
      (el) => el.textContent?.includes('ListFiles'),
    ) as HTMLElement | undefined;

    expect(row).toBeDefined();
    expect(container.textContent).not.toContain('2 item(s)');
    act(() => row!.click());
    expect(container.textContent).toContain('2 item(s)');
  });
});
