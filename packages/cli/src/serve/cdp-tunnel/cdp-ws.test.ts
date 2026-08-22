/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { attachCdpClient } from './cdp-ws.js';
import type { CdpOutboundFrame } from './cdp-reverse-link.js';
import {
  CdpTunnelRegistry,
  type CdpBridgeEndpoint,
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

function makeBridge(multiClient = false): {
  bridge: CdpBridgeEndpoint;
  sent: CdpOutboundFrame[];
} {
  const sent: CdpOutboundFrame[] = [];
  const bridge: CdpBridgeEndpoint = {
    connectionId: 'test-conn',
    send: (f) => {
      sent.push(f);
    },
    multiClient,
  };
  return { bridge, sent };
}

function makeRegistry(bridge?: CdpBridgeEndpoint): CdpTunnelRegistry {
  const registry = new CdpTunnelRegistry();
  if (bridge) registry.register(bridge);
  return registry;
}

function bind(ws: FakeWs, registry: CdpTunnelRegistry): void {
  attachCdpClient(ws as unknown as WebSocket, registry, () => {});
}

const releases = (sent: CdpOutboundFrame[]) =>
  sent.filter((f) => f.type === 'cdp_release');

describe('attachCdpClient (Plan C #5626)', () => {
  it('rejects with 1011 when no extension bridge is connected', () => {
    const ws = new FakeWs();
    bind(ws, makeRegistry(undefined));
    expect(ws.closed?.code).toBe(1011);
  });

  it('rejects a second puppeteer client while one is already bound (legacy bridge)', () => {
    const { bridge } = makeBridge(false);
    const registry = makeRegistry(bridge);
    const first = new FakeWs();
    bind(first, registry);
    expect(first.closed).toBeNull();
    expect(registry.linkCount()).toBe(1);

    const second = new FakeWs();
    bind(second, registry);
    expect(second.closed?.code).toBe(1011);
    expect(second.closed?.reason).toMatch(/already connected/i);
    expect(registry.linkCount()).toBe(1);
  });

  it('binds the bridge without attaching immediately', () => {
    const { bridge, sent } = makeBridge();
    const ws = new FakeWs();
    bind(ws, makeRegistry(bridge));
    expect(ws.closed).toBeNull();
    expect(sent.some((f) => f.type === 'cdp_attach')).toBe(false);
  });

  it('lazy-attaches before forwarding the first page command', async () => {
    const { bridge, sent } = makeBridge();
    const registry = makeRegistry(bridge);
    const ws = new FakeWs();
    bind(ws, registry);

    ws.emit(
      'message',
      JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression: '1+1' },
        sessionId: 'qwen-cdp-page-session',
      }),
    );

    await vi.waitFor(() =>
      expect(sent[0]).toMatchObject({ type: 'cdp_attach' }),
    );
    expect(sent.some((f) => f.type === 'cdp_command')).toBe(false);

    const attachId = (sent[0] as { id: number }).id;
    registry.routeInbound({
      type: 'cdp_attached',
      id: attachId,
      url: 'https://example.com/',
      title: 'Example',
    });

    await vi.waitFor(() =>
      expect(sent.some((f) => f.type === 'cdp_command')).toBe(true),
    );
    const command = sent.find((f) => f.type === 'cdp_command') as
      | { id: number }
      | undefined;
    expect(command).toMatchObject({ id: expect.any(Number) });
    registry.routeInbound({
      type: 'cdp_result',
      id: command?.id,
      result: { result: { type: 'number', value: 2 } },
    });

    await vi.waitFor(() => expect(ws.sent).toHaveLength(1));
    expect(JSON.parse(ws.sent[0] ?? '{}')).toMatchObject({
      id: 1,
      sessionId: 'qwen-cdp-page-session',
      result: { result: { value: 2 } },
    });
  });

  it('closes and releases the link when lazy attach fails', async () => {
    const { bridge, sent } = makeBridge();
    const registry = makeRegistry(bridge);
    const ws = new FakeWs();
    bind(ws, registry);

    ws.emit(
      'message',
      JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        sessionId: 'qwen-cdp-page-session',
      }),
    );

    await vi.waitFor(() =>
      expect(sent[0]).toMatchObject({ type: 'cdp_attach' }),
    );
    const attachId = (sent[0] as { id: number }).id;
    registry.routeInbound({
      type: 'cdp_attached',
      id: attachId,
      error: { message: 'Permission denied' },
    });

    await vi.waitFor(() => expect(ws.closed?.code).toBe(1011));
    expect(ws.closed?.reason).toBe('cdp attach failed');
    expect(registry.linkCount()).toBe(0);
    expect(releases(sent)).toHaveLength(0);
  });

  it('does not release when detach rejects a pending lazy attach', async () => {
    const { bridge, sent } = makeBridge();
    const registry = makeRegistry(bridge);
    const ws = new FakeWs();
    bind(ws, registry);

    ws.emit(
      'message',
      JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        sessionId: 'qwen-cdp-page-session',
      }),
    );

    await vi.waitFor(() =>
      expect(sent[0]).toMatchObject({ type: 'cdp_attach' }),
    );
    registry.routeInbound({ type: 'cdp_detach', reason: 'tab closed' });

    expect(ws.closed?.code).toBe(1000);
    expect(ws.closed?.reason).toBe('tab detached: tab closed');
    await vi.waitFor(() => expect(registry.linkCount()).toBe(0));
    expect(releases(sent)).toHaveLength(0);
  });

  it('bridge unregister closes the puppeteer socket without sending a release', () => {
    const { bridge, sent } = makeBridge();
    const registry = makeRegistry(bridge);
    const ws = new FakeWs();
    const unregister = registry.register(bridge); // idempotent re-register
    bind(ws, registry);
    unregister();
    expect(ws.closed?.code).toBe(1000);
    // The extension is already gone — must NOT try to notify it.
    expect(releases(sent)).toHaveLength(0);
    expect(registry.linkCount()).toBe(0);
  });

  it('on normal puppeteer close, sends cdp_release and releases the link', () => {
    const { bridge, sent } = makeBridge();
    const registry = makeRegistry(bridge);
    const ws = new FakeWs();
    bind(ws, registry);
    ws.emit('close');
    expect(releases(sent)).toHaveLength(1);
    expect(registry.linkCount()).toBe(0);
  });

  it('a superseded client closing leaves the new active bridge untouched', () => {
    const { bridge: a, sent: aSent } = makeBridge();
    const { bridge: b } = makeBridge();
    const reg = makeRegistry(a);
    const ws = new FakeWs();
    bind(ws, reg);
    reg.register(b); // a fresh extension bridge replaced `a`
    // Supersession already closed the stale client via onExtensionGone.
    expect(ws.closed?.code).toBe(1000);
    ws.emit('close'); // the stale socket's close event lands afterward
    // dispose must not release against the now-active bridge `b`.
    expect(releases(aSent)).toHaveLength(0);
    expect(reg.getActive()).toBe(b);
  });

  it('pings the /cdp socket and tears down the binding when pong is missed', async () => {
    vi.useFakeTimers();
    try {
      const { bridge, sent } = makeBridge();
      const registry = makeRegistry(bridge);
      const ws = new FakeWs();
      bind(ws, registry);

      await vi.advanceTimersByTimeAsync(15_000);
      expect(ws.pings).toBe(1);
      expect(registry.linkCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(15_000);
      expect(ws.closed?.code).toBe(1000);
      expect(ws.closed?.reason).toMatch(/heartbeat/i);
      expect(registry.linkCount()).toBe(0);
      expect(releases(sent)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('attachCdpClient multi-client bridge (issue #8737)', () => {
  it('hosts two concurrent puppeteer clients with distinct linkIds', async () => {
    const { bridge, sent } = makeBridge(true);
    const registry = makeRegistry(bridge);
    const wsA = new FakeWs();
    const wsB = new FakeWs();
    bind(wsA, registry);
    bind(wsB, registry);

    expect(wsA.closed).toBeNull();
    expect(wsB.closed).toBeNull();
    expect(registry.linkCount()).toBe(2);

    // Both lazy-attach independently.
    const pageCommand = JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      sessionId: 'qwen-cdp-page-session',
    });
    wsA.emit('message', pageCommand);
    wsB.emit('message', pageCommand);

    await vi.waitFor(() =>
      expect(sent.filter((f) => f.type === 'cdp_attach')).toHaveLength(2),
    );
    const attaches = sent.filter((f) => f.type === 'cdp_attach') as Array<{
      id: number;
      linkId?: string;
    }>;
    expect(attaches[0]?.linkId).toMatch(/^cdp-link-/);
    expect(attaches[1]?.linkId).toMatch(/^cdp-link-/);
    expect(attaches[0]?.linkId).not.toBe(attaches[1]?.linkId);
  });

  it('tags outbound frames with the link id and routes tagged results to the owner only', async () => {
    const { bridge, sent } = makeBridge(true);
    const registry = makeRegistry(bridge);
    const wsA = new FakeWs();
    const wsB = new FakeWs();
    bind(wsA, registry);
    bind(wsB, registry);

    const pageCommand = (id: number) =>
      JSON.stringify({
        id,
        method: 'Runtime.evaluate',
        sessionId: 'qwen-cdp-page-session',
      });
    wsA.emit('message', pageCommand(1));
    wsB.emit('message', pageCommand(2));

    await vi.waitFor(() =>
      expect(sent.filter((f) => f.type === 'cdp_attach')).toHaveLength(2),
    );
    const attachA = sent.find((f) => f.type === 'cdp_attach') as {
      id: number;
      linkId: string;
    };
    const attachB = sent.filter((f) => f.type === 'cdp_attach').at(-1) as {
      id: number;
      linkId: string;
    };

    // Ack both attaches; each ack must echo its own linkId.
    registry.routeInbound({
      type: 'cdp_attached',
      id: attachA.id,
      linkId: attachA.linkId,
    });
    registry.routeInbound({
      type: 'cdp_attached',
      id: attachB.id,
      linkId: attachB.linkId,
    });

    await vi.waitFor(() =>
      expect(sent.filter((f) => f.type === 'cdp_command')).toHaveLength(2),
    );
    const commandA = sent.find((f) => f.type === 'cdp_command') as {
      id: number;
      linkId: string;
    };
    const commandB = sent.filter((f) => f.type === 'cdp_command').at(-1) as {
      id: number;
      linkId: string;
    };
    expect(commandA.linkId).toBe(attachA.linkId);
    expect(commandB.linkId).toBe(attachB.linkId);

    // Answer only A; only A's puppeteer socket sees the reply.
    registry.routeInbound({
      type: 'cdp_result',
      id: commandA.id,
      linkId: commandA.linkId,
      result: { ok: 'a' },
    });

    await vi.waitFor(() => expect(wsA.sent).toHaveLength(1));
    expect(wsB.sent).toHaveLength(0);
    expect(JSON.parse(wsA.sent[0] ?? '{}')).toMatchObject({
      id: 1,
      result: { ok: 'a' },
    });
  });

  it('broadcasts tab events to every link', async () => {
    const { bridge, sent } = makeBridge(true);
    const registry = makeRegistry(bridge);
    const wsA = new FakeWs();
    const wsB = new FakeWs();
    bind(wsA, registry);
    bind(wsB, registry);

    // Events reach every bound link even before attach (each emulator decides
    // whether it has a live page session to deliver on).
    registry.routeInbound({
      type: 'cdp_event',
      method: 'Page.loadEventFired',
      params: {},
    });
    // No crash, nothing forwarded to clients without attached sessions.
    expect(wsA.sent).toHaveLength(0);
    expect(wsB.sent).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it('sends a tagged cdp_release on close', () => {
    const { bridge, sent } = makeBridge(true);
    const registry = makeRegistry(bridge);
    const ws = new FakeWs();
    bind(ws, registry);
    ws.emit('close');
    const [release] = releases(sent);
    expect(release).toMatchObject({
      type: 'cdp_release',
      linkId: expect.stringMatching(/^cdp-link-/),
    });
    expect(registry.linkCount()).toBe(0);
  });
});
