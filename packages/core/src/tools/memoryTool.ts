/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ToolEditConfirmationDetails, ToolResult } from './tools.js';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  ToolConfirmationOutcome,
} from './tools.js';
import type { FunctionDeclaration } from '@google/genai';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Storage } from '../config/storage.js';
import * as Diff from 'diff';
import { DEFAULT_DIFF_OPTIONS } from './diffOptions.js';
import { tildeifyPath } from '../utils/paths.js';
import type {
  ModifiableDeclarativeTool,
  ModifyContext,
} from './modifiable-tool.js';
import { ToolErrorType } from './tool-error.js';

const memoryToolSchemaData: FunctionDeclaration = {
  name: 'save_memory',
  description:
    'Saves a specific piece of information or fact to your long-term memory. Use this when the user explicitly asks you to remember something, or when they state a clear, concise fact that seems important to retain for future interactions.',
  parametersJsonSchema: {
    type: 'object',
    properties: {
      fact: {
        type: 'string',
        description:
          'The specific fact or piece of information to remember. Should be a clear, self-contained statement.',
      },
      scope: {
        type: 'string',
        description:
          'Where to save the memory: "global" saves to user-level ~/.qwen/QWEN.md (shared across all projects), "project" saves to current project\'s QWEN.md (project-specific). If not specified, will prompt user to choose.',
        enum: ['global', 'project'],
      },
    },
    required: ['fact'],
  },
};

const memoryToolDescription = `
Saves a specific piece of information or fact to your long-term memory.

Use this tool:

- When the user explicitly asks you to remember something (e.g., "Remember that I like pineapple on pizza", "Please save this: my cat's name is Whiskers").
- When the user states a clear, concise fact about themselves, their preferences, or their environment that seems important for you to retain for future interactions to provide a more personalized and effective assistance.

Do NOT use this tool:

- To remember conversational context that is only relevant for the current session.
- To save long, complex, or rambling pieces of text. The fact should be relatively short and to the point.
- If you are unsure whether the information is a fact worth remembering long-term. If in doubt, you can ask the user, "Should I remember that for you?"

## Parameters

- \`fact\` (string, required): The specific fact or piece of information to remember. This should be a clear, self-contained statement. For example, if the user says "My favorite color is blue", the fact would be "My favorite color is blue".
- \`scope\` (string, optional): Where to save the memory:
  - "global": Saves to user-level ~/.qwen/QWEN.md (shared across all projects)
  - "project": Saves to current project's QWEN.md (project-specific)
  - If not specified, the tool will ask the user where they want to save the memory.
`;

export const GEMINI_CONFIG_DIR = '.qwen';
export const DEFAULT_CONTEXT_FILENAME = 'QWEN.md';
export const MEMORY_SECTION_HEADER = '## Qwen Added Memories';

// This variable will hold the currently configured filename for QWEN.md context files.
// It defaults to DEFAULT_CONTEXT_FILENAME but can be overridden by setGeminiMdFilename.
let currentGeminiMdFilename: string | string[] = DEFAULT_CONTEXT_FILENAME;

export function setGeminiMdFilename(newFilename: string | string[]): void {
  if (Array.isArray(newFilename)) {
    if (newFilename.length > 0) {
      currentGeminiMdFilename = newFilename.map((name) => name.trim());
    }
  } else if (newFilename && newFilename.trim() !== '') {
    currentGeminiMdFilename = newFilename.trim();
  }
}

export function getCurrentGeminiMdFilename(): string {
  if (Array.isArray(currentGeminiMdFilename)) {
    return currentGeminiMdFilename[0];
  }
  return currentGeminiMdFilename;
}

export function getAllGeminiMdFilenames(): string[] {
  if (Array.isArray(currentGeminiMdFilename)) {
    return currentGeminiMdFilename;
  }
  return [currentGeminiMdFilename];
}

interface SaveMemoryParams {
  fact: string;
  modified_by_user?: boolean;
  modified_content?: string;
  scope?: 'global' | 'project';
}

function getGlobalMemoryFilePath(): string {
  return path.join(Storage.getGlobalGeminiDir(), getCurrentGeminiMdFilename());
}

