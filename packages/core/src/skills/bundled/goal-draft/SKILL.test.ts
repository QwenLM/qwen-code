/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildPermissionCheckContext,
  evaluatePermissionRules,
} from '../../../core/permission-helpers.js';
import { PermissionManager } from '../../../permissions/permission-manager.js';
import { applySkillAllowedTools } from '../../../tools/skill-utils.js';
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
  it('auto-approves only the non-mutating tools: Goal read and workspace reads', () => {
    const { config } = loadGoalDraftSkill();

    expect(config.name).toBe('goal-draft');
    expect(config.allowedTools).toEqual([
      'get_goal',
      'read_file',
      'glob',
      'grep_search',
    ]);
    // allowedTools is an additive auto-approval grant, not a sandbox
    // (skills/types.ts) — read-only behavior is enforced by the SKILL.md
    // prose. These assertions pin what the grant deliberately excludes:
    // drafting must never turn into doing the work or proposing a
    // terminal Goal status on the user's behalf.
    expect(config.allowedTools).not.toContain('run_shell_command');
    expect(config.allowedTools).not.toContain('write_file');
    expect(config.allowedTools).not.toContain('edit');
    expect(config.allowedTools).not.toContain('update_goal');
    // propose_goal shows its approval dialog through the tool's own 'ask'
    // default; a grant here would only mislead (see ask_user_question).
    expect(config.allowedTools).not.toContain('propose_goal');
    // ask_user_question must stay ungranted: a session-wide allow rule
    // overrides its 'ask' default and the scheduler then runs it without
    // showing the dialog, fabricating a declined-answer result (see the
    // grant test below).
    expect(config.allowedTools).not.toContain('ask_user_question');
  });

  it('keeps ask_user_question behind its dialog after the allowedTools grant', async () => {
    const { config } = loadGoalDraftSkill();

    // BundledSkillLoader applies the frontmatter grant as session-wide
    // allow rules. If ask_user_question were granted, that rule would
    // override the tool's interactive 'ask' default and it would execute
    // with no dialog, returning "User declined to answer" as success.
    const pm = new PermissionManager({
      getPermissionsAllow: () => undefined,
      getPermissionsAsk: () => undefined,
      getPermissionsDeny: () => undefined,
    });
    applySkillAllowedTools(pm, config.allowedTools);

    const ctx = buildPermissionCheckContext('ask_user_question', {}, '');
    await expect(
      evaluatePermissionRules(pm, 'ask', ctx),
    ).resolves.toMatchObject({ finalPermission: 'ask' });
  });

  it('stays model-invocable and user-invocable so both `/goal-draft` and "define a goal" reach it', () => {
    const { config, body } = loadGoalDraftSkill();

    expect(config.disableModelInvocation).toBeFalsy();
    expect(config.userInvocable ?? true).toBe(true);
    expect(config.argumentHint).toBe(
      '[intent, or an existing goal to tighten]',
    );
    expect(config.description).toContain('/goal-draft');
    expect(config.description).toContain('never starts the work');
    // Both entry paths — the `/goal-draft` slash command and the model's
    // own Skill call — inject this body, so a second Skill call can only
    // re-request an approval that headless runs cannot give, and the
    // session stops without drafting anything. The body must forbid it.
    expect(body).toContain('do not call the `skill` tool to invoke it again');
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

    // Pin the labels where the drafter copies them from — the ```text
    // template — not just anywhere in the body, where the Weak→strong
    // table repeats five of the six labels.
    const templateStart = body.indexOf('```text');
    const templateEnd = body.indexOf('\n```', templateStart);
    expect(templateStart).toBeGreaterThanOrEqual(0);
    expect(templateEnd).toBeGreaterThan(templateStart);
    const template = body.slice(templateStart, templateEnd);

    let previous = -1;
    for (const label of [
      'Outcome:',
      'Done when:',
      'Must not:',
      'Budget:',
      'On block:',
      'Context:',
    ]) {
      const position = template.indexOf(label);
      expect(position).toBeGreaterThan(previous);
      previous = position;
    }
    // parseGoalCommand joins whitespace-separated tokens with single
    // spaces, so a multi-line objective would be flattened anyway.
    expect(body).toContain(
      'the `/goal` parser joins lines with spaces, so number items instead of relying on newlines',
    );
    expect(body).toContain('`/goal set <objective on one line>`');
    expect(body).toContain('or `/goal edit …` when tightening the active goal');
    // Wrapping the hand-off line in inline code makes the terminal render
    // escaped backticks, and copying it then pastes backslashes into the
    // objective — the line must go out as plain text.
    expect(body).toContain('Print it as plain text with no code markers');
  });

  it('hands off through propose_goal when it is available, and prints the /goal line otherwise', () => {
    const { body } = loadGoalDraftSkill();

    expect(body).toContain(
      'If the `propose_goal` tool is available and no Goal is active',
    );
    expect(body).toContain('only their approval sets the Goal');
    expect(body).toContain(
      'do not propose the same or a reworded objective again',
    );
    expect(body).toContain('acknowledge it in one sentence and end the turn');
    // The text hand-off survives for headless runs and disabled tools.
    expect(body).toContain(
      '**Otherwise** (headless, the tool is disabled, or a Goal is active)',
    );
  });

  it('ends with the self-check list and an explicit stop', () => {
    const { body } = loadGoalDraftSkill();

    expect(body).toContain('No subjective adjectives as conditions');
    expect(body).toContain('No "after the user confirms/approves"');
    expect(body).toContain('Exactly one Outcome.');
    expect(body).toContain('Irreversible actions (push, delete, publish)');
    // The stop instruction is pinned as the very last line so the final
    // thing the model reads is "do not start".
    expect(body.trimEnd().split('\n').pop()).toBe(
      'Do not run /goal yourself. Do not begin the task. Stop and wait for the user.',
    );
    // The "do not do the work" instruction is stated up front as well as at
    // the end, because skipping straight to implementation is the most
    // common failure mode of spec-writing skills.
    const upFront = body.indexOf(
      'You are NOT doing the work the goal describes.',
    );
    const step0 = body.indexOf('## Step 0');
    expect(upFront).toBeGreaterThanOrEqual(0);
    expect(step0).toBeGreaterThanOrEqual(0);
    expect(upFront).toBeLessThan(step0);
  });
});
