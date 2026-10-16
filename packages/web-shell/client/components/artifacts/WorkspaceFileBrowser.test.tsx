// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { WorkspaceFileBrowser } from './WorkspaceFileBrowser';
import type { ArtifactWorkspaceActions } from './useArtifactWorkspaceTarget';

const settings = vi.hoisted(() => ({
  enabled: true,
  maxBytes: 2 * 1024 * 1024,
}));
vi.mock('../../customization', () => ({
  useWebShellCustomization: () => ({ fileUploadEnabled: settings.enabled }),
}));
vi.mock('../../themeContext', () => ({ useTheme: () => 'light' }));
vi.mock('@qwen-code/web-shell/daemon-react-sdk', () => ({
  useWorkspace: () => ({
    capabilities: {
      features: ['workspace_file_upload', 'workspace_qualified_rest_core'],
      limits: { maxWorkspaceFileUploadBytes: settings.maxBytes },
    },
  }),
}));
vi.mock('react-resizable-panels', () => ({
  usePanelRef: () => ({ current: null }),
}));
vi.mock('../ui/resizable', () => ({
  ResizablePanelGroup: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  ResizablePanel: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  ResizableHandle: () => null,
}));
const treeOptions = vi.hoisted(() => ({
  current: undefined as
    | ConstructorParameters<typeof import('@pierre/trees').FileTree>[0]
    | undefined,
}));
vi.mock('@pierre/trees', () => ({
  FileTree: class {
    constructor(
      options: ConstructorParameters<
        typeof import('@pierre/trees').FileTree
      >[0],
    ) {
      treeOptions.current = options;
    }
    render() {}
    getFileTreeContainer() {
      return undefined;
    }
    subscribe() {
      return () => {};
    }
    batch() {}
    setSearch() {}
    cleanUp() {}
  },
}));
let root: Root | undefined;
let container: HTMLDivElement;
const upload = vi.fn();
async function mount(
  workspaceCwd = '/workspace',
  rootListing: {
    entries: Array<{ name: string; kind: 'file' }>;
    truncated: boolean;
  } = {
    entries: [],
    truncated: false,
  },
) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const actions = {
    listDirectory: vi.fn().mockResolvedValue(rootListing),
    uploadWorkspaceFile: upload,
  } as unknown as ArtifactWorkspaceActions;
  await act(async () =>
    root!.render(
      <I18nProvider language="en">
        <WorkspaceFileBrowser
          workspaceCwd={workspaceCwd}
          actions={actions}
          renderPreview={() => null}
          onOpenPreview={() => {}}
        />
      </I18nProvider>,
    ),
  );
}
function dispatch(type: string, files: File[]) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', {
    value: { types: ['Files'], files },
  });
  act(() =>
    container
      .querySelector('[data-testid="workspace-file-sidebar"]')!
      .dispatchEvent(event),
  );
  return event.defaultPrevented;
}
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  settings.enabled = true;
  settings.maxBytes = 2 * 1024 * 1024;
  upload.mockReset();
});
it('host disable overrides both daemon capabilities and the available upload action', async () => {
  settings.enabled = false;
  await mount();
  expect(dispatch('dragover', [new File(['x'], 'disabled.bin')])).toBe(true);
  expect(container.textContent).not.toContain('Drop files');
  expect(dispatch('drop', [new File(['x'], 'disabled.bin')])).toBe(true);
  expect(upload).not.toHaveBeenCalled();
  expect(container.querySelector('[role="progressbar"]')).toBeNull();
});
it('reports the advertised size limit through one polite status and allows dismissal', async () => {
  await mount();
  dispatch('drop', [
    new File([new Uint8Array(3 * 1024 * 1024)], 'large.bin'),
    new File([new Uint8Array(3 * 1024 * 1024)], 'other.bin'),
  ]);
  expect(upload).not.toHaveBeenCalled();
  expect(container.textContent).toContain('2 MiB');
  expect(container.textContent).toContain('large.bin');
  expect(container.textContent).toContain('other.bin');
  expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);
  expect(container.querySelector('[role="status"]')?.textContent).toContain(
    'large.bin',
  );
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.querySelector('[role="progressbar"]')).toBeNull();
  act(() =>
    (
      container.querySelector('[aria-label="Dismiss"]') as HTMLButtonElement
    ).click(),
  );
  expect(container.textContent).not.toContain('large.bin');
});
it('reports overflow once with the skipped filename and count', async () => {
  settings.maxBytes = 0;
  await mount();
  dispatch(
    'drop',
    Array.from(
      { length: 102 },
      (_, index) => new File(['x'], `file-${index}.bin`),
    ),
  );
  expect(upload).not.toHaveBeenCalled();
  expect(container.textContent).toContain('file-100.bin');
  expect(container.textContent).toContain('2 more files');
  expect(container.textContent).not.toContain('file-101.bin');
  expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);
  expect(container.querySelector('[role="alert"]')).toBeNull();
});
it('keeps repeated spaces in the workspace name shown in the header', async () => {
  await mount('/workspace/notes  draft');
  expect(container.textContent).toContain('notes  draft');
});
it('keeps repeated spaces in the selected file shown in the header', async () => {
  await mount('/workspace', {
    entries: [{ name: 'notes  draft.md', kind: 'file' }],
    truncated: false,
  });
  act(() => treeOptions.current?.onSelectionChange?.(['notes  draft.md']));
  const header = container.querySelector('header span')!;
  expect(header.textContent).toContain('notes  draft.md');
  expect(header.getAttribute('title')).toContain('notes  draft.md');
});
