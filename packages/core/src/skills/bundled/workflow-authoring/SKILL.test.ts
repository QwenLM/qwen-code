/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseSkillContent } from '../../skill-load.js';
import {
  DEFAULT_MAX_AGENTS_PER_RUN,
  DEFAULT_WORKFLOW_SUBAGENT_MAX_TIME_MINUTES,
  DEFAULT_WORKFLOW_SUBAGENT_MAX_TURNS,
  MAX_WORKFLOW_AGENTS_ENV,
  MAX_WORKFLOW_CONCURRENCY_ENV,
  WORKFLOW_SUBAGENT_MAX_MINUTES_ENV,
  WORKFLOW_SUBAGENT_MAX_TURNS_ENV,
} from '../../../agents/runtime/workflow-orchestrator.js';
import {
  DEFAULT_STALL_MS,
  MAX_STALL_ATTEMPTS,
  MAX_WORKFLOW_STALL_MS_ENV,
} from '../../../agents/runtime/workflow-stall.js';

function loadSkill() {
  const skillPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'SKILL.md',
  );
  return parseSkillContent(fs.readFileSync(skillPath, 'utf8'), skillPath);
}

/**
 * The body with runs of whitespace collapsed. The anchors below are
 * sentences, and a hard-wrapped markdown paragraph renders a line break as a
 * space — asserting on the raw text would make every anchor break the moment
 * someone re-flowed a paragraph, which is not the regression these guard.
 */
function skillProse(): string {
  return loadSkill().body.replace(/\s+/g, ' ');
}

describe('bundled workflow-authoring skill', () => {
  it('is the authoring reference, and says it does not authorize a run', () => {
    const skill = loadSkill();

    expect(skill.name).toBe('workflow-authoring');
    expect(skill.description).toContain('Load before authoring');
    // The reference is loadable on the model's own initiative, so it has to
    // repeat the boundary: reading how to write a script is not permission
    // to run one. The opt-in rule lives in the tool description.
    expect(skill.description).toContain('does not itself authorize');
    expect(skillProse()).toContain('does not authorize a run');
  });

  // These sentences used to be in the tool description, where they cost
  // tokens on every single turn. They have to survive the move intact —
  // `workflow.test.ts` asserts the description no longer carries them, so
  // without this test the guidance could vanish entirely and both files
  // would still be green.
  it.each([
    ['Parallelism on its own is not a reason'],
    ['only before the orchestration step'],
    ['Common single-phase shapes'],
    ['Default to `pipeline()`'],
    ['A barrier is right only when'],
    ['refute'],
    ['against everything already seen'],
    ['`log()` what was dropped'],
    ['workingDir'],
    ['no-progress stall watchdog'],
    ['Call-shape validation failures'],
    ['nests one level only'],
    ['read `budget.total`'],
    // Error strings a script has to compare against, moved here with the
    // options that produce them.
    ['subagent completed without calling StructuredOutput'],
    ['Unresolved names make the admitted agent() resolve to null'],
    ['Run-level rejections no later call could survive'],
    ["named, with its error, in the run's failures list"],
    ['is not an agent dispatch'],
  ])('carries the guidance moved out of the tool description: %s', (anchor) => {
    expect(skillProse()).toContain(anchor);
  });

  // Every limit the reference states is a number the runtime actually
  // enforces. Anchored through the exported constants so raising a cap in
  // the runtime fails here instead of leaving the model planning against a
  // number nothing reads any more.
  it.each([
    [String(DEFAULT_MAX_AGENTS_PER_RUN)],
    [String(DEFAULT_WORKFLOW_SUBAGENT_MAX_TURNS)],
    [String(DEFAULT_WORKFLOW_SUBAGENT_MAX_TIME_MINUTES)],
    [String(MAX_STALL_ATTEMPTS)],
    [String(DEFAULT_STALL_MS)],
    [MAX_WORKFLOW_AGENTS_ENV],
    [MAX_WORKFLOW_CONCURRENCY_ENV],
    [WORKFLOW_SUBAGENT_MAX_TURNS_ENV],
    [WORKFLOW_SUBAGENT_MAX_MINUTES_ENV],
    [MAX_WORKFLOW_STALL_MS_ENV],
    ['QWEN_CODE_MAX_WORKFLOW_SECONDS'],
  ])('states the runtime limit %s', (anchor) => {
    expect(skillProse()).toContain(anchor);
  });

  it('describes the sandbox contract a script has to be written against', () => {
    const prose = skillProse();

    expect(prose).toContain('async IIFE');
    expect(prose).toContain('export const meta = {...}');
    expect(prose).toContain('`parallel([() => agent(...)])`');
    expect(prose).toContain('`Date.now()` and `Math.random()` both throw');
    expect(prose).toContain('`node:vm` sandbox');
    // Saving a workflow is a different skill; pointing at it keeps this one
    // from growing a second, drifting copy of the file-layout rules.
    expect(prose).toContain('`workflow-creator` skill');
  });

  // The worked example is the part a model copies. If it stopped checking
  // for `null` it would teach the exact bug the null-settlement contract
  // exists to make visible.
  it('ships a worked example that handles a failed agent', () => {
    const { body } = loadSkill();

    expect(body).toContain('```js');
    expect(body).toContain('await pipeline(');
    expect(body).toContain('=== null');
    expect(body).toContain('return { confirmed };');
  });

  // Ultracode is an upstream concept qwen-code does not have. A stray
  // mention would send the model looking for a keyword nothing detects.
  it('does not mention concepts this build lacks', () => {
    expect(loadSkill().body.toLowerCase()).not.toContain('ultracode');
  });
});
