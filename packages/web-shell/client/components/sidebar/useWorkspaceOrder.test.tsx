// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { flushReact } from '../../test/reactHarness';
import { useWorkspaceOrder } from './useWorkspaceOrder';
import { readWorkspaceOrder, writeWorkspaceOrder } from './workspaceOrder';

type Options = Parameters<typeof useWorkspaceOrder>[0];
let options: Options;
let current: ReturnType<typeof useWorkspaceOrder>;
let root: Root;
let container: HTMLDivElement;
function Harness() {
  current = useWorkspaceOrder(options);
  return null;
}
function render(next: Partial<Options> = {}) {
  options = { ...options, ...next };
  act(() => root.render(<Harness />));
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  localStorage.clear();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  options = {
    client: {
      getWorkspaceOrder: vi.fn().mockResolvedValue({ cwds: ['/b', '/a'] }),
      setWorkspaceOrder: vi.fn().mockResolvedValue({ cwds: [] }),
    },
    scope: 'http://one',
    primaryWorkspaceCwd: '/a',
    serverEnabled: true,
    onError: vi.fn(),
  };
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it('loads server order over conflicting local preferences and saves only to the server', async () => {
  writeWorkspaceOrder(options.scope, ['/obsolete-local']);
  render();
  expect(current.canReorder).toBe(false);
  expect(current.order).toEqual([]);
  await flushReact();
  expect(current.order).toEqual(['/b', '/a']);
  await act(async () => current.saveOrder(['/a', '/b']));
  expect(options.client.setWorkspaceOrder).toHaveBeenCalledWith(['/a', '/b']);
  expect(readWorkspaceOrder(options.scope)).toEqual(['/obsolete-local']);
  expect(current.canReorder).toBe(true);
});

it('prevents overlapping saves and restores the previous order on failure', async () => {
  const pending = deferred<{ cwds: string[] }>();
  vi.mocked(options.client.setWorkspaceOrder).mockReturnValue(pending.promise);
  render();
  await flushReact();
  const save = current.saveOrder;
  let first!: Promise<void>;
  act(() => {
    first = save(['/a', '/b']);
    void save(['/b', '/a']);
  });
  expect(options.client.setWorkspaceOrder).toHaveBeenCalledTimes(1);
  expect(current.order).toEqual(['/a', '/b']);
  expect(current.canReorder).toBe(false);
  await act(async () => {
    pending.reject(new Error('disk full'));
    await first;
  });
  expect(current.order).toEqual(['/b', '/a']);
  expect(options.onError).toHaveBeenCalledOnce();
  expect(current.canReorder).toBe(true);
});

it('releases the pending-save latch after a rejected write', async () => {
  render();
  await flushReact();
  vi.mocked(options.client.setWorkspaceOrder).mockRejectedValueOnce(
    new Error('disk full'),
  );
  await act(async () => current.saveOrder(['/a', '/b']));
  expect(options.client.setWorkspaceOrder).toHaveBeenCalledTimes(1);
  vi.mocked(options.client.setWorkspaceOrder).mockResolvedValueOnce({
    cwds: ['/a', '/b'],
  });
  await act(async () => current.saveOrder(['/a', '/b']));
  expect(options.client.setWorkspaceOrder).toHaveBeenCalledTimes(2);
  expect(current.order).toEqual(['/a', '/b']);
});

it('blocks sorting after an initial read failure rather than overwriting the server', async () => {
  vi.mocked(options.client.getWorkspaceOrder).mockRejectedValue(
    new Error('offline'),
  );
  writeWorkspaceOrder(options.scope, ['/local']);
  render();
  await flushReact();
  expect(current.order).toEqual([]);
  expect(current.canReorder).toBe(false);
  await act(async () => current.saveOrder(['/local']));
  expect(options.client.setWorkspaceOrder).not.toHaveBeenCalled();
  expect(options.onError).toHaveBeenCalledOnce();
});

it('discards late reads and failed saves after switching daemons', async () => {
  const oldRead = deferred<{ cwds: string[] }>();
  const oldClient = options.client;
  vi.mocked(oldClient.getWorkspaceOrder).mockReturnValueOnce(oldRead.promise);
  render();
  const newClient = {
    getWorkspaceOrder: vi.fn().mockResolvedValue({ cwds: ['/new'] }),
    setWorkspaceOrder: vi.fn().mockResolvedValue({ cwds: ['/new'] }),
  };
  render({ client: newClient, scope: 'http://two' });
  await flushReact();
  await act(async () => {
    oldRead.resolve({ cwds: ['/old'] });
    await oldRead.promise;
  });
  expect(current.order).toEqual(['/new']);
  const pending = deferred<{ cwds: string[] }>();
  newClient.setWorkspaceOrder.mockReturnValue(pending.promise);
  let saving!: Promise<void>;
  act(() => {
    saving = current.saveOrder(['/changed']);
  });
  render({ client: oldClient, scope: 'http://one' });
  await flushReact();
  await act(async () => {
    pending.reject(new Error('late failure'));
    await saving;
  });
  expect(current.order).toEqual(['/b', '/a']);
  expect(options.onError).not.toHaveBeenCalled();
});

it('keeps local persistence for an older daemon without the capability', async () => {
  writeWorkspaceOrder(options.scope, ['/a']);
  render({ serverEnabled: false });
  expect(current.order).toEqual(['/a']);
  await act(async () => current.saveOrder(['/b', '/a']));
  expect(readWorkspaceOrder(options.scope)).toEqual(['/b', '/a']);
  expect(options.client.getWorkspaceOrder).not.toHaveBeenCalled();
  expect(options.client.setWorkspaceOrder).not.toHaveBeenCalled();
});

it('reloads order and blocks saves when the same daemon changes primary workspace', async () => {
  render();
  await flushReact();
  const nextRead = deferred<{ cwds: string[] }>();
  vi.mocked(options.client.getWorkspaceOrder).mockReturnValue(nextRead.promise);
  render({ primaryWorkspaceCwd: '/b' });
  expect(current.order).toEqual([]);
  expect(current.canReorder).toBe(false);
  await act(async () => current.saveOrder(['/a', '/b']));
  expect(options.client.setWorkspaceOrder).not.toHaveBeenCalled();
  await act(async () => nextRead.resolve({ cwds: ['/a', '/b'] }));
  expect(options.client.getWorkspaceOrder).toHaveBeenCalledTimes(2);
  expect(current.order).toEqual(['/a', '/b']);
  expect(current.canReorder).toBe(true);
});

it('ignores pending reads and saves from the previous primary workspace', async () => {
  const oldRead = deferred<{ cwds: string[] }>();
  vi.mocked(options.client.getWorkspaceOrder).mockReturnValueOnce(
    oldRead.promise,
  );
  render();
  render({ primaryWorkspaceCwd: '/b' });
  await flushReact();
  await act(async () => oldRead.resolve({ cwds: ['/obsolete'] }));
  expect(current.order).toEqual(['/b', '/a']);

  const oldSave = deferred<{ cwds: string[] }>();
  vi.mocked(options.client.setWorkspaceOrder).mockReturnValueOnce(
    oldSave.promise,
  );
  let saving!: Promise<void>;
  act(() => {
    saving = current.saveOrder(['/a', '/b']);
  });
  vi.mocked(options.client.getWorkspaceOrder).mockResolvedValue({
    cwds: ['/c'],
  });
  render({ primaryWorkspaceCwd: '/c' });
  await flushReact();
  await act(async () => {
    oldSave.reject(new Error('late failure'));
    await saving;
  });
  expect(current.order).toEqual(['/c']);
  expect(current.canReorder).toBe(true);
  expect(options.onError).not.toHaveBeenCalled();
});

it('keeps the origin-only local preference when an older daemon changes primary', async () => {
  writeWorkspaceOrder(options.scope, ['/a']);
  render({ serverEnabled: false });
  await act(async () => current.saveOrder(['/b', '/a']));
  render({ primaryWorkspaceCwd: '/b' });
  expect(current.order).toEqual(['/b', '/a']);
  expect(readWorkspaceOrder(options.scope)).toEqual(['/b', '/a']);
  expect(options.client.getWorkspaceOrder).not.toHaveBeenCalled();
});
