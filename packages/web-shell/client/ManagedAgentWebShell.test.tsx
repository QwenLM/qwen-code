// @vitest-environment jsdom

import {
  act,
  startTransition,
  Suspense,
  type ComponentProps,
  type ReactNode,
} from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const captured = vi.hoisted(() => ({
  props: undefined as unknown,
  renders: [] as unknown[],
  probeRequests: false,
  requests: [] as Array<Promise<unknown>>,
  // Providers from commits only — a discarded render never fires an effect.
  committed: [] as unknown[],
  navigation: null as unknown,
  archived: null as unknown,
}));

vi.mock('./components/managed/ManagedSessionsPage', async () => {
  const { useEffect } = await import('react');
  return {
    ManagedSessionsPage: (props: unknown) => {
      captured.props = props;
      captured.renders.push(props);
      const {
        managedAgentProvider,
        renderNavigation,
        renderArchivedNavigation,
      } = props as {
        managedAgentProvider: ManagedAgentProvider;
        renderNavigation?: (navigation: unknown) => unknown;
        renderArchivedNavigation?: (archived: unknown) => unknown;
      };
      captured.navigation = renderNavigation
        ? renderNavigation(<nav>host list</nav>)
        : null;
      captured.archived = renderArchivedNavigation
        ? renderArchivedNavigation(<nav>archived list</nav>)
        : null;
      // Issues a request from a child effect whenever the provider identity
      // changes — the same trigger ManagedSessionsContent's list effect has.
      useEffect(() => {
        captured.committed.push(managedAgentProvider);
        if (captured.probeRequests)
          captured.requests.push(
            managedAgentProvider.listSessions({ clientId: 'probe', limit: 1 }),
          );
      }, [managedAgentProvider]);
      return (
        <div>
          managed-only
          {captured.navigation as ReactNode}
          {captured.archived as ReactNode}
        </div>
      );
    },
  };
});

vi.mock('./components/managed/java-managed-agent-provider', async () => {
  const actual = await import(
    './components/managed/java-managed-agent-provider'
  );
  return {
    ...actual,
    createJavaManagedAgentProvider: vi.fn(
      actual.createJavaManagedAgentProvider,
    ),
  };
});

import { ManagedAgentWebShell } from './ManagedAgentWebShell';
import { createJavaManagedAgentProvider } from './components/managed/java-managed-agent-provider';
import shellStyles from './App.module.css';
import { artifact } from './components/managed/managed-tool-result.test-fixtures';
import type { ManagedAgentProvider } from './components/managed/managed-agent-provider';

