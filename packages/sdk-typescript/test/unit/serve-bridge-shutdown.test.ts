/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { createShutdownController } from '../../src/daemon-mcp/serve-bridge/shutdown.js';

describe('serve-bridge shutdown', () => {
  it('shares recursive shutdown and waits for close and disposal before exit', async () => {
    let resolveDispose!: () => void;
    let recursiveShutdown: Promise<void> | undefined;
    const close = vi.fn(async () => {
      controller.markInstanceClosed();
      recursiveShutdown = controller.shutdown();
    });
    const dispose = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveDispose = resolve;
        }),
    );
    const exit = vi.fn();
    const controller = createShutdownController({
      close,
      dispose,
      exit,
      reportCloseError: vi.fn(),
    });

    const shutdown = controller.shutdown();
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());

    expect(recursiveShutdown).toBe(shutdown);
    expect(close).toHaveBeenCalledOnce();
    expect(exit).not.toHaveBeenCalled();
    resolveDispose();
    await shutdown;

    expect(dispose).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('skips duplicate close after peer shutdown and shares disposal', async () => {
    let resolveDispose!: () => void;
    const close = vi.fn(async () => undefined);
    const dispose = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveDispose = resolve;
        }),
    );
    const exit = vi.fn();
    const controller = createShutdownController({
      close,
      dispose,
      exit,
      reportCloseError: vi.fn(),
    });
    controller.markInstanceClosed();

    const first = controller.shutdown();
    const second = controller.shutdown();
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());

    expect(second).toBe(first);
    expect(close).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    resolveDispose();
    await Promise.all([first, second]);

    expect(dispose).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(0);
  });
});
