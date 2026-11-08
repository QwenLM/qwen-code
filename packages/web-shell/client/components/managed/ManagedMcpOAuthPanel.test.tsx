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
  sessionStorage.clear();
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
    status: vi.fn(async (..._args: unknown[]) => ({
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

it('keeps the provider link through pending polls when the popup is blocked', async () => {
  vi.useFakeTimers();
  vi.mocked(window.open).mockReturnValue(null);
  const client = api();
  client.status.mockResolvedValue({ attemptId: 'attempt', state: 'pending' });
  const callback = await render(client);
  await act(async () => button('Authorize and use in this session').click());
  const link = () => container.querySelector<HTMLAnchorElement>('a[href]');
  expect(link()?.href).toBe('https://auth.example/authorize?state=opaque');
  await act(async () => vi.advanceTimersByTimeAsync(1500));
  expect(client.status).toHaveBeenCalledOnce();
  expect(link()?.href).toBe('https://auth.example/authorize?state=opaque');
  expect(client.complete).not.toHaveBeenCalled();
  expect(callback).not.toHaveBeenCalled();
  expect(sessionStorage.length).toBe(0);
});

it('discards a completed A response that becomes ready immediately before starting flow B', async () => {
  vi.useFakeTimers();
  const client = api();
  const second = {
    ...server,
    serverId: `${pin.extensionId}:other`,
    serverName: 'other',
  };
  client.query.mockResolvedValue({
    supported: true,
    canAuthorize: true,
    servers: [server, second],
  });
  client.start.mockImplementation(async (...args: unknown[]) => ({
    attemptId:
      (args[1] as { serverId: string }).serverId === server.serverId
        ? 'attempt-A'
        : 'attempt-B',
    authorizationUrl: 'https://auth.example/authorize',
    state: 'pending',
  }));
  client.status.mockResolvedValue({
    attemptId: 'attempt-A',
    state: 'code_received',
  });
  let completeA!: (result: Awaited<ReturnType<typeof client.complete>>) => void;
  client.complete.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        completeA = resolve;
      }),
  );
  const callback = await render(client);
  const authorize = () =>
    [...container.querySelectorAll<HTMLButtonElement>('button')].filter(
      (entry) => entry.textContent === 'Authorize and use in this session',
    );
  await act(async () => authorize()[0].click());
  await act(async () => vi.advanceTimersByTimeAsync(1500));
  expect(client.complete).toHaveBeenCalledOnce();
  await act(async () => {
    completeA({
      attemptId: 'attempt-A',
      state: 'completed',
      credentialId: 'credential-A',
      generation: 1,
    });
    authorize()[1].click();
    await Promise.resolve();
  });
  expect(client.start).toHaveBeenCalledTimes(2);
  expect(callback).not.toHaveBeenCalled();
  client.status.mockResolvedValue({
    attemptId: 'attempt-B',
    state: 'code_received',
  });
  await act(async () => button('Check original authorization').click());
  expect(callback).toHaveBeenCalledExactlyOnceWith({
    serverId: second.serverId,
    credentialId: 'credential',
    credentialGeneration: 2,
  });
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

it.each(['failed', 'revision conflict'])(
  'releases a definitive OAuth %s only after explicit review of the fresh snapshot',
  async (failure) => {
    const client = api();
    const binding = {
      serverId: server.serverId,
      credentialId: 'credential',
      credentialGeneration: 2,
    };
    const snapshot = {
      sessionId: 'session',
      supported: true,
      revision: 4,
      selectionVersion: 2 as const,
      extensions: [pin],
      requestedExtensions: [pin],
      mcpAuthBindings: [binding],
      selfService: { supported: true, canApply: true },
    };
    const failed = {
      ...snapshot,
      operation: {
        operationId: '00000000-0000-4000-8000-000000000003',
        state: 'failed',
        mode: 'apply',
        revision: 5,
      },
    };
    const management = {
      storageScope: 'scope',
      query: vi.fn(async () => ({ ...snapshot, revision: 6 })),
      lookupApplyOperation: vi.fn(async (..._args: unknown[]) => {
        throw new JavaManagedAgentHttpError(404, 'not_found', 'Missing');
      }),
      apply: vi.fn(async (..._args: unknown[]) => ({
        ...failed,
        revision: 7,
        mcpAuthBindings: [],
        operation: { ...failed.operation, state: 'active', revision: 7 },
      })),
    };
    if (failure === 'failed') management.apply.mockResolvedValueOnce(failed);
    else
      management.apply.mockRejectedValueOnce(
        new JavaManagedAgentHttpError(
          409,
          'extension_config_revision_conflict',
          'Conflict',
        ),
      );
    await act(async () =>
      root.render(
        <I18nProvider language="en">
          <ManagedMcpOAuthManager
            provider={
              {
                storageKey: 'oauth-test',
                mcpOAuth: client,
                extensions: management,
              } as unknown as ManagedAgentProvider
            }
            workspaceId="workspace"
            sessionId="session"
            snapshot={snapshot}
            onChanged={vi.fn()}
          />
        </I18nProvider>,
      ),
    );
    await act(async () =>
      button('Remove authorization from this session').click(),
    );
    const storageKey = 'managed-mcp-oauth-binding:scope:workspace:session';
    const original = JSON.parse(sessionStorage.getItem(storageKey)!);
    expect(original.applySubmitted).toBe(false);
    if (failure === 'failed')
      management.lookupApplyOperation.mockResolvedValueOnce(failed as never);
    await act(async () => button('Review current selection').click());
    expect(sessionStorage.getItem(storageKey)).toBeNull();
    await act(async () =>
      button('Remove authorization from this session').click(),
    );
    expect(management.apply).toHaveBeenCalledTimes(2);
    const [_, selection, options] = management.apply.mock.calls[1] as [
      string,
      { expectedConfigRevision: number },
      { idempotencyKey: string },
    ];
    expect(selection.expectedConfigRevision).toBe(6);
    expect(options.idempotencyKey).not.toBe(original.key);
  },
);

it('treats an old OAuth journal without a submitted flag as an unknown outcome', async () => {
  const client = api();
  const snapshot = {
    sessionId: 'session',
    supported: true,
    revision: 4,
    extensions: [pin],
    requestedExtensions: [pin],
    selfService: { supported: true, canApply: true },
  };
  const storageKey = 'managed-mcp-oauth-binding:scope:workspace:session';
  const original = JSON.stringify({
    key: 'old-key',
    selection: {
      selectionVersion: 2,
      expectedConfigRevision: 2,
      extensions: [pin],
      mcpAuthBindings: [],
    },
  });
  sessionStorage.setItem(storageKey, original);
  const query = vi.fn();
  const apply = vi.fn();
  await act(async () =>
    root.render(
      <I18nProvider language="en">
        <ManagedMcpOAuthManager
          provider={
            {
              storageKey: 'oauth-test',
              mcpOAuth: client,
              extensions: {
                storageScope: 'scope',
                query,
                apply,
                lookupApplyOperation: vi.fn(async () => {
                  throw new JavaManagedAgentHttpError(
                    404,
                    'not_found',
                    'Missing',
                  );
                }),
              },
            } as unknown as ManagedAgentProvider
          }
          workspaceId="workspace"
          sessionId="session"
          snapshot={snapshot}
          onChanged={vi.fn()}
        />
      </I18nProvider>,
    ),
  );
  await act(async () => button('Review current selection').click());
  expect(sessionStorage.getItem(storageKey)).toBe(original);
  expect(query).not.toHaveBeenCalled();
  expect(apply).not.toHaveBeenCalled();
});
