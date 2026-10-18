/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// gh may render Maven's ESC bytes as the printable sequence ^[.
// eslint-disable-next-line no-control-regex -- Also accept raw ANSI colour codes.
const ANSI = /(?:\u001B|\^\[)\[[0-9;?]*[A-Za-z]/g;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z /;
const TRANSIENT_TRANSFER =
  /^\[ERROR\] .*Could not transfer artifact\b.*(?:status(?: code)?[: =]+(?:502|503|504)\b|Transfer failed for https?:\/\/\S+ (?:502|503|504)\b|(?:connect(?:ion)?|read) timed out\b|connection reset\b)/i;
const MAVEN_FOOTER =
  /^\[ERROR\](?:\s*| To see the full stack trace of the errors, re-run Maven with the -e switch\.| Re-run Maven using the -X switch to enable full debug logging\.| For more information about the errors and possible solutions, please read the following articles:| \[Help \d+\] https?:\/\/\S+\/(?:PluginResolutionException|DependencyResolutionException)| After correcting the problems, you can resume the build with the command|\s+mvn <args> -rf :\S+)$/;

function isTransientMavenFailure(lines) {
  const output = lines.filter((line) => line.trim());
  if (
    !/^##\[error\]Process completed with exit code [1-9]\d*\.$/.test(
      output.at(-1) ?? '',
    )
  ) {
    return false;
  }
  const failure = output.lastIndexOf('[INFO] BUILD FAILURE');
  if (failure < 0) return false;
  if (
    output.some(
      (line) =>
        line.startsWith('[ERROR]') &&
        !TRANSIENT_TRANSFER.test(line) &&
        !MAVEN_FOOTER.test(line),
    )
  ) {
    return false;
  }

  // Only the terminal Maven failure counts: an earlier retry or a warning
  // must not hide a later compiler/test failure in the same step.
  const tail = output.slice(failure + 1, -1);
  return (
    tail.some((line) => TRANSIENT_TRANSFER.test(line)) &&
    tail.every(
      (line) =>
        TRANSIENT_TRANSFER.test(line) ||
        MAVEN_FOOTER.test(line) ||
        /^\[INFO\] (?:-+|Total time: .+|Finished at: .+|Final Memory: .+)$/.test(
          line,
        ),
    )
  );
}

export function isMavenTransferFailure(job, logText) {
  if (!job || !Array.isArray(job.steps) || typeof job.name !== 'string') {
    return false;
  }
  const failedSteps = job.steps.filter((step) => step.conclusion === 'failure');
  if (
    !job.name ||
    /[\t\r\n]/.test(job.name) ||
    failedSteps.some(
      (step) =>
        typeof step.name !== 'string' ||
        !step.name ||
        /[\t\r\n]/.test(step.name),
    )
  ) {
    return false;
  }
  const logs = new Map(failedSteps.map((step) => [step.name, []]));
  if (!failedSteps.length || logs.size !== failedSteps.length) return false;

  for (const rawLine of logText.split('\n')) {
    if (!rawLine.trim()) continue;
    const [jobName, stepName, ...rest] = rawLine.replace(ANSI, '').split('\t');
    const text = rest.join('\t');
    if (
      jobName !== job.name ||
      stepName === 'UNKNOWN STEP' ||
      !logs.has(stepName) ||
      !TIMESTAMP.test(text)
    ) {
      return false;
    }
    logs.get(stepName).push(text.replace(TIMESTAMP, '').trimEnd());
  }
  // gh can silently omit a missing step log even when its command succeeds.
  return [...logs.values()].every(isTransientMavenFailure);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const job = JSON.parse(process.argv[2]);
    process.exitCode = isMavenTransferFailure(
      job,
      readFileSync(process.argv[3], 'utf8'),
    )
      ? 0
      : 1;
  } catch {
    // Missing metadata or logs keep the ordinary issue-reporting path.
    process.exitCode = 1;
  }
}
