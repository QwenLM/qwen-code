/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateFileAttachment, getChangedFiles, processAtMentionedFiles } from '../../attachments/generators/file-generators.js';
import { getRelevantMemoriesAttachments } from '../../attachments/generators/memory-generators.js';
import { pathPermissionContextOf } from '../../attachments/path-permission.js';
import type { AttachmentToolUseContext } from '../../attachments/types.js';
import type { ConfigService, ConfigValueListener } from '../../config-service/config-service.js';
import type { Config } from '../../config/config.js';
import { parseMcpToolName } from '../../mcp/tools/mcp-names.js';
import { TEST_POLICY_KEY, createPermissionManager } from '../../test-utils/config.js';
import { canReadFileWithoutPrompt } from '../../tools/file-read-permission.js';
import { createReadDenyResultFilter, isFileReadDenied } from '../../tools/filesystem-permissions/filesystem.js';
import { qwenInternalPathDeps } from '../../tools/filesystem-permissions/internal-path-deps.js';
import { checkEditableInternalPath } from '../../tools/filesystem-permissions/internalPaths.js';
import { confirmManagedSearchRead } from '../../tools/filesystem-permissions/search-permissions.js';
import { GlobTool } from '../../tools/glob.js';
import { RipGrepTool } from '../../tools/ripGrep.js';
import { _setPowerShellParserRunnerForTest } from '../../tools/shell-permissions/powerShellParser.js';
import type { ToolPermissionReason } from '../../tools/tool-checkers/checker-reasons.js';
import { createToolCheckerMap } from '../../tools/tool-checkers/checker-registry.js';
import { createMcpToolChecker } from '../../tools/tool-checkers/checkers/mcp-checker.js';
import type { SkillCheckerDeps } from '../../tools/tool-checkers/content-checkers.js';
import { withHookAsk, withToolLevelRules } from '../../tools/tool-checkers/rule-precedence.js';
import type { HostToolCheckContext, HostToolChecker } from '../../tools/tool-checkers/rule-precedence.js';
import type { ToolUseContext } from '../../tools/tool-types.js';
import { createFileStateCacheWithSizeLimit, createToolFileStateCache } from '../../utils/fileStateCache.js';
import { ripGrep } from '../../utils/ripgrep.js';
import { initializeShellParsers } from '../../utils/shell-utils.js';
import { _resetPowerShellRuntimeForTest, _setPowerShellRuntimeForTest } from '../../utils/shell/powerShell.js';
import { constrainAgentPermissions } from '../agent-tool-constraints.js';
import { createAskHandler, withPermissionRequestHook, withPermissionRequestHookHandler } from '../ask-handler/ask-handler.js';
import type { PermissionRequestHookBridge } from '../ask-handler/ask-handler.js';
import { createAskMetricsStore } from '../ask-handler/ask-facts.js';
import { checkInternalRead } from '../file-read.js';
import type { HostAskHandler } from '../../tools/tool-checkers/checker-reasons.js';
import type { AskHandler, PermissionMode, PermissionRules } from './decision/index.js';
import type { PermissionPolicySnapshot } from './policy.js';
import { checkWithOverride, recheckWithApproval } from '../../test-utils/config.js';

function registerTestChecker(
  permission: ReturnType<typeof createPermissionManager>,
  name: string,
  checker: HostToolChecker,
): void {
  permission.permissionManager!.registerSceneCheckers('main', new Map([
    [name, withHookAsk(withToolLevelRules(name, checker))],
  ]));
}

describe('rule execution', () => {
  type Rules = PermissionPolicySnapshot['rules'];
  type Handler = AskHandler<ToolPermissionReason>;
  let root: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'managed-exec-')));
    for (const name of ['public', 'private']) {
      mkdirSync(join(root, name));
      writeFileSync(join(root, name, 'file.txt'), name);
    }
    symlinkSync(join(root, 'public'), join(root, 'link'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  function setup(
    initial: Rules,
    handler?: Handler,
    mode: PermissionMode = 'yolo',
  ) {
    let rules = initial;
    const source: ConfigService = {
      start: async () => {},
      stop: async () => {},
      getValue: <T>() => ({ disabledModes: [], rules }) as T,
      onValueChange: () => () => {},
      onError: () => () => {},
    };
    const permission = createPermissionManager({
      cwd: root,
      permissionMode: mode,
      organizationPolicy: source,
      askHandler: handler,
      checkerDeps: {
        skill: {
          isAllowedForMainSession: () => true,
          isDisabled: () => false,
          hasOnlySafeProperties: () => true,
        },
        mcpCall: { isKnownTool: () => false, parseQualifiedName: () => ({}) },
      },
    });
    const request = {
      toolName: 'Read',
      input: { file_path: join(root, 'link', 'file.txt') },
      toolUseId: 'final-read',
    };
    return {
      permission,
      request,
      update(next: Rules) {
        rules = next;
      },
      retarget() {
        unlinkSync(join(root, 'link'));
        symlinkSync(join(root, 'private'), join(root, 'link'));
      },
    };
  }
  const denyPrivate = { deny: ['Read(/private/**)'], ask: [] };
  describe('final managed permission review', () => {
    it('denies a policy arriving after permission resolution', async () => {
      const s = setup(undefined);
      const first = await s.permission.check(s.request);
      expect(first.kind).toBe('allow');
      s.update({ deny: ['Read'], ask: [] });
      expect((await recheckWithApproval(s.permission, s.request, first)).kind).toBe(
        'deny',
      );
    });
    it('requests a new managed approval after permission resolution', async () => {
      const handler = vi.fn<Handler>(async () => ({ kind: 'approved' }));
      const s = setup(undefined, handler);
      const first = await s.permission.check(s.request);
      s.update({ deny: [], ask: ['Read(/public/**)'] });
      expect((await recheckWithApproval(s.permission, s.request, first)).kind).toBe(
        'allow',
      );
      expect(handler).toHaveBeenCalledOnce();
    });
    it('treats a second check as a new managed approval', async () => {
      const handler = vi.fn<Handler>(async () => ({ kind: 'approved' }));
      const s = setup({ deny: [], ask: ['Read(/public/**)'] }, handler);
      const first = await s.permission.check(s.request);
      expect(
        (await recheckWithApproval(s.permission, s.request, first)).kind,
      ).toBe('allow');
      expect(handler).toHaveBeenCalledTimes(2);
    });
    it('denies a symlink retargeted after permission resolution', async () => {
      const s = setup(denyPrivate);
      const first = await s.permission.check(s.request);
      s.retarget();
      expect((await recheckWithApproval(s.permission, s.request, first)).kind).toBe(
        'deny',
      );
    });
    it('denies a symlink retargeted while an ordinary approval is pending', async () => {
      const s = setup(
        denyPrivate,
        async () => {
          s.retarget();
          return { kind: 'approved' };
        },
        'default',
      );
      s.permission.setRules({
        allow: {},
        deny: {},
        ask: { userSettings: ['Read'] },
      });
      expect((await s.permission.check(s.request)).kind).toBe('deny');
    });
    it('asks again for a different actual file under the same managed pattern', async () => {
      const handler = vi.fn<Handler>(async () => ({ kind: 'approved' }));
      const s = setup({ deny: [], ask: ['Read(/**)'] }, handler);
      const first = await s.permission.check(s.request);
      s.retarget();
      expect((await recheckWithApproval(s.permission, s.request, first)).kind).toBe(
        'allow',
      );
      expect(handler).toHaveBeenCalledTimes(2);
    });
    it('checks the rebuilt invocation input instead of the old approved input', async () => {
      const s = setup(denyPrivate);
      const first = await s.permission.check(s.request);
      expect(
        (
          await recheckWithApproval(
            s.permission,
            {
              ...s.request,
              input: { file_path: join(root, 'private', 'file.txt') },
            },
            first,
          )
        ).kind,
      ).toBe('deny');
    });
    it('retains child agent constraints during final review', async () => {
      const s = setup({ deny: [], ask: ['Read(/private/**)'] });
      const child = constrainAgentPermissions(s.permission, ['Read']);
      const first = await s.permission.check(s.request);
      expect((await recheckWithApproval(child, s.request, first)).kind).toBe(
        'deny',
      );
    });
    it('allows a later call after managed constraints are cleared', async () => {
      const s = setup(denyPrivate);
      const first = await s.permission.check(s.request);
      s.update({ deny: [], ask: [] });
      expect((await recheckWithApproval(s.permission, s.request, first)).kind).toBe(
        'allow',
      );
    });
  });
});

describe('rule overrides', () => {
  type Rules = PermissionPolicySnapshot['rules'];
  type Handler = AskHandler<ToolPermissionReason>;
  const cases = [
    {
      tool: 'Bash',
      rule: 'Bash(git push:*)',
      input: { command: 'git push origin main' },
    },
    {
      tool: 'Read',
      rule: 'Read(/private/**)',
      input: { file_path: '/repo/private/secret.txt' },
    },
    {
      tool: 'Edit',
      rule: 'Edit(/private/**)',
      input: { file_path: '/repo/private/secret.txt' },
    },
    {
      tool: 'Agent',
      rule: 'Agent(Explore)',
      input: { subagent_type: 'explore' },
    },
    { tool: 'Skill', rule: 'Skill(review:*)', input: { skill: '/review-pr' } },
    { tool: 'Workflow', rule: 'Workflow(build)', input: { name: 'build' } },
    {
      tool: 'WebFetch',
      rule: 'WebFetch(nodejs.org)',
      input: { url: 'https://nodejs.org/api/fs.html' },
    },
    {
      tool: 'mcp_call',
      rule: 'mcp__files__read',
      input: { toolName: 'mcp__files__read', arguments: {} },
    },
  ] as const;
  function setup(
    initial: Rules,
    mode: PermissionMode = 'yolo',
    withSource = true,
  ) {
    let rules = initial;
    const source: ConfigService = {
      start: async () => {},
      stop: async () => {},
      getValue: <T>() => ({ disabledModes: [], rules }) as T,
      onValueChange: () => () => {},
      onError: () => () => {},
    };
    const resolveAuto = vi.fn(async () => ({ kind: 'allow' as const }));
    const checkerDeps = {
      skill: {
        isAllowedForMainSession: () => true,
        isDisabled: () => false,
        hasOnlySafeProperties: () => true,
      },
      mcpCall: {
        isKnownTool: (name: string) => name === 'mcp__files__read',
        parseQualifiedName: parseMcpToolName,
      },
    };
    const permission = createPermissionManager({
      organizationPolicy: withSource ? source : undefined,
      resolveAuto,
      cwd: '/repo',
      permissionMode: mode,
      checkerDeps,
    });
    return {
      permission,
      resolveAuto,
      checkers: createToolCheckerMap(checkerDeps),
      update(next: Rules) {
        rules = next;
      },
    };
  }
  const allow = () => ({ kind: 'allow' as const });
  beforeAll(() => initializeShellParsers());

  describe('managed rules with replacement checkers', () => {
    it.each(cases)(
      'keeps $tool deny when an override omits its checker',
      async ({ tool, rule, input }) => {
        const { permission } = setup({ deny: [rule], ask: [] });
        const decision = await checkWithOverride(permission, { toolName: tool, input, toolUseId: 'missing-checker' }, {}, );
        expect(decision.kind).toBe('deny');
      },
    );

    it.each(cases)(
      'keeps $tool deny when the call replaces its checker',
      async ({ tool, rule, input }) => {
        const { permission } = setup({ deny: [rule], ask: [] });
        const check = vi.fn(allow);
        const decision = await checkWithOverride(permission, { toolName: tool, input, toolUseId: 'override-deny' }, {
          }, );
        expect(decision.kind).toBe('deny');
        expect(decision.toolCheck).toMatchObject({
          extra: { denialReason: { attribution: { type: 'managedRule' } } },
        });
        expect(check).not.toHaveBeenCalled();
      },
    );
    it.each(['default', 'auto', 'yolo', 'acceptEdits'] as const)(
      'requires manual approval on every overridden call in %s',
      async (mode) => {
        const { permission, resolveAuto } = setup(
          { deny: [], ask: ['Bash(git push:*)'] },
          mode,
        );
        const handler = vi.fn<Handler>(async (ctx) => {
          expect(ctx.toolCheckResult).toMatchObject({
            kind: 'ask',
            reason: { attribution: { type: 'managedRule' } },
          });
          return { kind: 'approved' };
        });
        const override = {
          askHandler: handler,
        };
        for (let i = 0; i < 2; i++)
          expect(
            (
              await checkWithOverride(
                permission,
                {
                  toolName: 'Bash',
                  input: { command: 'git push origin main' },
                  toolUseId: `override-ask-${i}`,
                },
                override,
              )
            ).kind,
          ).toBe('allow');
        expect(handler).toHaveBeenCalledTimes(2);
        expect(resolveAuto).not.toHaveBeenCalled();
      },
    );
    it('denies an overridden managed ask in DontAsk', async () => {
      const { permission } = setup(
        { deny: [], ask: ['Bash(git push:*)'] },
        'dontAsk',
      );
      const handler = vi.fn<Handler>(async () => ({ kind: 'approved' }));
      expect(
        (
          await checkWithOverride(permission, {
              toolName: 'Bash',
              input: { command: 'git push origin main' },
              toolUseId: 'dont-ask',
            }, {
              askHandler: handler,
            }, )
        ).kind,
      ).toBe('deny');
      expect(handler).not.toHaveBeenCalled();
    });
    it('preserves replacement checker denials ahead of managed asks', async () => {
      const { permission } = setup({ deny: [], ask: ['Injected'] });
      const check = vi.fn(() => ({ kind: 'deny' as const }));
      registerTestChecker(permission, 'Injected', { check });
      expect(
        (
          await checkWithOverride(permission, {
              toolName: 'Injected',
              input: { command: 'git push origin main' },
              toolUseId: 'override-denies',
            }, {}, )
        ).kind,
      ).toBe('deny');
      expect(check).toHaveBeenCalledOnce();
    });
    it('keeps replacement checkers constrained after updates and clears', async () => {
      const s = setup(undefined);
      const check = vi.fn(allow);
      registerTestChecker(s.permission, 'Injected', { check });
      const run = () =>
        checkWithOverride(
          s.permission,
          {
            toolName: 'Injected',
            input: { command: 'git push origin main' },
            toolUseId: 'set-checker',
          },
          {},
        );
      expect((await run()).kind).toBe('allow');
      s.update({ deny: ['Injected'], ask: [] });
      expect((await run()).kind).toBe('deny');
      s.update({ deny: [], ask: [] });
      expect((await run()).kind).toBe('allow');
      expect(check).toHaveBeenCalledTimes(2);
    });
    it.each([false, true])(
      'preserves replacement behavior without matching rules (source=%s)',
      async (withSource) => {
        const { permission } = setup(
          { deny: ['Read(/private/**)'], ask: [] },
          'yolo',
          withSource,
        );
        const check = vi.fn(allow);
        registerTestChecker(permission, 'Injected', { check });
        expect(
          (
            await checkWithOverride(permission, {
                toolName: 'Injected',
                input: { command: 'git push origin main' },
                toolUseId: 'unmatched',
              }, {}, )
          ).kind,
        ).toBe('allow');
        expect(check).toHaveBeenCalledOnce();
      },
    );
    it.each(['deny', 'ask'] as const)(
      'keeps Read %s in an internal probe with a replacement pure checker',
      async (behavior) => {
        const { permission } = setup({
          deny: [],
          ask: [],
          [behavior]: ['Read(/private/**)'],
        });
        const main = vi.fn(allow);
        const result = await checkInternalRead(
          permission,
          {
            toolName: 'Read',
            input: { file_path: '/repo/private/secret.txt' },
            toolUseId: 'probe',
          },
          {
          },
        );
        expect(result).toEqual({
          denied: behavior === 'deny',
          autoAllowed: false,
        });
        expect(main).not.toHaveBeenCalled();
      },
    );
  });
});

