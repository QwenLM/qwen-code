/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { PartListUnion, PartUnion } from '@google/genai';
import type { AnyToolInvocation, Config } from '@qwen-code/qwen-code-core';
import {
  getErrorMessage,
  isNodeError,
  unescapePath,
} from '@qwen-code/qwen-code-core';
import type { HistoryItem, IndividualToolCallDisplay } from '../types.js';
import { ToolCallStatus } from '../types.js';
import type { UseHistoryManagerReturn } from './useHistoryManager.js';

interface HandleAtCommandParams {
  query: string;
  config: Config;
  addItem: UseHistoryManagerReturn['addItem'];
  onDebugMessage: (message: string) => void;
  messageId: number;
  signal: AbortSignal;
}

interface HandleAtCommandResult {
  processedQuery: PartListUnion | null;
  shouldProceed: boolean;
}

interface AtCommandPart {
  type: 'text' | 'atPath';
  content: string;
}

interface McpResourceAtReference {
  atCommand: string; // e.g. "@github:repos/owner/repo/issues"
  serverName: string;
  uri: string; // e.g. "github://repos/owner/repo/issues"
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

function getConfiguredMcpServerNames(config: Config): Set<string> {
  const names = new Set(Object.keys(config.getMcpServers() ?? {}));
  if (config.getMcpServerCommand()) {
    names.add('mcp');
  }
  return names;
}

function normalizeMcpResourceUri(serverName: string, resource: string): string {
  if (resource.includes('://')) {
    return resource;
  }

  const cleaned = resource.startsWith('/') ? resource.slice(1) : resource;
  return `${serverName}://${cleaned}`;
}

function splitLeadingToken(
  text: string,
): { token: string; rest: string } | null {
  let i = 0;
  while (i < text.length && /\s/.test(text[i])) {
    i++;
  }
  if (i >= text.length) {
    return null;
  }

  let token = '';
  let inEscape = false;
  while (i < text.length) {
    const char = text[i];
    if (inEscape) {
      token += char;
      inEscape = false;
      i++;
      continue;
    }
    if (char === '\\') {
      inEscape = true;
      i++;
      continue;
    }
    if (/[,\s;!?()[\]{}]/.test(char)) {
      break;
    }
    if (char === '.') {
      const nextChar = i + 1 < text.length ? text[i + 1] : '';
      if (nextChar === '' || /\s/.test(nextChar)) {
        break;
      }
    }
    token += char;
    i++;
  }

  if (!token) {
    return null;
  }

  return { token, rest: text.slice(i) };
}

function extractMcpResourceAtReferences(
  parts: AtCommandPart[],
  config: Config,
): { parts: AtCommandPart[]; refs: McpResourceAtReference[] } {
  const configuredServers = getConfiguredMcpServerNames(config);
  const refs: McpResourceAtReference[] = [];
  const merged: AtCommandPart[] = [];

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part.type !== 'atPath') {
      merged.push(part);
      continue;
    }

    const atText = part.content; // e.g. "@github:" or "@github:repos/..."
    const colonIndex = atText.indexOf(':');
    if (!atText.startsWith('@') || colonIndex <= 1) {
      merged.push(part);
      continue;
    }

    const serverName = atText.slice(1, colonIndex);
    if (!configuredServers.has(serverName)) {
      merged.push(part);
      continue;
    }

    let resource = atText.slice(colonIndex + 1);

    // Support the documented "@server: resource" format where the resource is
    // separated into the following text part.
    if (!resource) {
      const next = parts[i + 1];
      if (next?.type === 'text') {
        const tokenInfo = splitLeadingToken(next.content);
        if (tokenInfo) {
          resource = tokenInfo.token;
          const remainingText = tokenInfo.rest;
          // Update the next part in place, and let the next iteration handle it.
          parts[i + 1] = { type: 'text', content: remainingText };
        }
      }
    }

    if (!resource) {
      // Treat "@server:" without a resource as plain text, rather than falling
      // through to file resolution for a path like "server:".
      merged.push({ type: 'text', content: atText });
      continue;
    }

    const normalizedResource = resource.includes('://')
      ? resource
      : resource.startsWith('/')
        ? resource.slice(1)
        : resource;

