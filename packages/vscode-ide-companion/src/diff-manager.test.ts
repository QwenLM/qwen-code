/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JSONRPCNotification } from '@modelcontextprotocol/sdk/types.js';
import { DiffContentProvider, DiffManager } from './diff-manager.js';

const { workspaceMock, openTextDocument, executeCommand, tabGroups } =
  vi.hoisted(() => ({
    workspaceMock: {
      workspaceFolders: [] as Array<{ uri: { fsPath: string } }>,
    },
    openTextDocument: vi.fn(),
    executeCommand: vi.fn(),
    tabGroups: { all: [] as unknown[], close: vi.fn() },
  }));

// A minimal stand-in for vscode.Uri: enough structure for the scheme/query
// rewrites DiffManager does and a stable toString() for its map keys.
function makeUri(fsPath: string, scheme = 'file', query = '') {
  return {
    fsPath,
    scheme,
    query,
    with(change: { scheme?: string; query?: string }) {
      return makeUri(fsPath, change.scheme ?? scheme, change.query ?? query);
    },
    toString() {
      return `${scheme}://${fsPath}${query ? `?${query}` : ''}`;
    },
  };
}

vi.mock('vscode', () => ({
  workspace: {
    get workspaceFolders() {
      return workspaceMock.workspaceFolders;
    },
    openTextDocument,
    onDidChangeActiveTextEditor: vi.fn(() => ({ dispose: vi.fn() })),
  },
  window: {
    activeTextEditor: undefined,
    onDidChangeActiveTextEditor: vi.fn(() => ({ dispose: vi.fn() })),
    tabGroups,
  },
  commands: { executeCommand },
  ViewColumn: { Active: -1, Beside: -2 },
  Uri: {
    file: (fsPath: string) => makeUri(fsPath),
    joinPath: (base: { fsPath: string }, filePath: string) =>
      makeUri(`${base.fsPath}/${filePath}`),
  },
  EventEmitter: class {
    private listeners: Array<(e: unknown) => void> = [];
    event = (listener: (e: unknown) => void) => {
      this.listeners.push(listener);
      return { dispose: vi.fn() };
    };
    fire = (e: unknown) => {
      for (const listener of this.listeners) listener(e);
    };
    dispose = () => {
      this.listeners.length = 0;
    };
  },
}));

vi.mock('./extension.js', () => ({ DIFF_SCHEME: 'qwen-diff' }));

vi.mock('./utils/editorGroupUtils.js', () => ({
  findLeftGroupOfChatWebview: () => undefined,
  findRightGroupOfChatWebview: () => undefined,
}));

