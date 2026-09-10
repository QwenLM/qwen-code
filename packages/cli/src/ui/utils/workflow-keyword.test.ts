/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import type { Config } from '@qwen-code/qwen-code-core';
import {
  buildSkillLlmContent,
  readWorkflowAuthoringReference,
  ToolNames,
  WORKFLOW_AUTHORING_SKILL_NAME,
} from '@qwen-code/qwen-code-core';
import {
  buildWorkflowKeywordPrefix,
  buildWorkflowSteeringNotice,
  detectWorkflowKeyword,
} from './workflow-keyword.js';

/** Stands in for `SkillTool`'s loaded-skill bookkeeping. */
function fakeSkillTool() {
  const names = new Set<string>();
  return {
    getLoadedSkillNames: () => names as ReadonlySet<string>,
    markSkillLoaded: (name: string) => names.add(name),
    loaded: names,
  };
}

function stubConfig(
  options: {
    skillTool?: ReturnType<typeof fakeSkillTool>;
    withSkillTool?: boolean;
  } = {},
): Config {
  const { skillTool = fakeSkillTool(), withSkillTool = true } = options;
  return {
    getSkillManager: () => ({ getCachedSkills: () => null }),
    getToolRegistry: () => ({
      getAllToolNames: () =>
        withSkillTool
          ? [ToolNames.SKILL, ToolNames.WORKFLOW]
          : [ToolNames.WORKFLOW],
      getTool: (name: string) =>
        name === ToolNames.SKILL && withSkillTool ? skillTool : undefined,
    }),
    isSkillEnabled: () => true,
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

  // The closing sentence exists to stop the model spending a Skill call on
  // text that is already in the same message — or, when nothing was
  // injected, to keep it from being told to read something that is not
  // there.
  it('tells the model the reference is included when it was injected', () => {
    const notice = buildWorkflowSteeringNotice('loaded');
    expect(notice).toContain(WORKFLOW_AUTHORING_SKILL_NAME);
    expect(notice).toContain('do not load it again');
  });

  it('tells the model the reference is already in the conversation', () => {
    const notice = buildWorkflowSteeringNotice('already-loaded');
    expect(notice).toContain('already in this conversation');
  });

  it('says nothing about the reference when none was injected', () => {
    const notice = buildWorkflowSteeringNotice('unavailable');
    expect(notice).not.toContain(WORKFLOW_AUTHORING_SKILL_NAME);
    expect(notice).toMatch(/proceed normally/i);
  });
});

describe('buildWorkflowKeywordPrefix', () => {
  it('returns nothing when the keyword is absent', () => {
    expect(buildWorkflowKeywordPrefix(stubConfig(), 'just a request')).toBe(
      null,
    );
  });

  // The turn the keyword steers is the one turn known in advance to be about
  // orchestration, so the reference rides along instead of costing a round
  // trip — in exactly the form the Skill tool would have produced.
  it('carries the authoring reference on the first triggered turn', () => {
    const skillTool = fakeSkillTool();
    const reference = readWorkflowAuthoringReference()!;

    const triggered = buildWorkflowKeywordPrefix(
      stubConfig({ skillTool }),
      'build me a workflow for this',
    );

    expect(triggered?.autoloaded).toBe(true);
    expect(triggered?.prefix).toContain('<system-reminder>');
    expect(triggered?.prefix).toContain('Workflow tool');
    expect(triggered?.prefix).toContain(
      buildSkillLlmContent(reference.baseDir, reference.body),
    );
    // Registered, so a later Skill call dedups instead of repeating it.
    expect(skillTool.loaded.has(WORKFLOW_AUTHORING_SKILL_NAME)).toBe(true);
  });

  it('sends the reference once per session', () => {
    const config = stubConfig();
    const first = buildWorkflowKeywordPrefix(config, 'a workflow please');
    const second = buildWorkflowKeywordPrefix(config, 'another workflow');

    expect(first?.autoloaded).toBe(true);
    expect(second?.autoloaded).toBe(false);
    expect(second?.prefix).toContain('already in this conversation');
    expect(second?.prefix).not.toContain('Base directory for this skill:');
  });

  // Without a Skill tool the reference is inlined in the tool description
  // instead, so the reminder still fires — it just has nothing to add.
  it('still steers the turn when the reference cannot be injected', () => {
    const triggered = buildWorkflowKeywordPrefix(
      stubConfig({ withSkillTool: false }),
      'run a workflow',
    );

    expect(triggered?.autoloaded).toBe(false);
    expect(triggered?.prefix).toContain('Workflow tool');
    expect(triggered?.prefix).not.toContain('Base directory for this skill:');
  });
});