function getProjectMemoryFilePath(): string {
  return path.join(process.cwd(), getCurrentGeminiMdFilename());
}

function getMemoryFilePath(scope: 'global' | 'project' = 'global'): string {
  return scope === 'project'
    ? getProjectMemoryFilePath()
    : getGlobalMemoryFilePath();
}

/**
 * Ensures proper newline separation before appending content.
 */
function ensureNewlineSeparation(currentContent: string): string {
  if (currentContent.length === 0) return '';
  if (currentContent.endsWith('\n\n') || currentContent.endsWith('\r\n\r\n'))
    return '';
  if (currentContent.endsWith('\n') || currentContent.endsWith('\r\n'))
    return '\n';
  return '\n\n';
}

/**
 * Reads the current content of the memory file
 */
async function readMemoryFileContent(
  scope: 'global' | 'project' = 'global',
): Promise<string> {
  try {
    return await fs.readFile(getMemoryFilePath(scope), 'utf-8');
  } catch (err) {
    const error = err as Error & { code?: string };
    if (!(error instanceof Error) || error.code !== 'ENOENT') throw err;
    return '';
  }
}

/**
 * Computes the new content that would result from adding a memory entry
 */
function computeNewContent(currentContent: string, fact: string): string {
  let processedText = fact.trim();
  processedText = processedText.replace(/^(-+\s*)+/, '').trim();
  const newMemoryItem = `- ${processedText}`;

  const headerIndex = currentContent.indexOf(MEMORY_SECTION_HEADER);

  if (headerIndex === -1) {
    // Header not found, append header and then the entry
    const separator = ensureNewlineSeparation(currentContent);
    return (
      currentContent +
      `${separator}${MEMORY_SECTION_HEADER}\n${newMemoryItem}\n`
    );
  } else {
    // Header found, find where to insert the new memory entry
    const startOfSectionContent = headerIndex + MEMORY_SECTION_HEADER.length;
    let endOfSectionIndex = currentContent.indexOf(
      '\n## ',
      startOfSectionContent,
    );
    if (endOfSectionIndex === -1) {
      endOfSectionIndex = currentContent.length; // End of file
    }

    const beforeSectionMarker = currentContent
      .substring(0, startOfSectionContent)
      .trimEnd();
    let sectionContent = currentContent
      .substring(startOfSectionContent, endOfSectionIndex)
      .trimEnd();
    const afterSectionMarker = currentContent.substring(endOfSectionIndex);

    sectionContent += `\n${newMemoryItem}`;
    return (
      `${beforeSectionMarker}\n${sectionContent.trimStart()}\n${afterSectionMarker}`.trimEnd() +
      '\n'
    );
  }
}

class MemoryToolInvocation extends BaseToolInvocation<
  SaveMemoryParams,
  ToolResult
