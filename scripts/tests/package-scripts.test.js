/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { getWorkflowJob, getWorkflowStep } from './workflow-helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../..');

function readPackageJson() {
  return JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
}

function readWorkflow(relativePath) {
  return readFileSync(path.join(root, relativePath), 'utf8');
}

describe('package scripts', () => {
  it('does not couple Node REPL to Qwen release versions', () => {
    const versionScript = readFileSync(
      path.join(root, 'scripts/version.js'),
      'utf8',
    );

    expect(versionScript).toContain(
      'const workspacesToExclude = [\n' +
        "  '@qwen-code/sdk',\n" +
        "  '@qwen-code/mobile-mcp',\n" +
        "  '@qwen-code/node-repl-mcp',\n" +
        '];',
    );
  });

  it('keeps the serve fast-path bundle check outside unit test scripts', () => {
    const packageJson = readPackageJson();

    expect(packageJson.scripts['test:ci']).not.toContain(
      'npm run check:serve-fast-path-bundle',
    );
    expect(packageJson.scripts.preflight).toContain(
      'npm run check:serve-fast-path-bundle',
    );
  });

  it('limits SDK integration tests through the forks pool', () => {
    const packageJson = readPackageJson();

    expect(packageJson.scripts['test:integration:sdk:sandbox:none']).toContain(
      '--poolOptions.forks.maxForks 2',
    );
    expect(
      packageJson.scripts['test:integration:sdk:sandbox:docker'],
    ).toContain('--poolOptions.forks.maxForks 2');
  });

  it('cleans package build artifacts before checking the serve fast path bundle', () => {
    const packageJson = readPackageJson();

    expect(packageJson.scripts['check:serve-fast-path-bundle']).toBe(
      [
        'node scripts/clean-package-build-artifacts.js',
        '&& npm run build -- --cli-only',
        '&& cross-env DEV=true npm run bundle',
        '&& node scripts/check-serve-fast-path-bundle.js',
      ].join(' '),
    );
    expect(packageJson.scripts['check:serve-fast-path-bundle']).not.toContain(
      'npm run clean',
    );
  });

  it('defines a release test script that disables workspace coverage', () => {
    const packageJson = readPackageJson();

    expect(packageJson.scripts['test:release']).toBe(
      [
        'cross-env NODE_OPTIONS="--max-old-space-size=3072"',
        'npm run test:ci --workspaces --if-present --parallel -- --coverage.enabled=false',
        '&& npm run test:scripts',
      ].join(' '),
    );

    const vscodePackageJson = JSON.parse(
      readFileSync(
        path.join(root, 'packages/vscode-ide-companion/package.json'),
        'utf8',
      ),
    );
    expect(vscodePackageJson.scripts['test:ci']).toContain('--coverage');
  });

  it('skips build/bundle/husky but still generates git-commit info when CI builds explicitly', () => {
    const packageJson = readPackageJson();

    expect(packageJson.scripts.prepare).toBe('node scripts/prepare.js');

    const binDir = mkdtempSync(path.join(tmpdir(), 'qwen-prepare-skip-'));
    const logFile = path.join(binDir, 'commands.log');
    writeFileSync(logFile, '');

    try {
      if (process.platform === 'win32') {
        writeFileSync(
          path.join(binDir, 'husky.cmd'),
          '@echo(husky>>"%PREPARE_LOG_FILE%"\r\n',
        );
        writeFileSync(
          path.join(binDir, 'npm.cmd'),
          '@echo(npm %*>>"%PREPARE_LOG_FILE%"\r\n',
        );
      } else {
        writeFileSync(
          path.join(binDir, 'husky'),
          '#!/bin/sh\necho husky >> "$PREPARE_LOG_FILE"\n',
        );
        writeFileSync(
          path.join(binDir, 'npm'),
          '#!/bin/sh\necho "npm $*" >> "$PREPARE_LOG_FILE"\n',
        );
        chmodSync(path.join(binDir, 'husky'), 0o755);
        chmodSync(path.join(binDir, 'npm'), 0o755);
      }

      const result = spawnSync(
        process.execPath,
        [path.join(root, 'scripts/prepare.js')],
        {
          cwd: root,
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
            PREPARE_LOG_FILE: logFile,
            QWEN_SKIP_PREPARE: '1',
          },
        },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Skipping prepare');
      // git-commit info is still generated so a later per-workspace build or
      // typecheck (e.g. the review tooling's) doesn't fail on the missing
      // module; the heavy build/bundle/husky are skipped.
      expect(readFileSync(logFile, 'utf8').trim().split(/\r?\n/)).toEqual([
        'npm run generate',
      ]);
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  it('runs prepare steps in order when CI does not skip prepare', () => {
    const binDir = mkdtempSync(path.join(tmpdir(), 'qwen-prepare-bin-'));
    const logFile = path.join(binDir, 'commands.log');

    try {
      if (process.platform === 'win32') {
        writeFileSync(
          path.join(binDir, 'husky.cmd'),
          '@echo(husky>>"%PREPARE_LOG_FILE%"\r\n',
        );
        writeFileSync(
          path.join(binDir, 'npm.cmd'),
          '@echo(npm %*>>"%PREPARE_LOG_FILE%"\r\n',
        );
      } else {
        writeFileSync(
          path.join(binDir, 'husky'),
          '#!/bin/sh\necho husky >> "$PREPARE_LOG_FILE"\n',
        );
        writeFileSync(
          path.join(binDir, 'npm'),
          '#!/bin/sh\necho "npm $*" >> "$PREPARE_LOG_FILE"\n',
        );
        chmodSync(path.join(binDir, 'husky'), 0o755);
        chmodSync(path.join(binDir, 'npm'), 0o755);
      }

      const result = spawnSync(
        process.execPath,
        [path.join(root, 'scripts/prepare.js')],
        {
          cwd: root,
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
            PREPARE_LOG_FILE: logFile,
            QWEN_SKIP_PREPARE: '',
          },
        },
      );

      expect(result.status).toBe(0);
      expect(readFileSync(logFile, 'utf8').trim().split(/\r?\n/)).toEqual([
        'husky',
        'npm run build',
        'npm run bundle',
      ]);
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  it('exits when a prepare step fails', () => {
    const binDir = mkdtempSync(path.join(tmpdir(), 'qwen-prepare-fail-'));
    const logFile = path.join(binDir, 'commands.log');
    writeFileSync(logFile, '');

    try {
      if (process.platform === 'win32') {
        writeFileSync(path.join(binDir, 'husky.cmd'), '@exit /b 7\r\n');
        writeFileSync(
          path.join(binDir, 'npm.cmd'),
          '@echo npm %* >> "%PREPARE_LOG_FILE%"\r\n',
        );
      } else {
        writeFileSync(path.join(binDir, 'husky'), '#!/bin/sh\nexit 7\n');
        writeFileSync(
          path.join(binDir, 'npm'),
          '#!/bin/sh\necho "npm $*" >> "$PREPARE_LOG_FILE"\n',
        );
        chmodSync(path.join(binDir, 'husky'), 0o755);
        chmodSync(path.join(binDir, 'npm'), 0o755);
      }

      const result = spawnSync(
        process.execPath,
        [path.join(root, 'scripts/prepare.js')],
        {
          cwd: root,
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
            PREPARE_LOG_FILE: logFile,
            QWEN_SKIP_PREPARE: '',
          },
        },
      );

      expect(result.status).toBe(7);
      expect(result.stderr).toContain('prepare: husky exited with status 7');
      expect(readFileSync(logFile, 'utf8')).toBe('');
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  it('reports the failing prepare step after earlier steps succeed', () => {
    const binDir = mkdtempSync(path.join(tmpdir(), 'qwen-prepare-late-fail-'));
    const logFile = path.join(binDir, 'commands.log');
    writeFileSync(logFile, '');

    try {
      if (process.platform === 'win32') {
        writeFileSync(
          path.join(binDir, 'husky.cmd'),
          '@echo(husky>>"%PREPARE_LOG_FILE%"\r\n',
        );
        writeFileSync(
          path.join(binDir, 'npm.cmd'),
          [
            '@echo(npm %*>>"%PREPARE_LOG_FILE%"',
            '@if "%1 %2"=="run build" exit /b 7',
            '@exit /b 0',
            '',
          ].join('\r\n'),
        );
      } else {
        writeFileSync(
          path.join(binDir, 'husky'),
          '#!/bin/sh\necho husky >> "$PREPARE_LOG_FILE"\n',
        );
        writeFileSync(
          path.join(binDir, 'npm'),
          [
            '#!/bin/sh',
            'echo "npm $*" >> "$PREPARE_LOG_FILE"',
            'if [ "$1 $2" = "run build" ]; then exit 7; fi',
            '',
          ].join('\n'),
        );
        chmodSync(path.join(binDir, 'husky'), 0o755);
        chmodSync(path.join(binDir, 'npm'), 0o755);
      }

      const result = spawnSync(
        process.execPath,
        [path.join(root, 'scripts/prepare.js')],
        {
          cwd: root,
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
            PREPARE_LOG_FILE: logFile,
            QWEN_SKIP_PREPARE: '',
          },
        },
      );

      expect(result.status).toBe(7);
      expect(result.stderr).toContain(
        'prepare: npm run build exited with status 7',
      );
      expect(readFileSync(logFile, 'utf8').trim().split(/\r?\n/)).toEqual([
        'husky',
        'npm run build',
      ]);
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')(
    'reports when a prepare command is killed by a signal',
    () => {
      const binDir = mkdtempSync(path.join(tmpdir(), 'qwen-prepare-signal-'));

      try {
        writeFileSync(path.join(binDir, 'husky'), '#!/bin/sh\nkill -TERM $$\n');
        writeFileSync(path.join(binDir, 'npm'), '#!/bin/sh\nexit 0\n');
        chmodSync(path.join(binDir, 'husky'), 0o755);
        chmodSync(path.join(binDir, 'npm'), 0o755);

        const result = spawnSync(
          process.execPath,
          [path.join(root, 'scripts/prepare.js')],
          {
            cwd: root,
            encoding: 'utf8',
            env: {
              ...process.env,
              PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
              QWEN_SKIP_PREPARE: '',
            },
          },
        );

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(
          'prepare: husky killed by signal SIGTERM',
        );
      } finally {
        rmSync(binDir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'reports when a prepare command cannot be spawned',
    () => {
      const missingBinDir = mkdtempSync(
        path.join(tmpdir(), 'qwen-prepare-missing-bin-'),
      );

      try {
        const result = spawnSync(
          process.execPath,
          [path.join(root, 'scripts/prepare.js')],
          {
            cwd: root,
            encoding: 'utf8',
            env: {
              ...process.env,
              PATH: missingBinDir,
              QWEN_SKIP_PREPARE: '',
            },
          },
        );

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('prepare: husky failed:');
      } finally {
        rmSync(missingBinDir, { recursive: true, force: true });
      }
    },
  );

  it('wires release quality checks to fast explicit validation steps', () => {
    const workflow = readWorkflow('.github/workflows/release.yml');
    const qualityJob = getWorkflowJob(workflow, 'quality');
    const buildStep = getWorkflowStep(qualityJob, 'Build Project');
    const serveFastPathStep = getWorkflowStep(
      qualityJob,
      'Check Serve Fast Path Bundle',
    );
    const workspaceTestStep = getWorkflowStep(
      qualityJob,
      'Run Workspace Tests',
    );

    expect(qualityJob).toContain("name: 'Check Serve Fast Path Bundle'");
    expect(qualityJob).toContain('npm run check:serve-fast-path-bundle');
    expect(qualityJob.indexOf(serveFastPathStep)).toBeLessThan(
      qualityJob.indexOf(buildStep),
    );
    expect(workspaceTestStep).toContain('npm run test:release');
    expect(workspaceTestStep).not.toContain('npm run test:ci');
  });

  it('skips release install-time prepare and builds before publish bundling', () => {
    const workflow = readWorkflow('.github/workflows/release.yml');
    expect(workflow.slice(0, workflow.indexOf('jobs:'))).not.toContain(
      'CI_BOT_PAT',
    );
    const installSteps =
      workflow.match(
        / {6}- name: 'Install Dependencies'[\s\S]*?(?=\n {6}- name: '|\n {4}[A-Za-z0-9_-]+:|$)/g,
      ) || [];

    expect(installSteps.length).toBe(5);
    for (const installStep of installSteps) {
      expect(installStep).toContain(
        'npm ci --ignore-scripts --no-audit --progress=false',
      );
      expect(installStep).toContain('npm run postinstall');
      expect(installStep).toContain('npm run generate');
      expect(installStep).not.toContain('QWEN_SKIP_PREPARE');
      expect(installStep).not.toContain('CI_BOT_PAT');
    }

    for (const jobName of ['integration_none', 'integration_docker']) {
      const integrationJob = getWorkflowJob(workflow, jobName);
      const buildStep = getWorkflowStep(integrationJob, 'Build Bundle');
      expect(buildStep).toContain('npm run build\n          npm run bundle');
    }

    const publishJob = getWorkflowJob(workflow, 'publish');
    expect(publishJob.slice(0, publishJob.indexOf('steps:'))).not.toContain(
      'CI_BOT_PAT',
    );
    const checkoutStep = getWorkflowStep(publishJob, 'Checkout');
    const gitConfigStep = getWorkflowStep(publishJob, 'Configure Git User');
    const commitStep = getWorkflowStep(
      publishJob,
      'Commit and Conditionally Push package versions',
    );
    const buildStep = getWorkflowStep(
      publishJob,
      'Build Bundle and Prepare Package',
    );

    expect(checkoutStep).toContain('persist-credentials: false');
    expect(gitConfigStep).toContain('git config core.hooksPath .husky');
    expect(publishJob.indexOf(gitConfigStep)).toBeLessThan(
      publishJob.indexOf(commitStep),
    );
    expect(commitStep).toContain("CI_BOT_PAT: '${{ secrets.CI_BOT_PAT }}'");
    expect(commitStep).toContain('export GH_TOKEN="${CI_BOT_PAT}"');
    expect(commitStep).toContain('gh auth setup-git');
    const exportTokenIdx = commitStep.indexOf(
      'export GH_TOKEN="${CI_BOT_PAT}"',
    );
    const setupGitIdx = commitStep.indexOf('gh auth setup-git', exportTokenIdx);
    expect(setupGitIdx).toBeGreaterThan(exportTokenIdx);
    expect(setupGitIdx).toBeLessThan(
      commitStep.indexOf('git push --force --set-upstream'),
    );
    expect(buildStep).toContain('npm run build\n          npm run bundle');
  });

  it('skips npm packages whose release version is already published', () => {
    const workflow = readWorkflow('.github/workflows/release.yml');
    const publishJob = getWorkflowJob(workflow, 'publish');

    for (const stepName of [
      'Publish @qwen-code/audio-capture',
      'Publish @qwen-code/qwen-code',
      'Publish @qwen-code/channel-base',
      'Publish remaining channel packages',
    ]) {
      const publishStep = getWorkflowStep(publishJob, stepName);
      expect(publishStep).toContain(
        "RELEASE_VERSION: '${{ needs.prepare.outputs.release_version }}'",
      );
      expect(publishStep).toContain(
        'PACKAGE_NAME="$(node -p "require(\'./package.json\').name")"',
      );
      expect(publishStep).toContain('PUBLISH_ARGS+=(--dry-run)');
      expect(publishStep).toContain(
        'npm view "${PACKAGE_NAME}@${RELEASE_VERSION}" version',
      );
      expect(publishStep).toContain('already published; skipping');
      expect(publishStep).toContain('exit 0');
      expect(publishStep).toContain(
        'npm publish --provenance "${PUBLISH_ARGS[@]}"',
      );
    }

    // The channel loop must wrap each iteration in a subshell so that
    // `exit 0` skips only the current channel, not the entire step.
    const channelStep = getWorkflowStep(
      publishJob,
      'Publish remaining channel packages',
    );
    expect(channelStep).toContain('(\n');
    expect(channelStep).toContain(')');
    // A fully-skipped publish must be visible, not silently green.
    expect(channelStep).toContain(
      'Every channel package was already published; nothing shipped',
    );
  });

  it('meets npm trusted publishing requirements', () => {
    for (const [workflowPath, jobName, publishStepName] of [
      [
        '.github/workflows/release.yml',
        'publish',
        'Publish @qwen-code/audio-capture',
      ],
      [
        '.github/workflows/release-sdk.yml',
        'release-sdk',
        'Publish @qwen-code/sdk',
      ],
      [
        '.github/workflows/cd-cua-driver.yml',
        'publish-sdk',
        'Publish immutable SDK tarball',
      ],
      [
        '.github/workflows/cd-cua-driver.yml',
        'publish-node-repl',
        'Publish immutable Node REPL tarball',
      ],
      ['.github/workflows/cd-mobile-mcp.yml', 'build-and-publish', 'Publish'],
    ]) {
      const publishJob = getWorkflowJob(readWorkflow(workflowPath), jobName);
      const installStep = getWorkflowStep(publishJob, 'Install npm 11');
      const publishStep = getWorkflowStep(publishJob, publishStepName);
      expect(installStep).toContain('npm install --global npm@11.19.0');
      expect(publishJob).toContain("id-token: 'write'");
      expect(publishStep).toContain('--provenance');
      expect(publishJob).toContain("name: 'production-release'");
      expect(publishJob.indexOf(installStep)).toBeLessThan(
        publishJob.indexOf(publishStep),
      );
    }

    for (const packageDirectory of [
      'packages/audio-capture',
      'packages/cli',
      'packages/channels/base',
      'packages/channels/dingtalk',
      'packages/channels/dws',
      'packages/channels/feishu',
      'packages/channels/github',
      'packages/channels/qqbot',
      'packages/channels/telegram',
      'packages/channels/wecom',
      'packages/channels/weixin',
      'packages/cua-driver/typescript',
      'packages/mobile-mcp',
      'packages/node-repl',
      'packages/sdk-typescript',
    ]) {
      const packageJson = JSON.parse(
        readFileSync(path.join(root, packageDirectory, 'package.json'), 'utf8'),
      );
      expect(packageJson.repository?.url?.replace(/^git\+/, '')).toBe(
        'https://github.com/QwenLM/qwen-code.git',
      );
    }
  });

  it('fast-tracks trusted autofix issue triggers before LLM assessment', () => {
    const workflow = readWorkflow('.github/workflows/qwen-autofix.yml');
    const issueJob = getWorkflowJob(workflow, 'issue-autofix');
    const scanStep = getWorkflowStep(issueJob, 'Find candidate issues');
    const fastTrackStep = getWorkflowStep(issueJob, 'Fast-track decision');
    const assessStep = getWorkflowStep(issueJob, 'Assess candidates');

    expect(issueJob.indexOf(scanStep)).toBeLessThan(
      issueJob.indexOf(fastTrackStep),
    );
    expect(issueJob.indexOf(fastTrackStep)).toBeLessThan(
      issueJob.indexOf(assessStep),
    );
    expect(fastTrackStep).toContain("id: 'fasttrack'");
    expect(fastTrackStep).toContain('FAST_TRACK=false');
    expect(fastTrackStep).toContain('FAST_TRACK=true');
    expect(fastTrackStep).toContain('fast_tracked=false');
    expect(fastTrackStep).toContain('-n "${FORCED_ISSUE}"');
    expect(fastTrackStep).toContain(
      'Fast-tracked: trusted trigger bypasses LLM assessment.',
    );
    expect(assessStep).toContain(
      "steps.fasttrack.outputs.fast_tracked != 'true'",
    );
  });

  it('skips autofix install-time prepare without disabling dependency scripts', () => {
    const workflow = readWorkflow('.github/workflows/qwen-autofix.yml');

    // review-address restores the shared build-cli bundle instead of
    // compiling, so its install step is npm ci only; the other two jobs
    // still build from sources. Husky hooks are re-armed after the
    // prepare-skip only where git commits happen (build-cli never commits).
    for (const [jobName, stepName, armsHooks] of [
      ['issue-autofix', 'Install dependencies and build', true],
      ['build-cli', 'Install dependencies and build', false],
      ['review-address', 'Install dependencies', true],
    ]) {
      const job = getWorkflowJob(workflow, jobName);
      const installStep = getWorkflowStep(job, stepName);

      expect(installStep).toContain("QWEN_SKIP_PREPARE: '1'");
      expect(installStep).toContain(
        'npm ci --prefer-offline --no-audit --progress=false',
      );
      if (armsHooks) {
        expect(installStep).toContain('git config core.hooksPath .husky');
      }
      expect(installStep).not.toContain('--ignore-scripts');
    }
  });

  it('runs changed autofix tests instead of full touched-package suites', () => {
    const workflow = readWorkflow('.github/workflows/qwen-autofix.yml');
    const reviewVerificationRunner = readWorkflow(
      '.github/scripts/run-autofix-review-verification.sh',
    );
    const reviewJob = getWorkflowJob(workflow, 'review-address');

    for (const verificationBody of [
      getWorkflowStep(
        getWorkflowJob(workflow, 'issue-autofix'),
        'Verification gate',
      ),
      reviewVerificationRunner,
    ]) {
      expect(verificationBody).toContain(
        'npm run test --workspace "${p}" --if-present -- --changed origin/main --passWithNoTests',
      );
      expect(verificationBody).toContain(
        'bash "${RUNNER_TEMP}/resolve-owning-packages.sh"',
      );
      expect(verificationBody).toContain('pkg.scripts?.test');
      expect(verificationBody).toContain('!= *vitest*');
      expect(verificationBody).not.toContain(
        'npm run test --workspace "${p}" --if-present\n',
      );
    }

    expect(getWorkflowStep(reviewJob, 'Verification gate')).toContain(
      'bash --norc "${RUNNER_TEMP}/run-autofix-review-verification.sh"',
    );
  });
});
