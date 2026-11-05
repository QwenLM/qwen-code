/** @jsxImportSource @opentui/react */
// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import childProcess, { spawnSync } from 'node:child_process';
import { act, cleanup, render, screen } from '@testing-library/react';
import type { LoadedSettings } from '../../config/settings.js';
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import { Kind } from '@qwen-code/qwen-code-core/tools/tools.js';
import type { SubagentConfig } from '@qwen-code/qwen-code-core/subagents/types.js';

const mocks = vi.hoisted(() => ({
  keyboard: [] as Array<(key: unknown) => void>,
  paste: [] as Array<(key: unknown) => void>,
  scrollBy: vi.fn(),
  width: 100,
  renderer: { suspend: vi.fn(), resume: vi.fn() },
  spawn: vi.fn(() => ({ status: 0, signal: null, error: undefined })),
  editor: vi.fn((_preferred: string, file: string) => ({
    command: 'vim',
    args: [file],
    needsShell: false,
  })),
}));
vi.mock(
  '@opentui/core',
  async () =>
    (await import('../../test-utils/opentui-catalog.js')).catalogNativeCore,
);
vi.mock('@opentui/react', async () => ({
  ...(await import('../../test-utils/opentui-catalog.js')).catalogHooks(
    mocks.keyboard,
    mocks.paste,
    () => ({ width: mocks.width, height: 40 }),
  ),
  useRenderer: () => mocks.renderer,
}));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    default: { ...actual, spawnSync: mocks.spawn },
    spawnSync: mocks.spawn,
  };
});
vi.mock(
  '@qwen-code/qwen-code-core/utils/editor.js',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('@qwen-code/qwen-code-core/utils/editor.js')
    >()),
    getExternalEditorCommand: mocks.editor,
    isValidEditorType: (value: string) => value === 'vim',
  }),
);
vi.mock('@opentui/react/jsx-runtime', async () =>
  (await import('../../test-utils/opentui-catalog.js')).catalogRuntime(
    false,
    mocks.scrollBy,
  ),
);
vi.mock('@opentui/react/jsx-dev-runtime', async () =>
  (await import('../../test-utils/opentui-catalog.js')).catalogRuntime(
    false,
    mocks.scrollBy,
  ),
);

import { OpenTuiSubagentListDialog } from './SubagentListDialog.js';
import { catalogDeferred } from '../../test-utils/opentui-catalog.js';

beforeEach(() => {
  expect(spawnSync).toBe(mocks.spawn);
  expect(childProcess.spawnSync).toBe(mocks.spawn);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.width = 100;
});

const agent: SubagentConfig = {
  name: 'owned-agent',
  description: 'Owned description.',
  systemPrompt: 'Owned prompt.',
  level: 'project',
  filePath: '/owned/.qwen/agents/owned-agent.md',
  tools: ['ReadFile'],
  color: 'Blue',
  model: 'owned-model',
};
function press(name: string, count = 1) {
  act(() => {
    for (let i = 0; i < count; i++)
      for (const listener of [...mocks.keyboard])
        listener({
          name,
          sequence: name === 'return' ? '\r' : name === 'escape' ? '\x1b' : '',
          eventType: 'press',
        });
  });
}
function fixture(
  result: Promise<SubagentConfig[]> = Promise.resolve([agent]),
  availableTerminalHeight?: number,
) {
  const listSubagents = vi.fn().mockReturnValue(result);
  const onClose = vi.fn();
  const updateSubagent = vi.fn(
    async (
      _name: string,
      _updates: Partial<SubagentConfig>,
      _level?: SubagentConfig['level'],
      options?: { assertCanCommit?: () => void },
    ) => {
      options?.assertCanCommit?.();
    },
  );
  const deleteSubagent = vi.fn(
    async (
      _name: string,
      _level?: SubagentConfig['level'],
      _extension?: string,
      options?: { assertCanCommit?: () => void },
    ) => {
      options?.assertCanCommit?.();
    },
  );
  const config = {
    getSubagentManager: () => ({
      listSubagents,
      updateSubagent,
      deleteSubagent,
    }),
    getToolRegistry: () => ({
      getAllTools: () => [
        { kind: Kind.Read, displayName: 'ReadFile' },
        { kind: Kind.Edit, displayName: 'EditFile' },
        { kind: Kind.Execute, displayName: 'Shell' },
      ],
    }),
  } as unknown as Config;
  const view = render(
    <OpenTuiSubagentListDialog
      config={config}
      settings={
        { merged: { general: { preferredEditor: 'vim' } } } as LoadedSettings
      }
      onClose={onClose}
      availableTerminalHeight={availableTerminalHeight}
    />,
  );
  return {
    ...view,
    listSubagents,
    onClose,
    updateSubagent,
    deleteSubagent,
    config,
  };
}

