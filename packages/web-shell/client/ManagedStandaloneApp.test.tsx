// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManagedAgentProvider } from './components/managed/managed-agent-provider';
import type { ManagedAgentWebShellProps } from './ManagedAgentWebShell';

import {
  hasManagedAppMarker,
  ManagedStandaloneApp,
} from './ManagedStandaloneApp';

const gateway = vi.hoisted(() => ({
  props: [] as ManagedAgentWebShellProps[],
}));
vi.mock('./ManagedAgentWebShell', () => ({
  ManagedAgentWebShell: (props: ManagedAgentWebShellProps) => {
    gateway.props.push(props);
    return (
      <button onClick={() => props.onSessionChange?.('session-new')}>
        Managed only
      </button>
    );
  },
}));

const BOOT = {
  mode: 'managed',
  productScope: 'local:installation-1',
  agentId: 'qwen-code',
  enableWorkspaceBinding: true,
};

describe('Managed standalone application', () => {
  let container: HTMLDivElement;
  let root: Root;
  const fetch = vi.fn();
  const renderShell = vi.fn((provider: ManagedAgentProvider) => (
    <div>Local and Managed: {String(provider.canCancel)}</div>
  ));

  beforeEach(() => {
    gateway.props = [];
    renderShell.mockClear();
    fetch.mockReset();
    vi.stubGlobal('fetch', fetch);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    document.querySelector('meta[name="qwen-managed-app"]')?.remove();
    window.history.replaceState(null, '', '/');
    vi.unstubAllGlobals();
  });

  it('selects managed mode only from the server HTML marker', () => {
    window.history.replaceState(
      null,
      '',
      '/?managedProvider=java&managed=true',
    );
    expect(hasManagedAppMarker()).toBe(false);
    const marker = document.createElement('meta');
    marker.name = 'qwen-managed-app';
    marker.content = 'true';
    document.head.appendChild(marker);
    expect(hasManagedAppMarker()).toBe(true);
  });

  it('uses authenticated same-origin boot and Java provider without accepting browser identity', async () => {
    window.history.replaceState(
      null,
      '',
      '/?daemon=https://attacker.example&tenant=other&actor=other',
    );
    fetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          ...BOOT,
          baseUrl: 'https://attacker.example',
          tenantId: 'attacker',
          signingKey: 'untrusted',
        }),
      ),
    );
    await act(async () => {
      root.render(
        <ManagedStandaloneApp daemonToken="browser-token" language="zh-CN">
          {renderShell}
        </ManagedStandaloneApp>,
      );
    });
    expect(fetch).toHaveBeenCalledWith(
      `${window.location.origin}/managed/boot`,
      expect.objectContaining({
        headers: { Authorization: 'Bearer browser-token' },
        cache: 'no-store',
        redirect: 'error',
      }),
    );
    expect(container.textContent).toBe('Local and Managed: true');
    const provider = renderShell.mock.calls.at(-1)?.[0];
    expect(provider?.workspaceBinding?.agentId).toBe('qwen-code');
    expect(provider?.storageKey).toBe(
      JSON.stringify([
        window.location.origin,
        BOOT.productScope,
        BOOT.agentId,
        'workspace-binding-v1',
      ]),
    );
    fetch.mockResolvedValueOnce(Response.json({ data: [], hasMore: false }));
    await provider?.listSessions({ clientId: 'browser-client' });
    expect(fetch.mock.calls.at(-1)?.[0]).toBe(
      `${window.location.origin}/api/agent/web-shell/v1/sessions/query`,
    );
    const request = fetch.mock.calls.at(-1)?.[1] as RequestInit;
    const headers = new Headers(request.headers);
    expect(headers.get('authorization')).toBe('Bearer browser-token');
    expect(headers.get('x-qwen-tenant-id')).toBeNull();
    expect(headers.get('x-qwen-actor-id')).toBeNull();
    expect(headers.get('x-qwen-signature')).toBeNull();
  });

  it('keeps the composed shell and provider stable across parent renders', async () => {
    fetch.mockResolvedValue(Response.json(BOOT));
    await act(async () =>
      root.render(
        <ManagedStandaloneApp daemonToken="browser-token">
          {renderShell}
        </ManagedStandaloneApp>,
      ),
    );
    const provider = renderShell.mock.calls.at(-1)?.[0];
    await act(async () =>
      root.render(
        <ManagedStandaloneApp daemonToken="browser-token" language="zh-CN">
          {renderShell}
        </ManagedStandaloneApp>,
      ),
    );
    expect(renderShell.mock.calls.at(-1)?.[0]).toBe(provider);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('boots the existing Managed-only UI without composing daemon contexts', async () => {
    window.history.replaceState(
      null,
      '',
      '/?managed=1&managedSession=session-kept',
    );
    fetch.mockResolvedValue(Response.json({ ...BOOT, managedOnly: true }));
    await act(async () =>
      root.render(
        <ManagedStandaloneApp daemonToken="browser-token" language="zh-CN">
          {renderShell}
        </ManagedStandaloneApp>,
      ),
    );
    expect(renderShell).not.toHaveBeenCalled();
    expect(container.textContent).toBe('Managed only');
    expect(fetch).toHaveBeenCalledOnce();
    expect(gateway.props.at(-1)).toMatchObject({
      baseUrl: window.location.origin,
      productScope: BOOT.productScope,
      agentId: 'qwen-code',
      enableWorkspaceBinding: true,
      language: 'zh-CN',
      sessionId: 'session-kept',
    });
    expect(await gateway.props.at(-1)?.getHeaders?.()).toEqual({
      Authorization: 'Bearer browser-token',
    });
    await act(async () => container.querySelector('button')?.click());
    expect(gateway.props.at(-1)?.sessionId).toBe('session-new');
    expect(
      new URL(window.location.href).searchParams.get('managedSession'),
    ).toBe('session-new');
    await act(async () => {
      window.history.replaceState(
        null,
        '',
        '/?managed=1&managedSession=session-kept',
      );
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(gateway.props.at(-1)?.sessionId).toBe('session-kept');
  });

  it('adds history only when the selected gateway Session changes', async () => {
    window.history.replaceState(
      null,
      '',
      '/?managed=1&managedSession=session-kept&view=history#fragment',
    );
    fetch.mockResolvedValue(Response.json({ ...BOOT, managedOnly: true }));
    await act(async () =>
      root.render(
        <ManagedStandaloneApp daemonToken="browser-token">
          {renderShell}
        </ManagedStandaloneApp>,
      ),
    );
    const initialLength = window.history.length;
    await act(async () =>
      gateway.props.at(-1)?.onSessionChange?.('session-kept'),
    );
    expect(window.history.length).toBe(initialLength);
    await act(async () =>
      gateway.props.at(-1)?.onSessionChange?.('session-new'),
    );
    expect(window.history.length).toBe(initialLength + 1);
    await act(async () =>
      gateway.props.at(-1)?.onSessionChange?.('session-new'),
    );
    expect(window.history.length).toBe(initialLength + 1);
    expect(gateway.props.at(-1)?.sessionId).toBe('session-new');
    expect(window.location.search).toContain('view=history');
    expect(window.location.hash).toBe('#fragment');
    await act(async () => gateway.props.at(-1)?.onSessionChange?.(undefined));
    expect(window.history.length).toBe(initialLength + 2);
    await act(async () => gateway.props.at(-1)?.onSessionChange?.(undefined));
    expect(window.history.length).toBe(initialLength + 2);
    expect(gateway.props.at(-1)?.sessionId).toBeUndefined();
  });

  it('supplies admitted local model presets to the new-task picker', async () => {
    const modelPresets = [{ agentId: 'agent_model_b', label: 'Model B' }];
    fetch.mockResolvedValue(Response.json({ ...BOOT, modelPresets }));
    await act(async () =>
      root.render(
        <ManagedStandaloneApp daemonToken="browser-token">
          {renderShell}
        </ManagedStandaloneApp>,
      ),
    );
    expect(
      renderShell.mock.calls.at(-1)?.[0]?.workspaceBinding?.modelPresets,
    ).toEqual(modelPresets);
  });

  it('keeps multiple local model choices on the built-in Agent', async () => {
    const modelPresets = [
      { agentId: 'qwen-code', modelId: 'model-a', label: 'A' },
      { agentId: 'qwen-code', modelId: 'model-b', label: 'B' },
    ];
    fetch.mockResolvedValue(Response.json({ ...BOOT, modelPresets }));
    await act(async () =>
      root.render(
        <ManagedStandaloneApp daemonToken="browser-token">
          {renderShell}
        </ManagedStandaloneApp>,
      ),
    );
    expect(
      renderShell.mock.calls.at(-1)?.[0]?.workspaceBinding?.modelPresets,
    ).toEqual(modelPresets);
  });

  it('waits for authenticated boot before composing the shell', async () => {
    fetch.mockReturnValue(new Promise(() => {}));
    await act(async () =>
      root.render(
        <ManagedStandaloneApp daemonToken="browser-token" language="zh-CN">
          {renderShell}
        </ManagedStandaloneApp>,
      ),
    );
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      '正在连接…',
    );
    expect(renderShell).not.toHaveBeenCalled();
  });

  it.each([
    new Response('unavailable', { status: 503 }),
    new Response(JSON.stringify({ ...BOOT, mode: 'daemon' })),
    new Response(JSON.stringify({ ...BOOT, productScope: '' })),
    new Response(JSON.stringify({ ...BOOT, agentId: '' })),
    new Response(JSON.stringify({ ...BOOT, enableWorkspaceBinding: false })),
    Response.json({ ...BOOT, managedOnly: 'true' }),
    Response.json({ ...BOOT, modelPresets: null }),
    Response.json({
      ...BOOT,
      modelPresets: [{ modelId: 'model-a', label: 'A' }],
    }),
    Response.json({ ...BOOT, modelPresets: [{ agentId: ' ', label: 'A' }] }),
    Response.json({ ...BOOT, modelPresets: [{ agentId: 'a', label: ' ' }] }),
    Response.json({
      ...BOOT,
      modelPresets: [
        { agentId: 'a', label: 'A' },
        { agentId: 'a', label: 'B' },
      ],
    }),
  ])(
    'fails closed on unavailable or invalid boot options',
    async (response) => {
      fetch.mockResolvedValue(response);
      await act(async () =>
        root.render(
          <ManagedStandaloneApp daemonToken="browser-token">
            {renderShell}
          </ManagedStandaloneApp>,
        ),
      );
      expect(container.querySelector('[role="alert"]')).not.toBeNull();
      expect(renderShell).not.toHaveBeenCalled();
    },
  );

  it('retries failed boot before composing the unified shell', async () => {
    fetch
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(BOOT)));
    await act(async () =>
      root.render(
        <ManagedStandaloneApp daemonToken="browser-token">
          {renderShell}
        </ManagedStandaloneApp>,
      ),
    );
    expect(renderShell).not.toHaveBeenCalled();
    await act(async () => container.querySelector('button')?.click());
    expect(container.textContent).toBe('Local and Managed: true');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
