// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { DaemonSessionContextUsageStatus } from '@qwen-code/web-shell/daemon-react-sdk';
import { I18nProvider } from '../../i18n';
import { ContextUsageMessage } from './ContextUsageMessage';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

function makeStatus(
  totalTokens: number,
  isEstimated: boolean,
): DaemonSessionContextUsageStatus {
  return {
    v: 1,
    sessionId: 'session-1',
    workspaceCwd: '/workspace',
    formattedText: '',
    usage: {
      modelName: 'test-model',
      totalTokens,
      contextWindowSize: 100,
      breakdown: {
        systemPrompt: 20,
        builtinTools: 10,
        mcpTools: 0,
        memoryFiles: 5,
        skills: 5,
        messages: Math.max(0, totalTokens - 40),
        freeSpace: Math.max(0, 100 - totalTokens),
        autocompactBuffer: 10,
      },
      builtinTools: [],
      mcpTools: [],
      memoryFiles: [],
      skills: [],
      isEstimated,
    },
  };
}

function render(
  status: DaemonSessionContextUsageStatus,
  compact?: boolean,
  detailNameMaxLen?: number,
): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <I18nProvider language="en">
        <ContextUsageMessage
          status={status}
          {...(compact === undefined ? {} : { compact })}
          {...(detailNameMaxLen === undefined ? {} : { detailNameMaxLen })}
        />
      </I18nProvider>,
    );
  });
  mounted.push({ root, container });
  return container;
}

describe('ContextUsageMessage', () => {
  it('keeps numeric usage visible when the provider count is estimated', () => {
    const container = render(makeStatus(120, true));

    expect(container.textContent).toContain(
      'Token usage is estimated until provider usage is received.',
    );
    expect(container.textContent).toContain('Context exceeds limit!');
    expect(container.textContent).toContain('Used');
    expect(container.textContent).toContain('Messages');
    expect(container.querySelector('[aria-hidden="true"]')).not.toBeNull();
  });

  it('escalates the progress-bar color at the shared thresholds', () => {
    // The panel and the composer ring consume the same threshold helper;
    // this pins the panel half of that contract (the ring half lives in
    // ChatEditor.test.tsx). Both thresholds are strict `>`.
    const filledClass = (container: HTMLElement) =>
      container
        .querySelector('[aria-hidden="true"]')!
        .querySelector('span')!
        .getAttribute('class') ?? '';

    expect(filledClass(render(makeStatus(60, false)))).toContain('accent');
    expect(filledClass(render(makeStatus(61, false)))).toContain('warning');
    expect(filledClass(render(makeStatus(80, false)))).toContain('warning');
    expect(filledClass(render(makeStatus(81, false)))).toContain('error');
  });

  it('renders the compact meter in legend order with threshold colors', () => {
    const container = render(makeStatus(60, false), true);
    const spans = Array.from(
      container.querySelectorAll('[aria-hidden="true"] > span'),
    ) as HTMLSpanElement[];

    const [used, free, buffer] = spans;
    expect(used.style.width).toBe('60%');
    expect(used.style.background).toBe('var(--agent-blue-500)');
    expect(free.style.width).toBe('30%');
    expect(buffer.style.width).toBe('10%');
    expect(buffer.style.background).toBe('var(--warning-color)');

    // The meter order and the legend order must agree.
    const labels = Array.from(
      container.querySelectorAll('[class*="row"] [class*="label"]'),
    ).map((node) => node.textContent);
    expect(labels.slice(0, 3)).toEqual(['Used', 'Free', 'Autocompact buffer']);

    const first = (root: HTMLElement) =>
      (root.querySelector('[aria-hidden="true"] > span') as HTMLSpanElement)
        .style.background;
    expect(first(render(makeStatus(61, false), true))).toBe(
      'var(--warning-color)',
    );
    expect(first(render(makeStatus(81, false), true))).toBe(
      'var(--error-color)',
    );
  });

  it('keeps the transcript glyph track at exactly 56 cells', () => {
    const container = render(makeStatus(60, false));
    const [used, free, buffer] = Array.from(
      container.querySelectorAll('[aria-hidden="true"] > span'),
    ).map((node) => node.textContent?.length ?? 0);
    expect(used).toBe(34);
    expect(free).toBe(16);
    expect(buffer).toBe(6);
  });

  it('suppresses its own title in compact mode so the panel toolbar is the only heading', () => {
    const compactContainer = render(makeStatus(60, false), true);
    expect(compactContainer.querySelector('[class*="title"]')).toBeNull();
    expect(compactContainer.querySelector('[class*="compact"]')).not.toBeNull();

    const normalContainer = render(makeStatus(60, false));
    expect(normalContainer.querySelector('[class*="title"]')).not.toBeNull();
  });

  it('keeps full detail names only when the caller opts out of the cap', () => {
    const status = makeStatus(60, false);
    const longName = 'mcp__github__create_repository_issue';
    status.usage.showDetails = true;
    status.usage.builtinTools = [{ name: longName, tokens: 10 }];

    const uncappedContainer = render(status, true, Infinity);
    expect(uncappedContainer.textContent).toContain(longName);
    expect(uncappedContainer.textContent).not.toContain('…');

    // Both the transcript default and an unpinned compact caller keep the
    // cap; ContextUsagePanel.test.tsx pins that the panel passes the opt-out.
    for (const container of [render(status, true), render(status)]) {
      expect(container.textContent).not.toContain(longName);
      expect(container.textContent).toContain('mcp__github__create_repositor…');
    }
  });

  it('uses the pre-conversation view before any token count is available', () => {
    const container = render(makeStatus(0, true));

    expect(container.textContent).toContain('No API response yet.');
    expect(container.textContent).toContain(
      'Estimated pre-conversation overhead',
    );
    expect(container.textContent).not.toContain('Messages');
    expect(container.textContent).not.toContain('Used');
    expect(container.querySelector('[aria-hidden="true"]')).toBeNull();
  });
});
