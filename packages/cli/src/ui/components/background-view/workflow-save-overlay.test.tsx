/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act } from '@testing-library/react';
import { render } from 'ink-testing-library';

vi.mock('../../hooks/useKeypress.js', () => ({ useKeypress: vi.fn() }));
vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>();
  return { ...actual, saveWorkflowScript: vi.fn() };
});

import { useKeypress, type Key } from '../../hooks/useKeypress.js';
import { saveWorkflowScript, type Config } from '@qwen-code/qwen-code-core';
import { WorkflowSaveOverlay } from './workflow-save-overlay.js';

const mockedUseKeypress = vi.mocked(useKeypress);
const mockedSave = vi.mocked(saveWorkflowScript);

function key(partial: Partial<Key>): Key {
  return {
    name: '',
    ctrl: false,
    meta: false,
    shift: false,
    paste: false,
    sequence: '',
    ...partial,
  };
}

function setup(props: Partial<Parameters<typeof WorkflowSaveOverlay>[0]> = {}) {
  const handlers: Array<(k: Key) => void> = [];
  mockedUseKeypress.mockImplementation((cb, opts) => {
    if (opts?.isActive !== false) handlers.push(cb as (k: Key) => void);
  });
  const onClose = vi.fn();
  const { lastFrame } = render(
    <WorkflowSaveOverlay
      script="return 1;"
      config={{} as Config}
      isActive
      onClose={onClose}
      {...props}
    />,
  );
  const press = async (k: Partial<Key>) => {
    await act(async () => {
      handlers[handlers.length - 1]?.(key(k));
    });
  };
  const type = async (text: string) => {
    for (const ch of text) await press({ name: ch, sequence: ch });
  };
  return { lastFrame, press, type, onClose };
}

describe('WorkflowSaveOverlay', () => {
  beforeEach(() => {
    mockedSave.mockReset();
  });

  it('renders the name field, scope toggle, and hints in edit phase', () => {
    const { lastFrame } = setup();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Save workflow');
    expect(frame).toContain('project');
    expect(frame).toContain('user');
    expect(frame).toContain('Enter save');
  });

  it('appends typed characters to the name', async () => {
    const { lastFrame, type } = setup();
    await type('flow');
    expect(lastFrame() ?? '').toContain('flow');
  });

  it('saves to project scope on submit, then closes on the next key', async () => {
    mockedSave.mockResolvedValue({
      status: 'saved',
      name: 'flow',
      scope: 'project',
      path: '/proj/.qwen/workflows/flow.js',
    });
    const { lastFrame, type, press, onClose } = setup();
    await type('flow');
    await press({ name: 'return' });
    expect(mockedSave).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        name: 'flow',
        scope: 'project',
        script: 'return 1;',
        overwrite: false,
      }),
    );
    expect(lastFrame() ?? '').toContain('Saved to /proj/.qwen/workflows/flow.js');
    await press({ name: 'return' });
    expect(onClose).toHaveBeenCalledWith('flow');
  });

  it('Tab toggles to user scope', async () => {
    mockedSave.mockResolvedValue({
      status: 'saved',
      name: 'flow',
      scope: 'user',
      path: '/home/.qwen/workflows/flow.js',
    });
    const { type, press } = setup();
    await type('flow');
    await press({ name: 'tab' });
    await press({ name: 'return' });
    expect(mockedSave).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ scope: 'user' }),
    );
  });

  it('rejects an invalid name without calling save', async () => {
    const { type, press, lastFrame } = setup();
    await type('Bad'); // leading uppercase → invalid
    await press({ name: 'return' });
    expect(mockedSave).not.toHaveBeenCalled();
    expect(lastFrame() ?? '').toMatch(/Invalid workflow name|lower-case/);
  });

  it('Esc cancels without saving', async () => {
    const { press, onClose } = setup();
    await press({ name: 'escape' });
    expect(onClose).toHaveBeenCalledWith();
    expect(mockedSave).not.toHaveBeenCalled();
  });

  it('prompts to overwrite on collision and retries with overwrite:true', async () => {
    mockedSave
      .mockResolvedValueOnce({
        status: 'exists',
        name: 'flow',
        scope: 'project',
        path: '/proj/.qwen/workflows/flow.js',
      })
      .mockResolvedValueOnce({
        status: 'saved',
        name: 'flow',
        scope: 'project',
        path: '/proj/.qwen/workflows/flow.js',
      });
    const { type, press, lastFrame } = setup();
    await type('flow');
    await press({ name: 'return' });
    expect(lastFrame() ?? '').toContain('already exists');
    await press({ name: 'y', sequence: 'y' });
    expect(mockedSave).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ overwrite: true }),
    );
  });
});
