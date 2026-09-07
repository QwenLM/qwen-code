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
    expect(body).toContain("preserve the user's explicit choice to edit it");
    expect(body).toContain("do not choose on the user's behalf");
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

  it('bounds drafting reads and avoids invented audit quotas', () => {
    const { body } = loadGoalDraftSkill();

    expect(body).toContain('Stop exploring once those are grounded');
    expect(body).toContain(
      'do not audit the implementation, reproduce failures, run builds or tests, install dependencies, or start services',
    );
    expect(body).toContain('Usually 3–5 Done-when checks suffice');
    expect(body).toContain('Do not add checks just to reach a count');
    expect(body).toContain('preserve explicit user requirements');
    expect(body).toContain('Zero defects is a valid result');
    expect(body).toContain('never require a positive defect count');
    expect(body).toContain(
      'Do not invent minimum scenario counts, evidence-file counts, or exploration-round quotas',
    );
  });

  it('withholds an actionable hand-off while essential information is missing', () => {
    const { body } = loadGoalDraftSkill();
    const gate = body.indexOf('**If an essential item remains unresolved');
    const readyHandoff = body.indexOf('Then hand off, and nothing else:');

    // "Needs clarification" also appears in the gate line, so pin the
    // intro's deliverable sentence above Step 0 where only it can match.
    expect(body.slice(0, body.indexOf('## Step 0'))).toContain(
      'deliver only a draft marked "Needs clarification"',
    );

    expect(body).toContain(
      'use a recommended default only for nonessential choices',
    );
    expect(body).toContain(
      'unresolved edit-versus-replace choice stays `<TODO: …>`',
    );
    expect(gate).toBeGreaterThan(body.indexOf('## Step 5'));
    expect(gate).toBeLessThan(readyHandoff);
    expect(body.slice(gate, readyHandoff)).toContain('Needs clarification');
    expect(body.slice(gate, readyHandoff)).toContain('success criterion');
    expect(body.slice(gate, readyHandoff)).toContain(
      'Do not call `propose_goal` or print a runnable `/goal set` or `/goal edit` line',
    );
    expect(body.slice(gate, readyHandoff)).toContain('Stop here');
  });

  it('describes the prose budget as an agreement rather than a runtime limit', () => {
    const { body } = loadGoalDraftSkill();

    expect(body).toContain('not a runtime-enforced turn or wall-clock limit');
    expect(body).toContain(
      'Do not claim that writing it configures a timer or changes the Goal token budget',
    );
    expect(body).toContain('Preserve a user-specified budget');
    expect(body).toContain('mark the default `[ASSUMPTION]` in Context');
    // The self-check must enforce the marking, and the strong exemplar must
    // model it — a bare default Budget contradicts both.
    expect(body.slice(body.indexOf('## Step 5'))).toContain(
      'an unrequested default Budget is marked `[ASSUMPTION]` in Context',
    );
    expect(body).toContain(
      "Context: [ASSUMPTION] the 20-turn budget is the drafter's default",
    );
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
    expect(template).toContain("<user's stopping agreement");
    expect(template).toContain('stop as blocked after 20 turns');
    expect(template).not.toContain('minutes');
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
      '**Otherwise** (Web Shell or another ACP client, headless, the tool is disabled, or a Goal is active)',
    );
    expect(body).toContain('the draft has not been applied');
    expect(body).toContain(
      'Do not promise a dialog in Web Shell or other ACP sessions',
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
