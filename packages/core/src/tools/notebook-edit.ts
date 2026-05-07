/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as Diff from 'diff';
import type { Config } from '../config/config.js';
import { ApprovalMode } from '../config/config.js';
import { detectLineEnding } from '../services/fileSystemService.js';
import type { LineEnding } from '../services/fileSystemService.js';
import type {
  ToolCallConfirmationDetails,
  ToolEditConfirmationDetails,
  ToolInvocation,
  ToolLocation,
  ToolResult,
} from './tools.js';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  ToolConfirmationOutcome,
} from './tools.js';
import type { PermissionDecision } from '../permissions/types.js';
import { DEFAULT_DIFF_OPTIONS, getDiffStat } from './diffOptions.js';
import { FileOperation } from '../telemetry/metrics.js';
import { FileOperationEvent } from '../telemetry/types.js';
import { logFileOperation } from '../telemetry/loggers.js';
import { getSpecificMimeType } from '../utils/fileUtils.js';
import { makeRelative, shortenPath, unescapePath } from '../utils/paths.js';
import {
  findCellIndex,
  getNotebookLanguage,
  inferNotebookSourceArrayStyle,
  makeCellId,
  normalizeEditedCell,
  normalizeSource,
  parseNotebook,
  serializeNotebook,
  toNotebookSource,
  type EditableNotebookCellType,
  type NotebookCell,
  type NotebookCellType,
} from '../utils/notebook.js';
import { ToolDisplayNames, ToolNames } from './tool-names.js';
import { ToolErrorType } from './tool-error.js';
import { StructuredToolError } from './priorReadEnforcement.js';

export type NotebookEditMode = 'replace' | 'insert' | 'delete';

export interface NotebookEditToolParams {
  notebook_path: string;
  cell_id?: string;
  new_source?: string;
  cell_type?: EditableNotebookCellType;
  edit_mode?: NotebookEditMode;
}

interface NotebookEditResult {
  updatedContent: string;
  editedCellId: string;
  editedCellType?: NotebookCellType;
  language: string;
  mode: NotebookEditMode;
}

interface PreparedNotebookEdit extends NotebookEditResult {
  originalContent: string;
  bom: boolean;
  encoding: string | undefined;
  lineEnding: LineEnding;
}

type NotebookPriorReadDecision =
  | { ok: true }
  | {
      ok: false;
      type: ToolErrorType;
      rawMessage: string;
      displayMessage: string;
    };

class NotebookEditError extends Error {
  constructor(
    message: string,
    readonly type: ToolErrorType,
  ) {
    super(message);
    this.name = 'NotebookEditError';
  }
}

function requireNotebookSource(
  source: string | undefined,
  mode: NotebookEditMode,
): string {
  if (mode === 'delete') {
    return '';
  }
  if (typeof source !== 'string') {
    throw new NotebookEditError(
      `new_source is required when edit_mode is "${mode}".`,
      ToolErrorType.INVALID_TOOL_PARAMS,
    );
  }
  return source;
}

function displayCellId(cell: NotebookCell | undefined, index: number): string {
  return cell?.id ?? `cell-${index}`;
}

function resolveTargetIndex(
  notebook: ReturnType<typeof parseNotebook>,
  cellId: string | undefined,
  mode: NotebookEditMode,
): number {
  if (!cellId) {
    if (mode === 'insert') {
      return -1;
    }
    throw new NotebookEditError(
      'cell_id is required for replace and delete operations.',
      ToolErrorType.INVALID_TOOL_PARAMS,
    );
  }

  const index = findCellIndex(notebook, cellId);
  if (index === -1) {
    throw new NotebookEditError(
      `Cell with ID "${cellId}" not found in notebook.`,
      ToolErrorType.NOTEBOOK_CELL_NOT_FOUND,
    );
  }
  return index;
}

