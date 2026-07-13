// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '../../i18n';
import {
  ModelFallbacksDialog,
  type ModelFallbacksDialogProps,
} from './ModelFallbacksDialog';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

function render(node: ReactNode): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(node));
  mounted.push({ root, container });
  return container;
}

function renderDialog(overrides: Partial<ModelFallbacksDialogProps> = {}) {
  const props: ModelFallbacksDialogProps = {
    models: [
      { baseId: 'gpt-4o', label: 'GPT-4o' },
      { baseId: 'deepseek-v4', label: 'DeepSeek V4' },
      { baseId: 'qwen3-coder', label: 'Qwen3 Coder' },
      { baseId: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
    ],
    current: [],
    max: 3,
    onConfirm: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  const container = render(
    <I18nProvider language="en">
      <ModelFallbacksDialog {...props} />
    </I18nProvider>,
  );
  return { container, props };
}

function options(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(
    container.querySelectorAll<HTMLButtonElement>('button[aria-pressed]'),
  );
}

function clickConfirm(container: HTMLElement): void {
  const confirm = Array.from(
    container.querySelectorAll<HTMLButtonElement>('button'),
  ).find((b) => b.textContent?.trim() === 'Confirm');
  if (!confirm) throw new Error('Confirm button not found');
  act(() => confirm.click());
}

describe('ModelFallbacksDialog', () => {
  it('confirms selected base ids in click order', () => {
    const { container, props } = renderDialog();
    const opts = options(container);
    act(() => opts[1]!.click()); // deepseek-v4
    act(() => opts[0]!.click()); // gpt-4o
    clickConfirm(container);
    expect(props.onConfirm).toHaveBeenCalledWith(['deepseek-v4', 'gpt-4o']);
  });

  it('enforces the max selection by disabling further options', () => {
    const { container } = renderDialog({ current: ['gpt-4o', 'deepseek-v4'] });
    const opts = options(container);
    act(() => opts[2]!.click()); // qwen3-coder → now 3 selected
    const refreshed = options(container);
    // The 4th option (gemini) is not selected and the limit is reached.
    expect(refreshed[3]!.disabled).toBe(true);
  });

  it('toggles a selected option off', () => {
    const { container, props } = renderDialog({ current: ['gpt-4o'] });
    const opts = options(container);
    act(() => opts[0]!.click()); // deselect gpt-4o
    clickConfirm(container);
    expect(props.onConfirm).toHaveBeenCalledWith([]);
  });

  it('shows an already-configured but now-unavailable fallback so it can be removed', () => {
    const { container } = renderDialog({ current: ['removed-model'] });
    expect(container.textContent).toContain('removed-model');
    // 4 available + 1 extra unavailable = 5 options.
    expect(options(container)).toHaveLength(5);
  });

  it('normalizes a persisted list that is oversized and has duplicates/blanks', () => {
    // Hand-edited/legacy value: duplicates, whitespace, blanks, and more than
    // max. Confirming without touching anything must write the trimmed, deduped,
    // capped list — not the raw four+ entries.
    const { container, props } = renderDialog({
      current: [' gpt-4o ', 'gpt-4o', '', 'deepseek-v4', 'qwen3-coder'],
    });
    clickConfirm(container);
    expect(props.onConfirm).toHaveBeenCalledWith([
      'gpt-4o',
      'deepseek-v4',
      'qwen3-coder',
    ]);
  });

  it('shows the normalized count immediately on open', () => {
    const { container } = renderDialog({
      current: ['gpt-4o', 'gpt-4o', 'deepseek-v4'],
    });
    // Deduped to 2 of 3, not 3/3.
    expect(container.textContent).toContain('2/3');
  });

  it('invokes onClose when Cancel is clicked', () => {
    const { container, props } = renderDialog();
    const cancel = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((b) => b.textContent?.trim() === 'Cancel');
    if (!cancel) throw new Error('Cancel button not found');
    act(() => cancel.click());
    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(props.onConfirm).not.toHaveBeenCalled();
  });

  it('groups the toggle options with an accessible name for screen readers', () => {
    const { container } = renderDialog();
    const group = container.querySelector<HTMLDivElement>('[role="group"]');
    expect(group).toBeTruthy();
    expect(group?.getAttribute('aria-label')).toBe('Model Fallbacks');
    // The option buttons live inside the group.
    expect(group?.querySelectorAll('button[aria-pressed]').length).toBe(4);
  });
});
