/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * ACP prompt 内容翻译：把 `session/prompt` 的 content blocks 翻成模型输入。
 *
 * 这是协议翻译，不是会话能力：@path 展开、绝对路径读取授权、embedded resource
 * 降级都要走 ACP 自己的 `session/request_permission`，ThreadManager 不感知 ACP
 * 的 content block 形状。
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Part } from '@google/genai';
import * as acp from '@agentclientprotocol/sdk';
import {
  BRAND_NAME,
  GLOB_TOOL_NAME,
  READ_FILE_TOOL_NAME,
  REFERENCE_CONTENT_START,
  ToolConfirmationOutcome,
  getErrorMessage,
  isNodeError,
  isWithinRoot,
  processSingleFileContent,
  runLogger,
  type Config,
  type ModelInputContentBlock,
  type FilterFilesOptions,
} from '@qwen-code/core';
import { partsToContentBlocks } from './promptContent.js';
import { RequestPermissionResponseSchema } from './acpSupport.js';
import { z } from 'zod';

export interface AcpPromptContentParams {
  readonly message: acp.ContentBlock[];
  readonly signal: AbortSignal;
  readonly config: Config;
  readonly sendUpdate: (update: acp.SessionUpdate) => Promise<void>;
  readonly requestPermission: (
    request: acp.RequestPermissionRequest,
  ) => Promise<unknown>;
}