describe('rule recheck', () => {
  type Handler = AskHandler<ToolPermissionReason>;
  type Rules = PermissionPolicySnapshot['rules'];
  beforeAll(() => initializeShellParsers());
  function setup(
    initial: Rules,
    local: PermissionRules = {
      allow: {},
      deny: {},
      ask: { userSettings: ['Bash'] },
    },
    getWorkingDir?: () => string,
  ) {
    let rules = initial;
    const source: ConfigService = {
      start: async () => {},
      stop: async () => {},
      getValue: <T>() => ({ disabledModes: [], rules }) as T,
      onValueChange: () => () => {},
      onError: () => () => {},
    };
    const checkerDeps = {
      skill: {
        isAllowedForMainSession: () => true,
        isDisabled: () => false,
        hasOnlySafeProperties: () => true,
      },
      mcpCall: {
        isKnownTool: (name: string) => name === 'mcp__files__read',
        parseQualifiedName: parseMcpToolName,
      },
    };
    const permission = createPermissionManager({
      organizationPolicy: source,
      cwd: '/repo',
      getWorkingDir,
      permissionMode: 'default',
      rules: local,
      checkerDeps,
    });
    return {
      permission,
      update(next: Rules) {
        rules = next;
      },
      run(
        input: Record<string, unknown>,
        askHandler?: Handler,
        toolName = 'Bash',
        id = 'rule-recheck',
      ) {
        return checkWithOverride(
          permission,
          { toolName, input, toolUseId: id },
          { askHandler},
        );
      },
    };
  }
  const denyPush = { deny: ['Bash(git push:*)'], ask: [] };
  const askPush = { deny: [], ask: ['Bash(git push:*)'] };

  describe('managed rules after approval', () => {
    it('denies new command constraints applied while ordinary approval is pending', async () => {
      const s = setup(undefined);
      const handler = vi.fn<Handler>(async () => {
        s.update(denyPush);
        return { kind: 'approved' };
      });
      expect(
        (await s.run({ command: 'git push origin main' }, handler)).kind,
      ).toBe('deny');
      expect(handler).toHaveBeenCalledOnce();
    });
    it('keeps one manual approval when a managed ask appears', async () => {
      const s = setup(undefined);
      const handler = vi.fn<Handler>(async () => {
        if (handler.mock.calls.length === 1) s.update(askPush);
        return { kind: 'approved' };
      });
      expect(
        (await s.run({ command: 'git push origin main' }, handler)).kind,
      ).toBe('allow');
      expect(handler).toHaveBeenCalledOnce();
    });
    it('uses the installed handler once when a managed ask appears', async () => {
      const s = setup(undefined);
      const handler = vi.fn<Handler>(async () => {
        s.update(askPush);
        return { kind: 'approved' };
      });
      s.permission.setAskHandler(handler);
      expect((await s.run({ command: 'git push origin main' })).kind).toBe(
        'allow',
      );
      expect(handler).toHaveBeenCalledOnce();
    });
    it('denies a new content rule after approving an existing managed ask', async () => {
      const s = setup(askPush);
      const handler = vi.fn<Handler>(async () => {
        s.update(denyPush);
        return { kind: 'approved' };
      });
      expect(
        (await s.run({ command: 'git push origin main' }, handler)).kind,
      ).toBe('deny');
    });
    it('checks approved replacement input against unchanged managed rules', async () => {
      const s = setup(denyPush);
      const handler = vi.fn<Handler>(async () => ({
        kind: 'approved',
        input: { command: 'git push origin main' },
      }));
      expect((await s.run({ command: 'git status' }, handler)).kind).toBe('deny');
    });
    it('detects in-place changes to the approved input', async () => {
      const s = setup(denyPush);
      const handler = vi.fn<Handler>(async (ctx) => {
        ctx.input['command'] = 'git push origin main';
        return { kind: 'approved' };
      });
      expect((await s.run({ command: 'git status' }, handler)).kind).toBe('deny');
    });
    it('accepts approved replacement input under the same managed ask', async () => {
      const s = setup({ deny: [], ask: ['Bash(echo:*)'] });
      const handler = vi.fn<Handler>(async (ctx) => {
        expect(ctx.input).toEqual({ command: 'echo first' });
        return { kind: 'approved', input: { command: 'echo second' } };
      });
      const result = await s.run({ command: 'echo first' }, handler);
      expect(result.kind).toBe('allow');
      expect(result.input).toEqual({ command: 'echo second' });
      expect(handler).toHaveBeenCalledOnce();
    });
    it('does not repeat an ordinary approval for an unrelated policy update', async () => {
      const s = setup(undefined);
      const handler = vi.fn<Handler>(async () => {
        s.update({ deny: ['Read(*.secret)'], ask: [] });
        return { kind: 'approved' };
      });
      expect((await s.run({ command: 'echo hello' }, handler)).kind).toBe(
        'allow',
      );
      expect(handler).toHaveBeenCalledOnce();
    });
    it('retains an existing managed approval for unchanged input', async () => {
      const s = setup(askPush);
      const handler = vi.fn<Handler>(async () => {
        s.update({ deny: ['Read(*.secret)'], ask: askPush.ask });
        return { kind: 'approved' };
      });
      expect(
        (await s.run({ command: 'git push origin main' }, handler)).kind,
      ).toBe('allow');
      expect(handler).toHaveBeenCalledOnce();
    });
    it('preserves answer input without re-prompting an interaction tool', async () => {
      const s = setup(denyPush);
      registerTestChecker(s.permission, 'Question', {
        check: () => ({
          kind: 'ask',
          reason: {
            message: 'Answer',
            attribution: { type: 'interaction', reason: 'Collect an answer' },
          },
        }),
      });
      const handler = vi.fn<Handler>(async () => ({
        kind: 'approved',
        input: { answer: 'yes' },
      }));
      const result = await s.run({}, handler, 'Question');
      expect(result.kind).toBe('allow');
      expect(result.input).toEqual({ answer: 'yes' });
      expect(handler).toHaveBeenCalledOnce();
    });
    it('rechecks file path rules after approval', async () => {
      const s = setup({ deny: [], ask: ['Read(/private/**)'] });
      const handler = vi.fn<Handler>(async () => {
        s.update({ deny: ['Read(/private/**)'], ask: [] });
        return { kind: 'approved' };
      });
      expect(
        (await s.run({ file_path: '/repo/private/secret.txt' }, handler, 'Read'))
          .kind,
      ).toBe('deny');
    });
    it('rechecks the MCP target after approval', async () => {
      const s = setup(undefined, {
        allow: {},
        deny: {},
        ask: { userSettings: ['mcp__files__read'] },
      });
      const handler = vi.fn<Handler>(async () => {
        s.update({ deny: ['mcp__files__read'], ask: [] });
        return { kind: 'approved' };
      });
      expect(
        (await s.run({ toolName: 'mcp__files__read' }, handler, 'mcp_call')).kind,
      ).toBe('deny');
    });
    it('does not mix snapshots between two pending checks', async () => {
      const s = setup(undefined);
      let approve!: () => void;
      const pending = new Promise<void>((resolve) => {
        approve = resolve;
      });
      const handler = vi.fn<Handler>(async () => {
        await pending;
        return { kind: 'approved' };
      });
      const first = s.run({ command: 'echo first' }, handler, 'Bash', 'first');
      const second = s.run({ command: 'echo second' }, handler, 'Bash', 'second');
      await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(2));
      s.update({ deny: ['Bash(echo first)'], ask: [] });
      approve();
      expect((await first).kind).toBe('deny');
      expect((await second).kind).toBe('allow');
      expect(handler).toHaveBeenCalledTimes(2);
    });
    it('keeps concurrent approvals separate when a checker reuses its result object', async () => {
      const s = setup({ deny: ['OtherTool'], ask: [] });
      const sharedAsk = {
        kind: 'ask',
        reason: {
          message: 'Approve',
          attribution: { type: 'other', reason: 'ordinary approval' },
        },
      } as const;
      registerTestChecker(s.permission, 'Shared', { check: () => sharedAsk });
      let approve!: () => void;
      const pending = new Promise<void>((resolve) => {
        approve = resolve;
      });
      const handler = vi.fn<Handler>(async () => {
        await pending;
        return { kind: 'approved' };
      });
      const first = s.run({ value: 'first' }, handler, 'Shared', 'shared-first');
      const second = s.run(
        { value: 'second' },
        handler,
        'Shared',
        'shared-second',
      );
      await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(2));
      approve();
      expect((await first).kind).toBe('allow');
      expect((await second).kind).toBe('allow');
      expect(handler).toHaveBeenCalledTimes(2);
    });
    it('does not rerun for a replacement snapshot with identical rule content', async () => {
      const s = setup({ deny: ['OtherTool'], ask: [] });
      const check = vi.fn(() => {
        s.update({ deny: ['OtherTool'], ask: [] });
        return { kind: 'allow' as const };
      });
      registerTestChecker(s.permission, 'Stable', { check });
      expect((await s.run({}, undefined, 'Stable')).kind).toBe('allow');
      expect(check).toHaveBeenCalledOnce();
    });
    it.each(['mode', 'rules', 'directories'] as const)(
      'keeps one approval when %s changes without a new denial',
      async (field) => {
        const s = setup({ deny: ['OtherTool'], ask: [] });
        const ask = {
          kind: 'ask',
          reason: {
            message: 'Approve',
            attribution: { type: 'other', reason: 'ordinary approval' },
          },
        } as const;
        registerTestChecker(s.permission, 'Probe', { check: () => ask });
        const handler = vi.fn<Handler>(async () => {
          if (handler.mock.calls.length > 1) return { kind: 'rejected' };
          if (field === 'mode') s.permission.setPermissionMode('acceptEdits');
          if (field === 'rules')
            s.permission.setRules({
              allow: { session: ['Unrelated'] },
              deny: {},
              ask: {},
            });
          if (field === 'directories')
            s.permission.setAdditionalDirectories(['/changed']);
          s.update({ deny: ['AnotherTool'], ask: [] });
          return { kind: 'approved' };
        });
        expect((await s.run({ value: 'same' }, handler, 'Probe')).kind).toBe(
          'allow',
        );
        expect(handler).toHaveBeenCalledOnce();
      },
    );
    it('keeps one approval when the replacement checker has the same requirement', async () => {
      const s = setup({ deny: ['OtherTool'], ask: [] });
      const ask = {
        kind: 'ask',
        reason: {
          message: 'Approve',
          attribution: { type: 'other', reason: 'ordinary approval' },
        },
      } as const;
      registerTestChecker(s.permission, 'Probe', { check: () => ask });
      const handler = vi.fn<Handler>(async () => {
        if (handler.mock.calls.length > 1) return { kind: 'rejected' };
        registerTestChecker(s.permission, 'Probe', { check: () => ask });
        s.update({ deny: ['AnotherTool'], ask: [] });
        return { kind: 'approved' };
      });
      expect((await s.run({}, handler, 'Probe')).kind).toBe('allow');
      expect(handler).toHaveBeenCalledOnce();
    });
    it('keeps the invocation working directory pinned during approval', async () => {
      let cwd = '/repo';
      const s = setup({ deny: ['OtherTool'], ask: [] }, undefined, () => cwd);
      const directories: string[] = [];
      registerTestChecker(s.permission, 'Probe', {
        check: (_input, ctx) => {
          directories.push(ctx.cwd);
          return {
            kind: 'ask',
            reason: {
              message: 'Approve',
              attribution: { type: 'other', reason: 'ordinary approval' },
            },
          };
        },
      });
      const handler = vi.fn<Handler>(async () => {
        if (handler.mock.calls.length > 1) return { kind: 'rejected' };
        cwd = '/different';
        s.update({ deny: ['AnotherTool'], ask: [] });
        return { kind: 'approved' };
      });
      expect((await s.run({ command: 'same' }, handler, 'Probe')).kind).toBe(
        'allow',
      );
      expect(handler).toHaveBeenCalledOnce();
      expect(directories).toEqual(['/repo', '/repo']);
    });
    it.each(['safetyCheck', 'interaction'] as const)(
      'delivers a changed %s prompt to the current handler',
      async (type) => {
        const s = setup(undefined);
        let message = 'Original prompt';
        registerTestChecker(s.permission, 'Question', {
          check: () => ({
            kind: 'ask',
            reason: { message, attribution: { type, reason: message } },
          }),
        });
        const handler = vi.fn<Handler>(async (ctx) => {
          const updated = new Promise<void>((resolve) => {
            const unsubscribe = ctx.onToolCheckResult((result) => {
              expect(result).toMatchObject({
                kind: 'ask',
                reason: { message: 'Updated prompt' },
              });
              unsubscribe();
              resolve();
            });
          });
          message = 'Updated prompt';
          s.permission.setRules({
            allow: { session: ['OtherTool'] },
            deny: {},
            ask: {},
          });
          await updated;
          return { kind: 'approved', input: { answer: 'yes' } };
        });
        const result = await s.run({}, handler, 'Question');
        expect(result.kind).toBe('allow');
        expect(result.input).toEqual({ answer: 'yes' });
        expect(handler).toHaveBeenCalledOnce();
      },
    );
    it.each(['mode', 'rules', 'directories'] as const)(
      'respects a pinned %s override when reusing an approval',
      async (field) => {
        const s = setup({ deny: ['OtherTool'], ask: [] });
        registerTestChecker(s.permission, 'Probe', {
          check: () => ({
            kind: 'ask',
            reason: {
              message: 'Approve',
              attribution: { type: 'other', reason: 'ordinary approval' },
            },
          }),
        });
        const handler = vi.fn<Handler>(async () => {
          if (field === 'mode') s.permission.setPermissionMode('acceptEdits');
          if (field === 'rules')
            s.permission.setRules({
              allow: { session: ['Unrelated'] },
              deny: {},
              ask: {},
            });
          if (field === 'directories')
            s.permission.setAdditionalDirectories(['/changed']);
          s.update({ deny: ['AnotherTool'], ask: [] });
          return { kind: 'approved' };
        });
        const override =
          field === 'mode'
            ? { permissionMode: 'default' as const }
            : field === 'rules'
              ? { rules: { allow: {}, deny: {}, ask: {} } }
              : { additionalDirectories: ['/pinned'] };
        const result = await checkWithOverride(s.permission, { toolName: 'Probe', input: {}, toolUseId: 'pinned' }, { ...override, askHandler: handler}, );
        expect(result.kind).toBe('allow');
        expect(handler).toHaveBeenCalledOnce();
      },
    );
    it('preserves the existing local-only deny-update confirmation behavior', async () => {
      const s = setup({ deny: ['OtherTool'], ask: [] });
      const handler = createAskHandler(
        {
          present(_prompt, settle) {
            s.permission.setRules({
              allow: {},
              deny: { session: ['Bash'] },
              ask: {},
            });
            const timer = setTimeout(() => settle({ kind: 'approved' }), 0);
            return () => clearTimeout(timer);
          },
        },
        { getCurrentMode: () => s.permission.getPermissionMode() },
      );
      s.permission.setAskHandler(handler);
      expect((await s.run({ command: 'echo same' })).kind).toBe('allow');
    });
    it('preserves ordinary host inputs when no comparable approval record can be captured', async () => {
      const s = setup(undefined);
      registerTestChecker(s.permission, 'Metadata', {
        check: () => ({
          kind: 'ask',
          reason: {
            message: 'Approve',
            attribution: { type: 'other', reason: 'ordinary approval' },
          },
        }),
      });
      const handler = vi.fn<Handler>(async () => ({ kind: 'approved' }));
      expect(
        (await s.run({ callback: () => undefined }, handler, 'Metadata')).kind,
      ).toBe('allow');
      expect(handler).toHaveBeenCalledOnce();
    });
    it('keeps unrelated unregistered-tool fallback behavior', async () => {
      expect((await setup(denyPush).run({}, undefined, 'Unknown')).kind).toBe(
        'allow',
      );
    });
  });
});

