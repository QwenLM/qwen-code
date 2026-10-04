// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const captured = vi.hoisted(() => ({
  props: undefined as unknown,
  renders: [] as unknown[],
  probeRequests: false,
  requests: [] as Array<Promise<unknown>>,
}));

vi.mock('./components/managed/ManagedSessionsPage', async () => {
  const { useEffect } = await import('react');
  return {
    ManagedSessionsPage: (props: unknown) => {
      captured.props = props;
      captured.renders.push(props);
      const { managedAgentProvider } = props as {
        managedAgentProvider: ManagedAgentProvider;
      };
      // Issues a request from a child effect whenever the provider identity
      // changes — the same trigger ManagedSessionsContent's list effect has.
      useEffect(() => {
        if (captured.probeRequests)
          captured.requests.push(
            managedAgentProvider.listSessions({ clientId: 'probe', limit: 1 }),
          );
      }, [managedAgentProvider]);
      return <div>managed-only</div>;
    },
  };
});

import { ManagedAgentWebShell } from './ManagedAgentWebShell';
import { artifact } from './components/managed/managed-tool-result.test-fixtures';
import type { ManagedAgentProvider } from './components/managed/managed-agent-provider';

describe('ManagedAgentWebShell', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    captured.renders = [];
    captured.probeRequests = false;
    captured.requests = [];
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('constructs a Java provider without daemon workspace props', async () => {
    await act(async () => {
      root.render(
        <ManagedAgentWebShell
          baseUrl="https://product.example"
          environmentId="python"
          language="zh-CN"
          sessionId="session-1"
        />,
      );
    });

    const props = captured.props as {
      managedAgentProvider: ManagedAgentProvider;
      workspaceCwd?: string;
      sessionId?: string;
    };
    expect(container.textContent).toBe('managed-only');
    expect(
      container.querySelector('[data-web-shell-root]')?.getAttribute('lang'),
    ).toBe('zh-CN');
    expect(props.managedAgentProvider.kind).toBe('java');
    expect(props.managedAgentProvider.acceptsWorkspaceCwd).toBe(false);
    expect(props.workspaceCwd).toBeUndefined();
    expect(props.sessionId).toBe('session-1');
  });

  it('does not pass the previous identity Session ID to a new provider', async () => {
    await act(async () => {
      root.render(
        <ManagedAgentWebShell
          baseUrl="https://product.example"
          productScope="tenant-a:actor-a"
          enableWorkspaceBinding
          sessionId="old-session"
        />,
      );
    });
    await act(async () => {
      root.render(
        <ManagedAgentWebShell
          baseUrl="https://product.example"
          productScope="tenant-b:actor-b"
          enableWorkspaceBinding
          sessionId="old-session"
        />,
      );
    });

    const newIdentityRenders = captured.renders.filter((render) =>
      (
        render as { managedAgentProvider: ManagedAgentProvider }
      ).managedAgentProvider.storageKey.includes('tenant-b:actor-b'),
    ) as Array<{ sessionId?: string }>;
    expect(newIdentityRenders.length).toBeGreaterThan(0);
    expect(
      newIdentityRenders.every((render) => render.sessionId === undefined),
    ).toBe(true);

    await act(async () => {
      root.render(
        <ManagedAgentWebShell
          baseUrl="https://product.example"
          productScope="tenant-c:actor-c"
          enableWorkspaceBinding
          sessionId="new-session"
        />,
      );
    });
    const explicitSelectionRenders = captured.renders.filter((render) =>
      (
        render as { managedAgentProvider: ManagedAgentProvider }
      ).managedAgentProvider.storageKey.includes('tenant-c:actor-c'),
    ) as Array<{ sessionId?: string }>;
    expect(explicitSelectionRenders.length).toBeGreaterThan(0);
    expect(
      explicitSelectionRenders.every(
        (render) => render.sessionId === 'new-session',
      ),
    ).toBe(true);
  });
  it('keeps the provider stable across callback identity churn and routes calls to the latest callback', async () => {
    const first = vi.fn(async () => undefined);
    const second = vi.fn(async () => undefined);
    const provider = () =>
      (captured.props as { managedAgentProvider: ManagedAgentProvider })
        .managedAgentProvider;
    await act(async () =>
      root.render(
        <ManagedAgentWebShell
          baseUrl="https://product.example"
          saveArtifact={first}
        />,
      ),
    );
    const before = provider();
    expect(before.toolResults?.canDownload).toBe(true);
    await before.toolResults!.downloadArtifact(artifact, {
      clientId: 'client',
    });
    expect(first).toHaveBeenCalledWith(
      artifact,
      expect.objectContaining({ openStream: expect.any(Function) }),
    );
    await act(async () =>
      root.render(
        <ManagedAgentWebShell
          baseUrl="https://product.example"
          saveArtifact={second}
        />,
      ),
    );
    // A callback identity change must not rebuild the provider (that would
    // abort the list fetch, reload the summary and restart the SSE) — the
    // latest callback is read through a ref instead.
    expect(provider()).toBe(before);
    expect(provider().storageKey).toBe(before.storageKey);
    await provider().toolResults!.downloadArtifact(artifact, {
      clientId: 'client',
    });
    expect(second).toHaveBeenCalledOnce();
    expect(first).toHaveBeenCalledOnce();
  });

  it('sends the latest getHeaders on requests issued in the scope-switch commit', async () => {
    captured.probeRequests = true;
    const tenants: Array<string | null> = [];
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      tenants.push(new Headers(init?.headers).get('x-qwen-tenant-id'));
      return new Response(JSON.stringify({ data: [], hasMore: false }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    await act(async () => {
      root.render(
        <ManagedAgentWebShell
          baseUrl="https://product.example"
          productScope="tenant-a"
          getHeaders={() => ({ 'X-Qwen-Tenant-Id': 'tenant-a' })}
          fetch={fetchImpl}
        />,
      );
    });
    await act(async () => {
      await Promise.all(captured.requests);
    });

    // The scope switch rebuilds the provider and the child effect of that
    // same commit issues the first tenant-B request: it must already read
    // the new getHeaders, not the previous render's.
    await act(async () => {
      root.render(
        <ManagedAgentWebShell
          baseUrl="https://product.example"
          productScope="tenant-b"
          getHeaders={() => ({ 'X-Qwen-Tenant-Id': 'tenant-b' })}
          fetch={fetchImpl}
        />,
      );
    });
    await act(async () => {
      await Promise.all(captured.requests);
    });

    expect(tenants).toEqual(['tenant-a', 'tenant-b']);
  });

  it('lets a controlled host return to no selection', async () => {
    let hostSelection: string | undefined;
    const onSessionChange = vi.fn((next: string | undefined) => {
      hostSelection = next;
    });
    const renderShell = async (sessionId: string | undefined) => {
      await act(async () => {
        root.render(
          <ManagedAgentWebShell
            baseUrl="https://product.example"
            sessionId={sessionId}
            onSessionChange={onSessionChange}
          />,
        );
      });
    };
    const childProps = () =>
      captured.props as {
        sessionId?: string;
        onSelectSession: (next: string | undefined) => void;
      };

    await renderShell(undefined);
    // The user picks a session internally; the host echoes it back.
    await act(async () => childProps().onSelectSession('c'));
    await renderShell(hostSelection);
    expect(childProps().sessionId).toBe('c');

    // The shell's own "new task" asks the host to clear the selection; once
    // the host echoes undefined, the child must not keep the frozen pick.
    await act(async () => childProps().onSelectSession(undefined));
    await renderShell(hostSelection);
    expect(childProps().sessionId).toBeUndefined();
  });

  it('does not forward a carried-over sessionId to a new scope in controlled mode', async () => {
    const onSessionChange = vi.fn();
    await act(async () => {
      root.render(
        <ManagedAgentWebShell
          baseUrl="https://product.example"
          productScope="tenant-a:actor-a"
          sessionId="old-session"
          onSessionChange={onSessionChange}
        />,
      );
    });
    await act(async () => {
      root.render(
        <ManagedAgentWebShell
          baseUrl="https://product.example"
          productScope="tenant-b:actor-b"
          sessionId="old-session"
          onSessionChange={onSessionChange}
        />,
      );
    });

    const newScopeRenders = captured.renders.filter((render) =>
      (
        render as { managedAgentProvider: ManagedAgentProvider }
      ).managedAgentProvider.storageKey.includes('tenant-b:actor-b'),
    ) as Array<{ sessionId?: string }>;
    expect(newScopeRenders.length).toBeGreaterThan(0);
    expect(
      newScopeRenders.every((render) => render.sessionId === undefined),
    ).toBe(true);
  });
});
