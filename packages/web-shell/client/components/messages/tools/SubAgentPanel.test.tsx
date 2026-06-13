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
});
