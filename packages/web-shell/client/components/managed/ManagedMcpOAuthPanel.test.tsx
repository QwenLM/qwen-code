// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import type { ManagedAgentProvider } from './managed-agent-provider';
import { ManagedMcpOAuthPanel } from './ManagedMcpOAuthPanel';
import { ManagedMcpOAuthManager } from './ManagedMcpOAuthManager';
import { JavaManagedAgentHttpError } from './java-managed-agent-client';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const pin = {
  extensionId: 'ext_00000000-0000-4000-8000-000000000001',
  packageRevision: 1,
  packageDigest: 'a'.repeat(64),
};
const server = {
  serverId: `${pin.extensionId}:tools`,
  serverName: 'tools',
  providerId: 'company',
  resourceUri: 'https://mcp.example',
  scopes: ['read'],
  pin,
  state: 'unauthorized',
  actorOwned: true,
};
let container: HTMLDivElement;
let root: Root;
const popup = { opener: null, location: { replace: vi.fn() }, close: vi.fn() };

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function api() {
  return {
    query: vi.fn(async () => ({
      supported: true,
      canAuthorize: true,
      servers: [server],
    })),
    start: vi.fn(async (..._args: unknown[]) => ({
      attemptId: 'attempt',
      authorizationUrl: 'https://auth.example/authorize?state=opaque',
      state: 'pending',
    })),
    status: vi.fn(async () => ({
      attemptId: 'attempt',
      state: 'code_received',
    })),
    complete: vi.fn(async (..._args: unknown[]) => ({
      attemptId: 'attempt',
      state: 'completed',
      credentialId: 'credential',
      generation: 2,
    })),
    revoke: vi.fn(),
  };
}
async function render(client: ReturnType<typeof api>, callback = vi.fn()) {
  const provider = {
    storageKey: 'oauth-test',
    mcpOAuth: client,
  } as unknown as ManagedAgentProvider;
  await act(async () =>
    root.render(
      <I18nProvider language="en">
        <ManagedMcpOAuthPanel
          provider={provider}
          sessionId="session"
          extensions={[pin]}
          onAuthorized={callback}
        />
      </I18nProvider>,
    ),
  );
  return callback;
}
const button = (label: string) =>
  [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (entry) => entry.textContent === label,
  )!;

it('completes the initiating browser flow with an in-memory nonce and returns only its credential binding', async () => {
  const client = api();
  const callback = await render(client);
  expect(container.textContent).toContain('Workspace read permissions');
  await act(async () => button('Authorize and use in this session').click());
  const input = client.start.mock.calls[0]?.[1] as {
    browserNonce: string;
    pin: unknown;
  };
  expect(input.browserNonce).toMatch(/^[a-f0-9]{64}$/);
  expect(input.pin).toEqual(pin);
  expect(popup.location.replace).toHaveBeenCalledWith(
    'https://auth.example/authorize?state=opaque',
  );
  expect(sessionStorage.length).toBe(0);
  await act(async () => button('Check original authorization').click());
  expect(client.complete.mock.calls[0]?.[1]).toEqual({
    attemptId: 'attempt',
    browserNonce: input.browserNonce,
  });
  expect(callback).toHaveBeenCalledExactlyOnceWith({
    serverId: server.serverId,
    credentialId: 'credential',
    credentialGeneration: 2,
  });
  expect(popup.close).toHaveBeenCalled();
});

it('does not offer another actor execution or bind controls when authorization is disallowed', async () => {
  const client = api();
  client.query.mockResolvedValue({
    supported: true,
    canAuthorize: false,
    servers: [
      {
        ...server,
        state: 'authorized',
        actorOwned: false,
        credentialId: 'private',
        generation: 2,
      },
    ],
  } as never);
  await render(client);
  expect(button('Authorize and use in this session').disabled).toBe(true);
  expect(button('Use my saved authorization')).toBeUndefined();
  expect(button('Revoke my authorization')).toBeUndefined();
  expect(client.start).not.toHaveBeenCalled();
});

it('rejects a non-HTTP authorization destination without navigating or binding', async () => {
  const client = api();
  client.start.mockResolvedValue({
    attemptId: 'attempt',
    authorizationUrl: 'javascript:alert(1)',
    state: 'pending',
  });
  const callback = await render(client);
  popup.location.replace.mockClear();
  await act(async () => button('Authorize and use in this session').click());
  expect(popup.location.replace).not.toHaveBeenCalled();
  expect(callback).not.toHaveBeenCalled();
  expect(container.textContent).toContain(
    'Authorization could not be confirmed',
  );
});

it('cancels a pending browser flow before revoking its saved credential', async () => {
  vi.useFakeTimers();
  const client = api();
  const authorized = {
    ...server,
    state: 'authorized',
    credentialId: 'credential',
    generation: 2,
  };
  client.query
    .mockResolvedValueOnce({
      supported: true,
      canAuthorize: true,
      servers: [authorized],
    } as never)
    .mockResolvedValue({
      supported: true,
      canAuthorize: true,
      servers: [{ ...authorized, state: 'revoked', generation: 3 }],
    } as never);
  client.revoke.mockResolvedValue({
    credentialId: 'credential',
    generation: 3,
    state: 'revoked',
  });
  const callback = await render(client);
  await act(async () => button('Authorize and use in this session').click());
  await act(async () => button('Revoke my authorization').click());
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(client.complete).not.toHaveBeenCalled();
  expect(callback).not.toHaveBeenCalled();
  expect(button('Check original authorization')).toBeUndefined();
});

