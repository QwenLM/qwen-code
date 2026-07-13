import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const workflow = readFileSync(
  '.github/workflows/qwen-ci-flaky-rerun.yml',
  'utf8',
);
const yml = parse(workflow);
const skill = readFileSync('.qwen/skills/ci-flaky-patrol/SKILL.md', 'utf8');

describe('ci flaky rerun workflow', () => {
  it('runs every 10 minutes with bounded candidates', () => {
    expect(yml.on.schedule[0].cron).toBe('*/10 * * * *');
    expect(workflow).toContain("ACTIVE_DAYS: '7'");
    expect(workflow).toContain("MAX_CANDIDATES_PER_RUN: '5'");
  });

  it('keeps PAT out of the skill classification step', () => {
    expect(yml.jobs.classify.permissions).toEqual({
      actions: 'read',
      contents: 'read',
      'pull-requests': 'read',
    });
    expect(yml.jobs.act.permissions).toEqual({
      actions: 'read',
      contents: 'read',
      'pull-requests': 'read',
    });
    const skillStep = yml.jobs.classify.steps.find((s) =>
      s.uses?.includes('qwen-code-action'),
    );
    expect(skillStep).toBeDefined();
    expect(JSON.stringify(skillStep)).not.toContain('CI_BOT_PAT');
    expect(JSON.stringify(yml.jobs.act)).toContain('CI_BOT_PAT');
  });

  it('delegates failure judgment to the skill with sandbox and no token', () => {
    expect(workflow).toContain('.qwen/skills/ci-flaky-patrol/SKILL.md');
    expect(workflow).toContain('ci-flaky-input.json');
    expect(workflow).toContain('ci-flaky-decisions.json');
    expect(workflow).toContain('"sandbox": true');
    expect(workflow).toContain("GH_TOKEN: ''");
    expect(workflow).toContain('"read_file"');
    expect(workflow).toContain('"write_file"');
    expect(workflow).not.toContain('"shell"');
    expect(workflow).toContain('--input-sha');
    expect(workflow).toContain('needs.classify.outputs.input_sha');
    expect(workflow).toContain('test -s "${WORKDIR}/ci-flaky-decisions.json"');
    expect(skill).toContain('`pending` before rerun/update mutations');
    expect(skill).toContain('rejected or ambiguous output as `no_action`');
  });

  it('runs act even when classify finds nothing, for reset', () => {
    expect(yml.jobs.act.if).toContain('always()');
    expect(yml.jobs.act.needs).toContain('classify');
  });

  it('applies decisions before best-effort state cleanup', () => {
    const act = workflow.indexOf("name: 'Act on PR failure decisions'");
    const reset = workflow.indexOf("name: 'Reset successful failure state'");
    expect(act).toBeGreaterThan(-1);
    expect(reset).toBeGreaterThan(act);
    expect(workflow.slice(reset)).toContain('continue-on-error: true');
    expect(
      yml.jobs.act.steps.find((step) => step.name.includes('Reset')).if,
    ).toContain('always()');
  });
});
