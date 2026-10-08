// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { SourcesSection, type SourcesState } from './SourcesSection';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  window.history.replaceState({}, '', '/');
});

function supportedState(): SourcesState {
  return {
    supported: true,
    sources: [],
    owner: { isCurrent: () => true },
    revision: 1,
    hydrated: true,
    loading: false,
    error: null,
    refresh: vi.fn(),
    upsert: vi.fn(),
    remove: vi.fn(),
  };
}

function mount(): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <I18nProvider language="en">
        <SourcesSection state={supportedState()} />
      </I18nProvider>,
    );
  });
  return container;
}

describe('SourcesSection add-source button', () => {
  it('is hidden by default', () => {
    const el = mount();
    expect(el.querySelector('button[aria-label="Add source"]')).toBeNull();
  });

  it('appears when the addSource URL parameter is set', () => {
    window.history.replaceState({}, '', '/?addSource=1');
    const el = mount();
    expect(el.querySelector('button[aria-label="Add source"]')).not.toBeNull();
  });
});
