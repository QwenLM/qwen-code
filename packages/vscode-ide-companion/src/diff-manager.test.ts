/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const executeCommand = vi.fn().mockResolvedValue(undefined);

vi.mock('vscode', () => {
  class EventEmitter<T> {
    private listeners = new Set<(event: T) => void>();
    event = (listener: (event: T) => void) => {
      this.listeners.add(listener);
      return { dispose: () => this.listeners.delete(listener) };
    };
    fire(event: T): void {
      for (const listener of [...this.listeners]) listener(event);
    }
    dispose(): void {
      this.listeners.clear();
    }
  }

  return {
    EventEmitter,
    Uri: {
      file: (filePath: string) => {
        const uri: {
          fsPath: string;
          scheme: string;
          query: string;
          with: (change: Record<string, unknown>) => unknown;
          toString: () => string;
        } = {
          fsPath: filePath,
          scheme: 'file',
          query: '',
          with(change: Record<string, unknown>) {
            return { ...uri, ...change };
          },
          toString() {
            return `${uri.scheme}://${uri.fsPath}?${uri.query}`;
          },
        };
        return uri;
      },
    },
    ViewColumn: { Beside: -2 },
    commands: { executeCommand },
    window: {
      activeTextEditor: undefined,
      onDidChangeActiveTextEditor: vi.fn(() => ({ dispose: vi.fn() })),
      tabGroups: { all: [] },
    },
  };
});

// Avoid pulling the full extension module graph; only the scheme constant is
// needed by the diff manager.
vi.mock('./extension.js', () => ({ DIFF_SCHEME: 'qwen-diff' }));

vi.mock('@qwen-code/qwen-code-core', () => ({
  IdeDiffAcceptedNotificationSchema: { parse: (value: unknown) => value },
  IdeDiffClosedNotificationSchema: { parse: (value: unknown) => value },
}));

const { DiffContentProvider, DiffManager } = await import('./diff-manager.js');

const WRITABLE_COMMAND =
  'workbench.action.files.setActiveEditorWriteableInSession';

describe('DiffManager.showDiff writability', () => {
  beforeEach(() => {
    executeCommand.mockClear();
  });

  function createManager(): InstanceType<typeof DiffManager> {
    return new DiffManager(() => {}, new DiffContentProvider());
  }

  it('makes regular diffs editable so IDE-mode approvals can round-trip edits', async () => {
    const manager = createManager();

    await manager.showDiff('/workspace/foo.ts', 'old', 'new');

    expect(executeCommand).toHaveBeenCalledWith(WRITABLE_COMMAND);
  });

  it('keeps read-only diffs locked for flows that cannot round-trip edits', async () => {
    const manager = createManager();

    await manager.showDiff('/workspace/foo.ts', 'old', 'new', {
      readOnly: true,
    });

    expect(executeCommand).not.toHaveBeenCalledWith(WRITABLE_COMMAND);
    // The diff itself still opens.
    expect(executeCommand).toHaveBeenCalledWith(
      'vscode.diff',
      expect.anything(),
      expect.anything(),
      expect.stringContaining('foo.ts'),
      expect.anything(),
    );
  });
});
