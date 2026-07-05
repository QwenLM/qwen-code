#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const skillPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'SKILL.md',
);
const QWEN_TIMEOUT_MS = 50 * 60 * 1000;
const specs = {
  'assess-candidates': {
    inputs: ['candidates.json'],
    outputs: ['decision.json'],
    invocation: (o) => `/autofix assess-candidates --workdir ${o.workdir}`,
  },
  'develop-issue': {
    inputs: ['candidates.json', 'decision.json'],
    outputs: ['e2e-report.md', 'pr-title.txt', 'pr-body.md'],
    required: ['issue'],
    invocation: (o) =>
      `/autofix develop-issue --issue ${o.issue} --workdir ${o.workdir}`,
  },
  'address-review': {
    inputs: ['feedback.md'],
    outputs: ['address-summary.md', 'no-action.md'],
    required: ['pr', 'issue'],
    anyOutput: true,
    invocation: (o) =>
      `/autofix address-review --pr ${o.pr} --issue ${o.issue} --workdir ${o.workdir} --conflict ${o.conflict} --base ${o.base}`,
  },
};

function fail(message) {
  console.error(message);
  process.exit(1);
}

function file(workdir, name) {
  return resolve(workdir, name);
}

function missing(workdir, names) {
  return names.filter((name) => !existsSync(file(workdir, name)));
}

function writeFailure(workdir, message) {
  mkdirSync(workdir, { recursive: true });
  writeFileSync(
    file(workdir, 'failure.md'),
    `${message}\n\nSee the Qwen Autofix agent step logs for model/tool output.\n`,
  );
}

function promptFor(options, spec) {
  const skill = readFileSync(skillPath, 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/^---\n[\s\S]*?\n---(?:\n|$)/, '')
    .trim();
  return [
    `Skill directory: ${dirname(skillPath)}`,
    'Resolve skill-relative paths from that directory.',
    '',
    skill,
    '',
    `Mode: ${options.mode}`,
    'Invocation:',
    spec.invocation(options),
    '',
  ].join('\n');
}

const { values } = parseArgs({
  options: {
    base: { type: 'string', default: 'main' },
    conflict: { type: 'string', default: 'false' },
    issue: { type: 'string' },
    mode: { type: 'string' },
    pr: { type: 'string' },
    'print-prompt': { type: 'boolean', default: false },
    'qwen-bin': { type: 'string', default: 'qwen' },
    workdir: { type: 'string', default: '/tmp/autofix' },
  },
});
const options = {
  ...values,
  printPrompt: values['print-prompt'],
  qwenBin: values['qwen-bin'],
};
const spec = specs[options.mode];
if (!spec) fail(`--mode must be one of: ${Object.keys(specs).join(', ')}`);
if (!['true', 'false'].includes(options.conflict)) {
  fail('--conflict must be true or false');
}
for (const key of spec.required ?? []) {
  if (!options[key]) fail(`--${key} is required for ${options.mode}`);
}

const prompt = promptFor(options, spec);
if (options.printPrompt) {
  process.stdout.write(prompt);
  process.exit(0);
}

const missingInputs = missing(options.workdir, spec.inputs);
if (missingInputs.length > 0) {
  fail(
    `Missing input file(s) in ${options.workdir}: ${missingInputs.join(', ')}`,
  );
}

const result = spawnSync(options.qwenBin, ['--yolo', '--prompt', prompt], {
  stdio: 'inherit',
  timeout: QWEN_TIMEOUT_MS,
});
if (result.error || result.signal || result.status !== 0) {
  const detail =
    result.error?.message ?? result.signal ?? `status ${String(result.status)}`;
  if (!existsSync(file(options.workdir, 'failure.md'))) {
    writeFailure(
      options.workdir,
      `Qwen failed during ${options.mode}: ${detail}.`,
    );
  } else {
    console.error(
      `Qwen failed during ${options.mode}: ${detail}; preserving agent-written failure.md.`,
    );
  }
  process.exit(result.status ?? 1);
}

if (existsSync(file(options.workdir, 'failure.md'))) {
  console.error(`Autofix agent wrote ${file(options.workdir, 'failure.md')}`);
  process.exit(0);
}

const missingOutputs = missing(options.workdir, spec.outputs);
const ok = spec.anyOutput
  ? missingOutputs.length < spec.outputs.length
  : missingOutputs.length === 0;
if (!ok) {
  const message = `Autofix agent finished without required output file(s): ${spec.outputs.join(
    ', ',
  )}.`;
  writeFailure(options.workdir, message);
  fail(message);
}
