/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Three-stage short-circuit matrix: every registered tool's checker,
 * composed exactly as the registry composes it (withToolLevelRules around the
 * raw checker), against deny / ask / allow / no rules.
 *
 *   stage 1  deny rule  -> terminal deny, the self-check never runs
 *   stage 2  ask rule   -> prompts even when the self-check allows; only a
 *                          content-level deny from the self-check beats it
 *   stage 3  allow rule -> voucher only; fills a gap-shaped ask, never erases
 *                          a finding
 */

import { describe, expect, it, vi } from 'vitest';
import {
  PermissionModes,
  rulesForToolName,
  type PermissionRules,
  type ToolCheckContext,
} from '../../permissions/manager/decision/index.js';
import {
  withToolLevelRules,
  type HostToolChecker,
} from './rule-precedence.js';
import type { ToolPermissionReason } from './checker-reasons.js';
import { readToolChecker } from './checkers/read-checker.js';
import { globToolChecker } from './checkers/glob-checker.js';
import { grepToolChecker } from './checkers/grep-checker.js';
import { writeToolChecker } from './checkers/write-checker.js';
import { editToolChecker } from './checkers/edit-checker.js';
import { notebookEditToolChecker } from './checkers/notebook-edit-checker.js';
import { createShellToolChecker } from './checkers/bash-checker.js';
import { createAgentToolChecker } from './checkers/agent-checker.js';
import { createSkillToolChecker } from './checkers/skill-checker.js';
import { createWorkflowToolChecker } from './checkers/workflow-checker.js';
import { createMcpCallToolChecker } from './checkers/mcp-call-checker.js';
import {
  createMcpListToolChecker,
  createMcpGetToolChecker,
} from './checkers/mcp-discovery-checkers.js';
import { createWebFetchToolChecker } from './checkers/web-fetch-checker.js';
import { createWebSearchToolChecker } from './checkers/web-search-checker.js';
import { createImageSearchToolChecker } from './checkers/image-search-checker.js';
import { createImageGenToolChecker } from './checkers/image-gen-checker.js';
import { createSendMessageToolChecker } from './checkers/send-message-checker.js';
import {
  createEnterWorktreeToolChecker,
  createExitWorktreeToolChecker,
} from './checkers/worktree-checkers.js';
import {
  createCronCreateToolChecker,
  createCronDeleteToolChecker,
} from './checkers/cron-checkers.js';
import {
  createEnterPlanModeToolChecker,
  createExitPlanModeToolChecker,
} from './checkers/plan-mode-checkers.js';
import { createAskUserToolChecker } from './checkers/ask-user-checker.js';
import {
  createBashInputToolChecker,
  createBashOutputToolChecker,
  createBashResizeToolChecker,
} from './checkers/bash-pty-checkers.js';
import { createDefaultToolChecker } from './checkers/default-checker.js';

const CWD = '/repo';

function contextFor(
  toolName: string,
  rules: PermissionRules,
): ToolCheckContext<ToolPermissionReason> {
  return {
    mode: PermissionModes.Default,
    rules,
    cwd: CWD,
    additionalDirectories: [],
    rulesForTool: rulesForToolName(rules, toolName),
    toolName,
    toolUseId: 'tu-matrix',
  };
}

function rulesWith(behavior: 'allow' | 'deny' | 'ask', toolName: string): PermissionRules {
  return { allow: {}, deny: {}, ask: {}, [behavior]: { userSettings: [toolName] } };
}
const NO_RULES: PermissionRules = { allow: {}, deny: {}, ask: {} };

interface MatrixCase {
  tool: string;
  checker: HostToolChecker;
  input: Record<string, unknown>;
  /** What the self-check says with no rules; '? ' means allow-or-ask is fine. */
  baseline: 'allow' | 'ask';
  baselineFlex?: boolean;
}

const skillDeps = {
  isAllowedForMainSession: () => true,
  isDisabled: () => false,
  hasOnlySafeProperties: () => true,
};
const mcpCallDeps = {
  isKnownTool: () => true,
  parseQualifiedName: (name: string) => {
    const m = name.match(/^mcp__([^_]+)__(.+)$/);
    return m ? { serverName: m[1], toolName: m[2] } : {};
  },
};

