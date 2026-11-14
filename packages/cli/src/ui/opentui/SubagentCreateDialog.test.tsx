/** @jsxImportSource @opentui/react */
// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import type {
  CreateSubagentOptions,
  SubagentConfig,
} from '@qwen-code/qwen-code-core/subagents/types.js';

const mocks = vi.hoisted(() => ({
  keyboard: [] as Array<(key: unknown) => void>,
  paste: [] as Array<(event: unknown) => void>,
  generate: vi.fn(),
}));
vi.mock('@qwen-code/qwen-code-core/utils/subagentGenerator.js', () => ({
  subagentGenerator: mocks.generate,
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
    () => ({ width: 110, height: 40 }),
  ),
);
vi.mock('@opentui/react/jsx-runtime', async () =>
  (await import('../../test-utils/opentui-catalog.js')).catalogRuntime(true),
);
vi.mock('@opentui/react/jsx-dev-runtime', async () =>
  (await import('../../test-utils/opentui-catalog.js')).catalogRuntime(true),
);

import { OpenTuiSubagentCreateDialog } from './SubagentCreateDialog.js';
import { catalogDeferred } from '../../test-utils/opentui-catalog.js';

afterEach(() => {
  cleanup();
  mocks.generate.mockReset();
});

function press(name: string, sequence = name, ctrl = false) {
  act(() => {
    for (const handler of [...mocks.keyboard])
      handler({ name, sequence, ctrl });
  });
}
function paste(text: string) {
  act(() => {
    for (const handler of [...mocks.paste])
      handler({
        bytes: Buffer.from(text),
        preventDefault: vi.fn(),
      });
  });
}
function burstReturn() {
  act(() => {
    for (let index = 0; index < 2; index++) {
      for (const handler of [...mocks.keyboard])
        handler({ name: 'return', sequence: '\r' });
    }
  });
}
function fixture(missingConfig = false) {
  const createSubagent = vi
    .fn<
      (agent: SubagentConfig, options: CreateSubagentOptions) => Promise<void>
    >()
    .mockResolvedValue(undefined);
  const loadSubagent = vi
    .fn<(name: string) => Promise<Pick<SubagentConfig, 'level'> | null>>()
    .mockResolvedValue(null);
  const onClose = vi.fn();
  const config = {
    getSubagentManager: () => ({ createSubagent, loadSubagent }),
    getToolRegistry: () => ({
      getAllTools: () => [
        { kind: 'read', displayName: 'ReadFile' },
        { kind: 'search', displayName: 'Grep' },
        { kind: 'edit', displayName: 'EditFile' },
        { kind: 'execute', displayName: 'Shell' },
      ],
    }),
  } as unknown as Config;
  const view = render(
    <OpenTuiSubagentCreateDialog
      config={missingConfig ? null : config}
      onClose={onClose}
    />,
  );
  return { createSubagent, loadSubagent, onClose, config, ...view };
}
function enterFields() {
  press('return');
  expect(screen.getByText('Step 2: Choose Generation Method')).toBeTruthy();
  expect(screen.getByText(/Generate with Qwen/)).toBeTruthy();
  press('down');
  press('return');
  expect(screen.getByText('Step 3: Enter Subagent Name')).toBeTruthy();
  paste('owned-proof');
  press('return');
  expect(screen.getByText('Step 4: Enter System Prompt')).toBeTruthy();
  paste('You are an owned agent.');
  press('return');
  expect(screen.getByText('Step 5: Enter Description')).toBeTruthy();
  paste('Owned agent description.');
  press('return');
  expect(screen.getByText('Step 6: Select Tools')).toBeTruthy();
}
async function finalStep(readOnly = false) {
  enterFields();
  if (readOnly) press('down');
  press('return');
  expect(screen.getByText('Step 7: Choose Background Color')).toBeTruthy();
  press('down');
  press('return');
  expect(screen.getByText('Step 8: Confirm and Save')).toBeTruthy();
  await screen.findByText('Press Enter to save, Esc to go back');
}

describe('native manual subagent creation', () => {
  it('cancels before touching the manager', () => {
    const f = fixture();
    press('escape');
    expect(f.onClose).toHaveBeenCalledTimes(1);
    expect(f.loadSubagent).not.toHaveBeenCalled();
    expect(f.createSubagent).not.toHaveBeenCalled();
  });

  it('paints Ink display labels through the actual selection component', () => {
    const f = fixture();
    expect(screen.getByText('Project Level (.qwen/agents/)')).toBeTruthy();
    expect(screen.getByText('User Level (~/.qwen/agents/)')).toBeTruthy();
    press('return');
    expect(screen.getByText('Manual Creation')).toBeTruthy();
    press('down');
    press('return');
    for (const value of ['owned-proof', 'Owned prompt', 'Owned description']) {
      paste(value);
      press('return');
    }
    for (const label of [
      'All Tools',
      'Read-only Tools',
      'Read & Edit Tools',
      'Read & Edit & Execution Tools',
    ]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    press('return');
    expect(screen.getByText('Automatic Color')).toBeTruthy();
    expect(screen.getByText('Blue')).toBeTruthy();
    expect(f.createSubagent).not.toHaveBeenCalled();
  });

  it('walks all eight steps and saves the exact public manager payload once', async () => {
    const f = fixture();
    await finalStep();
    burstReturn();
    expect(f.createSubagent).toHaveBeenCalledTimes(1);
    const [agent, options] = f.createSubagent.mock.calls[0];
    expect(agent).toEqual({
      name: 'owned-proof',
      description: 'Owned agent description.',
      systemPrompt: 'You are an owned agent.',
      level: 'project',
      filePath: '',
      tools: [],
      color: 'blue',
    });
    expect(options).toEqual({
      level: 'project',
      overwrite: true,
      assertCanCommit: expect.any(Function),
    });
    expect(() => options.assertCanCommit?.()).not.toThrow();
    await screen.findByText('✓ Subagent Created Successfully!');
    expect(screen.queryByText(/save and edit/)).toBeNull();
  });

  it('saves the selected user scope and actual registry read-only tools', async () => {
    const f = fixture();
    press('down');
    await finalStep(true);
    press('return');
    await waitFor(() => expect(f.createSubagent).toHaveBeenCalledTimes(1));
    expect(f.createSubagent.mock.calls[0][0]).toMatchObject({
      level: 'user',
      tools: ['Grep', 'ReadFile'],
    });
    expect(f.createSubagent.mock.calls[0][1].level).toBe('user');
  });

  it('validates text, supports undo, and preserves drafts when going back', () => {
    fixture();
    press('return');
    press('down');
    press('return');
    press('return');
    expect(screen.getByText('Step 3: Enter Subagent Name')).toBeTruthy();
    expect(screen.getByText('Please enter a value.')).toBeTruthy();
    paste('owned-proof');
    press('u', '', true);
    press('z', '', true);
    press('return');
    expect(screen.getByText('Step 4: Enter System Prompt')).toBeTruthy();
    paste('Preserved prompt');
    press('return');
    press('escape');
    expect(screen.getByText('Step 4: Enter System Prompt')).toBeTruthy();
    expect(screen.getByText('Preserved prompt')).toBeTruthy();
  });

  it('clears the manual name with Ctrl+C as one undoable edit without consuming propagation', () => {
    fixture();
    press('return');
    press('down');
    press('return');
    paste('owned-proof');
    const event = {
      name: 'c',
      sequence: '\x03',
      ctrl: true,
      shift: false,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };
    act(() => {
      for (const handler of [...mocks.keyboard]) handler(event);
    });
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopPropagation).not.toHaveBeenCalled();
    expect(screen.queryByText('owned-proof')).toBeNull();
    press('return');
    expect(screen.getByText('Step 3: Enter Subagent Name')).toBeTruthy();
    expect(screen.getByText('Please enter a value.')).toBeTruthy();
    press('z', '\x1a', true);
    expect(screen.getByText('owned-proof')).toBeTruthy();
    press('z', '\x1a', true);
    expect(screen.queryByText('owned-proof')).toBeNull();
  });

  it('preserves text for Ctrl+Shift+C and leaves ordinary Shift+C printable', () => {
    fixture();
    press('return');
    press('down');
    press('return');
    paste('owned-proof');
    const event = {
      name: 'c',
      sequence: '\x03',
      ctrl: true,
      shift: true,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };
    act(() => {
      for (const handler of [...mocks.keyboard]) handler(event);
    });
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopPropagation).not.toHaveBeenCalled();
    expect(screen.getByText('owned-proof')).toBeTruthy();
    act(() => {
      for (const handler of [...mocks.keyboard])
        handler({ name: 'c', sequence: 'C', ctrl: false, shift: true });
    });
    expect(screen.getByText('owned-proofC')).toBeTruthy();
  });

  it('does not advance two steps from a single-read Enter burst', () => {
    fixture();
    burstReturn();
    expect(screen.getByText('Step 2: Choose Generation Method')).toBeTruthy();
  });

  it('keeps fields and permits a real retry after a rejected save', async () => {
    const f = fixture();
    f.createSubagent.mockRejectedValueOnce(new Error('disk is full'));
    await finalStep();
    press('return');
    await screen.findByText(/disk is full/);
    expect(screen.getByText('Name: owned-proof')).toBeTruthy();
    press('return');
    await screen.findByText('✓ Subagent Created Successfully!');
    expect(f.createSubagent).toHaveBeenCalledTimes(2);
    expect(f.createSubagent.mock.calls[1][0]).toEqual(
      f.createSubagent.mock.calls[0][0],
    );
  });

  it('revokes the commit owner when closing an in-flight save', async () => {
    const f = fixture();
    let finish: (() => void) | undefined;
    f.createSubagent.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await finalStep();
    burstReturn();
    expect(f.createSubagent).toHaveBeenCalledTimes(1);
    const guard = f.createSubagent.mock.calls[0][1].assertCanCommit;
    press('escape');
    expect(f.onClose).toHaveBeenCalledTimes(1);
    expect(() => guard?.()).toThrow('Subagent creation cancelled');
    await act(async () => {
      finish?.();
    });
    expect(screen.queryByText('✓ Subagent Created Successfully!')).toBeNull();
  });

  it('revokes an in-flight save when its configuration owner changes', async () => {
    const f = fixture();
    let finish: (() => void) | undefined;
    f.createSubagent.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await finalStep();
    press('return');
    const guard = f.createSubagent.mock.calls[0][1].assertCanCommit;
    f.rerender(
      <OpenTuiSubagentCreateDialog
        config={{ ...f.config } as Config}
        onClose={f.onClose}
      />,
    );
    expect(() => guard?.()).toThrow('Subagent creation cancelled');
    await act(async () => {
      finish?.();
    });
    expect(screen.queryByText('✓ Subagent Created Successfully!')).toBeNull();
    expect(f.onClose).not.toHaveBeenCalled();
  });

  it('never revives a revoked save when the original configuration returns', async () => {
    const f = fixture();
    let finish: (() => void) | undefined;
    f.createSubagent.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await finalStep();
    press('return');
    expect(f.createSubagent).toHaveBeenCalledTimes(1);
    const guard = f.createSubagent.mock.calls[0][1].assertCanCommit;
    try {
      f.rerender(
        <OpenTuiSubagentCreateDialog
          config={{ ...f.config } as Config}
          onClose={f.onClose}
        />,
      );
      expect(() => guard?.()).toThrow('Subagent creation cancelled');
      f.rerender(
        <OpenTuiSubagentCreateDialog config={f.config} onClose={f.onClose} />,
      );
      expect(() => guard?.()).toThrow('Subagent creation cancelled');
    } finally {
      await act(async () => {
        finish?.();
      });
    }
    expect(screen.queryByText('✓ Subagent Created Successfully!')).toBeNull();
    expect(screen.getByText('Saving… Esc to close')).toBeTruthy();
    press('return');
    expect(f.createSubagent).toHaveBeenCalledTimes(1);
    expect(f.onClose).not.toHaveBeenCalled();
  });

  it('ignores a rejected save after its revoked configuration returns', async () => {
    const f = fixture();
    let reject: ((error: Error) => void) | undefined;
    f.createSubagent.mockImplementation(
      () =>
        new Promise<void>((_resolve, rejectSave) => {
          reject = rejectSave;
        }),
    );
    await finalStep();
    press('return');
    f.rerender(
      <OpenTuiSubagentCreateDialog
        config={{ ...f.config } as Config}
        onClose={f.onClose}
      />,
    );
    f.rerender(
      <OpenTuiSubagentCreateDialog config={f.config} onClose={f.onClose} />,
    );
    await act(async () => {
      reject?.(new Error('old owner failed'));
    });
    expect(screen.queryByText(/old owner failed/)).toBeNull();
    expect(screen.getByText('Saving… Esc to close')).toBeTruthy();
    press('return');
    expect(f.createSubagent).toHaveBeenCalledTimes(1);
    expect(f.onClose).not.toHaveBeenCalled();
  });

  it('revokes an in-flight save after unmount without closing another dialog', async () => {
    const f = fixture();
    let finish: (() => void) | undefined;
    f.createSubagent.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await finalStep();
    press('return');
    const guard = f.createSubagent.mock.calls[0][1].assertCanCommit;
    f.unmount();
    expect(() => guard?.()).toThrow('Subagent creation cancelled');
    await act(async () => {
      finish?.();
    });
    expect(f.onClose).not.toHaveBeenCalled();
    expect(mocks.keyboard).toEqual([]);
  });

  it('waits for the name-conflict warning before accepting overwrite', async () => {
    const f = fixture();
    let finish: ((value: Pick<SubagentConfig, 'level'>) => void) | undefined;
    f.loadSubagent.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    enterFields();
    press('return');
    press('return');
    press('return');
    expect(f.createSubagent).not.toHaveBeenCalled();
    await waitFor(() => expect(f.loadSubagent).toHaveBeenCalledTimes(1));
    await act(async () => {
      finish?.({ level: 'project' });
    });
    await screen.findByText(/will overwrite existing subagent/);
    press('return');
    expect(f.createSubagent).toHaveBeenCalledTimes(1);
  });

  it('refuses overwrite when the existing-name check fails', async () => {
    const f = fixture();
    f.loadSubagent.mockRejectedValueOnce(new Error('read denied'));
    enterFields();
    press('return');
    press('return');
    await screen.findByText(/Unable to check existing subagents/);
    press('return');
    expect(f.createSubagent).not.toHaveBeenCalled();
    press('escape');
    expect(screen.getByText('Step 7: Choose Background Color')).toBeTruthy();
  });

  it('reports missing config without losing the entered form', async () => {
    fixture(true);
    await finalStep();
    press('return');
    await screen.findByText(/Configuration not available/);
    expect(screen.getByText('Name: owned-proof')).toBeTruthy();
  });
});

