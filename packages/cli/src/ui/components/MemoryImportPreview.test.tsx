/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { render } from 'ink-testing-library';
import { useApp } from 'ink';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import stripAnsi from 'strip-ansi';
import type { LoadedSettings } from '../../config/settings.js';
import type {
  ImportEntry,
  ImportPreview,
} from '../../commands/memory/codex-import.js';
import { SettingsContext } from '../contexts/SettingsContext.js';
import { KeypressProvider } from '../contexts/KeypressContext.js';
import { renderMermaidImageAsync } from '../utils/mermaidImageRenderer.js';
import { MemoryImportPreview } from './MemoryImportPreview.js';

const terminal = vi.hoisted(() => ({ columns: 80, rows: 28 }));
vi.mock('../hooks/useTerminalSize.js', () => ({
  useTerminalSize: () => terminal,
}));
vi.mock('../utils/mermaidImageRenderer.js', () => ({
  renderMermaidImageAsync: vi.fn(),
}));

const entry = (overrides: Partial<ImportEntry> = {}): ImportEntry => ({
  id: 'alpha',
  name: 'Atlas release verification',
  type: 'project',
  content: 'Check the synthetic release dashboard.',
  sourceFile: 'MEMORY.md',
  sourceLine: 12,
  sourceProject: '/source/atlas',
  targetRoot: '/private/atlas',
  status: 'ready',
  scope: 'project',
  updatedAt: '2025-04-01T10:00:00Z',
  ...overrides,
});
const fixture = (): ImportPreview => ({
  dryRun: true,
  sourceDigest: 'synthetic-source-digest',
  entries: [
    entry({
      id: 'user',
      name: 'Concise replies',
      sourceFile: 'memory_summary.md',
      scope: 'user',
      sourceProject: undefined,
      targetRoot: '/private/global',
      type: 'feedback',
    }),
    entry(),
    entry({
      id: 'conflict',
      name: 'Old release instructions',
      status: 'conflict',
      reason: 'A newer target already exists.',
      content: 'An obsolete synthetic release procedure.',
    }),
    entry({
      id: 'twin',
      name: 'Equivalent release guidance',
      status: 'duplicate',
      sourceProject: '/another/source/atlas',
    }),
    entry({
      id: 'missing',
      name: 'Missing project',
      sourceProject: '/missing/project',
      targetRoot: undefined,
      status: 'blocked',
      reason: 'The project directory is unavailable.',
    }),
  ],
  reviewNotes: [
    {
      path: 'extensions/ad_hoc/notes/synthetic.md',
      content: 'Verify this synthetic correction before selecting entries.',
    },
  ],
  warnings: ['Some historical guidance may be outdated.'],
});

const mounted: Array<ReturnType<typeof render>> = [];
function setup(
  preview = fixture(),
  initialSelectedIds: string[] | undefined = undefined,
  onOpen = vi
    .fn<(text: string) => Promise<void>>()
    .mockResolvedValue(undefined),
  canImport = false,
) {
  const onFinish = vi.fn();
  let flush!: () => Promise<void>;
  function FrameSync() {
    flush = useApp().waitUntilRenderFlush;
    return null;
  }
  const settings = { merged: { ui: {} } } as unknown as LoadedSettings;
  const tree = (
    <SettingsContext.Provider value={settings}>
      <KeypressProvider kittyProtocolEnabled={false}>
        <FrameSync />
        <MemoryImportPreview
          preview={preview}
          initialSelectedIds={initialSelectedIds}
          canImport={canImport}
          onFinish={onFinish}
          onOpen={onOpen}
        />
      </KeypressProvider>
    </SettingsContext.Provider>
  );
  const result = render(tree);
  mounted.push(result);
  const frame = () => stripAnsi(result.lastFrame() ?? '');
  const write = async (input: string) => {
    // Visible output can precede the new list's passive input subscription.
    await flush();
    await act(async () => result.stdin.write(input));
    await flush();
  };
  const press = async (input: string, expected: string) => {
    await write(input);
    await vi.waitFor(() => expect(frame()).toContain(expected));
  };
  return { ...result, frame, press, write, onFinish, onOpen, tree };
}

