/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
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
    expect(service.sessionSnapshot('research')).toMatchObject({
      currentTabId: 42,
      ownedTabIds: [42],
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
      .mockResolvedValueOnce({ success: true, tabId: 43 });
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

    expect(call).toHaveBeenLastCalledWith('navigate', {
      url: 'https://example.test/next',
      newTab: true,
      _session: 'research',
      _tabId: undefined,
      _tabIds: [],
    });
    expect(service.sessionSnapshot('research')).toMatchObject({
      currentTabId: 43,
      ownedTabIds: [43],
    });
  });

  it('never includes a borrowed tab in close_session ownership', async () => {
    const registry = new WebBridgeRegistry();
    const call = vi
      .spyOn(registry, 'call')
      .mockResolvedValueOnce({ success: true, tabId: 99, borrowed: true })
      .mockResolvedValueOnce({ success: true, closed: 0 });
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
    expect(service.sessionSnapshot('research')).toBeNull();
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
    expect(service.sessionSnapshot('research')).toMatchObject({
      currentTabId: 99,
      ownedTabIds: [],
      borrowedTabId: 99,
    });
  });

  it('forgets session tabs missing from list_tabs', async () => {
    const registry = new WebBridgeRegistry();
    vi.spyOn(registry, 'call')
      .mockResolvedValueOnce({ success: true, tabId: 42 })
      .mockResolvedValueOnce({ success: true, tabs: [] });
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

    expect(service.sessionSnapshot('research')).toBeNull();
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
    vi.spyOn(registry, 'call').mockRejectedValue(new Error('disconnected'));
    const service = new WebBridgeService(registry, '1.2.3');

    await expect(
      service.execute({ action: 'snapshot', args: {}, session: 'failed' }),
    ).rejects.toThrow('disconnected');
    expect(service.sessionSnapshot('failed')).toBeNull();
  });

  it.each([
    ['screenshot', 'png', 'image/png'],
    ['save_as_pdf', 'pdf', 'application/pdf'],
  ] as const)(
    'persists %s data returned by the extension',
    async (action, extension, mimeType) => {
      const directory = await mkdtemp(
        path.join(tmpdir(), 'qwen-webbridge-test-'),
      );
      const filePath = path.join(directory, `artifact.${extension}`);
      try {
        const registry = new WebBridgeRegistry();
        vi.spyOn(registry, 'call').mockResolvedValue({
          data: Buffer.from('artifact bytes').toString('base64'),
          dataLength: 20,
          format: extension === 'png' ? 'png' : undefined,
          pageTitle: 'Example',
        });
        const service = new WebBridgeService(registry, '1.2.3');

        await expect(
          service.execute({
            action,
            args: { path: filePath },
            session: 'artifact-test',
          }),
        ).resolves.toMatchObject({ path: filePath, mimeType, sizeBytes: 14 });
        await expect(readFile(filePath, 'utf8')).resolves.toBe(
          'artifact bytes',
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
