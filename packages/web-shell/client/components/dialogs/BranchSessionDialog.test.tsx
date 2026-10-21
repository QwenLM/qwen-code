// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '../../i18n';
import { BranchSessionDialog } from './BranchSessionDialog';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

function mount(onConfirm: (isolation: 'current' | 'worktree') => void) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <I18nProvider language="en">
        <BranchSessionDialog
          busy={false}
          onCancel={vi.fn()}
          onConfirm={onConfirm}
        />
      </I18nProvider>,
    );
  });
}

describe('BranchSessionDialog', () => {
  it('defaults to the current workspace', () => {
    const onConfirm = vi.fn();
    mount(onConfirm);

    const radios =
      container.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    expect(radios[0]?.getAttribute('data-state')).toBe('checked');
    act(() => {
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === 'Branch')
        ?.click();
    });
    expect(onConfirm).toHaveBeenCalledWith('current');
  });

  it('confirms an isolated worktree explicitly', () => {
    const onConfirm = vi.fn();
    mount(onConfirm);
    const worktree = container.querySelector<HTMLButtonElement>(
      '[role="radio"][value="worktree"]',
    );
    act(() => worktree?.click());
    act(() => {
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === 'Branch')
        ?.click();
    });
    expect(onConfirm).toHaveBeenCalledWith('worktree');
  });
});
