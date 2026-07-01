/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
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

  it('defines a release test script that disables workspace coverage', () => {
    const packageJson = readPackageJson();

    expect(packageJson.scripts['test:release']).toBe(
      [
        'cross-env NODE_OPTIONS="--max-old-space-size=3072"',
        'npm run test:ci --workspaces --if-present -- --coverage=false',
        '&& npm run test:scripts',
      ].join(' '),
    );
  });

  it('can skip root prepare work for CI installs that build explicitly', () => {
    const packageJson = readPackageJson();

    expect(packageJson.scripts.prepare).toBe('node scripts/prepare.js');

    const result = spawnSync(
      process.execPath,
      [path.join(root, 'scripts/prepare.js')],
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          QWEN_SKIP_PREPARE: '1',
        },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Skipping prepare');
  });

  it('wires release quality checks to fast explicit validation steps', () => {
    const workflow = readWorkflow('.github/workflows/release.yml');
    const qualityJob = getWorkflowJob(workflow, 'quality');
    const workspaceTestStep = getWorkflowStep(
      qualityJob,
      'Run Workspace Tests',
    );

    expect(qualityJob).toContain("name: 'Check Serve Fast Path Bundle'");
    expect(qualityJob).toContain('npm run check:serve-fast-path-bundle');
    expect(workspaceTestStep).toContain('npm run test:release');
    expect(workspaceTestStep).not.toContain('npm run test:ci');
  });

  it('skips release install-time prepare and builds before publish bundling', () => {
    const workflow = readWorkflow('.github/workflows/release.yml');
    const installSteps =
      workflow.match(
        / {6}- name: 'Install Dependencies'[\s\S]*? {10}npm ci --no-audit --progress=false/g,
      ) || [];

    expect(installSteps).toHaveLength(5);
    for (const installStep of installSteps) {
      expect(installStep).toContain("QWEN_SKIP_PREPARE: '1'");
    }

    for (const jobName of ['integration_none', 'integration_docker']) {
      const integrationJob = getWorkflowJob(workflow, jobName);
      const buildStep = getWorkflowStep(integrationJob, 'Build Bundle');
      expect(buildStep).toContain('npm run build\n          npm run bundle');
    }

    const publishJob = getWorkflowJob(workflow, 'publish');
    const buildStep = getWorkflowStep(
      publishJob,
      'Build Bundle and Prepare Package',
    );

    expect(buildStep).toContain('npm run build\n          npm run bundle');
  });
});
