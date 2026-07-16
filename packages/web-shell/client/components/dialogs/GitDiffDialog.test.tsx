// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '../../i18n';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

// A STABLE client object: the dialog's fetch effect depends on `client`, so a
// fresh object per render (as a naive mock returns) would re-fire it in a loop.
const { workspaceGitDiff, workspaceGitDiffFile, workspaceClient } = vi.hoisted(
  () => {
    const workspaceGitDiff = vi.fn();
    const workspaceGitDiffFile = vi.fn();
    const workspaceClient = {
      workspaceByCwd: () => ({ workspaceGitDiff, workspaceGitDiffFile }),
    };
    return { workspaceGitDiff, workspaceGitDiffFile, workspaceClient };
  },
);

vi.mock('@qwen-code/webui/daemon-react-sdk', () => ({
  useWorkspace: () => ({ client: workspaceClient }),
}));

// Shiki's WASM engine isn't available under jsdom; the dialog must degrade to
// plain text. Stub the highlighter so buildRows takes the plain-text path.
vi.mock('../messages/codeHighlighter', () => ({
  getCodeHighlighter: vi.fn().mockRejectedValue(new Error('no shiki in tests')),
  isTooLargeToHighlight: () => false,
}));

vi.mock('../messages/Markdown', () => ({
  resolveFenceLanguage: (lang: string) => ({
    label: lang,
    lang,
    resolvedLang: 'text',
  }),
}));

vi.mock('../messages/ToolGroup', () => ({
  languageForPath: () => 'text',
}));

const { GitDiffDialog } = await import('./GitDiffDialog');

let container: HTMLDivElement;
let root: Root;

function mount(workspaceCwd = '/repo') {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <I18nProvider language="en">
        <GitDiffDialog workspaceCwd={workspaceCwd} onClose={vi.fn()} />
      </I18nProvider>,
    );
  });
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

function diffPayload(
  overrides: Partial<{
    available: boolean;
    files: Array<Record<string, unknown>>;
  }> = {},
) {
  const files = overrides.files ?? [
    {
      path: 'src/a.ts',
      added: 2,
      removed: 1,
      isBinary: false,
      isUntracked: false,
      isDeleted: false,
      truncated: false,
    },
  ];
  return {
    v: 1 as const,
    workspaceCwd: '/repo',
    available: overrides.available ?? true,
    filesCount: files.length,
    linesAdded: 2,
    linesRemoved: 1,
    files,
    hiddenCount: 0,
  };
}

describe('GitDiffDialog', () => {
  it('renders the changed file list with stats', async () => {
    workspaceGitDiff.mockResolvedValue(diffPayload());
    mount();
    await flush();

    expect(workspaceGitDiff).toHaveBeenCalled();
    expect(document.body.textContent).toContain('src/a.ts');
    expect(document.body.textContent).toContain('+2');
    expect(document.body.textContent).toContain('-1');
  });

  it('loads and renders a file diff when expanded', async () => {
    workspaceGitDiff.mockResolvedValue(diffPayload());
    workspaceGitDiffFile.mockResolvedValue({
      v: 1,
      workspaceCwd: '/repo',
      path: 'src/a.ts',
      available: true,
      hunks: [
        {
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 2,
          lines: ['-const a = 1', '+const a = 2', '+const b = 3'],
        },
      ],
    });
    mount();
    await flush();

    const header = document.body.querySelector(
      'button[aria-expanded="false"]',
    ) as HTMLButtonElement;
    expect(header).not.toBeNull();
    await act(async () => {
      header.click();
    });
    await flush();

    expect(workspaceGitDiffFile).toHaveBeenCalledWith('src/a.ts');
    // Plain-text fallback: the line bodies render without the +/- prefix
    // (the marker is a separate column).
    expect(document.body.textContent).toContain('const a = 2');
    expect(document.body.textContent).toContain('const b = 3');
    expect(document.body.textContent).toContain('const a = 1');
  });

  it('shows a placeholder when git is unavailable', async () => {
    workspaceGitDiff.mockResolvedValue(
      diffPayload({ available: false, files: [] }),
    );
    mount();
    await flush();

    expect(document.body.textContent).toContain('Git is not available');
  });

  it('shows an empty placeholder for a clean working tree', async () => {
    workspaceGitDiff.mockResolvedValue(diffPayload({ files: [] }));
    mount();
    await flush();

    expect(document.body.textContent).toContain('No changes');
  });

  it('marks untracked and binary files in the list', async () => {
    workspaceGitDiff.mockResolvedValue(
      diffPayload({
        files: [
          {
            path: 'new.txt',
            added: 1,
            removed: 0,
            isBinary: false,
            isUntracked: true,
            isDeleted: false,
            truncated: false,
          },
          {
            path: 'logo.png',
            isBinary: true,
            isUntracked: false,
            isDeleted: false,
            truncated: false,
          },
        ],
      }),
    );
    mount();
    await flush();

    expect(document.body.textContent).toContain('Untracked');
    expect(document.body.textContent).toContain('Binary');
  });
});
