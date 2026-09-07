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
    ViewColumn: { Active: -1, Beside: -2 },
    commands: { executeCommand },
    workspace: {
      openTextDocument: vi.fn(async () => ({ getText: () => 'new' })),
    },
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

describe('DiffManager.showDiff reuse', () => {
  beforeEach(() => {
    executeCommand.mockClear();
  });

  function createManager(): InstanceType<typeof DiffManager> {
    return new DiffManager(() => {}, new DiffContentProvider());
  }

  function diffOpenCount(): number {
    return executeCommand.mock.calls.filter(
      ([command]) => command === 'vscode.diff',
    ).length;
  }

  it('opens a fresh diff instead of reusing a writable twin for a read-only request', async () => {
    const manager = createManager();

    // IDE-mode flow opens a writable diff for this (path, old, new) triple.
    await manager.showDiff('/workspace/foo.ts', 'old', 'new');
    executeCommand.mockClear();

    // A web-shell approval for the same triple must get its own read-only
    // diff; reusing the writable one would invite hand-edits that the
    // approving tool then silently discards (and inside the dedupe window
    // the request would otherwise be suppressed outright).
    await manager.showDiff('/workspace/foo.ts', 'old', 'new', {
      readOnly: true,
    });

    expect(diffOpenCount()).toBe(1);
    expect(executeCommand).not.toHaveBeenCalledWith(WRITABLE_COMMAND);
  });

  it('opens a fresh diff instead of reusing a read-only twin for a writable request', async () => {
    const manager = createManager();

    await manager.showDiff('/workspace/foo.ts', 'old', 'new', {
      readOnly: true,
    });
    executeCommand.mockClear();

    // The IDE-mode flow needs an editable right side to round-trip edits;
    // refocusing the locked diff would take that away.
    await manager.showDiff('/workspace/foo.ts', 'old', 'new');

    expect(diffOpenCount()).toBe(1);
    expect(executeCommand).toHaveBeenCalledWith(WRITABLE_COMMAND);
  });

  it('still dedupes repeat requests with matching writability', async () => {
    const manager = createManager();

    await manager.showDiff('/workspace/foo.ts', 'old', 'new');
    executeCommand.mockClear();

    // Same writability inside the dedupe window: suppressed entirely.
    await manager.showDiff('/workspace/foo.ts', 'old', 'new');
    expect(diffOpenCount()).toBe(0);

    await manager.showDiff('/workspace/foo.ts', 'old', 'new', {
      readOnly: true,
    });
    executeCommand.mockClear();
    await manager.showDiff('/workspace/foo.ts', 'old', 'new', {
      readOnly: true,
    });
    expect(diffOpenCount()).toBe(0);
  });
});

describe('DiffManager permission diff dismissal', () => {
  beforeEach(() => {
    executeCommand.mockClear();
  });

  function createManager(): InstanceType<typeof DiffManager> {
    return new DiffManager(() => {}, new DiffContentProvider());
  }

  function lastOpenedRightUri(): { toString(): string } {
    const call = executeCommand.mock.calls.find(
      ([command]) => command === 'vscode.diff',
    );
    if (!call) throw new Error('no diff was opened');
    return call[2] as { toString(): string };
  }

  it('reports a permission diff the user closed without voting', async () => {
    const manager = createManager();
    const closed = vi.fn();
    manager.onDidClosePermissionDiff(closed);

    await manager.showDiff('/workspace/foo.ts', 'old', 'new', {
      readOnly: true,
      permissionRequestId: 'req-1',
    });
    await manager.cancelDiff(lastOpenedRightUri() as never);

    // Deep equality on purpose: the fan-out in extension.ts consumes only the
    // request id, so a field added here without a reader would be dead weight
    // and this assertion is what stops one creeping back in.
    expect(closed).toHaveBeenCalledWith({ permissionRequestId: 'req-1' });
  });

  it('stays quiet for a diff that no approval is waiting on', async () => {
    const manager = createManager();
    const closed = vi.fn();
    manager.onDidClosePermissionDiff(closed);

    await manager.showDiff('/workspace/foo.ts', 'old', 'new');
    await manager.cancelDiff(lastOpenedRightUri() as never);

    expect(closed).not.toHaveBeenCalled();
  });

  it('does not echo a close the chat surface asked for', async () => {
    const manager = createManager();
    const closed = vi.fn();
    manager.onDidClosePermissionDiff(closed);

    await manager.showDiff('/workspace/foo.ts', 'old', 'new', {
      readOnly: true,
      permissionRequestId: 'req-1',
    });
    const rightUri = lastOpenedRightUri();
    // closeDiff() drops the entry before the tab closes, so the
    // onDidCloseTextDocument -> cancelDiff hop that follows finds nothing.
    await manager.closeDiff('/workspace/foo.ts', false, 'req-1');
    await manager.cancelDiff(rightUri as never);

    expect(closed).not.toHaveBeenCalled();
  });

  it('stops notifying once the manager is disposed', async () => {
    const manager = createManager();
    const closed = vi.fn();
    manager.onDidClosePermissionDiff(closed);

    await manager.showDiff('/workspace/foo.ts', 'old', 'new', {
      readOnly: true,
      permissionRequestId: 'req-1',
    });
    const rightUri = lastOpenedRightUri();

    // An extension-host reload activates a second manager while the previous
    // one's listener closure still holds the torn-down provider registry.
    manager.dispose();
    await manager.cancelDiff(rightUri as never);

    expect(closed).not.toHaveBeenCalled();
  });
});

