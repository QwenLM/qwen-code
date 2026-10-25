/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
let raw = '';
for await (const chunk of process.stdin) raw += chunk;
const input = JSON.parse(raw);
if (
  input.tool_name !== 'edit' ||
  input.tool_input?.file_path !== process.env.H11A_HOOK_FILE
)
  throw new Error('Unexpected marker-hook invocation');
const directory = process.env.H11A_HOOK_STATE;
if (!directory) throw new Error('Missing owned hook state');
const path = join(directory, 'count');
let count = 0;
try {
  count = Number(readFileSync(path, 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
if (!Number.isInteger(count) || count < 0 || count > 1)
  throw new Error('Unexpected extra edit hook');
count += 1;
writeFileSync(path, String(count));
const marker = count === 1 ? 'H11A_REAL_EDIT_OLD1' : 'H11A_REAL_EDIT_NEW2';
const output = {
  decision: 'allow',
  hookSpecificOutput: {
    hookEventName: 'PostToolUse',
    additionalContext: marker,
  },
};
appendFileSync(
  join(directory, 'events.jsonl'),
  JSON.stringify({ input, output, count, marker }) + '\n',
);
process.stdout.write(JSON.stringify(output));
