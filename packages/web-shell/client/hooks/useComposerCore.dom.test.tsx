// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '../i18n';
import { useComposerCore } from './useComposerCore';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function Harness({ renderComposerTag }: { renderComposerTag: () => never }) {
  const composer = useComposerCore({
    onSubmit: vi.fn(),
    commands: [],
    editorTheme: {},
    renderComposerTag,
    composerInput: {
      tags: [{ id: 'orders', label: 'Table', value: 'orders' }],
      tagPlacement: 'inline',
    },
    composerInputVersion: 1,
  });

  return <div ref={composer.containerRef} />;
}

async function mount(renderComposerTag: () => never) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);

  await act(async () => {
    root!.render(
      <I18nProvider language="en">
        <Harness renderComposerTag={renderComposerTag} />
      </I18nProvider>,
    );
  });
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe('useComposerCore inline tags', () => {
  it('falls back when inline custom tag rendering throws', async () => {
    const error = new Error('boom');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await mount(() => {
      throw error;
    });

    expect(warn).toHaveBeenCalledWith(
      '[WebShell] inline tag renderContent failed',
      error,
    );
    expect(document.body.textContent).toContain('orders');

    warn.mockRestore();
  });
});
