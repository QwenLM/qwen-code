/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview `/debug` bundled skill — enables debug logging at runtime,
 * reads the tail of the debug log, and generates a diagnostic prompt to
 * help the model analyze errors and warnings.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { runLogger } from '../../utils/runLogger.js';
import { BRAND_CLI_NAME } from '../../config/brand.js';
import {
  CONFIG_DIR,
  getUserConfigDisplayPath,
} from '../../utils/paths.js';
import type { BundledSkillRegistrar } from './index.js';
import {
  READ_FILE_TOOL_NAME,
  GREP_TOOL_NAME,
  GLOB_TOOL_NAME,
} from '../../tools/tool-names.js';

/** Number of trailing log lines to show in the diagnostic prompt. */
const DEFAULT_DEBUG_LINES_READ = 20;

/** Maximum bytes to read from the end of the log file. */
const TAIL_READ_BYTES = 64 * 1024;

/**
 * Read the last N lines from a file by reading up to TAIL_READ_BYTES
 * from the end and splitting by newlines.
 */
async function readLogTail(
  logPath: string,
  lineCount: number,
): Promise<string> {
  const stats = await fs.stat(logPath);
  const readSize = Math.min(stats.size, TAIL_READ_BYTES);
  const startOffset = stats.size - readSize;
  const fh = await fs.open(logPath, 'r');
  try {
    const buffer = Buffer.alloc(readSize);
    const { bytesRead } = await fh.read(buffer, 0, readSize, startOffset);
    return buffer
  .toString('utf-8', 0, bytesRead)
  .split('\n')
  .slice(-lineCount)
  .join('\n');
  } finally {
    await fh.close();
  }
}

const getTips = () =>
  `If you need help with ${BRAND_CLI_NAME} features, settings, or capabilities, use an available
CLI guide agent (listed under the session's available agents) or consult the official documentation.`;

async function buildDebugSkillBody(
  args?: string,
  context?: { skillDir: string; sessionId: string },
): Promise<string> {
  const sessionId = context?.sessionId ?? '';
  const wasAlreadyLogging = runLogger.enableDebugLogging(sessionId);
  const debugLogPath = runLogger.getDebugLogPath();

  // Build log info section
  let logInfo: string;
  if (!debugLogPath) {
    logInfo = 'Debug logging could not be enabled — no log path available.';
  } else {
    try {
      const stats = await fs.stat(debugLogPath);
      const tail = await readLogTail(
        debugLogPath,
        DEFAULT_DEBUG_LINES_READ,
      );
      logInfo = `Log size: ${stats.size} bytes\n\n### Last ${DEFAULT_DEBUG_LINES_READ} lines\n\n\`\`\`\n${tail}\n\`\`\``;
    } catch {
      logInfo = 'No debug log exists yet — logging was just enabled.';
    }
  }

  // If logging was just enabled, tell the model so it can inform the user
  const justEnabledSection = wasAlreadyLogging
    ? ''
    : `
## Debug Logging Just Enabled

Debug logging was OFF for this session until now. Nothing prior to this /debug invocation was captured.

Tell the user that debug logging is now active at \`${debugLogPath}\`, ask them to reproduce the issue, then re-read the log.
`;

  const globalSettings = getUserConfigDisplayPath('settings.json');
  const projectSettings = path.join(CONFIG_DIR, 'settings.json');

  return `# Debug Skill

Help the user debug an issue they're encountering in this session.
${justEnabledSection}
## Session Debug Log

The debug log for the current session is at: \`${debugLogPath}\`

${logInfo}

For additional context, grep for [ERROR] and [WARN] lines across the full file.

## Issue Description

${args || 'The user did not describe a specific issue. Read the debug log and summarize any errors, warnings, or notable issues.'}

## Settings

Remember that settings are in:
* user - ${globalSettings}
* project - ${projectSettings}

## Tips

${getTips()}

## Instructions

1. Review the user's issue description
2. The last ${DEFAULT_DEBUG_LINES_READ} lines show the debug file format. Look for [ERROR] and [WARN] entries, stack traces, and failure patterns
3. Explain what you found in plain language
4. Suggest concrete fixes or next steps
`;
}

export function registerDebugSkill(registrar: BundledSkillRegistrar): void {
  registrar.registerBundledSkill({
    name: 'debug',
    description:
      'Enable debug logging for this session and help diagnose issues.',
    allowedTools: [READ_FILE_TOOL_NAME, GREP_TOOL_NAME, GLOB_TOOL_NAME],
    argumentHint: '[issue description]',
    disableModelInvocation: true,
    userInvocable: true,
    location: 'bundled',
    body: '',
    getBody: buildDebugSkillBody,
  });
}
