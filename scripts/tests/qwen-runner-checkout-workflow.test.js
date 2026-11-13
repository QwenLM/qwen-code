import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';

// macOS ships rm at /bin/rm, so a hardcoded /usr/bin/rm exits 127 on the macOS
// scripts lane (which collects these files — the vitest exclude is win32-only).
// Resolve external tools the way the workflows themselves do.
const resolvedBin = (name) =>
  execFileSync('bash', ['-c', `command -v ${name}`], {
    encoding: 'utf8',
  }).trim();
import { expect, it } from 'vitest';

// The qwen-triage entries are DERIVED, not hand-typed: every pool-routed job
// that checks out must reset the workspace git metadata first. A hand-typed
// list missed publish-triage once (the write-PAT job ran on the pool with
// agent-planted hooks executable while this suite stayed green); deriving
// the set means the next pool-routed checkout job reddens here with no edit
// to this file. The checkout intersection is load-bearing: authorize and
// publish-tmux are pool-routed but never check out, so they have no reset
// step to pin. Same derivation shape as e2e-workflow.test.js's pool gate.
const triagePoolCheckoutJobs = Object.entries(
  parse(readFileSync('.github/workflows/qwen-triage.yml', 'utf8')).jobs,
)
  .filter(([, job]) => String(job['runs-on'] ?? '').includes('ecs-qwen'))
  .filter(([, job]) =>
    (job.steps ?? []).some((step) =>
      /^actions\/checkout@/.test(String(step.uses ?? '')),
    ),
  )
  .map(([name]) => ['qwen-triage', name]);

// A floor, not an exact list: the derivation reads the UN-EVALUATED runs-on
// expression, so rewriting one job's routing into a `vars.` lookup (or moving
// its checkout behind a composite action) silently drops that row and the
// guard stops covering it. Assert the jobs known to be pool-routed with a
// checkout are present, so a filter that stops matching names the job it
// lost; a NEW pool job still joins the matrix with no edit here.
it('derives every known pool-routed checkout job in qwen-triage', () => {
  expect(triagePoolCheckoutJobs.map(([, name]) => name)).toEqual(
    expect.arrayContaining([
      'triage',
      'publish-triage',
      'tmux-testing',
      'verify',
    ]),
  );
});

const jobs = [
  ['desktop-release', 'prepare'],
  ...triagePoolCheckoutJobs,
  ...[
    'test',
    'lint_and_static',
    'integration_no_ak',
    'integration_cli',
    'web_shell_e2e_smoke',
  ].map((name) => ['ci', name]),
  // The E2E pool legs check out on the same shared workspace, and a leftover
  // sparse index from another lane breaks them the same way: checkout's
  // clean/reset skip the sparse-excluded paths, then `sparse-checkout disable`
  // aborts with "not uptodate; will not remove from working tree" and leaves
  // no .github/ behind. Run 43010833061 lost the sandbox:docker leg at the very
  // next step, which could not resolve .github/actions/self-hosted-node.
  ...['build', 'e2e-test-linux'].map((name) => ['e2e', name]),
  ...['test', 'flyway-migrations', 'mysql-integration', 'daemon-e2e'].map(
    (name) => ['sdk-java', name],
  ),
  ...['issue-autofix', 'build-cli', 'review-address'].map((name) => [
    'qwen-autofix',
    name,
  ]),
  ...['classify', 'act'].map((name) => ['qwen-ci-flaky-rerun', name]),
];

it.each(jobs)(
  '%s / %s replaces runner Git metadata before checkout without following links',
  (workflow, name) => {
    const { steps } = parse(
      readFileSync(`.github/workflows/${workflow}.yml`, 'utf8'),
    ).jobs[name];
    const index = steps.findIndex(
      (step) => step.name === 'Recreate runner Git metadata',
    );
    expect(index).toBeGreaterThanOrEqual(0);
    expect(steps[index].if).toBe("${{ runner.environment == 'self-hosted' }}");
    expect(steps[index + 1].uses).toMatch(/^actions\/checkout@/);

    const root = mkdtempSync(join(tmpdir(), 'qwen-checkout-'));
    try {
      const workspace = join(root, 'workspace');
      const external = join(root, 'external');
      mkdirSync(workspace);
      mkdirSync(external);
      const cached = join(workspace, 'node_modules');
      const preserved = join(external, 'keep');
      mkdirSync(cached);
      writeFileSync(preserved, 'keep external repository');
      // A real runner always provides these. Steps that neutralise the global
      // and system Git config write an empty file under RUNNER_TEMP and export
      // the scopes through GITHUB_ENV, so the fixture has to offer both or it
      // would exercise those steps against paths that do not exist.
      const runnerTemp = join(root, 'runner-temp');
      mkdirSync(runnerTemp);
      const githubEnv = join(root, 'gh-env');
      writeFileSync(githubEnv, '');
      const git = (...args) =>
        execFileSync('git', args, { cwd: workspace, stdio: 'pipe' });
      const recover = () =>
        execFileSync('bash', ['-e', '-c', steps[index].run], {
          cwd: workspace,
          env: {
            ...process.env,
            GITHUB_WORKSPACE: workspace,
            RUNNER_TEMP: runnerTemp,
            GITHUB_ENV: githubEnv,
            // Steps that use the guard's verified base need those binaries and
            // an output file; a real runner always supplies GITHUB_OUTPUT.
            GITHUB_OUTPUT: join(root, 'gh-output'),
            RM_BIN: resolvedBin('rm'),
            // The patrol's rebuild also validates every component of the
            // system_path it hands checkout. Derive it from the same binary so
            // the two checks stand or fall together on any host.
            SYSTEM_PATH: resolvedBin('rm').replace(/\/[^/]+$/, ''),
            MKTEMP_BIN: resolvedBin('mktemp'),
          },
        });

      git('init', '--quiet');
      writeFileSync(
        join(workspace, '.git', 'shallow'),
        'broken shallow boundary',
      );
      expect(() => git('rev-parse', '--is-shallow-repository')).toThrow();
      recover();
      expect(existsSync(join(workspace, '.git'))).toBe(false);
      git('init', '--quiet');
      expect(
        git('rev-parse', '--is-shallow-repository').toString().trim(),
      ).toBe('false');

      rmSync(join(workspace, '.git'), { recursive: true });
      symlinkSync(external, join(workspace, '.git'));
      recover();
      expect(readFileSync(preserved, 'utf8')).toBe('keep external repository');
      expect(existsSync(cached)).toBe(true);
      recover();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
