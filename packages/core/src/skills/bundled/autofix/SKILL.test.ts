/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseSkillContent } from '../../skill-load.js';

function loadAutofixSkill() {
  const skillPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'SKILL.md',
  );
  const content = fs.readFileSync(skillPath, 'utf8');
  const config = parseSkillContent(content, skillPath);
  return { config, body: config.body };
}

function section(body: string, heading: string): string {
  const marker = `## ${heading}\n`;
  const start = body.indexOf(marker);
  expect(start, `missing section: ${heading}`).toBeGreaterThanOrEqual(0);
  const contentStart = start + marker.length;
  const next = body.indexOf('\n## ', contentStart);
  return body.slice(contentStart, next < 0 ? undefined : next);
}

function loadLoopSkill(): string {
  return fs.readFileSync(
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../loop/SKILL.md',
    ),
    'utf8',
  );
}

describe('bundled autofix skill', () => {
  it('is a user-only session watcher with explicit confirmation modes', () => {
    const { config, body } = loadAutofixSkill();
    const input = section(body, 'Input');
    const accepted = Array.from(
      input.matchAll(/^- `([^`]+)`$/gm),
      (match) => match[1],
    );

    expect(config.argumentHint).toBe(
      'status | on [propose-only|auto-commit|auto-push] | off',
    );
    expect(config.allowedTools).toEqual([
      'run_shell_command',
      'cron_create',
      'cron_list',
      'cron_delete',
    ]);
    expect(config.disableModelInvocation).toBe(true);
    expect(accepted).toEqual([
      'status',
      'on',
      'on propose-only',
      'on auto-commit',
      'on auto-push',
      'off',
    ]);
    expect(input).toContain('validates the literal slash-command arguments');
    expect(input).toContain('surrounding conversation text');
    expect(input).toContain('<autofix-authority>');
    expect(input).toContain('Bare `on` uses `propose-only`');
    expect(input).toContain(
      'Usage: /autofix status | on [propose-only|auto-commit|auto-push] | off',
    );
    expect(input).toContain('This skill is user-only');
  });

  it('pins current-branch resolution and stateful per-PR cron prompts', () => {
    const { body } = loadAutofixSkill();
    const status = section(body, 'status');
    const on = section(body, 'on');
    const off = section(body, 'off');
    const tick = section(body, 'Autofix tick');

    expect(body).toContain(
      'Do not accept or infer a pull request number or URL from the conversation.',
    );
    expect(status).toContain('completed by the CLI');
    expect(status).toContain('infrastructure rerun count');
    expect(on).toContain('`cron`: `*/10 * * * *`');
    expect(on).toContain(
      '`prompt`: `autofix tick repo=$OWNER/$REPO pr=$PR_NUMBER mode=$MODE rounds=0 infra-reruns=0`',
    );
    expect(on).toContain('Do not create a second job');
    expect(on).toContain('run the first maintenance check immediately');
    expect(off).toContain('completed by the CLI');
    expect(off).toContain('reports `off` only after none remain');
    expect(tick).toContain('canonical `owner/repo`');
    expect(tick).toContain('carrying the CLI-supplied');
    expect(tick).toContain('require the PR to remain open');
    expect(tick).toContain('Never retarget silently');
    expect(body).not.toContain('@qwen-code /takeover');
    expect(body).not.toContain('gh pr comment "$PR_NUMBER"');
  });

  it('documents CI, feedback, mode, commit, and stop guardrails', () => {
    const { body } = loadAutofixSkill();
    const tick = section(body, 'Autofix tick');
    expect(tick).toContain('Require the index to be empty');
    expect(tick).toContain('`act`');
    expect(tick).toContain('`reply-and-dismiss`');
    expect(tick).toContain('`defer-to-human`');
    expect(tick).toContain('Do not broaden scope');
    expect(tick).toContain('round five or later');
    expect(tick).toContain("run the repository's required build and typecheck");
    expect(tick).toContain('Auto-fix:');
    expect(tick).toContain('`propose-only`');
    expect(tick).toContain('`auto-commit`');
    expect(tick).toContain('`auto-push`');
    expect(tick).toContain('Push without force');
    expect(tick).toContain('round count is ten or greater');
    expect(tick).toContain('increment the round count by one');
    expect(tick).toContain('infrastructure rerun count is below one');
    expect(tick).toContain('`infra-reruns=1`');
    expect(tick).toContain('current infrastructure rerun count');
    expect(tick).toContain('do not call LoopWakeup');
  });

  it('states loop and review integration without delegating authority', () => {
    const { body } = loadAutofixSkill();
    const integration = section(body, 'Integration with loop and review');

    expect(loadLoopSkill()).toContain('`/autofix status`');
    expect(integration).toContain('/autofix on');
    expect(integration).toContain('/review');
    expect(integration).toContain(
      're-check every finding against the live pull request',
    );
    expect(integration).toContain(
      'Never treat a clean review as proof that failing CI is unrelated.',
    );
  });
});
