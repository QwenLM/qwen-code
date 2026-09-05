/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import {
  CdpTunnelRegistry,
  type CdpBridgeEndpoint,
  type CdpLinkBinding,
} from './cdp-tunnel-registry.js';

function endpoint(id: string, multiClient = false): CdpBridgeEndpoint {
  return {
    connectionId: id,
    send: vi.fn(),
    multiClient,
  };
}

/** Acquire one link whose routeInbound records frames and returns true. */
function acquire(
  reg: CdpTunnelRegistry,
): { linkId: string; binding: CdpLinkBinding; frames: unknown[] } | undefined {
  const frames: unknown[] = [];
  const binding = reg.acquireLink({
    routeInbound: (frame) => {
      frames.push(frame);
      return true;
    },
  });
  if (!binding) return undefined;
  return { linkId: binding.linkId, binding, frames };
}

describe('CdpTunnelRegistry (Plan C #5626, multi-client #8737)', () => {
  it('register exposes the active bridge; getActive/hasActive reflect it', () => {
    const reg = new CdpTunnelRegistry();
    expect(reg.hasActive()).toBe(false);
    expect(reg.getActive()).toBeUndefined();

    const ep = endpoint('a');
    reg.register(ep);
    expect(reg.hasActive()).toBe(true);
    expect(reg.getActive()).toBe(ep);
  });

  it('routeInbound returns false with no bridge or no links', () => {
    const reg = new CdpTunnelRegistry();
    expect(reg.routeInbound({ type: 'cdp_event' })).toBe(false);

    reg.register(endpoint('a'));
    expect(reg.routeInbound({ type: 'cdp_result', id: 1 })).toBe(false);
  });

  it('untagged frames route to the sole link (legacy single-client)', () => {
    const reg = new CdpTunnelRegistry();
    reg.register(endpoint('a'));
    const link = acquire(reg)!;
    const frame = { type: 'cdp_result', id: 1 };
    expect(reg.routeInbound(frame)).toBe(true);
    expect(link.frames).toEqual([frame]);
  });

  it('legacy bridge refuses a second link (single-client compat)', () => {
    const reg = new CdpTunnelRegistry();
    reg.register(endpoint('a', false));
    expect(acquire(reg)).toBeDefined();
    expect(acquire(reg)).toBeUndefined();
    expect(reg.linkCount()).toBe(1);
  });

  it('multi-client bridge hosts several concurrent links', () => {
    const reg = new CdpTunnelRegistry();
    reg.register(endpoint('a', true));
    const first = acquire(reg)!;
    const second = acquire(reg)!;
    expect(first.linkId).not.toBe(second.linkId);
    expect(reg.linkCount()).toBe(2);
  });

  it('caps multi-client links so a reconnect loop cannot grow state unbounded', () => {
    const reg = new CdpTunnelRegistry();
    reg.register(endpoint('a', true));
    const links = [];
    for (let i = 0; i < 16; i++) {
      links.push(acquire(reg)!);
    }
    expect(reg.linkCount()).toBe(16);
    expect(acquire(reg)).toBeUndefined();

    reg.releaseLink(links[0].linkId);
    expect(acquire(reg)).toBeDefined();
    expect(reg.linkCount()).toBe(16);
  });

  it('tagged result/attached frames route only to the owning link', () => {
    const reg = new CdpTunnelRegistry();
    reg.register(endpoint('a', true));
    const first = acquire(reg)!;
    const second = acquire(reg)!;

    const frame = { type: 'cdp_result', id: 7, linkId: second.linkId };
    expect(reg.routeInbound(frame)).toBe(true);
    expect(first.frames).toHaveLength(0);
    expect(second.frames).toEqual([frame]);
  });

  it('tagged frames for unknown or malformed linkIds are dropped, not routed', () => {
    const reg = new CdpTunnelRegistry();
    reg.register(endpoint('a', true));
    const link = acquire(reg)!;

    expect(
      reg.routeInbound({ type: 'cdp_result', id: 1, linkId: 'nope' }),
    ).toBe(true);
    expect(
      reg.routeInbound({ type: 'cdp_result', id: 1, linkId: 'a'.repeat(65) }),
    ).toBe(true);
    expect(link.frames).toHaveLength(0);
  });

  it('untagged cdp_event/cdp_detach broadcast to every link', () => {
    const reg = new CdpTunnelRegistry();
    reg.register(endpoint('a', true));
    const first = acquire(reg)!;
    const second = acquire(reg)!;

    const event = { type: 'cdp_event', method: 'Page.loadEventFired' };
    const detach = { type: 'cdp_detach', reason: 'target_closed' };
    expect(reg.routeInbound(event)).toBe(true);
    expect(reg.routeInbound(detach)).toBe(true);
    expect(first.frames).toEqual([event, detach]);
    expect(second.frames).toEqual([event, detach]);
  });

  it('untagged result with several links is uncorrelatable and dropped', () => {
    const reg = new CdpTunnelRegistry();
    reg.register(endpoint('a', true));
    const first = acquire(reg)!;
    const second = acquire(reg)!;
    expect(reg.routeInbound({ type: 'cdp_result', id: 1 })).toBe(true);
    expect(first.frames).toHaveLength(0);
    expect(second.frames).toHaveLength(0);
  });

  it('releaseLink unbinds so later tagged frames are dropped', () => {
    const reg = new CdpTunnelRegistry();
    reg.register(endpoint('a', true));
    const link = acquire(reg)!;
    reg.releaseLink(link.linkId);
    expect(reg.linkCount()).toBe(0);
    expect(
      reg.routeInbound({ type: 'cdp_result', id: 1, linkId: link.linkId }),
    ).toBe(true);
    expect(link.frames).toHaveLength(0);
  });

  it('superseding a bridge drops all its links (onExtensionGone each)', () => {
    const reg = new CdpTunnelRegistry();
    reg.register(endpoint('a', true));
    const first = acquire(reg)!;
    const second = acquire(reg)!;
    const goneFirst = vi.fn();
    const goneSecond = vi.fn();
    first.binding.onExtensionGone = goneFirst;
    second.binding.onExtensionGone = goneSecond;

    reg.register(endpoint('b', true));

    expect(goneFirst).toHaveBeenCalledTimes(1);
    expect(goneSecond).toHaveBeenCalledTimes(1);
    expect(reg.linkCount()).toBe(0);
    expect(reg.getActive()?.connectionId).toBe('b');
  });

  it('unregister drops all links once and is idempotent', () => {
    const reg = new CdpTunnelRegistry();
    const unregister = reg.register(endpoint('a', true));
    const link = acquire(reg)!;
    const gone = vi.fn();
    link.binding.onExtensionGone = gone;

    unregister();
    unregister();

    expect(gone).toHaveBeenCalledTimes(1);
    expect(reg.hasActive()).toBe(false);
    expect(reg.linkCount()).toBe(0);
  });

  it("a superseded bridge's stale unregister does not evict the new active one", () => {
    const reg = new CdpTunnelRegistry();
    const a = endpoint('a', true);
    const b = endpoint('b', true);
    const unregisterA = reg.register(a);
    reg.register(b);
    expect(acquire(reg)).toBeDefined();

    // A's `/acp` socket closes after B took over: must not clear B or its link.
    unregisterA();
    expect(reg.getActive()).toBe(b);
    expect(reg.linkCount()).toBe(1);
  });

  it('drops inbound frames from a superseded bridge', () => {
    const reg = new CdpTunnelRegistry();
    const stale = endpoint('stale', true);
    const active = endpoint('active', true);
    reg.register(stale);
    reg.register(active);
    const link = acquire(reg)!;
    const frame = { type: 'cdp_event', method: 'Page.loadEventFired' };

    expect(reg.routeInboundFrom(stale, frame)).toBe(false);
    expect(reg.routeInboundFrom(active, frame)).toBe(true);
    expect(link.frames).toEqual([frame]);
  });

  it('acquireLink without an active bridge returns undefined', () => {
    const reg = new CdpTunnelRegistry();
    expect(acquire(reg)).toBeUndefined();
  });
});
