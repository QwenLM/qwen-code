// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '../i18n';
import { useComposerCore, type UseComposerCoreReturn } from './useComposerCore';
import type { WebShellComposerInput } from '../customization';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let latest: UseComposerCoreReturn | null = null;

function Harness({
  composerInput,
  onSubmit,
  renderComposerTag,
  renderComposerTagTooltip,
}: {
  composerInput?: WebShellComposerInput;
  onSubmit: ReturnType<typeof vi.fn>;
  renderComposerTag?: () => ReactNode;
  renderComposerTagTooltip?: () => ReactNode;
}) {
  const composer = useComposerCore({
    onSubmit,
    commands: [],
    editorTheme: {},
    renderComposerTag,
    renderComposerTagTooltip,
    composerInput,
    composerInputVersion: composerInput ? 1 : undefined,
  });
  latest = composer;

  return <div ref={composer.containerRef} />;
}

async function mount({
  composerInput,
  onSubmit = vi.fn(),
  renderComposerTag,
  renderComposerTagTooltip,
}: {
  composerInput?: WebShellComposerInput;
  onSubmit?: ReturnType<typeof vi.fn>;
  renderComposerTag?: () => ReactNode;
  renderComposerTagTooltip?: () => ReactNode;
} = {}) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);

  await act(async () => {
    root!.render(
      <I18nProvider language="en">
        <Harness
          composerInput={composerInput}
          onSubmit={onSubmit}
          renderComposerTag={renderComposerTag}
          renderComposerTagTooltip={renderComposerTagTooltip}
        />
      </I18nProvider>,
    );
  });
  return { onSubmit };
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  latest = null;
});

describe('useComposerCore inline tags', () => {
  it('falls back when inline custom tag rendering throws', async () => {
    const error = new Error('boom');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await mount({
      composerInput: {
        tags: [{ id: 'orders', label: 'Table', value: 'orders' }],
        tagPlacement: 'inline',
      },
      renderComposerTag: () => {
        throw error;
      },
    });

    expect(warn).toHaveBeenCalledWith(
      '[WebShell] inline tag renderContent failed',
      error,
    );
    expect(document.body.textContent).toContain('orders');

    warn.mockRestore();
  });

  it('falls back when inline custom tag tooltip rendering throws', async () => {
    const error = new Error('bad tooltip');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await mount({
      composerInput: {
        tags: [{ id: 'orders', label: 'Table', value: 'orders' }],
        tagPlacement: 'inline',
      },
      renderComposerTagTooltip: () => {
        throw error;
      },
    });

    expect(warn).toHaveBeenCalledWith(
      '[WebShell] inline tag tooltip render failed',
      error,
    );
    expect(document.body.textContent).toContain('orders');

    warn.mockRestore();
  });

  it('uses a custom inline tooltip without a native title', async () => {
    await mount({
      composerInput: {
        tags: [{ id: 'orders', label: 'Table', value: 'orders' }],
        tagPlacement: 'inline',
      },
      renderComposerTagTooltip: () => 'Details',
    });

    const tooltip = document.body.querySelector('[role="tooltip"]');
    expect(tooltip?.textContent).toBe('Details');
    expect(tooltip?.parentElement?.getAttribute('title')).toBeNull();
    expect(tooltip?.id).toBeTruthy();
    expect(tooltip?.parentElement?.getAttribute('aria-describedby')).toBe(
      tooltip?.id,
    );
  });

  it('falls back to a native title when attaching an inline tooltip fails', async () => {
    const error = new Error('append failed');
    const appendChild = HTMLElement.prototype.appendChild;
    let failingTooltip: HTMLElement | null = null;
    let readFailingChipTitle: (() => string) | null = null;
    let dispatchOnFailingChip: ((event: Event) => boolean) | null = null;
    const appendChildSpy = vi
      .spyOn(HTMLElement.prototype, 'appendChild')
      .mockImplementation(function (child) {
        if (
          child instanceof HTMLElement &&
          child.getAttribute('role') === 'tooltip'
        ) {
          failingTooltip = child;
          readFailingChipTitle = () => this.title;
          dispatchOnFailingChip = (event) => this.dispatchEvent(event);
          throw error;
        }
        return appendChild.call(this, child);
      });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {
      expect(readFailingChipTitle?.()).toBe('Details');
    });

    try {
      await mount({
        composerInput: {
          tags: [{ id: 'orders', label: 'Table', value: 'orders' }],
          tagPlacement: 'inline',
        },
        renderComposerTagTooltip: () => 'Details',
      });

      expect(warn).toHaveBeenCalledWith(
        '[WebShell] inline tag tooltip render failed',
        error,
      );
      const chip = document.body.querySelector('[title="Details"]');
      expect(chip).not.toBeNull();
      expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
      dispatchOnFailingChip?.(new MouseEvent('mouseenter'));
      expect(failingTooltip?.style.display).toBe('none');
    } finally {
      warn.mockRestore();
      appendChildSpy.mockRestore();
    }
  });

  it('guards inline mask icon sources', async () => {
    await mount({
      composerInput: {
        tags: [
          {
            id: 'orders',
            label: 'Table',
            value: 'orders',
            icon: 'javascript:alert(1)',
          },
        ],
        tagPlacement: 'inline',
      },
    });

    expect(document.body.innerHTML).not.toContain('javascript:alert');
    expect(
      document.body.querySelector('[style*="--composer-tag-icon-url"]'),
    ).toBeNull();
  });

  it('keeps inline tags after trimming leading whitespace on submit', async () => {
    const { onSubmit } = await mount();

    act(() => {
      latest!.setText('  ');
      latest!.addTags(
        [{ id: 'orders', value: 'orders', serialized: '<table />' }],
        { placement: 'inline' },
      );
      latest!.insertText('explain');
      latest!.submitText();
    });

    expect(onSubmit).toHaveBeenCalledWith(
      '<table /> explain',
      undefined,
      expect.any(Function),
    );
  });
});