    const normalizedAtCommand = `@${serverName}:${normalizedResource}`;
    refs.push({
      atCommand: normalizedAtCommand,
      serverName,
      uri: normalizeMcpResourceUri(serverName, normalizedResource),
    });
    merged.push({ type: 'atPath', content: normalizedAtCommand });
  }

  return {
    parts: merged.filter(
      (p) => !(p.type === 'text' && p.content.trim() === ''),
    ),
    refs,
  };
}

function formatMcpResourceContents(
  raw: unknown,
  limits: { maxCharsPerResource: number; maxLinesPerResource: number },
): string {
  if (!raw || typeof raw !== 'object') {
    return '[Error: Invalid MCP resource response]';
  }

  const contents = (raw as { contents?: unknown }).contents;
  if (!Array.isArray(contents)) {
    return '[Error: Invalid MCP resource response]';
  }

  const parts: string[] = [];
  for (const item of contents) {
    if (!item || typeof item !== 'object') {
      continue;
    }

    const text = (item as { text?: unknown }).text;
    const blob = (item as { blob?: unknown }).blob;
    const mimeType = (item as { mimeType?: unknown }).mimeType;

    if (typeof text === 'string') {
      parts.push(text);
      continue;
    }

    if (typeof blob === 'string') {
      const mimeTypeLabel =
        typeof mimeType === 'string' ? mimeType : 'application/octet-stream';
      parts.push(
        `[Binary MCP resource omitted (mimeType: ${mimeTypeLabel}, bytes: ${blob.length})]`,
      );
    }
  }

  let combined = parts.join('\n\n');

  const maxLines = limits.maxLinesPerResource;
  if (Number.isFinite(maxLines)) {
    const lines = combined.split('\n');
    if (lines.length > maxLines) {
      combined = `${lines.slice(0, maxLines).join('\n')}\n[truncated]`;
    }
  }

  const maxChars = limits.maxCharsPerResource;
  if (Number.isFinite(maxChars) && combined.length > maxChars) {
    combined = `${combined.slice(0, maxChars)}\n[truncated]`;
  }

  return combined;
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
  addItem,
  onDebugMessage,
  messageId: userMessageTimestamp,
  signal,
}: HandleAtCommandParams): Promise<HandleAtCommandResult> {
  const parsedParts = parseAllAtCommands(query);
  const { parts: commandParts, refs: mcpResourceRefs } =
    extractMcpResourceAtReferences(parsedParts, config);

  const mcpAtCommands = new Set(mcpResourceRefs.map((r) => r.atCommand));
  const atPathCommandParts = commandParts.filter(
    (part) => part.type === 'atPath',
  );
  const fileAtPathCommandParts = atPathCommandParts.filter(
    (part) => !mcpAtCommands.has(part.content),
  );

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

  const toolRegistry = config.getToolRegistry();
  const readManyFilesTool = toolRegistry.getTool('read_many_files');
  const globTool = toolRegistry.getTool('glob');

  for (const atPathPart of fileAtPathCommandParts) {
    const originalAtPath = atPathPart.content; // e.g., "@file.txt" or "@"

    if (originalAtPath === '@') {
      onDebugMessage(
        'Lone @ detected, will be treated as text in the modified query.',
      );
      continue;
    }

    const pathName = originalAtPath.substring(1);
    if (!pathName) {
      // This case should ideally not be hit if parseAllAtCommands ensures content after @
      // but as a safeguard:
      addItem(
        {
          type: 'error',
          text: `Error: Invalid @ command '${originalAtPath}'. No path specified.`,
        },
        userMessageTimestamp,
      );
      // Decide if this is a fatal error for the whole command or just skip this @ part
      // For now, let's be strict and fail the command if one @path is malformed.
      return { processedQuery: null, shouldProceed: false };
    }

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

    for (const dir of config.getWorkspaceContext().getDirectories()) {
      let currentPathSpec = pathName;
      let resolvedSuccessfully = false;
      try {
        const absolutePath = path.resolve(dir, pathName);
        const stats = await fs.stat(absolutePath);
        if (stats.isDirectory()) {
          currentPathSpec =
            pathName + (pathName.endsWith(path.sep) ? `**` : `/**`);
          onDebugMessage(
            `Path ${pathName} resolved to directory, using glob: ${currentPathSpec}`,
          );
        } else {
          onDebugMessage(`Path ${pathName} resolved to file: ${absolutePath}`);
        }
        resolvedSuccessfully = true;
      } catch (error) {
        if (isNodeError(error) && error.code === 'ENOENT') {
          if (config.getEnableRecursiveFileSearch() && globTool) {
            onDebugMessage(
              `Path ${pathName} not found directly, attempting glob search.`,
            );
            try {
              const globResult = await globTool.buildAndExecute(
                {
                  pattern: `**/*${pathName}*`,
                  path: dir,
                },
                signal,
              );
              if (
                globResult.llmContent &&
                typeof globResult.llmContent === 'string' &&
                !globResult.llmContent.startsWith('No files found') &&
                !globResult.llmContent.startsWith('Error:')
              ) {
                const lines = globResult.llmContent.split('\n');
                if (lines.length > 1 && lines[1]) {
                  const firstMatchAbsolute = lines[1].trim();
                  currentPathSpec = path.relative(dir, firstMatchAbsolute);
                  onDebugMessage(
                    `Glob search for ${pathName} found ${firstMatchAbsolute}, using relative path: ${currentPathSpec}`,
                  );
                  resolvedSuccessfully = true;
                } else {
                  onDebugMessage(
                    `Glob search for '**/*${pathName}*' did not return a usable path. Path ${pathName} will be skipped.`,
                  );
                }
              } else {
                onDebugMessage(
                  `Glob search for '**/*${pathName}*' found no files or an error. Path ${pathName} will be skipped.`,
                );
              }
            } catch (globError) {
              console.error(
                `Error during glob search for ${pathName}: ${getErrorMessage(globError)}`,
              );
              onDebugMessage(
                `Error during glob search for ${pathName}. Path ${pathName} will be skipped.`,
              );
            }
          } else {
            onDebugMessage(
              `Glob tool not found. Path ${pathName} will be skipped.`,
            );
          }
        } else {
          console.error(
            `Error stating path ${pathName}: ${getErrorMessage(error)}`,
          );
          onDebugMessage(
            `Error stating path ${pathName}. Path ${pathName} will be skipped.`,
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
    console.log(message);
    onDebugMessage(message);
  }

  // Fallback for lone "@" or completely invalid @-commands resulting in empty initialQueryText
  if (pathSpecsToRead.length === 0 && mcpResourceRefs.length === 0) {
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

  const processedQueryParts: PartUnion[] = [{ text: initialQueryText }];

  const toolDisplays: IndividualToolCallDisplay[] = [];

  if (pathSpecsToRead.length > 0) {
    if (!readManyFilesTool) {
      addItem(
        { type: 'error', text: 'Error: read_many_files tool not found.' },
        userMessageTimestamp,
      );
      return { processedQuery: null, shouldProceed: false };
    }

    const toolArgs = {
      paths: pathSpecsToRead,
      file_filtering_options: {
        respect_git_ignore: respectFileIgnore.respectGitIgnore,
        respect_qwen_ignore: respectFileIgnore.respectQwenIgnore,
      },
      // Use configuration setting
    };

    let invocation: AnyToolInvocation | undefined = undefined;
    try {
      invocation = readManyFilesTool.build(toolArgs);
      const result = await invocation.execute(signal);
      toolDisplays.push({
        callId: `client-read-${userMessageTimestamp}`,
        name: readManyFilesTool.displayName,
        description: invocation.getDescription(),
        status: ToolCallStatus.Success,
        resultDisplay:
          result.returnDisplay ||
          `Successfully read: ${contentLabelsForDisplay.join(', ')}`,
        confirmationDetails: undefined,
      });

      if (Array.isArray(result.llmContent)) {
        const fileContentRegex = /^--- (.*?) ---\n\n([\s\S]*?)\n\n$/;
        processedQueryParts.push({
          text: '\n--- Content from referenced files ---',
        });
        for (const part of result.llmContent) {
          if (typeof part === 'string') {
            const match = fileContentRegex.exec(part);
            if (match) {
              const filePathSpecInContent = match[1]; // This is a resolved pathSpec
              const fileActualContent = match[2].trim();
              processedQueryParts.push({
                text: `\nContent from @${filePathSpecInContent}:\n`,
              });
              processedQueryParts.push({ text: fileActualContent });
            } else {
              processedQueryParts.push({ text: part });
            }
          } else {
            // part is a Part object.
            processedQueryParts.push(part);
          }
        }
      } else {
        onDebugMessage(
          'read_many_files tool returned no content or empty content.',
        );
      }
    } catch (error: unknown) {
      toolDisplays.push({
        callId: `client-read-${userMessageTimestamp}`,
        name: readManyFilesTool.displayName,
        description:
          invocation?.getDescription() ??
          'Error attempting to execute tool to read files',
        status: ToolCallStatus.Error,
        resultDisplay: `Error reading files (${contentLabelsForDisplay.join(', ')}): ${getErrorMessage(error)}`,
        confirmationDetails: undefined,
      });
      addItem(
        { type: 'tool_group', tools: toolDisplays } as Omit<HistoryItem, 'id'>,
        userMessageTimestamp,
      );
      return { processedQuery: null, shouldProceed: false };
    }
  }

  if (mcpResourceRefs.length > 0) {
    const totalCharLimit = config.getTruncateToolOutputThreshold();
    const totalLineLimit = config.getTruncateToolOutputLines();
    const maxCharsPerResource = Number.isFinite(totalCharLimit)
      ? Math.floor(totalCharLimit / Math.max(1, mcpResourceRefs.length))
      : Number.POSITIVE_INFINITY;
    const maxLinesPerResource = Number.isFinite(totalLineLimit)
      ? Math.floor(totalLineLimit / Math.max(1, mcpResourceRefs.length))
      : Number.POSITIVE_INFINITY;

    processedQueryParts.push({
      text: '\n--- Content from referenced MCP resources ---',
    });

    for (let i = 0; i < mcpResourceRefs.length; i++) {
      const ref = mcpResourceRefs[i];
      let resourceResult: unknown;
      try {
        if (signal.aborted) {
          const error = new Error('MCP resource read aborted');
          error.name = 'AbortError';
          throw error;
        }

        resourceResult = await toolRegistry.readMcpResource(
          ref.serverName,
          ref.uri,
          { signal },
        );

        toolDisplays.push({
          callId: `client-mcp-resource-${userMessageTimestamp}-${i}`,
          name: 'McpResourceRead',
          description: `Read MCP resource ${ref.uri} (server: ${ref.serverName})`,
          status: ToolCallStatus.Success,
          resultDisplay: `Read: ${ref.uri}`,
          confirmationDetails: undefined,
        });
      } catch (error: unknown) {
        toolDisplays.push({
          callId: `client-mcp-resource-${userMessageTimestamp}-${i}`,
          name: 'McpResourceRead',
          description: `Read MCP resource ${ref.uri} (server: ${ref.serverName})`,
          status: ToolCallStatus.Error,
          resultDisplay: `Error reading MCP resource (${ref.uri}): ${getErrorMessage(error)}`,
          confirmationDetails: undefined,
        });
        addItem(
          { type: 'tool_group', tools: toolDisplays } as Omit<
            HistoryItem,
            'id'
          >,
          userMessageTimestamp,
        );
        return { processedQuery: null, shouldProceed: false };
      }

      processedQueryParts.push({
        text: `\nContent from ${ref.atCommand}:\n`,
      });
      processedQueryParts.push({
        text: formatMcpResourceContents(resourceResult, {
          maxCharsPerResource,
          maxLinesPerResource,
        }),
      });
    }

    processedQueryParts.push({ text: '\n--- End of MCP resource content ---' });
  }

  if (toolDisplays.length > 0) {
    addItem(
      { type: 'tool_group', tools: toolDisplays } as Omit<HistoryItem, 'id'>,
      userMessageTimestamp,
    );
  }

  return { processedQuery: processedQueryParts, shouldProceed: true };
}
