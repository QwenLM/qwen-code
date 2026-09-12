// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
        freeSpace: Math.max(0, 90 - totalTokens),
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
  onShowDetail?: () => void,
): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <I18nProvider language="en">
        <ContextUsageMessage
          status={status}
          onShowDetail={onShowDetail}
          {...(compact === undefined ? {} : { compact })}
        />
      </I18nProvider>,
    );
  });
  mounted.push({ root, container });
  return container;
}

describe('ContextUsageMessage', () => {
  it('separates remaining capacity from free space and clamps exhausted capacity', () => {
    const container = render(makeStatus(60, false));
    expect(container.querySelector('[class*="total"]')?.textContent).toBe(
      '60 / 100 tokens',
    );
    expect(container.querySelector('[class*="remaining"]')?.textContent).toBe(
      'Remaining 40',
    );
    expect(container.textContent).toContain('Free 30 (30.0%)');
    expect(
      render(makeStatus(150, false)).querySelector('[class*="remaining"]')
        ?.textContent,
    ).toBe('Remaining 0');
  });

  it('keeps category totals and details together without repeated labels', () => {
    const status = makeStatus(60, false);
    status.usage.showDetails = true;
    status.usage.builtinTools = [{ name: 'read_file', tokens: 10 }];
    const container = render(status, true);
    const advanced = container.querySelector('details')!;
    expect(advanced.open).toBe(false);
    const category = advanced.querySelector('details')!;
    expect(category.querySelector('summary')?.textContent).toContain(
      '10 (10.0%)',
    );
    expect(category.textContent).toContain('read_file');
    expect(container.textContent?.match(/Built-in tools/g)).toHaveLength(1);
  });

  it('labels historical readings and lets a detailed snapshot request current context', () => {
    const status = makeStatus(60, false);
    status.usage.showDetails = true;
    const read = vi.fn();
    const container = render(status, false, read);
    expect(container.textContent).toContain('Snapshot');
    const button = container.querySelector('button')!;
    expect(button.textContent).toBe('View current context');
    act(() => button.click());
    expect(read).toHaveBeenCalledOnce();
    expect(status.usage.totalTokens).toBe(60);
    expect(container.querySelector('[class*="remaining"]')?.textContent).toBe(
      'Remaining 40',
    );
  });

  it('keeps numeric usage visible when the provider count is estimated', () => {
    const container = render(makeStatus(120, true));

    expect(container.textContent).toContain(
      'Token usage is estimated until provider usage is received.',
    );
    expect(container.textContent).toContain('Context exceeds limit!');
    expect(container.textContent).toContain('Used');
    expect(container.textContent).toContain('Messages');
    expect(
      container.querySelector('[data-web-shell-context-meter]'),
    ).not.toBeNull();
  });

  it.each([false, true])(
    'renders a proportional meter in legend order (compact=%s)',
    (compact) => {
      const container = render(makeStatus(60, false), compact);
      const spans = Array.from(
        container.querySelectorAll('[data-web-shell-context-meter] > span'),
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
      expect(labels.slice(0, 3)).toEqual([
        'Used',
        'Free',
        'Autocompact buffer',
      ]);
      const symbols = Array.from(
        container.querySelectorAll('[class*="row"] > [class*="symbol"]'),
        (node) => node.className,
      );
      expect(symbols[0]).toMatch(/accent/);
      expect(symbols[1]).toMatch(/secondary/);
      expect(symbols[2]).toMatch(/warning/);

      expect(
        Array.from(
          container.querySelectorAll('[class*="row"] [class*="value"]'),
          (node) => node.textContent,
        ).slice(0, 3),
      ).toEqual(['60 (60.0%)', '30 (30.0%)', '10 (10.0%)']);
      const first = (root: HTMLElement) =>
        (
          root.querySelector(
            '[data-web-shell-context-meter] > span',
          ) as HTMLSpanElement
        ).style.background;
      expect(first(render(makeStatus(61, false), compact))).toBe(
        'var(--warning-color)',
      );
      expect(first(render(makeStatus(81, false), compact))).toBe(
        'var(--error-color)',
      );
    },
  );

  it('caps the meter while showing real overflow in the transcript heading', () => {
    const container = render(makeStatus(150, false));
    expect(
      container.querySelector('[class*="row"] > [class*="symbol"]')?.className,
    ).toMatch(/error/);
    expect(container.querySelector('[class*="percentage"]')?.textContent).toBe(
      '150.0%',
    );
    expect(
      container
        .querySelector('[class*="percentage"]')
        ?.getAttribute('data-level'),
    ).toBe('error');
    expect(
      render(makeStatus(61, false))
        .querySelector('[class*="percentage"]')
        ?.getAttribute('data-level'),
    ).toBe('warning');
    const segments = container.querySelectorAll<HTMLSpanElement>(
      '[data-web-shell-context-meter] > span',
    );
    expect(Array.from(segments, (segment) => segment.style.width)).toEqual([
      '100%',
      '0%',
      '0%',
    ]);
  });

  it('suppresses its own title in compact mode so the panel toolbar is the only heading', () => {
    const compactContainer = render(makeStatus(60, false), true);
    expect(compactContainer.querySelector('[class*="title"]')).toBeNull();
    expect(compactContainer.querySelector('section[aria-label]')).toBeNull();
    expect(compactContainer.querySelector('section[role]')).toBeNull();
    expect(compactContainer.querySelector('[class*="compact"]')).not.toBeNull();

    const normalContainer = render(makeStatus(60, false));
    expect(normalContainer.querySelector('[class*="title"]')).not.toBeNull();
    expect(
      normalContainer
        .querySelector('section[aria-label]')
        ?.getAttribute('aria-label'),
    ).toBe('Context Usage');
  });

  it('uses named groups for repeated transcript readings without adding landmarks', () => {
    for (const container of [
      render(makeStatus(60, false)),
      render(makeStatus(60, false)),
    ]) {
      const card = container.querySelector('section')!;
      expect(card.getAttribute('role')).toBe('group');
      expect(card.getAttribute('aria-label')).toBe('Context Usage');
    }
  });

  it('renders full names in sidebar and transcript details', () => {
    const status = makeStatus(60, false);
    const longName = 'mcp__github__create_repository_issue';
    status.usage.showDetails = true;
    status.usage.builtinTools = [{ name: longName, tokens: 10 }];
    for (const compact of [true, false]) {
      const container = render(status, compact);
      expect(container.textContent).toContain(longName);
      const group = container.querySelector('details details')!;
      expect(group.open).toBe(!compact);
      expect(group.querySelector('summary')?.textContent).toBe(
        'Built-in tools 10 (10.0%)',
      );
      expect(container.querySelector('[title]')?.getAttribute('title')).toBe(
        longName,
      );
    }
  });

  it('offers a detail action only when its caller supports it', () => {
    const onShowDetail = vi.fn();
    const status = makeStatus(60, false);
    const container = render(status, false, onShowDetail);
    const button = container.querySelector('button')!;
    expect(button.textContent).toBe('View details');
    act(() => button.click());
    expect(onShowDetail).toHaveBeenCalledTimes(1);
    const readOnly = render(status);
    expect(readOnly.querySelector('button')).toBeNull();
    expect(readOnly.textContent).toContain(
      'Run /context detail for per-item breakdown.',
    );
  });

  it('uses the pre-conversation view before any token count is available', () => {
    const container = render(makeStatus(0, true));

    expect(container.textContent).toContain('No API response yet.');
    expect(container.textContent).toContain(
      'Estimated pre-conversation overhead',
    );
    expect(container.textContent).not.toContain('Messages');
    expect(container.textContent).not.toContain('Used');
    expect(
      container.querySelector('[data-web-shell-context-meter]'),
    ).toBeNull();
  });
});
