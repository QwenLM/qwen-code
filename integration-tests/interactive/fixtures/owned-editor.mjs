#!/usr/bin/env node
import {
  appendFileSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { setTimeout } from 'node:timers';

const file = process.argv.at(-1);
const controlPath = process.env['QWEN_U2B_EDITOR_CONTROL'];
const logPath = process.env['QWEN_U2B_EDITOR_LOG'];
if (!file || !controlPath || !logPath) process.exit(64);
const control = JSON.parse(readFileSync(controlPath, 'utf8'));
const before = readFileSync(file, 'utf8');
const record = (extra) =>
  appendFileSync(
    logPath,
    JSON.stringify({
      argv: process.argv.slice(2),
      file: resolve(file),
      realFile: realpathSync(file),
      mode: statSync(file).mode & 0o777,
      before,
      ...extra,
    }) + '\n',
  );
record({ phase: 'started', behavior: control.behavior });
process.stdout.write('OWNED_EDITOR_TERMINAL\n');
if (control.behavior === 'nonzero') process.exit(7);
if (control.behavior === 'signal') process.kill(process.pid, 'SIGTERM');
if (control.behavior === 'delay')
  await new Promise((done) => setTimeout(done, 750));
if (control.behavior !== 'unchanged')
  writeFileSync(file, control.output ?? 'EDITOR_RESULT_甲🙂\r\nNEXT', 'utf8');
record({ phase: 'finished', after: readFileSync(file, 'utf8') });
