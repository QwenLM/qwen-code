// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SessionSource } from '@qwen-code/sdk/daemon';
import type { DaemonSessionActions } from '@qwen-code/web-shell/daemon-react-sdk';
import { ArtifactPanel } from './ArtifactPanel';
import { I18nProvider } from '../../i18n';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const mock = vi.hoisted(() => ({
  current: true,
  trusted: true,
  standalone: false,
  connection: {
    sessionId: 'session-a',
    workspaceCwd: '/workspace',
    capabilities: { features: ['session_sources'] },
  },
  actions: {
    readWorkspaceFile: vi.fn(),
    readFileBytes: vi.fn(),
    stat: vi.fn(),
  },
  sessionActions: { readAttachment: vi.fn() },
}));
vi.mock('@qwen-code/web-shell/daemon-react-sdk', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  useConnection: () => ({
    ...mock.connection,
    workspaceCwd: mock.standalone ? undefined : mock.connection.workspaceCwd,
  }),
}));
vi.mock('../terminal/TerminalPanel', () => ({ TerminalPanel: () => null }));
const target = {
  workspaceCwd: '/workspace',
  workspaceId: 'owner-a',
  actions: mock.actions,
};
vi.mock('./useArtifactWorkspaceTarget', () => ({
  useArtifactWorkspaceTarget: (cwd: string) =>
    mock.trusted && cwd ? { ...target } : undefined,
}));
let container: HTMLDivElement;
let root: Root;
const owner = { isCurrent: () => mock.current };
const source = (locator: SessionSource['locator']): SessionSource => ({
  id: 'source-a',
  title: 'Reference',
  locator,
  kind: locator.type === 'url' ? 'link' : 'file',
  ...(locator.type === 'workspace_file' ? { workspaceCwd: '/workspace' } : {}),
  createdAt: '2026-09-07T00:00:00Z',
  updatedAt: '2026-09-07T00:00:00Z',
});
async function render(value: SessionSource) {
  await act(async () =>
    root.render(
      <I18nProvider language="en">
        <ArtifactPanel
          artifacts={[]}
          tabs={[
            {
              id: 'source:session-a:source-a',
              kind: 'source',
              title: value.title,
              source: value,
              sourceSessionId: 'session-a',
              workspaceCwd: mock.standalone ? undefined : '/workspace',
              workspaceId: mock.standalone ? undefined : 'owner-a',
              owner,
              sessionActions:
                mock.sessionActions as unknown as DaemonSessionActions,
            },
          ]}
          activeTabId="source:session-a:source-a"
          reviewChanges={[]}
          selectedReviewPath={null}
          onSelectTab={() => {}}
          onCloseTab={() => {}}
          onOpenFilePreview={() => {}}
          onClose={() => {}}
        />
      </I18nProvider>,
    ),
  );
}
beforeEach(() => {
  mock.current = true;
  mock.trusted = true;
  mock.standalone = false;
  mock.connection.workspaceCwd = '/workspace';
  Object.values(mock.actions).forEach((fn) => fn.mockReset());
  mock.sessionActions.readAttachment.mockReset();
  mock.actions.stat.mockResolvedValue({
    type: 'file',
    sizeBytes: 20,
    modifiedMs: 1,
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('source preview', () => {
  it('offers retry only after attachment loading fails', async () => {
    mock.standalone = true;
    mock.sessionActions.readAttachment
      .mockRejectedValueOnce(new Error('Attachment read failed'))
      .mockResolvedValueOnce({
        data: btoa('Recovered attachment'),
        mimeType: 'text/plain',
      });
    await render(source({ type: 'attachment', attachmentId: 'reference.txt' }));
    await vi.waitFor(() =>
      expect(container.textContent).toContain('Attachment read failed'),
    );
    const retry = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Try again',
    );
    expect(retry).not.toBeUndefined();
    await act(async () => retry!.click());
    await vi.waitFor(() =>
      expect(container.textContent).toContain('Recovered attachment'),
    );
    expect(
      Array.from(container.querySelectorAll('button')).some(
        (button) => button.textContent === 'Try again',
      ),
    ).toBe(false);
    expect(mock.sessionActions.readAttachment).toHaveBeenCalledTimes(2);
  });

  it('offers retry only after workspace file loading fails', async () => {
    mock.actions.readWorkspaceFile
      .mockRejectedValueOnce(new Error('Workspace read failed'))
      .mockResolvedValueOnce({
        content: 'Recovered workspace file',
        truncated: false,
      });
    await render(
      source({ type: 'workspace_file', workspacePath: 'reference.txt' }),
    );
    await vi.waitFor(() =>
      expect(container.textContent).toContain('Workspace read failed'),
    );
    const retry = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Try again',
    );
    expect(retry).not.toBeUndefined();
    await act(async () => retry!.click());
    await vi.waitFor(() =>
      expect(container.textContent).toContain('Recovered workspace file'),
    );
    expect(
      Array.from(container.querySelectorAll('button')).some(
        (button) => button.textContent === 'Try again',
      ),
    ).toBe(false);
    expect(mock.actions.readWorkspaceFile).toHaveBeenCalledTimes(2);
  });

  it.each(['text/plain', 'text/html'])(
    'previews standalone attachment bytes as %s without workspace access',
    async (mimeType) => {
      mock.standalone = true;
      mock.sessionActions.readAttachment.mockResolvedValue({
        data: btoa('<script>STANDALONE_SOURCE_BYTES</script>'),
        mimeType,
      });
      await render(
        source({
          type: 'attachment',
          attachmentId:
            mimeType === 'text/html' ? 'reference.html' : 'reference.txt',
        }),
      );
      expect(mock.sessionActions.readAttachment).toHaveBeenCalledOnce();
      await vi.waitFor(async () => {
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
        expect(container.textContent).toContain('STANDALONE_SOURCE_BYTES');
      });
      expect(container.querySelector('iframe')).toBeNull();
      expect(mock.actions.stat).not.toHaveBeenCalled();
      expect(mock.actions.readWorkspaceFile).not.toHaveBeenCalled();
      expect(mock.actions.readFileBytes).not.toHaveBeenCalled();
    },
  );

  it('rejects standalone attachment access after its owner is revoked', async () => {
    mock.standalone = true;
    mock.current = false;
    await render(source({ type: 'attachment', attachmentId: 'reference.txt' }));
    expect(container.textContent).toContain('no longer available');
    expect(mock.sessionActions.readAttachment).not.toHaveBeenCalled();
  });

  it('opens URL metadata without fetching it', async () => {
    await render(source({ type: 'url', url: 'https://example.com/docs#part' }));
    expect(
      container.querySelector('a[href="https://example.com/docs#part"]')
        ?.textContent,
    ).toBe('Open original');
    expect(container.querySelector('iframe')).toBeNull();
    expect(mock.actions.readWorkspaceFile).not.toHaveBeenCalled();
    expect(mock.sessionActions.readAttachment).not.toHaveBeenCalled();
  });
  it('renders source HTML as text without executing an iframe', async () => {
    mock.actions.readWorkspaceFile.mockResolvedValue({
      content: '<script>window.shouldNotRun = true</script>',
      truncated: false,
    });
    await render(
      source({ type: 'workspace_file', workspacePath: 'input.html' }),
    );
    expect(mock.actions.readWorkspaceFile).toHaveBeenCalledWith('input.html');
    expect(container.querySelector('iframe')).toBeNull();
    expect(container.textContent).toContain('window.shouldNotRun');
  });
  it('rejects a changed workspace and revoked owner without reading', async () => {
    mock.connection.workspaceCwd = '/different';
    await render(
      source({ type: 'workspace_file', workspacePath: 'input.html' }),
    );
    expect(container.textContent).toContain('no longer available');
    expect(mock.actions.stat).not.toHaveBeenCalled();
    mock.connection.workspaceCwd = '/workspace';
    mock.trusted = false;
    await render(source({ type: 'attachment', attachmentId: 'image.png' }));
    expect(mock.sessionActions.readAttachment).not.toHaveBeenCalled();
  });
  it('places attachment download in the source header and revokes its blob URL', async () => {
    const create = vi.fn(() => 'blob:source-test');
    const revoke = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: create,
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: revoke,
    });
    mock.sessionActions.readAttachment.mockResolvedValue({
      data: 'AAEC',
      mimeType: 'application/octet-stream',
    });
    await render(source({ type: 'attachment', attachmentId: 'data.bin' }));
    expect(mock.sessionActions.readAttachment).toHaveBeenCalledOnce();
    const download = container.querySelector<HTMLAnchorElement>('a[download]');
    expect(download?.getAttribute('href')).toBe('blob:source-test');
    const sourceHeader = container.querySelector(
      'span[title="data.bin"]',
    )?.parentElement;
    expect(sourceHeader?.contains(download ?? null)).toBe(true);
    await act(async () => root.render(null));
    expect(revoke).toHaveBeenCalledWith('blob:source-test');
  });
});