const CASES: MatrixCase[] = [
  { tool: 'Read', checker: readToolChecker, input: { file_path: `${CWD}/a.txt` }, baseline: 'allow' },
  { tool: 'Grep', checker: grepToolChecker, input: { pattern: 'foo', path: CWD }, baseline: 'allow' },
  { tool: 'Glob', checker: globToolChecker, input: { pattern: '*.ts', path: CWD }, baseline: 'allow' },
  { tool: 'Write', checker: writeToolChecker, input: { file_path: `${CWD}/new.txt`, content: 'x' }, baseline: 'allow', baselineFlex: true },
  { tool: 'Edit', checker: editToolChecker, input: { file_path: `${CWD}/a.txt`, old_string: 'a', new_string: 'b' }, baseline: 'allow', baselineFlex: true },
  { tool: 'NotebookEdit', checker: notebookEditToolChecker, input: { notebook_path: `${CWD}/nb.ipynb`, new_source: 'x' }, baseline: 'allow', baselineFlex: true },
  { tool: 'Bash', checker: createShellToolChecker('Bash'), input: { command: 'echo hi' }, baseline: 'allow', baselineFlex: true },
  { tool: 'Monitor', checker: createShellToolChecker('Monitor'), input: { command: 'echo hi' }, baseline: 'allow', baselineFlex: true },
  { tool: 'Agent', checker: createAgentToolChecker('Agent'), input: { prompt: 'x' }, baseline: 'ask', baselineFlex: true },
  { tool: 'Skill', checker: createSkillToolChecker('Skill', skillDeps), input: { skill: 'review' }, baseline: 'allow', baselineFlex: true },
  { tool: 'Workflow', checker: createWorkflowToolChecker('Workflow'), input: { name: 'wf' }, baseline: 'ask', baselineFlex: true },
  { tool: 'McpCall', checker: createMcpCallToolChecker(mcpCallDeps), input: { toolName: 'mcp__srv__tool', arguments: {} }, baseline: 'ask', baselineFlex: true },
  { tool: 'McpList', checker: createMcpListToolChecker('McpList'), input: {}, baseline: 'allow' },
  { tool: 'McpGet', checker: createMcpGetToolChecker('McpGet'), input: { serverName: 'srv' }, baseline: 'allow', baselineFlex: true },
  { tool: 'WebFetch', checker: createWebFetchToolChecker('WebFetch', () => false), input: { url: 'https://example.com' }, baseline: 'ask' },
  { tool: 'WebSearch', checker: createWebSearchToolChecker('WebSearch'), input: { query: 'x' }, baseline: 'ask' },
  { tool: 'ImageSearch', checker: createImageSearchToolChecker('ImageSearch'), input: { query: 'x' }, baseline: 'ask' },
  // develop parity: ImageGen has no self-check — absent a rule it runs silently.
  { tool: 'ImageGen', checker: createImageGenToolChecker('ImageGen'), input: { prompt: 'x' }, baseline: 'allow' },
  { tool: 'SendMessage', checker: createSendMessageToolChecker('SendMessage'), input: { message: 'x' }, baseline: 'ask', baselineFlex: true },
  { tool: 'EnterWorktree', checker: createEnterWorktreeToolChecker('EnterWorktree'), input: {}, baseline: 'ask', baselineFlex: true },
  { tool: 'ExitWorktree', checker: createExitWorktreeToolChecker('ExitWorktree'), input: { action: 'keep' }, baseline: 'ask', baselineFlex: true },
  { tool: 'CronCreate', checker: createCronCreateToolChecker('CronCreate'), input: { cron: '*/5 * * * *', prompt: 'x' }, baseline: 'ask', baselineFlex: true },
  { tool: 'CronDelete', checker: createCronDeleteToolChecker('CronDelete'), input: { id: 'job-1' }, baseline: 'ask', baselineFlex: true },
  { tool: 'EnterPlanMode', checker: createEnterPlanModeToolChecker('EnterPlanMode'), input: {}, baseline: 'ask' },
  { tool: 'ExitPlanMode', checker: createExitPlanModeToolChecker('ExitPlanMode'), input: {}, baseline: 'ask' },
  {
    tool: 'AskUserQuestion',
    checker: createAskUserToolChecker('AskUserQuestion'),
    input: { questions: [{ question: 'q', header: 'h', options: [{ label: 'a', description: '' }], multiSelect: false }] },
    baseline: 'ask',
  },
  { tool: 'BashInput', checker: createBashInputToolChecker('BashInput'), input: { pid: 1, chars: 'x' }, baseline: 'ask' },
  { tool: 'BashOutput', checker: createBashOutputToolChecker('BashOutput'), input: { pid: 1 }, baseline: 'allow' },
  { tool: 'BashResize', checker: createBashResizeToolChecker('BashResize'), input: { pid: 1, cols: 80, rows: 24 }, baseline: 'allow' },
  { tool: 'TodoWrite', checker: createDefaultToolChecker('TodoWrite'), input: { todos: [] }, baseline: 'allow' },
];

