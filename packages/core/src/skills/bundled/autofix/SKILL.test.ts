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

function loadAutofixWorkflow(): string {
  return fs.readFileSync(
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../../../../../.github/workflows/qwen-autofix.yml',
    ),
    'utf8',
  );
}

describe('bundled autofix skill', () => {
  it('is a user-only shell skill with three exact subcommands', () => {
    const { config, body } = loadAutofixSkill();
    const input = section(body, 'Input');
    const accepted = Array.from(
      input.matchAll(/^- `([^`]+)`$/gm),
      (match) => match[1],
    );

    expect(config.argumentHint).toBe('status | on | off');
    expect(config.allowedTools).toEqual(['run_shell_command']);
    expect(config.disableModelInvocation).toBe(true);
    expect(accepted).toEqual(['status', 'on', 'off']);
    expect(input).toContain('empty input, extra tokens, or any other value');
    expect(input).toContain('Usage: /autofix status | on | off');
    expect(input).toContain('stop without posting a comment');
  });

  it('pins current-branch resolution and the workflow command bodies', () => {
    const { body } = loadAutofixSkill();
    const status = section(body, 'status');
    const on = section(body, 'on');
    const off = section(body, 'off');
    const workflow = loadAutofixWorkflow();
    const takeoverCommand = workflow.match(
      /^\s*TAKEOVER_COMMAND: '([^']+)'$/m,
    )?.[1];

    expect(takeoverCommand).toBe('@qwen-code /takeover');
    expect(workflow).toContain(
      '[[ "${BODY_TRIMMED}" == "${TAKEOVER_COMMAND}" ]]',
    );
    expect(workflow).toContain(
      '[[ "${BODY_TRIMMED}" == "${TAKEOVER_COMMAND} stop" ]]',
    );
    expect(body).toContain(
      'gh pr view --json number,url,state,baseRefName,isCrossRepository,maintainerCanModify,author,labels,statusCheckRollup,reviewDecision,latestReviews',
    );
    expect(on.match(/gh pr comment/g) ?? []).toHaveLength(1);
    expect(on).toContain(
      `gh pr comment "$PR_NUMBER" --body '${takeoverCommand}'`,
    );
    expect(off.match(/gh pr comment/g) ?? []).toHaveLength(1);
    expect(off).toContain(
      `gh pr comment "$PR_NUMBER" --body '${takeoverCommand} stop'`,
    );
    expect(status).not.toContain('gh pr comment');
    expect(body).toContain(
      'Do not accept or infer a pull request number or URL from the conversation.',
    );
    expect(body).toContain('direct label mutation');
    expect(body).toContain('`gh workflow run`');
  });

  it('documents status precedence and fail-closed writes', () => {
    const { body } = loadAutofixSkill();
    const status = section(body, 'status');
    const failing = status.indexOf('1. `failing`');
    const pending = status.indexOf('2. `pending`');
    const passing = status.indexOf('3. `passing`');
    const noChecks = status.indexOf('4. `no checks`');

    expect(status).toContain('The skip label always wins');
    expect(status).toContain('**Takeover mode**');
    expect(status).toContain(
      'bot-authored pull requests may still receive standard Autofix management',
    );
    expect(status).toContain(
      '`FAILURE`, `CANCELLED`, `TIMED_OUT`, `ACTION_REQUIRED`, `STARTUP_FAILURE`, or `STALE`',
    );
    expect(status).toContain('StatusContext state is `ERROR` or `FAILURE`');
    expect(status).toContain(
      'no failure exists and any check has no conclusion',
    );
    expect(status).toContain(
      'at least one check exists, every CheckRun has a non-failing conclusion',
    );
    expect(status).toContain('rollup is absent or empty');
    expect([failing, pending, passing, noChecks]).toEqual(
      [...[failing, pending, passing, noChecks]].sort((a, b) => a - b),
    );
    expect(status).toContain('no aggregate decision');
    expect(body).toContain('Do not post a comment.');
    expect(body).toContain('require it to be a positive digit-only integer');
    expect(body).toContain('Do not claim takeover is active');
  });
});
