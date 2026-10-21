// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ManagedAgentProvider,
  ManagedAgentSessionSummary,
} from './managed-agent-provider';
import { useManagedSessionRename } from './use-managed-session-rename';

function summary(id: string, canRename = true): ManagedAgentSessionSummary {
  return {
    sessionId: id,
    title: `Title ${id}`,
    createdAt: 1,
    admittedAt: 1,
    updatedAt: 1,
    phase: 'agent_running',
    runtimeReady: true,
    runtimeState: 'ready',
    capabilities: { canSend: false, canCancel: true, canRename },
  };
}

describe('useManagedSessionRename', () => {
  let root: Root;
  let latest: ReturnType<typeof useManagedSessionRename>;
  const onRenamed = vi.fn();

  function Probe({
    provider,
    id,
    allowed,
    interactive,
  }: {
    provider: ManagedAgentProvider;
    id: string;
    allowed: boolean;
    interactive: boolean;
  }) {
    latest = useManagedSessionRename(
      provider,
      'client',
      id,
      summary(id, allowed),
      interactive,
      onRenamed,
    );
    return null;
  }

  beforeEach(() => {
    onRenamed.mockReset();
    root = createRoot(document.createElement('div'));
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  async function render(
    provider: ManagedAgentProvider,
    id = 'A',
    allowed = true,
    interactive = true,
  ) {
    await act(async () => {
      root.render(
        <Probe
          provider={provider}
          id={id}
          allowed={allowed}
          interactive={interactive}
        />,
      );
    });
  }

  it('renames a running Session, blocks duplicate submits, and reuses the key after an unknown result', async () => {
    let reject!: (error: Error) => void;
    const renameSession = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, fail) => {
            reject = fail;
          }),
      )
      .mockResolvedValue({ displayName: 'Stored name' });
    const provider = { renameSession } as unknown as ManagedAgentProvider;
    await render(provider);
    act(() => latest.open());
    let request!: Promise<void>;
    act(() => {
      request = latest.submit('Requested name');
    });
    await act(async () => {
      await latest.submit('Requested name');
    });
    expect(renameSession).toHaveBeenCalledOnce();
    expect(latest.editor?.busy).toBe(true);
    expect(onRenamed).not.toHaveBeenCalled();
    await act(async () => {
      reject(new TypeError('Lost response'));
      await request;
    });
    expect(latest.editor).toMatchObject({
      value: 'Requested name',
      busy: false,
      error: 'Lost response',
    });
    await act(async () => {
      await latest.submit('Requested name');
    });
    expect(renameSession.mock.calls[1][2].idempotencyKey).toBe(
      renameSession.mock.calls[0][2].idempotencyKey,
    );
    expect(onRenamed).toHaveBeenCalledWith('Stored name');
    expect(latest.editor).toBeUndefined();
  });

  it('uses a new key when the user changes the submitted name', async () => {
    const renameSession = vi.fn().mockRejectedValue(new Error('Unavailable'));
    await render({ renameSession } as unknown as ManagedAgentProvider);
    act(() => latest.open());
    await act(async () => {
      await latest.submit('First');
    });
    await act(async () => {
      latest.setValue('Second');
    });
    await act(async () => {
      await latest.submit('Second');
    });
    expect(renameSession.mock.calls[1][2].idempotencyKey).not.toBe(
      renameSession.mock.calls[0][2].idempotencyKey,
    );
  });

  it.each(['session', 'provider'] as const)(
    'ignores late success after switching %s and keeps the new editor',
    async (switchKind) => {
      let resolve!: (result: { displayName: string }) => void;
      const renameSession = vi.fn().mockImplementation(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      );
      const provider = { renameSession } as unknown as ManagedAgentProvider;
      await render(provider);
      act(() => latest.open());
      let request!: Promise<void>;
      act(() => {
        request = latest.submit('Old result');
      });
      await render(
        switchKind === 'provider' ? { ...provider } : provider,
        switchKind === 'session' ? 'B' : 'A',
      );
      act(() => latest.open());
      expect(latest.editor?.value).toBe(
        switchKind === 'session' ? 'Title B' : 'Title A',
      );
      await act(async () => {
        resolve({ displayName: 'Old result' });
        await request;
      });
      expect(renameSession.mock.calls[0][2].signal.aborted).toBe(true);
      expect(onRenamed).not.toHaveBeenCalled();
      expect(latest.editor?.value).toBe(
        switchKind === 'session' ? 'Title B' : 'Title A',
      );
    },
  );

  it('requires both advertised permission and an interactive provider method', async () => {
    const renameSession = vi.fn();
    const provider = { renameSession } as unknown as ManagedAgentProvider;
    await render(provider, 'A', false);
    act(() => latest.open());
    await act(async () => {
      await latest.submit('Forbidden');
    });
    expect(latest.editor).toBeUndefined();
    expect(renameSession).not.toHaveBeenCalled();
    await render(provider, 'A', true, false);
    expect(latest.supported).toBe(false);
    await render({} as ManagedAgentProvider);
    expect(latest.supported).toBe(false);
  });
});
