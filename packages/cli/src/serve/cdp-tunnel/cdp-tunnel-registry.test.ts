/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import {
  CdpTunnelRegistry,
  type CdpBridgeEndpoint,
} from './cdp-tunnel-registry.js';

function endpoint(id: string): CdpBridgeEndpoint {
  return {
    connectionId: id,
    send: vi.fn(),
    routeInbound: vi.fn(() => true),
  };
}

describe('CdpTunnelRegistry (Plan C #5626)', () => {
  it('register exposes the active bridge; getActive/hasActive reflect it', () => {
    const reg = new CdpTunnelRegistry();
    expect(reg.hasActive()).toBe(false);
    expect(reg.getActive()).toBeUndefined();

    const ep = endpoint('a');
    reg.register(ep);
    expect(reg.hasActive()).toBe(true);
    expect(reg.getActive()).toBe(ep);
  });

  it('routeInbound delegates to the active bridge, false when none', () => {
    const reg = new CdpTunnelRegistry();
    expect(reg.routeInbound({ type: 'cdp_event' })).toBe(false);

    const ep = endpoint('a');
    reg.register(ep);
    const frame = { type: 'cdp_result', id: 1 };
    expect(reg.routeInbound(frame)).toBe(true);
    expect(ep.routeInbound).toHaveBeenCalledWith(frame);
  });

  it('a second register supersedes the first (last-writer-wins)', () => {
    const reg = new CdpTunnelRegistry();
    const a = endpoint('a');
    const b = endpoint('b');
    reg.register(a);
    reg.register(b);
    expect(reg.getActive()).toBe(b);
  });

  it('superseding a bridge notifies the old one (onExtensionGone) so its /cdp client closes', () => {
    const reg = new CdpTunnelRegistry();
    const a = endpoint('a');
    const goneA = vi.fn();
    a.onExtensionGone = goneA;
    const b = endpoint('b');
    const goneB = vi.fn();
    b.onExtensionGone = goneB;

    reg.register(a);
    reg.register(b);

    // The superseded bridge is told it's gone; the new active one is not.
    expect(goneA).toHaveBeenCalledTimes(1);
    expect(goneB).not.toHaveBeenCalled();
    expect(reg.getActive()).toBe(b);
  });

  it('re-registering the same endpoint does not fire its onExtensionGone', () => {
    const reg = new CdpTunnelRegistry();
    const ep = endpoint('a');
    const gone = vi.fn();
    ep.onExtensionGone = gone;

    reg.register(ep);
    reg.register(ep);

    expect(gone).not.toHaveBeenCalled();
    expect(reg.getActive()).toBe(ep);
  });

  it('unregister fires onExtensionGone and clears the active bridge', () => {
    const reg = new CdpTunnelRegistry();
    const ep = endpoint('a');
    const gone = vi.fn();
    ep.onExtensionGone = gone;

    const unregister = reg.register(ep);
    unregister();

    expect(gone).toHaveBeenCalledTimes(1);
    expect(reg.hasActive()).toBe(false);
  });

  it('unregister is idempotent (onExtensionGone fires once)', () => {
    const reg = new CdpTunnelRegistry();
    const ep = endpoint('a');
    const gone = vi.fn();
    ep.onExtensionGone = gone;

    const unregister = reg.register(ep);
    unregister();
    unregister();

    expect(gone).toHaveBeenCalledTimes(1);
  });

  it("a superseded bridge's stale unregister does not evict the new active one", () => {
    const reg = new CdpTunnelRegistry();
    const a = endpoint('a');
    const b = endpoint('b');
    const unregisterA = reg.register(a);
    reg.register(b);

    // A's `/acp` socket closes after B took over: must not clear B.
    unregisterA();
    expect(reg.getActive()).toBe(b);
  });
});
