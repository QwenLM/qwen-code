/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Part, PartListUnion } from '@google/genai';
import type { Config, Extension } from '@qwen-code/qwen-code-core';
import {
  getErrorMessage,
  isNodeError,
  Storage,
  isSubpath,
  unescapePath,
  readManyFiles,
  shouldRunVisionBridge,
  emptyMcpResourceText,
  formatMcpResourceContents,
  summarizeMcpResource,
  SessionService,
  SessionReferenceService,
} from '@qwen-code/qwen-code-core';
import type {
  HistoryItemToolGroup,
  HistoryItemWithoutId,
  IndividualToolCallDisplay,
} from '../types.js';
import { ToolCallStatus } from '../types.js';
import { matchMcpServerPrefix } from './mcpResourceRef.js';
import {
  parseExtensionRef,
  matchExtensionByRef,
  buildExtensionRef,
} from './extension-mention-ref.js';
import { parseSessionRef, buildSessionRef } from './session-mention-ref.js';
import {
  buildExtensionMentionContext,
  EXTENSION_CONTEXT_BUDGET,
  getExtensionDisplayName,
} from '../../utils/extension-mention.js';
import {
  buildMcpServerContextText,
  buildMcpServerRef,
  matchMcpServerByRef,
  parseMcpServerRef,
} from '../../utils/mcp-server-mention.js';

export interface ResolveAtCommandParams {
  query: string;
  config: Config;
  onDebugMessage: (message: string) => void;
  messageId: number;
  signal: AbortSignal;
}

interface HandleAtCommandParams extends ResolveAtCommandParams {
  addItem?: (item: HistoryItemWithoutId, baseTimestamp: number) => number;
}

export interface HandleAtCommandResult {
  processedQuery: PartListUnion | null;
  shouldProceed: boolean;
  toolDisplays?: IndividualToolCallDisplay[];
  filesRead?: string[];
}

export interface AtCommandRecording {
  filesRead: string[];
  status: 'success' | 'error';
  message?: string;
}