describe('DiffManager path resolution', () => {
  let diffManager: DiffManager;
  let notifications: JSONRPCNotification[];

  beforeEach(() => {
    vi.clearAllMocks();
    workspaceMock.workspaceFolders = [{ uri: { fsPath: '/test/workspace1' } }];
    tabGroups.all = [];
    // The right-hand pane is read back through openTextDocument when a diff is
    // closed; the text it returns is what closeDiff resolves with.
    openTextDocument.mockResolvedValue({ getText: () => 'new content' });

    diffManager = new DiffManager(() => {}, new DiffContentProvider());
    notifications = [];
    diffManager.onDidChange((n) => notifications.push(n));
  });

  it('closes a diff opened with a workspace-relative path', async () => {
    await diffManager.showDiff('src/foo.ts', 'old', 'new');

    await expect(diffManager.closeDiff('src/foo.ts')).resolves.toBe(
      'new content',
    );
  });

  it('closes a relative-opened diff when asked with the absolute path', async () => {
    await diffManager.showDiff('src/foo.ts', 'old', 'new');

    await expect(
      diffManager.closeDiff('/test/workspace1/src/foo.ts'),
    ).resolves.toBe('new content');
  });

  it('closes an absolute-opened diff when asked with the relative path', async () => {
    await diffManager.showDiff('/test/workspace1/src/foo.ts', 'old', 'new');

    await expect(diffManager.closeDiff('src/foo.ts')).resolves.toBe(
      'new content',
    );
  });

  it('closes the entry the caller specified, not just the first same-file entry, when two sessions hold the same file open with different content', async () => {
    // Two entries for the same file coexist because hasExistingDiff only
    // dedupes on identical old/new content: a webview permission-preview
    // diff opened with the absolute form, and a second session's differently
    // proposed edit opened with the relative form.
    await diffManager.showDiff('/test/workspace1/src/foo.ts', 'o1', 'n1');
    const firstRightUri = executeCommand.mock.calls.find(
      (call) => call[0] === 'vscode.diff',
    )?.[2];

    await diffManager.showDiff('src/foo.ts', 'o2', 'n2');
    const secondRightUri = executeCommand.mock.calls
      .filter((call) => call[0] === 'vscode.diff')
      .at(-1)?.[2];

    openTextDocument.mockImplementation((uri: unknown) => ({
      getText: () => (uri === secondRightUri ? 'n2' : 'n1'),
    }));

    // Closing with the same form the second entry was opened with must
    // close the second entry, not silently fall back to the first one that
    // happens to share a resolvedFilePath.
    await expect(diffManager.closeDiff('src/foo.ts')).resolves.toBe('n2');
    expect(firstRightUri).not.toBe(secondRightUri);
  });

  it('echoes the path the diff was opened with, not the one used to close', async () => {
    await diffManager.showDiff('src/foo.ts', 'old', 'new');
    await diffManager.closeDiff('/test/workspace1/src/foo.ts');

    expect(notifications).toHaveLength(1);
    expect(notifications[0].params).toMatchObject({
      filePath: 'src/foo.ts',
      content: 'new content',
    });
  });

  it('echoes the caller-supplied path byte for byte, even when it is not normalize-stable', async () => {
    // The CLI keys its pending openDiff promise by the exact string it sent.
    // If the echo comes back normalized, a key like 'src/./foo.ts' no longer
    // matches, and the CLI's promise for it never settles.
    await diffManager.showDiff('src/./foo.ts', 'old', 'new');
    await diffManager.closeDiff('src/foo.ts');

    expect(notifications).toHaveLength(1);
    expect(notifications[0].params).toMatchObject({
      filePath: 'src/./foo.ts',
      content: 'new content',
    });
  });

  it('opens the diff against the resolved path', async () => {
    await diffManager.showDiff('src/foo.ts', 'old', 'new');

    const diffCall = executeCommand.mock.calls.find(
      (call) => call[0] === 'vscode.diff',
    );
    expect(diffCall?.[1].fsPath).toBe('/test/workspace1/src/foo.ts');
    expect(diffCall?.[2].fsPath).toBe('/test/workspace1/src/foo.ts');
  });

  it('reads the old content from the resolved path', async () => {
    await diffManager.showDiff('src/foo.ts', 'new');

    expect(openTextDocument).toHaveBeenCalledWith(
      expect.objectContaining({ fsPath: '/test/workspace1/src/foo.ts' }),
    );
  });

  it('falls back to the raw path when no workspace folder is open', async () => {
    workspaceMock.workspaceFolders = [];

    await diffManager.showDiff('src/foo.ts', 'old', 'new');
    await expect(diffManager.closeDiff('src/foo.ts')).resolves.toBe(
      'new content',
    );

    const diffCall = executeCommand.mock.calls.find(
      (call) => call[0] === 'vscode.diff',
    );
    expect(diffCall?.[1].fsPath).toBe('src/foo.ts');
  });

  it('returns undefined when no diff matches the requested path', async () => {
    await diffManager.showDiff('src/foo.ts', 'old', 'new');

    await expect(
      diffManager.closeDiff('src/other.ts'),
    ).resolves.toBeUndefined();
    expect(notifications).toHaveLength(0);
  });

  it('suppresses the notification when asked to', async () => {
    await diffManager.showDiff('src/foo.ts', 'old', 'new');
    await diffManager.closeDiff('src/foo.ts', true);

    expect(notifications).toHaveLength(0);
  });
});

