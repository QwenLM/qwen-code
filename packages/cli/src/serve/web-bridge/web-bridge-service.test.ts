/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { readFile, rm } from 'node:fs/promises';
import { WebBridgeRegistry } from './web-bridge-registry.js';
import { WebBridgeService } from './web-bridge-service.js';

describe('WebBridgeService', () => {
  it('tracks a session tab and injects it into later actions', async () => {
    const registry = new WebBridgeRegistry();
    const call = vi
      .spyOn(registry, 'call')
      .mockResolvedValueOnce({ success: true, tabId: 42 })
      .mockResolvedValueOnce({ title: 'Example' });
    const service = new WebBridgeService(registry, '1.2.3');

    await service.execute({
      action: 'navigate',
      args: { url: 'https://example.test', newTab: true },
      session: 'research',
    });
    await service.execute({
      action: 'snapshot',
      args: {},
      session: 'research',
    });

    expect(call).toHaveBeenLastCalledWith('snapshot', {
      _session: 'research',
      _tabId: 42,
      _tabIds: [42],
    });
  });

  it('serializes commands across sessions', async () => {
    const registry = new WebBridgeRegistry();
    let release!: () => void;
    const first = new Promise<void>((resolve) => {
      release = resolve;
    });
    const call = vi
      .spyOn(registry, 'call')
      .mockImplementationOnce(async () => {
        await first;
        return {};
      })
      .mockResolvedValueOnce({});
    const service = new WebBridgeService(registry, '1.2.3');

    const one = service.execute({ action: 'snapshot', args: {}, session: 'a' });
    const two = service.execute({ action: 'snapshot', args: {}, session: 'b' });
    await Promise.resolve();
    expect(call).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([one, two]);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('rejects command queue overflow before contacting the extension', async () => {
    const registry = new WebBridgeRegistry();
    let release!: () => void;
    const first = new Promise<void>((resolve) => {
      release = resolve;
    });
    const call = vi
      .spyOn(registry, 'call')
      .mockImplementationOnce(async () => {
        await first;
        return {};
      })
      .mockResolvedValue({});
    const service = new WebBridgeService(registry, '1.2.3');
    const pending = Array.from({ length: 32 }, (_, index) =>
      service.execute({
        action: 'snapshot',
        args: {},
        session: `session-${index}`,
      }),
    );

    await expect(
      service.execute({ action: 'snapshot', args: {}, session: 'overflow' }),
    ).rejects.toThrow('queue is full');
    expect(call).toHaveBeenCalledOnce();
    release();
    await Promise.all(pending);
  });

  it('bounds retained browser sessions', async () => {
    const registry = new WebBridgeRegistry();
    let tabId = 0;
    const call = vi
      .spyOn(registry, 'call')
      .mockImplementation(async () => ({ success: true, tabId: ++tabId }));
    const service = new WebBridgeService(registry, '1.2.3');

    for (let index = 0; index < 64; index++) {
      await service.execute({
        action: 'navigate',
        args: { url: 'https://example.test', newTab: true },
        session: `session-${index}`,
      });
    }
    await expect(
      service.execute({
        action: 'navigate',
        args: { url: 'https://example.test', newTab: true },
        session: 'overflow',
      }),
    ).rejects.toThrow('session limit reached');
    expect(call).toHaveBeenCalledTimes(64);
  });

  it('expires queued commands without blocking later commands', async () => {
    vi.useFakeTimers({ now: 0 });
    try {
      const registry = new WebBridgeRegistry();
      let release!: () => void;
      const first = new Promise<void>((resolve) => {
        release = resolve;
      });
      const call = vi
        .spyOn(registry, 'call')
        .mockImplementationOnce(async () => {
          await first;
          return {};
        })
        .mockResolvedValue({});
      const service = new WebBridgeService(registry, '1.2.3');

      const running = service.execute({
        action: 'snapshot',
        args: {},
        session: 'running',
      });
      await Promise.resolve();
      const expired = service.execute({
        action: 'snapshot',
        args: {},
        session: 'expired',
      });
      const rejection = expired.catch((error: unknown) => error);

      vi.setSystemTime(60_000);
      release();
      await running;
      expect(await rejection).toMatchObject({ statusCode: 503 });
      expect(call).toHaveBeenCalledOnce();

      await expect(
        service.execute({
          action: 'snapshot',
          args: {},
          session: 'later',
        }),
      ).resolves.toEqual({});
      expect(call).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('recovers stale navigation with a new owned tab', async () => {
    const registry = new WebBridgeRegistry();
    const call = vi
      .spyOn(registry, 'call')
      .mockResolvedValueOnce({ success: true, tabId: 42 })
      .mockRejectedValueOnce(new Error('No tab with id: 42'))
      .mockResolvedValueOnce({ success: true, tabId: 43 })
      .mockResolvedValueOnce({});
    const service = new WebBridgeService(registry, '1.2.3');

    await service.execute({
      action: 'navigate',
      args: { url: 'https://example.test', newTab: true },
      session: 'research',
    });
    await service.execute({
      action: 'navigate',
      args: { url: 'https://example.test/next' },
      session: 'research',
    });
    await service.execute({
      action: 'snapshot',
      args: {},
      session: 'research',
    });

    expect(call).toHaveBeenNthCalledWith(3, 'navigate', {
      url: 'https://example.test/next',
      newTab: true,
      _session: 'research',
      _tabId: undefined,
      _tabIds: [],
    });
    expect(call).toHaveBeenLastCalledWith('snapshot', {
      _session: 'research',
      _tabId: 43,
      _tabIds: [43],
    });
  });

  it('never includes a borrowed tab in close_session ownership', async () => {
    const registry = new WebBridgeRegistry();
    const call = vi
      .spyOn(registry, 'call')
      .mockResolvedValueOnce({ success: true, tabId: 99, borrowed: true })
      .mockResolvedValueOnce({ success: true, closed: 0 })
      .mockResolvedValueOnce({});
    const service = new WebBridgeService(registry, '1.2.3');

    await service.execute({
      action: 'find_tab',
      args: { url: 'https://example.test', active: true },
      session: 'research',
    });
    await service.execute({
      action: 'close_session',
      args: {},
      session: 'research',
    });

    expect(call).toHaveBeenLastCalledWith('close_session', {
      _session: 'research',
      _tabId: 99,
      _tabIds: [],
    });
    await service.execute({
      action: 'snapshot',
      args: {},
      session: 'research',
    });
    expect(call).toHaveBeenLastCalledWith('snapshot', {
      _session: 'research',
      _tabId: undefined,
      _tabIds: [],
    });
  });

  it('keeps a borrowed tab selected after navigating it', async () => {
    const registry = new WebBridgeRegistry();
    const call = vi
      .spyOn(registry, 'call')
      .mockResolvedValueOnce({ success: true, tabId: 99, borrowed: true })
      .mockResolvedValueOnce({ success: true, tabId: 99 })
      .mockResolvedValueOnce({ success: true, tabs: [] });
    const service = new WebBridgeService(registry, '1.2.3');

    await service.execute({
      action: 'find_tab',
      args: { url: 'https://example.test', active: true },
      session: 'research',
    });
    await service.execute({
      action: 'navigate',
      args: { url: 'https://example.test/next' },
      session: 'research',
    });
    await service.execute({
      action: 'list_tabs',
      args: {},
      session: 'research',
    });

    expect(call).toHaveBeenLastCalledWith('list_tabs', {
      _session: 'research',
      _tabId: 99,
      _tabIds: [],
    });
  });

  it('forgets session tabs missing from list_tabs', async () => {
    const registry = new WebBridgeRegistry();
    const call = vi
      .spyOn(registry, 'call')
      .mockResolvedValueOnce({ success: true, tabId: 42 })
      .mockResolvedValueOnce({ success: true, tabs: [] })
      .mockResolvedValueOnce({});
    const service = new WebBridgeService(registry, '1.2.3');

    await service.execute({
      action: 'navigate',
      args: { url: 'https://example.test', newTab: true },
      session: 'research',
    });
    await service.execute({
      action: 'list_tabs',
      args: {},
      session: 'research',
    });
    await service.execute({
      action: 'snapshot',
      args: {},
      session: 'research',
    });
    expect(call).toHaveBeenLastCalledWith('snapshot', {
      _session: 'research',
      _tabId: undefined,
      _tabIds: [],
    });
  });

  it('rejects unsupported actions before contacting the extension', async () => {
    const registry = new WebBridgeRegistry();
    const call = vi.spyOn(registry, 'call');
    const service = new WebBridgeService(registry, '1.2.3');

    await expect(
      service.execute({ action: 'unknown', args: {}, session: 'test' }),
    ).rejects.toThrow('Unknown WebBridge action');
    expect(call).not.toHaveBeenCalled();
  });

  it('rejects oversized commands before queueing them', async () => {
    const registry = new WebBridgeRegistry();
    const call = vi.spyOn(registry, 'call');
    const service = new WebBridgeService(registry, '1.2.3');

    await expect(
      service.execute({
        action: 'evaluate',
        args: { code: 'x'.repeat(256 * 1024) },
        session: 'test',
      }),
    ).rejects.toMatchObject({ statusCode: 413 });
    expect(call).not.toHaveBeenCalled();
  });

  it('forgets a session tab that was already closed', async () => {
    const registry = new WebBridgeRegistry();
    const call = vi
      .spyOn(registry, 'call')
      .mockResolvedValueOnce({ success: true, tabId: 42 })
      .mockResolvedValueOnce({
        success: true,
        closed: false,
        reason: 'tab already closed',
      })
      .mockResolvedValueOnce({});
    const service = new WebBridgeService(registry, '1.2.3');

    await service.execute({
      action: 'navigate',
      args: { url: 'https://example.test', newTab: true },
      session: 'research',
    });
    await service.execute({
      action: 'close_tab',
      args: {},
      session: 'research',
    });
    await service.execute({
      action: 'snapshot',
      args: {},
      session: 'research',
    });

    expect(call).toHaveBeenLastCalledWith('snapshot', {
      _session: 'research',
      _tabId: undefined,
      _tabIds: [],
    });
  });

  it('does not accept caller-supplied internal tab state', async () => {
    const registry = new WebBridgeRegistry();
    const call = vi.spyOn(registry, 'call').mockResolvedValue({});
    const service = new WebBridgeService(registry, '1.2.3');

    await service.execute({
      action: 'snapshot',
      args: { _tabId: 999, _tabIds: [999] },
      session: 'fresh',
    });

    expect(call).toHaveBeenCalledWith('snapshot', {
      _session: 'fresh',
      _tabId: undefined,
      _tabIds: [],
    });
  });

  it('does not retain a new session when its action fails', async () => {
    const registry = new WebBridgeRegistry();
    const call = vi
      .spyOn(registry, 'call')
      .mockRejectedValueOnce(new Error('disconnected'))
      .mockResolvedValueOnce({});
    const service = new WebBridgeService(registry, '1.2.3');

    await expect(
      service.execute({ action: 'snapshot', args: {}, session: 'failed' }),
    ).rejects.toThrow('disconnected');
    await service.execute({ action: 'snapshot', args: {}, session: 'failed' });
    expect(call).toHaveBeenLastCalledWith('snapshot', {
      _session: 'failed',
      _tabId: undefined,
      _tabIds: [],
    });
  });

  it.each([
    ['screenshot', 'png', 'image/png'],
    ['save_as_pdf', 'pdf', 'application/pdf'],
  ] as const)(
    'persists %s data returned by the extension',
    async (action, extension, mimeType) => {
      let filePath = '';
      try {
        const registry = new WebBridgeRegistry();
        vi.spyOn(registry, 'call').mockResolvedValue({
          data: Buffer.from('artifact bytes').toString('base64'),
          dataLength: 20,
          format: extension === 'png' ? 'png' : undefined,
          pageTitle: 'Example',
        });
        const service = new WebBridgeService(registry, '1.2.3');

        const result = await service.execute({
          action,
          args: { path: '/caller/cannot/choose-this' },
          session: 'artifact-test',
        });
        expect(result).toMatchObject({ mimeType, sizeBytes: 14 });
        filePath = String((result as Record<string, unknown>)['path']);
        expect(filePath).toContain('qwen-webbridge');
        await expect(readFile(filePath, 'utf8')).resolves.toBe(
          'artifact bytes',
        );
      } finally {
        if (filePath) await rm(filePath, { force: true });
      }
    },
  );
});
