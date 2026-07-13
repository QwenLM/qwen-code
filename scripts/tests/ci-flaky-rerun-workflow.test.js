import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const workflow = readFileSync(
  '.github/workflows/qwen-ci-flaky-rerun.yml',
  'utf8',
);
const skill = readFileSync('.qwen/skills/ci-flaky-patrol/SKILL.md', 'utf8');
const yml = parse(workflow);

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
      actions: 'write',
      contents: 'read',
      'pull-requests': 'write',
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
  });

  it('runs act even when classify finds nothing, for reset', () => {
    expect(yml.jobs.act.if).toContain('always()');
    expect(yml.jobs.act.needs).toContain('classify');
  });

  it('skill defines the classification contract', () => {
    expect(skill).toContain('rerun');
    expect(skill).toContain('update_branch');
    expect(skill).toContain('comment');
    expect(skill).toContain('no_action');
    expect(skill).toContain('failureKey');
    expect(skill).toContain('confidence');
    expect(skill).toContain('main-branch failures');
  });
});
