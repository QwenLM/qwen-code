/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fsPromises from 'fs/promises';
import path from 'path';
import {
  type SlashCommand,
  CommandKind,
  type SlashCommandActionReturn,
} from './types.js';
import {
  getProjectSummaryPrompt,
  isSubpath,
  resolvePath,
  runSideQuery,
} from '@qwen-code/qwen-code-core';
import type { HistoryItemSummary } from '../types.js';
import { t } from '../../i18n/index.js';

// Resolves the real path of the nearest existing ancestor of targetPath. The
// target file itself usually does not exist yet, but a symlinked parent
// directory can still point outside the project root, so the ancestor must be
// resolved to detect that. Unlike the realpathNearestExisting copies in
// exportCommand.ts/statsCommand.ts, this one does not guard the upward walk
// itself (they loop while isSubpath(cwd, currentPath) and throw on escape);
// every call site here must check containment on the returned path.
const realpathNearestExisting = async (targetPath: string): Promise<string> => {
  let currentPath = targetPath;
  for (;;) {
    try {
      return await fsPromises.realpath(currentPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
      const parentPath = path.dirname(currentPath);
      if (parentPath === currentPath) {
        return currentPath;
      }
      currentPath = parentPath;
    }
  }
};

// Follows the full symlink chain at filePath (with cycle detection) and
// verifies the final target is contained within realProjectRoot. A broken
// chain whose terminal target is absent still resolves via
// realpathNearestExisting, catching multi-hop escapes.
const assertLeafNotSymlinkEscape = async (
  filePath: string,
  realProjectRoot: string,
): Promise<void> => {
  let current = filePath;
  const seen = new Set<string>();
  for (;;) {
    const linkStat = await fsPromises.lstat(current).catch(() => null);
    if (!linkStat?.isSymbolicLink()) break;
    if (seen.has(current)) {
      throw new Error(t('Summary path must be within the project root.'));
    }
    seen.add(current);
    const linkTarget = await fsPromises.readlink(current);
    current = path.isAbsolute(linkTarget)
      ? linkTarget
      : path.resolve(path.dirname(current), linkTarget);
  }
  const realTarget = await realpathNearestExisting(current);
  if (!isSubpath(realProjectRoot, realTarget)) {
    throw new Error(t('Summary path must be within the project root.'));
  }
};

// Static footer prefix shared by the writer (saveSummaryToDisk) and the
// detector below, kept in one place so the two cannot drift apart.
const SUMMARY_FOOTER_PREFIX = '\n---\n\n## Summary Metadata\n**Update time**: ';

const buildSummaryFooter = (timestamp: string): string =>
  `${SUMMARY_FOOTER_PREFIX}${timestamp}\n`;

// Reads only the file tail: the footer always lives in the last ~90 bytes, so
// a mistyped multi-GB path is not loaded fully into memory just to test for it.
const readSummaryTail = async (p: string, bytes = 4096): Promise<string> => {
  const handle = await fsPromises.open(p, 'r');
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, Math.max(0, size - length));
    return buffer.toString('utf8');
  } finally {
    await handle.close();
  }
};

// Built from the same prefix the writer emits (escaped so the literal `**` is
// not read as a quantifier) and anchored to end-of-file, so a document that
// merely embeds a sample footer is not mistaken for a generated summary and
// clobbered.
const isGeneratedSummary = (content: string): boolean =>
  new RegExp(
    `${SUMMARY_FOOTER_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\n]*\\n?$`,
  ).test(content.replace(/\r\n/g, '\n'));

