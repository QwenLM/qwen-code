#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const defaultSkillPath = resolve(dirname(scriptPath), '..', 'SKILL.md');
const modes = new Set(['assess-candidates', 'develop-issue', 'address-review']);
const valueOptions = new Set([
  'base',
  'conflict',
  'issue',
  'mode',
  'pr',
  'qwen-bin',
  'skill-path',
  'workdir',
]);
const booleanOptions = new Set(['check-inputs', 'help', 'print-prompt']);

function usage() {
  return `Usage:
  run-agent.mjs --mode assess-candidates --workdir <dir> [--print-prompt] [--check-inputs]
  run-agent.mjs --mode develop-issue --issue <number> --workdir <dir> [--print-prompt] [--check-inputs]
  run-agent.mjs --mode address-review --pr <number> --issue <number> --workdir <dir> [--conflict true|false] [--base main] [--print-prompt] [--check-inputs]

Options:
  --print-prompt   Print the expanded skill prompt and exit without running qwen.
  --check-inputs   Validate required workdir input files before printing/running.
  --qwen-bin CMD   qwen executable to run. Defaults to qwen.
  --skill-path P   Skill markdown path. Defaults to ${defaultSkillPath}.
`;
}

function fail(message) {
  console.error(message);
  console.error('');
  console.error(usage());
  process.exit(1);
}

function parseArgs(args) {
  const options = {
    base: 'main',
    checkInputs: false,
    conflict: 'false',
    printPrompt: false,
    qwenBin: 'qwen',
    skillPath: defaultSkillPath,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith('--')) {
      fail(`Unexpected positional argument: ${arg}`);
    }

    const name = arg.slice(2);
    if (name === 'help') {
      options.help = true;
      continue;
    }
    if (name === 'print-prompt') {
      options.printPrompt = true;
      continue;
    }
    if (name === 'check-inputs') {
      options.checkInputs = true;
      continue;
    }
    if (!valueOptions.has(name) || booleanOptions.has(name)) {
      fail(`Unknown option: --${name}`);
    }
    const value = args[i + 1];
    if (!value || value.startsWith('--')) {
      fail(`--${name} requires a value`);
    }
    i += 1;

    if (name === 'qwen-bin') {
      options.qwenBin = value;
    } else if (name === 'skill-path') {
      options.skillPath = resolve(value);
    } else if (name === 'check-inputs') {
      options.checkInputs = true;
    } else if (name === 'print-prompt') {
      options.printPrompt = true;
    } else {
      options[name.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase())] = value;
    }
  }

  if (options.help) {
    process.stdout.write(usage());
    process.exit(0);
  }

  if (!options.mode) {
    fail('--mode is required');
  }
  if (!modes.has(options.mode)) {
    fail(`Unsupported --mode: ${options.mode}`);
  }

  if (options.mode === 'develop-issue' && !options.issue) {
    fail('--issue is required for develop-issue');
  }
  if (options.mode === 'address-review') {
    if (!options.pr) {
      fail('--pr is required for address-review');
    }
    if (!options.issue) {
      fail('--issue is required for address-review');
    }
    if (!options.workdir) {
      fail('--workdir is required for address-review');
    }
  }
  options.workdir ??= '/tmp/autofix';
  if (!['true', 'false'].includes(options.conflict)) {
    fail('--conflict must be true or false');
  }

  options.invocation = buildInvocation(options);
  return options;
}

function quoteArg(value) {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function buildInvocation(options) {
  const workdir = quoteArg(options.workdir);
  if (options.mode === 'assess-candidates') {
    return `/autofix assess-candidates --workdir ${workdir}`;
  }
  if (options.mode === 'develop-issue') {
    return `/autofix develop-issue --issue ${quoteArg(options.issue)} --workdir ${workdir}`;
  }
  return [
    '/autofix address-review',
    `--pr ${quoteArg(options.pr)}`,
    `--issue ${quoteArg(options.issue)}`,
    `--workdir ${workdir}`,
    `--conflict ${options.conflict}`,
    `--base ${quoteArg(options.base)}`,
  ].join(' ');
}

function buildPrompt(skillPath, invocation, mode) {
  const skillText = readFileSync(skillPath, 'utf8').replace(/\r\n/g, '\n');
  const match = /^---\n[\s\S]*?\n---(?:\n|$)([\s\S]*)$/.exec(skillText);
  if (!match) {
    throw new Error(`${skillPath} is missing YAML frontmatter.`);
  }

  return [
    `Base directory for this skill: ${dirname(skillPath)}`,
    'Important: ALWAYS resolve absolute paths from this base directory when working with skills.',
    '',
    match[1].trim(),
    '',
    `Mode: ${mode}`,
    'Invocation:',
    invocation,
    '',
  ].join('\n');
}

function requiredInputFiles(options) {
  if (options.mode === 'assess-candidates') {
    return ['candidates.json'];
  }
  if (options.mode === 'develop-issue') {
    return ['candidates.json', 'decision.json'];
  }
  if (options.mode === 'address-review') {
    return ['feedback.md'];
  }
  return [];
}

function checkInputs(options) {
  if (!options.workdir) {
    fail('--workdir is required to check inputs or write failure.md');
  }
  const missing = requiredInputFiles(options).filter(
    (filename) => !existsSync(resolve(options.workdir, filename)),
  );
  if (missing.length > 0) {
    fail(
      `Missing required autofix input file(s) in ${options.workdir}: ${missing.join(
        ', ',
      )}`,
    );
  }
}

function failureMessage(status, mode, result) {
  if (result.error) {
    return `Qwen failed to start during ${mode}: ${result.error.message}.`;
  }
  if (result.signal) {
    return `Qwen exited after signal ${result.signal} during ${mode}.`;
  }
  return `Qwen exited with status ${status} during ${mode}.`;
}

function writeFailure(options, message) {
  if (!options.workdir) {
    return;
  }
  mkdirSync(options.workdir, { recursive: true });
  writeFileSync(
    resolve(options.workdir, 'failure.md'),
    `${message}\n\nSee the Qwen Autofix agent step logs for model/tool output.\n`,
  );
}

const options = parseArgs(process.argv.slice(2));
if (options.checkInputs) {
  checkInputs(options);
}

let prompt;
try {
  prompt = buildPrompt(options.skillPath, options.invocation, options.mode);
} catch (error) {
  fail(error.message);
}

if (options.printPrompt) {
  process.stdout.write(prompt);
  process.exit(0);
}

checkInputs(options);
const result = spawnSync(options.qwenBin, ['--yolo', '--prompt', prompt], {
  stdio: 'inherit',
});
const status = result.status ?? 1;
if (status !== 0 || result.error || result.signal) {
  const message = failureMessage(status, options.mode, result);
  writeFailure(options, message);
  console.error(message);
  process.exit(status);
}
