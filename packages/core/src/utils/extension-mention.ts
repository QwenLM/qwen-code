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

const DEFAULT_IGNORABLE_RE = /\p{Default_Ignorable_Code_Point}/gu;
const EXTENSION_OPENING_FENCE =
  '--- Extension: selected (untrusted third-party content) ---';
const EXTENSION_CLOSING_FENCE = '--- End Extension: selected ---';

/**
 * 把不可信扩展文本固定在 Markdown 引用层级内，同时移除能改变终端显示或
 * 隐藏分隔符字符的控制码。分隔符保持在顶层，因此扩展内容无法自行结束区块。
 */
function quoteUntrustedExtensionText(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .replace(/[\u2028\u2029]/g, '\n')
    .split('\n')
    .map(
      (line) =>
        `> ${stripTerminalControlSequences(line).replace(DEFAULT_IGNORABLE_RE, '')}`,
    )
    .join('\n');
}

export function sanitizeDisplayText(raw: string): string | null {
  const stripped = stripTerminalControlSequences(raw)
    .replace(DEFAULT_IGNORABLE_RE, '')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped.length > 0 ? stripped : null;
}

export function getSanitizedExtensionDisplayName(extension: Extension): string {
  return (
    sanitizeDisplayText(extension.displayName || extension.name) ??
    sanitizeDisplayText(extension.name) ??
    'unnamed extension'
  );
}

export function buildExtensionContextText(extension: Extension): string {
  const displayName = getSanitizedExtensionDisplayName(extension);
  const lines: string[] = [`Extension: ${displayName}`];
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
      .map((s) => sanitizeDisplayText(s.name) ?? 'unnamed')
      .join(', ');
    capabilities.push(`- Skills: ${skillNames} (invoke via /<skill-name>)`);
  }

  if (extension.mcpServers && Object.keys(extension.mcpServers).length > 0) {
    const serverNames = Object.keys(extension.mcpServers)
      .map((n) => sanitizeDisplayText(n) ?? 'unnamed')
      .join(', ');
    capabilities.push(`- MCP Servers: ${serverNames}`);
  }

  if (extension.agents && extension.agents.length > 0) {
    const agentNames = extension.agents
      .map((a) => sanitizeDisplayText(a.name) ?? 'unnamed')
      .join(', ');
    capabilities.push(`- Agents: ${agentNames}`);
  }

  if (capabilities.length > 0) {
    lines.push('Available capabilities from this extension:');
    lines.push(...capabilities);
    lines.push('');
  }

  return [
    EXTENSION_OPENING_FENCE,
    quoteUntrustedExtensionText(lines.join('\n')),
    EXTENSION_CLOSING_FENCE,
  ].join('\n');
}

export async function buildExtensionMentionContext(
  extension: Extension,
  options: {
    remainingBudget: number;
    /** Fail instead of truncating context files retained by the loader. */
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
      throw new Error(
        `Extension '${getSanitizedExtensionDisplayName(extension)}' metadata needs ${contextText.length} characters, but only ${options.remainingBudget} remain in the shared context budget.`,
      );
  }

  if (extension.contextFiles.length === 0) {
    return { text: contextText, remainingBudget };
  }

  const closingFence = EXTENSION_CLOSING_FENCE;
  const appendInsideFence = (text: string, content: string): string => {
    const prefix = text.slice(0, -closingFence.length);
    const separator = prefix.endsWith('\n\n') ? '' : '\n';
    return `${prefix}${separator}${content}\n\n${closingFence}`;
  };

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
    const contextFilePath = extension.contextFiles[i];
    if (options.strict) {
      if (content.length > EXTENSION_CONTEXT_FILE_CAP) {
        throw new Error(
          `Extension context file '${contextFilePath}' has ${content.length} characters, exceeding the ${EXTENSION_CONTEXT_FILE_CAP}-character file cap.`,
        );
      }
      const nextText = appendInsideFence(
        contextText,
        quoteUntrustedExtensionText(content),
      );
      const addedLength = nextText.length - contextText.length;
      if (addedLength > remainingBudget) {
        throw new Error(
          `Extension context file '${contextFilePath}' needs ${addedLength} characters, but only ${remainingBudget} remain in the shared context budget.`,
        );
      }
      contextText = nextText;
      remainingBudget -= addedLength;
      continue;
    }
    if (remainingBudget <= 0) {
      options.onDebugMessage?.(
        'Extension context budget exhausted, skipping remaining files.',
      );
      break;
    }
    const cap = Math.min(EXTENSION_CONTEXT_FILE_CAP, remainingBudget);
    const quotedContent = quoteUntrustedExtensionText(content);
    const truncationMarker = '\n> ... (truncated)';
    const cappedContent =
      quotedContent.length > cap
        ? cap > truncationMarker.length
          ? quotedContent.slice(0, cap - truncationMarker.length) +
            truncationMarker
          : quotedContent.slice(0, cap)
        : quotedContent;
    contextText = appendInsideFence(contextText, cappedContent);
    remainingBudget -= cappedContent.length;
  }

  return { text: contextText, remainingBudget };
}
