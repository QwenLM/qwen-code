// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  DaemonWorkspaceMemoryFile,
  DaemonWorkspaceMemoryStatus,
} from '@qwen-code/web-shell/daemon-react-sdk';
import { I18nProvider } from '../../i18n';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const GLOBAL_PATH = '/home/u/.qwen/QWEN.md';

const memory = vi.hoisted(() => ({
  files: [] as DaemonWorkspaceMemoryFile[],
  status: undefined as DaemonWorkspaceMemoryStatus | undefined,
  readMemoryFile: vi.fn(),
  writeMemory: vi.fn(),
  reload: vi.fn(),
}));

vi.mock('@qwen-code/web-shell/daemon-react-sdk', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@qwen-code/web-shell/daemon-react-sdk')
    >();
  return {
    ...actual,
    useMemory: () => ({
      files: memory.files,
      status: memory.status,
      loading: false,
      error: undefined,
      readMemoryFile: memory.readMemoryFile,
      reload: memory.reload,
      writeMemory: memory.writeMemory,
    }),
  };
});

const { MemoryMessage } = await import('./MemoryMessage');

let container: HTMLDivElement;
let root: Root;

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function mountPanel(refreshSignal = 0) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <I18nProvider language="en">
        <MemoryMessage refreshSignal={refreshSignal} />
      </I18nProvider>,
    );
  });
  await flush();
}

async function mountOnUserTab() {
  await mountPanel();
  act(() => button('User').click());
  await flush();
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(container.querySelectorAll('button')).find(
    (item) => item.textContent === label,
  );
  if (!match) throw new Error(`button not found: ${label}`);
  return match;
}

async function refreshMemory() {
  act(() => button('Refresh').click());
  await flush();
}