function createNotebookCell(
  notebook: ReturnType<typeof parseNotebook>,
  cellType: EditableNotebookCellType,
  source: string,
): NotebookCell {
  const cell: NotebookCell = {
    cell_type: cellType,
    metadata: {},
    source: toNotebookSource(source, inferNotebookSourceArrayStyle(notebook)),
  };
  const id = makeCellId(notebook);
  if (id) {
    cell.id = id;
  }
  normalizeEditedCell(cell, cellType);
  return cell;
}

export function applyNotebookEdit(
  rawContent: string,
  params: NotebookEditToolParams,
): NotebookEditResult {
  let notebook: ReturnType<typeof parseNotebook>;
  try {
    notebook = parseNotebook(rawContent);
  } catch (error) {
    throw new NotebookEditError(
      error instanceof Error ? error.message : String(error),
      ToolErrorType.NOTEBOOK_INVALID_JSON,
    );
  }

  const mode = params.edit_mode ?? 'replace';
  const source = requireNotebookSource(params.new_source, mode);
  const targetIndex = resolveTargetIndex(notebook, params.cell_id, mode);
  const language = getNotebookLanguage(notebook);

  switch (mode) {
    case 'insert': {
      const cellType = params.cell_type ?? 'code';
      const newCell = createNotebookCell(notebook, cellType, source);
      const insertAt = targetIndex === -1 ? 0 : targetIndex + 1;
      notebook.cells.splice(insertAt, 0, newCell);
      return {
        updatedContent: serializeNotebook(notebook),
        editedCellId: displayCellId(newCell, insertAt),
        editedCellType: cellType,
        language,
        mode,
      };
    }

    case 'delete': {
      const [removed] = notebook.cells.splice(targetIndex, 1);
      return {
        updatedContent: serializeNotebook(notebook),
        editedCellId: displayCellId(removed, targetIndex),
        editedCellType: removed?.cell_type,
        language,
        mode,
      };
    }

    case 'replace': {
      const target = notebook.cells[targetIndex];
      if (!target) {
        throw new NotebookEditError(
          `Cell index ${targetIndex} is out of range.`,
          ToolErrorType.NOTEBOOK_CELL_NOT_FOUND,
        );
      }

      const finalType = params.cell_type ?? target.cell_type;
      target.source = toNotebookSource(source, Array.isArray(target.source));
      normalizeEditedCell(target, finalType);
      return {
        updatedContent: serializeNotebook(notebook),
        editedCellId: displayCellId(target, targetIndex),
        editedCellType: finalType,
        language,
        mode,
      };
    }

    default:
      throw new NotebookEditError(
        `Unsupported notebook edit mode: ${mode}`,
        ToolErrorType.INVALID_TOOL_PARAMS,
      );
  }
}

