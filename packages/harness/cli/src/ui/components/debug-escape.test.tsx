/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/* eslint-disable no-console */
import { renderWithProviders } from '../../test-utils/render.js';
import { act, useState } from 'react';
import { describe, it } from 'vitest';
import { Text } from 'ink';
import { BaseTabDialog } from './shared/BaseTabDialog.js';
import { useKeypress } from '../hooks/useKeypress.js';
function DebugKeyListener({
  label,
  priority,
}: {
  label: string;
  priority: number;
}) {
  useKeypress(
    (key) => {
      console.log(
        `[${label}@${priority}] got key: name=${key.name} ctrl=${key.ctrl} seq=${JSON.stringify(key.sequence)}`,
      );
      return undefined; // don't consume
    },
    { isActive: true },
  );
  return null;
}

function TestDialog() {
  const [closed, setClosed] = useState(false);
  if (closed) return <Text>CLOSED</Text>;
  return (
    <>
      <DebugKeyListener label="P400" priority={400} />
      <DebugKeyListener label="P150" priority={150} />
      <DebugKeyListener label="P50" priority={50} />
      <BaseTabDialog
        title="Test"
        onClose={() => {
          console.log('[BTD onClose] CALLED!');
          setClosed(true);
        }}
      >
        <Text>content</Text>
      </BaseTabDialog>
    </>
  );
}

describe('debug escape in BaseTabDialog', () => {
  it('BTD escape with debug listeners', async () => {
    const { lastFrame, stdin, waitUntilReady, unmount } =
      await renderWithProviders(<TestDialog />);

    console.log('BEFORE:', lastFrame()?.substring(0, 100));

    await act(async () => {
      stdin.write('\u001b[27u'); // kitty escape
    });
    await act(async () => {
      await waitUntilReady();
    });
    // Extra wait
    await act(async () => {
      await new Promise((r) => setTimeout(r, 200));
    });

    console.log('AFTER:', lastFrame()?.substring(0, 100));
    unmount();
  });
});