beforeEach(() => {
  terminal.columns = 80;
  terminal.rows = 28;
  vi.clearAllMocks();
});
afterEach(() => {
  for (const result of mounted) result.unmount();
  mounted.length = 0;
  vi.unstubAllEnvs();
});

describe('MemoryImportPreview', () => {
  it('groups canonical destinations while keeping user scope and review material distinct', () => {
    const preview = fixture();
    preview.entries[0].targetRoot = '/private/atlas';
    const ui = setup(preview, ['alpha', 'conflict', 'unknown']);
    expect(ui.frame()).toContain('User memory (1)');
    expect(ui.frame()).toContain('Project memory: /source/atlas (3)');
    expect(ui.frame()).toContain('Project memory: /missing/project (1)');
    expect(ui.frame()).toContain('Source notes & warnings (2)');
    expect(ui.frame()).toContain(
      '5 candidates · 1 selected · 1 notes · 1 warnings',
    );
    expect(ui.frame()).toContain('ready 2 · duplicate 1 · conflict 1');
    expect(ui.frame()).toContain(
      'blocked 1 · global fallback 0 · previously imported 0',
    );
    expect(ui.onFinish).not.toHaveBeenCalled();
  });

  it.each(['ready', 'duplicate', 'conflict'] as const)(
    'marks global fallback throughout %s review and selects only eligible entries',
    async (status) => {
      const reason = 'The original project is unavailable.';
      const ui = setup({
        ...fixture(),
        reviewNotes: [],
        warnings: [],
        entries: [
          entry({
            scope: 'user',
            scopeReason: reason,
            sourceProject: '/missing/atlas',
            targetRoot: '/private/global',
            status,
            reason: status === 'ready' ? undefined : 'Existing native memory.',
          }),
        ],
      });
      expect(ui.frame()).toContain('User memory (global fallback) (1)');
      expect(ui.frame()).toContain(`${status === 'conflict' ? 0 : 1} selected`);
      expect(ui.frame()).toContain('global fallback 1');
      await ui.press(
        '\r',
        `${status}: [global fallback] Atlas release verification`,
      );
      await ui.press('\r', 'Scope: User memory (global fallback)');
      await ui.write('o');
      await vi.waitFor(() =>
        expect(ui.onOpen).toHaveBeenCalledWith(
          expect.stringContaining(`Global fallback: ${reason}`),
        ),
      );
      const fullText = ui.onOpen.mock.calls[0][0];
      expect(fullText).toContain('Source project: /missing/atlas');
      expect(fullText).toContain('Destination: /private/global');
      if (status !== 'ready')
        expect(fullText).toContain('Reason: Existing native memory.');
      expect(ui.onFinish).not.toHaveBeenCalled();
      expect(ui.frame()).toContain(`${status === 'conflict' ? 0 : 1} selected`);
    },
  );

  it('defaults to all eligible candidates and supports all, none, and group toggles', async () => {
    const preview = fixture();
    preview.entries.push(
      entry({ id: 'handled', status: 'previously-imported' }),
    );
    const ui = setup(preview);
    expect(ui.frame()).toContain('3 selected');
    expect(ui.frame()).toContain('[1/1 selected] User memory (1)');
    await ui.press(' ', '2 selected');
    await ui.press(
      '\u001b[B',
      '› [2/2 selected] Project memory: /source/atlas',
    );
    await ui.press(' ', '0 selected');
    await ui.press('a', '3 selected');
    await ui.press('n', '0 selected');
    await ui.press(' ', '2 selected');
    await ui.write('d');
    await vi.waitFor(() =>
      expect(ui.onFinish).toHaveBeenCalledWith({
        action: 'preview',
        selectedIds: ['alpha', 'twin'],
      }),
    );
  });

  it('requires a separate confirmation and acknowledges source notes before importing', async () => {
    const preview = fixture();
    preview.entries.push(
      entry({
        id: 'global',
        scope: 'user',
        scopeReason: 'Shared scope.',
        targetRoot: '/private/global',
      }),
    );
    const ui = setup(preview, undefined, undefined, true);
    expect(ui.frame()).toContain('i Start import (4 selected)');
    await ui.press('i', 'Import 4 selected candidates?');
    expect(ui.frame()).toContain('Project: 2 · User: 2');
    expect(ui.frame()).toContain('Global fallbacks: 1');
    expect(ui.frame()).toContain('Review 1 source notes');
    expect(ui.frame()).toContain('› Back to review');
    await ui.press('\r', 'i Start import (4 selected)');
    expect(ui.onFinish).not.toHaveBeenCalled();
    await ui.press('d', 'Import 4 selected candidates?');
    await ui.press('\u001b[A', '› Notes reviewed: import 4');
    await ui.write('\r');
    await vi.waitFor(() =>
      expect(ui.onFinish).toHaveBeenCalledWith({
        action: 'import',
        selectedIds: ['user', 'alpha', 'twin', 'global'],
      }),
    );
  });

  it('blocks empty imports and supports returning from confirmation or cancelling', async () => {
    const ui = setup(fixture(), undefined, undefined, true);
    await ui.press('n', '0 selected');
    await ui.press('i', 'Select at least one candidate');
    expect(ui.onFinish).not.toHaveBeenCalled();
    await ui.press('a', '3 selected');
    await ui.press('i', 'Import 3 selected candidates?');
    await ui.press('\u001b', 'i Start import (3 selected)');
    await ui.press('i', 'Import 3 selected candidates?');
    await ui.write('\u0003');
    await vi.waitFor(() => expect(ui.onFinish).toHaveBeenCalledWith(undefined));
  });

  it('keeps dry-run read-only even with all candidates selected', async () => {
    const ui = setup();
    expect(ui.frame()).toContain('dry run (no writes)');
    await ui.press('i', 'Dry run: remove --dry-run to import.');
    expect(ui.frame()).not.toContain('Import 3 selected candidates?');
    expect(ui.onFinish).not.toHaveBeenCalled();
    await ui.write('d');
    await vi.waitFor(() =>
      expect(ui.onFinish).toHaveBeenCalledWith({
        action: 'preview',
        selectedIds: ['user', 'alpha', 'twin'],
      }),
    );
  });

  it('labels merged worktree entries with the main project and preserves source provenance in full text', async () => {
    const ui = setup({
      ...fixture(),
      reviewNotes: [],
      warnings: [],
      entries: [
        entry({
          sourceProject: '/work/atlas-one',
          resolvedProject: '/main/atlas',
        }),
        entry({
          id: 'beta',
          sourceProject: '/work/atlas-two',
          resolvedProject: '/main/atlas',
        }),
      ],
    });
    expect(ui.frame()).toContain('Project memory: /main/atlas (2)');
    expect(ui.frame()).not.toContain('Project memory: /work/');
    await ui.press('\r', '[x] ready: Atlas release verification');
    await ui.press('\r', 'Source project: /work/atlas-one');
    expect(ui.frame()).toContain('Resolved project: /main/atlas');
    await ui.write('o');
    await vi.waitFor(() =>
      expect(ui.onOpen).toHaveBeenCalledWith(
        expect.stringContaining(
          'Source project: /work/atlas-one\nResolved project: /main/atlas',
        ),
      ),
    );
  });

  it('keeps selection and row highlight across details and groups, then returns IDs without applying', async () => {
    const preview = fixture();
    const before = JSON.stringify(preview);
    const ui = setup(preview, []);
    await ui.press(
      '\u001b[B',
      '› [0/2 selected] Project memory: /source/atlas',
    );
    await ui.press('\r', '[ ] ready: Atlas release verification');
    await ui.press(' ', '1 selected');
    await ui.press('\u001b[B', '› [-] conflict: Old release instructions');
    await ui.press('\u001b[B', '› [ ] duplicate: Equivalent release guidance');
    await ui.press(' ', '2 selected');
    await ui.press('\r', 'ID: twin');
    await ui.press('\u001b', '› [x] duplicate: Equivalent release guidance');
    await ui.press('\u001b', 'Choose a memory group');
    await ui.press('\u001b[A', '› [0/1 selected] User memory');
    await ui.press('\r', '[ ] ready: Concise replies');
    await ui.press(' ', '3 selected');
    await ui.write('d');
    await vi.waitFor(() =>
      expect(ui.onFinish).toHaveBeenCalledWith({
        action: 'preview',
        selectedIds: ['user', 'alpha', 'twin'],
      }),
    );
    expect(JSON.stringify(preview)).toBe(before);
    expect(ui.onOpen).not.toHaveBeenCalled();
  });

  it('lets ineligible candidates be inspected but never checked', async () => {
    const ui = setup(fixture(), []);
    await ui.press(
      '\u001b[B',
      '› [0/2 selected] Project memory: /source/atlas',
    );
    await ui.press('\r', '[ ] ready: Atlas release verification');
    await ui.press('\u001b[B', '› [-] conflict: Old release instructions');
    await ui.press('\r', 'ID: conflict');
    expect(ui.frame()).toContain('A newer target already exists.');
    await ui.press(' ', 'Cannot select conflict');
    expect(ui.frame()).toContain('0 selected');
    await ui.write('d');
    await vi.waitFor(() =>
      expect(ui.onFinish).toHaveBeenCalledWith({
        action: 'preview',
        selectedIds: [],
      }),
    );
  });

  it('opens the complete sanitized candidate with provenance beyond the bounded preview', async () => {
    const preview = fixture();
    preview.entries = [
      entry({
        name: 'Unsafe\u001b[31m\u202etitle',
        sourceProject: '/source/\u200batlas',
        targetRoot: '/private/atlas\nspoofed',
        content:
          Array.from({ length: 90 }, (_, index) => `Body line ${index}`).join(
            '\n',
          ) + '\nLAST_LINE\u0007\u009b\u202e\u2066\u200d',
      }),
    ];
    const ui = setup(preview);
    await ui.press('\r', 'ready: Unsafe');
    await ui.press('\r', 'ID: alpha');
    expect(ui.frame()).not.toContain('LAST_LINE');
    expect(ui.frame().split('\n').length).toBeLessThanOrEqual(terminal.rows);
    await ui.write('o');
    await vi.waitFor(() => expect(ui.onOpen).toHaveBeenCalledOnce());
    const text = ui.onOpen.mock.calls[0][0];
    expect(text).toContain('LAST_LINE');
    expect(text).toContain('Source: MEMORY.md:12');
    expect(text).toContain('Source date: 2025-04-01T10:00:00Z');
    expect(text).toContain('Source digest: synthetic-source-digest');
    expect(text).toContain('/private/atlas\\nspoofed');
    expect(text).toContain('\\u202e');
    expect(text).toContain('\\u{200b}');
    for (const control of '\u0007\u001b\u009b\u202e\u2066\u200d') {
      expect(text).not.toContain(control);
    }
  });

  it('makes complete notes and warnings available without enabling external Markdown rendering', async () => {
    vi.stubEnv('QWEN_CODE_MERMAID_IMAGE_RENDERING', '1');
    const preview = fixture();
    preview.entries = [];
    preview.reviewNotes[0].content =
      '```mermaid\ngraph TD; A-->B\n```\nKeep the original source unchanged.';
    const ui = setup(preview);
    await ui.press('\r', 'Source note: extensions/ad_hoc/notes/synthetic.md');
    await ui.press('\r', 'graph TD; A-->B');
    await ui.write('o');
    await vi.waitFor(() => expect(ui.onOpen).toHaveBeenCalledOnce());
    expect(ui.onOpen.mock.calls[0][0]).toContain(
      'Keep the original source unchanged.',
    );
    expect(renderMermaidImageAsync).not.toHaveBeenCalled();
    await ui.press(
      '\u001b',
      'Source note: extensions/ad_hoc/notes/synthetic.md',
    );
    await ui.press('\u001b[B', '› Warning 1: Some historical guidance');
    await ui.press('\r', 'Some historical guidance may be outdated.');
    await ui.write('o');
    await vi.waitFor(() => expect(ui.onOpen).toHaveBeenCalledTimes(2));
    expect(ui.onOpen.mock.calls[1][0]).toContain(
      'Some historical guidance may be outdated.',
    );
    await ui.write('d');
    await vi.waitFor(() =>
      expect(ui.onFinish).toHaveBeenCalledWith({
        action: 'preview',
        selectedIds: [],
      }),
    );
  });

  it('keeps selection aligned when navigation races opening full text', async () => {
    let release!: () => void;
    const onOpen = vi.fn<(text: string) => Promise<void>>().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const ui = setup(
      {
        ...fixture(),
        reviewNotes: [],
        warnings: [],
        entries: [
          entry({ id: 'alpha', name: 'Synthetic Alpha' }),
          entry({ id: 'beta', name: 'Synthetic Beta' }),
        ],
      },
      undefined,
      onOpen,
    );
    await ui.press('\r', '› [x] ready: Synthetic Alpha');
    await ui.write('o\u001b[B');
    await vi.waitFor(() => expect(onOpen).toHaveBeenCalledOnce());
    release();
    await ui.write('');
    await vi.waitFor(() =>
      expect(ui.frame()).not.toContain('Opening full text'),
    );
    expect(ui.frame()).toContain('› [x] ready: Synthetic Beta');
    await ui.write(' ');
    expect(ui.frame()).toContain('› [ ] ready: Synthetic Beta');
    await ui.write('d');
    await vi.waitFor(() =>
      expect(ui.onFinish).toHaveBeenCalledWith({
        action: 'preview',
        selectedIds: ['alpha'],
      }),
    );
  });

  it('blocks navigation and finish during opening, then recovers from a sanitized failure', async () => {
    let reject!: (error: Error) => void;
    const onOpen = vi.fn<(text: string) => Promise<void>>().mockImplementation(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    );
    const ui = setup(fixture(), ['user'], onOpen);
    await ui.press('\r', '[x] ready: Concise replies');
    await ui.press('o', 'Opening full text');
    await ui.write('d\u001b\u0003\u001b[B');
    expect(ui.onFinish).not.toHaveBeenCalled();
    reject(new Error('Editor failed\u001b[2J\u202e'));
    await vi.waitFor(() => expect(ui.frame()).toContain('Editor failed'));
    expect(ui.frame()).toContain('1 selected');
    expect(ui.frame()).not.toContain('\u202e');
    expect(ui.onFinish).not.toHaveBeenCalled();
    await ui.write('\u0003');
    await vi.waitFor(() => expect(ui.onFinish).toHaveBeenCalledWith(undefined));
  });

  it('cancels from the group view and supports an empty preview', async () => {
    const ui = setup({
      dryRun: true,
      sourceDigest: 'empty',
      entries: [],
      reviewNotes: [],
      warnings: [],
    });
    expect(ui.frame()).toContain('No import candidates found.');
    await ui.write('\u001b');
    await vi.waitFor(() => expect(ui.onFinish).toHaveBeenCalledWith(undefined));
  });

  it('keeps the list inside a small terminal and keeps full text available', async () => {
    terminal.columns = 36;
    terminal.rows = 12;
    const ui = setup();
    expect(ui.frame().split('\n').length).toBeLessThanOrEqual(12);
    await ui.press('\r', '[x] ready: Concise replies');
    await ui.press('\r', 'Space select');
    expect(ui.frame().split('\n').length).toBeLessThanOrEqual(12);
    await ui.write('o');
    await vi.waitFor(() => expect(ui.onOpen).toHaveBeenCalledOnce());
    expect(ui.onOpen.mock.calls[0][0]).toContain(
      'Source: memory_summary.md:12',
    );
  });

  it('keeps the confirmation and actions visible in a small terminal', async () => {
    terminal.columns = 32;
    terminal.rows = 12;
    const ui = setup(fixture(), undefined, undefined, true);
    await ui.press('i', 'Back to review');
    expect(ui.frame()).toContain('Notes reviewed: import 3');
    expect(ui.frame().split('\n').length).toBeLessThanOrEqual(12);
    await ui.press('\u001b', 'i Start import');
    expect(ui.onFinish).not.toHaveBeenCalled();
  });

  it('shows a resize hint instead of an unusable list in tiny terminals', async () => {
    terminal.columns = 24;
    terminal.rows = 8;
    const ui = setup();
    expect(ui.frame()).toContain('Resize terminal');
    expect(ui.frame()).not.toContain('User memory');
    expect(ui.frame().split('\n').length).toBeLessThanOrEqual(8);
    await ui.write('\u0003');
    await vi.waitFor(() => expect(ui.onFinish).toHaveBeenCalledWith(undefined));
  });
});
