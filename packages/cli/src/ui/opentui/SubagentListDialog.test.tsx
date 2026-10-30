/** @jsxImportSource @opentui/react */
// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import type { SubagentConfig } from '@qwen-code/qwen-code-core/subagents/types.js';

const mocks = vi.hoisted(() => ({
  keyboard: [] as Array<(key: unknown) => void>,
  paste: [] as Array<(key: unknown) => void>,
  scrollBy: vi.fn(),
}));
vi.mock(
  '@opentui/core',
  async () =>
    (await import('../../test-utils/opentui-catalog.js')).catalogNativeCore,
);
vi.mock('@opentui/react', async () =>
  (await import('../../test-utils/opentui-catalog.js')).catalogHooks(
    mocks.keyboard,
    mocks.paste,
    () => ({ width: 100, height: 40 }),
  ),
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

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
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
function fixture(result: Promise<SubagentConfig[]> = Promise.resolve([agent])) {
  const listSubagents = vi.fn().mockReturnValue(result);
  const onClose = vi.fn();
  const config = {
    getSubagentManager: () => ({ listSubagents }),
  } as unknown as Config;
  const view = render(
    <OpenTuiSubagentListDialog config={config} onClose={onClose} />,
  );
  return { ...view, listSubagents, onClose };
}

describe('native read-only agent manager', () => {
  it('refreshes the public list and renders real choice labels and full details', async () => {
    const f = fixture();
    await screen.findByText(agent.name);
    expect(f.listSubagents).toHaveBeenCalledExactlyOnceWith({ force: true });
    expect(screen.queryByText('0')).toBeNull();
    press('return');
    expect(screen.getByText('Choose Action')).toBeTruthy();
    expect(screen.getByText('View Agent')).toBeTruthy();
    expect(screen.getByText('Back')).toBeTruthy();
    expect(screen.queryByText('Edit Agent')).toBeNull();
    expect(screen.queryByText('Delete Agent')).toBeNull();
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
});
