// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { DaemonHttpError, type DaemonClient } from '@qwen-code/sdk/daemon';
import type { DaemonConnectionState } from '../daemon/session/types';
import { useCapacityRecovery } from './useCapacityRecovery';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let container: HTMLElement;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});
it('rejects a late capacity error from a previous daemon and invalidates its existing choice', () => {
  const clientA = {} as DaemonClient;
  const clientB = {} as DaemonClient;
  const connection: DaemonConnectionState = { status: 'error' };
  const actions = { loadSession: vi.fn(), resumeSession: vi.fn() };
  let current!: ReturnType<typeof useCapacityRecovery>;
  function Harness({ client }: { client: DaemonClient }) {
    current = useCapacityRecovery(
      client,
      ['workspace_runtime_stop'],
      connection,
      actions,
    );
    return null;
  }
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => root.render(<Harness client={clientA} />));
  const offerFromA = current.offer;
  const error = new DaemonHttpError(
    503,
    { code: 'acp_child_capacity_exhausted' },
    'full',
  );
  const intent = { isCurrent: () => true, resume: vi.fn() };
  act(() => {
    expect(offerFromA(error, intent)).toBe(true);
  });
  expect(current.intent?.client).toBe(clientA);
  act(() => {
    expect(
      current.offer(error, {
        isCurrent: () => true,
        resume: vi.fn(),
        requesterCwd: '/other',
      }),
    ).toBe(false);
  });
  expect(current.intent?.resume).toBe(intent.resume);
  act(() => root.render(<Harness client={clientB} />));
  expect(current.intent?.isCurrent()).toBe(false);
  act(() => {
    expect(offerFromA(error, intent)).toBe(false);
    current.dismiss();
  });
  act(() => root.render(<Harness client={clientA} />));
  act(() => {
    expect(offerFromA(error, intent)).toBe(false);
  });
  expect(current.intent).toBeUndefined();
  expect(intent.resume).not.toHaveBeenCalled();
});

it('offers a pending restore when stop capabilities arrive after the capacity error', () => {
  const client = {} as DaemonClient;
  const connection: DaemonConnectionState = {
    status: 'error',
    capacityRecovery: {
      error: new DaemonHttpError(
        503,
        { code: 'acp_child_capacity_exhausted' },
        'full',
      ),
      sessionId: 'saved',
      mode: 'load',
    },
  };
  const actions = { loadSession: vi.fn(), resumeSession: vi.fn() };
  let current!: ReturnType<typeof useCapacityRecovery>;
  function Harness({ features }: { features?: string[] }) {
    current = useCapacityRecovery(client, features, connection, actions);
    return null;
  }
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => root.render(<Harness />));
  expect(current.intent).toBeUndefined();
  act(() => root.render(<Harness features={['workspace_runtime_stop']} />));
  expect(current.intent?.client).toBe(client);
  expect(current.intent?.isCurrent()).toBe(true);
  expect(actions.loadSession).not.toHaveBeenCalled();
});
