// @vitest-environment jsdom

import { EditorView } from '@codemirror/view';
import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { renderManagedAgentWebShell } from './managed-host';
import type {
  ManagedAgentProvider,
  ManagedAgentSessionSummary,
} from './components/managed/managed-agent-provider';

it('accepts a real composer submission without a public durable operation ID', async () => {
  const session: ManagedAgentSessionSummary = {
    sessionId: 'host-session',
    title: 'Host session',
    createdAt: 1,
    updatedAt: 1,
    admittedAt: 1,
    phase: 'created',
    runtimeReady: true,
    runtimeState: 'ready',
    capabilities: { canSend: true, canCancel: false },
  };
  const unsupported = vi.fn(async () => {
    throw new Error('Unsupported host API');
  });
  const submitPrompt = vi.fn<ManagedAgentProvider['submitPrompt']>(async () => {
    session.phase = 'completed';
    session.capabilities.canSend = false;
    return { sessionId: session.sessionId, turnId: 'accepted-turn' };
  });
  const provider: ManagedAgentProvider = {
    storageKey: 'host-composer:tenant:actor',
    canCancel: false,
    listSessions: unsupported,
    createSession: unsupported,
    cancel: unsupported,
    queryCancelOperation: unsupported,
    getSession: async () => ({ ...session }),
    getTranscript: async () => ({ events: [], lastEventId: 0 }),
    async *subscribeEvents(_id, options) {
      await new Promise<void>((resolve) => {
        if (options.signal?.aborted) resolve();
        else
          options.signal?.addEventListener('abort', () => resolve(), {
            once: true,
          });
      });
      yield* [];
    },
    submitPrompt,
  };
  const unexpectedFetch = vi.fn(async () => {
    throw new Error('Unexpected network request');
  });
  vi.stubGlobal('fetch', unexpectedFetch);
  localStorage.clear();
  sessionStorage.clear();
  const container = document.createElement('div');
  document.body.appendChild(container);
  let shell!: ReturnType<typeof renderManagedAgentWebShell>;
  const flush = async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve();
  };
  try {
    await act(async () => {
      shell = renderManagedAgentWebShell(container, {
        managedAgentProvider: provider,
        hostSessionOnly: true,
        sessionId: session.sessionId,
        language: 'en',
      });
      await flush();
    });
    const editorNode = container.querySelector<HTMLElement>('.cm-editor');
    expect(editorNode).not.toBeNull();
    const editor = EditorView.findFromDOM(editorNode!)!;
    await act(async () => {
      editor.dispatch({
        changes: { from: 0, insert: 'Run the existing host session' },
      });
      await flush();
    });
    const send = container.querySelector<HTMLButtonElement>(
      '[data-web-shell-composer-submit]',
    )!;
    expect(send.disabled).toBe(false);
    await act(async () => {
      send.click();
      await flush();
    });
    expect(submitPrompt).toHaveBeenCalledTimes(1);
    expect(submitPrompt).toHaveBeenCalledWith(
      session.sessionId,
      expect.objectContaining({ text: 'Run the existing host session' }),
      expect.objectContaining({ idempotencyKey: expect.any(String) }),
    );
    expect(editor.state.doc.toString()).toBe('');
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).not.toContain('unconfirmed');
    expect(unsupported).not.toHaveBeenCalled();
    expect(unexpectedFetch).not.toHaveBeenCalled();
  } finally {
    if (shell) await act(async () => shell.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
