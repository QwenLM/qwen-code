// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { I18nProvider } from '../../i18n';
import { SessionGroupSection } from './SessionGroupSection';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('SessionGroupSection', () => {
  it('shows five sessions and resets Show all after collapsing', () => {
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
              count={6}
              expanded={expanded}
              onToggle={() => {}}
            >
              {Array.from({ length: 6 }, (_, index) => (
                <div key={index}>Session {index + 1}</div>
              ))}
            </SessionGroupSection>
          </I18nProvider>,
        );
      });
    };

    render(true);
    expect(container.textContent).toContain('Session 5');
    expect(container.textContent).not.toContain('Session 6');
    const showAll = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Show all',
    );
    act(() => showAll?.click());
    expect(container.textContent).toContain('Session 6');

    render(false);
    render(true);
    expect(container.textContent).not.toContain('Session 6');

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
    expect(container.textContent).not.toContain('Show all');
    act(() => root.unmount());
    container.remove();
  });
});