describe('command rules', () => {
  function sharedSource(initial: PermissionPolicySnapshot | undefined) {
    let policy = initial;
    const listeners = new Set<ConfigValueListener>();
    const service: ConfigService = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      getValue: <T>(key: string) =>
        key === TEST_POLICY_KEY ? (policy as T) : undefined,
      onValueChange: vi.fn((_key, listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      }),
      onError: () => () => {},
    };
    return {
      service,
      update(next: PermissionPolicySnapshot | undefined) {
        policy = next;
        for (const listener of listeners) listener(policy);
      },
    };
  }

  const localRules = {
    allow: { userSettings: ['Bash'] },
    deny: { session: ['OtherTool'] },
    ask: {},
  };
  const request = { toolName: 'Probe', input: {}, toolUseId: 'probe' };
  const policy: PermissionPolicySnapshot = {
    disabledModes: [],
    rules: { deny: ['Bash(rm:*)'], ask: ['Bash(git push:*)'] },
  };

  function observer() {
    return vi.fn(
      (_input: Record<string, unknown>, _ctx: HostToolCheckContext) => ({
        kind: 'allow' as const,
      }),
    );
  }

  function manager(source: ConfigService | undefined, checker: HostToolChecker) {
    return createPermissionManager({
      organizationPolicy: source,
      cwd: '/repo',
      rules: localRules,
      builtinToolCheckers: new Map([['Probe', checker]]),
      checkerDeps: {
        skill: {
          isAllowedForMainSession: () => true,
          isDisabled: () => false,
          hasOnlySafeProperties: () => false,
        },
        mcpCall: { isKnownTool: () => false, parseQualifiedName: () => ({}) },
      },
    });
  }

  describe('global command rule context', () => {
    it('delivers shared rules without copying them into local state or changing the mode', async () => {
      const check = observer();
      const permission = manager(sharedSource(policy).service, { check });
      await permission.check(request);
      const ctx = check.mock.lastCall![1];
      expect(ctx.globalRules).toEqual(policy.rules);
      expect(ctx.rules).toMatchObject(localRules);
      expect(permission.getRules()).toMatchObject(localRules);
      expect(permission.getPermissionMode()).toBe('default');
    });

    it('reads replacements and removals in existing, new and child sessions', async () => {
      const source = sharedSource({ disabledModes: [] });
      const check = observer();
      const first = manager(source.service, { check });
      const second = manager(source.service, { check });
      const child = constrainAgentPermissions(first, ['Write']);
      await first.check(request);
      expect(check.mock.lastCall?.[1].globalRules).toBeUndefined();

      source.update(policy);
      const added = manager(source.service, { check });
      for (const permission of [first, second, child, added]) {
        await permission.check(request);
        expect(check.mock.lastCall?.[1].globalRules).toEqual(policy.rules);
      }

      const empty = { disabledModes: [], rules: { deny: [], ask: [] } };
      source.update(empty);
      for (const permission of [first, second, child, added]) {
        await permission.check(request);
        expect(check.mock.lastCall?.[1].globalRules).toEqual(empty.rules);
      }
      source.update({ disabledModes: [] });
      await first.check(request);
      expect(check.mock.lastCall?.[1].globalRules).toBeUndefined();
      source.update(undefined);
      await first.check(request);
      expect(check.mock.lastCall?.[1].globalRules).toBeUndefined();
      expect(source.service.start).not.toHaveBeenCalled();
      expect(source.service.stop).not.toHaveBeenCalled();
      expect(source.service.onValueChange).not.toHaveBeenCalled();
    });

    it('keeps global rules available under local rule overrides and does not mutate them', async () => {
      const check = observer();
      const permission = manager(sharedSource(policy).service, { check });
      const replacement = { allow: { session: ['Read'] }, deny: {}, ask: {} };
      const additional = { allow: { session: ['Read'] }, deny: {}, ask: {} };
      await permission.check(request, { rules: replacement });
      expect(check.mock.lastCall?.[1].rules).toMatchObject(replacement);
      expect(check.mock.lastCall?.[1].globalRules).toEqual(policy.rules);
      await permission.check(request, { additionalRules: additional });
      expect(check.mock.lastCall?.[1].globalRules).toEqual(policy.rules);
      expect(check.mock.lastCall?.[1].rules.allow).toEqual({
        userSettings: ['Bash'],
        session: ['Read'],
      });
      expect(replacement).toEqual({
        allow: { session: ['Read'] },
        deny: {},
        ask: {},
      });
      expect(additional).toEqual(replacement);
      expect(permission.getRules()).toMatchObject(localRules);
    });

    it('delivers current rules to registered checkers without changing their map', async () => {
      const source = sharedSource(policy);
      const original = observer();
      const replacement = observer();
      const checker = { check: replacement };
      const map = new Map([['Probe', checker]]);
      const permission = manager(source.service, { check: original });
      permission.permissionManager!.registerSceneCheckers('main', map);
      await permission.check(request);
      expect(replacement.mock.lastCall?.[1].globalRules).toEqual(policy.rules);
      expect(map.get('Probe')).toBe(checker);
      expect(original).not.toHaveBeenCalled();
      registerTestChecker(permission, 'Probe', { check: original });
      await permission.check(request);
      expect(original.mock.lastCall?.[1].globalRules).toEqual(policy.rules);
    });

    it('delivers updates to registered checkers', async () => {
      const source = sharedSource(policy);
      const check = observer();
      const permission = manager(source.service, { check: observer() });
      const late = new Map([['LateTool', { check }]]);
      permission.permissionManager!.registerSceneCheckers('main', late);
      await checkWithOverride(permission, { ...request, toolName: 'LateTool' }, {});
      expect(check.mock.lastCall?.[1].globalRules).toEqual(policy.rules);
      source.update({ disabledModes: [] });
      await checkWithOverride(permission, { ...request, toolName: 'LateTool' }, {});
      expect(check.mock.lastCall?.[1].globalRules).toBeUndefined();
      late.delete('LateTool');
      permission.permissionManager!.registerSceneCheckers('main', late);
      check.mockClear();
      await permission.check({ ...request, toolName: 'LateTool' });
      expect(check).not.toHaveBeenCalled();
    });

    it('reads the latest global snapshot when the component rechecks a pending call', async () => {
      const source = sharedSource(policy);
      const seen: Array<PermissionPolicySnapshot['rules']> = [];
      const permission = manager(source.service, {
        check: (_input, ctx) => {
          seen.push(ctx.globalRules);
          return {
            kind: 'ask',
            reason: {
              message: 'Pending',
              attribution: { type: 'other', reason: 'pending' },
            },
          };
        },
      });
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const abort = new AbortController();
      const pending = checkWithOverride(permission, { ...request, signal: abort.signal }, {
          askHandler: (ctx: {
            onToolCheckResult: (listener: () => void) => () => void;
          }) =>
            new Promise((resolve) => {
              ctx.onToolCheckResult(() => resolve({ kind: 'rejected' }));
              entered();
            }),
        }, );
      try {
        await started;
        const updated: PermissionPolicySnapshot = {
          disabledModes: [],
          rules: { deny: ['Bash'], ask: [] },
        };
        source.update(updated);
        permission.setRules({ allow: {}, deny: {}, ask: {} });
        await pending;
        expect(seen[0]).toEqual(policy.rules);
        expect(seen.at(-1)).toEqual(updated.rules);

      } finally {
        abort.abort();
      }
    }, 5000);

    it('preserves the original checker context when no global source is configured', async () => {
      const check = observer();
      const permission = manager(undefined, { check });
      await permission.check(request);
      expect(check.mock.lastCall?.[1]).not.toHaveProperty('globalRules');
      expect(check.mock.lastCall?.[1].rules).toMatchObject(localRules);
    });
  });
});

describe('shell rules', () => {
  type Handler = AskHandler<ToolPermissionReason>;
  beforeAll(async () => {
    await initializeShellParsers();
  });
  function setup(
    rules: NonNullable<PermissionPolicySnapshot['rules']>,
    mode: PermissionMode = 'yolo',
    local: PermissionRules = {
      allow: { userSettings: ['Bash'] },
      deny: {},
      ask: {},
    },
  ) {
    let current = rules;
    const organizationPolicy: ConfigService = {
      start: async () => {},
      stop: async () => {},
      getValue: <T>() => ({ disabledModes: [], rules: current }) as T,
      onValueChange: () => () => {},
      onError: () => () => {},
    };
    const permission = createPermissionManager({
      organizationPolicy,
      cwd: '/repo',
      permissionMode: mode,
      rules: local,
      checkerDeps: {
        skill: {
          isAllowedForMainSession: () => true,
          isDisabled: () => false,
          hasOnlySafeProperties: () => false,
        },
        mcpCall: { isKnownTool: () => false, parseQualifiedName: () => ({}) },
      },
    });
    return {
      permission,
      update(r: typeof rules) {
        current = r;
      },
      run(command: string, askHandler?: Handler) {
        return checkWithOverride(
          permission,
          { toolName: 'Bash', toolUseId: 'shell-rule', input: { command } },
          { askHandler },
        );
      },
    };
  }
  const denyPush = { deny: ['Bash(git push:*)'], ask: [] };
  const askPush = { deny: [], ask: ['Bash(git push:*)'] };
  describe('managed Bash content rules', () => {
    it.each([
      'git push origin main',
      'FOO=bar git push origin main',
      'echo ok && git push origin main',
      'echo "$(git push origin main)"',
    ])('denies executable command: %s', async (command) => {
      const result = await setup(denyPush).run(command);
      expect(result.kind).toBe('deny');
      expect(result.toolCheck).toMatchObject({
        extra: { denialReason: { attribution: { type: 'managedRule' } } },
      });
    });
    it.each(['git status', "echo 'git push origin main'"])(
      'does not deny nonmatching or quoted data: %s',
      async (command) => {
        expect((await setup(denyPush).run(command)).kind).toBe('allow');
      },
    );
    it.each(['default', 'auto', 'yolo', 'acceptEdits'] as const)(
      'keeps content ask manual under %s',
      async (mode) => {
        const handler = vi.fn<Handler>(async (ctx) => {
          expect(ctx.toolCheckResult).toMatchObject({
            kind: 'ask',
            reason: { attribution: { type: 'managedRule' } },
          });
          if (ctx.toolCheckResult.kind === 'ask')
            expect(ctx.toolCheckResult.suggestions).toBeUndefined();
          return { kind: 'approved' };
        });
        const s = setup(askPush, mode);
        expect((await s.run('git push origin main', handler)).kind).toBe('allow');
        expect(handler).toHaveBeenCalledOnce();
      },
    );
    it('uses the same interpreter-wrapper matching boundary as local rules', async () => {
      const command = "bash -lc 'git push origin main'";
      const local = setup({ deny: [], ask: [] }, 'yolo', {
        allow: { userSettings: ['Bash'] },
        deny: { userSettings: ['Bash(git push:*)'] },
        ask: {},
      });
      const managed = await setup(denyPush).run(command);
      const original = await local.run(command);
      // This is parity coverage, not proof that interpreter payloads are denied.
      expect(managed.kind).toBe(original.kind);
    });
    it('uses the actual shell tool name for Monitor rules', async () => {
      const s = setup({ deny: ['Monitor(git push:*)'], ask: [] });
      expect(
        (
          await s.permission.check({
            toolName: 'Monitor',
            toolUseId: 'monitor-rule',
            input: { command: 'git push origin main' },
          })
        ).kind,
      ).toBe('deny');
      expect((await s.run('git push origin main')).kind).toBe('allow');
    });
    it('refuses content ask in DontAsk', async () => {
      const handler = vi.fn<Handler>(async () => ({ kind: 'approved' }));
      expect(
        (await setup(askPush, 'dontAsk').run('git push origin main', handler))
          .kind,
      ).toBe('deny');
      expect(handler).not.toHaveBeenCalled();
    });
    it('lets content deny outrank managed and local bare asks', async () => {
      const handler = vi.fn<Handler>(async () => ({ kind: 'approved' }));
      const s = setup({ deny: ['Bash(git push:*)'], ask: ['Bash'] }, 'yolo', {
        allow: {},
        deny: {},
        ask: { userSettings: ['Bash'] },
      });
      expect((await s.run('git push origin main', handler)).kind).toBe('deny');
      expect(handler).not.toHaveBeenCalled();
    });
    it('lets local content deny outrank a managed bare ask', async () => {
      const handler = vi.fn<Handler>(async () => ({ kind: 'approved' }));
      const s = setup({ deny: [], ask: ['Bash'] }, 'yolo', {
        allow: {},
        deny: { userSettings: ['Bash(git push:*)'] },
        ask: {},
      });
      expect((await s.run('git push origin main', handler)).kind).toBe('deny');
      expect(handler).not.toHaveBeenCalled();
    });
    it('lets managed prefix deny outrank a local exact ask', async () => {
      const s = setup(denyPush, 'yolo', {
        allow: {},
        deny: {},
        ask: { userSettings: ['Bash(git push origin main)'] },
      });
      expect((await s.run('git push origin main')).kind).toBe('deny');
    });
    it('lets local prefix deny outrank exact asks', async () => {
      const s = setup({ deny: [], ask: ['Bash(git push origin main)'] }, 'yolo', {
        allow: {},
        deny: { userSettings: ['Bash(git push:*)'] },
        ask: { userSettings: ['Bash(git push origin main)'] },
      });
      expect((await s.run('git push origin main')).kind).toBe('deny');
    });
    it('collects a managed deny from another segment before matching an ask', async () => {
      const s = setup({ deny: ['Bash(git push:*)'], ask: ['Bash(echo:*)'] });
      expect((await s.run('echo ok && git push origin main')).kind).toBe('deny');
    });
    it('shares exact and wildcard syntax with existing matching', async () => {
      const exact = setup({ deny: ['Bash(echo hello)'], ask: [] });
      expect((await exact.run('echo hello')).kind).toBe('deny');
      expect((await exact.run('echo hello extra')).kind).toBe('allow');
      expect(
        (
          await setup({ deny: ['Bash(git * --force)'], ask: [] }).run(
            'git push origin --force',
          )
        ).kind,
      ).toBe('deny');
    });
    it('replaces and clears rules for an existing permission object', async () => {
      const s = setup(denyPush);
      expect((await s.run('git push origin main')).kind).toBe('deny');
      s.update({ deny: ['Bash(git status)'], ask: [] });
      expect((await s.run('git push origin main')).kind).toBe('allow');
      expect((await s.run('git status')).kind).toBe('deny');
      s.update({ deny: [], ask: [] });
      expect((await s.run('git status')).kind).toBe('allow');
    });
  });
});