async function checkPriorNotebookRead(
  config: Config,
  notebookPath: string,
  options: { expectExisting?: boolean } = {},
): Promise<NotebookPriorReadDecision> {
  if (config.getFileReadCacheDisabled()) {
    return { ok: true };
  }

  let stats: fs.Stats;
  try {
    stats = await fs.promises.stat(notebookPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') {
      if (options.expectExisting) {
        return {
          ok: false,
          type: ToolErrorType.FILE_CHANGED_SINCE_READ,
          rawMessage: `Notebook ${notebookPath} disappeared after it was read. Re-read it with the ${ToolNames.READ_FILE} tool before editing it.`,
          displayMessage: `notebook disappeared after last read; re-run ${ToolNames.READ_FILE} first.`,
        };
      }
      return { ok: true };
    }

    return {
      ok: false,
      type: ToolErrorType.PRIOR_READ_VERIFICATION_FAILED,
      rawMessage: `Could not stat ${notebookPath} to verify prior notebook read (${code ?? 'unknown error'}). Re-read it with the ${ToolNames.READ_FILE} tool before editing it.`,
      displayMessage: `cannot verify prior read of ${notebookPath}; re-run ${ToolNames.READ_FILE} before editing this notebook.`,
    };
  }

  if (stats.isDirectory()) {
    return {
      ok: false,
      type: ToolErrorType.TARGET_IS_DIRECTORY,
      rawMessage: `${notebookPath} is a directory. The NotebookEdit tool only operates on .ipynb files.`,
      displayMessage: 'path is a directory; cannot edit as a notebook.',
    };
  }

  if (!stats.isFile()) {
    return {
      ok: false,
      type: ToolErrorType.EDIT_REQUIRES_PRIOR_READ,
      rawMessage: `${notebookPath} is not a regular file. The NotebookEdit tool only operates on .ipynb files.`,
      displayMessage: 'special file; cannot edit as a notebook.',
    };
  }

  const status = config.getFileReadCache().check(stats);
  if (
    status.state === 'fresh' &&
    status.entry.lastReadAt !== undefined &&
    status.entry.lastReadWasFull
  ) {
    return { ok: true };
  }

  if (status.state === 'stale') {
    return {
      ok: false,
      type: ToolErrorType.FILE_CHANGED_SINCE_READ,
      rawMessage: `Notebook ${notebookPath} has been modified since you last read it. Re-read it with the ${ToolNames.READ_FILE} tool before editing it.`,
      displayMessage: `notebook changed since last read; re-run ${ToolNames.READ_FILE} first.`,
    };
  }

  return {
    ok: false,
    type: ToolErrorType.EDIT_REQUIRES_PRIOR_READ,
    rawMessage: `Notebook ${notebookPath} has not been fully read in this session. Use the ${ToolNames.READ_FILE} tool first, without offset or limit, before editing cells.`,
    displayMessage: `${ToolNames.READ_FILE} required before editing this notebook.`,
  };
}

class NotebookEditInvocation extends BaseToolInvocation<
  NotebookEditToolParams,
  ToolResult
