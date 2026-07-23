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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../..');

function readPackageJson() {
  return JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
}

function readWorkflow(relativePath) {
  return readFileSync(path.join(root, relativePath), 'utf8');
}

function getWorkflowJob(workflow, jobName) {
  const marker = `  ${jobName}:`;
  const start = workflow.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);

  const afterMarker = workflow.slice(start + marker.length);
  const nextJob = afterMarker.match(/\n {2}[a-zA-Z0-9_-]+:\n/);

  return workflow.slice(
    start,
    nextJob ? start + marker.length + nextJob.index : undefined,
  );
}

function getWorkflowStep(job, stepName) {
  const marker = `      - name: '${stepName}'`;
  const start = job.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);

  const afterMarker = job.slice(start + marker.length);
  const nextStep = afterMarker.match(/\n {6}- name: /);

  return job.slice(
    start,
    nextStep ? start + marker.length + nextStep.index : undefined,
  );
}

describe('package scripts', () => {
  it('keeps the serve fast-path bundle check outside unit test scripts', () => {
    const packageJson = readPackageJson();

    expect(packageJson.scripts['test:ci']).not.toContain(
      'npm run check:serve-fast-path-bundle',
    );
    expect(packageJson.scripts.preflight).toContain(
      'npm run check:serve-fast-path-bundle',
    );
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
          '@echo husky >> "%PREPARE_LOG_FILE%"\r\n',
        );
        writeFileSync(
          path.join(binDir, 'npm.cmd'),
          '@echo npm %* >> "%PREPARE_LOG_FILE%"\r\n',
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
          '@echo husky >> "%PREPARE_LOG_FILE%"\r\n',
        );
        writeFileSync(
          path.join(binDir, 'npm.cmd'),
          '@echo npm %* >> "%PREPARE_LOG_FILE%"\r\n',
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
          '@echo husky >> "%PREPARE_LOG_FILE%"\r\n',
        );
        writeFileSync(
          path.join(binDir, 'npm.cmd'),
          [
            '@echo npm %* >> "%PREPARE_LOG_FILE%"',
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
    const installSteps =
      workflow.match(
        / {6}- name: 'Install Dependencies'[\s\S]*? {10}npm ci --no-audit --progress=false/g,
      ) || [];

    expect(installSteps.length).toBeGreaterThanOrEqual(5);
    for (const installStep of installSteps) {
      expect(installStep).toContain("QWEN_SKIP_PREPARE: '1'");
    }

    for (const jobName of ['integration_none', 'integration_docker']) {
      const integrationJob = getWorkflowJob(workflow, jobName);
      const buildStep = getWorkflowStep(integrationJob, 'Build Bundle');
      expect(buildStep).toContain('npm run build\n          npm run bundle');
    }

    const publishJob = getWorkflowJob(workflow, 'publish');
    const gitConfigStep = getWorkflowStep(publishJob, 'Configure Git User');
    const commitStep = getWorkflowStep(
      publishJob,
      'Commit and Conditionally Push package versions',
    );
    const buildStep = getWorkflowStep(
      publishJob,
      'Build Bundle and Prepare Package',
    );

    expect(gitConfigStep).toContain('git config core.hooksPath .husky');
    expect(publishJob.indexOf(gitConfigStep)).toBeLessThan(
      publishJob.indexOf(commitStep),
    );
    expect(buildStep).toContain('npm run build\n          npm run bundle');
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

    for (const jobName of ['issue-autofix', 'review-address']) {
      const job = getWorkflowJob(workflow, jobName);
      const installStep = getWorkflowStep(
        job,
        'Install dependencies and build',
      );

      expect(installStep).toContain("QWEN_SKIP_PREPARE: '1'");
      expect(installStep).toContain(
        'npm ci --prefer-offline --no-audit --progress=false',
      );
      expect(installStep).toContain('git config core.hooksPath .husky');
      expect(installStep).not.toContain('--ignore-scripts');
    }
  });

  it('runs changed autofix tests instead of full touched-package suites', () => {
    const workflow = readWorkflow('.github/workflows/qwen-autofix.yml');

    for (const jobName of ['issue-autofix', 'review-address']) {
      const job = getWorkflowJob(workflow, jobName);
      const verifyStep = getWorkflowStep(job, 'Verification gate');

      expect(verifyStep).toContain(
        'npm run test --workspace "${p}" --if-present -- --changed origin/main --passWithNoTests',
      );
      expect(verifyStep).toContain(
        'bash "${RUNNER_TEMP}/resolve-owning-packages.sh"',
      );
      expect(verifyStep).toContain('pkg.scripts?.test');
      expect(verifyStep).toContain('!= *vitest*');
      expect(verifyStep).not.toContain(
        'npm run test --workspace "${p}" --if-present\n',
      );
    }
  });
});
