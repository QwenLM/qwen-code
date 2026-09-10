/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import type { Extension } from '../extension/extensionManager.js';
import { getErrorMessage } from './errors.js';
import { isSubpath } from './paths.js';
import { stripTerminalControlSequences } from './terminalSafe.js';

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

export function getSanitizedExtensionDisplayName(extension: Extension): string {
  return (
    sanitizeDisplayText(extension.displayName || extension.name) ||
    extension.name
  );
}

export function buildExtensionContextText(extension: Extension): string {
  const displayName = getSanitizedExtensionDisplayName(extension);
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
    /** 编排调用必须完整加载上下文，不能把缺失规则静默当作成功。 */
    strict?: boolean;
    signal?: AbortSignal;
    onDebugMessage?: (message: string) => void;
  },
): Promise<{ text: string; remainingBudget: number }> {
  if (options.strict) options.signal?.throwIfAborted();
  let contextText = buildExtensionContextText(extension);
  let remainingBudget = options.remainingBudget;
  if (options.strict) {
    remainingBudget -= contextText.length;
    if (remainingBudget < 0)
      throw new Error('Extension context exceeds the available budget.');
  }

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
        if (options.strict)
          throw new Error(
            `Unreadable extension context file: ${contextFilePath}`,
          );
        options.onDebugMessage?.(
          `Skipping unreadable context file: ${contextFilePath}`,
        );
        return null;
      }
      if (!isSubpath(realExtPath, realPath)) {
        if (options.strict)
          throw new Error(
            `Extension context file is outside its directory: ${contextFilePath}`,
          );
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

  if (options.strict) options.signal?.throwIfAborted();
  for (let i = 0; i < fileReads.length; i++) {
    const outcome = fileReads[i];
    if (outcome.status === 'rejected') {
      if (options.strict)
        throw new Error(
          `Failed to load extension context: ${getErrorMessage(outcome.reason)}`,
        );
      options.onDebugMessage?.(
        `Failed to read extension context file ${extension.contextFiles[i]}: ${getErrorMessage(outcome.reason)}`,
      );
      continue;
    }
    const content = outcome.value;
    if (!content || !content.trim()) continue;
    if (
      options.strict &&
      content.length > Math.min(EXTENSION_CONTEXT_FILE_CAP, remainingBudget - 2)
    ) {
      throw new Error(
        'Extension context exceeds the available budget or file cap.',
      );
    }
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
    remainingBudget -= cappedContent.length + (options.strict ? 2 : 0);
  }

  return { text: contextText, remainingBudget };
}
