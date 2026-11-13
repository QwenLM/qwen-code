// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { I18nProvider } from '../../i18n';
import { GoalStatusMessage } from './GoalStatusMessage';

it('starts compact and toggles the complete objective and check reason', () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const condition = 'Generate ideas\nPreserve the complete objective.';
  try {
    act(() => {
      root.render(
        <I18nProvider language="zh-CN">
          <GoalStatusMessage
            status={{
              kind: 'achieved',
              condition,
              iterations: 4,
              durationMs: 60_000,
              lastReason: 'Output was written and read back.',
            }}
          />
        </I18nProvider>,
      );
    });
    const toggle = container.querySelector('button')!;
    expect(container.textContent).toContain('目标已达成');
    expect(container.textContent).toContain('4 轮');
    expect(container.textContent).toContain('1m 0s');
    expect(toggle.textContent).toBe('展开详情');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(container.textContent).not.toContain('Output was written');

    act(() => toggle.click());
    expect(toggle.textContent).toBe('收起详情');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const details = document.getElementById(
      toggle.getAttribute('aria-controls')!,
    )!;
    expect(details.firstElementChild?.textContent).toBe(condition);
    expect(details.textContent).toContain(
      '上次检查: Output was written and read back.',
    );

    act(() => toggle.click());
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(container.textContent).not.toContain('Output was written');
    expect(container.textContent).toContain(condition);
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
