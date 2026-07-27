/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

describe('terminal teardown', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('runs the current teardown on process exit', async () => {
    let exitHandler: NodeJS.ExitListener | undefined;
    const realProcessOn = process.on.bind(process);
    vi.spyOn(process, 'on').mockImplementation(((
      eventName: string | symbol,
      listener: NodeJS.ExitListener,
    ) => {
      if (eventName === 'exit') {
        exitHandler = listener;
        return process;
      }
      return realProcessOn(eventName, listener);
    }) as typeof process.on);
    const teardown = vi.fn();
    const { setTerminalTeardown } = await import('./terminal-teardown.js');

    setTerminalTeardown(teardown);
    exitHandler?.(0);

    expect(teardown).toHaveBeenCalledTimes(1);
  });

  it('does not let an old disposer clear a newer teardown', async () => {
    vi.spyOn(process, 'on').mockReturnValue(process);
    const first = vi.fn();
    const second = vi.fn();
    const { runTerminalTeardown, setTerminalTeardown } = await import(
      './terminal-teardown.js'
    );

    const disposeFirst = setTerminalTeardown(first);
    setTerminalTeardown(second);
    disposeFirst();
    runTerminalTeardown();

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('does not let a teardown error interrupt shutdown', async () => {
    vi.spyOn(process, 'on').mockReturnValue(process);
    const { runTerminalTeardown, setTerminalTeardown } = await import(
      './terminal-teardown.js'
    );

    setTerminalTeardown(() => {
      throw new Error('closed terminal');
    });

    expect(() => runTerminalTeardown()).not.toThrow();
  });
});
