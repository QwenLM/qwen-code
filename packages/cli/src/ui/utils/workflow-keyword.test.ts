/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import type {
  Config,
  WorkflowAuthoringSurface,
} from '@qwen-code/qwen-code-core';
import {
  ToolNames,
  WORKFLOW_AUTHORING_SKILL_NAME,
} from '@qwen-code/qwen-code-core';
import {
  buildWorkflowKeywordPrefix,
  buildWorkflowSteeringNotice,
  detectWorkflowKeyword,
} from './workflow-keyword.js';

interface StubOptions {
  toolNames?: string[];
  /** What the Workflow tool instance recorded when it was built. */
  recordedSurface?: WorkflowAuthoringSurface;
  /** What a live re-derivation would say now. */
  skillEnabledNow?: boolean;
}

function stubConfig(options: StubOptions = {}): Config {
  const {
    toolNames = [ToolNames.SKILL, ToolNames.WORKFLOW],
    recordedSurface,
    skillEnabledNow = true,
  } = options;
  return {
    getSkillManager: () => ({}),
    getDisabledSkillLevels: () => new Set(),
    isSkillEnabled: () => skillEnabledNow,
    getToolRegistry: () => ({
      getAllToolNames: () => toolNames,
      isPermissionDeferred: () => false,
      getTool: (name: string) =>
        name === ToolNames.WORKFLOW && recordedSurface
          ? { authoringSurface: recordedSurface }
          : undefined,
    }),
  } as unknown as Config;
}

describe('detectWorkflowKeyword', () => {
  it.each([
    ['build me a workflow for this', true],
    ['Workflow this please', true],
    ['can you run a workflow?', true],
    ['WORKFLOW', true],
    ['the workflow.', true],
  ])('matches the standalone word: %s', (text, expected) => {
    expect(detectWorkflowKeyword(text)).toBe(expected);
  });

  it.each([
    ['fix the workflows list', false], // plural — not the bare word
    ['this is a dataflow problem', false], // substring, not a word
    ['my-workflow-runner crashed', false], // hyphen-joined
    ['just a normal request', false],
    ['', false],
  ])('does not over-match: %s', (text, expected) => {
    expect(detectWorkflowKeyword(text)).toBe(expected);
  });
});

describe('buildWorkflowSteeringNotice', () => {
  it('names the Workflow tool and stays a soft nudge', () => {
    const notice = buildWorkflowSteeringNotice();
    expect(notice).toContain('Workflow tool');
    expect(notice).toContain('workflow');
    // Soft, not forced — the model keeps discretion.
    expect(notice).toMatch(/proceed normally/i);
  });

  // The description only points at the skill, so the turn that is about to
  // write a script is told where the contract is.
  it('tells the model to load the skill when the description points at it', () => {
    const notice = buildWorkflowSteeringNotice('pointer');
    expect(notice).toContain(`load the \`${WORKFLOW_AUTHORING_SKILL_NAME}\``);
    expect(notice).toContain('unless it is already in this conversation');
  });

  it('names the ToolSearch detour when the Skill tool is deferred', () => {
    expect(buildWorkflowSteeringNotice('pointer-via-tool-search')).toContain(
      'reveal the Skill tool with ToolSearch first',
    );
  });

  // Inlined: nothing to load. Withheld: the user asked for it not to come back.
  it.each([['inline'], ['withheld']] as const)(
    'says nothing about the skill when the description is %s',
    (surface) => {
      const notice = buildWorkflowSteeringNotice(surface);
      expect(notice).not.toContain(WORKFLOW_AUTHORING_SKILL_NAME);
      expect(notice).toMatch(/proceed normally/i);
    },
  );
});

describe('buildWorkflowKeywordPrefix', () => {
  it('returns nothing when the keyword is absent', () => {
    expect(buildWorkflowKeywordPrefix(stubConfig(), 'just a request')).toBe(
      null,
    );
  });

  // A shell-mode submission goes to bash, where a leading `<system-reminder>`
  // is a syntax error, and is recorded as the command the user ran.
  it('returns nothing for a shell-mode submission', () => {
    expect(
      buildWorkflowKeywordPrefix(stubConfig(), 'gh workflow list', {
        shellMode: true,
      }),
    ).toBe(null);
  });

  // Steering toward a tool that is not in the request helps nobody.
  it('returns nothing when the Workflow tool is not in this session', () => {
    expect(
      buildWorkflowKeywordPrefix(
        stubConfig({ toolNames: [ToolNames.SKILL] }),
        'build me a workflow',
      ),
    ).toBe(null);
  });

  // The prefix is part of the user's own message: it is rendered in the
  // transcript and restored into the input buffer on a queue-cancel. It names
  // the reference and must never carry its body.
  it('names the reference without carrying it', () => {
    const prefix = buildWorkflowKeywordPrefix(
      stubConfig({ recordedSurface: 'pointer' }),
      'build me a workflow for this',
    );

    expect(prefix).toContain('<system-reminder>');
    expect(prefix).toContain(`load the \`${WORKFLOW_AUTHORING_SKILL_NAME}\``);
    expect(prefix).not.toContain('Base directory for this skill:');
    expect(prefix).not.toContain('# Workflow authoring reference');
    expect(prefix!.length).toBeLessThan(1_000);
  });

  // The Workflow tool recorded its description shape when it was built. A
  // `/skills` toggle since then changes what a live re-derivation would say,
  // but not the description the model holds — so the reminder follows the
  // record.
  it('follows the shape the Workflow tool recorded, not a re-derivation', () => {
    const prefix = buildWorkflowKeywordPrefix(
      stubConfig({ recordedSurface: 'inline', skillEnabledNow: true }),
      'run a workflow',
    );

    expect(prefix).not.toContain(WORKFLOW_AUTHORING_SKILL_NAME);
  });

  it('derives the shape when the Workflow tool is not instantiated yet', () => {
    const prefix = buildWorkflowKeywordPrefix(stubConfig(), 'run a workflow');
    expect(prefix).toContain(`load the \`${WORKFLOW_AUTHORING_SKILL_NAME}\``);
  });
});