// R3-9: the request-id binding was landed without a witness for any of its three
// halves — stored by showDiff, read back by getPermissionRequestId/hasDiff, and
// used by closeDiff to refuse a diff owned by a different approval.
describe('DiffManager permission request id binding', () => {
  beforeEach(() => {
    executeCommand.mockClear();
  });

  function createManager(): InstanceType<typeof DiffManager> {
    return new DiffManager(() => {}, new DiffContentProvider());
  }

  function lastOpenedRightUri(): { toString(): string } {
    const call = executeCommand.mock.calls.find(
      ([command]) => command === 'vscode.diff',
    );
    if (!call) throw new Error('no diff was opened');
    return call[2] as { toString(): string };
  }

  it('reads back the request id the diff was opened for', async () => {
    const manager = createManager();

    await manager.showDiff('/workspace/foo.ts', 'old', 'new', {
      readOnly: true,
      permissionRequestId: 'req-1',
    });
    const rightUri = lastOpenedRightUri();

    expect(manager.hasDiff(rightUri as never)).toBe(true);
    expect(manager.getPermissionRequestId(rightUri as never)).toBe('req-1');
  });

  it('leaves the request id undefined for a diff no approval owns', async () => {
    const manager = createManager();

    await manager.showDiff('/workspace/foo.ts', 'old', 'new');
    const rightUri = lastOpenedRightUri();

    expect(manager.hasDiff(rightUri as never)).toBe(true);
    expect(manager.getPermissionRequestId(rightUri as never)).toBeUndefined();
  });

  it('refuses to close a diff owned by a different approval', async () => {
    const manager = createManager();

    await manager.showDiff('/workspace/foo.ts', 'old', 'new', {
      readOnly: true,
      permissionRequestId: 'req-1',
    });
    const rightUri = lastOpenedRightUri();

    await manager.closeDiff('/workspace/foo.ts', true, 'req-other');

    // Same path, different owner: the diff the other approval is waiting on
    // must survive.
    expect(manager.hasDiff(rightUri as never)).toBe(true);
  });

  it('closes the bound diff when the ids match', async () => {
    const manager = createManager();

    await manager.showDiff('/workspace/foo.ts', 'old', 'new', {
      readOnly: true,
      permissionRequestId: 'req-1',
    });
    const rightUri = lastOpenedRightUri();

    await manager.closeDiff('/workspace/foo.ts', true, 'req-1');

    expect(manager.hasDiff(rightUri as never)).toBe(false);
  });

  it('closes by path alone when no request id is given', async () => {
    const manager = createManager();

    await manager.showDiff('/workspace/foo.ts', 'old', 'new', {
      readOnly: true,
      permissionRequestId: 'req-1',
    });
    const rightUri = lastOpenedRightUri();

    await manager.closeDiff('/workspace/foo.ts', true);

    expect(manager.hasDiff(rightUri as never)).toBe(false);
  });
});