describe('three-stage rule short-circuit across every tool checker', () => {
  for (const c of CASES) {
    describe(`${c.tool}`, () => {
      it('stage 1: a deny rule terminates before the self-check', async () => {
        const selfCheck = vi.fn(async () => ({ kind: 'allow' as const }));
        const wrapped = withToolLevelRules(c.tool, { check: selfCheck });
        const result = await wrapped.check(c.input, contextFor(c.tool, rulesWith('deny', c.tool)));
        expect(result.kind).toBe('deny');
        expect(selfCheck).not.toHaveBeenCalled();
      });

      it('stage 2: an ask rule prompts even when the self-check allows', async () => {
        const wrapped = withToolLevelRules(c.tool, c.checker);
        const result = await wrapped.check(c.input, contextFor(c.tool, rulesWith('ask', c.tool)));
        expect(result.kind).toBe('ask');
        if (result.kind === 'ask') {
          expect(result.reason.attribution).toMatchObject({ type: 'rule' });
        }
      });

      it('stage 3 baseline: with no rules the self-check verdict stands', async () => {
        const wrapped = withToolLevelRules(c.tool, c.checker);
        const result = await wrapped.check(c.input, contextFor(c.tool, NO_RULES));
        if (c.baselineFlex) {
          expect(['allow', 'ask']).toContain(result.kind);
        } else {
          expect(result.kind).toBe(c.baseline);
        }
      });
    });
  }

  it('stage 3: an allow rule fills a gap-shaped ask (BashInput)', async () => {
    const wrapped = withToolLevelRules('BashInput', createBashInputToolChecker('BashInput'));
    const result = await wrapped.check(
      { pid: 1, chars: 'x' },
      contextFor('BashInput', rulesWith('allow', 'BashInput')),
    );
    expect(result.kind).toBe('allow');
  });

  it('stage 3: a shell allow does not fill the write ask behind a redirect', async () => {
    // `allow Bash` covers the command, not the file write it performs.
    const wrapped = withToolLevelRules('Bash', createShellToolChecker('Bash'));
    const result = await wrapped.check(
      { command: 'echo hi > out.txt' },
      contextFor('Bash', rulesWith('allow', 'Bash')),
    );
    expect(result.kind).toBe('ask');
    if (result.kind === 'ask') {
      expect(result.reason).toMatchObject({
        decisionPoint: 'fs_write.default.ask',
      });
    }
  });

  it('stage 3: a shell hook allow does not fill the write ask behind a redirect', async () => {
    const wrapped = withToolLevelRules('Bash', createShellToolChecker('Bash'));
    const result = await wrapped.check(
      { command: 'echo hi > out.txt' },
      {
        ...contextFor('Bash', NO_RULES),
        mode: PermissionModes.Auto,
        preToolUseHookVerdict: { behavior: 'allow' },
      },
    );
    expect(result.kind).toBe('ask');
    if (result.kind === 'ask') {
      expect(result.reason).toMatchObject({
        decisionPoint: 'fs_write.default.ask',
      });
    }
  });

  it('stage 3: a tool-level allow fills the default write ask inside the workspace', async () => {
    // `--allowed-tools Write` must let a -p session write in the workspace:
    // the default ask says only that no rule vouched for this write.
    const wrapped = withToolLevelRules('Write', writeToolChecker);
    const result = await wrapped.check(
      { file_path: `${CWD}/new.txt`, content: 'x' },
      contextFor('Write', rulesWith('allow', 'Write')),
    );
    expect(result.kind).toBe('allow');
  });

  it('stage 3: an allow rule never erases a content finding (Write outside cwd)', async () => {
    const wrapped = withToolLevelRules('Write', writeToolChecker);
    const result = await wrapped.check(
      { file_path: '/etc/passwd', content: 'x' },
      contextFor('Write', rulesWith('allow', 'Write')),
    );
    expect(result.kind).not.toBe('allow');
  });

  it('stage 2 beats stage 3: an ask rule outranks a gap-filling allow (BashInput)', async () => {
    const wrapped = withToolLevelRules('BashInput', createBashInputToolChecker('BashInput'));
    const rules: PermissionRules = {
      allow: { userSettings: ['BashInput'] },
      deny: {},
      ask: { userSettings: ['BashInput'] },
    };
    const result = await wrapped.check({ pid: 1, chars: 'x' }, contextFor('BashInput', rules));
    expect(result.kind).toBe('ask');
  });

  it('stage 3 baseline: a network-shaped path asks from the content check', async () => {
    vi.stubGlobal(
      'process',
      Object.create(process, { platform: { get: () => 'win32' } }),
    );
    try {
      const wrapped = withToolLevelRules('Read', readToolChecker);
      // A network-shaped path is a content-level ask for the read family
      // (Windows-only enforcement). No rules involved, so the ask must carry
      // the content-check decision point.
      const result = await wrapped.check(
        { file_path: '//server/share/secret.txt' },
        contextFor('Read', NO_RULES),
      );
      expect(result.kind).toBe('ask');
      expect(
        result.kind === 'ask' ? result.reason?.decisionPoint : undefined,
      ).toBe('fs_read.network_path.ask');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