describe('native guided subagent creation', () => {
  const generated = {
    name: 'owned-generated',
    description: 'Generated description.',
    systemPrompt: 'Owned generated prompt.',
  };
  function description(missingConfig = false) {
    const f = fixture(missingConfig);
    press('return');
    press('return');
    expect(screen.getByText('Step 3: Describe Your Subagent')).toBeTruthy();
    return f;
  }
  it.each(['', '   '])(
    'refuses a blank description %j without issuing a request',
    (value) => {
      const f = description();
      if (value) paste(value);
      press('return');
      expect(screen.getByText('Please enter a value.')).toBeTruthy();
      expect(mocks.generate).not.toHaveBeenCalled();
      expect(f.createSubagent).not.toHaveBeenCalled();
    },
  );
  it('generates once per Enter burst and saves only after explicit review', async () => {
    const pending = catalogDeferred<typeof generated>();
    mocks.generate.mockReturnValue(pending.promise);
    const f = description();
    paste('  Describe this owned agent.  ');
    burstReturn();
    expect(mocks.generate).toHaveBeenCalledExactlyOnceWith(
      'Describe this owned agent.',
      f.config,
      expect.any(AbortSignal),
    );
    expect(f.createSubagent).not.toHaveBeenCalled();
    expect(
      screen.getByText('Generating subagent configuration...'),
    ).toBeTruthy();
    paste('must not change pending description');
    await act(async () => pending.resolve(generated));
    expect(screen.getByText('Step 4: Select Tools')).toBeTruthy();
    press('return');
    expect(screen.getByText('Step 5: Choose Background Color')).toBeTruthy();
    press('down');
    press('return');
    expect(screen.getByText('Step 6: Confirm and Save')).toBeTruthy();
    await screen.findByText('Press Enter to save, Esc to go back');
    expect(f.createSubagent).not.toHaveBeenCalled();
    burstReturn();
    expect(f.createSubagent).toHaveBeenCalledTimes(1);
    expect(f.createSubagent.mock.calls[0][0]).toEqual({
      ...generated,
      level: 'project',
      filePath: '',
      tools: [],
      color: 'blue',
    });
  });
  it('aborts generation on Escape, retains text and ignores a late success', async () => {
    const pending = catalogDeferred<typeof generated>();
    mocks.generate.mockReturnValue(pending.promise);
    const f = description();
    paste('Keep this description.');
    press('return');
    const signal = mocks.generate.mock.calls[0][2];
    press('escape');
    expect(signal.aborted).toBe(true);
    expect(screen.getByText('Keep this description.')).toBeTruthy();
    await act(async () => pending.resolve(generated));
    expect(screen.getByText('Step 3: Describe Your Subagent')).toBeTruthy();
    expect(f.createSubagent).not.toHaveBeenCalled();
    press('escape');
    expect(screen.getByText('Step 2: Choose Generation Method')).toBeTruthy();
  });
  it.each(['unmount', 'config-change'] as const)(
    'revokes a pending generation after %s',
    async (change) => {
      const pending = catalogDeferred<typeof generated>();
      mocks.generate.mockReturnValue(pending.promise);
      const f = description();
      paste('Owned pending request.');
      press('return');
      const signal = mocks.generate.mock.calls[0][2];
      if (change === 'unmount') f.unmount();
      else
        f.rerender(
          <OpenTuiSubagentCreateDialog
            config={{ ...f.config } as Config}
            onClose={f.onClose}
          />,
        );
      expect(signal.aborted).toBe(true);
      await act(async () => pending.resolve(generated));
      expect(f.createSubagent).not.toHaveBeenCalled();
      if (change === 'config-change')
        expect(screen.getByText('Step 3: Describe Your Subagent')).toBeTruthy();
    },
  );
  it('keeps the active retry pending when an aborted older request rejects', async () => {
    const old = catalogDeferred<typeof generated>();
    const current = catalogDeferred<typeof generated>();
    mocks.generate
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(current.promise);
    description();
    paste('Retry this description.');
    press('return');
    press('escape');
    press('return');
    expect(mocks.generate).toHaveBeenCalledTimes(2);
    await act(async () => old.reject(new Error('Old transport closed')));
    expect(
      screen.getByText('Generating subagent configuration...'),
    ).toBeTruthy();
    expect(mocks.generate.mock.calls[1][2].aborted).toBe(false);
    await act(async () => current.resolve(generated));
    expect(screen.getByText('Step 4: Select Tools')).toBeTruthy();
  });
  it('reports active errors and requires an explicit retry', async () => {
    mocks.generate
      .mockRejectedValueOnce(new Error('Owned generation failure'))
      .mockResolvedValueOnce(generated);
    const f = description();
    paste('Retry after error.');
    await act(async () => press('return'));
    expect(
      screen.getByText('Failed to generate subagent: Owned generation failure'),
    ).toBeTruthy();
    expect(screen.getByText('Retry after error.')).toBeTruthy();
    expect(mocks.generate).toHaveBeenCalledTimes(1);
    expect(f.createSubagent).not.toHaveBeenCalled();
    await act(async () => press('return'));
    expect(mocks.generate).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Step 4: Select Tools')).toBeTruthy();
  });

  it.each(['resolve', 'reject'] as const)(
    'does not revive an old generation after an owner ABA and late %s',
    async (completion) => {
      const old = catalogDeferred<typeof generated>();
      const current = catalogDeferred<typeof generated>();
      mocks.generate
        .mockReturnValueOnce(old.promise)
        .mockReturnValueOnce(current.promise);
      const f = description();
      paste('Owned ABA request.');
      press('return');
      const signal = mocks.generate.mock.calls[0][2];
      f.rerender(
        <OpenTuiSubagentCreateDialog
          config={{ ...f.config } as Config}
          onClose={f.onClose}
        />,
      );
      f.rerender(
        <OpenTuiSubagentCreateDialog config={f.config} onClose={f.onClose} />,
      );
      expect(signal.aborted).toBe(true);
      press('return');
      expect(mocks.generate).toHaveBeenCalledTimes(2);
      await act(async () => {
        if (completion === 'resolve') old.resolve(generated);
        else old.reject(new Error('Old ABA request failed'));
      });
      expect(screen.getByText('Step 3: Describe Your Subagent')).toBeTruthy();
      expect(
        screen.getByText('Generating subagent configuration...'),
      ).toBeTruthy();
      expect(screen.queryByText(/Old ABA request failed/)).toBeNull();
      expect(mocks.generate.mock.calls[1][2].aborted).toBe(false);
      expect(f.createSubagent).not.toHaveBeenCalled();
      await act(async () => current.resolve(generated));
      expect(screen.getByText('Step 4: Select Tools')).toBeTruthy();
    },
  );

  it('shows an active transport AbortError without pretending the user cancelled', async () => {
    const error = new Error('Provider cancelled unexpectedly');
    error.name = 'AbortError';
    mocks.generate.mockRejectedValueOnce(error);
    description();
    paste('Owned request.');
    await act(async () => press('return'));
    expect(
      screen.getByText(
        'Failed to generate subagent: Provider cancelled unexpectedly',
      ),
    ).toBeTruthy();
    expect(mocks.generate.mock.calls[0][2].aborted).toBe(false);
    expect(mocks.generate).toHaveBeenCalledTimes(1);
  });

  it('reports missing config without a generation or save request', () => {
    const f = description(true);
    paste('Missing runtime.');
    press('return');
    expect(screen.getByText('Configuration not available')).toBeTruthy();
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(f.createSubagent).not.toHaveBeenCalled();
  });
});
