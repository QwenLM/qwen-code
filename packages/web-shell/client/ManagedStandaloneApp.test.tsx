// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManagedAgentWebShellProps } from './ManagedAgentWebShell';

const captured = vi.hoisted(() => ({
  props: undefined as ManagedAgentWebShellProps | undefined,
}));
vi.mock('./ManagedAgentWebShell', () => ({
  ManagedAgentWebShell: (props: ManagedAgentWebShellProps) => {
    captured.props = props;
    return <div>managed-only</div>;
  },
}));

import {
  hasManagedAppMarker,
  ManagedStandaloneApp,
} from './ManagedStandaloneApp';

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

  beforeEach(() => {
    captured.props = undefined;
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
        <ManagedStandaloneApp
          daemonToken="browser-token"
          language="zh-CN"
          theme="light"
        />,
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
    expect(container.textContent).toBe('managed-only');
    expect(captured.props).toMatchObject({
      baseUrl: window.location.origin,
      productScope: BOOT.productScope,
      agentId: 'qwen-code',
      enableWorkspaceBinding: true,
      language: 'zh-CN',
      theme: 'light',
    });
    expect(await captured.props?.getHeaders?.()).toEqual({
      Authorization: 'Bearer browser-token',
    });
    expect(captured.props).not.toHaveProperty('tenantId');
    expect(captured.props).not.toHaveProperty('signingKey');
  });

  it.each([
    new Response('unavailable', { status: 503 }),
    new Response(JSON.stringify({ ...BOOT, mode: 'daemon' })),
    new Response(JSON.stringify({ ...BOOT, productScope: '' })),
  ])(
    'fails closed on unavailable or invalid boot options',
    async (response) => {
      fetch.mockResolvedValue(response);
      await act(async () =>
        root.render(<ManagedStandaloneApp daemonToken="browser-token" />),
      );
      expect(container.querySelector('[role="alert"]')).not.toBeNull();
      expect(captured.props).toBeUndefined();
    },
  );

  it('retries failed boot without constructing an ordinary daemon provider', async () => {
    fetch
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(BOOT)));
    await act(async () =>
      root.render(<ManagedStandaloneApp daemonToken="browser-token" />),
    );
    await act(async () => container.querySelector('button')?.click());
    expect(container.textContent).toBe('managed-only');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
