/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChromeDebuggerSession } from './debugger-session.js';

describe('ChromeDebuggerSession', () => {
  const onEvent = { addListener: vi.fn() };
  const onDetach = { addListener: vi.fn() };
  const attach = vi.fn();
  const detach = vi.fn();
  const sendCommand = vi.fn();
  const query = vi.fn();
  let runtime: {
    lastError?: { message?: string };
    getPlatformInfo: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    runtime = {
      lastError: undefined,
      getPlatformInfo: vi.fn((callback) => callback()),
    };
    vi.stubGlobal('chrome', {
      tabs: {
        query,
        get: vi.fn(async () => ({ id: 7, url: 'https://example.com' })),
      },
      debugger: { attach, detach, sendCommand, onEvent, onDetach },
      runtime,
    });
    attach.mockImplementation((_target, _version, callback) => callback());
    query.mockResolvedValue([
      { id: 7, url: 'https://example.com', title: 'Example' },
    ]);
    detach.mockImplementation((_target, callback) => callback());
    sendCommand.mockImplementation((_target, _method, _params, callback) =>
      callback({ ok: true }),
    );
  });

  afterEach(() => vi.useRealTimers());

  it('attaches once and sends commands to the active tab', async () => {
    const session = new ChromeDebuggerSession();
    await expect(session.send('Page.enable')).resolves.toEqual({ ok: true });
    await expect(session.send('Runtime.enable')).resolves.toEqual({ ok: true });
    expect(attach).toHaveBeenCalledTimes(1);
    expect(sendCommand).toHaveBeenCalledWith(
      { tabId: 7 },
      'Page.enable',
      {},
      expect.any(Function),
    );
    await session.detach();
  });

  it('rejects restricted pages before attaching', async () => {
    query.mockResolvedValueOnce([{ id: 8, url: 'chrome://extensions' }]);
    const session = new ChromeDebuggerSession();
    await expect(session.ensureAttached()).rejects.toThrow(
      'does not allow debugging',
    );
    expect(attach).not.toHaveBeenCalled();
  });

  it('rejects local file pages before attaching', async () => {
    query.mockResolvedValueOnce([{ id: 8, url: 'file:///tmp/secret.txt' }]);
    const session = new ChromeDebuggerSession();
    await expect(session.ensureAttached()).rejects.toThrow(
      'does not allow debugging',
    );
    expect(attach).not.toHaveBeenCalled();
  });

  it('keeps the first attached tab when the active tab changes', async () => {
    query.mockResolvedValueOnce([{ id: 7, url: 'https://one.example' }]);
    const session = new ChromeDebuggerSession();

    await session.send('Page.enable');
    await session.send('Runtime.enable');

    expect(attach).toHaveBeenNthCalledWith(
      1,
      { tabId: 7 },
      '1.3',
      expect.any(Function),
    );
    expect(query).toHaveBeenCalledTimes(1);
    expect(attach).toHaveBeenCalledTimes(1);
    expect(sendCommand).toHaveBeenLastCalledWith(
      { tabId: 7 },
      'Runtime.enable',
      {},
      expect.any(Function),
    );
    await session.detach();
  });

  it('reattaches after Chrome detaches the debugger', async () => {
    const session = new ChromeDebuggerSession();
    const listener = vi.fn();
    session.onEvent(listener);
    await session.send('Page.enable');

    const detachListener = onDetach.addListener.mock.calls.at(-1)?.[0];
    detachListener({ tabId: 7 }, 'canceled_by_user');
    await session.send('Runtime.enable');

    expect(listener).toHaveBeenCalledWith('Qwen.detached', {
      reason: 'canceled_by_user',
    });
    expect(attach).toHaveBeenCalledTimes(2);
    await session.detach();
  });

  it('coalesces concurrent attachment attempts', async () => {
    let finishAttach: (() => void) | undefined;
    attach.mockImplementation((_target, _version, callback) => {
      finishAttach = callback;
    });
    const session = new ChromeDebuggerSession();

    const first = session.ensureAttached();
    const second = session.ensureAttached();
    await vi.waitFor(() => expect(finishAttach).toBeTypeOf('function'));
    finishAttach!();

    await expect(Promise.all([first, second])).resolves.toEqual([
      { tabId: 7, changed: true },
      { tabId: 7, changed: true },
    ]);
    expect(attach).toHaveBeenCalledTimes(1);
    await session.detach();
  });

  it('detaches an attachment that finishes during shutdown', async () => {
    let finishAttach: (() => void) | undefined;
    attach.mockImplementation((_target, _version, callback) => {
      finishAttach = callback;
    });
    const session = new ChromeDebuggerSession();

    const pendingAttach = session.ensureAttached();
    await vi.waitFor(() => expect(finishAttach).toBeTypeOf('function'));
    const shutdown = session.detach();
    finishAttach!();

    await expect(pendingAttach).rejects.toThrow('canceled');
    await shutdown;
    expect(detach).toHaveBeenCalledWith({ tabId: 7 }, expect.any(Function));
  });

  it('pins commands to one tab for an operation', async () => {
    query
      .mockResolvedValueOnce([{ id: 7, url: 'https://one.example' }])
      .mockResolvedValueOnce([{ id: 8, url: 'https://two.example' }]);
    const session = new ChromeDebuggerSession();

    await session.withAttached(async () => {
      await session.send('DOM.getBoxModel');
      await session.send('Input.dispatchMouseEvent');
    });

    expect(query).toHaveBeenCalledTimes(1);
    expect(sendCommand).toHaveBeenNthCalledWith(
      1,
      { tabId: 7 },
      'DOM.getBoxModel',
      {},
      expect.any(Function),
    );
    expect(sendCommand).toHaveBeenNthCalledWith(
      2,
      { tabId: 7 },
      'Input.dispatchMouseEvent',
      {},
      expect.any(Function),
    );

    await session.withAttached(() => session.send('Runtime.enable'));
    expect(detach).toHaveBeenCalledWith({ tabId: 7 }, expect.any(Function));
    expect(attach).toHaveBeenNthCalledWith(
      2,
      { tabId: 8 },
      '1.3',
      expect.any(Function),
    );
    expect(sendCommand).toHaveBeenLastCalledWith(
      { tabId: 8 },
      'Runtime.enable',
      {},
      expect.any(Function),
    );
    await session.detach();
  });

  it('rejects a restricted active target before each operation', async () => {
    query
      .mockResolvedValueOnce([{ id: 7, url: 'https://one.example' }])
      .mockResolvedValueOnce([{ id: 7, url: 'chrome://settings' }]);
    const session = new ChromeDebuggerSession();

    await session.withAttached(() => session.send('Runtime.enable'));
    await expect(
      session.withAttached(() => session.send('Runtime.evaluate')),
    ).rejects.toThrow('does not allow debugging');

    expect(detach).toHaveBeenCalledWith({ tabId: 7 }, expect.any(Function));
    expect(sendCommand).toHaveBeenCalledTimes(1);
  });

  it('surfaces debugger attachment and command errors', async () => {
    attach.mockImplementationOnce((_target, _version, callback) => {
      runtime.lastError = { message: 'already attached' };
      callback();
      runtime.lastError = undefined;
    });
    const attachSession = new ChromeDebuggerSession();
    await expect(attachSession.ensureAttached()).rejects.toThrow(
      'already attached',
    );
    await expect(attachSession.ensureAttached()).resolves.toEqual({
      tabId: 7,
      changed: true,
    });
    await attachSession.detach();

    sendCommand.mockImplementationOnce(
      (_target, _method, _params, callback) => {
        runtime.lastError = { message: 'target closed' };
        callback();
        runtime.lastError = undefined;
      },
    );
    const commandSession = new ChromeDebuggerSession();
    await expect(commandSession.send('Page.enable')).rejects.toThrow(
      'target closed',
    );
    await commandSession.detach();
  });

  it('releases the operation queue after a CDP command times out', async () => {
    vi.useFakeTimers();
    sendCommand.mockImplementationOnce(() => undefined);
    const session = new ChromeDebuggerSession();

    const timedOut = session.withAttached(() =>
      session.send('Runtime.evaluate'),
    );
    const timedOutError = timedOut.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(timedOutError).resolves.toEqual(
      new Error('Chrome debugger command timed out: Runtime.evaluate'),
    );

    sendCommand.mockImplementation((_target, _method, _params, callback) =>
      callback({ ok: true }),
    );
    await expect(
      session.withAttached(() => session.send('Page.enable')),
    ).resolves.toEqual({ ok: true });
    await session.detach();
  });
});
