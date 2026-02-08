/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { PartListUnion } from '@google/genai';
import type { Config } from '@qwen-code/qwen-code-core';
import {
  getErrorMessage,
  isNodeError,
  unescapePath,
  readManyFiles,
} from '@qwen-code/qwen-code-core';
import type {
  HistoryItemToolGroup,
  HistoryItemWithoutId,
  IndividualToolCallDisplay,
} from '../types.js';
import { ToolCallStatus } from '../types.js';

interface HandleAtCommandParams {
  query: string;
  config: Config;
  onDebugMessage: (message: string) => void;
  messageId: number;
  signal: AbortSignal;
  addItem?: (item: HistoryItemWithoutId, baseTimestamp: number) => number;
}

interface HandleAtCommandResult {
  processedQuery: PartListUnion | null;
  shouldProceed: boolean;
  toolDisplays?: IndividualToolCallDisplay[];
  filesRead?: string[];
}

interface AtCommandPart {
  type: 'text' | 'atPath';
  content: string;
}

/**
 * Parses a query string to find all '@<path>' commands and text segments.
 * Handles \ escaped spaces within paths.
 */
function parseAllAtCommands(query: string): AtCommandPart[] {
  const parts: AtCommandPart[] = [];
  let currentIndex = 0;

  while (currentIndex < query.length) {
    let atIndex = -1;
    let nextSearchIndex = currentIndex;
    // Find next unescaped '@'
    while (nextSearchIndex < query.length) {
      if (
        query[nextSearchIndex] === '@' &&
        (nextSearchIndex === 0 || query[nextSearchIndex - 1] !== '\\')
      ) {
        atIndex = nextSearchIndex;
        break;
      }
      nextSearchIndex++;
    }

    if (atIndex === -1) {
      // No more @
      if (currentIndex < query.length) {
        parts.push({ type: 'text', content: query.substring(currentIndex) });
      }
      break;
    }

    // Add text before @
    if (atIndex > currentIndex) {
      parts.push({
        type: 'text',
        content: query.substring(currentIndex, atIndex),
      });
    }

    // Parse @path
    let pathEndIndex = atIndex + 1;
    let inEscape = false;
    while (pathEndIndex < query.length) {
      const char = query[pathEndIndex];
      if (inEscape) {
        inEscape = false;
      } else if (char === '\\') {
        inEscape = true;
      } else if (/[,\s;!?()[\]{}]/.test(char)) {
        // Path ends at first whitespace or punctuation not escaped
        break;
      } else if (char === '.') {
        // For . we need to be more careful - only terminate if followed by whitespace or end of string
        // This allows file extensions like .txt, .js but terminates at sentence endings like "file.txt. Next sentence"
        const nextChar =
          pathEndIndex + 1 < query.length ? query[pathEndIndex + 1] : '';
        if (nextChar === '' || /\s/.test(nextChar)) {
          break;
        }
      }
      pathEndIndex++;
    }
    const rawAtPath = query.substring(atIndex, pathEndIndex);
    // unescapePath expects the @ symbol to be present, and will handle it.
    const atPath = unescapePath(rawAtPath);
    parts.push({ type: 'atPath', content: atPath });
    currentIndex = pathEndIndex;
  }
  // Filter out empty text parts that might result from consecutive @paths or leading/trailing spaces
  return parts.filter(
    (part) => !(part.type === 'text' && part.content.trim() === ''),
  );
}

/**
 * Processes user input potentially containing one or more '@<path>' commands.
 * If found, it attempts to read the specified files/directories using the
 * 'read_many_files' tool. The user query is modified to include resolved paths,
 * and the content of the files is appended in a structured block.
 *
 * @returns An object indicating whether the main hook should proceed with an
 *          LLM call and the processed query parts (including file content).
 */
