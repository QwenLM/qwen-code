// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '../i18n';
import { ModelRefreshControl, ModelRefreshError } from './ModelRefreshControl';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function mount(node: ReactNode) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<I18nProvider language="en">{node}</I18nProvider>);
  });
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe('ModelRefreshControl', () => {
  it('renders an icon button labeled for refresh', () => {
    const refresh = vi.fn();
    mount(<ModelRefreshControl state={{ refresh, refreshing: false }} />);

    const button = container!.querySelector('button');
    expect(button).not.toBeNull();
    expect(button!.getAttribute('aria-label')).toBe('Refresh models');
    expect(button!.textContent).toBe('');
    expect(button!.querySelector('svg')).not.toBeNull();
  });

  it('spins and disables the icon while refreshing', () => {
    mount(
      <ModelRefreshControl state={{ refresh: vi.fn(), refreshing: true }} />,
    );

    const button = container!.querySelector('button');
    expect(button!.disabled).toBe(true);
    expect(button!.getAttribute('aria-label')).toBe('Refreshing models…');
    expect(button!.querySelector('.animate-spin')).not.toBeNull();
  });

  it('invokes refresh from the icon button', () => {
    const refresh = vi.fn();
    mount(<ModelRefreshControl state={{ refresh, refreshing: false }} />);

    act(() => container!.querySelector('button')!.click());
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('does not render when refresh is unavailable', () => {
    mount(<ModelRefreshControl state={{ refreshing: false }} />);
    expect(container!.querySelector('button')).toBeNull();
  });
});

describe('ModelRefreshError', () => {
  it('shows the failure after an icon refresh', () => {
    mount(
      <ModelRefreshError
        state={{
          refresh: vi.fn(),
          refreshing: false,
          error: 'Catalog offline',
        }}
      />,
    );

    const alert = container!.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe(
      'Unable to refresh models: Catalog offline',
    );
  });
});
