#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const invocation = process.argv.slice(2).join(' ').trim();
if (!invocation) {
  console.error('Usage: build-autofix-prompt.mjs <autofix invocation>');
  process.exit(1);
}

const skillPath = resolve('.qwen/skills/autofix/SKILL.md');
const skillText = readFileSync(skillPath, 'utf8').replace(/\r\n/g, '\n');
const match = /^---\n[\s\S]*?\n---(?:\n|$)([\s\S]*)$/.exec(skillText);

if (!match) {
  console.error(`${skillPath} is missing YAML frontmatter.`);
  process.exit(1);
}

const body = match[1].trim();

process.stdout.write(
  [
    `Base directory for this skill: ${dirname(skillPath)}`,
    'Important: ALWAYS resolve absolute paths from this base directory when working with skills.',
    '',
    body,
    '',
    'Invocation:',
    invocation,
    '',
  ].join('\n'),
);
