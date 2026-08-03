// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '../../i18n';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

// A STABLE client object: the dialog's fetch effect depends on `client`, so a
// fresh object per render (as a naive mock returns) would re-fire it in a loop.
const {
  workspaceGitDiff,
  workspaceGitDiffFile,
  workspaceGitLog,
  workspaceGitBranches,
  workspaceClient,
  shikiState,
} = vi.hoisted(() => {
  const workspaceGitDiff = vi.fn();
  const workspaceGitDiffFile = vi.fn();
  const workspaceGitLog = vi.fn();
  const workspaceGitBranches = vi.fn();
  const workspaceClient = {
    workspaceByCwd: () => ({
      workspaceGitDiff,
      workspaceGitDiffFile,
      workspaceGitLog,
      workspaceGitBranches,
    }),
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
    workspaceGitLog,
    workspaceGitBranches,
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

const { GitDiffDialog, GitDiffContent } = await import('./GitDiffDialog');

let container: HTMLDivElement;
let root: Root;

function mount(workspaceCwd = '/repo', strict = false) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const dialog = (
    <I18nProvider language="en">
      <GitDiffDialog workspaceCwd={workspaceCwd} onClose={vi.fn()} />
    </I18nProvider>
  );
  act(() => {
    root.render(strict ? <StrictMode>{dialog}</StrictMode> : dialog);
  });
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function typeInput(input: HTMLInputElement, value: string) {
  const nativeSetter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )?.set;
  nativeSetter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
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
    filesCount: number;
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
    filesCount: overrides.filesCount ?? files.length,
    linesAdded: 2,
    linesRemoved: 1,
    files,
    hiddenCount: overrides.hiddenCount ?? 0,
  };
}

describe('GitDiffDialog', () => {
  it('switches between uncommitted, unstaged, and staged sources', async () => {
    workspaceGitDiff.mockResolvedValue(diffPayload());
    mount();
    await flush();

    const source = document.body.querySelector(
      '#git-diff-source',
    ) as HTMLSelectElement;
    await act(async () => {
      source.value = 'unstaged';
      source.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();
    expect(workspaceGitDiff).toHaveBeenLastCalledWith(undefined, {
      mode: 'unstaged',
    });

    await act(async () => {
      source.value = 'staged';
      source.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();
    expect(workspaceGitDiff).toHaveBeenLastCalledWith(undefined, {
      mode: 'staged',
    });
  });

  it('loads commit and branch choices and forwards the selected ref', async () => {
    workspaceGitDiff.mockResolvedValue(diffPayload());
    workspaceGitLog.mockResolvedValue({
      available: true,
      entries: [
        {
          sha: 'abcdef1234567890',
          shortSha: 'abcdef1',
          subject: 'selected commit',
        },
        {
          sha: '1234567890abcdef',
          shortSha: '1234567',
          subject: 'search target',
        },
      ],
      hasMore: false,
    });
    workspaceGitBranches.mockResolvedValue({
      head: 'current-branch',
      local: [
        { name: 'main', isHead: true },
        { name: 'topic', isHead: false },
      ],
      remote: [
        { name: 'origin/main', isHead: false },
        { name: 'origin/search-target', isHead: false },
      ],
      tags: [],
    });
    mount();
    await flush();

    const source = document.body.querySelector(
      '#git-diff-source',
    ) as HTMLSelectElement;
    await act(async () => {
      source.value = 'commit';
      source.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();
    expect(workspaceGitLog).toHaveBeenCalledWith(200, 0, undefined);
    expect(workspaceGitDiff).toHaveBeenLastCalledWith(undefined, {
      mode: 'commit',
      ref: 'abcdef1234567890',
    });

    const commitTrigger = document.body.querySelector(
      'button[aria-label="Select commit"]',
    ) as HTMLButtonElement;
    await act(async () => {
      commitTrigger.click();
    });
    await flush();
    const commitSearch = document.body.querySelector(
      'input[aria-label="Search commits…"]',
    ) as HTMLInputElement;
    const commitList = document.body.querySelector(
      '[role="listbox"][aria-label="Select commit"]',
    ) as HTMLDivElement;
    const bubbledWheel = vi.fn();
    document.body.addEventListener('wheel', bubbledWheel);
    await act(async () => {
      commitList.dispatchEvent(
        new WheelEvent('wheel', { bubbles: true, deltaY: 100 }),
      );
    });
    document.body.removeEventListener('wheel', bubbledWheel);
    expect(bubbledWheel).not.toHaveBeenCalled();
    await act(async () => {
      typeInput(commitSearch, 'target');
    });
    await flush();
    const commitOptions = document.body.querySelectorAll('[role="option"]');
    expect(commitOptions).toHaveLength(1);
    expect(commitOptions[0]?.textContent).toContain('search target');
    await act(async () => {
      (commitOptions[0] as HTMLButtonElement).click();
    });
    await flush();
    expect(workspaceGitDiff).toHaveBeenLastCalledWith(undefined, {
      mode: 'commit',
      ref: '1234567890abcdef',
    });

    await act(async () => {
      source.value = 'branch';
      source.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();
    expect(workspaceGitBranches).toHaveBeenCalledWith(undefined);
    expect(workspaceGitDiff).toHaveBeenLastCalledWith(undefined, {
      mode: 'branch',
      ref: 'topic',
    });

    const branchTrigger = document.body.querySelector(
      'button[aria-label="Select branch"]',
    ) as HTMLButtonElement;
    expect(branchTrigger.textContent).toContain('current-branch');
    expect(branchTrigger.textContent).toContain('topic');
    await act(async () => {
      branchTrigger.click();
    });
    await flush();
    expect(
      Array.from(document.body.querySelectorAll('[role="option"]')).map(
        (option) => option.textContent,
      ),
    ).not.toContain('main');
    const branchSearch = document.body.querySelector(
      'input[aria-label="Search branches…"]',
    ) as HTMLInputElement;
    await act(async () => {
      typeInput(branchSearch, 'origin/search');
    });
    await flush();
    const branchOptions = document.body.querySelectorAll('[role="option"]');
    expect(branchOptions).toHaveLength(1);
    await act(async () => {
      (branchOptions[0] as HTMLButtonElement).click();
    });
    await flush();
    expect(workspaceGitDiff).toHaveBeenLastCalledWith(undefined, {
      mode: 'branch',
      ref: 'origin/search-target',
    });

    workspaceGitDiffFile.mockResolvedValue({ hunks: [], truncated: false });
    const header = document.body.querySelector(
      'button[aria-label^="Show changes for"]',
    ) as HTMLButtonElement;
    await act(async () => {
      header.click();
    });
    await flush();
    expect(workspaceGitDiffFile).toHaveBeenLastCalledWith(
      'src/a.ts',
      undefined,
      undefined,
      { mode: 'branch', ref: 'origin/search-target' },
    );
  });

  it('resets the selected source when the workspace changes', async () => {
    workspaceGitDiff.mockResolvedValue(diffPayload());
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(
        <I18nProvider language="en">
          <GitDiffContent workspaceCwd="/repo-a" />
        </I18nProvider>,
      );
    });
    await flush();

    const source = document.body.querySelector(
      '#git-diff-source',
    ) as HTMLSelectElement;
    await act(async () => {
      source.value = 'staged';
      source.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();

    act(() => {
      root.render(
        <I18nProvider language="en">
          <GitDiffContent workspaceCwd="/repo-b" />
        </I18nProvider>,
      );
    });
    await flush();

    expect(source.value).toBe('uncommitted');
    expect(workspaceGitDiff).toHaveBeenLastCalledWith(undefined);
  });

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

    expect(workspaceGitDiffFile).toHaveBeenCalledWith(
      'src/a.ts',
      undefined,
      undefined,
    );
    // Plain-text fallback: the line bodies render without the +/- prefix
    // (the marker is a separate column).
    expect(document.body.textContent).toContain('const a = 2');
    expect(document.body.textContent).toContain('const b = 3');
    expect(document.body.textContent).toContain('const a = 1');
  });

  it('still loads a file diff under StrictMode (cancelled flag resets on remount)', async () => {
    // StrictMode replays mount→unmount→mount and a ref persists across the
    // replay, so the row's cancelled flag must reset on mount — otherwise the
    // fetched hunks are dropped and the row sticks on "Loading changes…".
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
    mount('/repo', true);
    await flush();

    const header = document.body.querySelector(
      'button[aria-expanded="false"]',
    ) as HTMLButtonElement;
    expect(header).not.toBeNull();
    await act(async () => {
      header.click();
    });
    await flush();

    expect(document.body.textContent).toContain('const a = 2');
    expect(document.body.textContent).not.toContain('Loading changes…');
  });

  it('forwards the pre-rename oldPath when expanding a renamed file', async () => {
    workspaceGitDiff.mockResolvedValue(
      diffPayload({
        files: [
          {
            path: 'src/new.ts',
            oldPath: 'src/old.ts',
            added: 1,
            removed: 1,
            isBinary: false,
            isUntracked: false,
            isDeleted: false,
            truncated: false,
          },
        ],
      }),
    );
    workspaceGitDiffFile.mockResolvedValue({
      v: 1,
      workspaceCwd: '/repo',
      path: 'src/new.ts',
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
    expect(header).not.toBeNull();
    await act(async () => {
      header.click();
    });
    await flush();

    // The pre-rename path is forwarded so the daemon diffs old→new (rename
    // detection) instead of showing the new path as fully added.
    expect(workspaceGitDiffFile).toHaveBeenCalledWith(
      'src/new.ts',
      'src/old.ts',
      undefined,
    );
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

  it('shows the hidden-file count when the detail cap omits every file', async () => {
    workspaceGitDiff.mockResolvedValue(
      diffPayload({ files: [], filesCount: 7277, hiddenCount: 7277 }),
    );
    mount();
    await flush();

    expect(document.body.textContent).not.toContain('No changes');
    expect(document.body.textContent).toContain('7277 more file(s) not shown');
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

    expect(workspaceGitDiffFile).toHaveBeenCalledWith(
      'src/a.ts',
      undefined,
      undefined,
    );
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
    expect(header).not.toBeNull();
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
    expect(header).not.toBeNull();
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
    expect(header).not.toBeNull();
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

  it('forwards gitCwd to the diff list and file SDK calls', async () => {
    workspaceGitDiff.mockResolvedValue(
      diffPayload({
        files: [
          {
            path: 'src/a.ts',
            added: 1,
            removed: 0,
            isBinary: false,
            isUntracked: false,
            isDeleted: false,
            truncated: false,
          },
        ],
      }),
    );
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
          lines: ['-old', '+new'],
        },
      ],
    });

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(
        <I18nProvider language="en">
          <GitDiffContent workspaceCwd="/repo" gitCwd="/worktrees/wt" />
        </I18nProvider>,
      );
    });
    await flush();

    expect(workspaceGitDiff).toHaveBeenCalledWith('/worktrees/wt');

    const header = document.body.querySelector(
      'button[aria-expanded="false"]',
    ) as HTMLButtonElement;
    expect(header).not.toBeNull();
    await act(async () => {
      header.click();
    });
    await flush();

    expect(workspaceGitDiffFile).toHaveBeenCalledWith(
      'src/a.ts',
      undefined,
      '/worktrees/wt',
    );
  });
});
