/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * NotebookEditTool — Jupyter notebook cell editing.
 *
 * Supports replace, insert, and delete operations on individual cells.
 */

import {
  withFileWriteLock,
  pinFileWriteTarget,
  resolveFileWritePath,
} from '../utils/fileWriteTarget.js';
import fs from 'node:fs';
import * as path from 'node:path';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  type ToolInvocation,
  type ToolResult,
} from './tools.js';
import { ToolErrorType } from './tool-error.js';
import { readBaselineFor } from '../utils/fileStateCache.js';
import type { Config } from '../config/config.js';
import type { ToolUseContext } from './tool-types.js';
import { DEFAULT_DEFERRED_HINTS } from '../codemode/types.js';
import { isNodeError } from '../utils/errors.js';
import { rewritePosixDrivePath } from '../utils/paths.js';
import {
  activateConditionalSkillsForPath,
} from './jit-context.js';
import {
  FileNotTextError,
  notTextWriteRefusal,
  preserveBOM,
  readFileWithMetadata,
  writeTextContent,
} from '../utils/fileWriteUtils.js';
import { stripBOM } from '../utils/stripBom.js';
import {
  type NotebookCell,
  type NotebookContent,
  normalizeNotebook,
  parseCellId,
  getCellSourceText,
} from '../utils/notebook.js';
import { NOTEBOOK_EDIT_TOOL_NAME } from './definitions/base-declarations.js';
import { NOTEBOOK_EDIT_DISPLAY_NAME } from './tool-names.js';
import * as Diff from 'diff';
import { DEFAULT_DIFF_OPTIONS, getDiffStat } from './diffOptions.js';
import { runLogger } from '../utils/runLogger.js';




// ────────────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────────────

const NOTEBOOK_EDIT_DESCRIPTION =
  'Replace the contents of a specific cell in a Jupyter notebook.';

const NOTEBOOK_EDIT_PROMPT = `Completely replaces the contents of a specific cell in a Jupyter notebook (.ipynb file) with new source. Jupyter notebooks are interactive documents that combine code, text, and visualizations, commonly used for data analysis and scientific computing. The notebook_path parameter must be an absolute path, not a relative path. The cell_id is the ID of the cell to edit (as shown in the Read output), or a 0-indexed cell-N format (e.g. cell-0, cell-1). Use edit_mode=insert to add a new cell after the cell specified by cell_id. Use edit_mode=delete to delete the cell specified by cell_id.`;

// ────────────────────────────────────────────────────────────────────────────
// Schema
// ────────────────────────────────────────────────────────────────────────────

const NOTEBOOK_EDIT_SCHEMA = {
  type: 'object',
  properties: {
    notebook_path: {
      type: 'string',
      description:
        'The absolute path to the Jupyter notebook file to edit (must be absolute, not relative)',
    },
    cell_id: {
      type: 'string',
      description:
        'The ID of the cell to edit. When inserting a new cell, the new cell will be inserted after the cell with this ID, or at the beginning if not specified.',
    },
    new_source: {
      type: 'string',
      description:
        'The new source for the cell. Not required when edit_mode is delete.',
    },
    cell_type: {
      type: 'string',
      enum: ['code', 'markdown'],
      description:
        'The type of the cell (code or markdown). If not specified, it defaults to the current cell type. If using edit_mode=insert, this is required.',
    },
    edit_mode: {
      type: 'string',
      enum: ['replace', 'insert', 'delete'],
      description:
        'The type of edit to make (replace, insert, delete). Defaults to replace.',
    },
  },
  required: ['notebook_path'],
  additionalProperties: false,
};

// ────────────────────────────────────────────────────────────────────────────
// Params
// ────────────────────────────────────────────────────────────────────────────