describe('native agent manager', () => {
  it.each([
    ['list', 0, '§'],
    ['actions', 1, '§'],
    ['detail', 2, agent.name],
  ] as const)(
    'keeps the narrow %s page compact when its footer wraps',
    async (_page, steps, name) => {
      mocks.width = 11;
      fixture(Promise.resolve([{ ...agent, name }]), 12);
      await screen.findByText(name === '§' ? name : '…');
      for (let step = 0; step < steps; step++) press('return');
      if (steps === 0) expect(screen.getByText('§')).toBeTruthy();
      else if (steps === 1) expect(screen.getAllByText('…')).toHaveLength(4);
      else expect(screen.getByText(agent.systemPrompt)).toBeTruthy();
      expect(screen.queryByText('Agents')).toBeNull();
      expect(screen.queryByText('Choose Action')).toBeNull();
      expect(
        screen.queryByText('Enter to select, ↑↓ to navigate, Esc to close'),
      ).toBeNull();
      expect(
        screen.queryByText('Enter to select, ↑↓ to navigate, Esc to go back'),
      ).toBeNull();
      expect(screen.queryByText('Esc to go back')).toBeNull();
    },
  );

  it('refreshes the public list and renders real choice labels and full details', async () => {
    const f = fixture();
    await screen.findByText(agent.name);
    expect(f.listSubagents).toHaveBeenCalledExactlyOnceWith({ force: true });
    expect(screen.queryByText('0')).toBeNull();
    press('return');
    expect(screen.getByText('Choose Action')).toBeTruthy();
    expect(screen.getByText('View Agent')).toBeTruthy();
    expect(screen.getByText('Back')).toBeTruthy();
    expect(screen.getByText('Edit Agent')).toBeTruthy();
    expect(screen.getByText('Delete Agent')).toBeTruthy();
    press('return');
    expect(
      screen.getByText(/File Path:.*\/owned\/\.qwen\/agents\/owned-agent.md/),
    ).toBeTruthy();
    expect(screen.getByText('Tools: ReadFile')).toBeTruthy();
    expect(screen.getByText('Model: owned-model')).toBeTruthy();
    expect(screen.getByText('Color: Blue')).toBeTruthy();
    expect(screen.getByText(agent.description)).toBeTruthy();
    expect(screen.getByText(agent.systemPrompt)).toBeTruthy();
    press('down');
    expect(mocks.scrollBy).toHaveBeenCalledWith(1);
    press('escape');
    expect(screen.getByText('Choose Action')).toBeTruthy();
    press('escape');
    expect(screen.getByText('Agents')).toBeTruthy();
    expect(f.onClose).not.toHaveBeenCalled();
    press('escape');
    expect(f.onClose).toHaveBeenCalledOnce();
    expect(f.listSubagents).toHaveBeenCalledOnce();
  });

  it('keeps the chosen full object and list highlight when returning', async () => {
    fixture(
      Promise.resolve([
        agent,
        {
          ...agent,
          name: 'extension-agent',
          level: 'extension',
          filePath: '/extension/agent.md',
          systemPrompt: 'Extension prompt.',
          tools: undefined,
          color: 'auto',
          model: undefined,
        },
      ]),
    );
    await screen.findByText('extension-agent');
    press('down');
    press('return');
    press('return');
    expect(screen.getByText('Extension prompt.')).toBeTruthy();
    expect(screen.getByText('Tools: *')).toBeTruthy();
    expect(screen.queryByText('Color: auto')).toBeNull();
    press('escape');
    press('down');
    press('return');
    expect(screen.getByText('Agents')).toBeTruthy();
    press('return');
    press('return');
    expect(screen.getByText('Extension prompt.')).toBeTruthy();
  });

  it('does not consume a second Enter or Escape through a stale page in one key burst', async () => {
    const f = fixture();
    await screen.findByText(agent.name);
    press('return', 2);
    expect(screen.getByText('Choose Action')).toBeTruthy();
    expect(screen.queryByText(agent.systemPrompt)).toBeNull();
    press('return');
    press('escape', 2);
    expect(screen.getByText('Choose Action')).toBeTruthy();
    expect(f.onClose).not.toHaveBeenCalled();
  });

  it('keeps loading and empty states distinct', async () => {
    const pending = catalogDeferred<SubagentConfig[]>();
    fixture(pending.promise);
    expect(screen.getByText('Loading...')).toBeTruthy();
    press('return');
    expect(screen.queryByText('Choose Action')).toBeNull();
    await act(async () => pending.resolve([]));
    expect(screen.getByText('No subagents found.')).toBeTruthy();
    expect(screen.queryByText('Loading...')).toBeNull();
  });

  it('shows a sanitized error without pretending loading succeeded empty', async () => {
    const pending = catalogDeferred<SubagentConfig[]>();
    fixture(pending.promise);
    await act(async () =>
      pending.reject(new Error('\x1b[31mCannot load agents\x1b[0m')),
    );
    expect(screen.getByText(/Cannot load agents/).textContent).not.toContain(
      '\x1b',
    );
    expect(screen.queryByText('No subagents found.')).toBeNull();
    press('return');
    expect(screen.queryByText('Choose Action')).toBeNull();
  });

  it('ignores a late list after close and removes keyboard listeners on unmount', async () => {
    const pending = catalogDeferred<SubagentConfig[]>();
    const f = fixture(pending.promise);
    press('escape');
    await act(async () => pending.resolve([agent]));
    expect(screen.queryByText(agent.name)).toBeNull();
    f.unmount();
    expect(mocks.keyboard).toEqual([]);
    press('return');
    expect(f.onClose).toHaveBeenCalledOnce();
  });

  it('rejects an old config result after a runtime-owner change', async () => {
    const old = catalogDeferred<SubagentConfig[]>();
    const f = fixture(old.promise);
    const newConfig = {
      getSubagentManager: () => ({
        listSubagents: () => Promise.resolve([{ ...agent, name: 'new-owner' }]),
      }),
    } as unknown as Config;
    f.rerender(
      <OpenTuiSubagentListDialog config={newConfig} onClose={f.onClose} />,
    );
    await screen.findByText('new-owner');
    await act(async () => old.resolve([agent]));
    expect(screen.queryByText(agent.name)).toBeNull();
    expect(screen.getByText('new-owner')).toBeTruthy();
  });

  it('discards a request that finishes after unmount', async () => {
    const pending = catalogDeferred<SubagentConfig[]>();
    const f = fixture(pending.promise);
    f.unmount();
    await act(async () => pending.resolve([agent]));
    expect(f.container.textContent).toBe('');
    expect(mocks.keyboard).toEqual([]);
    expect(f.onClose).not.toHaveBeenCalled();
  });
  async function editOptions(f: ReturnType<typeof fixture>) {
    await screen.findByText(agent.name);
    press('return');
    press('down');
    press('return');
    expect(screen.getByText('Open in editor')).toBeTruthy();
    return f;
  }
  it('commits only the selected tools field and exact project level', async () => {
    const f = await editOptions(fixture());
    press('down');
    press('return');
    press('up');
    await act(async () => press('return'));
    expect(f.updateSubagent).toHaveBeenCalledExactlyOnceWith(
      agent.name,
      { tools: [] },
      'project',
      { assertCanCommit: expect.any(Function) },
    );
    expect(f.deleteSubagent).not.toHaveBeenCalled();
    expect(f.listSubagents).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Open in editor')).toBeTruthy();
  });
  it('saves canonical green and preserves the selected identity', async () => {
    const f = await editOptions(fixture());
    press('down', 2);
    press('return');
    press('down');
    await act(async () => press('return'));
    expect(f.updateSubagent).toHaveBeenCalledExactlyOnceWith(
      agent.name,
      { color: 'green' },
      'project',
      { assertCanCommit: expect.any(Function) },
    );
  });
  it.each(['project', 'user'] as const)(
    'cancels and then single-flights deletion of the exact %s level',
    async (level) => {
      const f = fixture(Promise.resolve([{ ...agent, level }]));
      await screen.findByText(agent.name);
      press('return');
      press('down', 2);
      press('return');
      press('n');
      expect(f.deleteSubagent).not.toHaveBeenCalled();
      press('down', 2);
      press('return');
      const pending = catalogDeferred<void>();
      f.deleteSubagent.mockImplementation(
        async (_name, _level, _extension, options) => {
          options?.assertCanCommit?.();
          await pending.promise;
        },
      );
      f.listSubagents.mockResolvedValueOnce([]);
      press('return', 2);
      expect(f.deleteSubagent).toHaveBeenCalledExactlyOnceWith(
        agent.name,
        level,
        undefined,
        { assertCanCommit: expect.any(Function) },
      );
      await act(async () => pending.resolve());
      expect(screen.getByText('No subagents found.')).toBeTruthy();
      expect(f.updateSubagent).not.toHaveBeenCalled();
    },
  );
  it.each(['builtin', 'extension', 'session'] as const)(
    'keeps %s agents read-only',
    async (level) => {
      const f = fixture(
        Promise.resolve([{ ...agent, level, isBuiltin: level === 'builtin' }]),
      );
      await screen.findByText(agent.name);
      press('return');
      expect(screen.queryByText('Edit Agent')).toBeNull();
      expect(screen.queryByText('Delete Agent')).toBeNull();
      expect(f.updateSubagent).not.toHaveBeenCalled();
      expect(f.deleteSubagent).not.toHaveBeenCalled();
    },
  );
  it('retains an update error without retrying the write', async () => {
    const f = await editOptions(fixture());
    f.updateSubagent.mockRejectedValueOnce(new Error('Write denied'));
    press('down');
    press('return');
    await act(async () => press('return'));
    expect(screen.getByText('Write denied')).toBeTruthy();
    expect(f.updateSubagent).toHaveBeenCalledOnce();
    expect(f.listSubagents).toHaveBeenCalledOnce();
  });
  it('reports a committed change whose list refresh fails without repeating it', async () => {
    const f = await editOptions(fixture());
    f.listSubagents.mockRejectedValueOnce(new Error('Reload failed'));
    press('down');
    press('return');
    await act(async () => press('return'));
    expect(
      screen.getByText('Changes committed; refresh failed: Reload failed'),
    ).toBeTruthy();
    expect(f.updateSubagent).toHaveBeenCalledOnce();
  });
  it.each(['unmount', 'owner-change'])(
    'rejects a pending write at its public commit callback after %s',
    async (change) => {
      const f = await editOptions(fixture());
      const pending = catalogDeferred<void>();
      let refused = false;
      f.updateSubagent.mockImplementation(
        async (_name, _updates, _level, options) => {
          await pending.promise;
          try {
            options?.assertCanCommit?.();
          } catch (error) {
            refused = true;
            throw error;
          }
        },
      );
      press('down');
      press('return');
      press('return');
      if (change === 'unmount') f.unmount();
      else {
        const nextConfig = {
          getSubagentManager: () => ({
            listSubagents: async () => [{ ...agent, name: 'new-owner' }],
          }),
        } as unknown as Config;
        f.rerender(
          <OpenTuiSubagentListDialog config={nextConfig} onClose={f.onClose} />,
        );
        await screen.findByText('new-owner');
      }
      await act(async () => pending.resolve());
      expect(refused).toBe(true);
      expect(f.listSubagents).toHaveBeenCalledOnce();
    },
  );
  it('opens only the actual selected file once per Enter burst and restores the terminal', async () => {
    await editOptions(fixture());
    await act(async () => press('return', 2));
    expect(mocks.editor).toHaveBeenLastCalledWith('vim', agent.filePath);
    expect(mocks.spawn).toHaveBeenCalledExactlyOnceWith(
      'vim',
      [agent.filePath],
      { stdio: 'inherit', shell: false },
    );
    expect(mocks.renderer.suspend).toHaveBeenCalledOnce();
    expect(mocks.renderer.resume).toHaveBeenCalledOnce();
  });

  it('does not delete when the confirmation cannot be fully displayed', async () => {
    mocks.width = 11;
    const f = fixture(Promise.resolve([agent]), 1);
    await screen.findByText('…');
    press('return');
    press('down', 2);
    press('return');
    press('return');
    expect(f.deleteSubagent).not.toHaveBeenCalled();
    press('escape');
    expect(f.onClose).not.toHaveBeenCalled();
  });
  it('reports an editor failure and resumes before a later explicit retry', async () => {
    await editOptions(fixture());
    mocks.spawn.mockReturnValueOnce({
      status: 7,
      signal: null,
      error: undefined,
    });
    await act(async () => press('return'));
    expect(screen.getByText('Editor exited with status 7')).toBeTruthy();
    expect(mocks.renderer.resume).toHaveBeenCalledOnce();
    await act(async () => press('return'));
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
    expect(mocks.renderer.resume).toHaveBeenCalledTimes(2);
  });

  it('returns to the list instead of silently editing a different level after refresh', async () => {
    const f = await editOptions(fixture());
    f.listSubagents.mockResolvedValueOnce([{ ...agent, level: 'user' }]);
    press('down');
    press('return');
    await act(async () => press('return'));
    expect(screen.getByText('Agents')).toBeTruthy();
    expect(screen.queryByText('Open in editor')).toBeNull();
    expect(f.updateSubagent).toHaveBeenCalledOnce();
  });

  it.each(['%TARGET%', '!TARGET!', '"quoted"'])(
    'rejects shell interpolation in the actual editor path %s before launch',
    async (part) => {
      const filePath = ['C:', 'owned', part, 'agent.md'].join(
        String.fromCharCode(92),
      );
      expect(filePath).toContain(part);
      mocks.editor.mockImplementationOnce((_preferred, file) => ({
        command: 'code.cmd',
        args: [file, '--wait'],
        needsShell: true,
      }));
      await editOptions(fixture(Promise.resolve([{ ...agent, filePath }])));
      await act(async () => press('return'));
      expect(screen.getByText('Unsafe editor path or argument')).toBeTruthy();
      expect(mocks.spawn).not.toHaveBeenCalled();
      expect(mocks.renderer.suspend).not.toHaveBeenCalled();
      expect(mocks.renderer.resume).not.toHaveBeenCalled();
    },
  );
  it('preserves an ordinary space-containing shell editor path literally', async () => {
    const filePath = ['C:', 'owned space', 'agent.md'].join(
      String.fromCharCode(92),
    );
    expect(filePath).toContain('owned space');
    expect(filePath).toContain(String.fromCharCode(92));
    mocks.editor.mockImplementationOnce((_preferred, file) => ({
      command: 'code.cmd',
      args: [file, '--wait'],
      needsShell: true,
    }));
    await editOptions(fixture(Promise.resolve([{ ...agent, filePath }])));
    await act(async () => press('return'));
    expect(mocks.spawn).toHaveBeenCalledExactlyOnceWith(
      '"code.cmd"',
      [`"${filePath}"`, '"--wait"'],
      { stdio: 'inherit', shell: true },
    );
    expect(mocks.renderer.suspend).toHaveBeenCalledOnce();
    expect(mocks.renderer.resume).toHaveBeenCalledOnce();
  });
});
