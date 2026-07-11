// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '../../i18n';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const { AddWorkspaceDialog } = await import('./AddWorkspaceDialog');

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function mount(node: React.ReactNode) {
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

// The dialog is portaled to document.body, so query the document, not container.
const input = () =>
  document.querySelector<HTMLInputElement>('#add-workspace-path')!;
const alert = () => document.querySelector('[role="alert"]');
const submitButton = () =>
  Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(
    (b) => b.getAttribute('type') === 'submit',
  )!;

function type(value: string) {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!;
    setter.call(input(), value);
    input().dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function submit() {
  act(() => {
    submitButton().dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('AddWorkspaceDialog', () => {
  it('describes the input with the hint and no error initially', () => {
    mount(<AddWorkspaceDialog onClose={vi.fn()} onAdd={vi.fn()} />);
    // Hint is always associated; error id is only added once an error exists so
    // aria-describedby never points at a missing node.
    expect(input().getAttribute('aria-describedby')).toBe('add-workspace-hint');
    expect(input().getAttribute('aria-invalid')).toBeNull();
    expect(alert()).toBeNull();
  });

  it('rejects a non-absolute path with an accessible error and does not call onAdd', () => {
    const onAdd = vi.fn().mockResolvedValue(undefined);
    mount(<AddWorkspaceDialog onClose={vi.fn()} onAdd={onAdd} />);

    type('relative/path');
    submit();

    const err = alert();
    expect(err?.textContent).toBe('Path must be absolute');
    expect(input().getAttribute('aria-invalid')).toBe('true');
    expect(input().getAttribute('aria-describedby')).toBe(
      'add-workspace-error add-workspace-hint',
    );
    expect(onAdd).not.toHaveBeenCalled();

    // Editing the field clears the error.
    type('/absolute/path');
    expect(alert()).toBeNull();
    expect(input().getAttribute('aria-invalid')).toBeNull();
  });

  it('submits a trimmed absolute path and closes on success', async () => {
    const onAdd = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    mount(<AddWorkspaceDialog onClose={onClose} onAdd={onAdd} />);

    type('  /abs/project  ');
    submit();
    // Let the awaited onAdd resolve.
    await act(async () => {
      await Promise.resolve();
    });

    expect(onAdd).toHaveBeenCalledWith('/abs/project');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('surfaces an onAdd failure as an inline error and stays open', async () => {
    const onAdd = vi.fn().mockRejectedValue(new Error('daemon unreachable'));
    const onClose = vi.fn();
    mount(<AddWorkspaceDialog onClose={onClose} onAdd={onAdd} />);

    type('/abs/project');
    submit();
    await act(async () => {
      await Promise.resolve();
    });

    expect(alert()?.textContent).toBe('daemon unreachable');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('accepts a Windows-style absolute path', async () => {
    const onAdd = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    mount(<AddWorkspaceDialog onClose={onClose} onAdd={onAdd} />);

    type('C:\\Users\\me\\project');
    submit();
    await act(async () => {
      await Promise.resolve();
    });

    expect(onAdd).toHaveBeenCalledWith('C:\\Users\\me\\project');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(alert()).toBeNull();
  });

  it('falls back to the generic error when onAdd rejects with a non-Error', async () => {
    const onAdd = vi.fn().mockRejectedValue('boom');
    const onClose = vi.fn();
    mount(<AddWorkspaceDialog onClose={onClose} onAdd={onAdd} />);

    type('/abs/project');
    submit();
    await act(async () => {
      await Promise.resolve();
    });

    expect(alert()?.textContent).toBe('Failed to add workspace');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('shows the adding state and disables controls while submitting', async () => {
    let resolveAdd!: () => void;
    const onAdd = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveAdd = resolve;
        }),
    );
    mount(<AddWorkspaceDialog onClose={vi.fn()} onAdd={onAdd} />);

    type('/abs/project');
    submit();

    // The awaited onAdd is still pending, so the dialog stays in its submitting
    // state: the button shows the localized "Adding…" label and the controls
    // are disabled.
    expect(submitButton().textContent).toBe('Adding…');
    expect(submitButton().disabled).toBe(true);
    expect(input().disabled).toBe(true);

    resolveAdd();
    await act(async () => {
      await Promise.resolve();
    });
  });
});
