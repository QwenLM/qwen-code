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
    //
    // A URL ref (`@https://…`) is delimited differently from a filesystem
    // path. The punctuation terminators below exist to stop a path at a
    // sentence boundary ("see file.txt, then…"), but `?`, `&`, `,` and `;`
    // are structural in a URL — a presigned OSS/S3 link carries its signature
    // in the query string, so terminating at `?` would silently drop it and
    // the request would fail with HTTP 403.
    //
    // Instead a URL runs to the first character RFC 3986 does not permit
    // unencoded. That covers whitespace and also CJK prose written with no
    // space ("@https://host/a.mp4。分析一下"), which a whitespace-only rule
    // would swallow into the URL.
    const isUrlRef = /^https?:\/\//i.test(query.slice(atIndex + 1));
    // unreserved / gen-delims / sub-delims / pct-encoding, per RFC 3986.
    const NON_URL_CHAR = /[^A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]/;
    let pathEndIndex = atIndex + 1;
    let inEscape = false;
    while (pathEndIndex < query.length) {
      const char = query[pathEndIndex]!;
      if (inEscape) {
        inEscape = false;
      } else if (char === '\\') {
        inEscape = true;
      } else if (isUrlRef) {
        if (NON_URL_CHAR.test(char)) break;
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
    let rawAtPath = query.substring(atIndex, pathEndIndex);
    if (isUrlRef) {
      // `.`/`,`/`;`/`!`/`?` are legal URL characters but are usually prose
      // when they land at the very end ("@https://host/a.mp4. Explain it").
      // Trimmed after the scan rather than treated as terminators, so they
      // can never cut a URL short mid-query. Brackets and parens are left
      // alone: they appear balanced inside real URLs, and a wrapped URL still
      // yields a named error rather than a silently mangled request.
      const trimmed = rawAtPath.replace(/[.,;:!?]+$/, '');
      pathEndIndex = atIndex + trimmed.length;
      rawAtPath = trimmed;
    }
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

  // URL media references (`@https://…`) collected during the loop and
  // localized (downloaded → recognized → promoted into the omni object
  // store) after it. Only active when omni delivery is on; otherwise URL
  // tokens keep today's fall-through behavior (left as text).
  const urlMediaRefs: Array<{ originalAtPath: string; url: string }> = [];
  /** `@`-referenced media whose bytes are gone but whose memory survives:
   * re-anchored to a session handle so recall stays reachable. */
  const rememberedMediaRefs: Array<{
    originalAtPath: string;
    pathName: string;
    annotation: string;
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

    // URL media reference (`@https://…`): detected BEFORE every other
    // parser — a URL can't be an extension/session/MCP ref, and without
    // this branch it would fall through to filesystem resolution where the
    // ENOENT skip silently drops it. Only intercepted when omni delivery
    // is active; otherwise preserve the legacy text fall-through.
    if (/^https?:\/\//i.test(pathName) && config.isOmniEnabled?.()) {
      const omni = await import('@qwen-code/qwen-code-core/omni');
      if (omni.isOmniDeliveryActive(config) && omni.parseHttpUrlRef(pathName)) {
        if (!urlMediaRefs.some((r) => r.url === pathName)) {
          urlMediaRefs.push({ originalAtPath, url: pathName });
        }
        // Keep the URL verbatim in the text sent to the model.
        atPathToResolvedSpecMap.set(originalAtPath, pathName);
        continue;
      }
    }

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

    // Session reference (`@session:<id|title>`): detected BEFORE MCP and
    // filesystem resolution so the ':' in the token isn't mistaken for a path
    // or intercepted by an MCP server literally named "session". Resolution
    // (load + slim) happens after the loop; here we only collect and keep the
    // token verbatim in the prompt text.
    const sessionRef = parseSessionRef(pathName);
    if (sessionRef) {
      if (
        !sessionMentions.some(
          (m) =>
            (m.ref.id ?? m.ref.title) === (sessionRef.id ?? sessionRef.title),
        )
      ) {
        sessionMentions.push({ originalAtPath, ref: sessionRef });
      }
      atPathToResolvedSpecMap.set(originalAtPath, pathName);
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
      // The bytes are gone, but media memory may still hold everything
      // that was ever derived from them (transcripts, keyframes, the
      // processing history). A handle is normally minted only at delivery,
      // which needs the bytes — so that knowledge used to be unreachable
      // for good. The user's own `@`-reference is the same authorization a
      // delivery carries, so re-anchor from the recorded identity and hand
      // the model a handle it can recall with (design M §9.2.1).
      let reanchored = false;
      if (config.isOmniEnabled?.()) {
        const { reanchorRememberedMedia } = await import(
          '@qwen-code/qwen-code-core'
        );
        for (const dir of config.getWorkspaceContext().getDirectories()) {
          const anchor = await reanchorRememberedMedia(
            config,
            path.resolve(dir, pathName),
          );
          if (!anchor) continue;
          rememberedMediaRefs.push({
            originalAtPath,
            pathName,
            annotation: anchor.annotation,
          });
          atPathToResolvedSpecMap.set(originalAtPath, pathName);
          onDebugMessage(
            `Path ${pathName} is gone but remembered; re-anchored as ` +
              `${anchor.resourceId} (bytes unavailable).`,
          );
          reanchored = true;
          break;
        }
      }
      if (!reanchored) {
        onDebugMessage(
          `Path ${pathName} not found. Path ${pathName} will be skipped.`,
        );
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

  // URL media localization: download → recognize → promote into the omni
  // object store → upload → fileData part. Sequential (media downloads can
  // be large; parallel GiB transfers would contend), failure-isolated per
  // URL (an error card is shown and the turn continues — mirroring the MCP
  // resource block's Promise.allSettled semantics).
  const urlMediaParts: Part[] = [];
  const urlMediaDisplays: IndividualToolCallDisplay[] = [];
  const urlMediaLabels: string[] = [];
  if (urlMediaRefs.length > 0) {
    const core = await import('@qwen-code/qwen-code-core/omni');
    for (let i = 0; i < urlMediaRefs.length; i++) {
      const ref = urlMediaRefs[i];
      const callId = `client-url-media-${userMessageTimestamp}-${i}`;
      const hostLabel = (() => {
        try {
          return new URL(ref.url).hostname;
        } catch {
          return 'invalid-url';
        }
      })();
      let tempPartPath: string | undefined;
      try {
        const store = new core.OmniObjectStore(config.storage.getQwenDir());
        const downloadsDir = path.join(store.getOmniRootDir(), 'downloads');
        const downloaded = await core.downloadMediaUrl({
          url: ref.url,
          downloadsDir,
          maxBytes: core.effectiveMaxDownloadFileBytes(config),
          signal,
        });
        tempPartPath = downloaded.partPath;
        // Full local-file pipeline on the downloaded bytes: sniff/probe/
        // hash again (the design requires re-recognition from the local
        // file — never trust transfer-time observations), guard, store,
        // upload. Displays and error messages need a stable name; use the
        // URL basename.
        const urlBase = path.basename(new URL(ref.url).pathname) || hostLabel;
        // Per-modality gate, mirroring the local-file path in fileUtils:
        // media the active model cannot consume must not be stored and
        // uploaded — the fileData part would only be replaced by an
        // unsupported-modality placeholder in the converter, after paying
        // for the upload. (The download itself is unavoidable: modality
        // is only knowable from the bytes.) A null sniff falls through to
        // the pipeline, whose recognition failure names the problem.
        const modalities =
          config.getContentGeneratorConfig?.()?.modalities ?? {};
        const sniffedModality = await core.sniffFileModality(
          downloaded.partPath,
        );
        if (sniffedModality && !modalities[sniffedModality]) {
          urlMediaDisplays.push({
            callId,
            name: 'Fetch Media URL',
            description: `Download ${ref.url}`,
            status: ToolCallStatus.Error,
            resultDisplay: `Skipped ${urlBase}: the active model does not accept ${sniffedModality} input.`,
            confirmationDetails: undefined,
          });
          continue;
        }
        const delivery = await core.processMediaForOmniDelivery(
          downloaded.partPath,
          config,
          // displayName: guard/error messages must name the URL's file, not
          // the opaque staging path the download landed under.
          { signal, displayName: urlBase },
        );
        // §6.2/D8 ordering contract documented on buildTranscriptParts.
        const transcriptParts = core.buildTranscriptParts(
          urlBase,
          delivery.transcripts,
        );
        // Additional media Parts (multi-output fixed policies): follow the
        // primary media slot in every branch below.
        const additionalParts = core.buildAdditionalMediaParts(
          urlBase,
          delivery.additionalMedia,
        );
        if (delivery.omission) {
          // Explicit omission (policy design §10.2): the media is withheld
          // and the omission notice text stands in its place — mirroring
          // readMediaViaOmniDelivery. Not an error: the fetch succeeded;
          // the transport guard's verdict is the content.
          urlMediaParts.push({
            text: core.formatOmissionText(urlBase, delivery.omission.reason),
          });
          urlMediaParts.push(...additionalParts);
          urlMediaParts.push(...transcriptParts);
          urlMediaLabels.push(ref.url);
          urlMediaDisplays.push({
            callId,
            name: 'Fetch Media URL',
            description: `Downloaded ${ref.url}`,
            status: ToolCallStatus.Success,
            resultDisplay: `Media omitted by the omni transport guard: ${urlBase}`,
            confirmationDetails: undefined,
          });
          continue;
        }
        if (!delivery.fileUri && transcriptParts.length > 0) {
          // Pure-transcript delivery (§6.2): the policies replaced the
          // media with text-only deliverables — no media Part is emitted
          // for the primary (additional deliverables, if any, still are).
          // The primary disclosure (chained prior lossy steps, decision
          // D8) still renders: the transcript was derived through them.
          if (delivery.disclosure) {
            urlMediaParts.push({
              text: core.formatDisclosureText(urlBase, delivery.disclosure),
            });
          }
          urlMediaParts.push(...additionalParts);
          urlMediaParts.push(...transcriptParts);
          urlMediaLabels.push(ref.url);
          urlMediaDisplays.push({
            callId,
            name: 'Fetch Media URL',
            description: `Downloaded ${ref.url}`,
            status: ToolCallStatus.Success,
            resultDisplay: `Localized ${urlBase} and delivered as transcript (omni policy).`,
            confirmationDetails: undefined,
          });
          continue;
        }
        // Disclosure IMMEDIATELY before its media part (decision D8):
        // provider converters that relocate media move the pair together.
        if (delivery.disclosure) {
          urlMediaParts.push({
            text: core.formatDisclosureText(urlBase, delivery.disclosure),
          });
        }
        urlMediaParts.push({
          fileData: {
            fileUri: delivery.fileUri,
            mimeType: delivery.mimeType,
            displayName: urlBase,
          },
        });
        urlMediaParts.push(...additionalParts);
        urlMediaParts.push(...transcriptParts);
        urlMediaLabels.push(ref.url);
        urlMediaDisplays.push({
          callId,
          name: 'Fetch Media URL',
          description: `Downloaded ${ref.url}`,
          status: ToolCallStatus.Success,
          resultDisplay: `Localized ${urlBase} (${delivery.recognized.modality}, ${(delivery.recognized.sizeBytes / 1024 / 1024).toFixed(1)}MB) and delivered via omni upload${delivery.degraded ? ' (degraded by media policy)' : ''}.`,
          confirmationDetails: undefined,
        });
      } catch (error) {
        if (signal.aborted) {
          // User cancelled mid-download: end the turn quietly instead of
          // throwing — resolveAtCommandQuery has no throw contract, and a
          // rejection here would surface as an unhandled-rejection banner
          // (cancelOngoingRequest already handles the UI reset).
          if (tempPartPath) {
            await fs.rm(tempPartPath, { force: true }).catch(() => {});
          }
          return {
            processedQuery: null,
            shouldProceed: false,
            toolDisplays: [...urlMediaDisplays],
            filesRead: urlMediaLabels,
            // No chat-recording entry for a user-cancelled resolution.
          };
        }
        const reason = getErrorMessage(error);
        onDebugMessage(`Failed to localize media URL ${ref.url}: ${reason}`);
        urlMediaDisplays.push({
          callId,
          name: 'Fetch Media URL',
          description: `Download ${ref.url}`,
          status: ToolCallStatus.Error,
          resultDisplay: `Failed to fetch media from ${hostLabel}: ${reason}`,
          confirmationDetails: undefined,
        });
      } finally {
        if (tempPartPath) {
          await fs.rm(tempPartPath, { force: true }).catch(() => {});
        }
      }
    }
  }

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
    sessionMentions.length === 0 &&
    // URL media refs count as content too: without this, a URL-only prompt
    // would run the whole download→upload pipeline and then discard the
    // delivered parts (and their display cards) via this early return.
    urlMediaRefs.length === 0
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
  const resolvedSessionIds = new Set<string>();
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
      } catch (error: unknown) {
        const reason = `Could not look up sessions matching "@${originalAtPath.substring(1)}" (${getErrorMessage(error)}); try a session id instead.`;
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

    // Cross-form dedup: a UUID ref and a title ref may resolve to the
    // same session — skip if already injected.
    if (resolvedSessionIds.has(sessionId)) {
      onDebugMessage(
        `Session reference "@${originalAtPath.substring(1)}" resolves to session ${sessionId}, which was already referenced; skipping duplicate.`,
      );
      continue;
    }
    resolvedSessionIds.add(sessionId);

    let resolved;
    try {
      resolved = await new SessionReferenceService(
        config.getProjectRoot(),
      ).resolve(sessionId, ref.title ? { title: ref.title } : {});
    } catch (error: unknown) {
      const reason = `Failed to load session "${sessionId}" (${getErrorMessage(error)}); the transcript may be corrupted or unreadable.`;
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
        description: `@${path.basename(file.filePath)}`,
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
        ...urlMediaLabels,
      ];
      return {
        processedQuery: null,
        shouldProceed: false,
        toolDisplays: [
          ...scopedMentionDisplays,
          ...resourceDisplays,
          ...urlMediaDisplays,
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
  // Re-anchored media: a handle annotation plus an explicit note that the
  // bytes are gone, so the model recalls instead of trying to read.
  const rememberedMediaParts: Part[] = rememberedMediaRefs.flatMap((ref) => [
    { text: ref.annotation },
    {
      text:
        `【媒体缺失】${ref.pathName}：文件已不在磁盘上，无法投递画面/音频。` +
        `其处理记忆仍可用——用上面的句柄调用 omni_recall_media_memory 取回。`,
    },
  ]);
  const processedQueryParts: PartListUnion = [
    { text: initialQueryText },
    ...scopedMentionParts,
    ...fileParts,
    ...resourceParts,
    ...urlMediaParts,
    ...rememberedMediaParts,
  ];
  const allLabels = [
    ...scopedMentionLabels,
    ...contentLabelsForDisplay,
    ...resourceLabels,
    ...urlMediaLabels,
    ...rememberedMediaRefs.map((ref) => `${ref.pathName} (记忆)`),
  ];

  return {
    processedQuery: processedQueryParts,
    shouldProceed: true,
    toolDisplays: [
      ...scopedMentionDisplays,
      ...fileDisplays,
      ...resourceDisplays,
      ...urlMediaDisplays,
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
