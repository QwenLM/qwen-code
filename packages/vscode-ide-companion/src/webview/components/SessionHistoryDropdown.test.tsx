/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DaemonSessionSummary } from '@qwen-code/sdk/daemon';
import { SessionHistoryDropdown } from './SessionHistoryDropdown.js';
import { createChromeStrings } from '../strings.js';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const t = createChromeStrings('en');

function makeSession(
  sessionId: string,
  displayName: string,
): DaemonSessionSummary {
  const stamp = new Date().toISOString();
  return {
    sessionId,
    workspaceCwd: '/workspace',
    displayName,
    createdAt: stamp,
    updatedAt: stamp,
  };
}

const mounted: Array<{ container: HTMLElement; root: Root }> = [];

async function renderDropdown() {
  const onClose = vi.fn();
  const onSelect = vi.fn();
  const onRename = vi.fn(async () => {});
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <SessionHistoryDropdown
        t={t}
        sessions={[makeSession('s1', 'First'), makeSession('s2', 'Second')]}
        currentSessionId="s1"
        searchQuery=""
        loading={false}
        hasMore={false}
        onSearchChange={() => {}}
        onSelect={onSelect}
        onRename={onRename}
        onDelete={async () => {}}
        onLoadMore={() => {}}
        onClose={onClose}
      />,
    );
    await Promise.resolve();
  });
  mounted.push({ container, root });
  return { container, onClose };
}

afterEach(() => {
  for (const { container, root } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

describe('SessionHistoryDropdown focus management', () => {
  it('restores focus inside the dialog when a rename ends, keeping Escape working', async () => {
    const { container, onClose } = await renderDropdown();

    const row = container.querySelector(
      '[data-session-id="s2"]',
    ) as HTMLElement;
    const renameButton = row.querySelector('button') as HTMLButtonElement;
    await act(async () => {
      renameButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    const input = row.querySelector('input') as HTMLInputElement;
    expect(document.activeElement).toBe(input);

    // Commit the rename with Enter (the input blurs and unmounts).
    await act(async () => {
      input.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
          cancelable: true,
        }),
      );
      await Promise.resolve();
    });

    // Focus must be back inside the dialog — otherwise Escape and the Tab
    // trap die with the unmounted input.
    const dialog = document.getElementById('qwen-session-history');
    expect(dialog).not.toBeNull();
    expect(dialog?.contains(document.activeElement)).toBe(true);

    await act(async () => {
      (document.activeElement as HTMLElement).dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        }),
      );
      await Promise.resolve();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('still closes on Escape when focus has fallen to <body>', async () => {
    const { onClose } = await renderDropdown();

    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);

    await act(async () => {
      document.body.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        }),
      );
      await Promise.resolve();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('pulls focus back into the dialog when Tab is pressed with focus outside', async () => {
    await renderDropdown();

    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();
    expect(document.activeElement).toBe(outside);

    await act(async () => {
      outside.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Tab',
          bubbles: true,
          cancelable: true,
        }),
      );
      await Promise.resolve();
    });

    const dialog = document.getElementById('qwen-session-history');
    expect(dialog?.contains(document.activeElement)).toBe(true);
    outside.remove();
  });
});
