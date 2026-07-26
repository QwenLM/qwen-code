// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '../../i18n';
import { TranscriptRenderModeProvider } from '../../transcriptRenderMode';
import { serializeGoalStatusMessage } from './GoalStatusMessage';
import { SystemMessage } from './SystemMessage';

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

function render(node: ReactNode): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<I18nProvider language="en">{node}</I18nProvider>);
  });
  mounted.push({ root, container });
  return container;
}

describe('SystemMessage — prompt_cancelled marker', () => {
  it('renders the user-cancelled marker as a status region', () => {
    const container = render(
      <SystemMessage content="" variant="info" source="prompt_cancelled" />,
    );
    const status = container.querySelector('[role="status"]');
    expect(status).not.toBeNull();
    expect(status?.textContent).toBe('You cancelled this request');
  });

  it('ignores message content when rendering the cancelled marker', () => {
    const container = render(
      <SystemMessage
        content="raw daemon text that must not leak"
        variant="info"
        source="prompt_cancelled"
      />,
    );
    expect(container.textContent).toBe('You cancelled this request');
    expect(container.textContent).not.toContain('raw daemon text');
  });

  it('renders a normal message without the status marker for other sources', () => {
    const container = render(
      <SystemMessage content="a plain note" variant="error" />,
    );
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.textContent).toContain('a plain note');
  });
});

describe('SystemMessage — goal status activation', () => {
  const content = serializeGoalStatusMessage({
    kind: 'set',
    condition: 'Ship safely',
    setAt: 1,
  });

  it('keeps the existing interactive event behavior by default', () => {
    const handler = vi.fn();
    window.addEventListener('web-shell-goal-status-active', handler);
    const container = render(
      <SystemMessage content={content} variant="info" isLatest />,
    );
    expect(container.textContent).toContain('Ship safely');
    expect(handler).toHaveBeenCalledOnce();
    window.removeEventListener('web-shell-goal-status-active', handler);
  });

  it('does not dispatch the goal event in readonly mode', () => {
    const handler = vi.fn();
    window.addEventListener('web-shell-goal-status-active', handler);
    const container = render(
      <TranscriptRenderModeProvider value="readonly">
        <SystemMessage content={content} variant="info" isLatest />
      </TranscriptRenderModeProvider>,
    );
    expect(container.textContent).toContain('Ship safely');
    expect(handler).not.toHaveBeenCalled();
    window.removeEventListener('web-shell-goal-status-active', handler);
  });
});
