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

function loadGoalDraftSkill() {
  const skillPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'SKILL.md',
  );
  const content = fs.readFileSync(skillPath, 'utf8');
  const config = parseSkillContent(content, skillPath);
  return { config, body: config.body };
}

describe('bundled goal-draft skill', () => {
  it('is a read-only skill: it may inspect the workspace and the Goal, but not change either', () => {
    const { config } = loadGoalDraftSkill();

    expect(config.name).toBe('goal-draft');
    expect(config.allowedTools).toEqual([
      'get_goal',
      'ask_user_question',
      'read_file',
      'glob',
      'grep_search',
    ]);
    // Drafting an objective must never turn into doing the work or
    // proposing a terminal Goal status on the user's behalf.
    expect(config.allowedTools).not.toContain('run_shell_command');
    expect(config.allowedTools).not.toContain('write_file');
    expect(config.allowedTools).not.toContain('edit');
    expect(config.allowedTools).not.toContain('update_goal');
  });

  it('stays model-invocable and user-invocable so both `/goal-draft` and "define a goal" reach it', () => {
    const { config } = loadGoalDraftSkill();

    expect(config.disableModelInvocation).toBeFalsy();
    expect(config.userInvocable ?? true).toBe(true);
    expect(config.argumentHint).toBe(
      '[intent, or an existing goal to tighten]',
    );
    expect(config.description).toContain('/goal-draft');
    expect(config.description).toContain('never starts the work');
  });

  it('explains the verifier rules the objective format is derived from', () => {
    const { body } = loadGoalDraftSkill();

    // These mirror goal-verifier.ts / goalJudge.ts: transcript-only
    // evidence, delivered_output cannot prove external state, and user
    // actions need user_input evidence.
    expect(body).toContain('sees ONLY transcript evidence');
    expect(body).toContain('`delivered_output` evidence proves only');
    expect(body).toContain('needs a real user message as evidence');
    expect(body).toContain('paste the decisive output line');
  });

  it('walks the six steps in order and gates on whether a Goal is warranted', () => {
    const { body } = loadGoalDraftSkill();

    const headings = [
      '## Step 0 — should this be a Goal at all?',
      '## Step 1 — check the active Goal',
      '## Step 2 — ground the draft in the workspace',
      '## Step 3 — at most one round of questions',
      '## Step 4 — draft the objective',
      '## Step 5 — self-check, then hand off',
    ];
    const positions = headings.map((heading) => body.indexOf(heading));
    expect(positions.every((index) => index >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(body).toContain('Call `get_goal`');
    expect(body).toContain('Never draft a second concurrent goal.');
    expect(body).toContain(
      'A goal that cannot be checked is a prompt, not a goal.',
    );
  });

  it('rations clarifying questions and forbids inventing a verification path', () => {
    const { body } = loadGoalDraftSkill();

    expect(body).toContain('1–3 questions in one call');
    expect(body).toContain(
      'Never ask what you could find out by reading the workspace.',
    );
    expect(body).toContain('you MUST ask, offering 2–3 candidate checks');
    expect(body).toContain('mark it `[ASSUMPTION]` in Context');
    expect(body).toContain('Never invent paths, IDs, or commands');
  });

  it('fixes the objective contract labels and keeps the hand-off on one line', () => {
    const { body } = loadGoalDraftSkill();

    for (const label of [
      'Outcome:',
      'Done when:',
      'Must not:',
      'Budget:',
      'On block:',
      'Context:',
    ]) {
      expect(body).toContain(label);
    }
    // parseGoalCommand joins whitespace-separated tokens with single
    // spaces, so a multi-line objective would be flattened anyway.
    expect(body).toContain(
      'the `/goal` parser joins lines with spaces, so number items instead of relying on newlines',
    );
    expect(body).toContain('`/goal set <objective on one line>`');
    expect(body).toContain('or `/goal edit …` when tightening the active goal');
  });

  it('ends with the self-check list and an explicit stop', () => {
    const { body } = loadGoalDraftSkill();

    expect(body).toContain('No subjective adjectives as conditions');
    expect(body).toContain('No "after the user confirms/approves"');
    expect(body).toContain('Exactly one Outcome.');
    expect(body).toContain('Irreversible actions (push, delete, publish)');
    expect(body).toContain(
      'Do not run /goal yourself. Do not begin the task. Stop and wait for the user.',
    );
    // The "do not do the work" instruction is stated up front as well as at
    // the end, because skipping straight to implementation is the most
    // common failure mode of spec-writing skills.
    expect(
      body.indexOf('You are NOT doing the work the goal describes.'),
    ).toBeLessThan(body.indexOf('## Step 0'));
  });
});
