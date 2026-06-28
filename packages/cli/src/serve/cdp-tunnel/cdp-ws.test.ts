/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { attachCdpClient } from './cdp-ws.js';
import type { CdpOutboundFrame } from './cdp-reverse-link.js';
import type {
  CdpBridgeEndpoint,
  CdpTunnelRegistry,
} from './cdp-tunnel-registry.js';

/** Minimal stand-in for the puppeteer `ws` WebSocket attachCdpClient drives. */
class FakeWs {
  readyState = 1;
  readonly OPEN = 1;
  sent: string[] = [];
  pings = 0;
  closed: { code: number; reason: string } | null = null;
  private handlers: Record<string, (arg?: unknown) => void> = {};
  on(event: string, cb: (arg?: unknown) => void): this {
    this.handlers[event] = cb;
    return this;
  }
  send(data: string): void {
    this.sent.push(data);
  }
  ping(): void {
    this.pings++;
  }
  close(code: number, reason: string): void {
    if (this.readyState === 3) return;
    this.closed = { code, reason };
    this.readyState = 3;
  }
  emit(event: string, arg?: unknown): void {
    this.handlers[event]?.(arg);
  }
}

function makeBridge(): {
  bridge: CdpBridgeEndpoint;
  sent: CdpOutboundFrame[];
} {
  const sent: CdpOutboundFrame[] = [];
  const bridge: CdpBridgeEndpoint = {
    connectionId: 'test-conn',
    send: (f) => {
      sent.push(f);
    },
    routeInbound: () => false,
    cdpBound: false,
    onExtensionGone: undefined,
  };
  return { bridge, sent };
}

/** Registry stub with a swappable active bridge (to model supersession). */
function makeRegistry(active?: CdpBridgeEndpoint): {
  registry: CdpTunnelRegistry;
  setActive: (b?: CdpBridgeEndpoint) => void;
} {
  let current = active;
  return {
    registry: { getActive: () => current } as unknown as CdpTunnelRegistry,
    setActive: (b) => {
      current = b;
    },
  };
}

function bind(ws: FakeWs, registry: CdpTunnelRegistry): void {
  attachCdpClient(ws as unknown as WebSocket, registry, () => {});
}

const releases = (sent: CdpOutboundFrame[]) =>
  sent.filter((f) => f.type === 'cdp_release');

describe('attachCdpClient (Plan C #5626)', () => {
  it('rejects with 1011 when no extension bridge is connected', () => {
    const ws = new FakeWs();
    bind(ws, makeRegistry(undefined).registry);
    expect(ws.closed?.code).toBe(1011);
  });

  it('rejects a second puppeteer client while one is already bound', () => {
    const { bridge } = makeBridge();
    bridge.cdpBound = true; // first client already bound
    const ws = new FakeWs();
    bind(ws, makeRegistry(bridge).registry);
    expect(ws.closed?.code).toBe(1011);
    expect(ws.closed?.reason).toMatch(/already connected/i);
    expect(bridge.cdpBound).toBe(true); // untouched
  });

  it('binds the bridge and kicks an attach', () => {
    const { bridge, sent } = makeBridge();
    const ws = new FakeWs();
    bind(ws, makeRegistry(bridge).registry);
    expect(bridge.cdpBound).toBe(true);
    expect(ws.closed).toBeNull();
    expect(sent.some((f) => f.type === 'cdp_attach')).toBe(true);
  });

  it('onExtensionGone closes the puppeteer socket without sending a release', () => {
    const { bridge, sent } = makeBridge();
    const ws = new FakeWs();
    bind(ws, makeRegistry(bridge).registry);
    expect(bridge.onExtensionGone).toBeTypeOf('function');
    bridge.onExtensionGone?.();
    expect(ws.closed?.code).toBe(1000);
    // The extension is already gone — must NOT try to notify it.
    expect(releases(sent)).toHaveLength(0);
  });

  it('on normal puppeteer close, sends cdp_release and clears cdpBound', () => {
    const { bridge, sent } = makeBridge();
    const ws = new FakeWs();
    bind(ws, makeRegistry(bridge).registry);
    ws.emit('close');
    expect(releases(sent)).toHaveLength(1);
    expect(bridge.cdpBound).toBe(false);
    expect(bridge.onExtensionGone).toBeUndefined();
  });

  it('a superseded client closing leaves the new active bridge untouched', () => {
    const { bridge: a, sent: aSent } = makeBridge();
    const { bridge: b } = makeBridge();
    b.cdpBound = true;
    const reg = makeRegistry(a);
    const ws = new FakeWs();
    bind(ws, reg.registry);
    reg.setActive(b); // a fresh extension bridge replaced `a`
    ws.emit('close'); // a's stale puppeteer socket drops
    // dispose must not release or reset the now-active bridge `b`.
    expect(releases(aSent)).toHaveLength(0);
    expect(b.cdpBound).toBe(true);
  });

  it('pings the /cdp socket and tears down the binding when pong is missed', async () => {
    vi.useFakeTimers();
    try {
      const { bridge, sent } = makeBridge();
      const ws = new FakeWs();
      bind(ws, makeRegistry(bridge).registry);

      await vi.advanceTimersByTimeAsync(15_000);
      expect(ws.pings).toBe(1);
      expect(bridge.cdpBound).toBe(true);

      await vi.advanceTimersByTimeAsync(15_000);
      expect(ws.closed?.code).toBe(1000);
      expect(ws.closed?.reason).toMatch(/heartbeat/i);
      expect(bridge.cdpBound).toBe(false);
      expect(releases(sent)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
