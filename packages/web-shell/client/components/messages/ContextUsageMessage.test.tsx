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
  language: 'en' | 'zh-CN' = 'en',
): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <I18nProvider language={language}>
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
  it.each(['en', 'zh-CN'] as const)(
    'keeps the skill listing row separate from its loaded body cost (%s)',
    (language) => {
      const status = makeStatus(60, false);
      status.usage.showDetails = true;
      const name = 'agent-reproduce-feature';
      status.usage.skills = [{ name, tokens: 2, loaded: true, bodyTokens: 3 }];
      const container = render(status, false, undefined, language);
      const label = language === 'en' ? 'body loaded' : '已加载正文';
      const nameElement = container.querySelector(`[title="${name}"]`)!;
      expect(nameElement.textContent).toBe(name);
      expect(nameElement.parentElement?.textContent).toContain('2');
      const skillBlock = nameElement.parentElement!.parentElement!;
      expect(skillBlock.textContent?.split(label)).toHaveLength(2);
      expect(skillBlock.textContent).toContain('+3');
    },
  );

  it.each(['en', 'zh-CN'] as const)(
    'toggles only the snapshot body without requesting context (%s)',
    (language) => {
      const read = vi.fn();
      const container = render(makeStatus(60, false), false, read, language);
      const card = container.querySelector('section')!;
      const toggle = container.querySelector<HTMLButtonElement>(
        'button[aria-expanded]',
      )!;
      const meter = container.querySelector('[data-web-shell-context-meter]');
      expect(toggle).not.toBeNull();
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      expect(toggle.getAttribute('aria-label')).toBe(
        language === 'en' ? 'Collapse' : '收起',
      );
      act(() => toggle.click());
      expect(card.getAttribute('data-collapsed')).toBe('true');
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      expect(toggle.getAttribute('aria-label')).toBe(
        language === 'en' ? 'Expand' : '展开',
      );
      act(() => toggle.click());
      expect(card.getAttribute('data-collapsed')).toBe('false');
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      expect(container.querySelector('[data-web-shell-context-meter]')).toBe(
        meter,
      );
      expect(read).not.toHaveBeenCalled();
    },
  );

  it('shows the cached prefix, startup context and unattributed rows only when present (#12235)', () => {
    const status = makeStatus(60, false);
    // Rows still sum to the total: 20 + 10 + 5 + 5 + 12 + 8 = 60.
    Object.assign(status.usage.breakdown, {
      messages: 0,
      startupContext: 12,
      unattributed: 8,
      cachedTokens: 30,
    });
    const text = render(status).textContent;
    expect(text).toContain('Cached prefix 30 (30.0%)');
    expect(text).toContain('Startup context 12 (12.0%)');
    expect(text).toContain('Unattributed 8 (8.0%)');

    const plain = render(makeStatus(60, false)).textContent;
    expect(plain).not.toContain('Cached prefix');
    expect(plain).not.toContain('Startup context');
    expect(plain).not.toContain('Unattributed');
  });

  it('shows an estimated history as messages when the provider total is gone (#12235)', () => {
    const status = makeStatus(0, true);
    status.usage.breakdown.messages = 25;
    const text = render(status).textContent;
    expect(text).toContain('Messages 25 (25.0%)');
    // The captions follow the row. This case renders the EN catalog only:
    // `render(status)` leaves `language` at its `'en'` default, so the zh-CN
    // copies of these two captions are not asserted here.
    expect(text).toContain('The estimates below include the conversation.');
    expect(text).toContain('Estimated usage, including the conversation');
    expect(text).not.toContain('excluding conversation messages');
    expect(render(makeStatus(0, true)).textContent).not.toContain('Messages');
  });

  it('orders skill rows by size whether `loaded` is false or absent (#12235)', () => {
    // `loaded?: boolean` is optional on the daemon payload, so an older client
    // omits it. Absent and `false` are the same state — not loaded — so the
    // pair must order by token cost, not by payload order.
    const small = { name: 'small-skill', tokens: 2, loaded: false };
    const big = { name: 'big-skill', tokens: 5 };
    for (const skills of [
      [small, big],
      [big, small],
    ]) {
      const status = makeStatus(60, false);
      status.usage.showDetails = true;
      status.usage.skills = skills;
      const text = render(status).textContent ?? '';
      expect(text).toContain('big-skill');
      expect(text.indexOf('big-skill')).toBeLessThan(
        text.indexOf('small-skill'),
      );
    }
  });

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
    const button = container.querySelector('button:not([aria-expanded])')!;
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
    expect(compactContainer.querySelector('button[aria-expanded]')).toBeNull();
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
    const button = container.querySelector('button:not([aria-expanded])')!;
    expect(button.textContent).toBe('View details');
    act(() => button.click());
    expect(onShowDetail).toHaveBeenCalledTimes(1);
    const readOnly = render(status);
    expect(readOnly.querySelector('button:not([aria-expanded])')).toBeNull();
    expect(readOnly.textContent).toContain(
      'Run /context detail for per-item breakdown.',
    );
  });

  it.each(['en', 'zh-CN'] as const)(
    'explains unknown usage without assuming an empty conversation (%s)',
    (language) => {
      for (const compact of [false, true]) {
        const container = render(
          makeStatus(0, true),
          compact,
          undefined,
          language,
        );
        expect(container.textContent).toContain(
          language === 'en'
            ? 'Current context usage is unavailable. The estimates below cover base overhead only, excluding conversation messages.'
            : '当前上下文用量暂不可用。下方仅为基础开销估算，不含对话消息。',
        );
        expect(
          container.querySelector('[class*="sectionTitle"]')?.textContent,
        ).toBe(language === 'en' ? 'Estimated base overhead' : '基础开销估算');
        expect(container.querySelector('[class*="total"]')).toBeNull();
        expect(container.querySelector('[class*="remaining"]')).toBeNull();
        expect(
          container.querySelector('[data-web-shell-context-meter]'),
        ).toBeNull();
      }
    },
  );
});
