/** @jsxImportSource @opentui/react */
// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Key, ReactNode } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import type { LoadedSettings } from '../../config/settings.js';
import type { OpenTuiAppHost } from './opentui-host.js';
import {
  useSkillReview,
  type NativeSkillReviewBatch,
} from './use-skill-review.js';
import {
  catalogDeferred,
  catalogKey,
} from '../../test-utils/opentui-catalog.js';
const { state, buildRuntime } = vi.hoisted(() => {
  const state = {
    keyboard: [] as Array<(key: unknown) => void>,
    width: 120,
    height: 40,
    open: vi.fn(),
    watch: vi.fn(),
    editor: vi.fn(),
    spawn: vi.fn(),
    spawnSync: vi.fn(),
    suspend: vi.fn(),
    resume: vi.fn(),
    release: vi.fn(),
    restore: vi.fn(),
    requestRender: vi.fn(),
    scrollIntoView: vi.fn(),
    renderAfter: null as (() => void) | null,
    onSizeChange: null as (() => void) | null,
  };
  async function buildRuntime() {
    const React = await import('react');
    const runtime = (
      await import('../../test-utils/opentui-catalog.js')
    ).catalogRuntime();
    const Scroll = React.forwardRef<
      unknown,
      {
        children?: ReactNode;
        renderAfter?: () => void;
        onSizeChange?: () => void;
      }
    >((props, ref) => {
      state.renderAfter = props.renderAfter ?? null;
      state.onSizeChange = props.onSizeChange ?? null;
      React.useImperativeHandle(ref, () => ({
        requestRender: state.requestRender,
        scrollChildIntoView: state.scrollIntoView,
      }));
      return React.createElement('div', null, props.children);
    });
    Scroll.displayName = 'SkillReviewScroll';
    const jsx = (
      type: unknown,
      props: Record<string, unknown> | null,
      key?: Key,
    ) =>
      type === 'scrollbox'
        ? React.createElement(Scroll, { ...props, key })
        : runtime.jsx(type, props, key);
    return { ...runtime, jsx, jsxs: jsx, jsxDEV: jsx };
  }
  return { state, buildRuntime };
});
vi.mock(
  '@opentui/core',
  async () =>
    (await import('../../test-utils/opentui-catalog.js')).catalogNativeCore,
);
vi.mock('@opentui/react/jsx-runtime', () => buildRuntime());
vi.mock('@opentui/react/jsx-dev-runtime', () => buildRuntime());
vi.mock('@opentui/react', async () => ({
  ...(await import('../../test-utils/opentui-catalog.js')).catalogHooks(
    state.keyboard,
    [],
    () => ({ width: state.width, height: state.height }),
  ),
  useRenderer: () => ({ suspend: state.suspend, resume: state.resume }),
}));
vi.mock('node:fs/promises', () => ({ default: { open: state.open } }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    watch: state.watch,
    default: { ...actual, watch: state.watch },
  };
});
vi.mock('node:child_process', () => ({
  spawn: state.spawn,
  spawnSync: state.spawnSync,
  default: { spawn: state.spawn, spawnSync: state.spawnSync },
}));
vi.mock('@qwen-code/qwen-code-core/utils/editor.js', () => ({
  getEditorExecutable: state.editor,
}));
vi.mock('../../utils/program-status.js', () => ({
  releaseProgramStatus: state.release,
  restoreProgramStatus: state.restore,
}));
vi.mock('../../config/settings.js', () => ({
  SettingScope: { Workspace: 'Workspace' },
}));
vi.mock('../../i18n/index.js', () => ({ t: (text: string) => text }));
vi.mock('./theme.js', () => ({
  C: {
    text: 'white',
    dim: 'gray',
    accent: 'cyan',
    red: 'red',
    success: 'green',
  },
}));
import { OpenTuiSkillReviewDialog } from './SkillReviewDialog.js';