> {
  constructor(
    private readonly config: Config,
    params: NotebookEditToolParams,
  ) {
    super(params);
  }

  override toolLocations(): ToolLocation[] {
    return [{ path: this.params.notebook_path }];
  }

  override getDescription(): string {
    const relativePath = makeRelative(
      this.params.notebook_path,
      this.config.getTargetDir(),
    );
    const mode = this.params.edit_mode ?? 'replace';
    const cell = this.params.cell_id ?? 'beginning';
    return `${mode} notebook cell ${cell} in ${shortenPath(relativePath)}`;
  }

  override async getDefaultPermission(): Promise<PermissionDecision> {
    return 'ask';
  }

  override async getConfirmationDetails(
    abortSignal: AbortSignal,
  ): Promise<ToolCallConfirmationDetails> {
    const prepared = await this.prepareEdit(abortSignal);
    const fileName = path.basename(this.params.notebook_path);
    const fileDiff = Diff.createPatch(
      fileName,
      prepared.originalContent,
      prepared.updatedContent,
      'Current',
      'Proposed',
      DEFAULT_DIFF_OPTIONS,
    );

    const confirmationDetails: ToolEditConfirmationDetails = {
      type: 'edit',
      title: `Confirm Notebook Edit: ${shortenPath(makeRelative(this.params.notebook_path, this.config.getTargetDir()))}`,
      fileName,
      filePath: this.params.notebook_path,
      fileDiff,
      originalContent: prepared.originalContent,
      newContent: prepared.updatedContent,
      onConfirm: async (outcome: ToolConfirmationOutcome) => {
        if (outcome === ToolConfirmationOutcome.ProceedAlways) {
          this.config.setApprovalMode(ApprovalMode.AUTO_EDIT);
        }
      },
    };
    return confirmationDetails;
  }

  private async prepareEdit(
    abortSignal: AbortSignal,
  ): Promise<PreparedNotebookEdit> {
    const preDecision = await checkPriorNotebookRead(
      this.config,
      this.params.notebook_path,
    );
    if (!preDecision.ok) {
      throw new StructuredToolError(preDecision.rawMessage, preDecision.type);
    }

    let originalContent: string;
    let bom = false;
    let encoding: string | undefined;
    let lineEnding: LineEnding = 'lf';
    try {
      const fileInfo = await this.config.getFileSystemService().readTextFile({
        path: this.params.notebook_path,
      });
      originalContent = fileInfo.content;
      bom = fileInfo._meta?.bom ?? false;
      encoding = fileInfo._meta?.encoding;
      lineEnding =
        fileInfo._meta?.lineEnding ?? detectLineEnding(fileInfo.content);
    } catch (error) {
      if (abortSignal.aborted) {
        throw error;
      }
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === 'ENOENT') {
        throw new StructuredToolError(
          `Notebook file not found: ${this.params.notebook_path}`,
          ToolErrorType.FILE_NOT_FOUND,
        );
      }
      throw new StructuredToolError(
        `Error reading notebook: ${
          error instanceof Error ? error.message : String(error)
        }`,
        ToolErrorType.READ_CONTENT_FAILURE,
      );
    }

    const postDecision = await checkPriorNotebookRead(
      this.config,
      this.params.notebook_path,
      { expectExisting: true },
    );
    if (!postDecision.ok) {
      throw new StructuredToolError(postDecision.rawMessage, postDecision.type);
    }

    try {
      return {
        ...applyNotebookEdit(originalContent, this.params),
        originalContent,
        bom,
        encoding,
        lineEnding,
      };
    } catch (error) {
      if (error instanceof NotebookEditError) {
        throw new StructuredToolError(error.message, error.type);
      }
      throw error;
    }
  }

  override async execute(signal: AbortSignal): Promise<ToolResult> {
    let prepared: PreparedNotebookEdit;
    try {
      prepared = await this.prepareEdit(signal);
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      const errorType =
        error instanceof StructuredToolError
          ? error.errorType
          : ToolErrorType.NOTEBOOK_EDIT_FAILURE;
      const message = error instanceof Error ? error.message : String(error);
      return {
        llmContent: message,
        returnDisplay: `Error: ${message}`,
        error: {
          message,
          type: errorType,
        },
      };
    }

    const writeDecision = await checkPriorNotebookRead(
      this.config,
      this.params.notebook_path,
      { expectExisting: true },
    );
    if (!writeDecision.ok) {
      return {
        llmContent: writeDecision.rawMessage,
        returnDisplay: `Error: ${writeDecision.displayMessage}`,
        error: {
          message: writeDecision.rawMessage,
          type: writeDecision.type,
        },
      };
    }

    try {
      await this.config.getFileSystemService().writeTextFile({
        path: this.params.notebook_path,
        content: prepared.updatedContent,
        _meta: {
          bom: prepared.bom,
          encoding: prepared.encoding,
          lineEnding: prepared.lineEnding,
        },
      });

      try {
        const postWriteStats = fs.statSync(this.params.notebook_path);
        this.config
          .getFileReadCache()
          .recordWrite(this.params.notebook_path, postWriteStats, {
            cacheable: false,
          });
      } catch {
        // Non-fatal: the write succeeded. A subsequent read will re-stat and
        // refresh the cache if this best-effort cache update failed.
      }

      const fileName = path.basename(this.params.notebook_path);
      const fileDiff = Diff.createPatch(
        fileName,
        prepared.originalContent,
        prepared.updatedContent,
        'Current',
        'Proposed',
        DEFAULT_DIFF_OPTIONS,
      );
      const diffStat = getDiffStat(
        fileName,
        prepared.originalContent,
        prepared.updatedContent,
        prepared.updatedContent,
      );

      logFileOperation(
        this.config,
        new FileOperationEvent(
          NotebookEditTool.Name,
          FileOperation.UPDATE,
          prepared.updatedContent.split('\n').length,
          getSpecificMimeType(this.params.notebook_path),
          '.ipynb',
          prepared.language,
        ),
      );

      const displayResult = {
        fileDiff,
        fileName,
        originalContent: prepared.originalContent,
        newContent: prepared.updatedContent,
        diffStat,
      };

      const sourcePreview =
        prepared.mode === 'delete'
          ? ''
          : `\n\nUpdated source:\n\n---\n\n${normalizeSource(this.params.new_source ?? '')}`;
      return {
        llmContent: `Notebook ${this.params.notebook_path} has been updated. ${prepared.mode} cell ${prepared.editedCellId}.${sourcePreview}`,
        returnDisplay: displayResult,
        resultFilePaths: [this.params.notebook_path],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        llmContent: `Error writing notebook: ${message}`,
        returnDisplay: `Error writing notebook: ${message}`,
        error: {
          message,
          type: ToolErrorType.FILE_WRITE_FAILURE,
        },
      };
    }
  }
}

