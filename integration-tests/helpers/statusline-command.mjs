/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import process from 'node:process';

const [log, control] = process.argv.slice(2);
let raw = '';
for await (const chunk of process.stdin) raw += chunk;
const input = JSON.parse(raw);
const { phase } = JSON.parse(readFileSync(control, 'utf8'));
const started = execFileSync(
  'ps',
  ['-p', String(process.pid), '-o', 'lstart='],
  {
    encoding: 'utf8',
  },
).trim();
appendFileSync(
  log,
  JSON.stringify({ pid: process.pid, started, input }) + '\n',
);
process.stdout.write(
  `\x1b[38;2;197;37;83mSTATUS_COLOR_${phase}\x1b[0m\n` +
    `STATUS_SECOND_${phase} in=${input.context_window.total_input_tokens} out=${input.context_window.total_output_tokens}\n` +
    'STATUS_MUST_CLIP\n',
);