describe('powershell rules', () => {
  type Handler = AskHandler<ToolPermissionReason>;
  type Rules = NonNullable<PermissionPolicySnapshot['rules']>;

  // Supply parser output only. Rule matching, mode handling and approval use the real code.
  function parsedCommands(
    commands: readonly string[],
    nested: readonly string[] = [],
  ) {
    const entry = (text: string) => {
      const [name, ...args] = text.split(' ');
      return {
        name,
        nameType: name.includes('-') ? 'Cmdlet' : 'Application',
        elementType: 'StringConstant',
        text,
        args,
        elements: [name, ...args].map((text) => ({
          text,
          elementType: 'StringConstant',
          staticValue: text,
          children: [],
        })),
        redirections: [],
      };
    };
    _setPowerShellParserRunnerForTest(async () => ({
      stdout: JSON.stringify({
        valid: true,
        errors: [],
        statements: [
          {
            statementType: 'PipelineAst',
            text: commands.join('; '),
            commands: commands.map(entry),
            nestedCommands: nested.map(entry),
            redirections: [],
          },
        ],
        variables: [],
        typeLiterals: [],
        hasStopParsing: false,
        hasUsingStatements: false,
        hasScriptRequirements: false,
        hasBackgroundJob: false,
      }),
      stderr: '',
      exitCode: 0,
      timedOut: false,
    }));
  }

  function setup(
    rules: Rules,
    mode: PermissionMode = 'yolo',
    local: PermissionRules = {
      allow: { userSettings: ['PowerShell'] },
      deny: {},
      ask: {},
    },
  ) {
    let current = rules;
    const source: ConfigService = {
      start: async () => {},
      stop: async () => {},
      getValue: <T>() => ({ disabledModes: [], rules: current }) as T,
      onValueChange: () => () => {},
      onError: () => () => {},
    };
    const permission = createPermissionManager({
      organizationPolicy: source,
      cwd: '/repo',
      permissionMode: mode,
      rules: local,
      checkerDeps: {
        skill: {
          isAllowedForMainSession: () => true,
          isDisabled: () => false,
          hasOnlySafeProperties: () => false,
        },
        mcpCall: { isKnownTool: () => false, parseQualifiedName: () => ({}) },
      },
    });
    return {
      update(value: Rules) {
        current = value;
      },
      run(command: string, askHandler?: Handler) {
        return checkWithOverride(
          permission,
          {
            toolName: 'PowerShell',
            toolUseId: 'managed-powershell',
            input: { command },
          },
          { askHandler },
        );
      },
    };
  }
  const denyPush: Rules = { deny: ['PowerShell(git push:*)'], ask: [] };
  const askPush: Rules = { deny: [], ask: ['PowerShell(git push:*)'] };

  beforeEach(() => {
    _setPowerShellRuntimeForTest({ executable: 'pwsh', edition: 'core' });
  });
  afterEach(() => {
    _setPowerShellParserRunnerForTest();
    _resetPowerShellRuntimeForTest();
  });

  describe('managed PowerShell content rules', () => {
    it.each([
      'git push origin main',
      'GIT PUSH origin main',
      'git.exe push origin main',
    ])(
      'denies native command with existing normalization: %s',
      async (command) => {
        parsedCommands([command]);
        const result = await setup(denyPush).run(command);
        expect(result.kind).toBe('deny');
        expect(result.toolCheck).toMatchObject({
          extra: { denialReason: { attribution: { type: 'managedRule' } } },
        });
      },
    );
    it('checks each executable segment before an ask', async () => {
      parsedCommands(['Get-Date', 'git push origin main']);
      const result = await setup({
        ...denyPush,
        ask: ['PowerShell(Get-Date:*)'],
      }).run('Get-Date; git push origin main');
      expect(result.kind).toBe('deny');
    });
    it('checks nested executable commands reported by the parser', async () => {
      parsedCommands(
        ['Write-Output $(git push origin main)'],
        ['git push origin main'],
      );
      expect(
        (await setup(denyPush).run('Write-Output $(git push origin main)')).kind,
      ).toBe('deny');
    });
    it('uses the existing built-in alias normalization', async () => {
      parsedCommands(['gci .']);
      expect(
        (
          await setup({ deny: ['PowerShell(Get-ChildItem:*)'], ask: [] }).run(
            'gci .',
          )
        ).kind,
      ).toBe('deny');
    });
    it.each(['git status', "Write-Output 'git push origin main'"])(
      'does not deny unrelated commands or quoted data: %s',
      async (command) => {
        parsedCommands([command]);
        expect((await setup(denyPush).run(command)).kind).toBe('allow');
      },
    );
    it.each(['default', 'auto', 'yolo', 'acceptEdits'] as const)(
      'keeps managed ask manual in %s',
      async (mode) => {
        parsedCommands(['git push origin main']);
        const handler = vi.fn<Handler>(async (ctx) => {
          expect(ctx.toolCheckResult).toMatchObject({
            kind: 'ask',
            reason: { attribution: { type: 'managedRule' } },
          });
          if (ctx.toolCheckResult.kind === 'ask')
            expect(ctx.toolCheckResult.suggestions).toBeUndefined();
          return { kind: 'approved' };
        });
        expect(
          (await setup(askPush, mode).run('git push origin main', handler)).kind,
        ).toBe('allow');
        expect(handler).toHaveBeenCalledOnce();
      },
    );
    it('refuses managed ask in DontAsk', async () => {
      parsedCommands(['git push origin main']);
      const handler = vi.fn<Handler>(async () => ({ kind: 'approved' }));
      expect(
        (await setup(askPush, 'dontAsk').run('git push origin main', handler))
          .kind,
      ).toBe('deny');
      expect(handler).not.toHaveBeenCalled();
    });
    it('preserves a local prefix deny before managed ask', async () => {
      parsedCommands(['git push origin main']);
      const s = setup(askPush, 'yolo', {
        allow: {},
        deny: { userSettings: ['PowerShell(git push:*)'] },
        ask: {},
      });
      expect((await s.run('git push origin main')).kind).toBe('deny');
    });
    it.each([
      ['Get-Content secret.txt', 'Read(secret.txt)'],
      ['Set-Content secret.txt changed', 'Edit(secret.txt)'],
    ])('preserves file deny before managed ask: %s', async (command, rule) => {
      parsedCommands([command]);
      const handler = vi.fn<Handler>(async () => ({ kind: 'approved' }));
      const s = setup({ deny: [], ask: ['PowerShell(*)'] }, 'yolo', {
        allow: { userSettings: ['PowerShell'] },
        deny: { userSettings: [rule] },
        ask: {},
      });
      expect((await s.run(command, handler)).kind).toBe('deny');
      expect(handler).not.toHaveBeenCalled();
    });
    it('refuses managed ask when the person rejects', async () => {
      parsedCommands(['git push origin main']);
      const handler = vi.fn<Handler>(async () => ({ kind: 'rejected' }));
      expect(
        (await setup(askPush).run('git push origin main', handler)).kind,
      ).toBe('deny');
      expect(handler).toHaveBeenCalledOnce();
    });
    it('refuses managed ask when no approval handler is available', async () => {
      parsedCommands(['git push origin main']);
      expect((await setup(askPush).run('git push origin main')).kind).toBe(
        'deny',
      );
    });
    it('lets managed content deny outrank bare and exact asks', async () => {
      parsedCommands(['git push origin main']);
      const handler = vi.fn<Handler>(async () => ({ kind: 'approved' }));
      const s = setup({ ...denyPush, ask: ['PowerShell'] }, 'yolo', {
        allow: {},
        deny: {},
        ask: { userSettings: ['PowerShell(git push origin main)'] },
      });
      expect((await s.run('git push origin main', handler)).kind).toBe('deny');
      expect(handler).not.toHaveBeenCalled();
    });
    it('shares exact matching with local rules', async () => {
      const s = setup({ deny: ['PowerShell(Write-Output hello)'], ask: [] });
      parsedCommands(['Write-Output hello']);
      expect((await s.run('Write-Output hello')).kind).toBe('deny');
      parsedCommands(['Write-Output hello extra']);
      expect((await s.run('Write-Output hello extra')).kind).toBe('allow');
    });
    it('shares wildcard matching with local rules', async () => {
      parsedCommands(['git push origin --force']);
      expect(
        (
          await setup({ deny: ['PowerShell(git * --force)'], ask: [] }).run(
            'git push origin --force',
          )
        ).kind,
      ).toBe('deny');
    });
    it('reads replacement and clearing rules even when syntax is cached', async () => {
      parsedCommands(['git push origin main']);
      const s = setup(denyPush);
      expect((await s.run('git push origin main')).kind).toBe('deny');
      s.update({ deny: [], ask: [] });
      expect((await s.run('git push origin main')).kind).toBe('allow');
      s.update(denyPush);
      expect((await s.run('git push origin main')).kind).toBe('deny');
    });
    it('does not apply Bash content rules to PowerShell', async () => {
      parsedCommands(['git push origin main']);
      expect(
        (
          await setup({ deny: ['Bash(git push:*)'], ask: [] }).run(
            'git push origin main',
          )
        ).kind,
      ).toBe('allow');
    });
    it('still matches the original command when the parser fails', async () => {
      _setPowerShellParserRunnerForTest(async () => ({
        stdout: '',
        stderr: 'parser failed',
        exitCode: 1,
        timedOut: false,
      }));
      expect((await setup(denyPush).run('git push origin main')).kind).toBe(
        'deny',
      );
    });
  });
});

