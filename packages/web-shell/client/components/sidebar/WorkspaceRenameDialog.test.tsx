// @vitest-environment jsdom
/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ReactNode } from 'react';
import type { DaemonWorkspaceCapability } from '@qwen-code/sdk/daemon';
import { I18nProvider } from '../../i18n';
import { WorkspaceRenameDialog } from './WorkspaceRenameDialog';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const workspace: DaemonWorkspaceCapability = {
  id: 'ws-api',
  cwd: '/tmp/qwen-api-service',
  displayName: 'API',
  primary: false,
  trusted: true,
};

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

async function render(node: ReactNode): Promise<void> {
  await act(async () => {
    root.render(<I18nProvider language="en">{node}</I18nProvider>);
  });
}

function input(): HTMLInputElement {
  const element = document.body.querySelector<HTMLInputElement>(
    '#workspace-display-name',
  );
  expect(element).not.toBeNull();
  return element!;
}

function saveButton(): HTMLButtonElement {
  const button = Array.from(
    document.body.querySelectorAll<HTMLButtonElement>('button[type="submit"]'),
  ).at(-1);
  expect(button).toBeDefined();
  return button!;
}

async function type(value: string): Promise<void> {
  await act(async () => {
    const element = input();
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!;
    setter.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function submit(): Promise<void> {
  await act(async () => {
    input().form!.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
  });
}

describe('WorkspaceRenameDialog', () => {
  it('starts from the current display name and disables save until it changes', async () => {
    const onSubmit = vi.fn();
    await render(
      <WorkspaceRenameDialog
        workspace={workspace}
        busy={false}
        onSubmit={onSubmit}
        onClose={vi.fn()}
      />,
    );
    expect(input().value).toBe('API');
    expect(input().placeholder).toBe('qwen-api-service');
    expect(saveButton().disabled).toBe(true);
    await submit();
    expect(onSubmit).not.toHaveBeenCalled();
    await type('  Payments API  ');
    expect(saveButton().disabled).toBe(false);
    await submit();
    expect(onSubmit).toHaveBeenCalledWith('Payments API');
  });

  it('submits null when the name is cleared so the folder name shows again', async () => {
    const onSubmit = vi.fn();
    await render(
      <WorkspaceRenameDialog
        workspace={workspace}
        busy={false}
        onSubmit={onSubmit}
        onClose={vi.fn()}
      />,
    );
    await type('   ');
    await submit();
    expect(onSubmit).toHaveBeenCalledWith(null);
  });

  it('accepts names up to the daemon cap so a long name can still be edited', async () => {
    const longName = 'x'.repeat(100);
    await render(
      <WorkspaceRenameDialog
        workspace={{ ...workspace, displayName: longName }}
        busy={false}
        onSubmit={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(input().value).toBe(longName);
    expect(input().maxLength).toBe(256);
  });

  it('keeps save disabled while busy even when the name changed', async () => {
    const onSubmit = vi.fn();
    const props = { workspace, onSubmit, onClose: vi.fn() };
    await render(<WorkspaceRenameDialog {...props} busy={false} />);
    await type('Payments API');
    expect(saveButton().disabled).toBe(false);
    // Same element tree, so the typed name survives the busy flip.
    await render(<WorkspaceRenameDialog {...props} busy />);
    expect(input().value).toBe('Payments API');
    expect(saveButton().disabled).toBe(true);
  });

  it('swallows Escape while busy and closes once idle', async () => {
    const onClose = vi.fn();
    const props = { workspace, onSubmit: vi.fn(), onClose };
    await render(<WorkspaceRenameDialog {...props} busy />);
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(onClose).not.toHaveBeenCalled();
    await render(<WorkspaceRenameDialog {...props} busy={false} />);
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    // DialogShell routes Escape through more than one listener; the contract
    // here is only that it reaches onClose once the dialog is idle.
    expect(onClose).toHaveBeenCalled();
  });

  it('rejects control characters before they reach the daemon', async () => {
    const onSubmit = vi.fn();
    await render(
      <WorkspaceRenameDialog
        workspace={workspace}
        busy={false}
        onSubmit={onSubmit}
        onClose={vi.fn()}
      />,
    );
    await type('Bad \u001b[31mname');
    expect(saveButton().disabled).toBe(true);
    expect(document.body.querySelector('[role="alert"]')?.textContent).toBe(
      'Names cannot contain control characters.',
    );
    await submit();
    expect(onSubmit).not.toHaveBeenCalled();
    await type('Good name');
    expect(saveButton().disabled).toBe(false);
    expect(document.body.querySelector('[role="alert"]')).toBeNull();
  });

  it('locks the form while busy', async () => {
    const onSubmit = vi.fn();
    await render(
      <WorkspaceRenameDialog
        workspace={{ ...workspace, displayName: undefined }}
        busy
        onSubmit={onSubmit}
        onClose={vi.fn()}
      />,
    );
    expect(input().disabled).toBe(true);
    expect(saveButton().disabled).toBe(true);
  });
});
