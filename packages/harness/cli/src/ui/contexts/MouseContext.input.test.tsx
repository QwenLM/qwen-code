/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../test-utils/render.js';
import { waitFor } from '../../test-utils/async.js';
import { useMouse, type MouseHandler } from './MouseContext.js';

function MouseListener({
  handler,
  isActive = true,
}: {
  handler: MouseHandler;
  isActive?: boolean;
}) {
  useMouse(handler, { isActive });
  return null;
}

describe('MouseProvider terminal input', () => {
  it('delivers split and batched wheel reports from the Ink input parser', async () => {
    const handler = vi.fn();
    const result = await renderWithProviders(
      <MouseListener handler={handler} />,
      { mouseEventsEnabled: true },
    );
    try {
      await act(async () => {
        result.stdin.write('\x1b[<64;');
        result.stdin.write('10;20M\x1b[<65;10;20M');
      });
      await waitFor(() => expect(handler).toHaveBeenCalledTimes(2));
      expect(handler.mock.calls.map(([event]) => event.name)).toEqual([
        'scroll-up',
        'scroll-down',
      ]);
      expect(handler.mock.calls[0][0]).toMatchObject({ col: 10, row: 20 });

      result.rerender(<MouseListener handler={handler} isActive={false} />);
      await act(async () => result.stdin.write('\x1b[<64;10;20M'));
      await result.waitUntilReady();
      expect(handler).toHaveBeenCalledTimes(2);
    } finally {
      result.unmount();
    }
  });

  it('does not deliver wheel reports when mouse events are disabled', async () => {
    const handler = vi.fn();
    const result = await renderWithProviders(
      <MouseListener handler={handler} />,
      { mouseEventsEnabled: false },
    );
    try {
      await act(async () => result.stdin.write('\x1b[<64;10;20M'));
      await result.waitUntilReady();
      expect(handler).not.toHaveBeenCalled();
    } finally {
      result.unmount();
    }
  });
});
