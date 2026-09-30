// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const captured = vi.hoisted(() => ({
  props: undefined as unknown,
  renders: [] as unknown[],
}));

vi.mock('./components/managed/ManagedSessionsPage', () => ({
  ManagedSessionsPage: (props: unknown) => {
    captured.props = props;
    captured.renders.push(props);
    return <div>managed-only</div>;
  },
}));

import { ManagedAgentWebShell } from './ManagedAgentWebShell';
import type { ManagedAgentProvider } from './components/managed/managed-agent-provider';

describe('ManagedAgentWebShell', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    captured.renders = [];
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
});
