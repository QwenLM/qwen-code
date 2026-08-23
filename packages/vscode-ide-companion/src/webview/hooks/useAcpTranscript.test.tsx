// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { useAcpTranscript } from './useAcpTranscript.js';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLElement | undefined;

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  delete document.body.dataset.webShellTranscript;
  root = undefined;
  container = undefined;
});

function Harness() {
  const transcript = useAcpTranscript();
  return <pre>{JSON.stringify(transcript)}</pre>;
}

function mount(): HTMLElement {
  document.body.dataset.webShellTranscript ??= 'enabled';
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<Harness />));
  return container;
}

function post(type: string, data: Record<string, unknown>): void {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: { type, data } }));
  });
}

function textUpdate(text: string, segmentId: string) {
  return {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text },
    _meta: { qwenTranscript: { segmentId } },
  };
}

describe('useAcpTranscript', () => {
  it('uses the host setting and reacts to configuration updates', () => {
    document.body.dataset.webShellTranscript = 'enabled';
    const view = mount();
    expect(view.textContent).toContain('"enabled":true');

    post('webShellTranscriptSettingChanged', { enabled: false });

    expect(view.textContent).toContain('"enabled":false');
  });

  it('drops updates while the active scope is unknown', () => {
    const view = mount();
    post('conversationCleared', {});
    post('transcriptUpdate', {
      sessionId: 'stale-session',
      update: textUpdate('STALE CONTENT', 'stale-1'),
    });

    expect(view.textContent).not.toContain('STALE CONTENT');
  });

  it('accepts only updates for the host-declared session', () => {
    const view = mount();
    post('qwenSessionSwitched', { sessionId: 'new-session' });
    post('transcriptUpdate', {
      sessionId: 'stale-session',
      update: textUpdate('STALE CONTENT', 'stale-1'),
    });
    post('transcriptUpdate', {
      sessionId: 'new-session',
      update: textUpdate('NEW CONTENT', 'new-1'),
    });

    expect(view.textContent).not.toContain('STALE CONTENT');
    expect(view.textContent).toContain('NEW CONTENT');
  });

  it('binds the host scope when the feature is enabled at runtime', () => {
    const view = mount();
    post('webShellTranscriptSettingChanged', {
      enabled: true,
      sessionId: 'runtime-session',
    });
    post('transcriptUpdate', {
      sessionId: 'runtime-session',
      update: textUpdate('RUNTIME CONTENT', 'runtime-1'),
    });

    expect(view.textContent).toContain('RUNTIME CONTENT');
  });

  it('resets stale blocks and binds the fresh scope after reconnect', () => {
    const view = mount();
    post('qwenSessionSwitched', { sessionId: 'old-session' });
    post('transcriptUpdate', {
      sessionId: 'old-session',
      update: textUpdate('OLD CONTENT', 'old-1'),
    });
    expect(view.textContent).toContain('OLD CONTENT');

    post('conversationLoaded', { id: 'local-conversation', messages: [] });
    expect(view.textContent).not.toContain('OLD CONTENT');
    post('agentConnected', { sessionId: 'fresh-session' });
    post('transcriptUpdate', {
      sessionId: 'fresh-session',
      update: textUpdate('FRESH CONTENT', 'fresh-1'),
    });
    expect(view.textContent).toContain('FRESH CONTENT');
  });

  it('clears transcript blocks when the agent connection fails', () => {
    const view = mount();
    post('qwenSessionSwitched', { sessionId: 'old-session' });
    post('transcriptUpdate', {
      sessionId: 'old-session',
      update: textUpdate('OLD CONTENT', 'old-1'),
    });

    post('agentConnectionError', { message: 'connection failed' });

    expect(view.textContent).not.toContain('OLD CONTENT');
  });
});
