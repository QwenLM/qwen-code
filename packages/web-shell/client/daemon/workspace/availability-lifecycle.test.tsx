// @vitest-environment jsdom
import { StrictMode, act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DaemonClient } from '@qwen-code/sdk/daemon';
import { useDaemonAvailabilityController } from '../availability-context.js';
import { SessionCatalogStore } from '../../session-catalog/session-catalog-store.js';
import {
  findDaemonAvailability,
  type DaemonAvailability,
} from '../availability.js';
import { detachDaemonClient } from '../session/clientLifecycle';
import { createDaemonRestRequest } from '../rest-request.js';
import {
  DaemonWorkspaceProvider,
  useOptionalDaemonWorkspace,
} from './DaemonWorkspaceProvider';
import type { DaemonWorkspaceContextValue } from './types.js';

let root: Root;
let container: HTMLDivElement;
let offline = false;
let fetchMock: ReturnType<typeof vi.fn<typeof globalThis.fetch>>;
const connections = new Map<
  string,
  {
    availability: DaemonAvailability;
    client: DaemonClient;
    workspace: DaemonWorkspaceContextValue;
  }
>();

function Probe({ id }: { id: string }) {
  const availability = useDaemonAvailabilityController();
  const workspace = useOptionalDaemonWorkspace();
  const client = workspace?.client;
  if (availability && client && workspace) {
    connections.set(id, { availability, client, workspace });
  }
  return null;
}

function provider(
  id: string,
  props: { autoConnect?: boolean; token?: string } = {},
) {
  return (
    <DaemonWorkspaceProvider baseUrl="https://daemon.example" {...props}>
      <Probe id={id} />
    </DaemonWorkspaceProvider>
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  offline = false;
  connections.clear();
  fetchMock = vi.fn<typeof globalThis.fetch>(async (input) => {
    if (offline) throw new TypeError('offline');
    const path = new URL(String(input)).pathname;
    if (path === '/health') return Response.json({ status: 'ok' });
    if (path === '/capabilities') return Response.json({ features: [] });
    if (path === '/brand') return Response.json({});
    return Response.json({});
  });
  vi.stubGlobal('fetch', fetchMock);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it.each(['initial', 'refresh'] as const)(
  'recovers a failed %s capabilities request when diagnostics stay available',
  async (mode) => {
    let failCapabilities = mode === 'initial';
    let releaseHealth!: (response: Response) => void;
    const health = new Promise<Response>((resolve) => {
      releaseHealth = resolve;
    });
    fetchMock.mockImplementation(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === '/health') return health;
      if (path === '/capabilities') {
        if (failCapabilities) {
          failCapabilities = false;
          return Response.json({ error: 'Starting' }, { status: 503 });
        }
        return Response.json({ features: ['current'] });
      }
      return Response.json({});
    });
    await act(async () => {
      root.render(provider('diagnostic'));
    });
    const current = () => connections.get('diagnostic')!;
    if (mode === 'refresh') {
      expect(current().workspace.status).toBe('connected');
      failCapabilities = true;
      await act(async () => {
        await current().workspace.refreshCapabilities!().catch(() => undefined);
      });
    }
    expect(current().workspace.status).toBe('error');
    const { availability } = current();
    expect(availability.getSnapshot()).toBe('available');
    const generation = availability.getGeneration();
    const listener = vi.fn();
    const unsubscribe = availability.subscribe(listener);
    fetchMock.mockImplementation(async (input) =>
      Response.json(
        String(input).endsWith('/capabilities')
          ? { features: ['recovered'] }
          : {},
      ),
    );
    await act(async () => {
      releaseHealth(Response.json({ status: 'ok' }));
      await availability.check();
    });
    expect(listener).toHaveBeenCalledOnce();
    expect(availability.getSnapshot()).toBe('available');
    expect(availability.getGeneration()).toBe(generation);
    expect(current().workspace.status).toBe('connected');
    expect(current().workspace.error).toBeUndefined();
    expect(current().workspace.capabilities?.features).toEqual(['recovered']);
    await expect(current().workspace.getCapabilities!()).resolves.toEqual(
      availability.recoveredCapabilities,
    );
    const requests = fetchMock.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(120_000));
    expect(fetchMock).toHaveBeenCalledTimes(requests);
    expect(fetchMock.mock.calls.every(([, init]) => !init?.method)).toBe(true);
    unsubscribe();
  },
);

