// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  DaemonHttpError,
  type DaemonSessionArtifact,
} from '@qwen-code/sdk/daemon';
import { I18nProvider } from '../../i18n';
import { SavedWebPreview } from './SavedWebPreview';

const { readContent, client } = vi.hoisted(() => {
  const readContent = vi.fn();
  return { readContent, client: { readSessionArtifactContent: readContent } };
});
vi.mock('@qwen-code/web-shell/daemon-react-sdk', () => ({
  useWorkspace: () => ({ client }),
  useConnection: () => ({ sessionId: 'active-session', clientId: 'viewer' }),
}));
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
const artifact = (id: string): DaemonSessionArtifact => ({
  id,
  title: 'Page',
  kind: 'html',
  storage: 'published',
  source: 'tool',
  status: 'available',
  retention: 'restorable',
  clientRetained: false,
  createdAt: '2026-09-07T00:00:00.000Z',
  updatedAt: '2026-09-07T00:00:00.000Z',
  metadata: { artifactType: 'web_preview_snapshot' },
});
function view(id: string, sourceSessionId = 'original-session') {
  return (
    <I18nProvider language="en">
      <SavedWebPreview
        artifact={artifact(id)}
        sourceSessionId={sourceSessionId}
      />
    </I18nProvider>
  );
}
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  readContent.mockReset();
  vi.restoreAllMocks();
});

describe('SavedWebPreview', () => {
  it('reads the original session and cannot display a stale response in another version', async () => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    let finishFirst!: (value: string) => void;
    readContent.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          finishFirst = resolve;
        }),
    );
    readContent.mockResolvedValueOnce(
      '<h1>Version two</h1><script>let count=0</script>',
    );
    await act(async () => {
      root.render(view('one'));
    });
    const firstSignal = readContent.mock.calls[0]![2].signal as AbortSignal;
    expect(readContent).toHaveBeenCalledWith('original-session', 'one', {
      clientId: undefined,
      signal: firstSignal,
    });
    await act(async () => {
      root.render(view('two'));
    });
    expect(firstSignal.aborted).toBe(true);
    await act(async () => {
      finishFirst('<h1>Version one</h1>');
    });
    const iframe = container.querySelector('iframe')!;
    const contentFrame = new DOMParser()
      .parseFromString(iframe.srcdoc, 'text/html')
      .querySelector('iframe')!;
    expect(contentFrame.srcdoc).toContain('Version two');
    expect(contentFrame.srcdoc).not.toContain('Version one');
    expect(contentFrame.srcdoc).toContain('<script>let count=0</script>');
    expect(contentFrame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(iframe.srcdoc).toContain("frame-src 'none'");
    expect(iframe.sandbox?.value ?? iframe.getAttribute('sandbox')).toBe(
      'allow-scripts',
    );
    expect(iframe.srcdoc).toContain("default-src 'none'");
    expect(iframe.srcdoc).toContain('font-src data:');
    expect(container.textContent).toContain('Saved version');
  });

  it('shows an unavailable version without loading a current URL', async () => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    readContent.mockRejectedValue(
      new DaemonHttpError(
        404,
        { error: 'artifact_snapshot_unavailable' },
        'missing',
      ),
    );
    await act(async () => {
      root.render(view('missing'));
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'missing or has changed',
    );
    expect(container.querySelector('iframe')).toBeNull();
    expect(readContent).toHaveBeenCalledTimes(1);
  });
  it('uses the active session identity locally and memoizes unchanged HTML', async () => {
    container = document.createElement('div');
    root = createRoot(container);
    readContent.mockResolvedValue('<h1>Local</h1>');
    const parse = vi.spyOn(DOMParser.prototype, 'parseFromString');
    await act(async () => root.render(view('local', 'active-session')));
    expect(readContent.mock.calls[0]![2].clientId).toBe('viewer');
    expect(parse).toHaveBeenCalledTimes(1);
    await act(async () => root.render(view('local', 'active-session')));
    expect(readContent).toHaveBeenCalledTimes(1);
    expect(parse).toHaveBeenCalledTimes(1);
  });

  it('refreshes loaded HTML from memory without another server read', async () => {
    container = document.createElement('div');
    root = createRoot(container);
    readContent
      .mockResolvedValueOnce('<h1>Version one</h1>')
      .mockRejectedValue(new DaemonHttpError(503, {}, 'busy'));
    await act(async () => root.render(view('one')));
    const originalFrame = container.querySelector('iframe')!;
    const originalDocument = originalFrame.srcdoc;
    await act(async () => container.querySelector('button')!.click());
    const refreshedFrame = container.querySelector('iframe')!;
    expect(refreshedFrame).not.toBe(originalFrame);
    expect(refreshedFrame.srcdoc).toBe(originalDocument);
    expect(refreshedFrame.srcdoc).toContain('Version one');
    expect(readContent).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it.each([
    new DaemonHttpError(503, {}, 'busy'),
    new DaemonHttpError(
      404,
      { code: 'session_not_found' },
      'session unavailable',
    ),
    new Error('timeout'),
  ])('retries transient failures: %s', async (error) => {
    container = document.createElement('div');
    root = createRoot(container);
    readContent
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce('<h1>Recovered</h1>');
    await act(async () => root.render(view('recover')));
    expect(container.textContent).toContain('Could not load');
    expect(container.textContent).not.toContain('missing or has changed');
    const retry = container.querySelector('button')!;
    expect(retry.textContent).toBe('Try again');
    await act(async () => retry.click());
    expect(readContent).toHaveBeenCalledTimes(2);
    expect(container.querySelector('iframe')!.srcdoc).toContain('Recovered');
  });
});
