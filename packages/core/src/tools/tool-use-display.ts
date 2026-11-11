/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import type { McpInfo } from '../mcp/tools/mcp-tool.js';
import { displayPathForWorkspace, shortenPath } from '../utils/paths.js';
import {
  CODE_MODE_TOOL_NAME,
  CODE_MODE_WAIT_TOOL_NAME,
  EDIT_DISPLAY_NAME,
  EDIT_TOOL_NAME,
  GLOB_DISPLAY_NAME,
  GLOB_PARAM_PATH,
  GLOB_TOOL_NAME,
  GREP_DISPLAY_NAME,
  GREP_PARAM_GLOB,
  GREP_PARAM_PATH,
  GREP_TOOL_NAME,
  IMAGE_GEN_DISPLAY_NAME,
  IMAGE_GEN_PARAM_PROMPT,
  IMAGE_GEN_TOOL_NAME,
  VIDEO_GEN_TOOL_NAME,
  VIDEO_GEN_DISPLAY_NAME,
  VIDEO_GEN_PARAM_PROMPT,
  VIDEO_GEN_RETRIEVE_TOOL_NAME,
  VIDEO_GEN_RETRIEVE_DISPLAY_NAME,
  VIDEO_GEN_RETRIEVE_PARAM_VIDEO_ID,
  IMAGE_SEARCH_DISPLAY_NAME,
  IMAGE_SEARCH_PARAM_QUERY,
  IMAGE_SEARCH_TOOL_NAME,
  NOTEBOOK_EDIT_DISPLAY_NAME,
  NOTEBOOK_EDIT_TOOL_NAME,
  ASK_USER_DISPLAY_NAME,
  ASK_USER_TOOL_NAME,
  COMPLETE_TASK_DISPLAY_NAME,
  COMPLETE_TASK_TOOL_NAME,
  ENTER_PLAN_MODE_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  PARAM_DESCRIPTION,
  PARAM_FILE_PATH,
  PARAM_PATTERN,
  READ_FILE_DISPLAY_NAME,
  READ_FILE_TOOL_NAME,
  READ_FILE_PARAM_OFFSET,
  READ_FILE_PARAM_LIMIT,
  READ_FILE_PARAM_PAGES,
  WEB_FETCH_DISPLAY_NAME,
  WEB_FETCH_TOOL_NAME,
  WEB_SEARCH_DISPLAY_NAME,
  WEB_SEARCH_PARAM_QUERY,
  WEB_SEARCH_TOOL_NAME,
  WEB_FETCH_PARAM_URL,
  SHELL_PARAM_COMMAND,
  SHELL_PARAM_RUN_IN_BACKGROUND,
  SHELL_TOOL_NAME,
  POWERSHELL_TOOL_NAME,
  SEND_MESSAGE_TOOL_NAME,
  SKILL_PARAM_NAME,
  SKILL_TOOL_NAME,
  WORKFLOW_TOOL_NAME,
  UPDATE_TOPIC_DISPLAY_NAME,
  UPDATE_TOPIC_TOOL_NAME,
  WRITE_FILE_DISPLAY_NAME,
  WRITE_FILE_TOOL_NAME,
  WRITE_TODOS_TOOL_NAME,
  TASK_CREATE_TOOL_NAME,
  TASK_GET_TOOL_NAME,
  TASK_LIST_TOOL_NAME,
  TASK_STOP_TOOL_NAME,
  TASK_UPDATE_TOOL_NAME,
} from './tool-names.js';

/** 显示只读取文本；图片源保持不透明，不绑定模型或会话的图片协议。 */
export type ToolResultDisplayContent =
  | string
  | ReadonlyArray<| { readonly type: 'text'; readonly text: string }
      | { readonly type: 'image'; readonly source: unknown }>;

export interface ToolUseDisplayMetadata {
  displayName: string;
  description: string;
  displayTitle?: string;
}

export interface ToolUseDisplayMetadataOptions {
  mcpInfo?: McpInfo;
  targetDir?: string;
}

