/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Message,
  RewindCandidate,
  UserMessage,
} from '@qwen-code/core';
import { waitFor } from '../../test-utils/async.js';
import { renderWithProviders } from '../../test-utils/render.js';
import { RewindDialog } from './RewindDialog.js';

function createCandidate(
  index: number,
  text = `message ${index}`,
): RewindCandidate {
  const message: UserMessage = {
    type: 'user',
    uuid: `user-${index}`,
    timestamp: new Date(Date.now() - index * 5 * 60_000).toISOString(),
    promptId: `prompt-${index}`,
    message: {
      role: 'user',
      content: text,
    },
  };
  return {
    message,
    displayText: text.replace(/\s+/g, ' ').trim(),
    prefillText: text,
    inputMode: 'prompt',
  };
}

describe('RewindDialog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-04T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('默认选中当前输入位置，回车会直接关闭选择器', async () => {
    const onClose = vi.fn();
    const onRestoreConversation = vi.fn().mockResolvedValue(undefined);
    const onRestoreFiles = vi.fn().mockResolvedValue(undefined);
    const onRestoreBoth = vi.fn().mockResolvedValue(undefined);

    const messages: RewindCandidate[] = [
      createCandidate(1),
      createCandidate(2),
    ];
    const allMessages: Message[] = messages.map(({ message }) => message);

    const { stdin, lastFrame, unmount } = await renderWithProviders(
        <RewindDialog
          messages={messages}
          allMessages={allMessages}
          onClose={onClose}
          onRestoreConversation={onRestoreConversation}
          onRestoreFiles={onRestoreFiles}
          onRestoreBoth={onRestoreBoth}
        />,
      );

    expect(lastFrame()).toContain('(current)');

    await act(async () => {
      stdin.write('\r');
    });

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onRestoreBoth).not.toHaveBeenCalled();
    expect(onRestoreConversation).not.toHaveBeenCalled();
    expect(onRestoreFiles).not.toHaveBeenCalled();

    unmount();
  });

  it('shows unavailable files in the rewind preview without hiding healthy restores', async () => {
    const messages = [createCandidate(1)];
    const { stdin, lastFrame, unmount } = await renderWithProviders(
      <RewindDialog
        messages={messages}
        allMessages={messages.map(({ message }) => message)}
        fileHistory={
          {
            canRewind: () => true,
            getDiffStats: async () => ({
              filesChanged: ['a.ts'],
              insertions: 1,
              deletions: 0,
              failedFiles: [{ path: 'b.ts', error: 'missing backup' }],
            }),
          } as never
        }
        onClose={vi.fn()}
        onRestoreConversation={vi.fn()}
        onRestoreFiles={vi.fn()}
        onRestoreBoth={vi.fn()}
      />,
    );
    try {
      await act(async () => {
        stdin.write('\u001B[A');
      });
      await act(async () => {
        stdin.write('\r');
      });
      await waitFor(() =>
        expect(lastFrame()).toContain('have no usable backup'),
      );
      expect(lastFrame()).toContain('b.ts');
      expect(lastFrame()).toContain('f files only');
    } finally {
      unmount();
    }
  });

  it('从当前输入位置移到历史消息后，按两次回车会先进入确认页，再执行恢复文件和对话', async () => {
    const onClose = vi.fn();
    const onRestoreConversation = vi.fn().mockResolvedValue(undefined);
    const onRestoreFiles = vi.fn().mockResolvedValue(undefined);
    const onRestoreBoth = vi.fn().mockResolvedValue(undefined);
    const fileHistory = {
      canRewind: vi.fn().mockReturnValue(true),
      getDiffStats: vi.fn().mockResolvedValue({
        filesChanged: ['a.ts'],
        insertions: 1,
        deletions: 0,
      }),
    };

    const messages: RewindCandidate[] = [
      createCandidate(1),
      createCandidate(2),
    ];
    const allMessages: Message[] = messages.map(({ message }) => message);

    const { stdin, lastFrame, unmount } = await renderWithProviders(
        <RewindDialog
          messages={messages}
          allMessages={allMessages}
          fileHistory={fileHistory as never}
          onClose={onClose}
          onRestoreConversation={onRestoreConversation}
          onRestoreFiles={onRestoreFiles}
          onRestoreBoth={onRestoreBoth}
        />,
      );

    await act(async () => {
      stdin.write('\u001B[A');
    });

    await act(async () => {
      stdin.write('\r');
    });

    await waitFor(() => {
      expect(lastFrame()).toContain('Confirm this rewind point:');
      expect(lastFrame()).toContain(
        'If you rewind now, a.ts would be restored (+1 -0).',
      );
    });
    expect(lastFrame()).toContain('Choose what to restore from this point.');
    expect(lastFrame()).toContain(
      'Files edited manually or via shell may not be restored by rewind.',
    );
    const warningIndex = lastFrame().indexOf(
      'Files edited manually or via shell may not be restored by rewind.',
    );
    const shortcutIndex = lastFrame().indexOf('Enter files and conversation');
    expect(warningIndex).toBeGreaterThan(-1);
    expect(shortcutIndex).toBeGreaterThan(-1);
    expect(warningIndex).toBeLessThan(shortcutIndex);
    expect(onRestoreBoth).not.toHaveBeenCalled();

    await act(async () => {
      stdin.write('\r');
    });

    await waitFor(() =>
      expect(onRestoreBoth).toHaveBeenCalledWith(messages[1]),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onRestoreConversation).not.toHaveBeenCalled();
    expect(onRestoreFiles).not.toHaveBeenCalled();

    unmount();
  });

  it('没有文件 checkpoint 时回车默认只恢复会话并隐藏文件快捷键', async () => {
    const onRestoreConversation = vi.fn().mockResolvedValue(undefined);
    const onRestoreFiles = vi.fn().mockResolvedValue(undefined);
    const onRestoreBoth = vi.fn().mockResolvedValue(undefined);
    const messages = [createCandidate(1), createCandidate(2)];
    const fileHistory = {
      canRewind: vi.fn().mockReturnValue(false),
      getDiffStats: vi.fn(),
    };
    const { stdin, lastFrame, unmount } = await renderWithProviders(
        <RewindDialog
          messages={messages}
          allMessages={messages.map(({ message }) => message)}
          fileHistory={fileHistory as never}
          onClose={vi.fn()}
          onRestoreConversation={onRestoreConversation}
          onRestoreFiles={onRestoreFiles}
          onRestoreBoth={onRestoreBoth}
        />,
      );

    await act(async () => {
      stdin.write('\u001B[A');
    });
    await act(async () => {
      stdin.write('\r');
    });
    await waitFor(() =>
      expect(lastFrame()).toContain(
        'Conversation will be restored. Files will stay as they are now.',
      ),
    );
    expect(lastFrame()).not.toContain('Enter files and conversation');
    expect(lastFrame()).not.toContain('F files only');

    await act(async () => {
      stdin.write('f');
    });
    expect(onRestoreFiles).not.toHaveBeenCalled();

    await act(async () => {
      stdin.write('\r');
    });
    await waitFor(() =>
      expect(onRestoreConversation).toHaveBeenCalledWith(messages[1]),
    );
    expect(onRestoreBoth).not.toHaveBeenCalled();
    expect(onRestoreFiles).not.toHaveBeenCalled();
    unmount();
  });

  it('直接渲染 candidate displayText，不再按固定字符数截断', async () => {
    const suffix = 'UNIQUE_REWIND_DISPLAY_SUFFIX';
    const longText = `${'long prompt segment '.repeat(6)}${suffix}`;
    const candidate = createCandidate(1, `source text ignored ${suffix}`);
    candidate.displayText = longText;

    const { lastFrame, unmount } = await renderWithProviders(
      <RewindDialog
        messages={[candidate]}
        allMessages={[candidate.message]}
        onClose={vi.fn()}
        onRestoreConversation={vi.fn().mockResolvedValue(undefined)}
        onRestoreFiles={vi.fn().mockResolvedValue(undefined)}
        onRestoreBoth={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(lastFrame()).toContain(suffix);
    unmount();
  });

  it('列表会显示这一轮的文件变更摘要，确认页显示目标回退摘要', async () => {
    const firstMessage = createCandidate(1);
    const secondMessage = createCandidate(2);
    const toolResultMessage: Message = {
      type: 'user',
      uuid: 'tool-result-1',
      timestamp: new Date().toISOString(),
      promptId: 'prompt-1',
      sourceToolAssistantUUID: 'assistant-1',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool-1',
            content: 'ok',
            is_error: false,
          },
        ],
      },
      toolUseResult: {
        fileDiff: '@@ -1 +1 @@',
        fileName: 'a.ts',
        filePath: '/tmp/a.ts',
        originalContent: 'before',
        newContent: 'after',
        diffStat: {
          model_added_lines: 3,
          model_removed_lines: 1,
          model_added_chars: 0,
          model_removed_chars: 0,
          user_added_lines: 0,
          user_removed_lines: 0,
          user_added_chars: 0,
          user_removed_chars: 0,
        },
      },
    };

    const fileHistory = {
      canRewind: vi.fn().mockReturnValue(true),
      getDiffStats: vi.fn().mockResolvedValue({
        filesChanged: ['/tmp/a.ts', '/tmp/b.ts'],
        insertions: 10,
        deletions: 4,
      }),
    };

    const { stdin, lastFrame, unmount } = await renderWithProviders(
        <RewindDialog
          messages={[firstMessage, secondMessage]}
          allMessages={[
            firstMessage.message,
            toolResultMessage,
            secondMessage.message,
          ]}
          fileHistory={fileHistory as never}
          onClose={vi.fn()}
          onRestoreConversation={vi.fn().mockResolvedValue(undefined)}
          onRestoreFiles={vi.fn().mockResolvedValue(undefined)}
          onRestoreBoth={vi.fn().mockResolvedValue(undefined)}
        />,
      );

    await waitFor(() => {
      expect(lastFrame()).toContain('(current)');
      expect(lastFrame()).toContain(
        'Each entry shows changes made after that message.',
      );
      expect(lastFrame()).toContain('5m · a.ts · +3 -1');
    });

    await act(async () => {
      stdin.write('\u001B[A');
      stdin.write('\u001B[A');
    });

    await act(async () => {
      stdin.write('\r');
    });

    await waitFor(() =>
      expect(lastFrame()).toContain(
        'If you rewind now, a.ts and b.ts would be restored (+10 -4).',
      ),
    );

    unmount();
  });

  it('长会话里选中更早消息时可视窗口会跟随移动', async () => {
    const messages: RewindCandidate[] = Array.from(
      { length: 15 },
      (_, index) => createCandidate(index + 1),
    );

    const { stdin, lastFrame, unmount } = await renderWithProviders(
        <RewindDialog
          messages={messages}
          allMessages={messages.map(({ message }) => message)}
          fileHistory={
            {
              canRewind: vi.fn().mockReturnValue(false),
              getDiffStats: vi.fn(),
            } as never
          }
          onClose={vi.fn()}
          onRestoreConversation={vi.fn().mockResolvedValue(undefined)}
          onRestoreFiles={vi.fn().mockResolvedValue(undefined)}
          onRestoreBoth={vi.fn().mockResolvedValue(undefined)}
        />,
      );

    expect(lastFrame()).toContain('message 15');
    expect(lastFrame()).toContain('(current)');
    expect(lastFrame()).toContain('↑ 9 earlier messages');

    await act(async () => {
      for (let i = 0; i < 14; i += 1) {
        stdin.write('\u001B[A');
      }
    });

    let output = '';
    await waitFor(() => {
      output = lastFrame();
      expect(output).toContain('message 2');
      expect(output).not.toContain('message 15');
      expect(output).toContain('↓ 9 later messages');
    });

    unmount();
  });

  it('列表项会显示相对时间，帮助区分回退点', async () => {
    const messages: RewindCandidate[] = [
      createCandidate(1),
      createCandidate(2),
    ];

    const { lastFrame, unmount } = await renderWithProviders(
      <RewindDialog
        messages={messages}
        allMessages={messages.map(({ message }) => message)}
        fileHistory={
          {
            canRewind: vi.fn().mockReturnValue(false),
            getDiffStats: vi.fn(),
          } as never
        }
        onClose={vi.fn()}
        onRestoreConversation={vi.fn().mockResolvedValue(undefined)}
        onRestoreFiles={vi.fn().mockResolvedValue(undefined)}
        onRestoreBoth={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    await waitFor(() => {
      expect(lastFrame()).toContain('5m · No file changes in that step');
      expect(lastFrame()).toContain('10m · No file changes in that step');
    });

    unmount();
  });

  describe('长时间恢复时的忙碌态', () => {
    /**
     * Drives the dialog to the confirm page and starts a restore that never
     * settles, so the dialog stays in its busy state.
     */
    async function startPendingRestore() {
      let rejectRestore: ((error: unknown) => void) | undefined;
      const onClose = vi.fn();
      const onBackgroundError = vi.fn();
      const onRestoreConversation = vi.fn().mockImplementation(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectRestore = reject;
          }),
      );
      const messages = [createCandidate(1), createCandidate(2)];

      const rendered = await renderWithProviders(
        <RewindDialog
          messages={messages}
          allMessages={messages.map(({ message }) => message)}
          onClose={onClose}
          onRestoreConversation={onRestoreConversation}
          onRestoreFiles={vi.fn().mockResolvedValue(undefined)}
          onRestoreBoth={vi.fn().mockResolvedValue(undefined)}
          onBackgroundError={onBackgroundError}
        />,
      );

      await act(async () => {
        rendered.stdin.write('\u001B[A');
      });
      await act(async () => {
        rendered.stdin.write('\r');
      });
      await waitFor(() =>
        expect(rendered.lastFrame()).toContain('Confirm this rewind point:'),
      );
      await act(async () => {
        rendered.stdin.write('\r');
      });
      await waitFor(() => expect(onRestoreConversation).toHaveBeenCalled());

      return {
        ...rendered,
        onClose,
        onBackgroundError,
        rejectRestore: (error: unknown) => rejectRestore?.(error),
      };
    }

    it('恢复进行中会显示忙碌提示，而不是看起来毫无反应', async () => {
      const { lastFrame, unmount } = await startPendingRestore();

      await waitFor(() => expect(lastFrame()).toContain('Restoring…'));
      expect(lastFrame()).not.toContain('press Esc to dismiss');

      unmount();
    });

    it('恢复超过 5 秒后提示可以按 Esc 离开', async () => {
      const { lastFrame, unmount } = await startPendingRestore();

      await waitFor(() => expect(lastFrame()).toContain('Restoring…'));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });

      await waitFor(() =>
        expect(lastFrame()).toContain('press Esc to dismiss'),
      );

      unmount();
    });

    it('忙碌中按 Esc 会关闭面板，之后的失败通过 onBackgroundError 上报', async () => {
      const { onClose, onBackgroundError, rejectRestore, stdin, unmount } =
        await startPendingRestore();

      expect(onClose).not.toHaveBeenCalled();

      await act(async () => {
        stdin.write('\u001B');
      });

      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));

      await act(async () => {
        rejectRestore(new Error('rewind blew up'));
      });

      await waitFor(() =>
        expect(onBackgroundError).toHaveBeenCalledWith('rewind blew up'),
      );
      // The dismissed dialog must not close a second time.
      expect(onClose).toHaveBeenCalledTimes(1);

      unmount();
    });
  });
});
