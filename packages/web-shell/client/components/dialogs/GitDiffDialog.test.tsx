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
const { workspaceGitDiff, workspaceGitDiffFile, workspaceClient, shikiState } =
  vi.hoisted(() => {
    const workspaceGitDiff = vi.fn();
    const workspaceGitDiffFile = vi.fn();
    const workspaceClient = {
      workspaceByCwd: () => ({ workspaceGitDiff, workspaceGitDiffFile }),
    };
    // Per-test switch for the highlighter path: `resolvedLang` steers whether
    // buildRows even asks for a highlighter ('text' skips it), `highlighter`
    // (when set) makes getCodeHighlighter resolve instead of reject.
    const shikiState = {
      resolvedLang: 'text',
      highlighter: null as {
        codeToTokens: (
          code: string,
          opts: { lang: string; theme: string },
        ) => { tokens: Array<Array<{ content: string; color?: string }>> };
      } | null,
    };
    return {
      workspaceGitDiff,
      workspaceGitDiffFile,
      workspaceClient,
      shikiState,
    };
  });

vi.mock('@qwen-code/webui/daemon-react-sdk', () => ({
  useWorkspace: () => ({ client: workspaceClient }),
}));

// Shiki's WASM engine isn't available under jsdom; by default the stub rejects
// so buildRows takes the plain-text path. A test can install a fake
// highlighter via `shikiState` to exercise the token-interleaving success path.
vi.mock('../messages/codeHighlighter', () => ({
  getCodeHighlighter: vi.fn(() =>
    shikiState.highlighter
      ? Promise.resolve(shikiState.highlighter)
      : Promise.reject(new Error('no shiki in tests')),
  ),
  isTooLargeToHighlight: () => false,
}));

vi.mock('../messages/Markdown', () => ({
  resolveFenceLanguage: (lang: string) => ({
    label: lang,
    lang,
    resolvedLang: shikiState.resolvedLang,
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
  shikiState.resolvedLang = 'text';
  shikiState.highlighter = null;
});

function diffPayload(
  overrides: Partial<{
    available: boolean;
    files: Array<Record<string, unknown>>;
    hiddenCount: number;
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
    hiddenCount: overrides.hiddenCount ?? 0,
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

  it('shows a truncation note when more files are hidden', async () => {
    workspaceGitDiff.mockResolvedValue(diffPayload({ hiddenCount: 3 }));
    mount();
    await flush();

    expect(document.body.textContent).toContain('3 more file(s) not shown');
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

  it('shows an error placeholder when the diff list fails to load', async () => {
    workspaceGitDiff.mockRejectedValue(new Error('network down'));
    mount();
    await flush();

    expect(document.body.textContent).toContain('Failed to load changes');
  });

  it('shows a per-file error when a file diff fails to load', async () => {
    workspaceGitDiff.mockResolvedValue(diffPayload());
    workspaceGitDiffFile.mockRejectedValue(new Error('file fetch failed'));
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
    expect(document.body.textContent).toContain('Failed to load this diff');
  });

  it('labels a capped file diff as truncated', async () => {
    workspaceGitDiff.mockResolvedValue(diffPayload());
    workspaceGitDiffFile.mockResolvedValue({
      v: 1,
      workspaceCwd: '/repo',
      path: 'src/a.ts',
      available: true,
      hunks: [
        {
          oldStart: 0,
          oldLines: 0,
          newStart: 1,
          newLines: 1,
          lines: ['+the visible head of a capped file'],
        },
      ],
      truncated: true,
    });
    mount();
    await flush();

    const header = document.body.querySelector(
      'button[aria-expanded="false"]',
    ) as HTMLButtonElement;
    await act(async () => {
      header.click();
    });
    await flush();

    expect(document.body.textContent).toContain('Diff truncated');
    // The visible window still renders above the note.
    expect(document.body.textContent).toContain('visible head');
  });

  it('shows the per-file error when row building rejects on malformed hunks', async () => {
    workspaceGitDiff.mockResolvedValue(diffPayload());
    workspaceGitDiffFile.mockResolvedValue({
      v: 1,
      workspaceCwd: '/repo',
      path: 'src/a.ts',
      available: true,
      // `lines: null` makes buildRows throw while iterating — the shape a
      // buggy daemon could emit. Without the .catch this is an unhandled
      // rejection and the diff area silently stays empty.
      hunks: [
        { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: null },
      ],
    });
    mount();
    await flush();

    const header = document.body.querySelector(
      'button[aria-expanded="false"]',
    ) as HTMLButtonElement;
    await act(async () => {
      header.click();
    });
    await flush();

    expect(document.body.textContent).toContain('Failed to load this diff');
  });

  it('renders Shiki tokens per side when highlighting succeeds', async () => {
    // Steer buildRows onto the highlighter path with a fake tokenizer that
    // emits one colored token per line, so the add row pulls from the new-side
    // tokens and the del row from the old-side tokens.
    shikiState.resolvedLang = 'ts';
    shikiState.highlighter = {
      codeToTokens: (code: string) => ({
        tokens: code
          .split('\n')
          .map((line) => [{ content: line, color: '#ff0000' }]),
      }),
    };
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
          newLines: 1,
          lines: ['-const a = 1', '+const a = 2'],
        },
      ],
    });
    mount();
    await flush();

    const header = document.body.querySelector(
      'button[aria-expanded="false"]',
    ) as HTMLButtonElement;
    await act(async () => {
      header.click();
    });
    await flush();

    const colored = Array.from(
      document.body.querySelectorAll('span[style]'),
    ).filter((el) => (el as HTMLElement).style.color !== '');
    const texts = colored.map((el) => el.textContent);
    // Both sides tokenized: the del row from the old side, the add row from
    // the new side — not the plain-text fallback.
    expect(texts).toContain('const a = 1');
    expect(texts).toContain('const a = 2');
  });
});
