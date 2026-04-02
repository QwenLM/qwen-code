import * as fs from 'node:fs';
import * as path from 'node:path';
import * as Diff from 'diff';
import type {
  ToolCallConfirmationDetails,
  ToolEditConfirmationDetails,
  ToolInvocation,
  ToolLocation,
  ToolResult,
} from './tools.js';
import type { PermissionDecision } from '../permissions/types.js';
import { BaseDeclarativeTool, Kind, ToolConfirmationOutcome } from './tools.js';
import { ToolErrorType } from './tool-error.js';
import { makeRelative, shortenPath } from '../utils/paths.js';
import { isNodeError } from '../utils/errors.js';
import type { Config } from '../config/config.js';
import { ApprovalMode } from '../config/config.js';
import { DEFAULT_DIFF_OPTIONS, getDiffStat } from './diffOptions.js';
import { ToolNames, ToolDisplayNames } from './tool-names.js';
import { logFileOperation } from '../telemetry/loggers.js';
import { FileOperationEvent } from '../telemetry/types.js';
import { FileOperation } from '../telemetry/metrics.js';
import { parseNotebook, findCellIndex } from '../utils/notebookUtils.js';
import type { NotebookCell } from '../utils/notebookUtils.js';
import { IdeClient } from '../ide/ide-client.js';
import { detectLineEnding } from '../services/fileSystemService.js';
import type { LineEnding } from '../services/fileSystemService.js';

/**
 * Parameters for the NotebookEdit tool
 */
export interface NotebookEditToolParams {
  /** Absolute path to the .ipynb file */
  notebook_path: string;
  /** Cell ID or "cell-N" index. Required for replace/delete. For insert, new cell goes after this cell (or at start if omitted). */
  cell_id?: string;
  /** The new source content for the cell */
  new_source: string;
  /** Cell type: code or markdown. Required for insert mode. */
  cell_type?: 'code' | 'markdown';
  /** Edit mode: replace (default), insert, or delete */
  edit_mode?: 'replace' | 'insert' | 'delete';
}