export async function resolveAcpPromptContent(
  params: AcpPromptContentParams,
): Promise<ModelInputContentBlock[]> {
  const { message, signal: abortSignal, config, sendUpdate } = params;
  const FILE_URI_SCHEME = 'file://';

  const embeddedContext: acp.EmbeddedResourceResource[] = [];

  const parts = message.map((part) => {
    switch (part.type) {
      case 'text':
        return { text: part.text };
      case 'image':
        return {
          inlineData: {
            mimeType: part.mimeType,
            data: part.data,
          },
        };
      case 'audio':
        throw acp.RequestError.invalidParams(
          { mimeType: part.mimeType },
          `Audio prompts are not supported by the selected ${BRAND_NAME} runtime.`,
        );
      case 'resource_link': {
        if (part.uri.startsWith(FILE_URI_SCHEME)) {
          return {
            fileData: {
              mimeType: part.mimeType ?? undefined,
              name: part.name,
              fileUri: part.uri.slice(FILE_URI_SCHEME.length),
            },
          };
        }
        return { text: `@${part.uri}` };
      }
      case 'resource': {
        embeddedContext.push(part.resource);
        return { text: `@${part.resource.uri}` };
      }
      default: {
        const unreachable: never = part;
        throw new Error(`Unexpected chunk type: '${unreachable}'`);
      }
    }
  });

  const atPathCommandParts = parts.filter((part) => 'fileData' in part);

  if (atPathCommandParts.length === 0 && embeddedContext.length === 0) {
    return partsToContentBlocks(parts);
  }

  const atPathToResolvedSpecMap = new Map<string, string>();

  const fileDiscovery = config.getFileService();
  const fileFilteringOptions: FilterFilesOptions =
    config.getFileFilteringOptions();

  const pathSpecsToRead: string[] = [];
  const ignoredPaths: string[] = [];
  const directContents: Array<{
    spec: string;
    content?: string;
    part?: Part;
  }> = [];

  const toolRegistry = config.getToolRegistry();
  const globTool = toolRegistry.getTool(GLOB_TOOL_NAME);

  for (const atPathPart of atPathCommandParts) {
    const pathName = atPathPart.fileData!.fileUri;
    if (fileDiscovery.shouldIgnoreFile(pathName, fileFilteringOptions)) {
      ignoredPaths.push(pathName);
      runLogger.warn(`Path ${pathName} is ignored and will be skipped.`);
      continue;
    }
    let currentPathSpec = pathName;
    let resolvedSuccessfully = false;
    let readDirectly = false;
    try {
      const absolutePath = path.resolve(config.getTargetDir(), pathName);

      let validationError = config.validatePathAccess(absolutePath, 'read');

      if (
        validationError &&
        !isWithinRoot(absolutePath, config.getTargetDir())
      ) {
        const currentMode = config.getPermissionMode();
        const isEffectiveAutoMode =
          currentMode === 'auto' ||
          currentMode === 'acceptEdits' ||
          currentMode === 'yolo';
        if (isEffectiveAutoMode) {
          config.getWorkspaceContext().addReadOnlyPath(absolutePath);
          validationError = null;
        } else {
          try {
            const stats = await fs.stat(absolutePath);
            if (stats.isFile()) {
              const syntheticCallId = `resolve-prompt-${pathName}-${randomUUID()}`;
              const request: acp.RequestPermissionRequest = {
                sessionId: config.getSessionId(),
                options: [
                  {
                    optionId: ToolConfirmationOutcome.ProceedOnce,
                    name: 'Allow once',
                    kind: 'allow_once',
                  },
                  {
                    optionId: ToolConfirmationOutcome.Cancel,
                    name: 'Deny',
                    kind: 'reject_once',
                  },
                ] as acp.PermissionOption[],
                toolCall: {
                  toolCallId: syntheticCallId,
                  status: 'pending',
                  title: `Allow access to absolute path: ${pathName}`,
                  content: [
                    {
                      type: 'content',
                      content: {
                        type: 'text',
                        text: `The Agent needs access to read an attached file outside your workspace: ${pathName}`,
                      },
                    },
                  ],
                  locations: [],
                  kind: 'read',
                },
              };

              const output = RequestPermissionResponseSchema.parse(
                await params.requestPermission(request),
              );

              const outcome =
                output.outcome.outcome === 'cancelled'
                  ? ToolConfirmationOutcome.Cancel
                  : z
                      .nativeEnum(ToolConfirmationOutcome)
                      .parse(output.outcome.optionId);

              if (outcome === ToolConfirmationOutcome.ProceedOnce) {
                config.getWorkspaceContext().addReadOnlyPath(absolutePath);
                validationError = null;
              } else {
                debug(config, `Direct read authorization denied for ${pathName}`);
                directContents.push({
                  spec: pathName,
                  content: `[Warning: Access to absolute path \`${pathName}\` denied by user.]`,
                });
                continue;
              }
            }
          } catch (error) {
            debug(
              config,
              `Failed to request permission for absolute attachment ${pathName}: ${getErrorMessage(error)}`,
            );
            await sendUpdate({
              sessionUpdate: 'agent_thought_chunk',
              content: {
                type: 'text',
                text: `Warning: Failed to display permission dialog for \`${absolutePath}\`. Error: ${getErrorMessage(error)}`,
              },
            });
          }
        }
      }

      if (!validationError) {
        if (
          (path.isAbsolute(pathName) ||
            !isWithinRoot(absolutePath, config.getTargetDir())) &&
          !readDirectly
        ) {
          try {
            const stats = await fs.stat(absolutePath);
            if (stats.isFile()) {
              const fileReadResult = await processSingleFileContent(
                absolutePath,
                config.getTargetDir(),
                config.getFileSystemService(),
              );

              if (!fileReadResult.error) {
                if (
                  typeof fileReadResult.llmContent === 'object' &&
                  'inlineData' in fileReadResult.llmContent
                ) {
                  directContents.push({
                    spec: pathName,
                    part: fileReadResult.llmContent,
                  });
                } else if (typeof fileReadResult.llmContent === 'string') {
                  let contentToPush = fileReadResult.llmContent;
                  if (fileReadResult.isTruncated) {
                    contentToPush = `[WARNING: This file was truncated]\n\n${contentToPush}`;
                  }
                  directContents.push({
                    spec: pathName,
                    content: contentToPush,
                  });
                }
                readDirectly = true;
                resolvedSuccessfully = true;
              } else {
                debug(
                  config,
                  `Direct read failed for absolute path ${pathName}: ${fileReadResult.error}`,
                );
                await sendUpdate({
                  sessionUpdate: 'agent_thought_chunk',
                  content: {
                    type: 'text',
                    text: `Warning: file read failed for \`${pathName}\`. Reason: ${fileReadResult.error}`,
                  },
                });
                continue;
              }
            }
          } catch (error) {
            debug(
              config,
              `File stat/access error for absolute path ${pathName}: ${getErrorMessage(error)}`,
            );
            await sendUpdate({
              sessionUpdate: 'agent_thought_chunk',
              content: {
                type: 'text',
                text: `Warning: file access failed for \`${pathName}\`. Reason: ${getErrorMessage(error)}`,
              },
            });
            continue;
          }
        }

        if (!readDirectly) {
          const stats = await fs.stat(absolutePath);
          if (stats.isDirectory()) {
            currentPathSpec = pathName.endsWith('/')
              ? `${pathName}**`
              : `${pathName}/**`;
            debug(
              config,
              `Path ${pathName} resolved to directory, using glob: ${currentPathSpec}`,
            );
          } else {
            debug(config, `Path ${pathName} resolved to file: ${currentPathSpec}`);
          }
          resolvedSuccessfully = true;
        }
      } else {
        debug(config, `Path ${pathName} access disallowed: ${validationError}.`);
        await sendUpdate({
          sessionUpdate: 'agent_thought_chunk',
          content: {
            type: 'text',
            text: `Warning: skipping access to \`${pathName}\`. Reason: ${validationError}`,
          },
        });
      }
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        if (config.getEnableRecursiveFileSearch() && globTool) {
          debug(
            config,
            `Path ${pathName} not found directly, attempting glob search.`,
          );
          try {
            const globResult = await globTool.buildAndExecute(
              {
                pattern: `**/*${pathName}*`,
                path: config.getTargetDir(),
              },
              abortSignal,
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
                currentPathSpec = path.relative(
                  config.getTargetDir(),
                  firstMatchAbsolute,
                );
                debug(
                  config,
                  `Glob search for ${pathName} found ${firstMatchAbsolute}, using relative path: ${currentPathSpec}`,
                );
                resolvedSuccessfully = true;
              } else {
                debug(
                  config,
                  `Glob search for '**/*${pathName}*' did not return a usable path.`,
                );
              }
            } else {
              debug(
                config,
                `Glob search for '**/*${pathName}*' found no files or an error.`,
              );
            }
          } catch (globError) {
            runLogger.error(
              `Error during glob search for ${pathName}: ${getErrorMessage(globError)}`,
            );
          }
        }
      } else {
        runLogger.error(
          `Error stating path ${pathName}. Path ${pathName} will be skipped.`,
        );
      }
    }
    if (resolvedSuccessfully) {
      if (!readDirectly) {
        pathSpecsToRead.push(currentPathSpec);
      }
      atPathToResolvedSpecMap.set(pathName, currentPathSpec);
    }
  }

  let initialQueryText = '';
  for (let i = 0; i < parts.length; i++) {
    const chunk = parts[i];
    if ('text' in chunk) {
      initialQueryText += chunk.text;
    } else {
      const resolvedSpec =
        chunk.fileData && atPathToResolvedSpecMap.get(chunk.fileData.fileUri);
      if (
        i > 0 &&
        initialQueryText.length > 0 &&
        !initialQueryText.endsWith(' ') &&
        resolvedSpec
      ) {
        const prevPart = parts[i - 1];
        if (
          'text' in prevPart ||
          ('fileData' in prevPart &&
            atPathToResolvedSpecMap.has(prevPart.fileData!.fileUri))
        ) {
          initialQueryText += ' ';
        }
      }
      if (resolvedSpec) {
        initialQueryText += `@${resolvedSpec}`;
      } else {
        if (
          i > 0 &&
          initialQueryText.length > 0 &&
          !initialQueryText.endsWith(' ') &&
          !chunk.fileData?.fileUri.startsWith(' ')
        ) {
          initialQueryText += ' ';
        }
        if (chunk.fileData?.fileUri) {
          initialQueryText += `@${chunk.fileData.fileUri}`;
        }
      }
    }
  }
  initialQueryText = initialQueryText.trim();
  if (ignoredPaths.length > 0) {
    debug(
      config,
      `Ignored ${ignoredPaths.length} files: ${ignoredPaths.join(', ')}`,
    );
  }

  const processedQueryParts: Part[] = [{ text: initialQueryText }];
  for (const part of parts) {
    if ('inlineData' in part) {
      processedQueryParts.push(part);
    }
  }

  if (
    pathSpecsToRead.length === 0 &&
    embeddedContext.length === 0 &&
    directContents.length === 0
  ) {
    runLogger.warn('No valid file paths found in @ commands to read.');
    return partsToContentBlocks([{ text: initialQueryText }]);
  }

  if (pathSpecsToRead.length > 0) {
    processedQueryParts.push({ text: `\n${REFERENCE_CONTENT_START}` });

    for (const pathSpec of pathSpecsToRead) {
      const absolutePath = path.resolve(config.getTargetDir(), pathSpec);
      try {
        const readFileTool = toolRegistry.getTool(READ_FILE_TOOL_NAME);
        if (!readFileTool) {
          runLogger.warn(`Skipping @${pathSpec}: Read tool is unavailable`);
          continue;
        }
        const readContext = { signal: abortSignal, config };
        const invocation = readFileTool.build(
          { file_path: absolutePath },
          readContext,
        );
        const result = await (invocation.executeWithContext?.(readContext) ??
          invocation.execute(abortSignal));

        if (result.error) {
          runLogger.warn(
            `Error reading file ${pathSpec}: ${result.error.message}`,
          );
          continue;
        }

        processedQueryParts.push({
          text: `\nContent from @${pathSpec}:\n`,
        });

        if (typeof result.llmContent === 'string') {
          processedQueryParts.push({ text: result.llmContent });
        } else if (Array.isArray(result.llmContent)) {
          for (const part of result.llmContent) {
            if (typeof part === 'string') {
              processedQueryParts.push({ text: part });
            } else {
              processedQueryParts.push(part);
            }
          }
        }
      } catch (error: unknown) {
        runLogger.warn(
          `Error reading file ${pathSpec}: ${getErrorMessage(error)}`,
        );
      }
    }
  }

  if (directContents.length > 0) {
    const hasReferenceStart = processedQueryParts.some(
      (p) =>
        'text' in p &&
        typeof p.text === 'string' &&
        p.text.includes(REFERENCE_CONTENT_START),
    );
    if (!hasReferenceStart) {
      processedQueryParts.push({ text: `\n${REFERENCE_CONTENT_START}` });
    }
    for (const item of directContents) {
      processedQueryParts.push({
        text: `\nContent from @${item.spec}:\n`,
      });
      if (item.content) {
        processedQueryParts.push({ text: item.content });
      } else if (item.part) {
        processedQueryParts.push(item.part);
      }
    }
  }

  if (embeddedContext.length > 0) {
    processedQueryParts.push({
      text: '\n--- Content from referenced context ---',
    });

    for (const contextPart of embeddedContext) {
      processedQueryParts.push({
        text: `\nContent from @${contextPart.uri}:\n`,
      });
      if ('text' in contextPart) {
        processedQueryParts.push({ text: contextPart.text });
      } else {
        processedQueryParts.push({
          text: `[Warning: embedded binary resource \`${contextPart.uri}\` could not be represented as model-visible text.]`,
        });
      }
    }
  }

  return partsToContentBlocks(processedQueryParts);
}

function debug(config: Config, msg: string): void {
  if (config.getDebugMode()) {
    runLogger.warn(msg);
  }
}
