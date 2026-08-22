// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { useWebShellTranscriptEnabled } from './useWebShellTranscriptEnabled.js';

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

function EnabledValue() {
  return <span>{String(useWebShellTranscriptEnabled())}</span>;
}

describe('useWebShellTranscriptEnabled', () => {
  it('uses the host value and reacts to configuration updates', async () => {
    document.body.dataset.webShellTranscript = 'enabled';
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root?.render(<EnabledValue />));
    expect(container.textContent).toBe('true');

    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'webShellTranscriptSettingChanged',
            data: { enabled: false },
          },
        }),
      );
    });
    expect(container.textContent).toBe('false');
  });
});
