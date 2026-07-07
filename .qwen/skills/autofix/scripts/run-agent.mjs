#!/usr/bin/env node

import { spawn } from 'node:child_process';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
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
    exclusiveOutput: true,
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
  return names.filter((name) => {
    const path = file(workdir, name);
    return !existsSync(path) || statSync(path).size === 0;
  });
}

function writeFailure(workdir, message) {
  mkdirSync(workdir, { recursive: true });
  writeFileSync(
    file(workdir, 'failure.md'),
    `${message}\n\nSee the Qwen Autofix agent step logs for model/tool output.\n`,
  );
}

function writeHandoff(workdir, message) {
  mkdirSync(workdir, { recursive: true });
  writeFileSync(file(workdir, 'handoff.md'), `${message}\n`);
}

function isLoopGuardOutput(output) {
  return (
    output.includes('turn_tool_call_cap') ||
    output.includes('Loop detection halted the run')
  );
}

function runQwen(options, prompt) {
  mkdirSync(options.workdir, { recursive: true });
  const log = createWriteStream(file(options.workdir, 'agent.log'), {
    flags: 'w',
  });
  log.on('error', () => {});
  let outputTail = '';
  let loopDetected = false;
  let settled = false;
  let timedOut = false;
  let timer;

  return new Promise((resolve) => {
    const child = spawn(options.qwenBin, ['--yolo', '--prompt', prompt], {
      stdio: ['inherit', 'pipe', 'pipe'],
    });

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const payload = {
        ...result,
        timedOut,
        loopDetected: loopDetected || isLoopGuardOutput(outputTail),
      };
      if (log.destroyed) {
        resolve(payload);
      } else {
        log.end(() => resolve(payload));
      }
    };

    const record = (chunk, stream) => {
      const text = chunk.toString('utf8');
      if (!loopDetected && isLoopGuardOutput(text)) loopDetected = true;
      outputTail = (outputTail + text).slice(-20_000);
      log.write(chunk);
      stream.write(chunk);
    };

    child.stdout.on('data', (chunk) => record(chunk, process.stdout));
    child.stderr.on('data', (chunk) => record(chunk, process.stderr));
    child.on('error', (error) => finish({ error, status: null, signal: null }));
    child.on('close', (status, signal) =>
      finish({ error: null, status, signal }),
    );

    timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, QWEN_TIMEOUT_MS);
  });
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

const result = await runQwen(options, prompt);
if (result.error || result.signal || result.status !== 0) {
  const detail = result.error
    ? result.error.message
    : result.timedOut
      ? `timeout (${QWEN_TIMEOUT_MS}ms)`
      : result.signal
        ? `signal ${result.signal}`
        : `status ${String(result.status)}`;
  if (!existsSync(file(options.workdir, 'failure.md'))) {
    if (result.loopDetected) {
      writeFailure(
        options.workdir,
        `Qwen hit the tool-call loop guard during ${options.mode}: turn_tool_call_cap. A human should take over this feedback batch.`,
      );
      writeHandoff(
        options.workdir,
        'Qwen hit the tool-call loop guard; a human should take over this feedback batch.',
      );
    } else {
      writeFailure(
        options.workdir,
        `Qwen failed during ${options.mode}: ${detail}.`,
      );
    }
  } else {
    writeHandoff(
      options.workdir,
      'The agent wrote failure.md before qwen exited; a human should take over this feedback batch.',
    );
    console.error(
      `Qwen failed during ${options.mode}: ${detail}; preserving agent-written failure.md.`,
    );
  }
  process.exit(result.status ?? 1);
}

if (existsSync(file(options.workdir, 'failure.md'))) {
  const content = readFileSync(file(options.workdir, 'failure.md'), 'utf8');
  writeHandoff(
    options.workdir,
    'The agent wrote failure.md; a human should take over this feedback batch.',
  );
  console.error(`Autofix agent wrote failure.md:\n${content}`);
  process.exit(0);
}

const missingOutputs = missing(options.workdir, spec.outputs);
const presentOutputs = spec.outputs.filter(
  (name) => !missingOutputs.includes(name),
);
if (spec.exclusiveOutput && presentOutputs.length > 1) {
  const message = `Autofix agent wrote mutually exclusive output files: ${presentOutputs.join(', ')}.`;
  writeFailure(options.workdir, message);
  fail(message);
}
const ok = spec.anyOutput
  ? missingOutputs.length < spec.outputs.length
  : missingOutputs.length === 0;
if (!ok) {
  const message = `Autofix agent finished without required output file(s): ${missingOutputs.join(', ')}.`;
  writeFailure(options.workdir, message);
  fail(message);
}

console.log(`Autofix agent completed ${options.mode} successfully.`);
