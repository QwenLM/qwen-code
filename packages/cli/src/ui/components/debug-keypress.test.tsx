/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
/* eslint-disable no-console, @typescript-eslint/no-explicit-any, react-hooks/exhaustive-deps */
import { describe, it, expect, vi } from 'vitest';
import { act, useEffect } from 'react';
import { Text, useStdin } from 'ink';
import { renderWithProviders } from '../../test-utils/render.js';
import { useKeypressContext } from '../contexts/KeypressContext.js';

function TestKeyListener({
  onKey,
  onInfo,
}: {
  onKey: (name: string) => void;
  onInfo: (msg: string) => void;
}) {
  const { subscribe, unsubscribe } = useKeypressContext();
  const { stdin } = useStdin();

  useEffect(() => {
    onInfo(`stdin exists: ${!!stdin}`);
    onInfo(`stdin listeners: ${stdin?.listenerCount?.('readable') ?? 'N/A'}`);
  }, [stdin]);

  // Try subscribing directly
  useEffect(() => {
    const handler = (key: any) => {
      onKey(`direct:${key.name ?? key.sequence ?? '?'}`);
      return true;
    };
    subscribe(handler);
    onInfo('subscribed at High priority');
    return () => unsubscribe(handler);
  }, [subscribe, unsubscribe, onKey]);

  return <Text>listening</Text>;
}

describe('useKeypress debug', () => {
  it('receives Enter key with direct subscribe', async () => {
    const onKey = vi.fn();
    const onInfo = vi.fn();

    const { stdin, waitUntilReady, unmount } = await renderWithProviders(
      <TestKeyListener onKey={onKey} onInfo={onInfo} />,
    );

    await waitUntilReady();

    // Log what info we got
    console.log(
      'Info calls:',
      onInfo.mock.calls.map((c) => c[0]),
    );

    await act(async () => {
      stdin.write('\r');
    });

    // Wait a bit
    await new Promise((r) => setTimeout(r, 100));
    await waitUntilReady();

    console.log('onKey calls:', onKey.mock.calls);
    expect(onKey).toHaveBeenCalled();
    unmount();
  });
});