it('keeps a newer capabilities refresh when a diagnostic probe lands later', async () => {
  let capabilitiesCalls = 0;
  let releaseProbeCapabilities!: (response: Response) => void;
  fetchMock.mockImplementation(async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === '/health') return Response.json({ status: 'ok' });
    if (path === '/capabilities') {
      capabilitiesCalls++;
      if (capabilitiesCalls === 1) {
        return Response.json({ features: ['pre-add'] });
      }
      if (capabilitiesCalls === 2) {
        return new Promise<Response>((resolve) => {
          releaseProbeCapabilities = resolve;
        });
      }
      return Response.json({ features: ['added'] });
    }
    return Response.json({});
  });
  await act(async () => {
    root.render(provider('stale-probe'));
  });
  const current = () => connections.get('stale-probe')!;
  expect(current().workspace.status).toBe('connected');
  expect(current().workspace.capabilities?.features).toEqual(['pre-add']);
  const diagnostics = current().availability.check();
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    await current().workspace.refreshCapabilities!();
  });
  expect(current().workspace.capabilities?.features).toEqual(['added']);
  releaseProbeCapabilities(Response.json({ features: ['pre-add'] }));
  await act(async () => diagnostics);
  expect(current().workspace.capabilities?.features).toEqual(['added']);
  await expect(current().workspace.getCapabilities!()).resolves.toMatchObject({
    features: ['added'],
  });
});

it('keeps brand retries bounded while successful diagnostics stay available', async () => {
  let releaseHealth!: (response: Response) => void;
  const health = new Promise<Response>((resolve) => {
    releaseHealth = resolve;
  });
  let brandRequests = 0;
  fetchMock.mockImplementation(async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === '/health') return (await health).clone();
    if (path === '/capabilities') return Response.json({ features: [] });
    if (path === '/brand' && ++brandRequests <= 2) {
      return Response.json({ error: 'Starting' }, { status: 503 });
    }
    return Response.json({});
  });
  await act(async () => {
    root.render(provider('brand'));
  });
  expect(brandRequests).toBe(1);
  const { availability } = connections.get('brand')!;
  await act(async () => {
    releaseHealth(Response.json({ status: 'ok' }));
    await availability.check();
  });
  expect(brandRequests).toBe(1);
  await act(async () => vi.advanceTimersByTimeAsync(120_000));
  expect(brandRequests).toBe(2);
  expect(availability.getSnapshot()).toBe('available');
});

it('stops both recovery loops when two providers unmount in the same commit', async () => {
  await act(async () => {
    root.render(
      <>
        <DaemonWorkspaceProvider baseUrl="https://first.example">
          <Probe id="first" />
        </DaemonWorkspaceProvider>
        <DaemonWorkspaceProvider baseUrl="https://second.example">
          <Probe id="second" />
        </DaemonWorkspaceProvider>
      </>,
    );
  });
  offline = true;
  await act(async () => {
    await Promise.all(
      [...connections.values()].map(({ availability }) => availability.check()),
    );
  });
  expect(
    fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/health')),
  ).toHaveLength(2);
  await act(async () => root.render(null));
  const requestsAtUnmount = fetchMock.mock.calls.length;
  await act(async () => vi.advanceTimersByTimeAsync(120_000));
  expect(fetchMock).toHaveBeenCalledTimes(requestsAtUnmount);
  for (const { availability } of connections.values()) {
    expect(() => availability.assertAvailable()).toThrow('unavailable');
  }
});

it.each(['first', 'second'])(
  'keeps the offline gate when the %s same-target provider unmounts',
  async (removed) => {
    const renderProviders = (ids: string[]) =>
      root.render(
        <>
          {ids.map((id) => (
            <DaemonWorkspaceProvider key={id} baseUrl="https://daemon.example">
              <Probe id={id} />
            </DaemonWorkspaceProvider>
          ))}
        </>,
      );
    await act(async () => renderProviders(['first', 'second']));
    offline = true;
    await act(async () => {
      await Promise.all(
        [...connections.values()].map(({ availability }) =>
          availability.check(),
        ),
      );
    });
    const remaining = removed === 'first' ? 'second' : 'first';
    await act(async () => renderProviders([remaining]));
    expect(findDaemonAvailability('https://daemon.example')).toBe(
      connections.get(remaining)!.availability,
    );
    const requestsBefore = fetchMock.mock.calls.length;
    await expect(
      createDaemonRestRequest('https://daemon.example')('/goals'),
    ).rejects.toMatchObject({ name: 'DaemonUnavailableError' });
    expect(fetchMock).toHaveBeenCalledTimes(requestsBefore);
  },
);