function type(textarea: HTMLTextAreaElement, text: string) {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )!.set!;
    setter.call(textarea, text);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
  memory.files = [
    { kind: 'memory_file', path: GLOBAL_PATH, scope: 'global', bytes: 42 },
  ];
  memory.status = {
    v: 1,
    workspaceCwd: '/workspace',
    initialized: true,
    files: memory.files,
    totalBytes: 42,
    fileCount: memory.files.length,
    ruleCount: 0,
  };
  memory.readMemoryFile.mockReset();
  memory.writeMemory.mockReset();
  memory.reload.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('MemoryMessage', () => {
  it('retries a failed content read from the mounted panel refresh control', async () => {
    memory.readMemoryFile.mockRejectedValue(
      new Error('temporary read failure'),
    );
    await mountOnUserTab();
    expect(button('Edit').disabled).toBe(true);

    memory.readMemoryFile.mockResolvedValue({
      content: 'recovered memory\n',
      truncated: false,
    });
    memory.reload.mockResolvedValue(memory.status);
    const readsBeforeRefresh = memory.readMemoryFile.mock.calls.length;

    await refreshMemory();

    expect(memory.reload).toHaveBeenCalledTimes(1);
    expect(memory.readMemoryFile).toHaveBeenCalledTimes(readsBeforeRefresh + 1);
    expect(container.textContent).toContain('recovered memory');
    expect(button('Edit').disabled).toBe(false);
    expect(memory.writeMemory).not.toHaveBeenCalled();
  });

  it('does not replay a persisted refresh counter when the panel reopens', async () => {
    memory.readMemoryFile.mockResolvedValue({
      content: 'existing memory\n',
      truncated: false,
    });
    memory.reload.mockResolvedValue(memory.status);

    memory.files = [
      {
        kind: 'memory_file',
        path: '/workspace/QWEN.md',
        scope: 'workspace',
        bytes: 42,
      },
    ];
    memory.status = { ...memory.status!, files: memory.files };

    await mountPanel(3);

    expect(memory.reload).not.toHaveBeenCalled();
    expect(memory.readMemoryFile).toHaveBeenCalledTimes(1);
  });

  it('keeps a refreshed truncated file read-only', async () => {
    memory.readMemoryFile.mockRejectedValue(
      new Error('temporary read failure'),
    );
    await mountOnUserTab();
    memory.reload.mockResolvedValue(memory.status);
    memory.readMemoryFile.mockResolvedValue({
      content: 'partial',
      truncated: true,
    });

    await refreshMemory();

    expect(container.textContent).toContain('partial');
    expect(button('Edit').disabled).toBe(true);
    expect(container.querySelector('textarea')).toBeNull();
    expect(memory.writeMemory).not.toHaveBeenCalled();
  });

  it('keeps failed content read-only when refreshing the list fails', async () => {
    memory.readMemoryFile.mockRejectedValue(
      new Error('temporary read failure'),
    );
    await mountOnUserTab();
    const readsBeforeRefresh = memory.readMemoryFile.mock.calls.length;
    // useDaemonResource returns undefined for failed or superseded reloads.
    memory.reload.mockResolvedValue(undefined);

    await refreshMemory();

    expect(memory.readMemoryFile).toHaveBeenCalledTimes(readsBeforeRefresh);
    expect(button('Edit').disabled).toBe(true);
    expect(container.textContent).not.toContain('Memory refreshed');
    expect(memory.writeMemory).not.toHaveBeenCalled();
  });

  it('clears a pending content load if refresh finds the file was removed', async () => {
    memory.readMemoryFile.mockReturnValue(new Promise(() => {}));
    await mountOnUserTab();
    memory.reload.mockImplementation(async () => {
      memory.files = [];
      memory.status = { ...memory.status!, files: [], fileCount: 0 };
      return memory.status;
    });

    await refreshMemory();

    expect(container.textContent).not.toContain('Loading memory file');
    expect(button('Edit').disabled).toBe(false);
    act(() => button('Edit').click());
    await flush();
    expect(container.querySelector('textarea')?.disabled).toBe(false);
    expect(memory.writeMemory).not.toHaveBeenCalled();
  });

  it('does not restore the previous tab when a pending refresh completes', async () => {
    memory.readMemoryFile.mockResolvedValue({
      content: 'user memory\n',
      truncated: false,
    });
    await mountOnUserTab();
    let finishRefresh!: (status: DaemonWorkspaceMemoryStatus) => void;
    memory.reload.mockImplementation(
      () => new Promise((resolve) => (finishRefresh = resolve)),
    );
    await refreshMemory();
    act(() => button('Workspace').click());
    await flush();

    await act(async () => finishRefresh(memory.status!));

    expect(container.textContent).not.toContain('user memory');
    expect(memory.writeMemory).not.toHaveBeenCalled();
    expect(memory.reload).toHaveBeenCalledTimes(1);
  });

  it('keeps editing when a refresh completes without cancellation', async () => {
    memory.readMemoryFile.mockResolvedValue({
      content: 'existing memory\n',
      truncated: false,
    });
    await mountOnUserTab();
    act(() => button('Edit').click());
    await flush();
    memory.reload.mockResolvedValue(memory.status);
    memory.readMemoryFile.mockResolvedValue({
      content: 'refreshed memory\n',
      truncated: false,
    });

    await refreshMemory();

    expect(container.querySelector('textarea')?.value).toBe(
      'refreshed memory\n',
    );
    expect(memory.writeMemory).not.toHaveBeenCalled();
  });

  it.each(['before', 'after'] as const)(
    'keeps view mode when editing is cancelled %s the refreshed list arrives',
    async (cancelWhen) => {
      memory.readMemoryFile.mockResolvedValue({
        content: 'existing memory\n',
        truncated: false,
      });
      await mountOnUserTab();
      act(() => button('Edit').click());
      await flush();
      type(container.querySelector('textarea')!, 'unsaved draft\n');

      let finishRefresh!: (status: DaemonWorkspaceMemoryStatus) => void;
      memory.reload.mockImplementation(
        () => new Promise((resolve) => (finishRefresh = resolve)),
      );
      let finishRead!: (result: {
        content: string;
        truncated: boolean;
      }) => void;
      memory.readMemoryFile.mockImplementation(
        () => new Promise((resolve) => (finishRead = resolve)),
      );
      const readsBeforeRefresh = memory.readMemoryFile.mock.calls.length;
      await refreshMemory();
      if (cancelWhen === 'after') {
        await act(async () => finishRefresh(memory.status!));
      }

      act(() => button('cancel').click());
      await flush();
      expect(container.querySelector('textarea')).toBeNull();
      if (cancelWhen === 'before') {
        await act(async () => finishRefresh(memory.status!));
      }
      await act(async () =>
        finishRead({ content: 'refreshed memory\n', truncated: false }),
      );

      expect(container.querySelector('textarea')).toBeNull();
      expect(container.textContent).toContain('refreshed memory');
      expect(container.textContent).not.toContain('unsaved draft');
      expect(container.textContent).not.toContain('Loading memory file');
      expect(button('Edit').disabled).toBe(false);
      expect(memory.readMemoryFile).toHaveBeenCalledTimes(
        readsBeforeRefresh + 1,
      );
      expect(memory.reload).toHaveBeenCalledTimes(1);
      expect(memory.writeMemory).not.toHaveBeenCalled();
    },
  );

  it('keeps the User tab read-only when its file cannot be read', async () => {
    memory.readMemoryFile.mockRejectedValue(
      new Error(`GET /file: path escapes workspace: ${GLOBAL_PATH}`),
    );

    await mountOnUserTab();

    expect(memory.readMemoryFile).toHaveBeenLastCalledWith(GLOBAL_PATH);
    expect(container.textContent).toContain(
      'Global memory is outside the bound workspace',
    );
    expect(container.textContent).not.toContain('path escapes workspace');
    expect(button('Edit').disabled).toBe(true);
    expect(container.querySelector('textarea')).toBeNull();
    expect(memory.writeMemory).not.toHaveBeenCalled();
  });

  it('replaces the global file with the edited text once it was read', async () => {
    memory.readMemoryFile.mockResolvedValue({
      content: 'existing\n',
      truncated: false,
    });
    memory.writeMemory.mockResolvedValue({
      ok: true,
      filePath: GLOBAL_PATH,
      bytesWritten: 15,
      mode: 'replace',
      changed: true,
    });

    await mountOnUserTab();
    act(() => button('Edit').click());
    await flush();

    const editor = container.querySelector('textarea')!;
    expect(editor.value).toBe('existing\n');
    // An actual edit: asserting only that the read text comes back would
    // also pass for a panel that ignores the editor entirely.
    type(editor, 'existing\none typed line\n');
    act(() => button('Save Memory').click());
    await flush();

    expect(memory.writeMemory).toHaveBeenCalledWith({
      scope: 'global',
      mode: 'replace',
      content: 'existing\none typed line\n',
    });
  });

  it('does not offer editing a truncated file', async () => {
    memory.readMemoryFile.mockResolvedValue({
      content: 'partial',
      truncated: true,
    });

    await mountOnUserTab();

    expect(container.textContent).toContain('partial');
    expect(button('Edit').disabled).toBe(true);
  });

  // #13100's destructive step: an outstanding status load makes `files`
  // empty, which looks exactly like "no memory file yet" and used to open
  // the create path with Edit + Save enabled over a file that is on disk.
  it('does not offer replace while the memory list has not loaded', async () => {
    memory.files = [];
    memory.status = undefined;

    await mountOnUserTab();

    expect(button('Edit').disabled).toBe(true);
    expect(container.querySelector('textarea')).toBeNull();
    expect(memory.writeMemory).not.toHaveBeenCalled();
  });

  // The gate must key on the load having succeeded, not on `files` being
  // empty: a genuinely empty list is the first-memory-file create path.
  it('still offers creating the first memory file once the list loaded', async () => {
    memory.files = [];
    memory.status = {
      v: 1,
      workspaceCwd: '/workspace',
      initialized: false,
      files: [],
      totalBytes: 0,
      fileCount: 0,
      ruleCount: 0,
    };

    await mountOnUserTab();

    expect(button('Edit').disabled).toBe(false);
    act(() => button('Edit').click());
    await flush();
    expect(container.querySelector('textarea')).not.toBeNull();
  });

  it('restores the file’s own CRLF endings on save', async () => {
    memory.readMemoryFile.mockResolvedValue({
      content: 'a\r\nb\r\n',
      truncated: false,
    });
    memory.writeMemory.mockResolvedValue({
      ok: true,
      filePath: GLOBAL_PATH,
      bytesWritten: 9,
      mode: 'replace',
      changed: true,
    });

    await mountOnUserTab();
    act(() => button('Edit').click());
    await flush();

    const editor = container.querySelector('textarea')!;
    // The textarea value API normalizes CRLF to LF.
    expect(editor.value).toBe('a\nb\n');
    // One keystroke: append "c" as a new line.
    type(editor, 'a\nb\nc\n');
    await flush();
    act(() => button('Save Memory').click());
    await flush();

    expect(memory.writeMemory).toHaveBeenCalledWith({
      scope: 'global',
      mode: 'replace',
      content: 'a\r\nb\r\nc\r\n',
    });
  });

  // Edit then Save with zero keystrokes: `draft` never went through the
  // textarea, so it still holds the file's own CRLF. A `\n`-keyed expansion
  // doubles every CR, and `mode:'replace'` writes that straight to disk.
  it('leaves a CRLF file untouched when saved without editing', async () => {
    memory.readMemoryFile.mockResolvedValue({
      content: 'a\r\nb\r\n',
      truncated: false,
    });
    memory.writeMemory.mockResolvedValue({
      ok: true,
      filePath: GLOBAL_PATH,
      bytesWritten: 8,
      mode: 'replace',
      changed: false,
    });

    await mountOnUserTab();
    act(() => button('Edit').click());
    await flush();
    expect(container.querySelector('textarea')!.value).toBe('a\nb\n');

    act(() => button('Save Memory').click());
    await flush();
    expect(memory.writeMemory).toHaveBeenLastCalledWith({
      scope: 'global',
      mode: 'replace',
      content: 'a\r\nb\r\n',
    });
  });
});