export async function handleAtCommand({
  query,
  config,
  onDebugMessage,
  messageId: userMessageTimestamp,
  signal,
  addItem,
}: HandleAtCommandParams): Promise<HandleAtCommandResult> {
  const commandParts = parseAllAtCommands(query);
  const atPathCommandParts = commandParts.filter(
    (part) => part.type === 'atPath',
  );

  const addToolGroup = (result: HandleAtCommandResult): void => {
    if (!addItem) return;
    if (result.toolDisplays && result.toolDisplays.length > 0) {
      const toolGroupItem: HistoryItemToolGroup = {
        type: 'tool_group',
        tools: result.toolDisplays,
      };
      addItem(toolGroupItem, userMessageTimestamp);
    }
  };

  if (atPathCommandParts.length === 0) {
    return { processedQuery: [{ text: query }], shouldProceed: true };
  }

  // Get centralized file discovery service
  const fileDiscovery = config.getFileService();

  const respectFileIgnore = config.getFileFilteringOptions();

  const pathSpecsToRead: string[] = [];
  const atPathToResolvedSpecMap = new Map<string, string>();
  const contentLabelsForDisplay: string[] = [];
  const ignoredByReason: Record<string, string[]> = {
    git: [],
    qwen: [],
    both: [],
  };

  for (const atPathPart of atPathCommandParts) {
    const originalAtPath = atPathPart.content; // e.g., "@file.txt" or "@"

    if (originalAtPath === '@') {
      onDebugMessage(
        'Lone @ detected, will be treated as text in the modified query.',
      );
      continue;
    }

    const pathName = originalAtPath.substring(1);

    // Check if path should be ignored based on filtering options
    const workspaceContext = config.getWorkspaceContext();
    if (!workspaceContext.isPathWithinWorkspace(pathName)) {
      onDebugMessage(
        `Path ${pathName} is not in the workspace and will be skipped.`,
      );
      continue;
    }

    const gitIgnored =
      respectFileIgnore.respectGitIgnore &&
      fileDiscovery.shouldIgnoreFile(pathName, {
        respectGitIgnore: true,
        respectQwenIgnore: false,
      });
    const qwenIgnored =
      respectFileIgnore.respectQwenIgnore &&
      fileDiscovery.shouldIgnoreFile(pathName, {
        respectGitIgnore: false,
        respectQwenIgnore: true,
      });

    if (gitIgnored || qwenIgnored) {
      const reason =
        gitIgnored && qwenIgnored ? 'both' : gitIgnored ? 'git' : 'qwen';
      ignoredByReason[reason].push(pathName);
      const reasonText =
        reason === 'both'
          ? 'ignored by both git and qwen'
          : reason === 'git'
            ? 'git-ignored'
            : 'qwen-ignored';
      onDebugMessage(`Path ${pathName} is ${reasonText} and will be skipped.`);
      continue;
    }

    let resolvedSuccessfully = false;
    let sawNotFound = false;
    for (const dir of config.getWorkspaceContext().getDirectories()) {
      let currentPathSpec = pathName;
      try {
        const absolutePath = path.resolve(dir, pathName);
        const stats = await fs.stat(absolutePath);
        if (stats.isDirectory()) {
          currentPathSpec = pathName;
          onDebugMessage(`Path ${pathName} resolved to directory.`);
        } else {
          onDebugMessage(`Path ${pathName} resolved to file: ${absolutePath}`);
        }
        resolvedSuccessfully = true;
      } catch (error) {
        if (isNodeError(error) && error.code === 'ENOENT') {
          sawNotFound = true;
          continue;
        } else {
          onDebugMessage(
            `Error stating path ${pathName}: ${getErrorMessage(error)}. Path ${pathName} will be skipped.`,
          );
        }
      }
      if (resolvedSuccessfully) {
        pathSpecsToRead.push(currentPathSpec);
        atPathToResolvedSpecMap.set(originalAtPath, currentPathSpec);
        contentLabelsForDisplay.push(pathName);
        break;
      }
    }
    if (!resolvedSuccessfully && sawNotFound) {
      onDebugMessage(
        `Path ${pathName} not found. Path ${pathName} will be skipped.`,
      );
    }
  }

  // Construct the initial part of the query for the LLM
  let initialQueryText = '';
  for (let i = 0; i < commandParts.length; i++) {
    const part = commandParts[i];
    if (part.type === 'text') {
      initialQueryText += part.content;
    } else {
      // type === 'atPath'
      const resolvedSpec = atPathToResolvedSpecMap.get(part.content);
      if (
        i > 0 &&
        initialQueryText.length > 0 &&
        !initialQueryText.endsWith(' ')
      ) {
        // Add space if previous part was text and didn't end with space, or if previous was @path
        const prevPart = commandParts[i - 1];
        if (
          prevPart.type === 'text' ||
          (prevPart.type === 'atPath' &&
            atPathToResolvedSpecMap.has(prevPart.content))
        ) {
          initialQueryText += ' ';
        }
      }
      if (resolvedSpec) {
        initialQueryText += `@${resolvedSpec}`;
      } else {
        // If not resolved for reading (e.g. lone @ or invalid path that was skipped),
        // add the original @-string back, ensuring spacing if it's not the first element.
        if (
          i > 0 &&
          initialQueryText.length > 0 &&
          !initialQueryText.endsWith(' ') &&
          !part.content.startsWith(' ')
        ) {
          initialQueryText += ' ';
        }
        initialQueryText += part.content;
      }
    }
  }
  initialQueryText = initialQueryText.trim();

  // Inform user about ignored paths
  const totalIgnored =
    ignoredByReason['git'].length +
    ignoredByReason['qwen'].length +
    ignoredByReason['both'].length;

  if (totalIgnored > 0) {
    const messages = [];
    if (ignoredByReason['git'].length) {
      messages.push(`Git-ignored: ${ignoredByReason['git'].join(', ')}`);
    }
    if (ignoredByReason['qwen'].length) {
      messages.push(`Qwen-ignored: ${ignoredByReason['qwen'].join(', ')}`);
    }
    if (ignoredByReason['both'].length) {
      messages.push(`Ignored by both: ${ignoredByReason['both'].join(', ')}`);
    }

    const message = `Ignored ${totalIgnored} files:\n${messages.join('\n')}`;
    onDebugMessage(message);
  }

  // Fallback for lone "@" or completely invalid @-commands resulting in empty initialQueryText
  if (pathSpecsToRead.length === 0) {
    onDebugMessage('No valid file paths found in @ commands to read.');
    if (initialQueryText === '@' && query.trim() === '@') {
      // If the only thing was a lone @, pass original query (which might have spaces)
      return { processedQuery: [{ text: query }], shouldProceed: true };
    } else if (!initialQueryText && query) {
      // If all @-commands were invalid and no surrounding text, pass original query
      return { processedQuery: [{ text: query }], shouldProceed: true };
    }
    // Otherwise, proceed with the (potentially modified) query text that doesn't involve file reading
    return {
      processedQuery: [{ text: initialQueryText || query }],
      shouldProceed: true,
    };
  }

  try {
    const result = await readManyFiles(config, {
      paths: pathSpecsToRead,
      signal,
    });

    const parts = Array.isArray(result.contentParts)
      ? result.contentParts
      : [result.contentParts];

    // Create individual tool call displays for each file read
    const toolCallDisplays: IndividualToolCallDisplay[] = result.files.map(
      (file, index) => ({
        callId: `client-read-${userMessageTimestamp}-${index}`,
        name: file.isDirectory ? 'Read Directory' : 'Read File',
        description: file.isDirectory
          ? `Read directory ${path.basename(file.filePath)}`
          : `Read file ${path.basename(file.filePath)}`,
        status: ToolCallStatus.Success,
        resultDisplay: undefined,
        confirmationDetails: undefined,
      }),
    );

    const processedQueryParts: PartListUnion = [{ text: initialQueryText }];

    if (parts.length > 0 && !result.error) {
      // readManyFiles now returns properly formatted parts with headers and prefixes
      for (const part of parts) {
        if (typeof part === 'string') {
          processedQueryParts.push({ text: part });
        } else {
          // part is a Part object (text, inlineData, or fileData)
          processedQueryParts.push(part);
        }
      }
    } else {
      onDebugMessage('readManyFiles returned no content or empty content.');
    }

    const processedResult: HandleAtCommandResult = {
      processedQuery: processedQueryParts,
      shouldProceed: true,
      toolDisplays: toolCallDisplays,
      filesRead: contentLabelsForDisplay,
    };

    const chatRecorder = config.getChatRecordingService?.();
    chatRecorder?.recordAtCommand({
      filesRead: contentLabelsForDisplay,
      status: 'success',
      userText: query,
    });

    addToolGroup(processedResult);
    return processedResult;
  } catch (error: unknown) {
    const errorToolCallDisplay: IndividualToolCallDisplay = {
      callId: `client-read-${userMessageTimestamp}`,
      name: 'Read File(s)',
      description: 'Error attempting to read files',
      status: ToolCallStatus.Error,
      resultDisplay: `Error reading files (${contentLabelsForDisplay.join(', ')}): ${getErrorMessage(error)}`,
      confirmationDetails: undefined,
    };
    const chatRecorder = config.getChatRecordingService?.();
    const errorMessage =
      typeof errorToolCallDisplay.resultDisplay === 'string'
        ? errorToolCallDisplay.resultDisplay
        : undefined;
    chatRecorder?.recordAtCommand({
      filesRead: contentLabelsForDisplay,
      status: 'error',
      message: errorMessage,
      userText: query,
    });
    const result = {
      processedQuery: null,
      shouldProceed: false,
      toolDisplays: [errorToolCallDisplay],
      filesRead: contentLabelsForDisplay,
    };
    addToolGroup(result);
    return result;
  }
}
