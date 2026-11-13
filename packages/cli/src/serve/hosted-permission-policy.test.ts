/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import type { ToolCallRequestInfo } from '@qwen-code/qwen-code-core/core/turn.js';
import { evaluateHostedPermissionRules } from './hosted-permission-policy.js';

const call = (
  name: string,
  args: Record<string, unknown> = {},
): ToolCallRequestInfo => ({
  name,
  args,
  callId: 'call',
  prompt_id: 'prompt',
  isClientInitiated: false,
});
const empty = { allow: [], ask: [], deny: [] };

describe('Hosted permission evaluation', () => {
  it('keeps deny and ask above an overlapping allow', async () => {
    await expect(
      evaluateHostedPermissionRules(
        { allow: ['Write'], ask: ['Write'], deny: ['Write'] },
        call('write_file'),
      ),
    ).resolves.toBe('deny');
    await expect(
      evaluateHostedPermissionRules(
        { allow: ['Write'], ask: ['Write'], deny: [] },
        call('write_file'),
      ),
    ).resolves.toBe('ask');
    await expect(
      evaluateHostedPermissionRules(
        { ...empty, allow: ['Write'] },
        call('write_file'),
      ),
    ).resolves.toBe('allow');
    await expect(
      evaluateHostedPermissionRules(empty, call('write_file')),
    ).resolves.toBe('default');
  });
  it('checks every shell segment without consulting a Harness working directory', async () => {
    const rules = {
      allow: ['Bash(git status*)'],
      ask: [],
      deny: ['Bash(rm *)'],
    };
    await expect(
      evaluateHostedPermissionRules(
        rules,
        call('run_shell_command', { command: 'git status' }),
      ),
    ).resolves.toBe('allow');
    await expect(
      evaluateHostedPermissionRules(
        rules,
        call('run_shell_command', { command: 'git status && rm file' }),
      ),
    ).resolves.toBe('deny');
    await expect(
      evaluateHostedPermissionRules(
        rules,
        call('run_shell_command', { command: 'git status && unknown' }),
      ),
    ).resolves.toBe('ask');
    await expect(
      evaluateHostedPermissionRules(
        { ...empty, deny: ['Read'] },
        call('run_shell_command', { command: 'cat secret' }),
      ),
    ).resolves.toBe('deny');
  });
  it('matches domains and producer MCP identities, not opaque advertised names', async () => {
    await expect(
      evaluateHostedPermissionRules(
        { ...empty, ask: ['WebFetch(domain:example.com)'] },
        call('web_fetch', { url: 'https://docs.example.com/page' }),
      ),
    ).resolves.toBe('ask');
    const identity = { serverName: 'server', serverToolName: 'write' };
    await expect(
      evaluateHostedPermissionRules(
        { ...empty, deny: ['mcp__server__*'] },
        call('mcp_opaque'),
        identity,
        [identity],
      ),
    ).resolves.toBe('deny');
    await expect(
      evaluateHostedPermissionRules(
        { ...empty, allow: ['mcp__other__*'] },
        call('mcp_opaque'),
        identity,
        [identity],
      ),
    ).resolves.toBe('default');
  });

  it('checks glob rules against the requested path, not result entries', async () => {
    const rules = { ...empty, deny: ['Read(./secret/**)'] };

    await expect(
      evaluateHostedPermissionRules(rules, call('glob', { pattern: '**/*' })),
    ).resolves.toBe('default');
    await expect(
      evaluateHostedPermissionRules(
        rules,
        call('glob', { pattern: '**/*', path: 'secret' }),
      ),
    ).resolves.toBe('deny');
  });
});
