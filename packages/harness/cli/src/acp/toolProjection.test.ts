/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  projectToolCall,
  projectToolCallUpdate,
  projectTerminalOutputUpdate,
  toAcpToolCallContent,
} from './toolProjection.js';

describe('toolProjection', () => {
  it('projects write calls as edit diffs with locations', () => {
    expect(
      projectToolCall({
        toolCallId: 'call-1',
        name: 'Write',
        input: { file_path: '/tmp/file.txt', content: 'hello' },
      }),
    ).toMatchObject({
      toolCallId: 'call-1',
      title: 'Write /tmp/file.txt',
      _meta: { qwen: { toolName: 'Write' } },
      kind: 'edit',
      locations: [{ path: '/tmp/file.txt' }],
      content: [
        {
          type: 'diff',
          path: '/tmp/file.txt',
          oldText: null,
          newText: 'hello',
        },
      ],
    });
  });

  it('renders compact persisted file results as bounded patch text', () => {
    expect(
      toAcpToolCallContent({
        success: true,
        file_path: '/tmp/file.txt',
        diff: '@@ -1,1 +1,1 @@\n-old\n+new\n',
        additions: 1,
        deletions: 1,
      }),
    ).toEqual([
      {
        type: 'content',
        content: {
          type: 'text',
          text: '```diff\n@@ -1,1 +1,1 @@\n-old\n+new\n```',
        },
      },
    ]);
  });

  it('does not reinterpret omitted file bodies as an empty ACP diff', () => {
    expect(
      toAcpToolCallContent({
        fileName: 'file.txt',
        filePath: '/tmp/file.txt',
        fileDiff: '@@ -1,1 +1,1 @@\n-old\n+new\n',
        contentOmitted: true,
        originalContent: null,
        newContent: '',
      }),
    ).toEqual([
      {
        type: 'content',
        content: {
          type: 'text',
          text: '```diff\n@@ -1,1 +1,1 @@\n-old\n+new\n```',
        },
      },
    ]);
  });

  it.each(['Bash', 'PowerShell'])(
    'projects shell calls as pending terminal blocks when supported (%s)',
    (name) => {
      expect(
        projectToolCall({
          toolCallId: 'call-2',
          name,
          input: { command: 'npm test' },
          supportsTerminalOutput: true,
        }),
      ).toMatchObject({
        toolCallId: 'call-2',
        status: 'pending',
        title: 'npm test',
        kind: 'execute',
        content: [{ type: 'terminal', terminalId: 'call-2' }],
        _meta: {
          terminal_info: { terminal_id: 'call-2' },
        },
      });
    },
  );

  it.each(['Bash', 'PowerShell'])(
    'projects terminal output as a separate metadata update (%s)',
    (name) => {
      expect(
        projectTerminalOutputUpdate({
          toolCallId: 'call-2',
          name,
          content: 'done',
          supportsTerminalOutput: true,
        }),
      ).toEqual({
        toolCallId: 'call-2',
        _meta: {
          terminal_output: {
            terminal_id: 'call-2',
            data: 'done',
          },
        },
      });
    },
  );

  it.each(['Bash', 'PowerShell'])(
    'projects shell completion with terminal exit metadata when supported (%s)',
    (name) => {
      expect(
        projectToolCallUpdate({
          toolCallId: 'call-2',
          name,
          content: 'done',
          supportsTerminalOutput: true,
        }),
      ).toMatchObject({
        toolCallId: 'call-2',
        status: 'completed',
        content: [{ type: 'terminal', terminalId: 'call-2' }],
        rawOutput: 'done',
        _meta: {
          terminal_exit: {
            terminal_id: 'call-2',
            exit_code: 0,
            signal: null,
          },
        },
      });
    },
  );

  it.each(['Bash', 'PowerShell'])(
    'formats shell output as console markdown when terminal output is unsupported (%s)',
    (name) => {
      expect(
        projectToolCallUpdate({
          toolCallId: 'call-3',
          name,
          content: 'Cargo.lock\nCargo.toml\n',
          supportsTerminalOutput: false,
        }).content,
      ).toEqual([
        {
          type: 'content',
          content: {
            type: 'text',
            text: '```console\nCargo.lock\nCargo.toml\n```',
          },
        },
      ]);
    },
  );

  it('wraps read output in a dynamic markdown fence', () => {
    expect(
      projectToolCallUpdate({
        toolCallId: 'call-4',
        name: 'Read',
        content: 'for example:\n```markdown\nHello\n```\n',
      }).content,
    ).toEqual([
      {
        type: 'content',
        content: {
          type: 'text',
          text: '````\nfor example:\n```markdown\nHello\n```\n````',
        },
      },
    ]);
  });

  it.each(['Bash', 'PowerShell'])(
    'wraps error output in a markdown fence (%s)',
    (name) => {
      expect(
        projectToolCallUpdate({
          toolCallId: 'call-5',
          name,
          content: 'command not found: nope',
          isError: true,
          supportsTerminalOutput: true,
        }).content,
      ).toEqual([
        {
          type: 'content',
          content: {
            type: 'text',
            text: '```\ncommand not found: nope\n```',
          },
        },
      ]);
    },
  );

  it.each(['Bash', 'PowerShell'])(
    'joins text block arrays before formatting tool output (%s)',
    (name) => {
      expect(
        projectToolCallUpdate({
          toolCallId: 'call-6',
          name,
          content: [
            { type: 'text', text: 'line1' },
            { type: 'text', text: 'line2' },
          ],
        }).content,
      ).toEqual([
        {
          type: 'content',
          content: {
            type: 'text',
            text: '```console\nline1\nline2\n```',
          },
        },
      ]);
    },
  );
});
