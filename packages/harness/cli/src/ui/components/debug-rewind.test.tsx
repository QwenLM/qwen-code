/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
/* eslint-disable no-console, @typescript-eslint/no-explicit-any */
import { describe, it } from 'vitest';
import type React from 'react';
import { act, useState, useEffect, useContext } from 'react';
import { Text, useStdin } from 'ink';
import { renderWithProviders } from '../../test-utils/render.js';
import { useKeypress } from '../hooks/useKeypress.js';
import StdinContext from '../../ink/components/StdinContext.js';

// Store references globally so we can compare
let componentStdin: any = null;

function KeyTest(): React.JSX.Element {
  const [keys, setKeys] = useState<string[]>([]);
  const stdinCtx = useContext(StdinContext);
  const { stdin: useStdinResult } = useStdin();

  useEffect(() => {
    componentStdin = stdinCtx.stdin;
    console.log('Component stdin isTTY:', stdinCtx.stdin?.isTTY);
    console.log('Component stdin type:', stdinCtx.stdin?.constructor?.name);
    console.log('useStdin result type:', useStdinResult?.constructor?.name);
  }, [stdinCtx, useStdinResult]);

  useKeypress(
    (key) => {
      console.log('=== KEY RECEIVED:', key.name);
      setKeys((prev) => [...prev, `${key.name}`]);
      return true;
    },
    { isActive: true },
  );

  return <Text>keys={keys.join(',')}</Text>;
}

describe('keyboard pipeline debug', () => {
  it('verify stdin identity', async () => {
    const { stdin, lastFrame, waitUntilReady, unmount } =
      await renderWithProviders(<KeyTest />);

    await waitUntilReady();
    await new Promise((r) => setTimeout(r, 300));

    console.log('Test stdin type:', stdin.constructor.name);
    console.log('Same stdin?', stdin === componentStdin);
    console.log(
      'Test stdin readable listeners:',
      stdin.listenerCount('readable'),
    );
    console.log(
      'Component stdin readable listeners:',
      componentStdin?.listenerCount?.('readable'),
    );

    // Try writing directly to the component's stdin
    if (componentStdin && componentStdin !== stdin) {
      console.log('DIFFERENT STDIN OBJECTS! Writing to component stdin...');
      await act(async () => {
        componentStdin.write('\r');
      });
      await new Promise((r) => setTimeout(r, 200));
      await waitUntilReady();
      console.log('FRAME after writing to component stdin:', lastFrame());
    }

    // Write to test stdin
    await act(async () => {
      stdin.write('\r');
    });
    await new Promise((r) => setTimeout(r, 200));
    await waitUntilReady();
    console.log('FRAME after writing to test stdin:', lastFrame());

    unmount();
  });
});
