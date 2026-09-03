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

const skillDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const QWEN_TIMEOUT_MS = Number(process.env.QWEN_TIMEOUT_MS) || 70 * 60 * 1000;
const specs = {
  scan: {
    inputs: [],
    outputs: ['findings.json'],
    required: [],
    invocation: (o) => `Scan phase. --workdir ${o.workdir}`,
  },
  fix: {
    inputs: ['findings.json'],
    outputs: ['findings.json'],
    required: ['branch'],
    invocation: (o) => `Fix phase. --workdir ${o.workdir} --branch ${o.branch}`,
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
    `${message}\n\nSee the repo-hygiene agent step logs for model/tool output.\n`,
  );
}

function isLoopGuardOutput(output) {
  return (
    output.includes('turn_tool_call_cap') ||
    output.includes('Loop detection halted the run')
  );
}

function killQwen(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
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
  let killTimer;

  return new Promise((resolve) => {
    const child = spawn(
      options.qwenBin,
      ['--approval-mode', 'auto-edit', '--prompt', prompt],
      {
        stdio: ['inherit', 'pipe', 'pipe'],
        detached: true,
      },
    );

    // A cancelled workflow SIGTERMs this script only; without forwarding,
    // the detached child would keep running (with API credentials) until
    // the runner VM is reclaimed.
    for (const sig of ['SIGTERM', 'SIGINT']) {
      process.on(sig, () => {
        killQwen(child, 'SIGKILL');
        process.exit(1);
      });
    }

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      const payload = {
        ...result,
        timedOut,
        loopDetected: loopDetected || isLoopGuardOutput(outputTail),
      };
      if (log.destroyed) {
        resolve(payload);
      } else {
        // Settle on error too: a swallowed stream error would otherwise
        // drop the end() callback and hang the promise forever.
        let done = false;
        const settle = () => {
          if (!done) {
            done = true;
            resolve(payload);
          }
        };
        log.once('error', settle);
        log.end(settle);
      }
    };

    const record = (chunk, stream) => {
      const text = chunk.toString('utf8');
      outputTail = (outputTail + text).slice(-20_000);
      if (!loopDetected && isLoopGuardOutput(outputTail)) loopDetected = true;
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
      killQwen(child, 'SIGTERM');
      killTimer = setTimeout(() => {
        if (!settled) killQwen(child, 'SIGKILL');
      }, 10_000);
    }, QWEN_TIMEOUT_MS);
  });
}

function promptFor(options, spec) {
  const skill = readFileSync(resolve(skillDir, 'SKILL.md'), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/^---\n[\s\S]*?\n---(?:\n|$)/, '')
    .trim();
  return [
    `Skill directory: ${skillDir}`,
    'Resolve skill-relative paths from that directory.',
    '',
    skill,
    '',
    'Invocation:',
    spec.invocation(options),
    '',
  ].join('\n');
}

const { values } = parseArgs({
  options: {
    branch: { type: 'string' },
    mode: { type: 'string' },
    'print-prompt': { type: 'boolean', default: false },
    'qwen-bin': { type: 'string', default: 'qwen' },
    workdir: { type: 'string', default: '/tmp/hygiene' },
  },
});
const options = {
  ...values,
  printPrompt: values['print-prompt'],
  qwenBin: values['qwen-bin'],
};
const spec = specs[options.mode];
if (!spec) fail(`--mode must be one of: ${Object.keys(specs).join(', ')}`);
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
        `Qwen hit the tool-call loop guard during ${options.mode}. A human should review this run's partial output.`,
      );
    } else {
      writeFailure(
        options.workdir,
        `Qwen failed during ${options.mode}: ${detail}.`,
      );
    }
  } else {
    console.error(
      `Qwen failed during ${options.mode}: ${detail}; preserving agent-written failure.md.`,
    );
  }
  process.exit(result.status ?? 1);
}

if (existsSync(file(options.workdir, 'failure.md'))) {
  const content = readFileSync(file(options.workdir, 'failure.md'), 'utf8');
  console.error(`Repo-hygiene agent wrote failure.md:\n${content}`);
  process.exit(0);
}

const missingOutputs = missing(options.workdir, spec.outputs);
if (missingOutputs.length > 0) {
  const message = `Repo-hygiene agent finished without required output file(s): ${missingOutputs.join(', ')}.`;
  writeFailure(options.workdir, message);
  fail(message);
}

console.log(`Repo-hygiene agent completed ${options.mode} successfully.`);