describe('ManagedAgentWebShell', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    captured.renders = [];
    captured.probeRequests = false;
    captured.requests = [];
    captured.committed = [];
    captured.navigation = null;
    vi.mocked(createJavaManagedAgentProvider).mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('uses the injected provider and resets host selection when its identity scope changes', async () => {
    const fetchImpl = vi.fn();
    const first = { storageKey: 'tenant-a:actor-a' } as ManagedAgentProvider;
    const second = { storageKey: 'tenant-b:actor-b' } as ManagedAgentProvider;
    const render = async (
      provider: ManagedAgentProvider,
      sessionId?: string,
    ) => {
      await act(async () =>
        root.render(
          <ManagedAgentWebShell
            managedAgentProvider={provider}
            hostSessionOnly
            sessionId={sessionId}
            fetch={fetchImpl}
          />,
        ),
      );
    };
    await render(first, 'old');
    expect(captured.props).toMatchObject({
      managedAgentProvider: first,
      hostSessionOnly: true,
      sessionId: 'old',
    });
    await render(second, 'old');
    expect(captured.props).toMatchObject({
      managedAgentProvider: second,
      sessionId: undefined,
    });
    await render(second, 'new');
    expect(captured.props).toMatchObject({ sessionId: 'new' });
    await act(async () => {
      (
        captured.props as { onSelectSession: (id?: string) => void }
      ).onSelectSession('unrequested');
    });
    expect(captured.props).toMatchObject({ sessionId: 'new' });
    await render(second);
    expect(captured.props).toMatchObject({ sessionId: undefined });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(createJavaManagedAgentProvider).not.toHaveBeenCalled();
  });

  it('renders the unavailable notice without a provider or base URL', async () => {
    await act(async () => root.render(<ManagedAgentWebShell />));
    expect(createJavaManagedAgentProvider).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('managed-only');
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      'Managed Agents is unavailable',
    );
  });

  it('wraps a host navigation slot in the portal scope and syncs theme variables', async () => {
    const provider = { storageKey: 'slot-scope' } as ManagedAgentProvider;
    const navigationTarget = document.createElement('div');
    document.body.appendChild(navigationTarget);
    try {
      await act(async () =>
        root.render(
          <ManagedAgentWebShell
            managedAgentProvider={provider}
            navigationTarget={navigationTarget}
            language="zh-CN"
          />,
        ),
      );
      const slot = navigationTarget.firstElementChild as HTMLElement;
      expect(slot.hasAttribute('data-web-shell-portal-root')).toBe(true);
      expect(slot.hasAttribute('data-web-shell-shadcn')).toBe(true);
      // The wrapper must not generate a box, or it becomes the host sidebar's
      // flex item and its min-height:auto blocks the nav from scrolling (R1-4).
      expect(slot.style.display).toBe('contents');
      expect(slot.classList.contains('dark')).toBe(true);
      expect(slot.lang).toBe('zh-CN');
      expect(slot.textContent).toBe('host list');
      await act(async () =>
        root.render(
          <ManagedAgentWebShell
            managedAgentProvider={provider}
            navigationTarget={navigationTarget}
            theme="light"
            language="en"
            style={{ ['--background' as string]: 'oklch(0.9 0 0)' }}
          />,
        ),
      );
      expect(slot.classList.contains('dark')).toBe(false);
      expect(slot.lang).toBe('en');
      // The host slot lives outside the shell, so it only inherits theme tokens
      // if the entry copies them across.
      expect(slot.style.getPropertyValue('--background')).toBe(
        'oklch(0.9 0 0)',
      );
    } finally {
      navigationTarget.remove();
    }
  });

  it('styles only its own wrapper when the host slot already has children', async () => {
    const provider = { storageKey: 'slot-shared' } as ManagedAgentProvider;
    const target = document.createElement('div');
    const hostChrome = document.createElement('span');
    hostChrome.textContent = 'host chrome';
    hostChrome.lang = 'fr';
    target.appendChild(hostChrome);
    document.body.appendChild(target);
    try {
      await act(async () =>
        root.render(
          <ManagedAgentWebShell
            managedAgentProvider={provider}
            navigationTarget={target}
            language="zh-CN"
            style={{ ['--background' as string]: 'oklch(0.2 0 0)' }}
          />,
        ),
      );
      const wrapper = target.querySelector<HTMLElement>(
        '[data-web-shell-portal-root]',
      )!;
      // The host's own node must stay untouched: it is not ours to theme, and
      // styling the slot's first child would both mutate it and miss the list.
      expect(hostChrome.lang).toBe('fr');
      expect(hostChrome.classList.contains('dark')).toBe(false);
      expect(hostChrome.style.getPropertyValue('--background')).toBe('');
      expect(wrapper.lang).toBe('zh-CN');
      expect(wrapper.classList.contains('dark')).toBe(true);
      expect(wrapper.style.getPropertyValue('--background')).toBe(
        'oklch(0.2 0 0)',
      );
    } finally {
      target.remove();
    }
  });

  it('themes a wrapper that mounts after a commit the sync effect does not watch', async () => {
    const provider = { storageKey: 'slot-late' } as ManagedAgentProvider;
    const target = document.createElement('div');
    // One identity for both renders: a fresh literal per render would re-run
    // the sync effect and hide a root ref a child's ref callback cannot see.
    const tokenStyle = { ['--background' as string]: 'oklch(0.2 0 0)' };
    document.body.appendChild(target);
    try {
      // No provider: the page — and with it the slot wrapper — does not exist
      // yet, so the wrapper mounts in a later commit.
      await act(async () =>
        root.render(
          <ManagedAgentWebShell
            navigationTarget={target}
            language="zh-CN"
            style={tokenStyle}
          />,
        ),
      );
      expect(target.querySelector('[data-web-shell-portal-root]')).toBeNull();
      await act(async () =>
        root.render(
          <ManagedAgentWebShell
            managedAgentProvider={provider}
            navigationTarget={target}
            language="zh-CN"
            style={tokenStyle}
          />,
        ),
      );
      const wrapper = target.querySelector<HTMLElement>(
        '[data-web-shell-portal-root]',
      )!;
      expect(wrapper.classList.contains('dark')).toBe(true);
      expect(wrapper.lang).toBe('zh-CN');
      expect(wrapper.style.getPropertyValue('--background')).toBe(
        'oklch(0.2 0 0)',
      );
      // A host token that changes without a theme or language change must
      // still reach the wrapper.
      await act(async () =>
        root.render(
          <ManagedAgentWebShell
            managedAgentProvider={provider}
            navigationTarget={target}
            language="zh-CN"
            style={{ ['--background' as string]: 'oklch(0.9 0 0)' }}
          />,
        ),
      );
      expect(wrapper.style.getPropertyValue('--background')).toBe(
        'oklch(0.9 0 0)',
      );
    } finally {
      target.remove();
    }
  });

  it('keeps an explicit host sessionId when the provider arrives later', async () => {
    const provider = { storageKey: 'late-provider' } as ManagedAgentProvider;
    // The host mounts with neither `managedAgentProvider` nor `baseUrl`: there
    // is no previous identity to carry an id over from.
    await act(async () =>
      root.render(<ManagedAgentWebShell hostSessionOnly sessionId="s1" />),
    );
    await act(async () =>
      root.render(
        <ManagedAgentWebShell
          managedAgentProvider={provider}
          hostSessionOnly
          sessionId="s1"
        />,
      ),
    );
    expect(captured.props).toMatchObject({
      managedAgentProvider: provider,
      sessionId: 's1',
    });
  });

  it('drops a carried sessionId when the identity switch passes through a provider-less render', async () => {
    const first = { storageKey: 'tenant-a:actor-a' } as ManagedAgentProvider;
    const third = { storageKey: 'tenant-c:actor-c' } as ManagedAgentProvider;
    const render = (provider?: ManagedAgentProvider) =>
      act(async () =>
        root.render(
          <ManagedAgentWebShell
            managedAgentProvider={provider}
            hostSessionOnly
            sessionId="s1"
          />,
        ),
      );
    await render(first);
    await render(undefined);
    await render(third);
    expect(captured.props).toMatchObject({
      managedAgentProvider: third,
      sessionId: undefined,
    });
  });

  it('styles both wrappers when the host reuses one slot element', async () => {
    const provider = { storageKey: 'slot-reused' } as ManagedAgentProvider;
    const target = document.createElement('div');
    document.body.appendChild(target);
    try {
      await act(async () =>
        root.render(
          <ManagedAgentWebShell
            managedAgentProvider={provider}
            navigationTarget={target}
            archivedNavigationTarget={target}
            language="zh-CN"
          />,
        ),
      );
      const wrappers = [
        ...target.querySelectorAll<HTMLElement>('[data-web-shell-portal-root]'),
      ];
      // Both lists portal into the same host element, so a per-target lookup
      // would theme only one of the two wrappers.
      expect(wrappers).toHaveLength(2);
      for (const wrapper of wrappers) {
        expect(wrapper.lang).toBe('zh-CN');
        expect(wrapper.classList.contains('dark')).toBe(true);
      }
    } finally {
      target.remove();
    }
  });

  it('discards internal selection when a host takes ownership without an ID', async () => {
    const provider = { storageKey: 'host-mode-switch' } as ManagedAgentProvider;
    await act(async () =>
      root.render(<ManagedAgentWebShell managedAgentProvider={provider} />),
    );
    await act(async () => {
      (
        captured.props as { onSelectSession: (id?: string) => void }
      ).onSelectSession('internal-session');
    });
    expect(captured.props).toMatchObject({ sessionId: 'internal-session' });
    await act(async () =>
      root.render(
        <ManagedAgentWebShell
          managedAgentProvider={provider}
          hostSessionOnly
        />,
      ),
    );
    expect(captured.props).toMatchObject({
      sessionId: undefined,
      hostSessionOnly: true,
    });
  });

  it('lets a delete/archive clear through when the host has no echo channel', async () => {
    const provider = { storageKey: 'host-no-echo' } as ManagedAgentProvider;
    await act(async () =>
      root.render(
        <ManagedAgentWebShell
          managedAgentProvider={provider}
          hostSessionOnly
          sessionId="s1"
        />,
      ),
    );
    expect(captured.props).toMatchObject({ sessionId: 's1' });
    // New selections stay host-owned even without an echo channel…
    await act(async () => {
      (
        captured.props as { onSelectSession: (id?: string) => void }
      ).onSelectSession('unrequested');
    });
    expect(captured.props).toMatchObject({ sessionId: 's1' });
    // …but clearing the deleted/archived session must reach the page.
    await act(async () => {
      (
        captured.props as { onSelectSession: (id?: string) => void }
      ).onSelectSession(undefined);
    });
    expect(captured.props).toMatchObject({ sessionId: undefined });
  });

  it('routes the clear through the echo channel when the host provides one', async () => {
    const provider = { storageKey: 'host-echo' } as ManagedAgentProvider;
    const onSessionChange = vi.fn();
    await act(async () =>
      root.render(
        <ManagedAgentWebShell
          managedAgentProvider={provider}
          hostSessionOnly
          sessionId="s1"
          onSessionChange={onSessionChange}
        />,
      ),
    );
    await act(async () => {
      (
        captured.props as { onSelectSession: (id?: string) => void }
      ).onSelectSession(undefined);
    });
    expect(onSessionChange).toHaveBeenCalledWith(undefined);
    // The host owns the selection: no internal write before the echo.
    expect(captured.props).toMatchObject({ sessionId: 's1' });
    await act(async () =>
      root.render(
        <ManagedAgentWebShell
          managedAgentProvider={provider}
          hostSessionOnly
          onSessionChange={onSessionChange}
        />,
      ),
    );
    expect(captured.props).toMatchObject({ sessionId: undefined });
  });

  it('constructs a Java provider without daemon workspace props', async () => {
    await act(async () => {
      root.render(
        <ManagedAgentWebShell
          baseUrl="https://product.example"
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
    expect(props.workspaceCwd).toBeUndefined();
    expect(props.sessionId).toBe('session-1');
  });

  it('scopes the standalone root with the shell frame and theme classes', async () => {
    for (const [theme, themeClass] of [
      ['dark', shellStyles.themeDark],
      ['light', shellStyles.themeLight],
    ] as const) {
      await act(async () => {
        root.render(
          <ManagedAgentWebShell
            baseUrl="https://product.example"
            theme={theme}
          />,
        );
      });
      const classes = container.querySelector(
        '[data-web-shell-root]',
      )!.classList;
      expect(shellStyles.app).toBeTruthy();
      expect(classes.contains(shellStyles.app)).toBe(true);
      expect(classes.contains(themeClass)).toBe(true);
    }
  });

  it('does not pass the previous identity Session ID to a new provider', async () => {
    await act(async () => {
      root.render(
        <ManagedAgentWebShell
          baseUrl="https://product.example"
          productScope="tenant-a:actor-a"
          enableWorkspaceBinding
          modelPresets={[{ agentId: 'agent-a', label: 'Model A' }]}
          sessionId="old-session"
        />,
      );
    });
    expect(
      (captured.props as { managedAgentProvider: ManagedAgentProvider })
        .managedAgentProvider.workspaceBinding?.modelPresets,
    ).toEqual([{ agentId: 'agent-a', label: 'Model A' }]);
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

  it('keeps the committed callbacks when a scope-switch render is discarded', async () => {
    captured.probeRequests = true;
    const tenants: Array<string | null> = [];
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      tenants.push(new Headers(init?.headers).get('x-qwen-tenant-id'));
      return new Response(JSON.stringify({ data: [], hasMore: false }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    let gateOpen = false;
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = () => {
        gateOpen = true;
        resolve();
      };
    });
    function Gate() {
      if (!gateOpen) throw gate;
      return null;
    }
    const shell = (scope: string, withGate: boolean) => (
      <Suspense fallback={null}>
        <ManagedAgentWebShell
          baseUrl="https://product.example"
          productScope={scope}
          getHeaders={() => ({ 'X-Qwen-Tenant-Id': scope })}
          fetch={fetchImpl}
        />
        {withGate ? <Gate /> : null}
      </Suspense>
    );

    await act(async () => {
      root.render(shell('tenant-a', false));
    });
    await act(async () => {
      await Promise.all(captured.requests);
    });
    expect(tenants).toEqual(['tenant-a']);

    // The transition renders tenant-b's shell but suspends before commit,
    // so React throws the render away and the committed tree keeps showing.
    await act(async () => {
      startTransition(() => root.render(shell('tenant-b', true)));
    });
    // The discarded render must not repoint the committed provider's
    // callbacks: the committed tree's next request still signs tenant-a.
    const committed = captured.committed.at(-1) as ManagedAgentProvider;
    await act(async () => {
      await committed.listSessions({ clientId: 'probe', limit: 1 });
    });
    expect(tenants).toEqual(['tenant-a', 'tenant-a']);

    // Once the gate releases, the transition commits and takes over.
    await act(async () => {
      releaseGate();
      await gate;
    });
    await act(async () => {
      await Promise.all(captured.requests);
    });
    expect(tenants).toEqual(['tenant-a', 'tenant-a', 'tenant-b']);
  });

  it('suppresses the internal selection write while a controlled host declines to echo', async () => {
    const onSessionChange = vi.fn();
    await act(async () => {
      root.render(
        <ManagedAgentWebShell
          baseUrl="https://product.example"
          sessionId="a"
          onSessionChange={onSessionChange}
        />,
      );
    });
    const childProps = () =>
      captured.props as {
        sessionId?: string;
        onSelectSession: (next: string | undefined) => void;
      };
    expect(childProps().sessionId).toBe('a');

    await act(async () => childProps().onSelectSession('c'));

    // The host owns the selection: the pick is reported, but until the host
    // echoes it the child keeps the host-driven value.
    expect(onSessionChange).toHaveBeenCalledWith('c');
    expect(childProps().sessionId).toBe('a');
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

  it('forwards navigation slots and stabilizes archived status callbacks', async () => {
    const provider = { storageKey: 'navigation-props' } as ManagedAgentProvider;
    const navigationTarget = document.createElement('nav');
    const archivedNavigationTarget = document.createElement('section');
    const onArchivedSessionsStatusChange = vi.fn();
    await act(async () => {
      root.render(
        <ManagedAgentWebShell
          managedAgentProvider={provider}
          navigationTarget={navigationTarget}
          archivedNavigationTarget={archivedNavigationTarget}
          onArchivedSessionsStatusChange={onArchivedSessionsStatusChange}
          navigationActive={false}
          navigationSearch="release"
        />,
      );
    });
    expect(captured.props).toMatchObject({
      navigationTarget,
      archivedNavigationTarget,
      navigationActive: false,
      navigationSearch: 'release',
    });
    const forwardedStatus = (
      captured.props as {
        onArchivedSessionsStatusChange: NonNullable<
          ComponentProps<
            typeof ManagedAgentWebShell
          >['onArchivedSessionsStatusChange']
        >;
      }
    ).onArchivedSessionsStatusChange;
    const status = { count: 2, loading: false, error: false };
    await act(async () => forwardedStatus(status));
    expect(onArchivedSessionsStatusChange).toHaveBeenCalledWith(status);
    const nextStatusChange = vi.fn();
    await act(async () =>
      root.render(
        <ManagedAgentWebShell
          managedAgentProvider={provider}
          navigationTarget={navigationTarget}
          archivedNavigationTarget={archivedNavigationTarget}
          onArchivedSessionsStatusChange={nextStatusChange}
          navigationActive={false}
          navigationSearch="release"
        />,
      ),
    );
    expect(captured.props).toMatchObject({
      onArchivedSessionsStatusChange: forwardedStatus,
    });
    const nextStatus = { count: 3, loading: false, error: false };
    await act(async () => forwardedStatus(nextStatus));
    expect(nextStatusChange).toHaveBeenCalledWith(nextStatus);
    expect(onArchivedSessionsStatusChange).toHaveBeenCalledTimes(1);
  });

  it('accepts an injected provider without a Java base URL', async () => {
    const provider = { storageKey: 'injected' } as ManagedAgentProvider;
    const props: ComponentProps<typeof ManagedAgentWebShell> = {
      managedAgentProvider: provider,
      hostSessionOnly: true,
      sessionId: 'existing',
    };
    await act(async () => root.render(<ManagedAgentWebShell {...props} />));
    expect(captured.props).toMatchObject({
      managedAgentProvider: provider,
      sessionId: 'existing',
    });
  });

  it('leaves the navigation defaults to the sessions page when unset', async () => {
    const provider = {
      storageKey: 'navigation-defaults',
    } as ManagedAgentProvider;
    await act(async () => {
      root.render(<ManagedAgentWebShell managedAgentProvider={provider} />);
    });
    expect(captured.props).toMatchObject({
      navigationTarget: undefined,
      archivedNavigationTarget: undefined,
      onArchivedSessionsStatusChange: undefined,
      navigationActive: undefined,
      navigationSearch: undefined,
    });
  });
});
