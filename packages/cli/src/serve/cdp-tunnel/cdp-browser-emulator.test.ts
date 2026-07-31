/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { CdpBrowserEmulator, type CdpFrame } from './cdp-browser-emulator.js';

function setup(forward?: (m: string, p: unknown) => Promise<unknown>) {
  const replies: CdpFrame[] = [];
  const forwardToTab = vi.fn(forward ?? (async () => ({ ok: true })));
  const emu = new CdpBrowserEmulator(
    { reply: (f) => replies.push(f), forwardToTab },
    { url: 'https://example.com/', title: 'Mock Page' },
  );
  return { emu, replies, forwardToTab };
}

describe('CdpBrowserEmulator (Plan C #5626)', () => {
  it('answers Browser.getVersion and Target.getBrowserContexts locally', async () => {
    const { emu, replies } = setup();
    await emu.handleFromClient({ id: 1, method: 'Browser.getVersion' });
    await emu.handleFromClient({ id: 2, method: 'Target.getBrowserContexts' });
    expect(replies[0]).toMatchObject({
      id: 1,
      result: { protocolVersion: '1.3' },
    });
    expect(replies[1]).toMatchObject({
      id: 2,
      result: { browserContextIds: [] },
    });
  });

  it('emits two targetCreated (tab + page) on setDiscoverTargets', async () => {
    const { emu, replies } = setup();
    await emu.handleFromClient({
      id: 3,
      method: 'Target.setDiscoverTargets',
      params: { discover: true },
    });
    const created = replies.filter((r) => r.method === 'Target.targetCreated');
    expect(
      created.map(
        (c) => (c.params as { targetInfo: { type: string } }).targetInfo.type,
      ),
    ).toEqual(['tab', 'page']);
    expect(replies.at(-1)).toMatchObject({ id: 3, result: {} });
  });

  it('browser-level setAutoAttach attaches the TAB session', async () => {
    const { emu, replies } = setup();
    await emu.handleFromClient({
      id: 4,
      method: 'Target.setAutoAttach',
      params: { flatten: true },
    });
    const attached = replies.find(
      (r) => r.method === 'Target.attachedToTarget',
    );
    expect(attached?.params).toMatchObject({
      targetInfo: { type: 'tab' },
      sessionId: 'qwen-cdp-tab-session',
    });
    expect(attached?.sessionId).toBeUndefined(); // top-level: browser context
    expect(replies.at(-1)).toMatchObject({ id: 4, result: {} });
  });

  it('tab-session setAutoAttach recursively attaches the PAGE session', async () => {
    const { emu, replies } = setup();
    await emu.handleFromClient({
      id: 5,
      method: 'Target.setAutoAttach',
      params: { flatten: true },
      sessionId: 'qwen-cdp-tab-session',
    });
    const attached = replies.find(
      (r) => r.method === 'Target.attachedToTarget',
    );
    expect(attached?.sessionId).toBe('qwen-cdp-tab-session'); // nested under the tab session
    expect(attached?.params).toMatchObject({
      targetInfo: { type: 'page' },
      sessionId: 'qwen-cdp-page-session',
    });
    expect(replies.at(-1)).toMatchObject({
      id: 5,
      sessionId: 'qwen-cdp-tab-session',
      result: {},
    });
  });

  it('forwards page-session commands to the real tab and tags the reply', async () => {
    const { emu, replies, forwardToTab } = setup(async () => ({
      result: { type: 'number', value: 2 },
    }));
    await emu.handleFromClient({
      id: 6,
      method: 'Runtime.evaluate',
      params: { expression: '1+1' },
      sessionId: 'qwen-cdp-page-session',
    });
    expect(forwardToTab).toHaveBeenCalledWith('Runtime.evaluate', {
      expression: '1+1',
    });
    expect(replies[0]).toMatchObject({
      id: 6,
      sessionId: 'qwen-cdp-page-session',
      result: { result: { value: 2 } },
    });
  });

  it('surfaces a forward failure as a CDP error to the client', async () => {
    const { emu, replies } = setup(async () => {
      throw { code: -32000, message: 'Not allowed' };
    });
    await emu.handleFromClient({
      id: 7,
      method: 'Page.captureScreenshot',
      sessionId: 'qwen-cdp-page-session',
    });
    expect(replies[0]).toMatchObject({
      id: 7,
      sessionId: 'qwen-cdp-page-session',
      error: { code: -32000, message: 'Not allowed' },
    });
  });

  it('returns a CDP error for an unknown session instead of a fake success', async () => {
    const { emu, replies, forwardToTab } = setup();
    await emu.handleFromClient({
      id: 8,
      method: 'Runtime.evaluate',
      params: { expression: '1+1' },
      sessionId: 'stale-session',
    });
    // A stale session must not be forwarded to the tab, and must not "succeed".
    expect(forwardToTab).not.toHaveBeenCalled();
    expect(replies[0]).toMatchObject({
      id: 8,
      sessionId: 'stale-session',
      error: { code: -32000, message: 'Unknown CDP session: stale-session' },
    });
    expect(replies[0].result).toBeUndefined();
  });

  it('re-tags tab events with the page session id', () => {
    const { emu, replies } = setup();
    emu.emitTabEvent('Network.requestWillBeSent', { requestId: 'r1' });
    expect(replies[0]).toEqual({
      method: 'Network.requestWillBeSent',
      params: { requestId: 'r1' },
      sessionId: 'qwen-cdp-page-session',
    });
  });
});