export class NotebookEditTool extends BaseDeclarativeTool<
  NotebookEditToolParams,
  ToolResult
> {
  static readonly Name = ToolNames.NOTEBOOK_EDIT;

  constructor(private readonly config: Config) {
    super(
      NotebookEditTool.Name,
      ToolDisplayNames.NOTEBOOK_EDIT,
      `Edits a Jupyter notebook (.ipynb) safely at the cell level. Use this instead of ${ToolNames.EDIT} or ${ToolNames.WRITE_FILE} for notebook cells. Supports replacing, inserting, and deleting cells. Always read the notebook first with ${ToolNames.READ_FILE}; then use the cell IDs shown in that output.`,
      Kind.Edit,
      {
        properties: {
          notebook_path: {
            description:
              'Absolute path to the Jupyter notebook file to edit. Must end with .ipynb.',
            type: 'string',
          },
          cell_id: {
            description:
              'Target cell ID from read_file output, or cell-N 0-based fallback. Required for replace and delete. For insert, the new cell is inserted after this cell; if omitted, inserted at the beginning.',
            type: 'string',
          },
          new_source: {
            description:
              'New source content for replace and insert operations. Not required for delete.',
            type: 'string',
          },
          cell_type: {
            description:
              'Cell type for inserted cells or type conversion on replace.',
            type: 'string',
            enum: ['code', 'markdown'],
          },
          edit_mode: {
            description: 'Notebook edit operation. Defaults to replace.',
            type: 'string',
            enum: ['replace', 'insert', 'delete'],
          },
        },
        required: ['notebook_path'],
        type: 'object',
      },
    );
  }

  protected override validateToolParamValues(
    params: NotebookEditToolParams,
  ): string | null {
    params.notebook_path = unescapePath(params.notebook_path.trim());

    if (!params.notebook_path) {
      return "The 'notebook_path' parameter must be non-empty.";
    }

    if (!path.isAbsolute(params.notebook_path)) {
      return `Notebook path must be absolute: ${params.notebook_path}`;
    }

    if (path.extname(params.notebook_path).toLowerCase() !== '.ipynb') {
      return 'File must be a Jupyter notebook (.ipynb). Use the edit tool for other file types.';
    }

    const mode = params.edit_mode ?? 'replace';
    if (!['replace', 'insert', 'delete'].includes(mode)) {
      return "edit_mode must be 'replace', 'insert', or 'delete'.";
    }

    if (params.cell_type && !['code', 'markdown'].includes(params.cell_type)) {
      return "cell_type must be 'code' or 'markdown'.";
    }

    if (mode !== 'insert' && !params.cell_id) {
      return 'cell_id is required for replace and delete operations.';
    }

    if (mode !== 'delete' && typeof params.new_source !== 'string') {
      return `new_source is required when edit_mode is "${mode}".`;
    }

    const fileService = this.config.getFileService();
    if (fileService.shouldQwenIgnoreFile(params.notebook_path)) {
      return `File path '${params.notebook_path}' is ignored by .qwenignore pattern(s).`;
    }

    return null;
  }

  protected createInvocation(
    params: NotebookEditToolParams,
  ): ToolInvocation<NotebookEditToolParams, ToolResult> {
    return new NotebookEditInvocation(this.config, params);
  }
}
