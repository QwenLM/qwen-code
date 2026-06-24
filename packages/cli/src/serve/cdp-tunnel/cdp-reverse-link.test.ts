/**
 * @license
 * Copyright 2025 Qwen Team
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

describe('CdpReverseLink (Plan C #5626)', () => {
  it('forwardToTab sends a cdp_command and resolves on the matching cdp_result', async () => {
    const { link, sent } = setup();
    const p = link.forwardToTab('Runtime.evaluate', { expression: '1+1' });
    expect(sent[0]).toMatchObject({
      type: 'cdp_command',
      method: 'Runtime.evaluate',
      params: { expression: '1+1' },
    });
    const id = (sent[0] as { id: number }).id;
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
    const p = link.forwardToTab('Page.captureScreenshot', undefined);
    const id = (sent[0] as { id: number }).id;
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

  it('dispose rejects pending commands and refuses new ones', async () => {
    const { link } = setup();
    const inflight = link.forwardToTab('Runtime.enable', undefined);
    link.dispose('closed');
    await expect(inflight).rejects.toMatchObject({ message: 'closed' });
    await expect(
      link.forwardToTab('Runtime.enable', undefined),
    ).rejects.toMatchObject({ message: 'CDP tunnel closed' });
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
