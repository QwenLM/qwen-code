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
import { expect, it } from 'vitest';

const jobs = [
  ['desktop-release', 'prepare'],
  ...['triage', 'tmux-testing', 'verify'].map((name) => ['qwen-triage', name]),
  ...[
    'test',
    'lint_and_static',
    'integration_no_ak',
    'integration_cli',
    'web_shell_e2e_smoke',
  ].map((name) => ['ci', name]),
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
            RM_BIN: '/usr/bin/rm',
            MKTEMP_BIN: '/usr/bin/mktemp',
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
