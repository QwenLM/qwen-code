// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { I18nProvider } from '../../i18n';
import { SessionGroupSection } from './SessionGroupSection';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('SessionGroupSection', () => {
  it('renders a supplied source icon instead of a color dot', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <I18nProvider language="en">
          <SessionGroupSection
            id="scheduled-task:task-1"
            label="Review PRs"
            count={1}
            expanded
            icon={<svg data-testid="scheduled-task-icon" />}
            onToggle={() => {}}
          >
            <div>Run 1</div>
          </SessionGroupSection>
        </I18nProvider>,
      );
    });

    expect(
      container.querySelector('[data-testid="scheduled-task-icon"]'),
    ).not.toBeNull();
    expect(container.querySelector('[class*="sessionGroupDot"]')).toBeNull();
    act(() => root.unmount());
    container.remove();
  });

  it('expands ten sessions at a time and resets after collapsing', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const render = (expanded: boolean) => {
      act(() => {
        root.render(
          <I18nProvider language="en">
            <SessionGroupSection
              id="group"
              label="Group"
              count={16}
              expanded={expanded}
              onToggle={() => {}}
            >
              {Array.from({ length: 16 }, (_, index) => (
                <div key={index}>Session {index + 1}</div>
              ))}
            </SessionGroupSection>
          </I18nProvider>,
        );
      });
    };
    const expandButton = () =>
      Array.from(container.querySelectorAll('button')).find((button) =>
        /^Show \d+ more$/.test(button.textContent ?? ''),
      );

    render(true);
    expect(container.textContent).toContain('Session 5');
    expect(container.textContent).not.toContain('Session 6');
    expect(expandButton()?.textContent).toBe('Show 10 more');
    act(() => expandButton()?.click());
    expect(container.textContent).toContain('Session 15');
    expect(container.textContent).not.toContain('Session 16');
    expect(expandButton()?.textContent).toBe('Show 1 more');
    act(() => expandButton()?.click());
    expect(container.textContent).toContain('Session 16');
    expect(expandButton()).toBeUndefined();

    render(false);
    render(true);
    expect(container.textContent).not.toContain('Session 6');
    expect(expandButton()?.textContent).toBe('Show 10 more');

    act(() => root.unmount());
    container.remove();
  });

  it('shows every session when preview limiting is disabled', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <I18nProvider language="en">
          <SessionGroupSection
            id="group"
            label="Group"
            count={6}
            expanded
            limitSessions={false}
            onToggle={() => {}}
          >
            {Array.from({ length: 6 }, (_, index) => (
              <div key={index}>Session {index + 1}</div>
            ))}
          </SessionGroupSection>
        </I18nProvider>,
      );
    });

    expect(container.textContent).toContain('Session 6');
    expect(container.textContent).not.toMatch(/Show \d+ more/);
    act(() => root.unmount());
    container.remove();
  });
});
