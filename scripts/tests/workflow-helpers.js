/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect } from 'vitest';

export function getWorkflowJob(workflow, jobName) {
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

export function getWorkflowStep(job, stepName) {
  const marker = `      - name: '${stepName}'`;
  const start = job.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);

  const afterMarker = job.slice(start + marker.length);
  const nextStep = afterMarker.match(/\n {6}- /);

  return job.slice(
    start,
    nextStep ? start + marker.length + nextStep.index : undefined,
  );
}