const WRITABLE_COMMAND =
  'workbench.action.files.setActiveEditorWriteableInSession';

// `vscode.diff` is called as (command, left, right, title, options): the left
// side is the read-only old document, the right side the writable one the vote
// commands and the dismissal keying both resolve through.
function openedDiffCall(): unknown[] {
  const call = executeCommand.mock.calls.find(
    ([command]) => command === 'vscode.diff',
  );
  if (!call) throw new Error('no diff was opened');
  return call;
}

function lastOpenedLeftUri(): { toString(): string } {
  return openedDiffCall()[1] as { toString(): string };
}

function lastOpenedRightUri(): { toString(): string } {
  return openedDiffCall()[2] as { toString(): string };
}

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
    openTextDocument.mockResolvedValue({ getText: () => 'new content' });
  });

  function createManager(): InstanceType<typeof DiffManager> {
    return new DiffManager(() => {}, new DiffContentProvider());
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

  // R4-1: the IDE-mode MCP tool closes by path alone, so its close lands on a
  // diff an approval owns while the caller knows nothing about that request.
  it('reports a permission diff an id-less close took away', async () => {
    const manager = createManager();
    const closed = vi.fn();
    manager.onDidClosePermissionDiff(closed);

    await manager.showDiff('/workspace/foo.ts', 'old', 'new', {
      readOnly: true,
      permissionRequestId: 'req-1',
    });
    const rightUri = lastOpenedRightUri();

    await manager.closeDiff('/workspace/foo.ts', true);
    // The entry is already gone, so this hop cannot be what reports it.
    await manager.cancelDiff(rightUri as never);

    expect(closed).toHaveBeenCalledWith({ permissionRequestId: 'req-1' });
    expect(closed).toHaveBeenCalledTimes(1);
  });

  // R5-2: the two cases above both pass `suppressNotification = true`, and the
  // one case that passes `false` also passes a request id, so it never reaches
  // the fire. The default arm is the one production actually sends —
  // IdeClient.disconnect() calls closeDiff(filePath) with no options and the MCP
  // closeDiff tool forwards `suppressNotification: undefined` — so gating the
  // fire on the flag instead of on the missing id went unnoticed.
  it('reports an id-less close that leaves the notification flag at its default', async () => {
    const manager = createManager();
    const closed = vi.fn();
    manager.onDidClosePermissionDiff(closed);

    await manager.showDiff('/workspace/foo.ts', 'old', 'new', {
      readOnly: true,
      permissionRequestId: 'req-1',
    });

    await manager.closeDiff('/workspace/foo.ts');

    expect(closed).toHaveBeenCalledWith({ permissionRequestId: 'req-1' });
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('stays quiet when an id-less close matches a diff no approval owns', async () => {
    const manager = createManager();
    const closed = vi.fn();
    manager.onDidClosePermissionDiff(closed);

    await manager.showDiff('/workspace/foo.ts', 'old', 'new');

    await manager.closeDiff('/workspace/foo.ts', true);

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
    openTextDocument.mockResolvedValue({ getText: () => 'new content' });
  });

  function createManager(): InstanceType<typeof DiffManager> {
    return new DiffManager(() => {}, new DiffContentProvider());
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

  // R5-1: the entry is keyed on the writable right side only. `qwen.diff.accept`
  // and `qwen.diff.cancel` resolve the vote through the active editor's uri,
  // which is the modified side, so keying the map on the left document would
  // silently break both — and while the uri mock rendered a `with()` copy with
  // the original's scheme and query, both sides shared one key and nothing here
  // could tell the two apart.
  it('keys the diff on the writable side, not the read-only one', async () => {
    const manager = createManager();

    await manager.showDiff('/workspace/foo.ts', 'old', 'new', {
      readOnly: true,
      permissionRequestId: 'req-1',
    });
    const leftUri = lastOpenedLeftUri();

    expect(manager.hasDiff(leftUri as never)).toBe(false);
    expect(manager.getPermissionRequestId(leftUri as never)).toBeUndefined();
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
