/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { cleanup, render } from 'ink-testing-library';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KeypressProvider } from '../contexts/KeypressContext.js';
import { AgentViewRoster } from './AgentViewRoster.js';

vi.mock('../../services/BuiltinCommandLoader.js', () => ({
  BuiltinCommandLoader: class {
    loadCommands() {
      return Promise.resolve([]);
    }
  },
}));

describe('AgentViewRoster terminal input', () => {
  afterEach(cleanup);

  it('drops terminal responses after Ink strips their ESC prefix', async () => {
    const onPromptChange = vi.fn();
    const onCancel = vi.fn();
    const onDispatch = vi.fn(() => true);
    const { stdin } = render(
      <KeypressProvider kittyProtocolEnabled={false}>
        <AgentViewRoster
          rows={[]}
          prompt=""
          selectedIndex={0}
          groupMode="state"
          onPromptChange={onPromptChange}
          onPeekPromptChange={vi.fn()}
          onDispatch={onDispatch}
          onSubmitPeekPrompt={vi.fn(() => true)}
          onAttachSession={vi.fn()}
          onPeekSession={vi.fn()}
          onTogglePinSession={vi.fn()}
          onRenameSession={vi.fn()}
          onStopOrRemoveSession={vi.fn()}
          onToggleGroupMode={vi.fn()}
          onShowHelp={vi.fn()}
          onInterrupt={vi.fn()}
          onMoveSelection={vi.fn()}
          onCancel={onCancel}
        />
      </KeypressProvider>,
    );

    stdin.write('\x1b[?1;2c');
    stdin.write('\x1b[27;2;13~');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(onPromptChange).not.toHaveBeenCalled();
    expect(onDispatch).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });
});
