/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { render } from '../../test-utils/render.js';
import { TerminalProvider, useTerminalContext } from './TerminalContext.js';
import { vi, describe, it, expect, beforeEach, type Mock } from 'vitest';
import { useEffect } from 'react';
import { EventEmitter } from 'node:events';
import { waitFor } from '../../test-utils/async.js';

const mockSend = vi.fn();
const mockFlush = vi.fn();

const mockStdin = new EventEmitter() as unknown as NodeJS.ReadStream &
  EventEmitter;
// Add required properties for Ink's StdinProps
(mockStdin as unknown as { write: Mock }).write = vi.fn();
(mockStdin as unknown as { setEncoding: Mock }).setEncoding = vi.fn();
(mockStdin as unknown as { setRawMode: Mock }).setRawMode = vi.fn();
(mockStdin as unknown as { isTTY: boolean }).isTTY = true;
// Mock removeListener specifically as it is used in cleanup
(mockStdin as unknown as { removeListener: Mock }).removeListener = vi.fn(
  (event: string, listener: (...args: unknown[]) => void) => {
    mockStdin.off(event, listener);
  },
);

vi.mock('ink', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ink')>();
  return {
    ...actual,
    useStdinInternal: () => ({
      stdin: mockStdin,
      internal_querier: {
        send: mockSend,
        flush: mockFlush,
      },
    }),
    useStdout: () => ({
      stdout: {
        write: vi.fn(),
      },
    }),
  };
});

const TestComponent = ({ onColor }: { onColor: (c: string) => void }) => {
  const { subscribe, unsubscribe, queryTerminalBackground } =
    useTerminalContext();
  useEffect(() => {
    subscribe(onColor);
    void queryTerminalBackground();
    return () => unsubscribe(onColor);
  }, [subscribe, unsubscribe, queryTerminalBackground, onColor]);
  return null;
};

describe('TerminalContext', () => {
  beforeEach(() => {
    mockSend.mockReset();
    mockFlush.mockReset();
    mockFlush.mockResolvedValue(undefined);
  });

  it('queries OSC 11 through the terminal querier and notifies subscribers', async () => {
    mockSend.mockResolvedValue({
      type: 'osc',
      code: 11,
      data: 'rgb:ffff/ffff/ffff',
    });
    const handleColor = vi.fn();
    const { waitUntilReady, unmount } = await render(
      <TerminalProvider>
        <TestComponent onColor={handleColor} />
      </TerminalProvider>,
    );

    await waitUntilReady();

    await waitFor(() => {
      expect(handleColor).toHaveBeenCalledWith('rgb:ffff/ffff/ffff');
    });
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({ responsePrefix: '\x1b]11;' }),
    );
    expect(mockFlush).toHaveBeenCalledOnce();
    unmount();
  });

  it('does not notify subscribers when OSC 11 is unsupported', async () => {
    mockSend.mockResolvedValue(undefined);
    const handleColor = vi.fn();
    const { waitUntilReady, unmount } = await render(
      <TerminalProvider>
        <TestComponent onColor={handleColor} />
      </TerminalProvider>,
    );

    await waitUntilReady();
    expect(handleColor).not.toHaveBeenCalled();
    expect(mockFlush).toHaveBeenCalledOnce();
    unmount();
  });
});