function getStringArg(
  input: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = input[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function getNumberArg(
  input: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = input[key];
  return typeof value === 'number' ? value : undefined;
}

function getBooleanArg(
  input: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = input[key];
  return typeof value === 'boolean' ? value : undefined;
}

function parseMcpToolName(
  toolName: string,
): { serverName: string; toolName: string } | undefined {
  if (!toolName.startsWith('mcp__')) {
    return undefined;
  }
  const raw = toolName.slice('mcp__'.length);
  const separatorIndex = raw.indexOf('__');
  if (separatorIndex < 0) {
    return undefined;
  }
  const serverName = raw.slice(0, separatorIndex);
  const mcpToolName = raw.slice(separatorIndex + 2);
  if (!serverName || !mcpToolName) {
    return undefined;
  }
  return { serverName, toolName: mcpToolName };
}

function getQuestionText(question: unknown): string | undefined {
  if (!question || typeof question !== 'object' || !('question' in question)) {
    return undefined;
  }
  const value = (question as { question: unknown }).question;
  return typeof value === 'string' ? value : undefined;
}

function describeInput(input: Record<string, unknown>): string {
  return Object.keys(input).length > 0 ? JSON.stringify(input) : '';
}

function formatPathForDisplay(
  filePath: string,
  options?: ToolUseDisplayMetadataOptions,
): string {
  const displayPath = options?.targetDir
    ? displayPathForWorkspace(filePath, options.targetDir)
    : filePath;
  return shortenPath(displayPath);
}

function getPathArg(
  input: Record<string, unknown>,
  key: string,
  options?: ToolUseDisplayMetadataOptions,
): string | undefined {
  const value = getStringArg(input, key);
  return value ? formatPathForDisplay(value, options) : undefined;
}

export function getTodoWriteDescription(input: { todos?: unknown }): string {
  const todos = input.todos;
  if (!Array.isArray(todos)) {
    return 'Update todo list';
  }
  if (todos.length === 0) {
    return 'Cleared todo list';
  }
  return `Set ${todos.length} todo(s)`;
}

export function getToolUseDisplayMetadata(
  toolName: string,
  input: Record<string, unknown>,
  options?: ToolUseDisplayMetadataOptions,
): ToolUseDisplayMetadata {
  if (options?.mcpInfo) {
    const { serverName, toolName: originalName } = options.mcpInfo;
    const args =
      toolName === 'mcp_call' ? normalizeToolInput(input['arguments']) : input;
    return {
      displayName: `${originalName} (${serverName} MCP Server)`,
      description: describeInput(args),
      displayTitle: getStringArg(args, 'command'),
    };
  }
  switch (toolName) {
    case CODE_MODE_TOOL_NAME:
      return { displayName: CODE_MODE_TOOL_NAME, description: 'Execute script' };
    case CODE_MODE_WAIT_TOOL_NAME:
      return {
        displayName: CODE_MODE_TOOL_NAME,
        description:
          input['cancel'] === true ? 'Cancel script' : 'Wait for script',
      };

    case SHELL_TOOL_NAME:
    case POWERSHELL_TOOL_NAME: {
      const command = getStringArg(input, SHELL_PARAM_COMMAND);
      const description = getStringArg(input, PARAM_DESCRIPTION);
      // Transcripts written before the Bash parameter rename persist
      // `is_background`. Read it only as a display fallback so resumed sessions
      // preserve their original background marker without extending the current
      // executable tool schema.
      const isBackground =
        getBooleanArg(input, SHELL_PARAM_RUN_IN_BACKGROUND) ??
        getBooleanArg(input, 'is_background');
      const isPty = getBooleanArg(input, 'pty');
      const label = description ?? command ?? describeInput(input);
      const suffixes = [
        ...(isBackground ? ['background'] : []),
        ...(isPty ? ['pty'] : []),
      ];
      return {
        displayName: toolName,
        description: suffixes.length
          ? `${label} [${suffixes.join(', ')}]`
          : label,
        displayTitle: command,
      };
    }

    case WRITE_FILE_TOOL_NAME: {
      const filePath = getPathArg(input, PARAM_FILE_PATH, options);
      return {
        displayName: WRITE_FILE_DISPLAY_NAME,
        description: filePath ? filePath : describeInput(input),
      };
    }

    case EDIT_TOOL_NAME: {
      const filePath = getPathArg(input, PARAM_FILE_PATH, options);

      if (!filePath) {
        return {
          displayName: EDIT_DISPLAY_NAME,
          description: describeInput(input),
        };
      }

      return {
        displayName: EDIT_DISPLAY_NAME,
        description: filePath,
      };
    }

    case READ_FILE_TOOL_NAME: {
      const filePath = getPathArg(input, PARAM_FILE_PATH, options);
      if (!filePath) {
        return {
          displayName: READ_FILE_DISPLAY_NAME,
          description: describeInput(input),
        };
      }
      const offset = getNumberArg(input, READ_FILE_PARAM_OFFSET);
      const limit = getNumberArg(input, READ_FILE_PARAM_LIMIT);
      const pages = getStringArg(input, READ_FILE_PARAM_PAGES);
      let description = filePath;
      if (pages) {
        description += ` · pages ${pages}`;
      } else if (offset != null || limit != null) {
        const startLine = Math.max(offset ?? 1, 1);
        if (limit != null) {
          description += ` · lines ${startLine}-${startLine + limit - 1}`;
        } else {
          description += ` · from line ${startLine}`;
        }
      }
      return { displayName: READ_FILE_DISPLAY_NAME, description };
    }

    case GLOB_TOOL_NAME: {
      const pattern = getStringArg(input, PARAM_PATTERN);
      const searchPath = getPathArg(input, GLOB_PARAM_PATH, options);
      return {
        displayName: GLOB_DISPLAY_NAME,
        description: pattern
          ? searchPath
            ? `'${pattern}' within ${searchPath}`
            : `'${pattern}'`
          : describeInput(input),
      };
    }

    case GREP_TOOL_NAME: {
      const pattern = getStringArg(input, PARAM_PATTERN);
      if (!pattern) {
        return {
          displayName: GREP_DISPLAY_NAME,
          description: describeInput(input),
        };
      }

      let description = `'${pattern}'`;
      const glob = getStringArg(input, GREP_PARAM_GLOB);
      if (glob) {
        description += ` in ${glob}`;
      }
      const searchPath = getPathArg(input, GREP_PARAM_PATH, options) ?? '.';
      description +=
        searchPath === '.' ? ' within ./' : ` within ${searchPath}`;

      return {
        displayName: GREP_DISPLAY_NAME,
        description,
      };
    }

    case WEB_SEARCH_TOOL_NAME: {
      const query = getStringArg(input, WEB_SEARCH_PARAM_QUERY);
      return {
        displayName: WEB_SEARCH_DISPLAY_NAME,
        description: query
          ? `Searching the web for: "${query}"`
          : describeInput(input),
      };
    }

    case IMAGE_SEARCH_TOOL_NAME: {
      const query = getStringArg(input, IMAGE_SEARCH_PARAM_QUERY);
      return {
        displayName: IMAGE_SEARCH_DISPLAY_NAME,
        description: query
          ? `Searching images for: "${query}"`
          : describeInput(input),
      };
    }

    case WEB_FETCH_TOOL_NAME: {
      const url = getStringArg(input, WEB_FETCH_PARAM_URL);
      if (!url) {
        return {
          displayName: WEB_FETCH_DISPLAY_NAME,
          description: describeInput(input),
        };
      }

      try {
        return {
          displayName: WEB_FETCH_DISPLAY_NAME,
          description: `Fetching content from ${new URL(url).hostname}`,
        };
      } catch {
        return {
          displayName: WEB_FETCH_DISPLAY_NAME,
          description: 'Fetching content from URL',
        };
      }
    }

    case IMAGE_GEN_TOOL_NAME: {
      const prompt = getStringArg(input, IMAGE_GEN_PARAM_PROMPT);
      return {
        displayName: IMAGE_GEN_DISPLAY_NAME,
        description: prompt
          ? `${Array.isArray(input['images']) && input['images'].length > 0 ? 'Editing' : 'Generating'} image: "${prompt.slice(0, 80)}${prompt.length > 80 ? '...' : ''}"`
          : describeInput(input),
      };
    }

    case VIDEO_GEN_TOOL_NAME: {
      const prompt = getStringArg(input, VIDEO_GEN_PARAM_PROMPT);
      return {
        displayName: VIDEO_GEN_DISPLAY_NAME,
        description: prompt
          ? `Generating video: "${prompt.slice(0, 80)}${prompt.length > 80 ? '...' : ''}"`
          : describeInput(input),
      };
    }

    case VIDEO_GEN_RETRIEVE_TOOL_NAME: {
      const videoId = getStringArg(input, VIDEO_GEN_RETRIEVE_PARAM_VIDEO_ID);
      return {
        displayName: VIDEO_GEN_RETRIEVE_DISPLAY_NAME,
        description: `Retrieving video ${videoId ?? ''}`,
      };
    }

    case ASK_USER_TOOL_NAME: {
      const questions = input['questions'];
      const questionTexts = Array.isArray(questions)
        ? questions
            .map((question) => getQuestionText(question))
            .filter((question): question is string => question !== undefined)
        : [];
      return {
        displayName: ASK_USER_DISPLAY_NAME,
        description: questionTexts.length
          ? `Asking user: ${questionTexts.join(', ')}`
          : describeInput(input),
      };
    }

    case SKILL_TOOL_NAME: {
      const skillName = getStringArg(input, SKILL_PARAM_NAME);
      return {
        displayName: SKILL_TOOL_NAME,
        description: skillName ? `"${skillName}"` : describeInput(input),
      };
    }

    case WORKFLOW_TOOL_NAME: {
      const name = getStringArg(input, 'name');
      const scriptPath = getPathArg(input, 'scriptPath', options);
      const script = getStringArg(input, 'script');
      return {
        displayName: WORKFLOW_TOOL_NAME,
        description: scriptPath
          ? `dynamic workflow script: ${scriptPath}`
          : script
            ? 'inline dynamic workflow'
            : name
              ? `dynamic workflow: ${name}`
              : describeInput(input),
      };
    }

    case ENTER_PLAN_MODE_TOOL_NAME: {
      const reason = getStringArg(input, 'reason');
      return {
        displayName: ENTER_PLAN_MODE_TOOL_NAME,
        description: reason ?? 'Initiating Plan Mode',
      };
    }

    case EXIT_PLAN_MODE_TOOL_NAME:
      return {
        displayName: EXIT_PLAN_MODE_TOOL_NAME,
        description: 'Requesting plan approval',
      };

    case UPDATE_TOPIC_TOOL_NAME: {
      const title = getStringArg(input, 'title');
      const intent = getStringArg(input, 'strategic_intent');
      return {
        displayName: UPDATE_TOPIC_DISPLAY_NAME,
        description: title
          ? `Update topic to: "${title}"`
          : `Update tactical intent: "${intent ?? '...'}"`,
      };
    }

    case COMPLETE_TASK_TOOL_NAME:
      return {
        displayName: COMPLETE_TASK_DISPLAY_NAME,
        description: 'Completing task and submitting results.',
      };

    case NOTEBOOK_EDIT_TOOL_NAME: {
      const notebookPath = getPathArg(input, 'notebook_path', options);
      const cellId = getStringArg(input, 'cell_id');
      if (!notebookPath) {
        return {
          displayName: NOTEBOOK_EDIT_DISPLAY_NAME,
          description: describeInput(input),
        };
      }
      // Use basename to match getDescription() format
      const fileName = path.basename(notebookPath);
      return {
        displayName: NOTEBOOK_EDIT_DISPLAY_NAME,
        description: `${fileName}${cellId ? `@${cellId}` : ''}`,
      };
    }

    case WRITE_TODOS_TOOL_NAME:
      return {
        displayName: toolName,
        description: getTodoWriteDescription(input),
      };

    case TASK_STOP_TOOL_NAME: {
      const taskId = getStringArg(input, 'task_id');
      return {
        displayName: toolName,
        description: taskId ? `Stopping task ${taskId}` : 'Stopping task',
      };
    }

    case TASK_CREATE_TOOL_NAME: {
      const subject = getStringArg(input, 'subject');
      return {
        displayName: toolName,
        description: subject
          ? `Creating task: ${subject}`
          : describeInput(input),
      };
    }

    case TASK_UPDATE_TOOL_NAME: {
      const id = getStringArg(input, 'taskId');
      return {
        displayName: toolName,
        description: id ? `Updating task ${id}` : describeInput(input),
      };
    }

    case TASK_GET_TOOL_NAME: {
      const id = getStringArg(input, 'taskId');
      return {
        displayName: toolName,
        description: id ? `Retrieving task ${id}` : describeInput(input),
      };
    }

    case TASK_LIST_TOOL_NAME:
      return {
        displayName: toolName,
        description: 'Listing tasks.',
      };

    case SEND_MESSAGE_TOOL_NAME: {
      return {
        displayName: toolName,
        description: '',
      };
    }

    default:
      {
        const mcpTool = parseMcpToolName(toolName);
        if (mcpTool) {
          const command = getStringArg(input, 'command');
          const displayName =
            mcpTool.toolName === 'authenticate'
              ? `${mcpTool.serverName} - authenticate (MCP)`
              : `${mcpTool.toolName} (${mcpTool.serverName} MCP Server)`;
          return {
            displayName,
            description: describeInput(input),
            displayTitle: command,
          };
        }
      }
      return {
        displayName: toolName,
        description: describeInput(input),
      };
  }
}

/**
 * Safely narrow an unknown tool input to a record, falling back to `{}`.
 */
export function normalizeToolInput(input: unknown): Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}
