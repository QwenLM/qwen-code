#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const skillPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'SKILL.md',
);
const specs = {
  'assess-candidates': {
    inputs: ['candidates.json'],
    outputs: ['decision.json'],
    invocation: (o) =>
      `/autofix assess-candidates --workdir ${quote(o.workdir)}`,
  },
  'develop-issue': {
    inputs: ['candidates.json', 'decision.json'],
    outputs: ['e2e-report.md', 'pr-title.txt', 'pr-body.md'],
    required: ['issue'],
    invocation: (o) =>
      `/autofix develop-issue --issue ${quote(o.issue)} --workdir ${quote(
        o.workdir,
      )}`,
  },
  'address-review': {
    inputs: ['feedback.md'],
    outputs: ['address-summary.md', 'no-action.md', 'failure.md'],
    required: ['pr', 'issue'],
    anyOutput: true,
    invocation: (o) =>
      `/autofix address-review --pr ${quote(o.pr)} --issue ${quote(
        o.issue,
      )} --workdir ${quote(o.workdir)} --conflict ${o.conflict} --base ${quote(
        o.base,
      )}`,
  },
};

function fail(message) {
  console.error(message);
  process.exit(1);
}

function quote(value) {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", "'\\''")}'`;
}

function parseArgs(args) {
  const options = {
    base: 'main',
    conflict: 'false',
    qwenBin: 'qwen',
    workdir: '/tmp/autofix',
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--print-prompt') {
      options.printPrompt = true;
      continue;
    }
    if (!arg.startsWith('--')) fail(`Unexpected argument: ${arg}`);
    const name = arg.slice(2);
    const value = args[i + 1];
    if (!value || value.startsWith('--')) fail(`--${name} requires a value`);
    i += 1;
    const key =
      name === 'qwen-bin'
        ? 'qwenBin'
        : name.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    options[key] = value;
  }

  const spec = specs[options.mode];
  if (!spec)
    fail('--mode must be assess-candidates, develop-issue, or address-review');
  if (!['true', 'false'].includes(options.conflict)) {
    fail('--conflict must be true or false');
  }
  for (const key of spec.required ?? []) {
    if (!options[key]) fail(`--${key} is required for ${options.mode}`);
  }
  return { options, spec };
}

function workdirPath(options, filename) {
  return resolve(options.workdir, filename);
}

function missing(options, filenames) {
  return filenames.filter(
    (filename) => !existsSync(workdirPath(options, filename)),
  );
}

function writeFailure(options, message) {
  mkdirSync(options.workdir, { recursive: true });
  writeFileSync(
    workdirPath(options, 'failure.md'),
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

const { options, spec } = parseArgs(process.argv.slice(2));
const prompt = promptFor(options, spec);

if (options.printPrompt) {
  process.stdout.write(prompt);
  process.exit(0);
}

const missingInputs = missing(options, spec.inputs);
if (missingInputs.length > 0) {
  fail(
    `Missing input file(s) in ${options.workdir}: ${missingInputs.join(', ')}`,
  );
}

const result = spawnSync(options.qwenBin, ['--yolo', '--prompt', prompt], {
  stdio: 'inherit',
});
if (result.error || result.signal || result.status !== 0) {
  const detail =
    result.error?.message ?? result.signal ?? `status ${String(result.status)}`;
  writeFailure(options, `Qwen failed during ${options.mode}: ${detail}.`);
  process.exit(result.status ?? 1);
}

if (existsSync(workdirPath(options, 'failure.md'))) {
  fail(`Autofix agent wrote ${workdirPath(options, 'failure.md')}`);
}

const missingOutputs = missing(options, spec.outputs);
const ok = spec.anyOutput
  ? missingOutputs.length < spec.outputs.length
  : missingOutputs.length === 0;
if (!ok) {
  const message = `Autofix agent finished without required output file(s): ${spec.outputs.join(
    ', ',
  )}.`;
  writeFailure(options, message);
  fail(message);
}