it('preserves a recoverable connection across StrictMode effect cleanup', async () => {
  await act(async () => {
    root.render(<StrictMode>{provider('strict')}</StrictMode>);
  });
  const { availability, client } = connections.get('strict')!;
  expect(() => availability.assertAvailable()).not.toThrow();
  offline = true;
  await act(async () => availability.check());
  expect(availability.getSnapshot()).toBe('unavailable');
  offline = false;
  await act(async () => vi.advanceTimersByTimeAsync(5_000));
  expect(availability.getSnapshot()).toBe('available');
  await expect(client.requestRest('/status')).resolves.toMatchObject({
    ok: true,
  });
  expect(connections.get('strict')!.client).toBe(client);
});

it('keeps the offline gate available to child detach cleanup during provider unmount', async () => {
  const detached: Array<Promise<unknown>> = [];
  function ChildCleanup() {
    useEffect(
      () => () => {
        detached.push(
          detachDaemonClient({
            baseUrl: 'https://daemon.example',
            sessionId: 'session-1',
            clientId: 'client-1',
          }).catch((error: unknown) => error),
        );
      },
      [],
    );
    return <Probe id="detach" />;
  }
  await act(async () => {
    root.render(
      <DaemonWorkspaceProvider baseUrl="https://daemon.example">
        <ChildCleanup />
      </DaemonWorkspaceProvider>,
    );
  });
  offline = true;
  await act(async () => connections.get('detach')!.availability.check());
  const requestsBeforeUnmount = fetchMock.mock.calls.length;
  await act(async () => root.render(null));
  expect(detached).toHaveLength(1);
  expect(await detached[0]).toMatchObject({ name: 'DaemonUnavailableError' });
  expect(fetchMock).toHaveBeenCalledTimes(requestsBeforeUnmount);
  expect(
    fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST'),
  ).toHaveLength(0);
  expect(findDaemonAvailability('https://daemon.example')).toBeUndefined();
});

it('pauses the workspace catalog while the daemon is unavailable', async () => {
  const setPaused = vi.spyOn(SessionCatalogStore.prototype, 'setPaused');
  await act(async () => root.render(provider('paused')));
  const { availability } = connections.get('paused')!;
  offline = true;
  await act(async () => availability.check(true));
  expect(setPaused).toHaveBeenLastCalledWith(true);
  offline = false;
  await act(async () => vi.advanceTimersByTimeAsync(5_000));
  expect(setPaused).toHaveBeenLastCalledWith(false);
});

it('creates a fresh usable controller when autoConnect is disabled then enabled', async () => {
  const renderEnabled = (autoConnect: boolean) =>
    root.render(provider('toggle', { autoConnect }));
  await act(async () => renderEnabled(true));
  const first = connections.get('toggle')!;
  await act(async () => renderEnabled(false));
  expect(findDaemonAvailability('https://daemon.example')).toBeUndefined();
  expect(() => first.availability.assertAvailable()).toThrow('unavailable');
  await act(async () => renderEnabled(true));
  const next = connections.get('toggle')!;
  expect(next.availability).not.toBe(first.availability);
  expect(findDaemonAvailability('https://daemon.example')).toBe(
    next.availability,
  );
  await expect(next.client.requestRest('/status')).resolves.toMatchObject({
    ok: true,
  });
});

it('retains the active registry entry after deferred StrictMode cleanup', async () => {
  await act(async () => {
    root.render(
      <StrictMode>{provider('registry', { token: 'secret' })}</StrictMode>,
    );
  });
  const { availability } = connections.get('registry')!;
  expect(findDaemonAvailability('https://daemon.example/', 'secret')).toBe(
    availability,
  );
  offline = true;
  await act(async () => availability.check());
  expect(
    findDaemonAvailability('https://daemon.example', 'secret')?.getSnapshot(),
  ).toBe('unavailable');
});

it('probes on foreground after auth-required can be fixed externally', async () => {
  await act(async () => root.render(provider('auth')));
  const { availability } = connections.get('auth')!;
  fetchMock.mockImplementation(async () => new Response(null, { status: 401 }));
  await act(async () => availability.check(true));
  expect(availability.getSnapshot()).toBe('auth-required');
  const before = fetchMock.mock.calls.length;
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'));
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(fetchMock.mock.calls.length).toBeGreaterThan(before);
});
