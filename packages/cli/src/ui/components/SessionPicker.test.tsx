/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import stringWidth from 'string-width';
import { renderWithProviders } from '../../test-utils/render.js';
import { DialogSizeProvider } from '../contexts/DialogSizeContext.js';
import { SessionPicker } from './SessionPicker.js';
import type { SessionListItem } from '@qwen-code/qwen-code-core';

const sessions: SessionListItem[] = Array.from({ length: 28 }, (_, index) => ({
  sessionId: `session-${index}`,
  cwd: '/tmp/fixture',
  startTime: '2026-01-01T00:00:00Z',
  mtime: Date.now() - index * 60000,
  filePath: `/tmp/fixture/${index}.jsonl`,
  prompt: `Session ${index} 中文长标题 ${'keep the title inside this dialog '.repeat(10)}`,
  gitBranch: 'dragon/a-very-long-branch-name'.repeat(5),
}));

describe('SessionPicker floating layout', () => {
  it('R3-4 keeps the branch-filter header on its reserved row', async () => {
    const branch = 'feature/long-branch-'.repeat(8);
    const view = renderWithProviders(
      <DialogSizeProvider value={{ columns: 40, rows: 20 }}>
        <SessionPicker
          sessionService={{} as never}
          currentBranch={branch}
          initialSessions={sessions.slice(0, 8).map((session, index) => ({
            ...session,
            prompt: `BRANCH-SESSION-${index}`,
            gitBranch: branch,
          }))}
          onSelect={vi.fn()}
          onCancel={vi.fn()}
        />
      </DialogSizeProvider>,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    view.stdin.write('\u0002');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(view.lastFrame()).toContain('(branch:');
    expect(view.lastFrame()?.split('\n')[2]).toContain('Press /');
    expect(view.lastFrame()).toContain('BRANCH-SESSION-3');
    view.unmount();
  });

  it('keeps all frame edges, long titles and metadata inside the popup budget', async () => {
    const { lastFrame, stdin } = renderWithProviders(
      <DialogSizeProvider value={{ columns: 70, rows: 20 }}>
        <SessionPicker
          sessionService={{} as never}
          initialSessions={sessions}
          onSelect={vi.fn()}
          onCancel={vi.fn()}
          enablePreview
        />
      </DialogSizeProvider>,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    const lines = (lastFrame() ?? '').split('\n');
    expect(lines).toHaveLength(20);
    expect(lines.every((line) => stringWidth(line) <= 70)).toBe(true);
    expect(lines[0]).toMatch(/^╭.*╮$/);
    expect(lines.at(-1)).toMatch(/^╰.*╯$/);
    expect(lastFrame()).toContain('Session 0');
    expect(lastFrame()).not.toContain('Session 20');
    for (let i = 0; i < 8; i++) stdin.write('\u001b[B');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(lastFrame()).toContain('Session 8');
  });
});