it.each([
  [false, 'authorized'],
  [false, 'unavailable'],
  [true, 'unavailable'],
] as const)(
  'keeps owned %s/%s grants revocable under the deployment capability',
  async (supported, state) => {
    const client = api();
    const grant = {
      ...server,
      state,
      credentialId: 'credential',
      generation: 2,
    };
    client.query
      .mockResolvedValueOnce({
        supported,
        canAuthorize: supported,
        servers: [grant],
      } as never)
      .mockResolvedValue({
        supported,
        canAuthorize: supported,
        servers: [{ ...grant, state: 'revoked', generation: 3 }],
      } as never);
    client.revoke.mockResolvedValue({
      credentialId: 'credential',
      generation: 3,
      state: 'revoked',
    });
    const callback = await render(client);
    expect(container.textContent).toContain(server.serverName);
    expect(button('Authorize and use in this session').disabled).toBe(
      !supported,
    );
    if (state === 'authorized')
      expect(button('Use my saved authorization').disabled).toBe(true);
    else expect(button('Use my saved authorization')).toBeUndefined();
    expect(button('Revoke my authorization').disabled).toBe(false);
    await act(async () => button('Revoke my authorization').click());
    expect(client.revoke).toHaveBeenCalledWith(
      'session',
      { credentialId: 'credential', expectedGeneration: 2 },
      expect.objectContaining({ clientId: expect.any(String) }),
    );
    expect(client.start).not.toHaveBeenCalled();
    expect(callback).not.toHaveBeenCalled();
    expect(button('Revoke my authorization')).toBeUndefined();
  },
);

it('offers a new authorization after an uncertain refresh without requiring revocation first', async () => {
  const client = api();
  client.query.mockResolvedValue({
    supported: true,
    canAuthorize: true,
    servers: [
      {
        ...server,
        state: 'unavailable',
        credentialId: 'credential',
        generation: 2,
      },
    ],
  } as never);
  const callback = await render(client);
  expect(button('Authorize and use in this session').disabled).toBe(false);
  await act(async () => button('Authorize and use in this session').click());
  expect(client.start).toHaveBeenCalledOnce();
  expect(client.revoke).not.toHaveBeenCalled();
  await act(async () => button('Check original authorization').click());
  expect(callback).toHaveBeenCalledExactlyOnceWith({
    serverId: server.serverId,
    credentialId: 'credential',
    credentialGeneration: 2,
  });
});

it('keeps explicit binding removal available after personal OAuth is disabled', async () => {
  const client = api();
  client.query.mockResolvedValue({
    supported: false,
    canAuthorize: false,
    servers: [
      {
        ...server,
        state: 'unavailable',
        credentialId: 'credential',
        generation: 2,
      },
    ],
  } as never);
  const bindings = [
    {
      serverId: server.serverId,
      credentialId: 'credential',
      credentialGeneration: 2,
    },
  ];
  const snapshot = {
    sessionId: 'session',
    supported: true,
    revision: 7,
    selectionVersion: 2 as const,
    extensions: [pin],
    requestedExtensions: [pin],
    mcpAuthBindings: bindings,
    selfService: { supported: true, canApply: true },
  };
  const apply = vi.fn(async () => ({
    ...snapshot,
    revision: 8,
    mcpAuthBindings: [],
    operation: {
      operationId: '00000000-0000-4000-8000-000000000003',
      mode: 'apply',
      state: 'active',
      revision: 8,
    },
  }));
  const lookupApplyOperation = vi.fn(async () => {
    throw new JavaManagedAgentHttpError(404, 'not_found', 'Missing');
  });
  const provider = {
    storageKey: 'oauth-test',
    mcpOAuth: client,
    extensions: { apply, lookupApplyOperation },
  } as unknown as ManagedAgentProvider;
  await act(async () =>
    root.render(
      <I18nProvider language="en">
        <ManagedMcpOAuthManager
          provider={provider}
          workspaceId="workspace"
          sessionId="session"
          snapshot={snapshot}
          onChanged={vi.fn()}
        />
      </I18nProvider>,
    ),
  );
  expect(button('Remove authorization from this session').disabled).toBe(false);
  await act(async () =>
    button('Remove authorization from this session').click(),
  );
  expect(apply).toHaveBeenCalledWith(
    'session',
    {
      selectionVersion: 2,
      expectedConfigRevision: 7,
      extensions: [pin],
      mcpAuthBindings: [],
    },
    expect.objectContaining({ idempotencyKey: expect.any(String) }),
  );
  expect(client.start).not.toHaveBeenCalled();
  expect(client.revoke).not.toHaveBeenCalled();
});