describe('file rules', () => {
  type Rules = NonNullable<PermissionPolicySnapshot['rules']>;
  type Handler = AskHandler<ToolPermissionReason>;
  let root: string;
  let cwd: string;
  const noRules: Rules = { deny: [], ask: [] };
  const calls = [
    ['Read', 'file_path', 'Read'],
    ['Glob', 'path', 'Read'],
    ['Grep', 'path', 'Read'],
    ['Write', 'file_path', 'Edit'],
    ['Edit', 'file_path', 'Edit'],
    ['NotebookEdit', 'notebook_path', 'Edit'],
  ] as const;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'test-managed-files-')));
    cwd = join(root, 'project');
    mkdirSync(join(cwd, 'private'), { recursive: true });
    writeFileSync(join(cwd, 'private', 'secret.txt'), 'test');
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function setup(
    rules: Rules,
    mode: PermissionMode = 'yolo',
    local: PermissionRules = {
      allow: { userSettings: calls.map(([tool]) => tool) },
      deny: {},
      ask: {},
    },
  ) {
    let current = rules;
    const source: ConfigService = {
      start: async () => {},
      stop: async () => {},
      getValue: <T>() => ({ disabledModes: [], rules: current }) as T,
      onValueChange: () => () => {},
      onError: () => () => {},
    };
    const permission = createPermissionManager({
      organizationPolicy: source,
      cwd,
      permissionMode: mode,
      rules: local,
      checkerDeps: {
        skill: {
          isAllowedForMainSession: () => true,
          isDisabled: () => false,
          hasOnlySafeProperties: () => false,
        },
        mcpCall: { isKnownTool: () => false, parseQualifiedName: () => ({}) },
      },
    });
    return {
      update(value: Rules) {
        current = value;
      },
      run(
        toolName: string,
        input: Record<string, unknown>,
        askHandler?: Handler,
      ) {
        return checkWithOverride(
          permission,
          { toolName, toolUseId: 'managed-file', input },
          { askHandler },
        );
      },
    };
  }

  describe('managed file content rules', () => {
    it.each(calls)(
      'denies %s using the existing %s path input',
      async (tool, field, scope) => {
        const s = setup({ deny: [`${scope}(/private/**)`], ask: [] });
        const result = await s.run(tool, {
          [field]: join(cwd, 'private', 'secret.txt'),
          pattern: 'test',
        });
        expect(result.kind).toBe('deny');
        expect(result.toolCheck).toMatchObject({
          extra: { denialReason: { attribution: { type: 'managedRule' } } },
        });
      },
    );
    it.each(['default', 'auto', 'yolo', 'acceptEdits'] as const)(
      'keeps read ask manual under %s',
      async (mode) => {
        const handler = vi.fn<Handler>(async (ctx) => {
          expect(ctx.toolCheckResult).toMatchObject({
            kind: 'ask',
            reason: { attribution: { type: 'managedRule' } },
          });
          if (ctx.toolCheckResult.kind === 'ask')
            expect(ctx.toolCheckResult.suggestions).toBeUndefined();
          return { kind: 'approved' };
        });
        expect(
          (
            await setup({ deny: [], ask: ['Read(/private/**)'] }, mode).run(
              'Read',
              { file_path: join(cwd, 'private', 'secret.txt') },
              handler,
            )
          ).kind,
        ).toBe('allow');
        expect(handler).toHaveBeenCalledOnce();
      },
    );
    it.each(['default', 'auto', 'yolo', 'acceptEdits'] as const)(
      'keeps write ask manual under %s',
      async (mode) => {
        const handler = vi.fn<Handler>(async (ctx) => {
          expect(ctx.toolCheckResult).toMatchObject({
            kind: 'ask',
            reason: { attribution: { type: 'managedRule' } },
          });
          return { kind: 'approved' };
        });
        expect(
          (
            await setup({ deny: [], ask: ['Edit(/private/**)'] }, mode).run(
              'Write',
              { file_path: join(cwd, 'private', 'secret.txt') },
              handler,
            )
          ).kind,
        ).toBe('allow');
        expect(handler).toHaveBeenCalledOnce();
      },
    );
    it.each([
      ['Read', 'Read'],
      ['Write', 'Edit'],
    ])('refuses %s managed ask in DontAsk', async (tool, scope) => {
      const handler = vi.fn<Handler>(async () => ({ kind: 'approved' }));
      expect(
        (
          await setup(
            { deny: [], ask: [`${scope}(/private/**)`] },
            'dontAsk',
          ).run(tool, { file_path: join(cwd, 'private', 'secret.txt') }, handler)
        ).kind,
      ).toBe('deny');
      expect(handler).not.toHaveBeenCalled();
    });
    it('lets local read deny outrank managed read ask', async () => {
      const s = setup({ deny: [], ask: ['Read(/private/**)'] }, 'yolo', {
        allow: { userSettings: ['Read'] },
        deny: { projectSettings: ['Read(/private/**)'] },
        ask: {},
      });
      expect(
        (await s.run('Read', { file_path: join(cwd, 'private', 'secret.txt') }))
          .kind,
      ).toBe('deny');
    });
    it('lets local write deny outrank managed write ask', async () => {
      const s = setup({ deny: [], ask: ['Edit(/private/**)'] }, 'yolo', {
        allow: { userSettings: ['Write'] },
        deny: { projectSettings: ['Edit(/private/**)'] },
        ask: {},
      });
      expect(
        (await s.run('Write', { file_path: join(cwd, 'private', 'secret.txt') }))
          .kind,
      ).toBe('deny');
    });
    it('does not deny a sibling path outside the matching directory', async () => {
      expect(
        (
          await setup({ deny: ['Read(/private/**)'], ask: [] }).run('Read', {
            file_path: join(cwd, 'private-other', 'visible.txt'),
          })
        ).kind,
      ).toBe('allow');
    });
    it('retains basename matching for a rootless glob', async () => {
      expect(
        (
          await setup({ deny: ['Read(*.txt)'], ask: [] }).run('Read', {
            file_path: join(cwd, 'private', 'secret.txt'),
          })
        ).kind,
      ).toBe('deny');
    });
    it.each(calls)(
      'matches managed rootless directory rules for %s',
      async (tool, field, scope) => {
        mkdirSync(join(cwd, 'policy-private'));
        writeFileSync(join(cwd, 'policy-private', 'secret.txt'), 'test');
        const s = setup({ deny: [`${scope}(**/policy-private/**)`], ask: [] });
        expect(
          (
            await s.run(tool, {
              [field]: join(cwd, 'policy-private', 'secret.txt'),
              pattern: 'test',
            })
          ).kind,
        ).toBe('deny');
      },
    );
    it.each(['policy-private/**', '**/policy-private/**'])(
      'keeps managed rootless directory boundaries for %s',
      async (pattern) => {
        const s = setup({ deny: [`Read(${pattern})`], ask: [] });
        expect(
          (
            await s.run('Read', {
              file_path: join(root, 'outside', 'policy-private', 'secret.txt'),
            })
          ).kind,
        ).toBe('deny');
        expect(
          (
            await s.run('Read', {
              file_path: join(cwd, 'policy-private-other', 'visible.txt'),
            })
          ).kind,
        ).toBe('allow');
      },
    );
    it('keeps managed rootless directory asks manual', async () => {
      const handler = vi.fn<Handler>(async () => ({ kind: 'approved' }));
      const s = setup({ deny: [], ask: ['Read(**/policy-private/**)'] });
      expect(
        (
          await s.run(
            'Read',
            {
              file_path: join(cwd, 'policy-private', 'secret.txt'),
            },
            handler,
          )
        ).kind,
      ).toBe('allow');
      expect(handler).toHaveBeenCalledOnce();
    });
    it('supports an absolute path pattern', async () => {
      const file = join(cwd, 'private', 'secret.txt');
      expect(
        (
          await setup({ deny: [`Read(/${file})`], ask: [] }).run('Read', {
            file_path: file,
          })
        ).kind,
      ).toBe('deny');
    });
    it('supports a home-relative path pattern', async () => {
      expect(
        (
          await setup({ deny: ['Read(~/.managed-policy-test)'], ask: [] }).run(
            'Read',
            { file_path: join(homedir(), '.managed-policy-test') },
          )
        ).kind,
      ).toBe('deny');
    });
    it('checks the real symlink target', async () => {
      const outside = join(root, 'outside');
      mkdirSync(outside);
      writeFileSync(join(outside, 'secret.txt'), 'test');
      symlinkSync(outside, join(cwd, 'linked'), 'dir');
      expect(
        (
          await setup({ deny: [`Read(/${outside}/**)`], ask: [] }).run('Read', {
            file_path: join(cwd, 'linked', 'secret.txt'),
          })
        ).kind,
      ).toBe('deny');
    });
    it('also checks the caller-visible symlink path', async () => {
      symlinkSync(join(cwd, 'private'), join(cwd, 'linked'), 'dir');
      expect(
        (
          await setup({ deny: ['Read(/linked/**)'], ask: [] }).run('Read', {
            file_path: join(cwd, 'linked', 'secret.txt'),
          })
        ).kind,
      ).toBe('deny');
    });
    it('replaces and clears rules for an existing session', async () => {
      const s = setup({ deny: ['Read(/private/**)'], ask: [] });
      const input = { file_path: join(cwd, 'private', 'secret.txt') };
      expect((await s.run('Read', input)).kind).toBe('deny');
      s.update(noRules);
      expect((await s.run('Read', input)).kind).toBe('allow');
      s.update({ deny: ['Read(/private/**)'], ask: [] });
      expect((await s.run('Read', input)).kind).toBe('deny');
    });
    it('does not apply read rules to writes or edit rules to reads', async () => {
      const input = { file_path: join(cwd, 'private', 'secret.txt') };
      expect(
        (
          await setup({ deny: ['Read(/private/**)'], ask: [] }).run(
            'Write',
            input,
          )
        ).kind,
      ).toBe('allow');
      expect(
        (await setup({ deny: ['Edit(/private/**)'], ask: [] }).run('Read', input))
          .kind,
      ).toBe('allow');
    });
    it.each(['Glob', 'Grep'])(
      'keeps root-wide managed ask when %s has no explicit path',
      async (tool) => {
        const handler = vi.fn<Handler>(async () => ({ kind: 'approved' }));
        expect(
          (
            await setup({ deny: [], ask: ['Read(/**)'] }).run(
              tool,
              { pattern: 'test' },
              handler,
            )
          ).kind,
        ).toBe('allow');
        expect(handler).toHaveBeenCalledOnce();
      },
    );
    it('does not let internal editable paths bypass a managed ask', async () => {
      const internalPaths = qwenInternalPathDeps.resolve({ cwd });
      const file = join(internalPaths.projectConfigDir!, 'todo.md');
      expect(checkEditableInternalPath(file, cwd, internalPaths)).toBe(true);
      const handler = vi.fn<Handler>(async (ctx) => {
        expect(ctx.toolCheckResult).toMatchObject({
          kind: 'ask',
          reason: { attribution: { type: 'managedRule' } },
        });
        return { kind: 'approved' };
      });
      expect(
        (
          await setup({ deny: [], ask: ['Edit(**/todo.md)'] }).run(
            'Write',
            { file_path: file },
            handler,
          )
        ).kind,
      ).toBe('allow');
      expect(handler).toHaveBeenCalledOnce();
    });
  });
});

describe('content rules', () => {
  type Rules = NonNullable<PermissionPolicySnapshot['rules']>;
  type Handler = AskHandler<ToolPermissionReason>;
  const tools = [
    { tool: 'Agent', content: 'Explore', input: { subagent_type: 'explore' } },
    { tool: 'Skill', content: 'review:*', input: { skill: '/review-pr' } },
    { tool: 'Workflow', content: 'build', input: { name: 'build' } },
    {
      tool: 'WebFetch',
      content: 'nodejs.org',
      input: { url: 'https://nodejs.org/api/fs.html' },
    },
  ] as const;
  function setup(
    rules: Rules,
    mode: PermissionMode = 'yolo',
    local: PermissionRules = {
      allow: { userSettings: tools.map((t) => t.tool) },
      deny: {},
      ask: {},
    },
    skill: Partial<SkillCheckerDeps> = {},
  ) {
    let current = rules;
    const source: ConfigService = {
      start: async () => {},
      stop: async () => {},
      getValue: <T>() => ({ disabledModes: [], rules: current }) as T,
      onValueChange: () => () => {},
      onError: () => () => {},
    };
    const resolveAuto = vi.fn(async () => ({ kind: 'allow' as const }));
    const permission = createPermissionManager({
      organizationPolicy: source,
      cwd: '/repo',
      permissionMode: mode,
      rules: local,
      resolveAuto,
      checkerDeps: {
        skill: {
          isAllowedForMainSession: () => true,
          isDisabled: () => false,
          hasOnlySafeProperties: () => true,
          ...skill,
        },
        mcpCall: { isKnownTool: () => false, parseQualifiedName: () => ({}) },
      },
    });
    return {
      resolveAuto,
      update(value: Rules) {
        current = value;
      },
      run(
        toolName: string,
        input: Record<string, unknown>,
        askHandler?: Handler,
      ) {
        return checkWithOverride(
          permission,
          { toolName, input, toolUseId: 'managed-content' },
          { askHandler },
        );
      },
    };
  }

  describe('managed shared content rules', () => {
    it.each(tools)(
      'denies $tool despite a local allow and builtin defaults',
      async ({ tool, content, input }) => {
        const result = await setup({
          deny: [`${tool}(${content})`],
          ask: [],
        }).run(tool, input);
        expect(result.kind).toBe('deny');
        expect(result.toolCheck).toMatchObject({
          extra: { denialReason: { attribution: { type: 'managedRule' } } },
        });
      },
    );
    it.each(tools)(
      'keeps $tool ask manual on every invocation',
      async ({ tool, content, input }) => {
        const handler = vi.fn<Handler>(async (ctx) => {
          expect(ctx.toolCheckResult).toMatchObject({
            kind: 'ask',
            reason: { attribution: { type: 'managedRule' } },
          });
          if (ctx.toolCheckResult.kind === 'ask')
            expect(ctx.toolCheckResult.suggestions).toBeUndefined();
          return { kind: 'approved' };
        });
        const s = setup({ deny: [], ask: [`${tool}(${content})`] });
        expect((await s.run(tool, input, handler)).kind).toBe('allow');
        expect((await s.run(tool, input, handler)).kind).toBe('allow');
        expect(handler).toHaveBeenCalledTimes(2);
      },
    );
    it.each(tools)(
      'preserves local content deny for $tool',
      async ({ tool, content, input }) => {
        const s = setup({ deny: [], ask: [`${tool}(${content})`] }, 'yolo', {
          allow: {},
          deny: { userSettings: [`${tool}(${content})`] },
          ask: {},
        });
        expect((await s.run(tool, input)).kind).toBe('deny');
      },
    );
    it.each(tools)(
      'refuses $tool managed ask in DontAsk',
      async ({ tool, content, input }) => {
        const handler = vi.fn<Handler>(async () => ({ kind: 'approved' }));
        expect(
          (
            await setup(
              { deny: [], ask: [`${tool}(${content})`] },
              'dontAsk',
            ).run(tool, input, handler)
          ).kind,
        ).toBe('deny');
        expect(handler).not.toHaveBeenCalled();
      },
    );
    it.each(tools)(
      'preserves $tool behavior for a nonmatching managed rule',
      async ({ tool, input }) => {
        expect(
          (
            await setup({ deny: [`${tool}(unrelated)`], ask: [] }).run(
              tool,
              input,
            )
          ).kind,
        ).toBe('allow');
      },
    );
    it.each(tools)(
      'replaces and clears $tool content rules for the same session',
      async ({ tool, content, input }) => {
        const s = setup({ deny: [`${tool}(${content})`], ask: [] });
        expect((await s.run(tool, input)).kind).toBe('deny');
        s.update({ deny: [`${tool}(unrelated)`], ask: [] });
        expect((await s.run(tool, input)).kind).toBe('allow');
        s.update({ deny: [], ask: [] });
        expect((await s.run(tool, input)).kind).toBe('allow');
      },
    );
    it.each(['default', 'auto', 'acceptEdits'] as const)(
      'keeps shared content ask manual in %s',
      async (mode) => {
        const handler = vi.fn<Handler>(async () => ({ kind: 'approved' }));
        const s = setup({ deny: [], ask: ['Skill(review:*)'] }, mode);
        expect((await s.run('Skill', { skill: 'review-pr' }, handler)).kind).toBe(
          'allow',
        );
        expect(handler).toHaveBeenCalledOnce();
        expect(s.resolveAuto).not.toHaveBeenCalled();
      },
    );
    it('preserves disabled-skill refusal before managed ask', async () => {
      const handler = vi.fn<Handler>(async () => ({ kind: 'approved' }));
      const s = setup({ deny: [], ask: ['Skill(review:*)'] }, 'yolo', undefined, {
        isDisabled: () => true,
      });
      expect((await s.run('Skill', { skill: 'review-pr' }, handler)).kind).toBe(
        'deny',
      );
      expect(handler).not.toHaveBeenCalled();
    });
    it('preserves the main-session skill allowlist before managed ask', async () => {
      const handler = vi.fn<Handler>(async () => ({ kind: 'approved' }));
      const s = setup({ deny: [], ask: ['Skill(review:*)'] }, 'yolo', undefined, {
        isAllowedForMainSession: () => false,
      });
      expect((await s.run('Skill', { skill: 'review-pr' }, handler)).kind).toBe(
        'deny',
      );
      expect(handler).not.toHaveBeenCalled();
    });
    it('keeps the managed ask when a local content rule also asks', async () => {
      const handler = vi.fn<Handler>(async (ctx) => {
        expect(ctx.toolCheckResult).toMatchObject({
          kind: 'ask',
          reason: { attribution: { type: 'managedRule' } },
        });
        if (ctx.toolCheckResult.kind === 'ask')
          expect(ctx.toolCheckResult.suggestions).toBeUndefined();
        return { kind: 'approved' };
      });
      const s = setup({ deny: [], ask: ['Agent(Explore)'] }, 'yolo', {
        allow: {},
        deny: {},
        ask: { userSettings: ['Agent(Explore)'] },
      });
      expect(
        (await s.run('Agent', { subagent_type: 'explore' }, handler)).kind,
      ).toBe('allow');
      expect(handler).toHaveBeenCalledOnce();
    });
    it('keeps reusable suggestions for ordinary local Agent asks', async () => {
      const handler = vi.fn<Handler>(async (ctx) => {
        expect(ctx.toolCheckResult).toMatchObject({
          kind: 'ask',
          reason: { attribution: { type: 'rule' } },
          suggestions: [{ type: 'addRules' }],
        });
        return { kind: 'approved' };
      });
      const s = setup({ deny: [], ask: [] }, 'default', {
        allow: {},
        deny: {},
        ask: { userSettings: ['Agent(Explore)'] },
      });
      expect(
        (await s.run('Agent', { subagent_type: 'explore' }, handler)).kind,
      ).toBe('allow');
      expect(handler).toHaveBeenCalledOnce();
    });
    it('uses the existing skill name fallback and slash-prefix syntax', async () => {
      expect(
        (
          await setup({ deny: ['Skill(/review:*)'], ask: [] }).run('Skill', {
            name: 'review-pr',
          })
        ).kind,
      ).toBe('deny');
    });
    it('uses the existing workflow script-path fallback', async () => {
      expect(
        (
          await setup({ deny: ['Workflow(scripts/build.ts)'], ask: [] }).run(
            'Workflow',
            { scriptPath: 'scripts/build.ts' },
          )
        ).kind,
      ).toBe('deny');
    });
    it('matches a URL path without also denying a sibling URL', async () => {
      const s = setup({ deny: ['WebFetch(nodejs.org/api/fs.html)'], ask: [] });
      expect(
        (await s.run('WebFetch', { url: 'https://nodejs.org/api/fs.html' })).kind,
      ).toBe('deny');
      expect(
        (await s.run('WebFetch', { url: 'https://nodejs.org/api/path.html' }))
          .kind,
      ).toBe('allow');
    });
  });
});

