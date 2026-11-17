/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  createDaemonTranscriptState,
  daemonBlockToHtml,
  daemonBlockToMarkdown,
  daemonBlockToPlainText,
  normalizeDaemonEvent,
  reduceDaemonTranscriptEvents,
} from '../../src/daemon/ui/index.js';

function shellBlock({
  command = 'ls',
  cwd = '/workspace',
  output = 'README.md\n',
  stream,
  userShell = true,
}: {
  command?: string;
  cwd?: string;
  output?: string;
  stream?: 'stdout' | 'stderr';
  userShell?: boolean;
} = {}) {
  const state = reduceDaemonTranscriptEvents(createDaemonTranscriptState(), [
    ...normalizeDaemonEvent({
      id: 1,
      v: 1,
      type: 'user_shell_command',
      data: { sessionId: 'session', command, cwd },
    }),
    ...normalizeDaemonEvent({
      id: 2,
      v: 1,
      type: 'session_update',
      data: {
        sessionId: 'session',
        update: {
          sessionUpdate: 'shell_output',
          output,
          stream,
          ...(userShell ? { _meta: { source: 'user-shell' } } : {}),
        },
      },
    }),
  ]);
  const block = state.blocks.find(
    (candidate) => candidate.kind === (userShell ? 'user_shell' : 'shell'),
  );
  expect(block).toBeDefined();
  return block!;
}

const renderers = [
  daemonBlockToMarkdown,
  daemonBlockToHtml,
  daemonBlockToPlainText,
];

describe('user shell transcript rendering', () => {
  it.each(renderers)('%s retains command, directory and output', (render) => {
    const block = shellBlock();
    expect(block).toMatchObject({
      kind: 'user_shell',
      command: 'ls',
      cwd: '/workspace',
      text: 'README.md\n',
    });
    const rendered = render(block);
    expect(rendered).toContain('ls');
    expect(rendered).toContain('/workspace');
    expect(rendered).toContain('README.md\n');
  });

  it.each(renderers)('%s retains ordinary shell output', (render) => {
    expect(render(shellBlock({ userShell: false }))).toContain('README.md\n');
  });

  it('preserves stderr identification in all formats', () => {
    const block = shellBlock({ stream: 'stderr', output: 'command failed' });
    expect(daemonBlockToMarkdown(block)).toContain('shellsession-stderr');
    expect(daemonBlockToPlainText(block)).toContain('[shell stderr]');
    expect(daemonBlockToHtml(block)).toContain('data-stream="stderr"');
  });

  it('keeps backticks in commands and output inside their Markdown fences', () => {
    const block = shellBlock({
      command: "printf '```'",
      output: '```\n<script>output</script>\n',
    });
    const rendered = daemonBlockToMarkdown(block);
    expect(rendered).toContain(
      "````bash\n# cwd: /workspace\nprintf '```'\n````",
    );
    expect(rendered).toContain(
      '````shell\n```\n<script>output</script>\n\n````',
    );
  });

  it('escapes HTML in the command, directory and output', () => {
    const rendered = daemonBlockToHtml(
      shellBlock({
        command: 'echo "<command>"',
        cwd: '/workspace/<project>&',
        output: '<script>output</script>\n',
      }),
    );
    expect(rendered).toContain('echo &quot;&lt;command&gt;&quot;');
    expect(rendered).toContain('/workspace/&lt;project&gt;&amp;');
    expect(rendered).toContain('&lt;script&gt;output&lt;/script&gt;\n');
    expect(rendered).not.toContain('<script>');
  });

  it.each(renderers)(
    '%s sanitizes terminal controls and caps each field',
    (render) => {
      const rendered = render(
        shellBlock({
          command: '\x1b[31maaaaaaaa\x1b[0m',
          cwd: 'bbbbbbbb',
          output: '\x1b[32mcccccccc\x1b[0m',
        }),
        { maxFieldLength: 4 },
      );
      expect(rendered).toContain('aaaa… [truncated]');
      expect(rendered).toContain('bbbb… [truncated]');
      expect(rendered).toContain('cccc… [truncated]');
      expect(rendered).not.toContain('\x1b');
    },
  );

  it('uses a custom HTML sanitizer for command context and output', () => {
    const sanitizer = vi.fn((text: string) => `sanitized(${text})`);
    const rendered = daemonBlockToHtml(shellBlock(), { sanitizer });
    expect(sanitizer).toHaveBeenCalledWith('$ ls (cwd: /workspace)');
    expect(sanitizer).toHaveBeenCalledWith('README.md\n');
    expect(rendered).toContain('sanitized($ ls (cwd: /workspace))');
    expect(rendered).toContain('sanitized(README.md\n)');
  });
});