export const summaryCommand: SlashCommand = {
  name: 'summary',
  get description() {
    return t(
      'Generate a project summary and save it to .qwen/PROJECT_SUMMARY.md',
    );
  },
  argumentHint: '[path]',
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive', 'non_interactive', 'acp'] as const,
  action: async (context, args): Promise<SlashCommandActionReturn> => {
    const { config } = context.services;
    const { ui } = context;
    const executionMode = context.executionMode ?? 'interactive';
    const abortSignal = context.abortSignal;

    if (!config) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('Config not loaded.'),
      };
    }

    const llmClient = config.getLlmClient();
    if (!llmClient) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('No chat client available to generate summary.'),
      };
    }

    // Check if already generating summary (interactive UI only)
    if (executionMode === 'interactive' && ui.pendingItem) {
      ui.addItem(
        {
          type: 'error' as const,
          text: t(
            'Already generating summary, wait for previous request to complete',
          ),
        },
        Date.now(),
      );
      return {
        type: 'message',
        messageType: 'error',
        content: t(
          'Already generating summary, wait for previous request to complete',
        ),
      };
    }

    const getChatHistory = () => {
      const chat = llmClient.getChat();
      return chat.getHistoryShallow();
    };

    const validateChatHistory = (
      history: ReturnType<typeof getChatHistory>,
    ) => {
      if (history.length <= 2) {
        throw new Error(t('No conversation found to summarize.'));
      }
    };

    const generateSummaryMarkdown = async (
      history: ReturnType<typeof getChatHistory>,
    ): Promise<string> => {
      // Build the conversation context for summary generation
      const conversationContext = history.map((message) => ({
        role: message.role,
        parts: message.parts,
      }));

      // Carry over the main session's system instruction. Without this the
      // model sees only chat history + the summary prompt, losing the coding-
      // assistant role, project context, and user memory. The chat sets it
      // as a string (see LlmClient.getMainSessionSystemInstruction).
      const rawSystemInstruction = llmClient
        .getChat()
        .getGenerationConfig().systemInstruction;
      const chatSystemInstruction =
        typeof rawSystemInstruction === 'string'
          ? rawSystemInstruction
          : undefined;

      const result = await runSideQuery(config, {
        purpose: 'project-summary',
        skipOutputLanguagePreference: true,
        model: config.getModel(),
        systemInstruction: chatSystemInstruction,
        contents: [
          ...conversationContext,
          {
            role: 'user',
            parts: [
              {
                text: getProjectSummaryPrompt(),
              },
            ],
          },
        ],
        abortSignal: abortSignal ?? new AbortController().signal,
      });

      if (!result.text) {
        throw new Error(
          t(
            'Failed to generate summary - no text content received from LLM response',
          ),
        );
      }

      return result.text;
    };

    const resolveSummaryTarget = async (): Promise<{
      summaryPath: string;
      filePathForDisplay: string;
      isDefaultTarget: boolean;
      realProjectRoot: string;
    }> => {
      const projectRoot = config.getProjectRoot();
      const defaultSummaryPath = path.join(
        projectRoot,
        '.qwen',
        'PROJECT_SUMMARY.md',
      );
      const customPath = args?.trim();

      if (!customPath) {
        // The default target always overwrites: regenerating the summary is
        // the command's purpose, and .qwen/PROJECT_SUMMARY.md is a generated
        // artifact — not user prose the overwrite guard protects.
        return {
          summaryPath: defaultSummaryPath,
          filePathForDisplay: '.qwen/PROJECT_SUMMARY.md',
          isDefaultTarget: true,
          realProjectRoot: await fsPromises.realpath(projectRoot),
        };
      }

      // resolvePath expands a leading ~ so the path is honest before the
      // containment check rejects it, instead of creating a literal "~" dir.
      const resolved = resolvePath(projectRoot, customPath);

      if (!isSubpath(projectRoot, resolved)) {
        throw new Error(t('Summary path must be within the project root.'));
      }

      // A lexical check cannot see through symlinks: a link inside the project
      // root may point outside it. Re-check containment on the real paths.
      const realProjectRoot = await fsPromises.realpath(projectRoot);

      await assertLeafNotSymlinkEscape(resolved, realProjectRoot);

      const realResolved = await realpathNearestExisting(resolved);
      if (!isSubpath(realProjectRoot, realResolved)) {
        throw new Error(t('Summary path must be within the project root.'));
      }

      const hasTrailingSep =
        customPath.endsWith('/') || customPath.endsWith(path.sep);
      const resolvedStat = await fsPromises.stat(resolved).catch(() => null);
      if (hasTrailingSep && resolvedStat?.isFile()) {
        throw new Error(
          t(
            'Summary path ends with a separator but is an existing file: {{path}}',
            { path: customPath },
          ),
        );
      }
      const isDir = hasTrailingSep || (resolvedStat?.isDirectory() ?? false);

      const summaryPath = isDir
        ? path.join(resolved, 'PROJECT_SUMMARY.md')
        : resolved;

      // The appended filename may itself be a symlink escaping the project
      // root (e.g. a malicious repo tracks docs/PROJECT_SUMMARY.md -> /etc/
      // passwd). Re-check the leaf after the join.
      if (isDir) {
        await assertLeafNotSymlinkEscape(summaryPath, realProjectRoot);
      }

      const filePathForDisplay = (
        path.isAbsolute(customPath)
          ? summaryPath
          : path.relative(projectRoot, summaryPath)
      ).replaceAll(path.sep, '/');

      // Compute the default-target flag before the guards so an explicitly
      // spelled default path (`.qwen/PROJECT_SUMMARY.md` or `.qwen/`) is
      // treated as the default target for the overwrite guard and always
      // overwrites. Unlike the no-arg command, a spelled path still runs the
      // custom-path symlink containment checks.
      const isDefaultTarget = summaryPath === defaultSummaryPath;

      const existingStat = await fsPromises.stat(summaryPath).catch(() => null);

      // Reject an existing directory at the leaf (e.g. `/summary docs` where
      // docs/PROJECT_SUMMARY.md is itself a directory) before the LLM call,
      // instead of surfacing a raw EISDIR only at write time.
      if (existingStat?.isDirectory()) {
        throw new Error(
          t('Summary path resolves to an existing directory: {{path}}', {
            path: filePathForDisplay,
          }),
        );
      }

      // For any non-default path, refuse to clobber a pre-existing file that is
      // not a generated summary (e.g. a mistyped `package.json`). A generated
      // summary carries a `## Summary Metadata` footer, so regenerating one is
      // allowed.
      if (!isDefaultTarget && existingStat?.isFile() && existingStat.size > 0) {
        const existing = await readSummaryTail(summaryPath).catch(() => '');
        if (!isGeneratedSummary(existing)) {
          throw new Error(
            t(
              'Summary path already exists and is not a generated summary: {{path}}',
              { path: filePathForDisplay },
            ),
          );
        }
      }

      return {
        summaryPath,
        filePathForDisplay,
        isDefaultTarget,
        realProjectRoot,
      };
    };

    const saveSummaryToDisk = async (
      markdownSummary: string,
      target: {
        summaryPath: string;
        filePathForDisplay: string;
        isDefaultTarget: boolean;
        realProjectRoot: string;
      },
    ): Promise<{
      filePathForDisplay: string;
      fullPath: string;
    }> => {
      const summaryContent = `${markdownSummary}\n${buildSummaryFooter(
        new Date().toISOString(),
      )}`;

      // Re-check the leaf right before writing to narrow the TOCTOU window
      // between resolveSummaryTarget (pre-LLM) and the write (post-LLM).
      // The default target is the user's own .qwen/ directory — a symlinked
      // .qwen/ is a deliberate setup, not an attack vector.
      if (!target.isDefaultTarget) {
        await assertLeafNotSymlinkEscape(
          target.summaryPath,
          target.realProjectRoot,
        );
      }

      const preWriteStat = await fsPromises
        .stat(target.summaryPath)
        .catch(() => null);

      // Re-run the overwrite guard: a file created during generation (the
      // slow step) would otherwise be silently destroyed.
      if (
        !target.isDefaultTarget &&
        preWriteStat?.isFile() &&
        preWriteStat.size > 0
      ) {
        const existing = await readSummaryTail(target.summaryPath).catch(
          () => '',
        );
        if (!isGeneratedSummary(existing)) {
          throw new Error(
            t(
              'Summary path already exists and is not a generated summary: {{path}}',
              { path: target.filePathForDisplay },
            ),
          );
        }
      }

      await fsPromises.mkdir(path.dirname(target.summaryPath), {
        recursive: true,
        ...(target.isDefaultTarget ? { mode: 0o700 } : {}),
      });
      // writeFile's mode applies at creation; for an existing file the user may
      // have relaxed, the mode argument is ignored and permissions are kept.
      await fsPromises.writeFile(target.summaryPath, summaryContent, {
        encoding: 'utf8',
        mode: 0o600,
      });

      return {
        filePathForDisplay: target.filePathForDisplay,
        fullPath: target.summaryPath,
      };
    };

    const emitInteractivePending = (stage: 'generating' | 'saving') => {
      if (executionMode !== 'interactive') {
        return;
      }
      const pendingMessage: HistoryItemSummary = {
        type: 'summary',
        summary: {
          isPending: true,
          stage,
        },
      };
      ui.setPendingItem(pendingMessage);
    };

    const completeInteractive = (filePathForDisplay: string) => {
      if (executionMode !== 'interactive') {
        return;
      }
      ui.setPendingItem(null);
      const completedSummaryItem: HistoryItemSummary = {
        type: 'summary',
        summary: {
          isPending: false,
          stage: 'completed',
          filePath: filePathForDisplay,
        },
      };
      ui.addItem(completedSummaryItem, Date.now());
    };

    const formatErrorMessage = (error: unknown): string =>
      t('Failed to generate project context summary: {{error}}', {
        error: error instanceof Error ? error.message : String(error),
      });

    const failInteractive = (error: unknown) => {
      if (executionMode !== 'interactive') {
        return;
      }
      // If cancelled via ESC, don't show error — cancelSlashCommand already handled UI
      if (abortSignal?.aborted) {
        return;
      }
      ui.setPendingItem(null);
      ui.addItem(
        {
          type: 'error' as const,
          text: `✗ ${formatErrorMessage(error)}`,
        },
        Date.now(),
      );
    };

    const formatSuccessMessage = (filePathForDisplay: string): string =>
      t('Saved project summary to {{filePathForDisplay}}.', {
        filePathForDisplay,
      });

    const returnNoConversationMessage = (): SlashCommandActionReturn => {
      const msg = t('No conversation found to summarize.');
      if (executionMode === 'acp') {
        const messages = async function* () {
          yield {
            messageType: 'info' as const,
            content: msg,
          };
        };
        return {
          type: 'stream_messages',
          messages: messages(),
        };
      }
      return {
        type: 'message',
        messageType: 'info',
        content: msg,
      };
    };

    const executeSummaryGeneration = async (
      history: ReturnType<typeof getChatHistory>,
    ): Promise<{
      markdownSummary: string;
      filePathForDisplay: string;
    }> => {
      const target = await resolveSummaryTarget();
      emitInteractivePending('generating');
      const markdownSummary = await generateSummaryMarkdown(history);
      if (abortSignal?.aborted) {
        throw new DOMException('Summary generation cancelled.', 'AbortError');
      }
      emitInteractivePending('saving');
      const { filePathForDisplay } = await saveSummaryToDisk(
        markdownSummary,
        target,
      );
      completeInteractive(filePathForDisplay);
      return { markdownSummary, filePathForDisplay };
    };

    // Validate chat history once at the beginning
    const history = getChatHistory();
    try {
      validateChatHistory(history);
    } catch (_error) {
      return returnNoConversationMessage();
    }

    if (executionMode === 'acp') {
      const messages = async function* () {
        try {
          yield {
            messageType: 'info' as const,
            content: t('Generating project summary...'),
          };

          const { filePathForDisplay } =
            await executeSummaryGeneration(history);

          yield {
            messageType: 'info' as const,
            content: formatSuccessMessage(filePathForDisplay),
          };
        } catch (error) {
          failInteractive(error);
          yield {
            messageType: 'error' as const,
            content: formatErrorMessage(error),
          };
        }
      };

      return {
        type: 'stream_messages',
        messages: messages(),
      };
    }

    try {
      const { filePathForDisplay } = await executeSummaryGeneration(history);

      if (executionMode === 'non_interactive') {
        return {
          type: 'message',
          messageType: 'info',
          content: formatSuccessMessage(filePathForDisplay),
        };
      }

      // Interactive mode: UI components already display progress and completion.
      return {
        type: 'message',
        messageType: 'info',
        content: '',
      };
    } catch (error) {
      failInteractive(error);

      return {
        type: 'message',
        messageType: 'error',
        content:
          executionMode === 'interactive' ? '' : formatErrorMessage(error),
      };
    }
  },
};
