/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

function definitionFiles(pattern) {
  return execFileSync(
    'git',
    ['grep', '--untracked', '-l', '-E', pattern, '--', 'packages'],
    { cwd: root, encoding: 'utf8' },
  )
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);
}

const definitions = [
  {
    symbol: 'LIVE_TASK_TOOL_NAMES',
    pattern: '^(export )?(const|let|var) LIVE_TASK_TOOL_NAMES[[:space:]]*[:=]',
    owner: 'packages/acp-bridge/src/bridgeOptions.ts',
  },
  {
    symbol: 'LiveTaskToolName',
    pattern:
      '^(export )?type LiveTaskToolName[[:space:]]*(<[^>]+>)?[[:space:]]*=',
    owner: 'packages/acp-bridge/src/bridgeOptions.ts',
  },
  {
    symbol: 'MAX_SUB_SESSION_PROMPT_CHARS',
    pattern:
      '^(export )?(const|let|var) MAX_SUB_SESSION_PROMPT_CHARS[[:space:]]*[:=]',
    owner: 'packages/core/src/tools/sub-session-constants.ts',
  },
];

it.each(definitions)('$symbol has one owner', ({ pattern, owner }) => {
  expect(definitionFiles(pattern)).toEqual([owner]);
});

const imports = [
  [
    'LIVE_TASK_TOOL_NAMES',
    'packages/acp-bridge/src/bridgeClient.ts',
    './bridgeOptions.js',
  ],
  [
    'LIVE_TASK_TOOL_NAMES',
    'packages/cli/src/acp-integration/live/live-task-tools.ts',
    '@qwen-code/acp-bridge/bridgeOptions',
  ],
  [
    'LIVE_TASK_TOOL_NAMES',
    'packages/cli/src/serve/live/live-task-service.ts',
    '@qwen-code/acp-bridge/bridgeOptions',
  ],
  [
    'LiveTaskToolName',
    'packages/cli/src/acp-integration/live/live-task-tools.ts',
    '@qwen-code/acp-bridge/bridgeOptions',
  ],
  [
    'LiveTaskToolName',
    'packages/cli/src/serve/live/live-task-service.ts',
    '@qwen-code/acp-bridge/bridgeOptions',
  ],
  [
    'MAX_SUB_SESSION_PROMPT_CHARS',
    'packages/core/src/tools/create-sub-session.ts',
    './sub-session-constants.js',
  ],
  [
    'MAX_SUB_SESSION_PROMPT_CHARS',
    'packages/acp-bridge/src/bridgeOptions.ts',
    '@qwen-code/qwen-code-core/subSessionConstants',
  ],
  [
    'MAX_SUB_SESSION_PROMPT_CHARS',
    'packages/acp-bridge/src/bridgeClient.ts',
    './bridgeOptions.js',
  ],
];

it.each(imports)('%s is imported by %s', (symbol, path, source) => {
  const text = readFileSync(join(root, path), 'utf8');
  const escapedSource = source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const statements =
    text.replace(/\/\/.*$/gm, '').match(/^import[\s\S]*?;$/gm) ?? [];
  expect(
    statements.some(
      (statement) =>
        new RegExp(`\\b${symbol}\\b`).test(statement) &&
        new RegExp(`from ['"]${escapedSource}['"]`).test(statement),
    ),
  ).toBe(true);
});

it('distinguishes locale resolution from prompt sanitization', () => {
  expect(
    definitionFiles('^export function getExtensionDisplayName[(]'),
  ).toEqual(['packages/core/src/extension/i18n.ts']);
  expect(
    definitionFiles('^export function getSanitizedExtensionDisplayName[(]'),
  ).toEqual(['packages/cli/src/utils/extension-mention.ts']);
});
