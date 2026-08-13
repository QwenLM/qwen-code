// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { I18nProvider, type WebShellLanguage } from '../../i18n';
import { HelpDialog } from './HelpDialog';

const containers: HTMLDivElement[] = [];

afterEach(() => {
  for (const container of containers.splice(0)) container.remove();
});

describe('HelpDialog shortcuts', () => {
  it.each([
    ['en', 'Toggle compact mode'],
    ['zh-CN', '切换紧凑模式'],
  ] as const)('documents Ctrl+O in %s', (language, description) => {
    const container = document.createElement('div');
    containers.push(container);
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        <I18nProvider language={language as WebShellLanguage}>
          <HelpDialog commands={[]} />
        </I18nProvider>,
      );
    });

    expect(container.textContent).toContain('Ctrl+O');
    expect(container.textContent).toContain(description);
    act(() => root.unmount());
  });
});