function fixture() {
  let valid = true;
  const skills = ['alpha', 'beta'].map((name) => ({
    name,
    description: `${name} description`,
    stagedManifestPath: `/pending/${name}/SKILL.md`,
  }));
  const task = {
    id: 'task',
    projectRoot: '/project',
    metadata: { pendingSkills: [...skills] },
  };
  const manager = {
    getTask: vi.fn(() => task),
    acceptPendingSkillFromTask: vi.fn(async () => {}),
    rejectPendingSkillFromTask: vi.fn(async () => {}),
  };
  const config = { setAutoSkillEnabled: vi.fn() } as unknown as Config;
  const settings = {
    workspace: { path: '/project/.qwen/settings.json' },
    isTrusted: true,
    merged: { general: { preferredEditor: 'vim' } },
    setValue: vi.fn(),
  } as unknown as LoadedSettings;
  const host: Pick<OpenTuiAppHost, 'config' | 'settings'> = {
    config,
    settings,
  };
  const batch = {
    config,
    manager,
    task,
    skills,
    generation: 0,
    isCurrent: () => valid,
    isDismissed: () => false,
    dismiss: vi.fn(),
  } as unknown as NativeSkillReviewBatch;
  return {
    batch,
    manager,
    config,
    settings,
    host,
    onClose: vi.fn(),
    onDismiss: vi.fn(),
    revoke: () => {
      valid = false;
    },
    restore: () => {
      valid = true;
    },
  };
}
function key(name: string, sequence = '') {
  act(() => {
    for (const handler of [...state.keyboard])
      handler(catalogKey(name, sequence));
  });
}
async function settle() {
  await act(async () => {
    await Promise.resolve();
  });
}
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
beforeEach(() => {
  vi.clearAllMocks();
  state.keyboard.length = 0;
  state.renderAfter = null;
  state.onSizeChange = null;
  state.width = 120;
  state.height = 40;
  state.editor.mockReturnValue('vim');
  state.spawnSync.mockReturnValue({ status: 0, signal: null });
  state.open.mockImplementation(async () => ({
    read: async (buffer: Buffer) => {
      const text = Buffer.from('# preview\r\nbody\n');
      text.copy(buffer);
      return { bytesRead: text.length };
    },
    close: vi.fn(),
  }));
  state.watch.mockReturnValue({ on: vi.fn(), close: vi.fn() });
});
describe('OpenTuiSkillReviewDialog', () => {
  it('follows the selected action after initial layout, async preview, index and resize without resetting manual scroll each frame', async () => {
    state.width = 20;
    const wait = catalogDeferred<{
      read: (buffer: Buffer) => Promise<{ bytesRead: number }>;
      close: () => void;
    }>();
    state.open.mockReturnValueOnce(wait.promise);
    const f = fixture();
    const view = render(
      <OpenTuiSkillReviewDialog {...f} availableTerminalHeight={15} />,
    );
    expect(state.requestRender).toHaveBeenCalled();
    act(() => state.renderAfter?.());
    expect(state.scrollIntoView).toHaveBeenLastCalledWith(
      'skill-review-option-keep',
    );
    state.scrollIntoView.mockClear();
    act(() => state.renderAfter?.());
    expect(state.scrollIntoView).not.toHaveBeenCalled();
    await act(async () => {
      wait.resolve({
        read: async (buffer) => {
          buffer.write('new preview');
          return { bytesRead: 11 };
        },
        close: vi.fn(),
      });
      await wait.promise;
    });
    await settle();
    act(() => state.renderAfter?.());
    expect(state.scrollIntoView).toHaveBeenLastCalledWith(
      'skill-review-option-keep',
    );
    key('down');
    act(() => state.renderAfter?.());
    expect(state.scrollIntoView).toHaveBeenLastCalledWith(
      'skill-review-option-discard',
    );
    state.width = 40;
    view.rerender(
      <OpenTuiSkillReviewDialog {...f} availableTerminalHeight={12} />,
    );
    act(() => state.renderAfter?.());
    expect(state.scrollIntoView).toHaveBeenLastCalledWith(
      'skill-review-option-discard',
    );
    state.requestRender.mockClear();
    act(() => state.onSizeChange?.());
    expect(state.requestRender).toHaveBeenCalledOnce();
    act(() => state.renderAfter?.());
    expect(state.scrollIntoView).toHaveBeenLastCalledWith(
      'skill-review-option-discard',
    );
    key('return');
    await settle();
    act(() => state.renderAfter?.());
    expect(state.scrollIntoView).toHaveBeenLastCalledWith(
      'skill-review-option-keep',
    );
    state.scrollIntoView.mockClear();
    act(() => state.renderAfter?.());
    expect(state.scrollIntoView).not.toHaveBeenCalled();
  });
  it('does not read or dispatch behind an unrelated host', async () => {
    const f = fixture();
    f.host = { ...f.host, config: {} as Config };
    render(<OpenTuiSkillReviewDialog {...f} />);
    await settle();
    expect(state.open).not.toHaveBeenCalled();
    key('return');
    expect(f.manager.acceptPendingSkillFromTask).not.toHaveBeenCalled();
  });
  it('remounts a usable body after an unpainted record ABA and ignores the old pending body', async () => {
    const f = fixture();
    const original = f.manager.getTask();
    let selected = original;
    let notify = () => {};
    const manager = {
      ...f.manager,
      listTasksByType: () => [selected],
      subscribe: (listener: () => void) => {
        notify = listener;
        return () => {};
      },
    };
    f.manager.getTask.mockImplementation(() => selected);
    const config = {
      ...f.config,
      getMemoryManager: () => manager,
      getProjectRoot: () => '/project',
      getWorkingDir: () => '/project',
      getSessionId: () => 'A',
      getAutoSkillEnabled: () => true,
    } as unknown as Config;
    const host = { ...f.host, config };
    const painted: unknown[] = [];
    let latestBatch!: NativeSkillReviewBatch;
    function Harness() {
      const controller = useSkillReview(config);
      if (controller.pending) latestBatch = controller.pending;
      painted.push(controller.pending?.task);
      return controller.pending ? (
        <OpenTuiSkillReviewDialog
          {...f}
          batch={controller.pending}
          host={host}
        />
      ) : null;
    }
    const wait = catalogDeferred<void>();
    f.manager.acceptPendingSkillFromTask.mockReturnValueOnce(wait.promise);
    render(<Harness />);
    await settle();
    const oldA = latestBatch!;
    key('return');
    const oldHandlers = [...state.keyboard];
    const replacement = { ...original };
    act(() => {
      selected = replacement;
      notify();
      selected = original;
      notify();
    });
    await settle();
    expect(painted).not.toContain(replacement);
    expect(oldA.isCurrent()).toBe(false);
    oldA.dismiss();
    expect(latestBatch!.isDismissed()).toBe(false);
    key('return');
    await settle();
    expect(f.manager.acceptPendingSkillFromTask).toHaveBeenCalledTimes(2);
    expect(screen.getByText('beta')).toBeTruthy();
    act(() =>
      oldHandlers.forEach((handler) => handler(catalogKey('escape', ''))),
    );
    await act(async () => {
      wait.resolve();
      await wait.promise;
    });
    expect(f.onClose).not.toHaveBeenCalled();
    expect(f.onDismiss).not.toHaveBeenCalled();
    expect(screen.getByText('beta')).toBeTruthy();
  });
  it('closes an empty snapshot without any decision', async () => {
    const f = fixture();
    f.batch.skills = [];
    render(<OpenTuiSkillReviewDialog {...f} />);
    await settle();
    expect(f.onClose).toHaveBeenCalledOnce();
    expect(f.manager.acceptPendingSkillFromTask).not.toHaveBeenCalled();
    expect(f.manager.rejectPendingSkillFromTask).not.toHaveBeenCalled();
  });
  it('keeps then discards immutable snapshot entries despite live pending shrink', async () => {
    const f = fixture();
    const view = render(<OpenTuiSkillReviewDialog {...f} />);
    await settle();
    expect(view.container.textContent).toContain('# preview\nbody');
    key('return');
    await settle();
    expect(f.manager.acceptPendingSkillFromTask).toHaveBeenCalledWith(
      'task',
      'alpha',
    );
    f.batch.skills.splice(0, 1);
    view.rerender(<OpenTuiSkillReviewDialog {...f} />);
    key('down');
    key('return');
    await settle();
    expect(f.manager.rejectPendingSkillFromTask).toHaveBeenCalledWith(
      'task',
      'beta',
    );
    expect(f.onClose).toHaveBeenCalledOnce();
    expect(f.onDismiss).not.toHaveBeenCalled();
  });
  it.each([
    ['3', 'acceptPendingSkillFromTask'],
    ['4', 'rejectPendingSkillFromTask'],
  ] as const)(
    'uses immediate numbered bulk option %s for remaining skills only',
    async (number, operation) => {
      const f = fixture();
      render(<OpenTuiSkillReviewDialog {...f} />);
      await settle();
      key(number, number);
      await settle();
      expect(f.manager[operation].mock.calls).toEqual([
        ['task', 'alpha'],
        ['task', 'beta'],
      ]);
      expect(f.onClose).toHaveBeenCalledOnce();
    },
  );
  it('defers Escape without resolving a skill', async () => {
    const f = fixture();
    render(<OpenTuiSkillReviewDialog {...f} />);
    await settle();
    key('escape');
    expect(f.onDismiss).toHaveBeenCalledOnce();
    expect(f.manager.acceptPendingSkillFromTask).not.toHaveBeenCalled();
    expect(f.manager.rejectPendingSkillFromTask).not.toHaveBeenCalled();
  });
  it('persists turn-off before the live setter and closes without dismissal', async () => {
    const f = fixture();
    const order: string[] = [];
    vi.mocked(f.settings.setValue).mockImplementation(
      (_scope, _key, _value, guard) => {
        guard?.();
        order.push('persist');
      },
    );
    vi.mocked(f.config.setAutoSkillEnabled).mockImplementation(() => {
      order.push('live');
    });
    render(<OpenTuiSkillReviewDialog {...f} />);
    await settle();
    key('5', '5');
    await settle();
    expect(f.settings.setValue).toHaveBeenCalledWith(
      'Workspace',
      'memory.enableAutoSkill',
      false,
      expect.any(Function),
      { throwOnWriteFailure: true },
    );
    expect(order).toEqual(['persist', 'live']);
    expect(f.onClose).toHaveBeenCalledOnce();
    expect(f.onDismiss).not.toHaveBeenCalled();
    expect(f.manager.rejectPendingSkillFromTask).not.toHaveBeenCalled();
  });
  it('keeps a failed write visible and never disables the live feature', async () => {
    const f = fixture();
    vi.mocked(f.settings.setValue).mockImplementation(() => {
      throw new Error('readonly workspace');
    });
    render(<OpenTuiSkillReviewDialog {...f} />);
    await settle();
    key('5', '5');
    await settle();
    expect(screen.getByText('readonly workspace')).toBeTruthy();
    expect(f.config.setAutoSkillEnabled).not.toHaveBeenCalled();
    expect(f.onClose).not.toHaveBeenCalled();
  });
  it('stops a bulk failure at the unresolved entry and allows a truthful retry', async () => {
    const f = fixture();
    f.manager.acceptPendingSkillFromTask.mockRejectedValueOnce(
      new Error('rename failed'),
    );
    render(<OpenTuiSkillReviewDialog {...f} />);
    await settle();
    key('3', '3');
    await settle();
    expect(f.manager.acceptPendingSkillFromTask).toHaveBeenCalledTimes(1);
    expect(screen.getByText('rename failed')).toBeTruthy();
    expect(f.onClose).not.toHaveBeenCalled();
    key('1', '1');
    await settle();
    expect(f.manager.acceptPendingSkillFromTask).toHaveBeenLastCalledWith(
      'task',
      'alpha',
    );
  });
  it('never repeats an already successful bulk entry after a later failure', async () => {
    const f = fixture();
    f.manager.acceptPendingSkillFromTask
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('beta failed'));
    render(<OpenTuiSkillReviewDialog {...f} />);
    await settle();
    key('3', '3');
    await settle();
    expect(screen.getByText('beta failed')).toBeTruthy();
    expect(f.onClose).not.toHaveBeenCalled();
    key('return');
    await settle();
    expect(f.manager.acceptPendingSkillFromTask.mock.calls).toEqual([
      ['task', 'alpha'],
      ['task', 'beta'],
      ['task', 'beta'],
    ]);
    expect(f.onClose).toHaveBeenCalledOnce();
  });
  it('permanently refuses a getter-only owner ABA once observed', async () => {
    const f = fixture();
    render(<OpenTuiSkillReviewDialog {...f} />);
    await settle();
    f.revoke();
    key('o', 'o');
    f.restore();
    key('return');
    await settle();
    expect(f.manager.acceptPendingSkillFromTask).not.toHaveBeenCalled();
    expect(state.spawnSync).not.toHaveBeenCalled();
  });
  it('refuses duplicate input and late completion after revocation', async () => {
    const f = fixture();
    const wait = catalogDeferred<void>();
    f.manager.acceptPendingSkillFromTask.mockReturnValue(wait.promise);
    render(<OpenTuiSkillReviewDialog {...f} />);
    await settle();
    key('return');
    key('return');
    key('escape');
    expect(f.manager.acceptPendingSkillFromTask).toHaveBeenCalledTimes(1);
    expect(f.onDismiss).not.toHaveBeenCalled();
    f.revoke();
    await act(async () => {
      wait.resolve();
      await wait.promise;
    });
    expect(f.onClose).not.toHaveBeenCalled();
    expect(f.manager.rejectPendingSkillFromTask).not.toHaveBeenCalled();
  });
  it('ignores a late rejection from an unmounted task without poisoning its replacement', async () => {
    const a = fixture();
    const wait = catalogDeferred<void>();
    a.manager.acceptPendingSkillFromTask.mockReturnValue(wait.promise);
    const view = render(<OpenTuiSkillReviewDialog {...a} />);
    await settle();
    key('return');
    const b = fixture();
    view.rerender(<OpenTuiSkillReviewDialog {...b} />);
    await settle();
    await act(async () => {
      wait.reject(new Error('old rejection'));
      await wait.promise.catch(() => {});
    });
    expect(screen.queryByText('old rejection')).toBeNull();
    expect(b.onClose).not.toHaveBeenCalled();
    key('escape');
    expect(b.onDismiss).toHaveBeenCalledOnce();
  });
  it('refuses a changed authoritative staged path before dispatch', async () => {
    const f = fixture();
    render(<OpenTuiSkillReviewDialog {...f} />);
    await settle();
    f.manager.getTask.mockReturnValue({
      ...f.manager.getTask()!,
      metadata: {
        pendingSkills: [
          { ...f.batch.skills[0]!, stagedManifestPath: '/other/SKILL.md' },
        ],
      },
    });
    key('return');
    await settle();
    expect(f.manager.acceptPendingSkillFromTask).not.toHaveBeenCalled();
    expect(screen.getByText(/no longer pending/)).toBeTruthy();
  });
  it('opens only the actual staged file, restores the terminal, and reloads without resolving', async () => {
    const f = fixture();
    render(<OpenTuiSkillReviewDialog {...f} />);
    await settle();
    key('o', 'o');
    await settle();
    expect(state.spawnSync).toHaveBeenCalledWith(
      'vim',
      ['/pending/alpha/SKILL.md'],
      { stdio: 'inherit', shell: false },
    );
    expect(state.suspend).toHaveBeenCalledOnce();
    expect(state.resume).toHaveBeenCalledOnce();
    expect(state.restore).toHaveBeenCalledOnce();
    expect(state.open).toHaveBeenCalledTimes(2);
    expect(f.manager.acceptPendingSkillFromTask).not.toHaveBeenCalled();
  });
  it('restores after editor failure and shows the error without advancing', async () => {
    state.spawnSync.mockReturnValue({ status: 2 });
    const f = fixture();
    render(<OpenTuiSkillReviewDialog {...f} />);
    await settle();
    key('o', 'o');
    expect(screen.getByText('Editor exited with status 2')).toBeTruthy();
    expect(state.resume).toHaveBeenCalledOnce();
    expect(f.onClose).not.toHaveBeenCalled();
  });
  it('bounds preview reads, sanitizes controls, and closes handles and watchers', async () => {
    const read = vi.fn(async (buffer: Buffer) => {
      buffer.fill(65);
      Buffer.from('\u001b[2J# danger\u0007\u202e\n').copy(buffer);
      return { bytesRead: buffer.length };
    });
    const close = vi.fn();
    const stop = vi.fn();
    state.open.mockResolvedValue({ read, close });
    state.watch.mockReturnValue({ on: vi.fn(), close: stop });
    const f = fixture();
    const view = render(<OpenTuiSkillReviewDialog {...f} />);
    await settle();
    expect(read.mock.calls[0]?.[0].length).toBe(65537);
    expect(close).toHaveBeenCalledOnce();
    expect(
      screen.getByText('… preview truncated (file too large) …'),
    ).toBeTruthy();
    expect(view.container.textContent).toContain('danger');
    expect(view.container.textContent).not.toContain('\u001b');
    expect(view.container.textContent).not.toContain('\u0007');
    expect(view.container.textContent).not.toContain('\u202e');
    view.unmount();
    expect(stop).toHaveBeenCalledOnce();
  });
  it('debounces a public file-watch refresh and cleans the pending timer on unmount', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const view = render(<OpenTuiSkillReviewDialog {...f} />);
    await settle();
    const changed = state.watch.mock.calls[0]![2] as () => void;
    act(() => {
      changed();
      changed();
      vi.advanceTimersByTime(299);
    });
    expect(state.open).toHaveBeenCalledOnce();
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(state.open).toHaveBeenCalledTimes(2);
    act(() => changed());
    view.unmount();
    act(() => vi.advanceTimersByTime(300));
    expect(state.open).toHaveBeenCalledTimes(2);
  });
  it('ignores a late preview from the prior task and closes its opened file', async () => {
    const wait = catalogDeferred<{
      read: (buffer: Buffer) => Promise<{ bytesRead: number }>;
      close: () => void;
    }>();
    const close = vi.fn();
    state.open.mockReturnValueOnce(wait.promise);
    const a = fixture();
    const view = render(<OpenTuiSkillReviewDialog {...a} />);
    await settle();
    const b = fixture();
    b.batch.task = { ...b.batch.task, id: 'successor' };
    view.rerender(<OpenTuiSkillReviewDialog {...b} />);
    await settle();
    await act(async () => {
      wait.resolve({
        read: async (buffer) => {
          buffer.write('STALE PREVIEW');
          return { bytesRead: 13 };
        },
        close,
      });
      await wait.promise;
    });
    expect(view.container.textContent).not.toContain('STALE PREVIEW');
    expect(close).toHaveBeenCalledOnce();
  });
  it('shows unavailable preview and consumes asynchronous watcher failure', async () => {
    state.open.mockRejectedValueOnce(new Error('missing file'));
    const f = fixture();
    const view = render(<OpenTuiSkillReviewDialog {...f} />);
    await settle();
    expect(screen.getByText('Preview unavailable')).toBeTruthy();
    key('o', 'o');
    await settle();
    const watcher = state.watch.mock.results[0]!.value as {
      on: ReturnType<typeof vi.fn>;
      close: ReturnType<typeof vi.fn>;
    };
    const onError = watcher.on.mock.calls[0]![1] as () => void;
    act(() => onError());
    expect(watcher.close).toHaveBeenCalledOnce();
    view.unmount();
  });
  it('does not let a retained old keyboard callback close a replacement or an unmounted dialog', async () => {
    const a = fixture();
    const view = render(<OpenTuiSkillReviewDialog {...a} />);
    await settle();
    const old = [...state.keyboard];
    const b = fixture();
    view.rerender(<OpenTuiSkillReviewDialog {...b} />);
    await settle();
    a.revoke();
    act(() => {
      old.forEach((handler) => handler(catalogKey('escape', '')));
    });
    expect(b.onClose).not.toHaveBeenCalled();
    expect(b.onDismiss).not.toHaveBeenCalled();
    const current = [...state.keyboard];
    view.unmount();
    act(() => {
      current.forEach((handler) => handler(catalogKey('escape', '')));
    });
    expect(b.onDismiss).not.toHaveBeenCalled();
  });
  it('does not dispatch actions in a zero-row region', async () => {
    const f = fixture();
    render(<OpenTuiSkillReviewDialog {...f} availableTerminalHeight={0} />);
    await settle();
    key('return');
    key('1', '1');
    key('o', 'o');
    expect(f.manager.acceptPendingSkillFromTask).not.toHaveBeenCalled();
    expect(state.spawnSync).not.toHaveBeenCalled();
    key('escape');
    expect(f.onDismiss).toHaveBeenCalledOnce();
  });
});