describe('mcp rules', () => {
  type Rules = NonNullable<PermissionPolicySnapshot['rules']>;
  type Handler = AskHandler<ToolPermissionReason>;
  const target = 'mcp__files__read';
  const other = 'mcp__other__read';
  const entries = [
    { name: 'mcp_call', input: { toolName: target } },
    // Input cannot replace the identity held by a directly registered checker.
    { name: 'FilesAlias', input: { toolName: other } },
    { name: target, input: {} },
  ] as const;

  function setup(
    rules: Rules,
    mode: PermissionMode = 'yolo',
    local: PermissionRules = {
      allow: { userSettings: ['mcp_call', 'FilesAlias', 'mcp__*'] },
      deny: {},
      ask: {},
    },
  ) {
    let current = rules;
    const source: ConfigService = {
      start: async () => {},
      stop: async () => {},
      getValue: <T>() => ({ disabledModes: [], rules: current }) as T,
      onValueChange: () => () => {},
      onError: () => () => {},
    };
    const resolveAuto = vi.fn(async () => ({ kind: 'allow' as const }));
    const checker = createMcpToolChecker({
      serverName: 'files',
      toolName: 'read',
    });
    const permission = createPermissionManager({
      organizationPolicy: source,
      cwd: '/repo',
      permissionMode: mode,
      rules: local,
      resolveAuto,
      builtinToolCheckers: new Map([
        ['FilesAlias', checker],
        [target, checker],
      ]),
      checkerDeps: {
        skill: {
          isAllowedForMainSession: () => true,
          isDisabled: () => false,
          hasOnlySafeProperties: () => true,
        },
        mcpCall: {
          isKnownTool: (name) =>
            [target, other, 'mcp__files__write', 'malformed'].includes(name),
          parseQualifiedName: parseMcpToolName,
        },
      },
    });
    return {
      permission,
      resolveAuto,
      update(value: Rules) {
        current = value;
      },
      run(name: string, input: Record<string, unknown>, askHandler?: Handler) {
        return checkWithOverride(
          permission,
          { toolName: name, input, toolUseId: 'managed-mcp' },
          { askHandler },
        );
      },
    };
  }

  describe('managed MCP target rules', () => {
    describe.each(entries)('$name entry', ({ name, input }) => {
      it.each([target, 'mcp__files__*', 'mcp__*'])(
        'denies the actual target by %s',
        async (rule) => {
          const result = await setup({ deny: [rule], ask: [] }).run(name, input);
          expect(result.kind).toBe('deny');
          expect(result.toolCheck).toMatchObject({
            extra: { denialReason: { attribution: { type: 'managedRule' } } },
          });
        },
      );
      it('requires manual approval for every call despite local allow', async () => {
        const handler = vi.fn<Handler>(async (ctx) => {
          expect(ctx.toolCheckResult).toMatchObject({
            kind: 'ask',
            reason: { attribution: { type: 'managedRule' } },
          });
          if (ctx.toolCheckResult.kind === 'ask')
            expect(ctx.toolCheckResult.suggestions).toBeUndefined();
          return { kind: 'approved' };
        });
        const s = setup({ deny: [], ask: ['mcp__files__*'] });
        expect((await s.run(name, input, handler)).kind).toBe('allow');
        expect((await s.run(name, input, handler)).kind).toBe('allow');
        expect(handler).toHaveBeenCalledTimes(2);
      });
      it('refuses managed target ask in DontAsk', async () => {
        const handler = vi.fn<Handler>(async () => ({ kind: 'approved' }));
        expect(
          (
            await setup({ deny: [], ask: [target] }, 'dontAsk').run(
              name,
              input,
              handler,
            )
          ).kind,
        ).toBe('deny');
        expect(handler).not.toHaveBeenCalled();
      });
      it('keeps a local target deny above managed ask', async () => {
        const s = setup({ deny: [], ask: [target] }, 'yolo', {
          allow: {},
          deny: { userSettings: ['mcp__files__*'] },
          ask: {},
        });
        expect((await s.run(name, input)).kind).toBe('deny');
      });
      it('reads replaced and cleared policies in the same session', async () => {
        const s = setup({ deny: [target], ask: [] });
        expect((await s.run(name, input)).kind).toBe('deny');
        s.update({ deny: ['mcp__other__*'], ask: [] });
        expect((await s.run(name, input)).kind).toBe('allow');
        s.update({ deny: [], ask: [] });
        expect((await s.run(name, input)).kind).toBe('allow');
      });
    });
    it.each(['default', 'auto', 'acceptEdits'] as const)(
      'keeps dispatcher target ask manual under %s',
      async (mode) => {
        const handler = vi.fn<Handler>(async () => ({ kind: 'approved' }));
        const s = setup({ deny: [], ask: [target] }, mode);
        expect(
          (await s.run('mcp_call', { toolName: target }, handler)).kind,
        ).toBe('allow');
        expect(handler).toHaveBeenCalledOnce();
        expect(s.resolveAuto).not.toHaveBeenCalled();
      },
    );
    it.each([other, 'mcp__files__write'])(
      'does not deny a different target: %s',
      async (toolName) => {
        expect(
          (await setup({ deny: [target], ask: [] }).run('mcp_call', { toolName }))
            .kind,
        ).toBe('allow');
      },
    );
    it.each([
      [{}, 'mcp.no_identity.deny'],
      [{ toolName: 'mcp__missing__tool' }, 'mcp.unknown_tool.deny'],
      [{ toolName: 'malformed' }, 'mcp.malformed_identity.deny'],
    ] as const)('keeps existing target validation: %j', async (input, point) => {
      const result = await setup({ deny: [], ask: ['mcp__*'] }).run(
        'mcp_call',
        input,
      );
      expect(result.kind).toBe('deny');
      expect(result.toolCheck.extra).toMatchObject({ decisionPoint: point });
    });
    it('keeps target deny above a managed ask on the dispatcher itself', async () => {
      const handler = vi.fn<Handler>(async () => ({ kind: 'approved' }));
      expect(
        (
          await setup({ deny: [target], ask: ['mcp_call'] }).run(
            'mcp_call',
            { toolName: target },
            handler,
          )
        ).kind,
      ).toBe('deny');
      expect(handler).not.toHaveBeenCalled();
    });
    it('keeps a dispatcher deny above managed target ask', async () => {
      expect(
        (
          await setup({ deny: ['mcp_call'], ask: [target] }).run('mcp_call', {
            toolName: target,
          })
        ).kind,
      ).toBe('deny');
    });
    it('refuses managed target ask when no approval channel is available', async () => {
      expect(
        (
          await setup({ deny: [], ask: [target] }).run('mcp_call', {
            toolName: target,
          })
        ).kind,
      ).toBe('deny');
    });
    it('keeps per-tool and per-server suggestions for ordinary MCP asks', async () => {
      const handler = vi.fn<Handler>(async (ctx) => {
        expect(ctx.toolCheckResult).toMatchObject({
          kind: 'ask',
          suggestions: [
            { rules: [{ toolName: target }] },
            { rules: [{ toolName: 'mcp__files__*' }] },
          ],
        });
        return { kind: 'approved' };
      });
      const s = setup({ deny: [], ask: [] }, 'default', {
        allow: {},
        deny: {},
        ask: {},
      });
      expect((await s.run('mcp_call', { toolName: target }, handler)).kind).toBe(
        'allow',
      );
      expect(handler).toHaveBeenCalledOnce();
    });
  });
});

