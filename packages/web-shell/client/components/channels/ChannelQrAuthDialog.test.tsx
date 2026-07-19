/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DaemonChannelAuthSession } from '@qwen-code/sdk/daemon';
import { ChannelQrAuthDialog } from './ChannelQrAuthDialog';
import type { ChannelQrAuthActions } from './useChannelQrAuth';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function session(state: DaemonChannelAuthSession['state'], qrRevision = 1) {
  return {
    id: 'auth-1',
    state,
    qrRevision,
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  };
}

let container: HTMLDivElement;
let root: Root;
let actions: ChannelQrAuthActions;

function button(name: string) {
  const match = Array.from(document.querySelectorAll('button')).find(
    (element) => element.textContent?.trim() === name,
  );
  if (!match) throw new Error(`Button not found: ${name}`);
  return match as HTMLButtonElement;
}

async function renderDialog(state: DaemonChannelAuthSession['state']) {
  vi.mocked(actions.begin).mockResolvedValue(session(state));
  await act(async () => {
    root.render(
      <ChannelQrAuthDialog
        open
        identity={{}}
        name="qq-main"
        channelType="qq"
        channelDisplayName="QQ"
        actions={actions}
        onOpenChange={vi.fn()}
      />,
    );
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.stubGlobal(
    'URL',
    Object.assign(URL, {
      createObjectURL: vi.fn(() => 'blob:qr'),
      revokeObjectURL: vi.fn(),
    }),
  );
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  actions = {
    begin: vi.fn(),
    status: vi.fn().mockResolvedValue(session('awaiting_scan')),
    qr: vi.fn().mockResolvedValue(new Blob(['qr'], { type: 'image/svg+xml' })),
    cancel: vi.fn().mockResolvedValue({ cancelled: true }),
    commit: vi.fn().mockResolvedValue({}),
  };
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('ChannelQrAuthDialog', () => {
  it('names the QR image and announces status without moving focus on rotation', async () => {
    vi.useFakeTimers();
    vi.mocked(actions.status).mockResolvedValue(session('awaiting_scan', 2));
    await renderDialog('awaiting_scan');
    const cancel = button('Cancel');
    cancel.focus();

    expect(document.querySelector('img')?.alt).toBe(
      'QR code for QQ channel qq-main',
    );
    expect(
      document.querySelector('[aria-live="polite"]')?.textContent,
    ).toContain('Scan the QR code');
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(actions.qr).toHaveBeenCalledTimes(2);
    expect(document.activeElement).toBe(cancel);
  });

  it('requires an explicit commit when authentication is ready', async () => {
    await renderDialog('ready');
    expect(actions.commit).not.toHaveBeenCalled();

    await act(async () => button('Save authentication').click());
    expect(actions.commit).toHaveBeenCalledWith('qq-main', 'auth-1', {
      channelType: 'qq',
    });
  });

  it('shows Retry only for retryable terminal states', async () => {
    await renderDialog('expired');
    expect(button('Retry')).toBeInstanceOf(HTMLButtonElement);
    expect(document.body.textContent).not.toContain('Save authentication');
  });

  it('cancels when the dialog closes before commit', async () => {
    const onOpenChange = vi.fn();
    vi.mocked(actions.begin).mockResolvedValue(session('awaiting_scan'));
    await act(async () => {
      root.render(
        <ChannelQrAuthDialog
          open
          identity={{}}
          name="qq-main"
          channelType="qq"
          channelDisplayName="QQ"
          actions={actions}
          onOpenChange={onOpenChange}
        />,
      );
    });
    await act(async () => {
      await Promise.resolve();
      button('Cancel').click();
    });

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(actions.cancel).toHaveBeenCalledWith('qq-main', 'auth-1');
  });
});
