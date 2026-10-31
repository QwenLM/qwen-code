#!/usr/bin/env node
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Dependency-free: workflows use block mappings with two-space indentation.
// Reject unsupported headers instead of silently excluding them from the gate.
function block(source, key) {
  const lines = source.split('\n');
  const start = lines.findIndex((line) => key.test(line));
  if (start < 0 || !/:\s*(?:#.*)?$/.test(lines[start])) {
    throw new Error('Expected block-style on/jobs mapping');
  }
  const end = lines.findIndex(
    (line, index) => index > start && /^\S/.test(line) && !line.startsWith('#'),
  );
  return lines.slice(start + 1, end < 0 ? undefined : end);
}

export function measureWorkflow(source) {
  const triggers = block(source, /^(?:on|true|'on'|"on"):/);
  if (
    !triggers.some((line) =>
      /^ {2}(['"]?)(pull_request|pull_request_target|merge_group)\1\s*:/.test(
        line,
      ),
    )
  ) {
    return null;
  }
  const jobs = [];
  for (const line of block(source, /^jobs:/)) {
    if (/^ {2}[\w-]+:\s*(?:#.*)?$/.test(line)) jobs.push(null);
    else if (/^ {2}[^#\s]/.test(line))
      throw new Error('Expected block-style job');
    const timeoutKey = /^ {4}(['"]?)timeout-minutes\1\s*:\s*/;
    if (timeoutKey.test(line)) {
      const timeout = /^(\d+)\s*(?:#.*)?$/.exec(line.replace(timeoutKey, ''));
      // Expressions have no fixed declared budget; count them as unbounded.
      if (timeout && jobs.length) jobs[jobs.length - 1] = Number(timeout[1]);
    }
  }
  if (!jobs.length) throw new Error('No jobs found');
  return [
    jobs.length,
    jobs.reduce((sum, timeout) => sum + (timeout ?? 0), 0),
    jobs.filter((timeout) => timeout === null).length,
  ];
}

export function checkBudget(workflowDir = '.github/workflows') {
  const baseline = new Map();
  for (const line of readFileSync(
    join(workflowDir, '.ci-budget'),
    'utf8',
  ).split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const match = /^(\d+)\s+(\d+)\s+(\d+)\s+(\S+\.ya?ml)$/.exec(line.trim());
    if (!match || baseline.has(match[4]))
      throw new Error(`Invalid budget entry: ${line}`);
    baseline.set(match[4], match.slice(1, 4).map(Number));
  }
  const errors = [];
  const labels = ['jobs', 'timeout-minutes', 'jobs without fixed timeout'];
  for (const file of readdirSync(workflowDir).sort()) {
    if (!/\.ya?ml$/.test(file)) continue;
    let actual;
    try {
      actual = measureWorkflow(readFileSync(join(workflowDir, file), 'utf8'));
    } catch (error) {
      throw new Error(`${file}: ${error.message}`);
    }
    if (!actual) continue;
    const recorded = baseline.get(file);
    const entry = `${actual.join(' ')} ${file}`;
    if (!recorded) {
      errors.push(`${file}: missing budget; add '${entry}' to .ci-budget`);
      continue;
    }
    const growth = labels.flatMap((label, index) =>
      actual[index] > recorded[index]
        ? [`${label} ${recorded[index]} -> ${actual[index]}`]
        : [],
    );
    if (growth.length) {
      errors.push(
        `${file}: ${growth.join(', ')}; update .ci-budget to '${entry}' if intentional`,
      );
    }
  }
  return errors;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const errors = checkBudget();
    for (const error of errors) console.error(`::error::${error}`);
    if (!errors.length) console.log('PR-stage CI budget holds');
    process.exitCode = errors.length ? 1 : 0;
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