describe('tool rules', () => {
  type CheckHandler = AskHandler<ToolPermissionReason>;




  function source(initial: PermissionPolicySnapshot['rules']) {
    let rules = initial;
    const service: ConfigService = {
      start: async () => {},
      stop: async () => {},
      getValue: <T>() => ({ disabledModes: [], rules }) as T,
      onValueChange: () => () => {},
      onError: () => () => {},
    };
    return {
      service,
      update(next: PermissionPolicySnapshot['rules']) {
        rules = next;
      },
    };
  }
  function manager(
    shared: ReturnType<typeof source>,
    mode: 'default' | 'auto' | 'yolo' | 'acceptEdits' | 'dontAsk' = 'default',
    askHandler?: HostAskHandler,
  ) {
    return createPermissionManager({
      organizationPolicy: shared.service,
      cwd: '/repo',
      permissionMode: mode,
      askHandler,
      rules: { allow: { userSettings: ['Bash'] }, deny: {}, ask: {} },
      checkerDeps: {
        skill: {
          isAllowedForMainSession: () => true,
          isDisabled: () => false,
          hasOnlySafeProperties: () => false,
        },
        mcpCall: { isKnownTool: () => false, parseQualifiedName: () => ({}) },
      },
    });
  }
  const request = {
    toolName: 'Bash',
    input: { command: 'echo rule-test' },
    toolUseId: 'managed-tool',
  };
  const deny = { deny: ['Bash'], ask: [] };
  const ask = { deny: [], ask: ['Bash'] };

  describe('managed tool-level rules', () => {
    it('denies despite a local tool allow and a per-call allow', async () => {
      const p = manager(source(deny), 'yolo');
      const result = await p.check(request, {
        rules: { allow: { session: ['Bash'] }, deny: {}, ask: {} },
      });
      expect(result.kind).toBe('deny');
      expect(result.toolCheck).toMatchObject({
        extra: { denialReason: { attribution: { type: 'managedRule' } } },
      });
      expect(p.getRules().allow).toEqual({ userSettings: ['Bash'] });
    });
    it.each(['default', 'auto', 'yolo', 'acceptEdits'] as const)(
      'keeps managed ask under %s and asks on every call',
      async (mode) => {
        const p = manager(source(ask), mode);
        const handler = vi.fn<CheckHandler>(async (ctx) => {
          expect(ctx.toolCheckResult).toMatchObject({
            kind: 'ask',
            reason: { attribution: { type: 'managedRule' } },
          });
          if (ctx.toolCheckResult.kind === 'ask')
            expect(ctx.toolCheckResult.suggestions).toBeUndefined();
          return { kind: 'approved' };
        });
        for (let i = 0; i < 2; i++)
          expect(
            (
              await checkWithOverride(p, { ...request, toolUseId: 'ask-' + i }, { askHandler: handler }, )
            ).kind,
          ).toBe('allow');
        expect(handler).toHaveBeenCalledTimes(2);
        expect(p.getRules().allow).toEqual({ userSettings: ['Bash'] });
      },
    );
    it('refuses managed ask in DontAsk without a prompt', async () => {
      const handler = vi.fn<CheckHandler>(async () => ({ kind: 'approved' }));
      const result = await checkWithOverride(manager(source(ask), 'dontAsk'), request, {
        askHandler: handler,
      });
      expect(result.kind).toBe('deny');
      expect(handler).not.toHaveBeenCalled();
    });
    it('lets a local content deny outrank managed ask', async () => {
      const p = manager(source(ask), 'yolo');
      p.setRules({
        allow: {},
        deny: { userSettings: ['Bash(echo:*)'] },
        ask: {},
      });
      const handler = vi.fn<CheckHandler>(async () => ({ kind: 'approved' }));
      expect(
        (await checkWithOverride(p, request, { askHandler: handler })).kind,
      ).toBe('deny');
      expect(handler).not.toHaveBeenCalled();
    });
    it.each(['allow', 'ask'] as const)(
      'retains managed ask over a PreToolUse hook %s',
      async (behavior) => {
        const handler = vi.fn<CheckHandler>(async () => ({ kind: 'rejected' }));
        await checkWithOverride(manager(source(ask), 'yolo'), request, {
          askHandler: handler,
          preToolUseHookVerdict: { behavior, message: 'hook verdict' },
        });
        expect(handler.mock.calls[0][0].toolCheckResult).toMatchObject({
          reason: { attribution: { type: 'managedRule' } },
        });
      },
    );
    it('keeps managed deny over a per-call replacement checker', async () => {
      const p = manager(source({ deny: ['Injected'], ask: [] }));
      const result = await checkWithOverride(
        p,
        { ...request, toolName: 'Injected' },
        {},
      );
      expect(result.kind).toBe('deny');
      expect(result.toolCheck).toMatchObject({
        extra: { denialReason: { attribution: { type: 'managedRule' } } },
      });
    });
    it('applies managed rules to unregistered tools', async () => {
      const s = source({ deny: ['Unknown'], ask: [] });
      const p = manager(s);
      const req = { ...request, toolName: 'Unknown' };
      expect((await p.check(req)).kind).toBe('deny');
      s.update({ deny: [], ask: ['Unknown'] });
      const handler = vi.fn<CheckHandler>(async () => ({ kind: 'approved' }));
      expect((await checkWithOverride(p, req, { askHandler: handler })).kind).toBe(
        'allow',
      );
      expect(handler).toHaveBeenCalledOnce();
      s.update(undefined);
      expect((await p.check(req)).kind).toBe('allow');
    });
    it.each(['default', 'auto', 'yolo', 'acceptEdits', 'dontAsk'] as const)(
      'applies %s to a managed ask for an unregistered tool', async (mode) => {
        const handler = vi.fn<CheckHandler>(async () => ({ kind: 'approved' }));
        const permission = manager(source({ deny: [], ask: ['Unknown'] }), mode, handler);
        const decision = await permission.check({ ...request, toolName: 'Unknown' });
        expect(decision.kind).toBe(mode === 'dontAsk' ? 'deny' : 'allow');
        expect(handler).toHaveBeenCalledTimes(mode === 'dontAsk' ? 0 : 1);
      },
    );
    it('keeps internal read probes from bypassing managed asks under Yolo', async () => {
      const p = manager(source({ deny: [], ask: ['Read'] }), 'yolo');
      const probe = await checkInternalRead(
        p,
        { ...request, toolName: 'Read', input: { file_path: '/repo/file.txt' } },
        {
        },
      );
      expect(probe.autoAllowed).toBe(false);
    });
    it('rechecks a new managed deny after manual approval', async () => {
      const s = source(ask);
      const p = manager(s);
      const handler: CheckHandler = async () => {
        s.update(deny);
        return { kind: 'approved' };
      };
      expect(
        (await checkWithOverride(p, request, { askHandler: handler })).kind,
      ).toBe('deny');
    });
    it.each(['Bash', 'mcp__test__write'])(
      'reports the latest deny when approval returns unchanged input for %s',
      async (toolName) => {
        const s = source({ deny: [], ask: [toolName] });
        const p = manager(s, 'yolo');
        const decision = await checkWithOverride(
          p,
          { ...request, toolName },
          {
            askHandler: async (ctx) => {
              s.update({ deny: [toolName], ask: [] });
              return { kind: 'approved', input: { ...ctx.input } };
            },
          },
        );
        expect(decision.kind).toBe('deny');
        expect(decision.settlement).toBe('approved');
        expect(decision.denialMessage).toBe(
          `Rule ${toolName} denies ${toolName}.`,
        );
        // Keep the initial ask in the decision's history contract.
        expect(decision.toolCheck.kind).toBe('ask');
        expect(decision.reason?.message).toBe(
          `Rule ${toolName} requires your approval for this use of ${toolName}.`,
        );
      },
    );
    it('does not treat a content rule as a tool-wide restriction', async () => {
      const p = manager(source({ deny: ['Bash(git push:*)'], ask: [] }), 'yolo');
      expect((await p.check(request)).kind).toBe('allow');
    });
    it('rechecks a new managed deny after approving an unregistered tool', async () => {
      const s = source({ deny: [], ask: ['Unknown'] });
      const handler: CheckHandler = async () => {
        s.update({ deny: ['Unknown'], ask: [] });
        return { kind: 'approved' };
      };
      expect(
        (
          await checkWithOverride(manager(s), { ...request, toolName: 'Unknown' }, {
            askHandler: handler,
          })
        ).kind,
      ).toBe('deny');
    });
    it('keeps the tool safety warning with a managed ask', async () => {
      const handler = vi.fn<CheckHandler>(async () => ({ kind: 'rejected' }));
      await checkWithOverride(manager(source(ask), 'yolo'), {
        ...request,
        input: { command: 'rm -rf /' },
      }, { askHandler: handler });
      const check = handler.mock.calls[0][0].toolCheckResult;
      expect(check).toMatchObject({
        kind: 'ask',
        reason: { attribution: { type: 'managedRule' } },
      });
      if (check.kind === 'ask') {
        expect(check.reason.message).toContain('rm');
        expect(check.reason.message).toContain('approval');
      }
    });
    it('preserves a safe prompt projection from an injected checker', async () => {
      const s = source({ deny: [], ask: ['Injected'] });
      const handler = vi.fn<CheckHandler>(async () => ({ kind: 'rejected' }));
      const permission = manager(s);
      registerTestChecker(permission, 'Injected', {
        check: () => ({
          kind: 'ask',
          reason: { message: 'question', attribution: { type: 'interaction', reason: 'question' } },
          extra: { promptInput: { safe: true } },
        }),
      });
      await checkWithOverride(permission, { ...request, toolName: 'Injected' }, {
          askHandler: handler,
        },
      );
      expect(handler.mock.calls[0][0].toolCheckResult).toMatchObject({
        extra: { promptInput: { safe: true } },
      });
    });
    it('applies new tool restrictions to existing, new and child permissions', async () => {
      const s = source(undefined);
      const first = manager(s, 'yolo');
      const second = manager(s, 'yolo');
      const child = constrainAgentPermissions(first, ['Write']);
      expect((await first.check(request)).kind).toBe('allow');
      s.update(deny);
      const added = manager(s, 'yolo');
      for (const p of [first, second, child, added])
        expect((await p.check(request)).kind).toBe('deny');
      s.update({ deny: [], ask: [] });
      for (const p of [first, second, child, added])
        expect((await p.check(request)).kind).toBe('allow');
    });
    it('keeps one manual approval when a managed tool requirement appears', async () => {
      const s = source(undefined);
      const p = manager(s);
      p.setRules({ allow: {}, deny: {}, ask: { session: ['Bash'] } });
      const handler = vi.fn<CheckHandler>(async () => {
        s.update(ask);
        return { kind: 'approved' };
      });
      expect(
        (await checkWithOverride(p, request, { askHandler: handler })).kind,
      ).toBe('allow');
      expect(handler).toHaveBeenCalledOnce();
    });
    it('does not start an approval loop when the handler updates managed asks', async () => {
      const shared = source(ask);
      const handler = vi.fn<CheckHandler>(async () => {
        shared.update({
          deny: [],
          ask: handler.mock.calls.length % 2 ? ['Bash(*)'] : ['Bash'],
        });
        return { kind: 'approved' };
      });
      const result = await manager(shared, 'yolo', handler).check(request);
      expect(handler).toHaveBeenCalledOnce();
      expect(result.kind).toBe('allow');
      expect(result.decidedBy).toBe('ask');
      expect(result.history).toHaveLength(1);
    });
    it('keeps MCP wildcard tool rules in the shared tool-level path', async () => {
      const p = manager(source({ deny: ['mcp__github__*'], ask: [] }), 'yolo');
      expect(
        (
          await p.check({
            ...request,
            toolName: 'mcp__github__create_issue',
          })
        ).kind,
      ).toBe('deny');
    });
  });

  describe('managed confirmation uses the existing channel', () => {
    function bridge(
      permission: ReturnType<typeof manager>,
    ): PermissionRequestHookBridge {
      return {
        permission,
        askMetrics: createAskMetricsStore(),
        getVerdict: vi.fn(async () => ({ behavior: 'allow' as const })),
      };
    }
    it('offers only a single, manual approval and does not consult the handler hook', async () => {
      const p = manager(source(ask), 'yolo');
      const hook = bridge(p);
      const present = vi.fn((prompt, settle) => {
        expect(prompt).toMatchObject({ skippable: false, persistable: false });
        expect(prompt.suggestions).toBeUndefined();
        settle({ kind: 'approved' });
        return () => {};
      });
      const channel = createAskHandler({ present });
      const handler = withPermissionRequestHookHandler(channel, hook);
      const configured = manager(source(ask), 'yolo', handler);
      expect((await configured.check(request)).kind).toBe('allow');
      expect(present).toHaveBeenCalledOnce();
      expect(hook.getVerdict).not.toHaveBeenCalled();
    });
    it('does not let a hook approve when no manual channel is attached', async () => {
      const p = manager(source(ask), 'yolo');
      const hook = bridge(p);
      const configured = manager(
        source(ask),
        'yolo',
        withPermissionRequestHookHandler(undefined, hook),
      );
      expect((await configured.check(request)).kind).toBe('deny');
      expect(hook.getVerdict).not.toHaveBeenCalled();
    });
    it('does not start a presenter hook race for managed confirmation', async () => {
      const p = manager(source(ask), 'yolo');
      const hook = bridge(p);
      const present = vi.fn((_prompt, settle) => {
        settle({ kind: 'rejected' });
        return () => {};
      });
      const configured = manager(
        source(ask),
        'yolo',
        createAskHandler(withPermissionRequestHook({ present }, hook)),
      );
      expect((await configured.check(request)).kind).toBe('deny');
      expect(present).toHaveBeenCalledOnce();
      expect(hook.getVerdict).not.toHaveBeenCalled();
    });
  });
});