class NotebookEditToolInvocation
  implements ToolInvocation<NotebookEditToolParams, ToolResult>
{
  constructor(
    private readonly config: Config,
    public params: NotebookEditToolParams,
  ) {}

  toolLocations(): ToolLocation[] {
    return [{ path: this.params.notebook_path }];
  }

  async getDefaultPermission(): Promise<PermissionDecision> {
    return 'ask';
  }

  getDescription(): string {
    const relativePath = makeRelative(
      this.params.notebook_path,
      this.config.getTargetDir(),
    );
    const mode = this.params.edit_mode ?? 'replace';
    const cellRef = this.params.cell_id ?? 'start';
    return `${shortenPath(relativePath)} (${mode} cell ${cellRef})`;
  }

  async getConfirmationDetails(
    abortSignal: AbortSignal,
  ): Promise<ToolCallConfirmationDetails> {
    let originalContent: string;
    try {
      originalContent = await fs.promises.readFile(
        this.params.notebook_path,
        'utf-8',
      );
    } catch (err) {
      if (abortSignal.aborted) throw err;
      throw new Error(
        `Cannot read notebook: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    let newContent: string;
    try {
      newContent = this.applyNotebookEdit(originalContent);
    } catch (err) {
      if (abortSignal.aborted) throw err;
      throw new Error(
        `Edit error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const fileName = path.basename(this.params.notebook_path);
    const fileDiff = Diff.createPatch(
      fileName,
      originalContent,
      newContent,
      'Current',
      'Proposed',
      DEFAULT_DIFF_OPTIONS,
    );

    const approvalMode = this.config.getApprovalMode();
    const ideClient = await IdeClient.getInstance();
    const ideConfirmation =
      this.config.getIdeMode() &&
      ideClient.isDiffingEnabled() &&
      approvalMode !== ApprovalMode.AUTO_EDIT &&
      approvalMode !== ApprovalMode.YOLO
        ? ideClient.openDiff(this.params.notebook_path, newContent)
        : undefined;

    const confirmationDetails: ToolEditConfirmationDetails = {
      type: 'edit',
      title: `Confirm Notebook Edit: ${shortenPath(makeRelative(this.params.notebook_path, this.config.getTargetDir()))}`,
      fileName,
      filePath: this.params.notebook_path,
      fileDiff,
      originalContent,
      newContent,
      onConfirm: async (outcome: ToolConfirmationOutcome) => {
        if (outcome === ToolConfirmationOutcome.ProceedAlways) {
          this.config.setApprovalMode(ApprovalMode.AUTO_EDIT);
        }
        if (ideConfirmation) {
          const result = await ideConfirmation;
          if (result.status === 'accepted' && result.content) {
            // IDE modified the content; we'll use it directly in execute
          }
        }
      },
      ideConfirmation,
    };
    return confirmationDetails;
  }

  /**
   * Apply the notebook edit to the raw JSON content and return the new content string.
   */
  private applyNotebookEdit(rawContent: string): string {
    const notebook = parseNotebook(rawContent);
    const editMode = this.params.edit_mode ?? 'replace';
    let cellType = this.params.cell_type;

    let cellIndex: number;
    if (!this.params.cell_id) {
      cellIndex = 0;
    } else {
      cellIndex = findCellIndex(notebook, this.params.cell_id);
      if (cellIndex === -1) {
        throw new Error(`Cell "${this.params.cell_id}" not found in notebook.`);
      }
      if (editMode === 'insert') {
        cellIndex += 1; // Insert after the specified cell
      }
    }

    // If replacing one-past-end, convert to insert
    let effectiveMode = editMode;
    if (effectiveMode === 'replace' && cellIndex === notebook.cells.length) {
      effectiveMode = 'insert';
      if (!cellType) cellType = 'code';
    }

    const generateCellId =
      notebook.nbformat > 4 ||
      (notebook.nbformat === 4 && notebook.nbformat_minor >= 5);

    if (effectiveMode === 'delete') {
      notebook.cells.splice(cellIndex, 1);
    } else if (effectiveMode === 'insert') {
      const newCell: NotebookCell = {
        cell_type: cellType ?? 'code',
        source: this.params.new_source,
        metadata: {},
        ...(generateCellId
          ? { id: Math.random().toString(36).substring(2, 15) }
          : {}),
        ...((cellType ?? 'code') === 'code'
          ? { execution_count: null, outputs: [] }
          : {}),
      };
      notebook.cells.splice(cellIndex, 0, newCell);
    } else {
      // replace
      const target = notebook.cells[cellIndex]!;
      target.source = this.params.new_source;
      if (target.cell_type === 'code') {
        target.execution_count = null;
        target.outputs = [];
      }
      if (cellType && cellType !== target.cell_type) {
        target.cell_type = cellType;
      }
    }

    return JSON.stringify(notebook, null, 1) + '\n';
  }

  async execute(signal: AbortSignal): Promise<ToolResult> {
    let originalContent: string;
    let detectedLineEnding: LineEnding = 'lf';

    try {
      originalContent = await fs.promises.readFile(
        this.params.notebook_path,
        'utf-8',
      );
      detectedLineEnding = detectLineEnding(originalContent);
    } catch (err) {
      if (signal.aborted) throw err;
      if (isNodeError(err) && err.code === 'ENOENT') {
        return {
          llmContent: `Notebook file not found: ${this.params.notebook_path}`,
          returnDisplay: 'Notebook file not found.',
          error: {
            message: `File not found: ${this.params.notebook_path}`,
            type: ToolErrorType.FILE_NOT_FOUND,
          },
        };
      }
      const msg = err instanceof Error ? err.message : String(err);
      return {
        llmContent: `Error reading notebook: ${msg}`,
        returnDisplay: `Error reading notebook: ${msg}`,
        error: { message: msg, type: ToolErrorType.READ_CONTENT_FAILURE },
      };
    }

    let newContent: string;
    try {
      newContent = this.applyNotebookEdit(originalContent);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        llmContent: `Error applying notebook edit: ${msg}`,
        returnDisplay: `Error: ${msg}`,
        error: { message: msg, type: ToolErrorType.NOTEBOOK_EDIT_FAILURE },
      };
    }

    // Restore original line endings if CRLF
    let contentToWrite = newContent;
    if (detectedLineEnding === 'crlf') {
      contentToWrite = newContent.replace(/\n/g, '\r\n');
    }

    try {
      // Ensure parent directory exists
      const dirName = path.dirname(this.params.notebook_path);
      if (!fs.existsSync(dirName)) {
        fs.mkdirSync(dirName, { recursive: true });
      }

      await fs.promises.writeFile(
        this.params.notebook_path,
        contentToWrite,
        'utf-8',
      );

      const fileName = path.basename(this.params.notebook_path);
      const fileDiff = Diff.createPatch(
        fileName,
        originalContent,
        newContent,
        'Current',
        'Proposed',
        DEFAULT_DIFF_OPTIONS,
      );
      const diffStat = getDiffStat(
        fileName,
        originalContent,
        newContent,
        newContent,
      );

      const editMode = this.params.edit_mode ?? 'replace';
      const cellRef = this.params.cell_id ?? 'start';

      logFileOperation(
        this.config,
        new FileOperationEvent(
          NotebookEditTool.Name,
          FileOperation.UPDATE,
          newContent.split('\n').length,
          'application/x-ipynb+json',
          '.ipynb',
          undefined,
        ),
      );

      const llmMessage =
        editMode === 'delete'
          ? `Deleted cell ${cellRef} from ${this.params.notebook_path}.`
          : editMode === 'insert'
            ? `Inserted new cell after ${cellRef} in ${this.params.notebook_path}.`
            : `Updated cell ${cellRef} in ${this.params.notebook_path}.`;

      return {
        llmContent: llmMessage,
        returnDisplay: {
          fileDiff,
          fileName,
          originalContent,
          newContent,
          diffStat,
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        llmContent: `Error writing notebook: ${msg}`,
        returnDisplay: `Error writing notebook: ${msg}`,
        error: { message: msg, type: ToolErrorType.FILE_WRITE_FAILURE },
      };
    }
  }
}

/**
 * Tool for editing Jupyter notebook (.ipynb) cells.
 * Supports replacing, inserting, and deleting cells.
 */
export class NotebookEditTool extends BaseDeclarativeTool<
  NotebookEditToolParams,
  ToolResult
> {
  static readonly Name = ToolNames.NOTEBOOK_EDIT;

  constructor(private readonly config: Config) {
    super(
      NotebookEditTool.Name,
      ToolDisplayNames.NOTEBOOK_EDIT,
      `Edits a Jupyter notebook (.ipynb) file by modifying, inserting, or deleting cells.

Operations:
- **replace** (default): Replaces the source of an existing cell. Resets execution count and clears outputs for code cells.
- **insert**: Inserts a new cell after the specified cell_id (or at the beginning if cell_id is omitted). Requires cell_type.
- **delete**: Removes the specified cell.

Cell identification: Use the cell's ID (as shown when reading the notebook) or numeric "cell-N" format (0-indexed).

Always read the notebook first with the ${ToolNames.READ_FILE} tool before editing.`,
      Kind.Edit,
      {
        properties: {
          notebook_path: {
            description:
              'The absolute path to the Jupyter notebook (.ipynb) file to edit. Must be an absolute path.',
            type: 'string',
          },
          cell_id: {
            description:
              'The ID of the cell to edit (from notebook read output) or "cell-N" format (0-indexed). Required for replace and delete. For insert, the new cell is placed after this cell (or at the start if omitted).',
            type: 'string',
          },
          new_source: {
            description:
              'The new source content for the cell. For delete mode, this is ignored.',
            type: 'string',
          },
          cell_type: {
            description:
              "The cell type: 'code' or 'markdown'. Required when inserting a new cell. For replace, changes the cell type if specified.",
            type: 'string',
            enum: ['code', 'markdown'],
          },
          edit_mode: {
            description:
              "The edit operation: 'replace' (default), 'insert', or 'delete'.",
            type: 'string',
            enum: ['replace', 'insert', 'delete'],
          },
        },
        required: ['notebook_path', 'new_source'],
        type: 'object',
      },
    );
  }

  protected override validateToolParamValues(
    params: NotebookEditToolParams,
  ): string | null {
    if (!params.notebook_path || params.notebook_path.trim() === '') {
      return "The 'notebook_path' parameter must be non-empty.";
    }

    if (!path.isAbsolute(params.notebook_path)) {
      return `Notebook path must be absolute: ${params.notebook_path}`;
    }

    if (path.extname(params.notebook_path).toLowerCase() !== '.ipynb') {
      return 'File must be a Jupyter notebook (.ipynb). Use the edit tool for other file types.';
    }

    const editMode = params.edit_mode ?? 'replace';
    if (!['replace', 'insert', 'delete'].includes(editMode)) {
      return "edit_mode must be 'replace', 'insert', or 'delete'.";
    }

    if (editMode === 'insert' && !params.cell_type) {
      return "cell_type is required when using edit_mode='insert'.";
    }

    if (editMode !== 'insert' && !params.cell_id) {
      return 'cell_id is required for replace and delete operations.';
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
    return new NotebookEditToolInvocation(this.config, params);
  }
}
