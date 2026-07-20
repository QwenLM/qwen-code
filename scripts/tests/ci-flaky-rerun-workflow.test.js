import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const workflow = readFileSync(
  '.github/workflows/qwen-ci-flaky-rerun.yml',
  'utf8',
);
const yml = parse(workflow);
const skill = readFileSync('.qwen/skills/ci-flaky-patrol/SKILL.md', 'utf8');

describe('ci failure patrol workflow', () => {
  it('runs every ten minutes with serialized configurable batches', () => {
    expect(yml.on.schedule[0].cron).toBe('*/10 * * * *');
    expect(yml.concurrency).toEqual({
      group: 'qwen-ci-flaky-rerun',
      'cancel-in-progress': false,
    });
    expect(yml.env.ACTIVE_DAYS).toBe('7');
    expect(yml.env.MAX_CANDIDATES_PER_RUN).toBe('5');
    expect(workflow).toContain('--active-days "${ACTIVE_DAYS}"');
    expect(workflow).toContain('--max-candidates "${MAX_CANDIDATES_PER_RUN}"');
  });

  it('bounds the classifier step below the job so a slow model cannot kill the patrol', () => {
    // Observed: across a busy 9-hour window EVERY scheduled patrol spent ~9m40s
    // in the classifier and was killed by the 10-minute job timeout, so
    // Validate and Upload never ran, `act` was skipped, and nothing was ever
    // re-run - 28 of 30 runs cancelled. The two that passed took ~2 minutes,
    // at 00:0x, when the model was idle.
    const classify = yml.jobs.classify;
    const step = classify.steps.find(
      (s) => s.name === 'Classify with ci-flaky-patrol skill',
    );
    expect(step).toBeTruthy();
    expect(step['timeout-minutes']).toBeLessThan(classify['timeout-minutes']);
    // A slow model must cost one cycle, not the whole job.
    expect(step['continue-on-error']).toBe(true);

    // An empty classifier result is a no-op cycle, not a patrol failure.
    const validate = classify.steps.find(
      (s) => s.name === 'Validate patrol decisions',
    );
    expect(validate.id).toBe('decisions');
    expect(validate.run).not.toContain('test -s');
    // A timeout kill can leave a non-empty but unparseable file; the validate
    // step must reject it so the act job never receives corrupt JSON.
    expect(validate.run).toContain('JSON.parse');

    // Downstream work is gated on decisions EXISTING, not merely on the job
    // having survived - otherwise a no-decision cycle looks actionable.
    expect(classify.outputs.has_decisions).toBe(
      '${{ steps.decisions.outputs.has_decisions }}',
    );
    const upload = classify.steps.find(
      (s) => s.name === 'Upload patrol input and decisions',
    );
    expect(upload.if).toContain(
      "steps.decisions.outputs.has_decisions == 'true'",
    );
    expect(yml.jobs.act.if).toContain(
      "needs.classify.outputs.has_decisions == 'true'",
    );
  });

  it('reports an empty or corrupt classifier result instead of failing the patrol', () => {
    const validate = yml.jobs.classify.steps.find(
      (s) => s.name === 'Validate patrol decisions',
    );
    const run = (content) => {
      const dir = mkdtempSync(join(tmpdir(), 'patrol-'));
      const out = join(dir, 'gh_output');
      writeFileSync(out, '');
      if (content !== null) {
        writeFileSync(join(dir, 'ci-flaky-decisions.json'), content);
      }
      let status = 0;
      try {
        execFileSync('bash', ['-c', `set -eo pipefail\n${validate.run}`], {
          env: { ...process.env, WORKDIR: dir, GITHUB_OUTPUT: out },
          encoding: 'utf8',
        });
      } catch (e) {
        status = e.status;
      }
      const result = readFileSync(out, 'utf8');
      rmSync(dir, { recursive: true, force: true });
      return { status, result };
    };
    // Decisions present -> act downstream.
    expect(run('{"decisions":[]}')).toMatchObject({ status: 0 });
    expect(run('{"decisions":[]}').result).toContain('has_decisions=true');
    // Classifier timed out and wrote nothing -> still exit 0, just no work.
    expect(run(null)).toMatchObject({ status: 0 });
    expect(run(null).result).toContain('has_decisions=false');
    // Classifier killed mid-write -> partial JSON is not actionable.
    const partial = run('{"decisions": [{"pr": 123, "action": "rer');
    expect(partial).toMatchObject({ status: 0 });
    expect(partial.result).toContain('has_decisions=false');
  });

  it('keeps classifier credentials isolated and PAT writes explicit', () => {
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

  it('passes a decision batch through a trusted act job and always resets', () => {
    expect(yml.jobs.classify.outputs).toHaveProperty('bot_login');
    expect(workflow).toContain('ci-flaky-decisions.json');
    expect(workflow).toContain('--input-sha');
    expect(workflow).toContain('--trusted-marker-login');
    const reset = yml.jobs.act.steps.find(
      (step) => step.name === 'Reset successful failure state',
    );
    expect(reset.if).toContain('always()');
    expect(reset['continue-on-error']).toBe(true);
    expect(reset.env.GH_TOKEN).toContain('CI_BOT_PAT');
  });

  it('runs scan and act with the same trusted event commit', () => {
    for (const job of [yml.jobs.classify, yml.jobs.act]) {
      const checkout = job.steps.find((step) =>
        step.uses?.includes('actions/checkout'),
      );
      expect(checkout.with.ref).toBe('${{ github.sha }}');
      expect(checkout.with['persist-credentials']).toBe(false);
    }
  });

  it('keeps judgment in the skill and GitHub writes in the driver', () => {
    for (const action of ['rerun', 'comment', 'no_action']) {
      expect(skill).toContain(action);
    }
    expect(skill).toContain('maximum of 3 actions');
    expect(skill).toContain('main-branch failures');
    expect(skill).toContain('changedFiles');
    expect(skill).toContain('ci-flaky-decisions.json');
  });
});
