/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it, vi } from 'vitest';
import { recheckWithApproval } from '../test-utils/config.js';
import {
  POWERSHELL_TOOL_NAME,
  TOOL_LEGACY_ALIASES,
} from '../tools/tool-names.js';
import { checkInternalRead } from './file-read.js';
import { createPermissionManager } from '../test-utils/config.js';
import { constrainAgentPermissions } from './agent-tool-constraints.js';

function manager(mode: 'default' | 'yolo' | 'acceptEdits' = 'yolo') {
  return createPermissionManager({
    cwd: '/repo',
    permissionMode: mode,
    checkerDeps: {
      skill: {
        isAllowedForMainSession: () => true,
        isDisabled: () => false,
        hasOnlySafeProperties: () => false,
      },
      mcpCall: { isKnownTool: () => false, parseQualifiedName: () => ({}) },
    },
    askHandler: async () => ({ kind: 'rejected' }),
  });
}
const request = (command: string) => ({
  toolName: 'Bash',
  input: { command },
  toolUseId: 't',
});

describe('per-agent permission narrowing', () => {
  it.each(['acceptEdits', 'default'] as const)(
    'does not deny a write pre-read for an ordinary outside-workspace ask (%s)',
    async (mode) => {
      const permission = manager(mode);
      const decision = await checkInternalRead(permission, {
        toolName: 'Read',
        input: { file_path: '/tmp/outside/file.txt' },
        toolUseId: 'write-pre-read',
      });
      expect(decision).toMatchObject({ denied: false, autoAllowed: false });
    },
  );

  it('still blocks a write pre-read on a hard deny rule', async () => {
    const permission = manager('acceptEdits');
    const decision = await checkInternalRead(
      permission,
      {
        toolName: 'Read',
        input: { file_path: '/repo/secret.txt' },
        toolUseId: 'write-pre-read-deny',
      },
      { rules: { allow: {}, deny: { userSettings: ['Read'] }, ask: {} } },
    );
    expect(decision.denied).toBe(true);
  });

  it('blocks PowerShell and its canonical aliases before parent approval and read probes', async () => {
    const parent = manager();
    const check = vi.spyOn(parent, 'check');
    const child = constrainAgentPermissions(parent, [], ['Bash(git:*)']);
    TOOL_LEGACY_ALIASES['test-powershell-alias'] = POWERSHELL_TOOL_NAME;
    try {
      for (const toolName of [POWERSHELL_TOOL_NAME, 'test-powershell-alias']) {
        const input = { ...request('git status'), toolName };
        expect((await child.check(input)).kind).toBe('deny');
        expect(await checkInternalRead(child, input)).toMatchObject({
          denied: true,
          autoAllowed: false,
        });
      }
      expect(check).not.toHaveBeenCalled();
    } finally {
      delete TOOL_LEGACY_ALIASES['test-powershell-alias'];
      check.mockRestore();
    }
  });

  it('does not restrict PowerShell when no Bash clamp exists', async () => {
    const parent = manager();
    expect(constrainAgentPermissions(parent, [], [])).toBe(parent);
    const child = constrainAgentPermissions(parent, ['Write'], []);
    const input = { ...request('git status'), toolName: POWERSHELL_TOOL_NAME };
    const check = vi.spyOn(parent, 'check');
    await child.check(input);
    expect(check).toHaveBeenCalledOnce();
    check.mockRestore();
  });

  it.each([
    ['git status', 'allow'],
    ['git status && git diff', 'allow'],
    ['git status | git diff', 'allow'],
    ['git status; rm -rf /tmp/test', 'deny'],
    ['git status-no-such-subcommand', 'deny'],
    ['git diff $(rm -rf /tmp/test)', 'deny'],
    ['git diff `rm -rf /tmp/test`', 'deny'],
    ['git diff <(cat /tmp/test)', 'deny'],
    ['if git status; then git diff; fi', 'deny'],
    ['for x in a; do git status; done', 'deny'],
    ['f() { git status; }; f', 'deny'],
    ['git diff "unterminated', 'deny'],
  ])('enforces a clamp even under yolo: %s', async (command, kind) => {
    const parent = manager();
    const child = constrainAgentPermissions(
      parent,
      [],
      ['Bash(git status:*)', 'Bash(git diff:*)'],
    );
    expect((await child.check(request(command))).kind).toBe(kind);
  });

  it('intersects inherited clamps and leaves the parent and siblings unchanged', async () => {
    const parent = manager();
    const first = constrainAgentPermissions(parent, ['Write'], ['Bash(git:*)']);
    const nested = constrainAgentPermissions(
      first,
      [],
      ['Bash(git status:*)', 'Bash(ls:*)'],
    );
    const sibling = constrainAgentPermissions(parent, [], ['Bash(ls:*)']);
    expect((await nested.check(request('git status'))).kind).toBe(
      'allow',
    );
    expect((await nested.check(request('git diff'))).kind).toBe(
      'deny',
    );
    expect((await nested.check(request('ls'))).kind).toBe('deny');
    expect((await sibling.check(request('ls'))).kind).toBe('allow');
    expect((await parent.check(request('git diff'))).kind).toBe(
      'allow',
    );
    expect(first.getRules()).toEqual(parent.getRules());
    parent.setPermissionMode('default');
    expect(first.getPermissionMode()).toBe('default');
  });

  it('cannot grant permission or allow a rewritten command to escape the clamp', async () => {
    const parent = manager();
    const realCheck = parent.check.bind(parent);
    const check = vi
      .spyOn(parent, 'check')
      .mockImplementation(async (input, options) => ({
        ...(await realCheck(input, options)),
        input: { command: 'rm -rf /tmp/test' },
      }));
    const child = constrainAgentPermissions(parent, [], ['Bash(git:*)']);
    expect((await child.check(request('git status'))).kind).toBe(
      'deny',
    );
    expect(check).toHaveBeenCalledTimes(1);
    check.mockRestore();
    parent.setRules({ allow: {}, deny: { session: ['Bash'] }, ask: {} });
    expect((await child.check(request('git status'))).kind).toBe(
      'deny',
    );
  });

  it('keeps child command constraints before and after the framework execution recheck', async () => {
    const parent = manager();
    const child = constrainAgentPermissions(parent, [], ['Bash(git:*)']);
    const approved = await child.check(request('git status'));
    expect(approved.kind).toBe('allow');
    const recheck = vi.spyOn(parent, 'check');
    try {
      expect((await recheckWithApproval(child, request('rm -rf /tmp/test'), approved)).kind).toBe('deny');
      expect(recheck).not.toHaveBeenCalled();
      recheck.mockResolvedValue({ ...approved, input: { command: 'rm -rf /tmp/test' } });
      expect((await recheckWithApproval(child, request('git status'), approved)).kind).toBe('deny');
      expect(recheck).toHaveBeenCalledOnce();
    } finally {
      recheck.mockRestore();
    }
  });

  it('denies MCP aliases and legacy tool aliases at the permission boundary', async () => {
    const child = constrainAgentPermissions(manager(), [
      'mcp__*',
      'searchAlias',
      'Workflow',
    ]);
    for (const name of [
      'mcp__repo__search',
      'searchAlias',
      'RunWorkflow',
      'Workflow',
    ]) {
      expect(
        (await child.check({ ...request('ignored'), toolName: name }))
          .kind,
      ).toBe('deny');
    }
  });

  it('checks the lazy mcp_call target before any permissive parent decision', async () => {
    const parent = manager();
    const check = vi.spyOn(parent, 'check');
    const child = constrainAgentPermissions(parent, ['mcp__repo']);
    const decision = await child.check({
      toolName: 'mcp_call',
      input: { toolName: 'mcp__repo__write', arguments: {} },
      toolUseId: 'lazy',
    });
    expect(decision.kind).toBe('deny');
    expect(check).not.toHaveBeenCalled();
  });
});