export interface ResolveAtCommandResult extends HandleAtCommandResult {
  recording?: AtCommandRecording;
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

export function extractAtPathCommands(query: string): string[] {
  return parseAllAtCommands(query).flatMap((part) =>
    part.type === 'atPath' && part.content !== '@'
      ? [part.content.substring(1)]
      : [],
  );
}

/**
 * Detect an `@server:uri` MCP resource reference. Returns the parsed
 * `{ serverName, uri }` ONLY when `pathName` is prefixed by a configured MCP
 * server name followed by ':' (longest-prefix match via
 * `matchMcpServerPrefix`, so a server name containing ':' resolves). This
 * disambiguates resource refs from filesystem paths that legitimately contain
 * ':' (e.g. a Windows `C:\...` path, or a URL pasted as a path). Anything not
 * matching a known server — or a `@server:` with an empty URI — returns null
 * and falls through to the existing filesystem handling unchanged.
 */
function parseMcpResourceRef(
  pathName: string,
  mcpServerNames: ReadonlySet<string>,
): { serverName: string; uri: string } | null {
  const match = matchMcpServerPrefix(pathName, mcpServerNames);
  if (!match || !match.rest) return null;
  return { serverName: match.serverName, uri: match.rest };
}

/**
 * Processes user input potentially containing one or more '@<path>' commands.
 * If found, it attempts to read the specified files/directories using the
 * 'read_many_files' tool, and any `@server:uri` MCP resource references via
 * the MCP server. The user query is modified to include resolved paths, and
 * the content of the files/resources is appended in a structured block.
 *
 * @returns An object indicating whether the main hook should proceed with an
 *          LLM call and the processed query parts (including file content).
 */
export async function resolveAtCommandQuery({
  query,
  config,
  onDebugMessage,
  messageId: userMessageTimestamp,
  signal,
}: ResolveAtCommandParams): Promise<ResolveAtCommandResult> {
  const commandParts = parseAllAtCommands(query);
  const atPathCommandParts = commandParts.filter(
    (part) => part.type === 'atPath',
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

  // MCP resource references (`@server:uri`) collected during the loop and
  // read after it. Keyed by the configured MCP server names so a path that
  // merely contains ':' is never mistaken for a resource.
  const mcpServerNames = new Set(Object.keys(config.getMcpServers() || {}));
  const mcpResourceRefs: Array<{
    originalAtPath: string;
    serverName: string;
    uri: string;
  }> = [];
  const mcpServerMentions: Array<{
    originalAtPath: string;
    serverName: string;
  }> = [];

  // Extension references (`@ext:<name>`) collected during the loop.
  const activeExtensions = config.getActiveExtensions?.() ?? [];
  const extensionMentions: Array<{
    originalAtPath: string;
    extension: Extension;
  }> = [];

  // Session references (`@session:<id|title>`) collected during the loop and
  // resolved after it. Each resolves to a slimmed, read-only block of a prior
  // session's history injected as reference context (never a fork/resume).
  const sessionMentions: Array<{
    originalAtPath: string;
    ref: { id?: string; title?: string };
  }> = [];

  for (const atPathPart of atPathCommandParts) {
    const originalAtPath = atPathPart.content; // e.g., "@file.txt" or "@"

    if (originalAtPath === '@') {
      onDebugMessage(
        'Lone @ detected, will be treated as text in the modified query.',
      );
      continue;
    }

    const pathName = originalAtPath.substring(1);

    // Extension reference (`@ext:<name>`): detected BEFORE MCP/filesystem
    // resolution. Only matches when the path starts with `ext:` and the name
    // corresponds to an active extension.
    const extRef = parseExtensionRef(pathName);
    if (extRef) {
      const extension = matchExtensionByRef(extRef.name, activeExtensions);
      if (extension) {
        if (
          !extensionMentions.some((m) => m.extension.name === extension.name)
        ) {
          extensionMentions.push({ originalAtPath, extension });
        }
        atPathToResolvedSpecMap.set(originalAtPath, pathName);
        continue;
      }
      onDebugMessage(
        `Extension "${extRef.name}" not found among active extensions. ` +
          `Available: ${activeExtensions.map((e) => e.name).join(', ') || '(none)'}`,
      );
      continue;
    }

    // MCP resource reference (`@server:uri`): detected BEFORE filesystem
    // resolution so a resource URI containing ':' / '//' isn't mistaken for
    // a path. Only matches when `server` is a configured MCP server; all
    // other `@...` tokens fall through to the filesystem logic untouched.
    const resourceRef = parseMcpResourceRef(pathName, mcpServerNames);
    if (resourceRef) {
      mcpResourceRefs.push({ originalAtPath, ...resourceRef });
      // Keep `@server:uri` verbatim in the text sent to the model.
      atPathToResolvedSpecMap.set(originalAtPath, pathName);
      continue;
    }

    const mcpServerRef = parseMcpServerRef(pathName);
    if (mcpServerRef) {
      const matched = matchMcpServerByRef(
        mcpServerRef.name,
        config.getMcpServers() || {},
      );
      if (matched) {
        if (
          !mcpServerMentions.some((m) => m.serverName === matched.serverName)
        ) {
          mcpServerMentions.push({
            originalAtPath,
            serverName: matched.serverName,
          });
        }
        atPathToResolvedSpecMap.set(
          originalAtPath,
          buildMcpServerRef(matched.serverName),
        );
        continue;
      }
      onDebugMessage(
        `MCP server "${mcpServerRef.name}" not found among configured MCP servers. ` +
          `Available: ${Object.keys(config.getMcpServers() || {}).join(', ') || '(none)'}`,
      );
      continue;
    }

    // Session reference (`@session:<id|title>`): detected BEFORE filesystem
    // resolution so the ':' in the token isn't mistaken for a path. Resolution
    // (load + slim) happens after the loop; here we only collect and keep the
    // token verbatim in the prompt text.
    const sessionRef = parseSessionRef(pathName);
    if (sessionRef) {
      sessionMentions.push({ originalAtPath, ref: sessionRef });
      atPathToResolvedSpecMap.set(originalAtPath, pathName);
      continue;
    }

    // Check if path should be ignored based on filtering options
    const workspaceContext = config.getWorkspaceContext();

    // Check if path is in project temp directory
    const projectTempDir = Storage.getGlobalTempDir();
    const absolutePathName = path.isAbsolute(pathName)
      ? pathName
      : path.resolve(workspaceContext.getDirectories()[0] || '', pathName);

    if (
      !isSubpath(projectTempDir, absolutePathName) &&
      !workspaceContext.isPathWithinWorkspace(pathName)
    ) {
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

  // Read all MCP resource references in parallel — each is an independent RPC
  // to a (possibly different) server, mirroring how the file path batches via
  // `readManyFiles`. Order is preserved so cards/labels line up with the refs.
  // A failure surfaces as an error tool-card but does NOT abort the turn.
  const resourceReads = await Promise.allSettled(
    mcpResourceRefs.map((ref) =>
      config
        .getToolRegistry()
        .readMcpResource(ref.serverName, ref.uri, { signal }),
    ),
  );

  const resourceParts: Part[] = [];
  const resourceDisplays: IndividualToolCallDisplay[] = [];
  const resourceLabels: string[] = [];
  for (let i = 0; i < mcpResourceRefs.length; i++) {
    const ref = mcpResourceRefs[i];
    const label = `${ref.serverName}:${ref.uri}`;
    const callId = `client-mcp-resource-${userMessageTimestamp}-${i}`;
    const outcome = resourceReads[i];

    if (outcome.status === 'rejected') {
      onDebugMessage(
        `Failed to read MCP resource ${label}: ${getErrorMessage(outcome.reason)}`,
      );
      resourceDisplays.push({
        callId,
        name: 'Read MCP Resource',
        description: `Read resource ${label}`,
        status: ToolCallStatus.Error,
        resultDisplay: `Failed to read resource ${label}: ${getErrorMessage(outcome.reason)}`,
        confirmationDetails: undefined,
      });
      continue;
    }

    // Shared formatter (see `formatMcpResourceContents`): caps text/blob size,
    // promotes blobs to media parts, and frames the content with attribution
    // delimiters so the model gets a clear boundary around untrusted,
    // server-supplied content. Kept identical to the `read_mcp_resource` tool.
    const formatted = formatMcpResourceContents(outcome.value, label);
    if (formatted.parts.length > 0) {
      resourceParts.push(...formatted.parts);
    } else {
      // Empty read: inject the same attributed diagnostic the `read_mcp_resource`
      // tool surfaces, so the model never gets a dangling `@server:uri` with zero
      // content and zero explanation (the two paths must not diverge).
      resourceParts.push({ text: emptyMcpResourceText(formatted, label) });
    }
    resourceLabels.push(label);

    // Reflect what was actually injected so a success card never hides an
    // empty/truncated read (no `contents`, or only non-text/non-blob entries
    // such as resource links / metadata).
    resourceDisplays.push({
      callId,
      name: 'Read MCP Resource',
      description: `Read resource ${label}`,
      status: ToolCallStatus.Success,
      resultDisplay: summarizeMcpResource(formatted),
      confirmationDetails: undefined,
    });
  }

  // Fallback for lone "@" or completely invalid @-commands resulting in empty
  // initialQueryText — only when there is nothing to read at all (no valid
  // file paths, resource references, or extension mentions).
  if (
    pathSpecsToRead.length === 0 &&
    mcpResourceRefs.length === 0 &&
    mcpServerMentions.length === 0 &&
    extensionMentions.length === 0 &&
    sessionMentions.length === 0
  ) {
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

  // Build extension context parts and display cards for @-mentioned extensions.
  // Processed BEFORE file reads so that extension labels/displays are available
  // in the file-read error path (mirroring how resourceDisplays/resourceLabels
  // are already built before the file read).
  // Aggregate cap across all extensions to prevent unbounded context injection.
  let extensionContextBudgetRemaining = EXTENSION_CONTEXT_BUDGET;

  const scopedMentionEntries: Array<{
    originalAtPath: string;
    part: Part;
    label: string;
    display: IndividualToolCallDisplay;
  }> = [];
  for (let i = 0; i < extensionMentions.length; i++) {
    const { originalAtPath, extension } = extensionMentions[i];
    const displayName = getExtensionDisplayName(extension);
    const callId = `client-extension-${userMessageTimestamp}-${i}`;

    const context = await buildExtensionMentionContext(extension, {
      remainingBudget: extensionContextBudgetRemaining,
      signal,
      onDebugMessage,
    });
    extensionContextBudgetRemaining = context.remainingBudget;

    scopedMentionEntries.push({
      originalAtPath,
      part: { text: context.text },
      label: buildExtensionRef(extension.name),
      display: {
        callId,
        name: 'Activate Extension',
        description: `Activated extension ${displayName}`,
        status: ToolCallStatus.Success,
        resultDisplay: undefined,
        confirmationDetails: undefined,
      },
    });
  }

  for (let i = 0; i < mcpServerMentions.length; i++) {
    const { originalAtPath, serverName } = mcpServerMentions[i];
    scopedMentionEntries.push({
      originalAtPath,
      part: { text: buildMcpServerContextText(config, serverName) },
      label: buildMcpServerRef(serverName),
      display: {
        callId: `client-mcp-server-${userMessageTimestamp}-${i}`,
        name: 'Activate MCP Server',
        description: `Activated MCP server ${serverName}`,
        status: ToolCallStatus.Success,
        resultDisplay: undefined,
        confirmationDetails: undefined,
      },
    });
  }

  // Resolve session references: load + deterministically slim a prior session
  // and inject it as a read-only reference block. A miss (not-found / ambiguous
  // title) surfaces an error card and leaves the `@session:` token as literal
  // text (already retained above), never aborting the turn.
  for (let i = 0; i < sessionMentions.length; i++) {
    const { originalAtPath, ref } = sessionMentions[i];
    const callId = `client-session-${userMessageTimestamp}-${i}`;

    let sessionId = ref.id;
    if (!sessionId && ref.title) {
      let matches: Array<{ sessionId: string }> = [];
      try {
        matches = await new SessionService(
          config.getProjectRoot(),
        ).findSessionsByTitle(ref.title);
      } catch {
        const reason = `Could not look up sessions matching "@${originalAtPath.substring(1)}" (I/O error); try a session id instead.`;
        onDebugMessage(reason);
        scopedMentionEntries.push({
          originalAtPath,
          part: { text: '' },
          label: buildSessionRef(ref.title ?? originalAtPath),
          display: {
            callId,
            name: 'Referenced Session',
            description: `Reference session "${ref.title ?? ''}"`,
            status: ToolCallStatus.Error,
            resultDisplay: reason,
            confirmationDetails: undefined,
          },
        });
        continue;
      }
      if (matches.length === 1) {
        sessionId = matches[0].sessionId;
      } else {
        const reason =
          matches.length === 0
            ? `No session matches "@${originalAtPath.substring(1)}".`
            : `"@${originalAtPath.substring(1)}" is ambiguous (${matches.length} matches); use the picker or a session id.`;
        onDebugMessage(reason);
        scopedMentionEntries.push({
          originalAtPath,
          part: { text: '' },
          label: buildSessionRef(ref.title),
          display: {
            callId,
            name: 'Referenced Session',
            description: `Reference session "${ref.title}"`,
            status: ToolCallStatus.Error,
            resultDisplay: reason,
            confirmationDetails: undefined,
          },
        });
        continue;
      }
    }

    if (!sessionId) {
      const reason = `Session reference "@${originalAtPath.substring(1)}" could not be resolved.`;
      onDebugMessage(reason);
      scopedMentionEntries.push({
        originalAtPath,
        part: { text: '' },
        label: buildSessionRef(ref.title ?? ref.id ?? originalAtPath),
        display: {
          callId,
          name: 'Referenced Session',
          description: `Reference session "${ref.title ?? ref.id ?? ''}"`,
          status: ToolCallStatus.Error,
          resultDisplay: reason,
          confirmationDetails: undefined,
        },
      });
      continue;
    }

    let resolved;
    try {
      resolved = await new SessionReferenceService(
        config.getProjectRoot(),
      ).resolve(sessionId, ref.title ? { title: ref.title } : {});
    } catch {
      const reason = `Failed to load session "${sessionId}" (I/O error); the transcript may be corrupted or unreadable.`;
      onDebugMessage(reason);
      scopedMentionEntries.push({
        originalAtPath,
        part: { text: '' },
        label: buildSessionRef(sessionId),
        display: {
          callId,
          name: 'Referenced Session',
          description: `Reference session ${sessionId}`,
          status: ToolCallStatus.Error,
          resultDisplay: reason,
          confirmationDetails: undefined,
        },
      });
      continue;
    }

    if ('notFound' in resolved) {
      const reason = `Session "${sessionId}" not found in this project.`;
      onDebugMessage(reason);
      scopedMentionEntries.push({
        originalAtPath,
        part: { text: '' },
        label: buildSessionRef(sessionId),
        display: {
          callId,
          name: 'Referenced Session',
          description: `Reference session ${sessionId}`,
          status: ToolCallStatus.Error,
          resultDisplay: reason,
          confirmationDetails: undefined,
        },
      });
      continue;
    }

    scopedMentionEntries.push({
      originalAtPath,
      part: { text: resolved.text },
      label: buildSessionRef(sessionId),
      display: {
        callId,
        name: 'Referenced Session',
        description: `Referenced session "${resolved.meta.title}"${
          resolved.truncated ? ' (truncated)' : ''
        }`,
        status: ToolCallStatus.Success,
        resultDisplay: undefined,
        confirmationDetails: undefined,
      },
    });
  }

  const scopedMentionOrder = new Map(
    atPathCommandParts.map((part, index) => [part.content, index]),
  );
  scopedMentionEntries.sort(
    (a, b) =>
      (scopedMentionOrder.get(a.originalAtPath) ?? Number.MAX_SAFE_INTEGER) -
      (scopedMentionOrder.get(b.originalAtPath) ?? Number.MAX_SAFE_INTEGER),
  );
  const scopedMentionParts = scopedMentionEntries.map((entry) => entry.part);
  const scopedMentionLabels = scopedMentionEntries.map((entry) => entry.label);
  const scopedMentionDisplays = scopedMentionEntries.map(
    (entry) => entry.display,
  );

  // Read files (if any). A hard read error aborts the turn, as before — but
  // any extension/resource tool-cards already gathered are still surfaced.
  const fileParts: Part[] = [];
  let fileDisplays: IndividualToolCallDisplay[] = [];
  if (pathSpecsToRead.length > 0) {
    try {
      const result = await readManyFiles(config, {
        paths: pathSpecsToRead,
        signal,
        preserveUnsupportedImageForBridge: shouldRunVisionBridge(config),
      });

      const parts = Array.isArray(result.contentParts)
        ? result.contentParts
        : [result.contentParts];

      fileDisplays = result.files.map((file, index) => ({
        callId: `client-read-${userMessageTimestamp}-${index}`,
        name: file.isDirectory ? 'Read Directory' : 'Read File',
        description: file.isDirectory
          ? `Read directory ${path.basename(file.filePath)}`
          : `Read file ${path.basename(file.filePath)}`,
        status: file.error ? ToolCallStatus.Error : ToolCallStatus.Success,
        resultDisplay: file.error
          ? `Failed to read ${path.basename(file.filePath)}: ${file.error}`
          : undefined,
        confirmationDetails: undefined,
      }));

      if (parts.length > 0 && !result.error) {
        for (const part of parts) {
          fileParts.push(typeof part === 'string' ? { text: part } : part);
        }
      } else {
        onDebugMessage('readManyFiles returned no content or empty content.');
      }
    } catch (error: unknown) {
      const errorToolCallDisplay: IndividualToolCallDisplay = {
        callId: `client-read-${userMessageTimestamp}`,
        name: 'Read File(s)',
        description: 'Error attempting to read files',
        status: ToolCallStatus.Error,
        resultDisplay: `Error reading files (${contentLabelsForDisplay.join(', ')}): ${getErrorMessage(error)}`,
        confirmationDetails: undefined,
      };
      const errorMessage =
        typeof errorToolCallDisplay.resultDisplay === 'string'
          ? errorToolCallDisplay.resultDisplay
          : undefined;
      const labelsOnError = [
        ...scopedMentionLabels,
        ...contentLabelsForDisplay,
        ...resourceLabels,
      ];
      return {
        processedQuery: null,
        shouldProceed: false,
        toolDisplays: [
          ...scopedMentionDisplays,
          ...resourceDisplays,
          errorToolCallDisplay,
        ],
        filesRead: labelsOnError,
        recording: {
          filesRead: labelsOnError,
          status: 'error',
          message: errorMessage,
        },
      };
    }
  }

  // File and resource content are grouped by type, NOT interleaved by their
  // position in the user's query. The model correlates each @-reference with
  // its content block via the "--- Content from ... ---" delimiter labels (and
  // the verbatim `@server:uri` / `@path` left in the prompt text), not by
  // positional alignment, so grouping is safe.
  const processedQueryParts: PartListUnion = [
    { text: initialQueryText },
    ...scopedMentionParts,
    ...fileParts,
    ...resourceParts,
  ];
  const allLabels = [
    ...scopedMentionLabels,
    ...contentLabelsForDisplay,
    ...resourceLabels,
  ];

  return {
    processedQuery: processedQueryParts,
    shouldProceed: true,
    toolDisplays: [
      ...scopedMentionDisplays,
      ...fileDisplays,
      ...resourceDisplays,
    ],
    filesRead: allLabels,
    recording: {
      filesRead: allLabels,
      status: 'success',
    },
  };
}

export async function handleAtCommand(
  params: HandleAtCommandParams,
): Promise<HandleAtCommandResult> {
  const result = await resolveAtCommandQuery(params);

  if (result.recording) {
    const chatRecorder = params.config.getChatRecordingService?.();
    chatRecorder?.recordAtCommand({
      filesRead: result.recording.filesRead,
      status: result.recording.status,
      ...(result.recording.message
        ? { message: result.recording.message }
        : {}),
      userText: params.query,
    });
  }

  if (params.addItem && result.toolDisplays && result.toolDisplays.length > 0) {
    const toolGroupItem: HistoryItemToolGroup = {
      type: 'tool_group',
      tools: result.toolDisplays,
    };
    params.addItem(toolGroupItem, params.messageId);
  }

  return {
    processedQuery: result.processedQuery,
    shouldProceed: result.shouldProceed,
    toolDisplays: result.toolDisplays,
    filesRead: result.filesRead,
  };
}
