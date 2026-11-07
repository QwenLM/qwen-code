// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n';
import { SessionLimitBanner } from './SessionLimitBanner';

describe('SessionLimitBanner', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(onRelease = vi.fn(), onDismiss = vi.fn()) {
    act(() => {
      root.render(
        <I18nProvider language="en">
          <SessionLimitBanner onRelease={onRelease} onDismiss={onDismiss} />
        </I18nProvider>,
      );
    });
    return { onRelease, onDismiss };
  }

  it('offers the release action and dismiss control', () => {
    const handlers = render();
    expect(container.textContent).toContain(
      'The live-session limit has been reached',
    );

    const [release, dismiss] = container.querySelectorAll('button');
    act(() => release?.click());
    act(() => dismiss?.click());

    expect(handlers.onRelease).toHaveBeenCalledOnce();
    expect(handlers.onDismiss).toHaveBeenCalledOnce();
  });
});
