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
  it('runs every ten minutes and processes one candidate', () => {
    expect(yml.on.schedule[0].cron).toBe('*/10 * * * *');
    expect(skill).toContain('Classify exactly one');
  });

  it('keeps GitHub write credentials out of classification', () => {
    expect(yml.jobs.classify.permissions).toEqual({
      actions: 'read',
      contents: 'read',
      'pull-requests': 'read',
    });
    const classifier = yml.jobs.classify.steps.find((step) =>
      step.uses?.includes('qwen-code-action'),
    );
    expect(classifier.env).toEqual({ GH_TOKEN: '', GITHUB_TOKEN: '' });
    expect(JSON.stringify(classifier)).not.toContain('CI_BOT_PAT');
    expect(yml.jobs.act.permissions).toEqual({
      actions: 'read',
      contents: 'read',
      'pull-requests': 'read',
    });
    expect(JSON.stringify(yml.jobs.act)).toContain('CI_BOT_PAT');
  });

  it('uses a restricted classifier and a trusted fresh act checkout', () => {
    const classifier = yml.jobs.classify.steps.find((step) =>
      step.uses?.includes('qwen-code-action'),
    );
    expect(classifier.with.settings).toContain('"sandbox": true');
    expect(classifier.with.settings).toContain('"read_file"');
    expect(classifier.with.settings).toContain('"write_file"');
    expect(classifier.with.settings).not.toContain('"shell"');
    expect(yml.jobs.act.needs).toBe('classify');
    expect(workflow).toContain('needs.classify.outputs.input_sha');
    expect(workflow).toContain('--input-sha');
    expect(
      yml.jobs.act.steps.find((step) => step.name === 'Checkout trusted main')
        .with['persist-credentials'],
    ).toBe(false);
  });
});
