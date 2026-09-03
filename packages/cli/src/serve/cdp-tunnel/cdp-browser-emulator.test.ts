/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment node

import { describe, it, expect, vi } from 'vitest';
import { CdpBrowserEmulator, type CdpFrame } from './cdp-browser-emulator.js';

function setup(forward?: (m: string, p: unknown) => Promise<unknown>) {
  const replies: CdpFrame[] = [];
  const log = vi.fn();
  const forwardToTab = vi.fn(forward ?? (async () => ({ ok: true })));
  const emu = new CdpBrowserEmulator(
    { reply: (f) => replies.push(f), forwardToTab, log },
    { url: 'https://example.com/', title: 'Mock Page' },
  );
  return { emu, replies, forwardToTab, log };
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

  it('creates and forwards an explicitly attached page session', async () => {
    const { emu, replies, forwardToTab } = setup(async () => ({ value: 2 }));
    await emu.handleFromClient({
      id: 7,
      method: 'Target.attachToTarget',
      params: { targetId: 'qwen-cdp-page', flatten: true },
    });
    const attached = replies.find(
      (reply) => reply.method === 'Target.attachedToTarget',
    );
    const sessionId = (attached?.params as { sessionId?: string })?.sessionId;
    expect(sessionId).toBeTruthy();
    expect(replies.at(-1)).toMatchObject({ id: 7, result: { sessionId } });

    replies.length = 0;
    await emu.handleFromClient({
      id: 8,
      method: 'Runtime.evaluate',
      params: { expression: '1+1' },
      sessionId,
    });
    expect(forwardToTab).toHaveBeenCalledWith('Runtime.evaluate', {
      expression: '1+1',
    });
    expect(replies[0]).toMatchObject({
      id: 8,
      sessionId,
      result: { value: 2 },
    });

    replies.length = 0;
    await emu.handleFromClient({
      id: 9,
      method: 'Target.detachFromTarget',
      params: { sessionId },
    });
    expect(replies[0]).toEqual({
      method: 'Target.detachedFromTarget',
      params: { sessionId, targetId: 'qwen-cdp-page' },
    });
    expect(replies[1]).toEqual({ id: 9, result: {} });
    await emu.handleFromClient({
      id: 10,
      method: 'Runtime.evaluate',
      sessionId,
    });
    expect(replies[2]).toMatchObject({
      id: 10,
      error: { message: `Unknown CDP session: ${sessionId}` },
    });
  });

  it('rejects attachToTarget for a target that is not the page', async () => {
    const { emu, replies } = setup();
    await emu.handleFromClient({
      id: 15,
      method: 'Target.attachToTarget',
      params: { targetId: 'qwen-cdp-tab', flatten: true },
    });
    // The tab target is advertised but only attachable via setAutoAttach, so an
    // explicit attach must fail without minting a session.
    expect(
      replies.find((reply) => reply.method === 'Target.attachedToTarget'),
    ).toBeUndefined();
    expect(replies.at(-1)).toMatchObject({
      id: 15,
      error: { code: -32000, message: 'Cannot attach to target: qwen-cdp-tab' },
    });
  });

  it('reports that the selected page has no DevTools target', async () => {
    const { emu, replies, log } = setup();
    await emu.handleFromClient({
      id: 11,
      method: 'Target.getDevToolsTarget',
      params: { targetId: 'qwen-cdp-page' },
    });
    expect(replies[0]).toEqual({ id: 11, result: {} });
    expect(log).not.toHaveBeenCalled();
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

  it('re-tags tab events with the page session id after auto-attach', async () => {
    const { emu, replies } = setup();
    await emu.handleFromClient({
      id: 30,
      method: 'Target.setAutoAttach',
      params: { flatten: true },
      sessionId: 'qwen-cdp-tab-session',
    });
    replies.length = 0;
    emu.emitTabEvent('Network.requestWillBeSent', { requestId: 'r1' });
    expect(replies[0]).toEqual({
      method: 'Network.requestWillBeSent',
      params: { requestId: 'r1' },
      sessionId: 'qwen-cdp-page-session',
    });
  });

  it('keeps the auto-attach session silent when autoAttach is false', async () => {
    const { emu, replies } = setup();
    await emu.handleFromClient({
      id: 32,
      method: 'Target.setAutoAttach',
      params: { autoAttach: false, flatten: true },
      sessionId: 'qwen-cdp-tab-session',
    });
    expect(
      replies.filter((r) => r.method === 'Target.attachedToTarget'),
    ).toHaveLength(0);
    replies.length = 0;
    emu.emitTabEvent('Network.requestWillBeSent', { requestId: 'r-off' });
    expect(
      replies.filter((reply) => reply.sessionId === 'qwen-cdp-page-session'),
    ).toHaveLength(0);
  });

  it('skips the auto-attach session when no setAutoAttach handshake occurred', async () => {
    const { emu, replies } = setup();
    await emu.handleFromClient({
      id: 31,
      method: 'Target.attachToTarget',
      params: { targetId: 'qwen-cdp-page', flatten: true },
    });
    const attached = replies.find(
      (reply) => reply.method === 'Target.attachedToTarget',
    );
    const sessionId = (attached?.params as { sessionId?: string })?.sessionId;
    replies.length = 0;
    emu.emitTabEvent('Network.requestWillBeSent', { requestId: 'r-skip' });
    expect(
      replies.filter((reply) => reply.sessionId === 'qwen-cdp-page-session'),
    ).toHaveLength(0);
    expect(
      replies.filter((reply) => reply.sessionId === sessionId),
    ).toHaveLength(1);
  });

  it('broadcasts tab events to attached sessions until they detach', async () => {
    const { emu, replies } = setup();
    await emu.handleFromClient({
      id: 12,
      method: 'Target.attachToTarget',
      params: { targetId: 'qwen-cdp-page', flatten: true },
    });
    const attached = replies.find(
      (reply) => reply.method === 'Target.attachedToTarget',
    );
    const sessionId = (attached?.params as { sessionId?: string })?.sessionId;
    expect(sessionId).toBeTruthy();

    replies.length = 0;
    emu.emitTabEvent('Network.requestWillBeSent', { requestId: 'r2' });
    // No auto-attach handshake, so only the explicit session receives events.
    expect(replies).toEqual([
      {
        method: 'Network.requestWillBeSent',
        params: { requestId: 'r2' },
        sessionId,
      },
    ]);

    await emu.handleFromClient({
      id: 13,
      method: 'Target.detachFromTarget',
      params: { sessionId },
    });
    replies.length = 0;
    emu.emitTabEvent('Network.requestWillBeSent', { requestId: 'r3' });
    // No auto-attach handshake occurred, so the auto-attach session is silent
    // and the detached explicit session is gone — nothing is emitted.
    expect(replies).toEqual([]);
  });

  it('delivers each event once to a client that attached through a single path', async () => {
    const { emu, replies } = setup();
    // Bring up BOTH attach mechanisms against the same page: the recursive
    // auto-attach handshake mints PAGE_SESSION_ID...
    await emu.handleFromClient({
      id: 20,
      method: 'Target.setAutoAttach',
      params: { flatten: true },
      sessionId: 'qwen-cdp-tab-session',
    });
    // ...and an explicit attachToTarget mints a second, distinct session.
    await emu.handleFromClient({
      id: 21,
      method: 'Target.attachToTarget',
      params: { targetId: 'qwen-cdp-page', flatten: true },
    });
    const explicit = replies.find(
      (reply) =>
        reply.method === 'Target.attachedToTarget' &&
        (reply.params as { sessionId?: string }).sessionId !==
          'qwen-cdp-page-session',
    );
    const explicitSessionId = (explicit?.params as { sessionId?: string })
      ?.sessionId;
    expect(explicitSessionId).toBeTruthy();

    replies.length = 0;
    emu.emitTabEvent('Network.requestWillBeSent', { requestId: 'r-once' });

    // The fan-out reaches both sessions, but a client listens only on the one
    // session it attached through, so from its point of view each event lands
    // exactly once — its request/console buffers cannot double-count.
    expect(
      replies.filter((reply) => reply.sessionId === 'qwen-cdp-page-session'),
    ).toHaveLength(1);
    expect(
      replies.filter((reply) => reply.sessionId === explicitSessionId),
    ).toHaveLength(1);
  });

  it('stops auto-attach delivery when the page session is detached', async () => {
    const { emu, replies } = setup();
    await emu.handleFromClient({
      id: 33,
      method: 'Target.setAutoAttach',
      params: { flatten: true },
      sessionId: 'qwen-cdp-tab-session',
    });
    replies.length = 0;
    await emu.handleFromClient({
      id: 34,
      method: 'Target.detachFromTarget',
      params: { sessionId: 'qwen-cdp-page-session' },
    });
    expect(replies[0]).toEqual({
      method: 'Target.detachedFromTarget',
      params: { sessionId: 'qwen-cdp-page-session', targetId: 'qwen-cdp-page' },
    });
    replies.length = 0;
    emu.emitTabEvent('Network.requestWillBeSent', { requestId: 'r-detached' });
    expect(
      replies.filter((reply) => reply.sessionId === 'qwen-cdp-page-session'),
    ).toHaveLength(0);
  });

  it('rejects commands on the page session after detach', async () => {
    const { emu, replies, forwardToTab } = setup();
    await emu.handleFromClient({
      id: 40,
      method: 'Target.setAutoAttach',
      params: { flatten: true },
      sessionId: 'qwen-cdp-tab-session',
    });
    await emu.handleFromClient({
      id: 41,
      method: 'Target.detachFromTarget',
      params: { sessionId: 'qwen-cdp-page-session' },
    });
    replies.length = 0;
    await emu.handleFromClient({
      id: 42,
      method: 'Runtime.evaluate',
      params: { expression: '1+1' },
      sessionId: 'qwen-cdp-page-session',
    });
    expect(forwardToTab).not.toHaveBeenCalled();
    expect(replies[0]).toMatchObject({
      id: 42,
      sessionId: 'qwen-cdp-page-session',
      error: {
        code: -32000,
        message: 'Unknown CDP session: qwen-cdp-page-session',
      },
    });
  });

  it('restores page-session forwarding after re-attach', async () => {
    const { emu, replies, forwardToTab } = setup(async () => ({ value: 42 }));
    await emu.handleFromClient({
      id: 50,
      method: 'Target.setAutoAttach',
      params: { flatten: true },
      sessionId: 'qwen-cdp-tab-session',
    });
    await emu.handleFromClient({
      id: 51,
      method: 'Target.detachFromTarget',
      params: { sessionId: 'qwen-cdp-page-session' },
    });
    // Re-attach via a new setAutoAttach handshake.
    await emu.handleFromClient({
      id: 52,
      method: 'Target.setAutoAttach',
      params: { flatten: true },
      sessionId: 'qwen-cdp-tab-session',
    });
    replies.length = 0;
    await emu.handleFromClient({
      id: 53,
      method: 'Runtime.evaluate',
      params: { expression: '6*7' },
      sessionId: 'qwen-cdp-page-session',
    });
    expect(forwardToTab).toHaveBeenCalledWith('Runtime.evaluate', {
      expression: '6*7',
    });
    expect(replies[0]).toMatchObject({
      id: 53,
      sessionId: 'qwen-cdp-page-session',
      result: { value: 42 },
    });
  });

  it('re-logs periodically while tab events keep dropping', async () => {
    const { emu, log } = setup();
    emu.emitTabEvent('Console.messageAdded', { message: 'm1' });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain('dropped');
    emu.emitTabEvent('Console.messageAdded', { message: 'm2' });
    expect(log).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 98; i += 1) {
      emu.emitTabEvent('Console.messageAdded', { message: `m${i + 3}` });
    }
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[1][0]).toContain('100 total');
  });

  it('does not emit detachedFromTarget for a never-attached session', async () => {
    const { emu, replies, log } = setup();
    await emu.handleFromClient({
      id: 14,
      method: 'Target.detachFromTarget',
      params: { sessionId: 'qwen-cdp-page-session' },
    });
    expect(
      replies.find((reply) => reply.method === 'Target.detachedFromTarget'),
    ).toBeUndefined();
    expect(replies.at(-1)).toEqual({ id: 14, result: {} });
    expect(log).not.toHaveBeenCalled();
  });

  it('keeps forwarding page-session commands after a no-handshake detach', async () => {
    const { emu, forwardToTab } = setup(async () => ({ value: 1 }));
    await emu.handleFromClient({
      id: 15,
      method: 'Target.detachFromTarget',
      params: { sessionId: 'qwen-cdp-page-session' },
    });
    await emu.handleFromClient({
      id: 16,
      method: 'Runtime.evaluate',
      params: { expression: '1' },
      sessionId: 'qwen-cdp-page-session',
    });
    expect(forwardToTab).toHaveBeenCalledWith('Runtime.evaluate', {
      expression: '1',
    });
  });

  it('errors when detaching an unrecognized session id', async () => {
    const { emu, replies } = setup();
    await emu.handleFromClient({
      id: 60,
      method: 'Target.detachFromTarget',
      params: { sessionId: 'qwen-cdp-page-session-99' },
    });
    expect(
      replies.find((reply) => reply.method === 'Target.detachedFromTarget'),
    ).toBeUndefined();
    expect(replies.at(-1)).toEqual({
      id: 60,
      error: {
        code: -32000,
        message: 'Unknown CDP session: qwen-cdp-page-session-99',
      },
    });
  });
});
