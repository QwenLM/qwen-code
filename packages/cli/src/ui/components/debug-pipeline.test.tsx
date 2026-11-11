/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
/* eslint-disable no-console, @typescript-eslint/no-explicit-any, react-hooks/exhaustive-deps */
import { describe, it, vi } from 'vitest';
import { act, useEffect, useContext } from 'react';
import { Text, useStdin } from 'ink';
import { renderWithProviders } from '../../test-utils/render.js';
import StdinContext from '../../ink/components/StdinContext.js';
import { useKeypressContext } from '../contexts/KeypressContext.js';

function DebugComponent({ onInfo }: { onInfo: (msg: string) => void }) {
  const { stdin, setRawMode, isRawModeSupported } = useStdin();
  useContext(StdinContext);
  const { subscribe, unsubscribe } = useKeypressContext();

  useEffect(() => {
    onInfo(`isRawModeSupported: ${isRawModeSupported}`);

    // Try calling setRawMode ourselves
    try {
      setRawMode(true);
      onInfo('setRawMode(true) succeeded');
    } catch (e: any) {
      onInfo(`setRawMode(true) failed: ${e.message}`);
    }

    // Check readable listeners AFTER setRawMode
    const readableCount = stdin?.listenerCount?.('readable') ?? 'N/A';
    onInfo(`stdin readable listeners after setRawMode: ${readableCount}`);

    // Also check if stdin has the right type
    onInfo(`stdin constructor: ${stdin?.constructor?.name}`);
    onInfo(`stdin has setEncoding: ${typeof stdin?.setEncoding}`);
  }, []);

  // Subscribe to keypress
  useEffect(() => {
    const handler = (key: any) => {
      onInfo(
        `keypress received: name=${key.name} seq=${JSON.stringify(key.sequence)}`,
      );
      return false;
    };
    subscribe(handler);
    onInfo('subscribed to keypress at priority 300');
    return () => unsubscribe(handler);
  }, [subscribe, unsubscribe]);

  return <Text>debug</Text>;
}

describe('pipeline debug', () => {
  it('traces key event pipeline', async () => {
    const onInfo = vi.fn();

    const { stdin, waitUntilReady, unmount } = await renderWithProviders(
      <DebugComponent onInfo={onInfo} />,
    );

    await waitUntilReady();
    console.log(
      'Before write:',
      onInfo.mock.calls.map((c) => c[0]),
    );

    await act(async () => {
      stdin.write('\r');
    });

    await new Promise((r) => setTimeout(r, 200));
    await waitUntilReady();

    console.log(
      'After write:',
      onInfo.mock.calls.map((c) => c[0]),
    );
    unmount();
  });
});
