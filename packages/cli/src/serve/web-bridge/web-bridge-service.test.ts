/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, rm, stat, utimes } from 'node:fs/promises';
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
  });

  it('passes owned tabs to close_session', async () => {
    const registry = new WebBridgeRegistry();
    const call = vi
      .spyOn(registry, 'call')
      .mockResolvedValueOnce({ success: true, tabId: 42 })
      .mockResolvedValueOnce({ success: true, closed: 1 });
    const service = new WebBridgeService(registry, '1.2.3');

    await service.execute({
      action: 'navigate',
      args: { url: 'https://example.test', newTab: true },
      session: 'research',
    });
    await service.execute({
      action: 'close_session',
      args: {},
      session: 'research',
    });

    expect(call).toHaveBeenLastCalledWith('close_session', {
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

  it('keeps the current tab when a new-tab navigation goes stale', async () => {
    const registry = new WebBridgeRegistry();
    const call = vi
      .spyOn(registry, 'call')
      .mockResolvedValueOnce({ success: true, tabId: 17 })
      .mockRejectedValueOnce(new Error('No tab with id: 23'))
      .mockResolvedValueOnce({});
    const service = new WebBridgeService(registry, '1.2.3');

    await service.execute({
      action: 'navigate',
      args: { url: 'https://example.test', newTab: true },
      session: 'research',
    });
    await expect(
      service.execute({
        action: 'navigate',
        args: { url: 'https://example.test/next', newTab: true },
        session: 'research',
      }),
    ).rejects.toThrow('No tab with id: 23');
    await service.execute({
      action: 'snapshot',
      args: {},
      session: 'research',
    });

    expect(call).toHaveBeenLastCalledWith('snapshot', {
      _session: 'research',
      _tabId: 17,
      _tabIds: [17],
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

  it('keeps a session-created tab owned when re-found via find_tab(active)', async () => {
    // Demoting a session's own tab to borrowed would remove it from the
    // close set permanently (close_tab rejects borrowed tabs and
    // close_session filters them out), leaking the tab in the browser.
    const registry = new WebBridgeRegistry();
    const call = vi
      .spyOn(registry, 'call')
      .mockResolvedValueOnce({ success: true, tabId: 99 })
      .mockResolvedValueOnce({ success: true, tabId: 99, borrowed: true })
      .mockResolvedValueOnce({ success: true, closed: 1 });
    const service = new WebBridgeService(registry, '1.2.3');

    await service.execute({
      action: 'navigate',
      args: { url: 'https://example.test', newTab: true },
      session: 'research',
    });
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
      _tabIds: [99],
    });
  });

  it('keeps session state intact when the stale-tab retry fails', async () => {
    const registry = new WebBridgeRegistry();
    const call = vi
      .spyOn(registry, 'call')
      .mockResolvedValueOnce({ success: true, tabId: 99 })
      .mockRejectedValueOnce(new Error('No tab with id: 99'))
      .mockRejectedValueOnce(new Error('tab load timed out'))
      .mockResolvedValueOnce({ success: true, closed: 1 });
    const service = new WebBridgeService(registry, '1.2.3');

    await service.execute({
      action: 'navigate',
      args: { url: 'https://example.test' },
      session: 'research',
    });
    await expect(
      service.execute({
        action: 'navigate',
        args: { url: 'https://example.test' },
        session: 'research',
      }),
    ).rejects.toThrow('tab load timed out');

    // The failed retry must not leave an emptied session entry behind:
    // the original tab stays in the close set.
    await service.execute({
      action: 'close_session',
      args: {},
      session: 'research',
    });
    expect(call).toHaveBeenLastCalledWith('close_session', {
      _session: 'research',
      _tabId: 99,
      _tabIds: [99],
    });
  });

  it('hands ownership of a borrowed tab to the borrower when the owner closes', async () => {
    const registry = new WebBridgeRegistry();
    const call = vi
      .spyOn(registry, 'call')
      .mockResolvedValueOnce({ success: true, tabId: 99 })
      .mockResolvedValueOnce({ success: true, tabId: 99, borrowed: true })
      .mockResolvedValueOnce({ success: true, closed: 0 })
      .mockResolvedValueOnce({ success: true, closed: 1 });
    const service = new WebBridgeService(registry, '1.2.3');

    await service.execute({
      action: 'navigate',
      args: { url: 'https://example.test', newTab: true },
      session: 'owner',
    });
    await service.execute({
      action: 'find_tab',
      args: { url: 'https://example.test', active: true },
      session: 'borrower',
    });
    await service.execute({
      action: 'close_session',
      args: {},
      session: 'owner',
    });

    expect(call).toHaveBeenNthCalledWith(3, 'close_session', {
      _session: 'owner',
      _tabId: 99,
      _tabIds: [],
    });

    // Ownership moved to the borrower, so its close_session closes the tab
    // instead of orphaning it.
    await service.execute({
      action: 'close_session',
      args: {},
      session: 'borrower',
    });
    expect(call).toHaveBeenNthCalledWith(4, 'close_session', {
      _session: 'borrower',
      _tabId: 99,
      _tabIds: [99],
    });
  });

  it('does not close a borrowed tab', async () => {
    const registry = new WebBridgeRegistry();
    const call = vi
      .spyOn(registry, 'call')
      .mockResolvedValueOnce({ success: true, tabId: 99, borrowed: true });
    const service = new WebBridgeService(registry, '1.2.3');

    await service.execute({
      action: 'find_tab',
      args: { url: 'https://example.test', active: true },
      session: 'research',
    });

    await expect(
      service.execute({
        action: 'close_tab',
        args: {},
        session: 'research',
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(call).toHaveBeenCalledOnce();
  });

  it('rejects close_tab while another session borrows the tab', async () => {
    const registry = new WebBridgeRegistry();
    const call = vi
      .spyOn(registry, 'call')
      .mockResolvedValueOnce({ success: true, tabId: 99 })
      .mockResolvedValueOnce({ success: true, tabId: 99, borrowed: true });
    const service = new WebBridgeService(registry, '1.2.3');

    await service.execute({
      action: 'navigate',
      args: { url: 'https://example.test', newTab: true },
      session: 'owner',
    });
    await service.execute({
      action: 'find_tab',
      args: { url: 'https://example.test', active: true },
      session: 'borrower',
    });

    await expect(
      service.execute({
        action: 'close_tab',
        args: {},
        session: 'owner',
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('keeps another session\'s tab out of the close_session close set', async () => {
    const registry = new WebBridgeRegistry();
    const call = vi
      .spyOn(registry, 'call')
      .mockResolvedValueOnce({ success: true, tabId: 99 })
      .mockResolvedValueOnce({ success: true, tabId: 99, borrowed: true })
      .mockResolvedValueOnce({ success: true, closed: 0 });
    const service = new WebBridgeService(registry, '1.2.3');

    await service.execute({
      action: 'navigate',
      args: { url: 'https://example.test', newTab: true },
      session: 'owner',
    });
    await service.execute({
      action: 'find_tab',
      args: { url: 'https://example.test', active: true },
      session: 'borrower',
    });

    await service.execute({
      action: 'close_session',
      args: {},
      session: 'owner',
    });

    expect(call).toHaveBeenLastCalledWith(
      'close_session',
      expect.objectContaining({
        _session: 'owner',
        _tabIds: [],
      }),
    );
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

  it('prunes the oldest artifact directories beyond the cap', async () => {
    const root = tmpdir();
    const created: string[] = [];
    for (let i = 0; i < 130; i++) {
      const dir = path.join(
        root,
        `qwen-webbridge-prune-test-${String(i).padStart(3, '0')}`,
      );
      await mkdir(dir, { recursive: true });
      const time = 1_700_000_000 + i;
      await utimes(dir, time, time);
      created.push(dir);
    }
    let artifactDir = '';
    try {
      const registry = new WebBridgeRegistry();
      vi.spyOn(registry, 'call').mockResolvedValue({
        data: Buffer.from('x').toString('base64'),
        dataLength: 1,
        pageTitle: 'Prune',
      });
      const service = new WebBridgeService(registry, '1.2.3');

      const result = await service.execute({
        action: 'screenshot',
        args: {},
        session: 'prune',
      });
      artifactDir = path.dirname(
        String((result as Record<string, unknown>)['path']),
      );

      await expect(stat(created[0])).rejects.toThrow();
      await expect(stat(created[1])).rejects.toThrow();
      await expect(stat(created[2])).rejects.toThrow();
      await expect(stat(created[3])).resolves.toBeDefined();
    } finally {
      for (const dir of [...created, artifactDir]) {
        if (dir.includes('qwen-webbridge')) {
          await rm(dir, { recursive: true, force: true });
        }
      }
    }
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
        if (process.platform !== 'win32') {
          expect((await stat(path.dirname(filePath))).mode & 0o777).toBe(0o700);
          expect((await stat(filePath)).mode & 0o777).toBe(0o600);
        }
      } finally {
        if (filePath && filePath.includes('qwen-webbridge')) {
          await rm(path.dirname(filePath), { force: true, recursive: true });
        }
      }
    },
  );
});
