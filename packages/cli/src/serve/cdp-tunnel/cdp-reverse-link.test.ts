/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import {
  CdpReverseLink,
  isCdpInboundFrameType,
  type CdpOutboundFrame,
} from './cdp-reverse-link.js';

function setup() {
  const sent: CdpOutboundFrame[] = [];
  const link = new CdpReverseLink((f) => sent.push(f));
  return { link, sent };
}

async function markAttached(
  link: CdpReverseLink,
  sent: CdpOutboundFrame[],
): Promise<void> {
  const p = link.attach();
  const attachId = (sent.at(-1) as { id: number }).id;
  link.handleInbound({ type: 'cdp_attached', id: attachId });
  await p;
}

describe('CdpReverseLink (Plan C #5626)', () => {
  it('forwardToTab sends a cdp_command and resolves on the matching cdp_result', async () => {
    const { link, sent } = setup();
    await markAttached(link, sent);
    const p = link.forwardToTab('Runtime.evaluate', { expression: '1+1' });
    await Promise.resolve();
    expect(sent.at(-1)).toMatchObject({
      type: 'cdp_command',
      method: 'Runtime.evaluate',
      params: { expression: '1+1' },
    });
    const id = (sent.at(-1) as { id: number }).id;
    link.handleInbound({
      type: 'cdp_result',
      id,
      result: { result: { type: 'number', value: 2 } },
    });
    await expect(p).resolves.toEqual({ result: { type: 'number', value: 2 } });
    expect(link.pendingCount()).toBe(0);
  });

  it('rejects forwardToTab on a cdp_result error', async () => {
    const { link, sent } = setup();
    await markAttached(link, sent);
    const p = link.forwardToTab('Page.captureScreenshot', undefined);
    await Promise.resolve();
    const id = (sent.at(-1) as { id: number }).id;
    link.handleInbound({
      type: 'cdp_result',
      id,
      error: { code: -32000, message: 'Not allowed' },
    });
    await expect(p).rejects.toMatchObject({ code: -32000 });
  });

  it('routes cdp_event to the bound emulator as a tab event', () => {
    const { link } = setup();
    const emitTabEvent = vi.fn();
    link.bindEmulator({ emitTabEvent } as never);
    const consumed = link.handleInbound({
      type: 'cdp_event',
      method: 'Network.requestWillBeSent',
      params: { requestId: 'r1' },
    });
    expect(consumed).toBe(true);
    expect(emitTabEvent).toHaveBeenCalledWith('Network.requestWillBeSent', {
      requestId: 'r1',
    });
  });

  it('attach resolves with tab metadata on cdp_attached', async () => {
    const { link, sent } = setup();
    const p = link.attach();
    expect(sent[0]).toMatchObject({ type: 'cdp_attach' });
    const id = (sent[0] as { id: number }).id;
    link.handleInbound({
      type: 'cdp_attached',
      id,
      url: 'https://example.com/',
      title: 'Example',
    });
    await expect(p).resolves.toEqual({
      url: 'https://example.com/',
      title: 'Example',
    });
  });

  it('invokes onDetach when the extension reports cdp_detach', () => {
    const { link } = setup();
    const onDetach = vi.fn();
    link.onDetach = onDetach;
    link.handleInbound({ type: 'cdp_detach', reason: 'DevTools opened' });
    expect(onDetach).toHaveBeenCalledWith('DevTools opened');
  });

  it('rejects a pending attach on detach and ignores the stale attach ack', async () => {
    const { link, sent } = setup();
    const attachP = link.attach();
    attachP.catch(() => undefined);
    const attachId = (sent[0] as { id: number }).id;

    link.handleInbound({ type: 'cdp_detach', reason: 'tab went away' });
    await expect(attachP).rejects.toMatchObject({ message: 'tab went away' });

    link.handleInbound({ type: 'cdp_attached', id: attachId });
    const cmdP = link.forwardToTab('Runtime.evaluate', undefined);
    cmdP.catch(() => undefined);
    await Promise.resolve();

    expect(sent.filter((f) => f.type === 'cdp_attach')).toHaveLength(2);
    expect(sent.some((f) => f.type === 'cdp_command')).toBe(false);
  });

  it('does not stay attached after an attached ack and detach in the same tick', async () => {
    const { link, sent } = setup();
    const attachP = link.attach();
    const attachId = (sent[0] as { id: number }).id;

    link.handleInbound({ type: 'cdp_attached', id: attachId });
    link.handleInbound({ type: 'cdp_detach', reason: 'tab closed' });
    await attachP;

    const cmdP = link.forwardToTab('Runtime.evaluate', undefined);
    cmdP.catch(() => undefined);
    await Promise.resolve();

    expect(sent.filter((f) => f.type === 'cdp_attach')).toHaveLength(2);
    expect(sent.some((f) => f.type === 'cdp_command')).toBe(false);
  });

  it('dispose rejects pending commands and refuses new ones', async () => {
    const { link } = setup();
    const inflight = link.forwardToTab('Runtime.enable', undefined);
    link.dispose('closed');
    await expect(inflight).rejects.toMatchObject({ message: 'closed' });
    await expect(
      link.forwardToTab('Runtime.enable', undefined),
    ).rejects.toMatchObject({ message: 'CDP tunnel closed' });
  });

  it('rejects a forwarded command when its per-command timer expires', async () => {
    vi.useFakeTimers();
    try {
      const sent: CdpOutboundFrame[] = [];
      // Small per-command timeout so the timer fires under the fake clock.
      const link = new CdpReverseLink((f) => sent.push(f), 50);
      await markAttached(link, sent);
      const p = link.forwardToTab('Page.navigate', { url: 'about:blank' });
      await Promise.resolve();
      let err: unknown;
      p.catch((e) => {
        err = e;
      });
      expect(link.pendingCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(50);

      expect(err).toMatchObject({ code: -32000 });
      expect((err as { message: string }).message).toContain('timed out');
      expect(link.pendingCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs forwarded commands, midpoint waits, and timeout context', async () => {
    vi.useFakeTimers();
    try {
      const sent: CdpOutboundFrame[] = [];
      const log = vi.fn();
      const link = new CdpReverseLink((f) => sent.push(f), 50_000, log);
      await markAttached(link, sent);
      const p = link.forwardToTab('Page.navigate', { url: 'about:blank' });
      await Promise.resolve();
      p.catch(() => undefined);

      expect(log).toHaveBeenCalledWith(
        'qwen serve: /cdp forwarded command id=2 method=Page.navigate to extension',
      );

      await vi.advanceTimersByTimeAsync(30_000);
      expect(log).toHaveBeenCalledWith(
        'qwen serve: /cdp still waiting for command id=2 method=Page.navigate after 30000ms',
      );

      await vi.advanceTimersByTimeAsync(20_000);
      await expect(p).rejects.toMatchObject({
        message:
          'CDP command id=2 method=Page.navigate timed out after 50000ms',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('forwardToTab waits for the attach gate before sending a command', async () => {
    const { link, sent } = setup();
    // Open the gate with an in-flight attach (no cdp_attached ack yet).
    const attachP = link.attach();
    const attachId = (sent[0] as { id: number }).id;

    // A command issued while the gate is closed must NOT reach the extension
    // yet — it parks behind the attach so it can't race chrome.debugger.attach.
    const cmdP = link.forwardToTab('Runtime.evaluate', { expression: '1' });
    await Promise.resolve();
    expect(sent.some((f) => f.type === 'cdp_command')).toBe(false);

    // Settle the attach → gate opens → the parked command now sends.
    link.handleInbound({ type: 'cdp_attached', id: attachId });
    await attachP;
    await Promise.resolve();
    const cmd = sent.find((f) => f.type === 'cdp_command');
    expect(cmd).toMatchObject({ method: 'Runtime.evaluate' });

    const cmdId = (cmd as { id: number }).id;
    link.handleInbound({ type: 'cdp_result', id: cmdId, result: { ok: true } });
    await expect(cmdP).resolves.toEqual({ ok: true });
  });

  it('attach rejects when its cdp_attach timer expires', async () => {
    vi.useFakeTimers();
    try {
      const sent: CdpOutboundFrame[] = [];
      const link = new CdpReverseLink((f) => sent.push(f), 50);
      const p = link.attach();
      let err: unknown;
      p.catch((e) => {
        err = e;
      });
      expect(sent[0]).toMatchObject({ type: 'cdp_attach' });

      await vi.advanceTimersByTimeAsync(50);

      expect(err).toMatchObject({ code: -32000 });
      expect((err as { message: string }).message).toContain('timed out');
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a lazy command when attach times out', async () => {
    vi.useFakeTimers();
    try {
      const sent: CdpOutboundFrame[] = [];
      const link = new CdpReverseLink((f) => sent.push(f), 50);
      const cmdP = link.forwardToTab('Runtime.evaluate', undefined);
      cmdP.catch(() => undefined);
      expect(sent[0]).toMatchObject({ type: 'cdp_attach' });

      await vi.advanceTimersByTimeAsync(50);
      await expect(cmdP).rejects.toMatchObject({
        message: 'cdp_attach timed out',
      });
      expect(sent.some((f) => f.type === 'cdp_command')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('isCdpInboundFrameType recognizes extension->daemon frames only', () => {
    expect(isCdpInboundFrameType('cdp_result')).toBe(true);
    expect(isCdpInboundFrameType('cdp_event')).toBe(true);
    expect(isCdpInboundFrameType('cdp_attached')).toBe(true);
    expect(isCdpInboundFrameType('cdp_detach')).toBe(true);
    // Outbound (daemon->extension) frames are not inbound.
    expect(isCdpInboundFrameType('cdp_command')).toBe(false);
    expect(isCdpInboundFrameType('mcp_message')).toBe(false);
  });
});