export interface NotebookEditToolParams {
  notebook_path: string;
  cell_id?: string;
  new_source?: string;
  cell_type?: 'code' | 'markdown';
  edit_mode?: 'replace' | 'insert' | 'delete';
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function safeParseJSON(content: string): unknown | null {
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function getFileModificationTime(filePath: string): number {
  try {
    return Math.floor(fs.statSync(filePath).mtimeMs);
  } catch {
    return 0;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Invocation
// ────────────────────────────────────────────────────────────────────────────

class NotebookEditToolInvocation extends BaseToolInvocation<
  NotebookEditToolParams,
  ToolResult
> {
  private readonly fullPath: string;

  constructor(
    private readonly config: Config,
    params: NotebookEditToolParams,
    toolName?: string,
    displayName?: string,
  ) {
    super(params, toolName, displayName);
    const notebookPath = rewritePosixDrivePath(params.notebook_path);
    this.fullPath = path.isAbsolute(notebookPath)
      ? notebookPath
      : path.resolve(this.config.getTargetDir(), notebookPath);
  }

  getDescription(): string {
    const fileName = path.basename(this.fullPath);
    const cellSuffix = this.params.cell_id ? `@${this.params.cell_id}` : '';
    return `${fileName}${cellSuffix}`;
  }

  async execute(signal: AbortSignal): Promise<ToolResult> {
    return this.executeWithContext({ signal });
  }

  override async executeWithContext(ctx: ToolUseContext): Promise<ToolResult> {
    activateConditionalSkillsForPath(this.config, this.fullPath);
    const result = await this._executeInternal(ctx);
    return result;
  }

  async validateBeforePermission(
    ctx: ToolUseContext,
  ): Promise<ToolResult | undefined> {
    return this.validateReadBaseline(ctx);
  }

  private validateReadBaseline(ctx: ToolUseContext): ToolResult | undefined {
    const cache = ctx.fileReadState ?? this.config.fileReadState;
    const baseline = readBaselineFor(
      cache.get(this.fullPath),
      ctx.resultConsumption,
    );
    if (
      baseline &&
      getFileModificationTime(this.fullPath) <= baseline.timestamp
    ) {
      return undefined;
    }

    const message = !baseline
      ? 'File has not been read yet. Read it first before writing to it.'
      : 'File has been modified since read. Read it again before editing.';
    return {
      llmContent: message,
      returnDisplay: message,
      error: { message, type: ToolErrorType.FILE_UNEXPECTEDLY_MODIFIED },
    };
  }

  private async _executeInternal(
    ctx: ToolUseContext,
    target?: ReturnType<typeof pinFileWriteTarget>,
  ): Promise<ToolResult> {
    const expectedPath = resolveFileWritePath(this.fullPath);
    const baselineError = this.validateReadBaseline(ctx);
    if (baselineError) return baselineError;
    const { cell_id, edit_mode: originalEditMode } = this.params;
    const new_source = this.params.new_source ?? '';
    let { cell_type } = this.params;

    try {
      // readFileWithMetadata gives content + encoding + lineEndings
      const { content, encoding, lineEndings, notText } = readFileWithMetadata(
        this.fullPath,
      );
      if (notText) {
        const message = notTextWriteRefusal(notText);
        return {
          llmContent: message,
          returnDisplay: `Error: ${message}`,
          error: { message, type: ToolErrorType.FILE_NOT_TEXT },
        };
      }

      // Must use non-memoized JSON.parse (not safeParseJSON cache)
      // because we mutate the notebook in place below.
      let notebook: NotebookContent;
      try {
        notebook = normalizeNotebook(JSON.parse(stripBOM(content)));
      } catch {
        return this.makeErrorResult(
          new_source,
          cell_type,
          cell_id,
          'Notebook is not valid JSON.',
        );
      }

      let cellIndex: number;
      if (!cell_id) {
        cellIndex = 0; // Default to inserting at the beginning if no cell_id
      } else {
        // First try to find the cell by its actual ID
        cellIndex = notebook.cells.findIndex((cell) => cell.id === cell_id);

        // If not found, try to parse as a numeric index (cell-N format)
        if (cellIndex === -1) {
          const parsedCellIndex = parseCellId(cell_id);
          if (parsedCellIndex !== undefined) {
            cellIndex = parsedCellIndex;
          }
        }

        if (originalEditMode === 'insert') {
          cellIndex += 1; // Insert after the cell with this ID
        }
      }

      // Convert replace to insert if trying to replace one past the end
      let edit_mode = originalEditMode ?? 'replace';
      if (edit_mode === 'replace' && cellIndex === notebook.cells.length) {
        edit_mode = 'insert';
        if (!cell_type) {
          cell_type = 'code'; // Default to code if no cell_type specified
        }
      }

      // Generate cell ID for nbformat >= 4.5
      let new_cell_id: string | undefined = undefined;
      if (
        notebook.nbformat > 4 ||
        (notebook.nbformat === 4 && notebook.nbformat_minor >= 5)
      ) {
        if (edit_mode === 'insert') {
          new_cell_id = Math.random().toString(36).substring(2, 15);
        } else if (cell_id !== null) {
          new_cell_id = cell_id;
        }
      }

      let oldCellSource = '';
      if (edit_mode !== 'insert') {
        const targetCell = notebook.cells[cellIndex];
        if (targetCell) {
          oldCellSource = getCellSourceText(targetCell);
        }
      }

      if (edit_mode === 'delete') {
        // Delete the specified cell
        notebook.cells.splice(cellIndex, 1);
      } else if (edit_mode === 'insert') {
        let new_cell: NotebookCell;
        if (cell_type === 'markdown') {
          new_cell = {
            cell_type: 'markdown',
            id: new_cell_id,
            source: new_source,
            metadata: {},
          };
        } else {
          new_cell = {
            cell_type: 'code',
            id: new_cell_id,
            source: new_source,
            metadata: {},
            execution_count: null,
            outputs: [],
          };
        }
        // Insert the new cell
        notebook.cells.splice(cellIndex, 0, new_cell);
      } else {
        // Replace: find the specified cell
        const targetCell = notebook.cells[cellIndex];
        targetCell.source = new_source;
        if (targetCell.cell_type === 'code') {
          // Reset execution count and clear outputs since cell was modified
          targetCell.execution_count = null;
          targetCell.outputs = [];
        }
        if (cell_type && cell_type !== targetCell.cell_type) {
          targetCell.cell_type = cell_type;
        }
      }

      // Write back to file with indent=1
      const IPYNB_INDENT = 1;
      const updatedContent = preserveBOM(content, JSON.stringify(notebook, null, IPYNB_INDENT));
      if (!target) {
        if (ctx.fileHistory && ctx.messageId)
          await ctx.fileHistory.trackEdit(this.fullPath, ctx.messageId);
        return await withFileWriteLock(this.fullPath, ctx.signal, () =>
          this._executeInternal(
            ctx,
            pinFileWriteTarget(this.fullPath, expectedPath),
          ),
        );
      }
      await writeTextContent(
        target.ioPath,
        updatedContent,
        encoding,
        lineEndings,
        () => {
          ctx.signal.throwIfAborted();
          target.recheckBeforeWrite();
          const beforeWrite = readFileWithMetadata(this.fullPath);
          if (beforeWrite.notText)
            throw new FileNotTextError(beforeWrite.notText);
        },
      );

      // Update readFileState with post-write mtime
      const fileStateCache = ctx.fileReadState ?? this.config.fileReadState;
      try {
        fileStateCache.set(this.fullPath, {
          content: updatedContent,
          timestamp: Math.floor(fs.statSync(this.fullPath).mtimeMs),
          offset: undefined,
          limit: undefined,
          contentNotInModelContext: true,
        });
      } catch {
        fileStateCache.delete(this.fullPath);
      }

      // Fire FileChanged hook (fire-and-forget, observability only)
      void this.config
        .getHookSystem()
        ?.fireFileChangedEvent(this.fullPath, 'change')
        .catch((err) => runLogger.debug(`FileChanged hook error: ${err}`));

      const cellLabel = new_cell_id || cell_id || 'beginning';
      let llmContent: string;
      switch (edit_mode) {
        case 'delete':
          llmContent = `Deleted cell ${cellLabel}`;
          break;
        case 'insert':
          llmContent = `Inserted cell ${cellLabel} with ${new_source}`;
          break;
        default:
          llmContent = `Updated cell ${cellLabel} with ${new_source}`;
          break;
      }

      const newCellSource = edit_mode === 'delete' ? '' : new_source;
      const fileName = path.basename(this.fullPath);
      const fileDiff = Diff.createPatch(
        fileName,
        oldCellSource,
        newCellSource,
        'Current',
        'Proposed',
        DEFAULT_DIFF_OPTIONS,
      );
      const diffStat = getDiffStat(
        fileName,
        oldCellSource,
        newCellSource,
        newCellSource,
      );

      const toolUseResult = {
        fileDiff,
        fileName,
        filePath: this.fullPath,
        originalContent: oldCellSource,
        newContent: newCellSource,
        diffStat,
        isNewFile: edit_mode === 'insert',
      };

      return {
        llmContent,
        returnDisplay: toolUseResult,
        toolUseResult,
        fileWrite: {
          filePath: this.fullPath,
          workspacePath: this.config.getTargetDir(),
          originalContent: content,
          proposedContent: updatedContent,
          writtenContent: updatedContent,
        },
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return this.makeErrorResult(
        new_source,
        cell_type,
        cell_id,
        errorMsg,
        error instanceof FileNotTextError
          ? ToolErrorType.FILE_NOT_TEXT
          : ToolErrorType.EXECUTION_FAILED,
      );
    }
  }

  private makeErrorResult(
    _newSource: string,
    _cellType: string | undefined,
    _cellId: string | undefined,
    errorMessage: string,
    errorType = ToolErrorType.EXECUTION_FAILED,
  ): ToolResult {
    return {
      llmContent: errorMessage,
      returnDisplay: `Error: ${errorMessage}`,
      error: {
        message: errorMessage,
        type: errorType,
      },
    };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Tool
// ────────────────────────────────────────────────────────────────────────────

export class NotebookEditTool extends BaseDeclarativeTool<
  NotebookEditToolParams,
  ToolResult
> {
  static readonly Name = NOTEBOOK_EDIT_TOOL_NAME;

  override get exposureHints() {
    return DEFAULT_DEFERRED_HINTS;
  }

  constructor(private readonly config: Config) {
    super(
      NotebookEditTool.Name,
      NOTEBOOK_EDIT_DISPLAY_NAME,
      `${NOTEBOOK_EDIT_DESCRIPTION}\n${NOTEBOOK_EDIT_PROMPT}`,
      Kind.Edit,
      NOTEBOOK_EDIT_SCHEMA,
      true, // isOutputMarkdown
      false, // canUpdateOutput
    );
  }


  override isDestructive(_input?: NotebookEditToolParams): boolean {
    return true;
  }

  /**
   * Validation: extension check, edit_mode validation,
   * read-before-edit, staleness check, notebook JSON parsing, cell ID resolution.
   */
  protected override validateToolParamValues(
    params: NotebookEditToolParams,
  ): string | null {
    const notebookPath = rewritePosixDrivePath(params.notebook_path);
    const fullPath = path.isAbsolute(notebookPath)
      ? notebookPath
      : path.resolve(this.config.getTargetDir(), notebookPath);

    const edit_mode = params.edit_mode ?? 'replace';

    // .ipynb extension check
    if (path.extname(fullPath) !== '.ipynb') {
      return 'File must be a Jupyter notebook (.ipynb file). For editing other file types, use the Edit tool.';
    }

    // edit_mode validation
    if (
      edit_mode !== 'replace' &&
      edit_mode !== 'insert' &&
      edit_mode !== 'delete'
    ) {
      return 'Edit mode must be replace, insert, or delete.';
    }

    if (edit_mode !== 'delete' && params.new_source === undefined) {
      return 'New source is required unless using edit_mode=delete.';
    }

    // cell_type required for insert
    if (edit_mode === 'insert' && !params.cell_type) {
      return 'Cell type is required when using edit_mode=insert.';
    }

    // Read and parse notebook JSON for validation
    let content: string;
    try {
      const meta = readFileWithMetadata(fullPath);
      if (meta.notText) return notTextWriteRefusal(meta.notText);
      content = meta.content;
    } catch (e) {
      if (isNodeError(e) && e.code === 'ENOENT') {
        return 'Notebook file does not exist.';
      }
      throw e;
    }

    const parsed = safeParseJSON(stripBOM(content));
    if (!parsed) {
      return 'Notebook is not valid JSON.';
    }
    const notebook = normalizeNotebook(parsed as Partial<NotebookContent>);

    // cell_id validation
    if (!params.cell_id) {
      if (edit_mode !== 'insert') {
        return 'Cell ID must be specified when not inserting a new cell.';
      }
      // insert without cell_id → insert at beginning (valid for empty notebooks)
    } else if (edit_mode !== 'insert') {
      // For replace/delete, the target cell MUST exist
      const cellIndex = notebook.cells.findIndex(
        (cell) => cell.id === params.cell_id,
      );

      if (cellIndex === -1) {
        const parsedCellIndex = parseCellId(params.cell_id);
        if (parsedCellIndex !== undefined) {
          if (!notebook.cells[parsedCellIndex]) {
            return `Cell with index ${parsedCellIndex} does not exist in notebook.`;
          }
        } else {
          return `Cell with ID "${params.cell_id}" not found in notebook.`;
        }
      }
    }
    // For insert with cell_id, the cell_id is used as a position hint
    // ("insert after this cell"). If the cell doesn't exist, the execute
    // phase handles fallback gracefully (inserts at index 0).

    return null;
  }

  protected createInvocation(
    params: NotebookEditToolParams,
    toolName?: string,
    displayName?: string,
  ): ToolInvocation<NotebookEditToolParams, ToolResult> {
    return new NotebookEditToolInvocation(
      this.config,
      params,
      toolName,
      displayName,
    );
  }
}