> {
  private static readonly allowlist: Set<string> = new Set();

  getDescription(): string {
    if (!this.params.scope) {
      const globalPath = tildeifyPath(getMemoryFilePath('global'));
      const projectPath = tildeifyPath(getMemoryFilePath('project'));
      return `CHOOSE: ${globalPath} (global) OR ${projectPath} (project)`;
    }
    const scope = this.params.scope;
    const memoryFilePath = getMemoryFilePath(scope);
    return `${tildeifyPath(memoryFilePath)} (${scope})`;
  }

  override async shouldConfirmExecute(
    _abortSignal: AbortSignal,
  ): Promise<ToolEditConfirmationDetails | false> {
    // When scope is not specified, show a choice dialog defaulting to global
    if (!this.params.scope) {
      // Show preview of what would be added to global by default
      const defaultScope = 'global';
      const currentContent = await readMemoryFileContent(defaultScope);
      const newContent = computeNewContent(currentContent, this.params.fact);

      const globalPath = tildeifyPath(getMemoryFilePath('global'));
      const projectPath = tildeifyPath(getMemoryFilePath('project'));

      const fileName = path.basename(getMemoryFilePath(defaultScope));
      const choiceText = `Choose where to save this memory:

"${this.params.fact}"

Options:
- Global: ${globalPath} (shared across all projects)
- Project: ${projectPath} (current project only)

Preview of changes to be made to GLOBAL memory:
`;
      const fileDiff =
        choiceText +
        Diff.createPatch(
          fileName,
          currentContent,
          newContent,
          'Current',
          'Proposed (Global)',
          DEFAULT_DIFF_OPTIONS,
        );

      const confirmationDetails: ToolEditConfirmationDetails = {
        type: 'edit',
        title: `Choose Memory Location: GLOBAL (${globalPath}) or PROJECT (${projectPath})`,
        fileName,
        filePath: getMemoryFilePath(defaultScope),
        fileDiff,
        originalContent: `scope: global\n\n# INSTRUCTIONS:\n# - Click "Yes" to save to GLOBAL memory: ${globalPath}\n# - Click "Modify with external editor" and change "global" to "project" to save to PROJECT memory: ${projectPath}\n\n${currentContent}`,
        newContent: `scope: global\n\n# INSTRUCTIONS:\n# - Click "Yes" to save to GLOBAL memory: ${globalPath}\n# - Click "Modify with external editor" and change "global" to "project" to save to PROJECT memory: ${projectPath}\n\n${newContent}`,
        onConfirm: async (_outcome: ToolConfirmationOutcome) => {
          // Will be handled in createUpdatedParams
        },
      };
      return confirmationDetails;
    }

    // Only check allowlist when scope is specified
    const scope = this.params.scope;
    const memoryFilePath = getMemoryFilePath(scope);
    const allowlistKey = `${memoryFilePath}_${scope}`;

    if (MemoryToolInvocation.allowlist.has(allowlistKey)) {
      return false;
    }

    // Read current content of the memory file
    const currentContent = await readMemoryFileContent(scope);

    // Calculate the new content that will be written to the memory file
    const newContent = computeNewContent(currentContent, this.params.fact);

    const fileName = path.basename(memoryFilePath);
    const fileDiff = Diff.createPatch(
      fileName,
      currentContent,
      newContent,
      'Current',
      'Proposed',
      DEFAULT_DIFF_OPTIONS,
    );

    const confirmationDetails: ToolEditConfirmationDetails = {
      type: 'edit',
      title: `Confirm Memory Save: ${tildeifyPath(memoryFilePath)} (${scope})`,
      fileName: memoryFilePath,
      filePath: memoryFilePath,
      fileDiff,
      originalContent: currentContent,
      newContent,
      onConfirm: async (outcome: ToolConfirmationOutcome) => {
        if (outcome === ToolConfirmationOutcome.ProceedAlways) {
          MemoryToolInvocation.allowlist.add(allowlistKey);
        }
      },
    };
    return confirmationDetails;
  }

  async execute(_signal: AbortSignal): Promise<ToolResult> {
    const { fact, modified_by_user, modified_content } = this.params;

    if (!fact || typeof fact !== 'string' || fact.trim() === '') {
      const errorMessage = 'Parameter "fact" must be a non-empty string.';
      return {
        llmContent: JSON.stringify({ success: false, error: errorMessage }),
        returnDisplay: `Error: ${errorMessage}`,
      };
    }

    // If scope is not specified and user didn't modify content, return error prompting for choice
    if (!this.params.scope && !modified_by_user) {
      const globalPath = tildeifyPath(getMemoryFilePath('global'));
      const projectPath = tildeifyPath(getMemoryFilePath('project'));
      const errorMessage = `Please specify where to save this memory:

Global: ${globalPath} (shared across all projects)
Project: ${projectPath} (current project only)`;

      return {
        llmContent: JSON.stringify({
          success: false,
          error: 'Please specify where to save this memory',
        }),
        returnDisplay: errorMessage,
      };
    }

    const scope = this.params.scope || 'global';
    const memoryFilePath = getMemoryFilePath(scope);

    try {
      if (modified_by_user && modified_content !== undefined) {
        // User modified the content in external editor, write it directly
        await fs.mkdir(path.dirname(memoryFilePath), {
          recursive: true,
        });
        await fs.writeFile(memoryFilePath, modified_content, 'utf-8');
        const successMessage = `Okay, I've updated the ${scope} memory file with your modifications.`;
        return {
          llmContent: JSON.stringify({
            success: true,
            message: successMessage,
          }),
          returnDisplay: successMessage,
        };
      } else {
        // Use the normal memory entry logic
        await MemoryTool.performAddMemoryEntry(fact, memoryFilePath, {
          readFile: fs.readFile,
          writeFile: fs.writeFile,
          mkdir: fs.mkdir,
        });
        const successMessage = `Okay, I've remembered that in ${scope} memory: "${fact}"`;
        return {
          llmContent: JSON.stringify({
            success: true,
            message: successMessage,
          }),
          returnDisplay: successMessage,
        };
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error(
        `[MemoryTool] Error executing save_memory for fact "${fact}" in ${scope}: ${errorMessage}`,
      );
      return {
        llmContent: JSON.stringify({
          success: false,
          error: `Failed to save memory. Detail: ${errorMessage}`,
        }),
        returnDisplay: `Error saving memory: ${errorMessage}`,
        error: {
          message: errorMessage,
          type: ToolErrorType.MEMORY_TOOL_EXECUTION_ERROR,
        },
      };
    }
  }
}

export class MemoryTool
  extends BaseDeclarativeTool<SaveMemoryParams, ToolResult>
  implements ModifiableDeclarativeTool<SaveMemoryParams>
{
  static readonly Name: string = memoryToolSchemaData.name!;
  constructor() {
    super(
      MemoryTool.Name,
      'SaveMemory',
      memoryToolDescription,
      Kind.Think,
      memoryToolSchemaData.parametersJsonSchema as Record<string, unknown>,
    );
  }

  protected override validateToolParamValues(
    params: SaveMemoryParams,
  ): string | null {
    if (params.fact.trim() === '') {
      return 'Parameter "fact" must be a non-empty string.';
    }

    return null;
  }

  protected createInvocation(params: SaveMemoryParams) {
    return new MemoryToolInvocation(params);
  }

  static async performAddMemoryEntry(
    text: string,
    memoryFilePath: string,
    fsAdapter: {
      readFile: (path: string, encoding: 'utf-8') => Promise<string>;
      writeFile: (
        path: string,
        data: string,
        encoding: 'utf-8',
      ) => Promise<void>;
      mkdir: (
        path: string,
        options: { recursive: boolean },
      ) => Promise<string | undefined>;
    },
  ): Promise<void> {
    let processedText = text.trim();
    // Remove leading hyphens and spaces that might be misinterpreted as markdown list items
    processedText = processedText.replace(/^(-+\s*)+/, '').trim();
    const newMemoryItem = `- ${processedText}`;

    try {
      await fsAdapter.mkdir(path.dirname(memoryFilePath), { recursive: true });
      let content = '';
      try {
        content = await fsAdapter.readFile(memoryFilePath, 'utf-8');
      } catch (_e) {
        // File doesn't exist, will be created with header and item.
      }

      const headerIndex = content.indexOf(MEMORY_SECTION_HEADER);

      if (headerIndex === -1) {
        // Header not found, append header and then the entry
        const separator = ensureNewlineSeparation(content);
        content += `${separator}${MEMORY_SECTION_HEADER}\n${newMemoryItem}\n`;
      } else {
        // Header found, find where to insert the new memory entry
        const startOfSectionContent =
          headerIndex + MEMORY_SECTION_HEADER.length;
        let endOfSectionIndex = content.indexOf('\n## ', startOfSectionContent);
        if (endOfSectionIndex === -1) {
          endOfSectionIndex = content.length; // End of file
        }

        const beforeSectionMarker = content
          .substring(0, startOfSectionContent)
          .trimEnd();
        let sectionContent = content
          .substring(startOfSectionContent, endOfSectionIndex)
          .trimEnd();
        const afterSectionMarker = content.substring(endOfSectionIndex);

        sectionContent += `\n${newMemoryItem}`;
        content =
          `${beforeSectionMarker}\n${sectionContent.trimStart()}\n${afterSectionMarker}`.trimEnd() +
          '\n';
      }
      await fsAdapter.writeFile(memoryFilePath, content, 'utf-8');
    } catch (error) {
      console.error(
        `[MemoryTool] Error adding memory entry to ${memoryFilePath}:`,
        error,
      );
      throw new Error(
        `[MemoryTool] Failed to add memory entry: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  getModifyContext(_abortSignal: AbortSignal): ModifyContext<SaveMemoryParams> {
    return {
      getFilePath: (params: SaveMemoryParams) => {
        // Determine scope from modified content or default
        let scope = params.scope || 'global';
        if (params.modified_content) {
          const scopeMatch = params.modified_content.match(
            /^scope:\s*(global|project)\s*\n/i,
          );
          if (scopeMatch) {
            scope = scopeMatch[1].toLowerCase() as 'global' | 'project';
          }
        }
        return getMemoryFilePath(scope);
      },
      getCurrentContent: async (params: SaveMemoryParams): Promise<string> => {
        // Check if content starts with scope directive
        if (params.modified_content) {
          const scopeMatch = params.modified_content.match(
            /^scope:\s*(global|project)\s*\n/i,
          );
          if (scopeMatch) {
            const scope = scopeMatch[1].toLowerCase() as 'global' | 'project';
            const content = await readMemoryFileContent(scope);
            const globalPath = tildeifyPath(getMemoryFilePath('global'));
            const projectPath = tildeifyPath(getMemoryFilePath('project'));
            return `scope: ${scope}\n\n# INSTRUCTIONS:\n# - Save as "global" for GLOBAL memory: ${globalPath}\n# - Save as "project" for PROJECT memory: ${projectPath}\n\n${content}`;
          }
        }
        const scope = params.scope || 'global';
        const content = await readMemoryFileContent(scope);
        const globalPath = tildeifyPath(getMemoryFilePath('global'));
        const projectPath = tildeifyPath(getMemoryFilePath('project'));
        return `scope: ${scope}\n\n# INSTRUCTIONS:\n# - Save as "global" for GLOBAL memory: ${globalPath}\n# - Save as "project" for PROJECT memory: ${projectPath}\n\n${content}`;
      },
      getProposedContent: async (params: SaveMemoryParams): Promise<string> => {
        let scope = params.scope || 'global';

        // Check if modified content has scope directive
        if (params.modified_content) {
          const scopeMatch = params.modified_content.match(
            /^scope:\s*(global|project)\s*\n/i,
          );
          if (scopeMatch) {
            scope = scopeMatch[1].toLowerCase() as 'global' | 'project';
          }
        }

        const currentContent = await readMemoryFileContent(scope);
        const newContent = computeNewContent(currentContent, params.fact);
        const globalPath = tildeifyPath(getMemoryFilePath('global'));
        const projectPath = tildeifyPath(getMemoryFilePath('project'));
        return `scope: ${scope}\n\n# INSTRUCTIONS:\n# - Save as "global" for GLOBAL memory: ${globalPath}\n# - Save as "project" for PROJECT memory: ${projectPath}\n\n${newContent}`;
      },
      createUpdatedParams: (
        _oldContent: string,
        modifiedProposedContent: string,
        originalParams: SaveMemoryParams,
      ): SaveMemoryParams => {
        // Parse user's scope choice from modified content
        const scopeMatch = modifiedProposedContent.match(
          /^scope:\s*(global|project)/i,
        );
        const scope = scopeMatch
          ? (scopeMatch[1].toLowerCase() as 'global' | 'project')
          : 'global';

        // Strip out the scope directive and instruction lines, keep only the actual memory content
        const contentWithoutScope = modifiedProposedContent.replace(
          /^scope:\s*(global|project)\s*\n/,
          '',
        );
        const actualContent = contentWithoutScope
          .replace(/^#[^\n]*\n/gm, '')
          .replace(/^\s*\n/gm, '')
          .trim();

        return {
          ...originalParams,
          scope,
          modified_by_user: true,
          modified_content: actualContent,
        };
      },
    };
  }
}
