/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import type { Extension } from '@qwen-code/qwen-code-core';
import {
  getErrorMessage,
  isSubpath,
  stripTerminalControlSequences,
} from '@qwen-code/qwen-code-core';

export const EXTENSION_REF_PREFIX = 'ext:';
export const EXTENSION_CONTEXT_BUDGET = 200_000;
export const EXTENSION_CONTEXT_FILE_CAP = 50_000;

/**
 * Parses an `ext:<name>` reference string. Returns the extension name
 * portion if the input starts with the extension prefix, or `null` otherwise.
 */
export function parseExtensionRef(pathName: string): { name: string } | null {
  if (!pathName.startsWith(EXTENSION_REF_PREFIX)) return null;
  const name = pathName.slice(EXTENSION_REF_PREFIX.length);
  if (!name) return null;
  return { name };
}

export function buildExtensionRef(extensionName: string): string {
  return `${EXTENSION_REF_PREFIX}${extensionName}`;
}

export function matchExtensionByRef(
  name: string,
  extensions: Extension[],
): Extension | undefined {
  const lower = name.toLowerCase();
  return extensions.find(
    (ext) =>
      ext.name.toLowerCase() === lower ||
      ext.config.name.toLowerCase() === lower,
  );
}

const BIDI_CONTROL_RE = /[‎‏؜⁦⁧⁨⁩‪‫‬‭‮]/g;

export function sanitizeDisplayText(raw: string): string | null {
  const stripped = stripTerminalControlSequences(raw)
    .replace(BIDI_CONTROL_RE, '')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped.length > 0 ? stripped : null;
}

export function getExtensionDisplayName(extension: Extension): string {
  return (
    sanitizeDisplayText(extension.displayName || extension.name) ||
    extension.name
  );
}

export function buildExtensionContextText(extension: Extension): string {
  const displayName = getExtensionDisplayName(extension);
  const lines: string[] = [];

  lines.push(
    `--- Extension: ${displayName} (untrusted third-party content) ---`,
  );
  if (extension.config.description) {
    const desc = sanitizeDisplayText(extension.config.description);
    if (desc) {
      lines.push(desc);
      lines.push('');
    }
  }

  const capabilities: string[] = [];

  if (extension.skills && extension.skills.length > 0) {
    const skillNames = extension.skills
      .map((s) => sanitizeDisplayText(s.name) || s.name)
      .join(', ');
    capabilities.push(`- Skills: ${skillNames} (invoke via /<skill-name>)`);
  }

  if (extension.mcpServers && Object.keys(extension.mcpServers).length > 0) {
    const serverNames = Object.keys(extension.mcpServers)
      .map((n) => sanitizeDisplayText(n) || n)
      .join(', ');
    capabilities.push(`- MCP Servers: ${serverNames}`);
  }

  if (extension.agents && extension.agents.length > 0) {
    const agentNames = extension.agents
      .map((a) => sanitizeDisplayText(a.name) || a.name)
      .join(', ');
    capabilities.push(`- Agents: ${agentNames}`);
  }

  if (capabilities.length > 0) {
    lines.push('Available capabilities from this extension:');
    lines.push(...capabilities);
    lines.push('');
  }

  lines.push(`--- End Extension: ${displayName} ---`);

  return lines.join('\n');
}

export async function buildExtensionMentionContext(
  extension: Extension,
  options: {
    remainingBudget: number;
    signal?: AbortSignal;
    onDebugMessage?: (message: string) => void;
  },
): Promise<{ text: string; remainingBudget: number }> {
  let contextText = buildExtensionContextText(extension);
  let remainingBudget = options.remainingBudget;

  if (extension.contextFiles.length === 0) {
    return { text: contextText, remainingBudget };
  }

  const fileReads = await Promise.allSettled(
    extension.contextFiles.map(async (contextFilePath) => {
      let realPath: string;
      let realExtPath: string;
      try {
        realPath = await fs.realpath(contextFilePath);
        realExtPath = await fs.realpath(extension.path);
      } catch {
        options.onDebugMessage?.(
          `Skipping unreadable context file: ${contextFilePath}`,
        );
        return null;
      }
      if (!isSubpath(realExtPath, realPath)) {
        options.onDebugMessage?.(
          `Skipping context file outside extension directory: ${contextFilePath}`,
        );
        return null;
      }
      return fs.readFile(realPath, {
        encoding: 'utf-8',
        signal: options.signal,
      });
    }),
  );

  for (let i = 0; i < fileReads.length; i++) {
    const outcome = fileReads[i];
    if (outcome.status === 'rejected') {
      options.onDebugMessage?.(
        `Failed to read extension context file ${extension.contextFiles[i]}: ${getErrorMessage(outcome.reason)}`,
      );
      continue;
    }
    const content = outcome.value;
    if (!content || !content.trim()) continue;
    if (remainingBudget <= 0) {
      options.onDebugMessage?.(
        'Extension context budget exhausted, skipping remaining files.',
      );
      break;
    }
    const cap = Math.min(EXTENSION_CONTEXT_FILE_CAP, remainingBudget);
    const cappedContent =
      content.length > cap
        ? content.slice(0, cap) + '\n... (truncated)'
        : content;
    contextText += `\n\n${cappedContent}`;
    remainingBudget -= cappedContent.length;
  }

  return { text: contextText, remainingBudget };
}