describe('read channels', () => {
  vi.mock('../../utils/ripgrep.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../utils/ripgrep.js')>()),
    ripGrep: vi.fn(),
  }));

  type Rules = PermissionPolicySnapshot['rules'];
  type Handler = AskHandler<ToolPermissionReason>;
  let cwd: string;
  beforeEach(() => {
    cwd = realpathSync(mkdtempSync(join(tmpdir(), 'managed-read-')));
    mkdirSync(join(cwd, 'private'));
    writeFileSync(join(cwd, 'private', 'secret.txt'), 'SECRET');
    writeFileSync(join(cwd, 'private', 'other.txt'), 'OTHER_SECRET');
    writeFileSync(join(cwd, 'public.txt'), 'PUBLIC');
    vi.mocked(ripGrep).mockReset();
    vi.mocked(ripGrep).mockResolvedValue([
      'private/secret.txt\0private/other.txt\0public.txt\0',
    ]);
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));
  function setup(
    initial: Rules,
    handler?: Handler,
    mode: PermissionMode = 'yolo',
  ) {
    let rules = initial;
    const source: ConfigService = {
      start: async () => {},
      stop: async () => {},
      getValue: <T>() => ({ disabledModes: [], rules }) as T,
      onValueChange: () => () => {},
      onError: () => () => {},
    };
    const permission = createPermissionManager({
      cwd,
      organizationPolicy: source,
      permissionMode: mode,
      askHandler: handler,
      checkerDeps: {
        skill: {
          isAllowedForMainSession: () => true,
          isDisabled: () => false,
          hasOnlySafeProperties: () => true,
        },
        mcpCall: { isKnownTool: () => false, parseQualifiedName: () => ({}) },
      },
    });
    const config = {
      permission,
      getTargetDir: () => cwd,
      getDebugMode: () => false,
    } as unknown as Config;
    const context: AttachmentToolUseContext = {
      cwd,
      permission,
      fileReadState: createToolFileStateCache(),
      readFileState: createFileStateCacheWithSizeLimit(10),
      loadedNestedMemoryPaths: new Set(),
      sentSkillNames: new Map(),
      pendingHookOutputs: [],
      pendingHookAttachments: [],
      postCompactCandidates: null,
      announcedMcpInstructionServers: new Set(),
      announcedLazyMcpTools: new Set(),
      announcedAgentTypes: new Set(),
      seenSessionStartHookOutputs: new Set(),
    };
    return {
      permission,
      config,
      context,
      update(next: Rules) {
        rules = next;
      },
      paths() {
        return pathPermissionContextOf(context)!;
      },
    };
  }
  const denyPrivate = { deny: ['Read(/private/**)'], ask: [] };
  const askPrivate = { deny: [], ask: ['Read(/private/**)'] };
  const signal = () => new AbortController().signal;
  const rgMatch = (file: string, text: string) =>
    JSON.stringify({
      type: 'match',
      data: {
        path: { text: file },
        lines: { text: text + '\n' },
        line_number: 1,
      },
    });

  describe('managed read channels', () => {
    it('filters managed rootless directory rules from search results', () => {
      mkdirSync(join(cwd, 'policy-private'));
      writeFileSync(join(cwd, 'policy-private', 'secret.txt'), 'test');
      const s = setup({ deny: ['Read(**/policy-private/**)'], ask: [] });
      const isDenied = createReadDenyResultFilter(s.paths(), cwd)!;
      expect(isDenied(join(cwd, 'policy-private', 'secret.txt'))).toBe(true);
      expect(isDenied(join(cwd, 'public.txt'))).toBe(false);
    });
    it('keeps pinned local attachment rules but reads current managed rules', () => {
      const s = setup(undefined);
      const local = {
        allow: {},
        deny: { userSettings: [`Read(/${join(cwd, 'public.txt')})`] },
        ask: {},
      };
      s.context.permissionPaths = { rules: local, additionalDirectories: [] };
      s.update(denyPrivate);
      expect(s.paths().rules).toBe(local);
      expect(
        isFileReadDenied(join(cwd, 'private', 'secret.txt'), s.paths(), cwd),
      ).toBe(true);
      s.update({ deny: [], ask: [] });
      expect(
        isFileReadDenied(join(cwd, 'private', 'secret.txt'), s.paths(), cwd),
      ).toBe(false);
      expect(isFileReadDenied(join(cwd, 'public.txt'), s.paths(), cwd)).toBe(
        true,
      );
    });
    it.each([denyPrivate, askPrivate])(
      'skips protected file attachments without asking (%j)',
      async (rules) => {
        const handler = vi.fn<Handler>(async () => ({ kind: 'approved' }));
        const s = setup(rules, handler);
        expect(
          await generateFileAttachment(
            join(cwd, 'private', 'secret.txt'),
            'at-mention',
            s.context,
          ),
        ).toBeNull();
        expect(
          await processAtMentionedFiles('@private/secret.txt', s.context),
        ).toEqual([]);
        expect(
          await generateFileAttachment(
            join(cwd, 'public.txt'),
            'at-mention',
            s.context,
          ),
        ).not.toBeNull();
        expect(handler).not.toHaveBeenCalled();
      },
    );
    it('does not reread a changed file after a managed constraint arrives', async () => {
      const s = setup(undefined);
      const file = join(cwd, 'private', 'secret.txt');
      expect(
        await generateFileAttachment(file, 'at-mention', s.context),
      ).not.toBeNull();
      s.update(denyPrivate);
      writeFileSync(file, 'CHANGED_SECRET');
      const changedAt = new Date(Date.now() + 2000);
      utimesSync(file, changedAt, changedAt);
      expect(await getChangedFiles(s.context)).toEqual([]);
    });
    it('does not inject protected JIT memory', async () => {
      const s = setup(askPrivate);
      const ext = {
        memoryContextManager: {
          getLoadedPaths: () => [join(cwd, 'private', 'secret.txt')],
        },
      } as unknown as Parameters<typeof getRelevantMemoriesAttachments>[1];
      expect(await getRelevantMemoriesAttachments(s.context, ext)).toEqual([]);
    });
    it('filters real symlink targets and keeps ask rules out of deny filtering', () => {
      const s = setup(denyPrivate);
      symlinkSync(join(cwd, 'private', 'secret.txt'), join(cwd, 'alias.txt'));
      const filter = createReadDenyResultFilter(s.paths(), cwd)!;
      expect(filter(join(cwd, 'alias.txt'))).toBe(true);
      expect(filter(join(cwd, 'public.txt'))).toBe(false);
      s.update(askPrivate);
      expect(createReadDenyResultFilter(s.paths(), cwd)).toBeUndefined();
    });
    it.each(['Read', 'Read(/**)'])('honors a whole-read deny (%s)', (rule) => {
      const s = setup({ deny: [rule], ask: [] });
      expect(
        createReadDenyResultFilter(s.paths(), cwd)!(join(cwd, 'public.txt')),
      ).toBe(true);
    });
    it('does not change ordinary local ask attachment behavior', async () => {
      const s = setup(undefined);
      s.permission.setRules({
        allow: {},
        deny: {},
        ask: { userSettings: ['Read(/public.txt)'] },
      });
      expect(
        await generateFileAttachment(
          join(cwd, 'public.txt'),
          'at-mention',
          s.context,
        ),
      ).not.toBeNull();
    });
    it.each(['default', 'auto', 'yolo', 'acceptEdits'] as const)(
      'confirms all protected search paths once per call under %s',
      async (mode) => {
        const handler = vi.fn<Handler>(async (ctx) => {
          expect(ctx.toolCheckResult).toMatchObject({
            kind: 'ask',
            reason: { attribution: { type: 'managedRule' } },
          });
          return { kind: 'approved' };
        });
        const s = setup(askPrivate, handler, mode);
        const paths = ['secret.txt', 'other.txt'].map((name) =>
          join(cwd, 'private', name),
        );
        for (let i = 0; i < 2; i++)
          expect(
            await confirmManagedSearchRead(
              paths,
              'Grep',
              { path: cwd, pattern: '.' },
              { signal: signal(), callId: `search-${i}` },
              s.config,
            ),
          ).toBeUndefined();
        expect(handler).toHaveBeenCalledTimes(2);
      },
    );
    it('does not ask under DontAsk', async () => {
      const handler = vi.fn<Handler>(async () => ({ kind: 'approved' }));
      const s = setup(askPrivate, handler, 'dontAsk');
      expect(
        (
          await confirmManagedSearchRead(
            [join(cwd, 'private', 'secret.txt')],
            'Grep',
            { path: cwd, pattern: '.' },
            { signal: signal() },
            s.config,
          )
        )?.error?.type,
      ).toBe('permission_denied');
      expect(handler).not.toHaveBeenCalled();
    });
    it('does not prompt for search results when the child context cannot prompt', async () => {
      const handler = vi.fn<Handler>(async () => ({ kind: 'approved' }));
      const s = setup(askPrivate, handler, 'yolo');
      const result = await confirmManagedSearchRead(
        [join(cwd, 'private', 'secret.txt')],
        'Grep',
        { path: cwd, pattern: '.' },
        { signal: signal(), agentLoopContext: { permission: s.permission, permissionContext: () => ({ canPrompt: false }) } as NonNullable<ToolUseContext['agentLoopContext']> },
        s.config,
      );
      expect(result?.error?.type).toBe('permission_denied');
      expect(handler).not.toHaveBeenCalled();
    });

    it('keeps additional local denies when search has replacement rules', async () => {
      const handler = vi.fn<Handler>(async () => ({ kind: 'approved' }));
      const s = setup(askPrivate, handler, 'yolo');
      const result = await confirmManagedSearchRead(
        [join(cwd, 'private', 'secret.txt')], 'Grep', { path: cwd, pattern: '.' },
        { signal: signal(), agentLoopContext: {
          permission: s.permission,
          permissionContext: () => ({
            rules: { allow: { command: ['Grep', 'Read'] }, deny: {}, ask: {} },
            additionalRules: { allow: {}, deny: { command: ['Read(/private/**)'] }, ask: {} },
          }),
        } as NonNullable<ToolUseContext['agentLoopContext']> }, s.config,
      );
      expect(result?.error?.type).toBe('permission_denied');
      expect(handler).not.toHaveBeenCalled();
    });

    it('refuses search results if a deny arrives during approval', async () => {
      const s = setup(askPrivate, async () => {
        s.update(denyPrivate);
        return { kind: 'approved' };
      });
      expect(
        (
          await confirmManagedSearchRead(
            [join(cwd, 'private', 'secret.txt')],
            'Grep',
            { path: cwd, pattern: '.' },
            { signal: signal() },
            s.config,
          )
        )?.error,
      ).toBeDefined();
    });
    it('releases search results after constraints are cleared', async () => {
      const handler = vi.fn<Handler>(async () => ({ kind: 'approved' }));
      const s = setup(askPrivate, handler);
      s.update({ deny: [], ask: [] });
      expect(
        await confirmManagedSearchRead(
          [join(cwd, 'private', 'secret.txt')],
          'Glob',
          { path: cwd, pattern: '**/*' },
          { signal: signal() },
          s.config,
        ),
      ).toBeUndefined();
      expect(handler).not.toHaveBeenCalled();
    });
    it('filters protected files in the actual Glob collector', async () => {
      const s = setup(denyPrivate);
      const result = await new GlobTool(s.config)
        .build({ path: cwd, pattern: '**/*.txt' })
        .execute(signal());
      expect(result.error).toBeUndefined();
      expect(result.llmContent).toContain('public.txt');
      expect(result.llmContent).not.toContain('secret.txt');
    });
    it('asks before the actual Glob result exposes protected paths', async () => {
      const handler = vi.fn<Handler>(async () => ({ kind: 'rejected' }));
      const s = setup(askPrivate, handler);
      const result = await new GlobTool(s.config)
        .build({ path: cwd, pattern: '**/*.txt' })
        .execute(signal());
      expect(result.error).toBeDefined();
      expect(handler).toHaveBeenCalledOnce();
      expect(result.llmContent).not.toContain('OTHER_SECRET');
    });
    it.each(['files_with_matches', 'content', 'count'] as const)(
      'filters real Grep %s output before exposing content',
      async (output_mode) => {
        const s = setup(denyPrivate);
        const privatePath = join(cwd, 'private', 'secret.txt');
        const publicPath = join(cwd, 'public.txt');
        vi.mocked(ripGrep).mockResolvedValue(
          output_mode === 'content'
            ? [rgMatch(privatePath, 'SECRET'), rgMatch(publicPath, 'PUBLIC')]
            : output_mode === 'count'
              ? [`${privatePath}${'\0'}1`, `${publicPath}${'\0'}1`]
              : [`${privatePath}\0${publicPath}\0`],
        );
        const result = await new RipGrepTool(s.config)
          .build({ path: cwd, pattern: '.', output_mode })
          .execute(signal());
        expect(result.error).toBeUndefined();
        expect(result.llmContent).toContain(
          output_mode === 'content' ? 'PUBLIC' : 'public.txt',
        );
        expect(result.llmContent).not.toContain('SECRET');
        expect(result.llmContent).not.toContain('secret.txt');
      },
    );
    it.each(['files_with_matches', 'content', 'count'] as const)(
      'requires approval for real Grep %s output',
      async (output_mode) => {
        const handler = vi.fn<Handler>(async () => ({ kind: 'rejected' }));
        const s = setup(askPrivate, handler);
        const file = join(cwd, 'private', 'secret.txt');
        vi.mocked(ripGrep).mockResolvedValue([file + '\0']);
        const result = await new RipGrepTool(s.config)
          .build({ path: cwd, pattern: '.', output_mode })
          .execute(signal());
        expect(result.error).toBeDefined();
        expect(result.llmContent).not.toContain('SECRET');
        expect(handler).toHaveBeenCalledOnce();
        expect(vi.mocked(ripGrep)).toHaveBeenCalledOnce();
        expect(vi.mocked(ripGrep).mock.calls[0][0]).toContain('--files');
      },
    );
    it('waits for approval before executing a Grep content query', async () => {
      let approved = false;
      const handler = vi.fn<Handler>(async () => {
        approved = true;
        return { kind: 'approved' };
      });
      const s = setup(askPrivate, handler);
      const file = join(cwd, 'private', 'secret.txt');
      vi.mocked(ripGrep).mockImplementation(async (args) => {
        if (args.includes('--files')) {
          expect(approved).toBe(false);
          return [file + '\0'];
        }
        expect(approved).toBe(true);
        return [rgMatch(file, 'SECRET')];
      });
      const result = await new RipGrepTool(s.config)
        .build({ path: cwd, pattern: '.', output_mode: 'content' })
        .execute(signal());
      expect(result.error).toBeUndefined();
      expect(result.llmContent).toContain('SECRET');
      expect(handler).toHaveBeenCalledOnce();
      expect(vi.mocked(ripGrep)).toHaveBeenCalledTimes(2);
    });
    it('does not read content when preflight file listing is incomplete', async () => {
      const handler = vi.fn<Handler>(async () => ({ kind: 'approved' }));
      const s = setup(askPrivate, handler);
      vi.mocked(ripGrep).mockImplementation(
        async (_args, _target, _signal, options) => {
          options?.onPartialResults?.();
          return [join(cwd, 'public.txt') + '\0'];
        },
      );
      const result = await new RipGrepTool(s.config)
        .build({ path: cwd, pattern: '.' })
        .execute(signal());
      expect(result.error?.type).toBe('permission_denied');
      expect(vi.mocked(ripGrep)).toHaveBeenCalledOnce();
      expect(handler).not.toHaveBeenCalled();
    });
    it('does not enumerate files for unrelated managed asks', async () => {
      const s = setup({ deny: [], ask: ['Agent(Explore)'] });
      vi.mocked(ripGrep).mockResolvedValue([join(cwd, 'public.txt') + '\0']);
      const result = await new RipGrepTool(s.config)
        .build({ path: cwd, pattern: '.' })
        .execute(signal());
      expect(result.error).toBeUndefined();
      expect(vi.mocked(ripGrep)).toHaveBeenCalledOnce();
      expect(vi.mocked(ripGrep).mock.calls[0][0]).not.toContain('--files');
    });
    it('keeps denied files filtered while confirming the remaining search paths', async () => {
      const handler = vi.fn<Handler>(async () => ({ kind: 'approved' }));
      const s = setup(
        { deny: ['Read(/private/**)'], ask: ['Read(/public.txt)'] },
        handler,
      );
      const visible = join(cwd, 'public.txt');
      const hidden = join(cwd, 'private', 'secret.txt');
      vi.mocked(ripGrep).mockImplementation(async (args) =>
        args.includes('--files')
          ? [hidden + '\0' + visible + '\0']
          : [rgMatch(hidden, 'SECRET'), rgMatch(visible, 'PUBLIC')],
      );
      const result = await new RipGrepTool(s.config)
        .build({ path: cwd, pattern: '.', output_mode: 'content' })
        .execute(signal());
      expect(result.error).toBeUndefined();
      expect(result.llmContent).toContain('PUBLIC');
      expect(result.llmContent).not.toContain('SECRET');
      expect(handler).toHaveBeenCalledOnce();
    });
    it('uses the same type, glob and exclusion filters in Grep preflight', async () => {
      const s = setup(askPrivate, async () => ({ kind: 'approved' }));
      vi.mocked(ripGrep).mockResolvedValue([]);
      await new RipGrepTool(s.config)
        .build({ path: cwd, pattern: '.', type: 'ts', glob: '**/*.ts' })
        .execute(signal());
      const [preflight, query] = vi
        .mocked(ripGrep)
        .mock.calls.map((call) => call[0]);
      for (const args of [preflight, query]) {
        expect(args).toEqual(
          expect.arrayContaining(['--type', 'ts', '--glob', '**/*.ts', '!.git']),
        );
      }
    });
    it('does not execute a Grep query if approval mutates the input in place', async () => {
      const s = setup(askPrivate, async (ctx) => {
        ctx.input['pattern'] = 'changed';
        return { kind: 'approved' };
      });
      vi.mocked(ripGrep).mockResolvedValue([
        join(cwd, 'private', 'secret.txt') + '\0',
      ]);
      const result = await new RipGrepTool(s.config)
        .build({ path: cwd, pattern: 'original' })
        .execute(signal());
      expect(result.error?.type).toBe('permission_denied');
      expect(vi.mocked(ripGrep)).toHaveBeenCalledOnce();
      expect(vi.mocked(ripGrep).mock.calls[0][0]).toContain('--files');
    });
    it('keeps unrestricted JIT memory injection working', async () => {
      const s = setup(undefined);
      const ext = {
        memoryContextManager: {
          getLoadedPaths: () => [join(cwd, 'private', 'secret.txt')],
        },
      } as unknown as Parameters<typeof getRelevantMemoriesAttachments>[1];
      const result = await getRelevantMemoriesAttachments(s.context, ext);
      expect(result).toHaveLength(1);
      expect(JSON.stringify(result)).toContain('SECRET');
    });
    it.each([denyPrivate, askPrivate])('blocks the existing no-prompt Read route (%j)', async rules => {
      const handler = vi.fn<Handler>(async () => ({kind: 'approved'}));
      const s = setup(rules, handler);
      expect(await canReadFileWithoutPrompt(s.config, join(cwd, 'private', 'secret.txt'))).toBe(false);
      expect(await canReadFileWithoutPrompt(s.config, join(cwd, 'public.txt'))).toBe(true);
      expect(handler).not.toHaveBeenCalled();
    });

  });
});
