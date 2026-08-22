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
  root = undefined;
  container = undefined;
});

function Harness() {
  const transcript = useAcpTranscript(true);
  return <pre>{JSON.stringify(transcript.blocks)}</pre>;
}

function mount(): HTMLElement {
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
});
