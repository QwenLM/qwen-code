// Force strict mode and setup for ESM
"use strict";
import {
  checkTeamMemorySecrets
} from "./chunk-7PQ65Z5F.js";
import {
  CommitAttributionService,
  createPatchSmart,
  detectLineEnding,
  getDiffStat
} from "./chunk-MRTRBONQ.js";
import "./chunk-GOFAQQZA.js";
import "./chunk-65I7S4Z3.js";
import "./chunk-HEOH7JZY.js";
import "./chunk-TWPJO254.js";
import "./chunk-CQ35AJ4Z.js";
import "./chunk-4YS7RMCB.js";
import "./chunk-PQQV3OBW.js";
import "./chunk-ANKISCKU.js";
import "./chunk-4SZ2636R.js";
import "./chunk-5EZRLTLQ.js";
import "./chunk-QHWCP53L.js";
import "./chunk-C4FISGDN.js";
import "./chunk-O6GEWCJA.js";
import "./chunk-KS6F6LZQ.js";
import "./chunk-6PVPNMXU.js";
import "./chunk-OB57Y2WH.js";
import "./chunk-IMV5DBIP.js";
import "./chunk-IWMYX5LB.js";
import "./chunk-QJNDUTOL.js";
import "./chunk-QPTE6BKL.js";
import "./chunk-U6H3XTFA.js";
import "./chunk-ACHCT36C.js";
import "./chunk-CHEIIBT3.js";
import "./chunk-GHG4PQY2.js";
import "./chunk-YVYK3JYU.js";
import "./chunk-Q5N5NEVT.js";
import "./chunk-ADN5KESB.js";
import "./chunk-SK3RZOPS.js";
import "./chunk-EVZT24AF.js";
import "./chunk-ELRMZTPF.js";
import "./chunk-B5WYAQ4I.js";
import "./chunk-JX6XHPTX.js";
import "./chunk-6C3D7BKK.js";
import "./chunk-ZAQM5T2X.js";
import "./chunk-MNU36NGH.js";
import "./chunk-B3HGO6BB.js";
import "./chunk-AUFTA63J.js";
import "./chunk-SATGWSS6.js";
import "./chunk-MLXTMF7H.js";
import "./chunk-BQMSZSG6.js";
import "./chunk-WFNEY5G7.js";
import "./chunk-5FHOPPLZ.js";
import "./chunk-S6LOFUVP.js";
import "./chunk-BKVPLSEI.js";
import "./chunk-WNM6BA7E.js";
import "./chunk-S7UQ3V2H.js";
import "./chunk-QE36VXWP.js";
import "./chunk-2A6RZKP2.js";
import "./chunk-WDVSRQIQ.js";
import "./chunk-GXNXX7A2.js";
import "./chunk-IITTKFWM.js";
import "./chunk-Z72PLR74.js";
import "./chunk-NUQ4GK5I.js";
import "./chunk-KP2FHIFR.js";
import "./chunk-TLS6QN2S.js";
import "./chunk-NAVJD2PQ.js";
import "./chunk-KKPIFWTZ.js";
import "./chunk-NFC4WTY2.js";
import "./chunk-YSD6IY6F.js";
import "./chunk-DJ2GSRLV.js";
import "./chunk-MS4SXNJ6.js";
import "./chunk-GVTAFLWB.js";
import {
  FileOperationEvent,
  logFileOperation
} from "./chunk-KKGSJZWK.js";
import "./chunk-5ETULJLP.js";
import "./chunk-VGC4I5JJ.js";
import "./chunk-RVT5L74D.js";
import "./chunk-HD7O6WLV.js";
import {
  findCellIndex,
  getCellDisplayId,
  getNotebookLanguage,
  getSpecificMimeType,
  hasStableCellIds,
  inferInsertedCellSourceArrayStyle,
  inferNotebookJsonFormat,
  isAmbiguousCellId,
  makeCellId,
  normalizeEditedCell,
  normalizeSource,
  parseNotebook,
  serializeNotebook,
  toNotebookSource
} from "./chunk-25FMWESU.js";
import "./chunk-CFMZLE3L.js";
import "./chunk-43QUA4MC.js";
import "./chunk-WZAD4ZNJ.js";
import "./chunk-EKBQJ627.js";
import "./chunk-KUON6Z6R.js";
import "./chunk-XZA32HII.js";
import "./chunk-CA63HYHU.js";
import "./chunk-SBP43AO6.js";
import "./chunk-HHJLM3WQ.js";
import "./chunk-B3XJFEEH.js";
import "./chunk-74TONY4F.js";
import "./chunk-ZRQGTRHA.js";
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  StructuredToolError
} from "./chunk-VPGRGNNH.js";
import {
  ToolDisplayNames,
  ToolNames
} from "./chunk-ERIBG3BX.js";
import {
  createDebugLogger,
  makeRelative,
  shortenPath,
  unescapePath
} from "./chunk-ZYDMQCQP.js";
import "./chunk-S34QJ6IR.js";
import "./chunk-TBWQLLFO.js";
import "./chunk-UKMWZ5NS.js";
import "./chunk-75DOP5OR.js";
import "./chunk-DMTGGOSA.js";
import "./chunk-YQ3U5MUC.js";
import "./chunk-MATEIJZF.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/tools/notebook-edit.ts
init_esbuild_shims();
import * as fs from "node:fs";
import * as path from "node:path";
var debugLogger = createDebugLogger("NOTEBOOK_EDIT");
function rejectNotebookPriorRead(notebookPath, reason, decision) {
  debugLogger.debug("prior-read-rejected", {
    path: notebookPath,
    reason,
    type: decision.type,
    displayMessage: decision.displayMessage
  });
  return decision;
}
__name(rejectNotebookPriorRead, "rejectNotebookPriorRead");
var NotebookEditError = class extends Error {
  constructor(message, type) {
    super(message);
    this.type = type;
    this.name = "NotebookEditError";
  }
  static {
    __name(this, "NotebookEditError");
  }
};
function requireNotebookSource(source, mode) {
  if (mode === "delete") {
    return "";
  }
  if (typeof source !== "string") {
    throw new NotebookEditError(
      `new_source is required when edit_mode is "${mode}".`,
      "invalid_tool_params" /* INVALID_TOOL_PARAMS */
    );
  }
  return source;
}
__name(requireNotebookSource, "requireNotebookSource");
function displayCellId(cell, index) {
  return cell ? getCellDisplayId(cell, index) : `cell-${index}`;
}
__name(displayCellId, "displayCellId");
function resolveTargetIndex(notebook, cellId, mode) {
  if (!cellId) {
    if (mode === "insert") {
      return -1;
    }
    throw new NotebookEditError(
      "cell_id is required for replace and delete operations.",
      "invalid_tool_params" /* INVALID_TOOL_PARAMS */
    );
  }
  if (isAmbiguousCellId(notebook, cellId)) {
    throw new NotebookEditError(
      `Cell ID "${cellId}" is ambiguous in the rendered notebook. Re-read the notebook and target a stable real cell ID before editing.`,
      "invalid_tool_params" /* INVALID_TOOL_PARAMS */
    );
  }
  const index = findCellIndex(notebook, cellId);
  if (index === -1) {
    throw new NotebookEditError(
      `Cell with ID "${cellId}" not found in notebook.`,
      "notebook_cell_not_found" /* NOTEBOOK_CELL_NOT_FOUND */
    );
  }
  return index;
}
__name(resolveTargetIndex, "resolveTargetIndex");
function createNotebookCell(notebook, cellType, source, preferSourceArray) {
  const cell = {
    cell_type: cellType,
    metadata: {},
    source: toNotebookSource(source, preferSourceArray)
  };
  const id = makeCellId(notebook);
  if (id) {
    cell.id = id;
  }
  normalizeEditedCell(cell, cellType);
  return cell;
}
__name(createNotebookCell, "createNotebookCell");
function applyNotebookEdit(rawContent, params) {
  let notebook;
  try {
    notebook = parseNotebook(rawContent);
  } catch (error) {
    throw new NotebookEditError(
      error instanceof Error ? error.message : String(error),
      "notebook_invalid_json" /* NOTEBOOK_INVALID_JSON */
    );
  }
  const mode = params.edit_mode ?? "replace";
  const source = requireNotebookSource(params.new_source, mode);
  const originalHasStableCellIds = hasStableCellIds(notebook);
  const targetIndex = resolveTargetIndex(notebook, params.cell_id, mode);
  const language = getNotebookLanguage(notebook);
  const jsonFormat = inferNotebookJsonFormat(rawContent);
  const buildResult = /* @__PURE__ */ __name((updatedNotebook, result) => {
    const structuralEdit = mode === "insert" || mode === "delete";
    return {
      ...result,
      updatedContent: serializeNotebook(updatedNotebook, jsonFormat),
      requiresReadAfterWrite: structuralEdit && !(originalHasStableCellIds && hasStableCellIds(updatedNotebook))
    };
  }, "buildResult");
  switch (mode) {
    case "insert": {
      const cellType = params.cell_type ?? "code";
      const insertAt = targetIndex === -1 ? 0 : targetIndex + 1;
      const newCell = createNotebookCell(
        notebook,
        cellType,
        source,
        inferInsertedCellSourceArrayStyle(notebook, insertAt)
      );
      notebook.cells.splice(insertAt, 0, newCell);
      return buildResult(notebook, {
        editedCellId: displayCellId(newCell, insertAt),
        editedCellType: cellType,
        language,
        mode
      });
    }
    case "delete": {
      const [removed] = notebook.cells.splice(targetIndex, 1);
      return buildResult(notebook, {
        editedCellId: displayCellId(removed, targetIndex),
        editedCellType: removed?.cell_type,
        language,
        mode
      });
    }
    case "replace": {
      const target = notebook.cells[targetIndex];
      if (!target) {
        throw new NotebookEditError(
          `Cell index ${targetIndex} is out of range.`,
          "notebook_cell_not_found" /* NOTEBOOK_CELL_NOT_FOUND */
        );
      }
      const finalType = params.cell_type ?? target.cell_type;
      target.source = toNotebookSource(source, Array.isArray(target.source));
      normalizeEditedCell(target, finalType);
      return buildResult(notebook, {
        editedCellId: displayCellId(target, targetIndex),
        editedCellType: finalType,
        language,
        mode
      });
    }
    default:
      throw new NotebookEditError(
        `Unsupported notebook edit mode: ${mode}`,
        "invalid_tool_params" /* INVALID_TOOL_PARAMS */
      );
  }
}
__name(applyNotebookEdit, "applyNotebookEdit");
function prepareModifiedNotebookContent(originalContent, modifiedContent, params) {
  let notebook;
  let originalNotebook;
  try {
    notebook = parseNotebook(modifiedContent);
    originalNotebook = parseNotebook(originalContent);
  } catch (error) {
    throw new NotebookEditError(
      error instanceof Error ? error.message : String(error),
      "notebook_invalid_json" /* NOTEBOOK_INVALID_JSON */
    );
  }
  return {
    updatedContent: modifiedContent,
    editedCellId: params.cell_id ?? "user-modified-notebook",
    editedCellType: void 0,
    language: getNotebookLanguage(notebook),
    mode: params.edit_mode ?? "replace",
    requiresReadAfterWrite: !hasStableCellIds(originalNotebook) || !hasStableCellIds(notebook)
  };
}
__name(prepareModifiedNotebookContent, "prepareModifiedNotebookContent");
async function checkPriorNotebookRead(config, notebookPath, options = {}) {
  if (config.getFileReadCacheDisabled()) {
    return { ok: true };
  }
  let stats;
  try {
    stats = await fs.promises.stat(notebookPath);
  } catch (error) {
    const code = error?.code;
    if (code === "ENOENT") {
      if (options.expectExisting) {
        return rejectNotebookPriorRead(notebookPath, "missing-after-read", {
          ok: false,
          type: "file_changed_since_read" /* FILE_CHANGED_SINCE_READ */,
          rawMessage: `Notebook ${notebookPath} disappeared after it was read. Re-read it with the ${ToolNames.READ_FILE} tool before editing it.`,
          displayMessage: `notebook disappeared after last read; re-run ${ToolNames.READ_FILE} first.`
        });
      }
      return { ok: true };
    }
    return rejectNotebookPriorRead(notebookPath, "stat-failed", {
      ok: false,
      type: "prior_read_verification_failed" /* PRIOR_READ_VERIFICATION_FAILED */,
      rawMessage: `Could not stat ${notebookPath} to verify prior notebook read (${code ?? "unknown error"}). Re-read it with the ${ToolNames.READ_FILE} tool before editing it.`,
      displayMessage: `cannot verify prior read of ${notebookPath}; re-run ${ToolNames.READ_FILE} before editing this notebook.`
    });
  }
  if (stats.isDirectory()) {
    return rejectNotebookPriorRead(notebookPath, "target-is-directory", {
      ok: false,
      type: "target_is_directory" /* TARGET_IS_DIRECTORY */,
      rawMessage: `${notebookPath} is a directory. The NotebookEdit tool only operates on .ipynb files.`,
      displayMessage: "path is a directory; cannot edit as a notebook."
    });
  }
  if (!stats.isFile()) {
    return rejectNotebookPriorRead(notebookPath, "target-not-regular-file", {
      ok: false,
      type: "target_not_regular_file" /* TARGET_NOT_REGULAR_FILE */,
      rawMessage: `${notebookPath} is not a regular file. The NotebookEdit tool only operates on .ipynb files.`,
      displayMessage: "special file; cannot edit as a notebook."
    });
  }
  const status = config.getFileReadCache().check(stats);
  if (status.state === "fresh" && status.entry.lastReadAt !== void 0 && status.entry.lastReadWasFull) {
    return { ok: true };
  }
  if (status.state === "fresh" && status.entry.lastReadAt !== void 0 && !status.entry.lastReadWasFull) {
    return rejectNotebookPriorRead(notebookPath, "truncated-cache-entry", {
      ok: false,
      type: "edit_requires_prior_read" /* EDIT_REQUIRES_PRIOR_READ */,
      rawMessage: `Notebook ${notebookPath} is too large for cell-level editing because its rendered output was truncated when read. Reduce the notebook output size or split the notebook before editing cells.`,
      displayMessage: "notebook too large for cell-level editing."
    });
  }
  if (status.state === "stale") {
    return rejectNotebookPriorRead(notebookPath, "stale-cache-entry", {
      ok: false,
      type: "file_changed_since_read" /* FILE_CHANGED_SINCE_READ */,
      rawMessage: `Notebook ${notebookPath} has been modified since you last read it. Re-read it with the ${ToolNames.READ_FILE} tool before editing it.`,
      displayMessage: `notebook changed since last read; re-run ${ToolNames.READ_FILE} first.`
    });
  }
  if (status.state === "unverifiable") {
    return rejectNotebookPriorRead(notebookPath, "unverifiable-cache-entry", {
      ok: false,
      type: "prior_read_verification_failed" /* PRIOR_READ_VERIFICATION_FAILED */,
      rawMessage: `Notebook ${notebookPath} is on a filesystem that does not provide a verifiable inode identity (ino=0), so NotebookEdit cannot safely confirm a prior read. Use a different mechanism to edit this notebook.`,
      displayMessage: `cannot verify prior read of ${notebookPath}; use a different mechanism to edit it.`
    });
  }
  return rejectNotebookPriorRead(notebookPath, `cache-${status.state}`, {
    ok: false,
    type: "edit_requires_prior_read" /* EDIT_REQUIRES_PRIOR_READ */,
    rawMessage: `Notebook ${notebookPath} has not been fully read in this session. Use the ${ToolNames.READ_FILE} tool first, without offset or limit, before editing cells.`,
    displayMessage: `${ToolNames.READ_FILE} required before editing this notebook.`
  });
}
__name(checkPriorNotebookRead, "checkPriorNotebookRead");
var NotebookEditInvocation = class extends BaseToolInvocation {
  constructor(config, params, modifyMetadata) {
    super(params);
    this.config = config;
    this.modifyMetadata = modifyMetadata;
  }
  static {
    __name(this, "NotebookEditInvocation");
  }
  toolLocations() {
    return [{ path: this.params.notebook_path }];
  }
  getDescription() {
    const relativePath = makeRelative(
      this.params.notebook_path,
      this.config.getTargetDir()
    );
    const mode = this.params.edit_mode ?? "replace";
    const cell = this.params.cell_id ?? "beginning";
    return `${mode} notebook cell ${cell} in ${shortenPath(relativePath)}`;
  }
  async getDefaultPermission() {
    return "ask";
  }
  async getConfirmationDetails(abortSignal) {
    const prepared = await this.prepareEdit(abortSignal);
    const fileName = path.basename(this.params.notebook_path);
    const fileDiff = createPatchSmart(
      fileName,
      prepared.originalContent,
      prepared.updatedContent,
      "Current",
      "Proposed"
    );
    const confirmationDetails = {
      type: "edit",
      title: `Confirm Notebook Edit: ${shortenPath(makeRelative(this.params.notebook_path, this.config.getTargetDir()))}`,
      fileName,
      filePath: this.params.notebook_path,
      fileDiff,
      originalContent: prepared.originalContent,
      newContent: prepared.updatedContent,
      onConfirm: /* @__PURE__ */ __name(async (outcome) => {
        if (outcome === "proceed_always" /* ProceedAlways */) {
          this.config.setApprovalMode("auto-edit" /* AUTO_EDIT */);
        }
      }, "onConfirm")
    };
    return confirmationDetails;
  }
  async prepareEdit(abortSignal) {
    const preDecision = await checkPriorNotebookRead(
      this.config,
      this.params.notebook_path
    );
    if (!preDecision.ok) {
      throw new StructuredToolError(preDecision.rawMessage, preDecision.type);
    }
    let originalContent;
    let bom = false;
    let encoding;
    let lineEnding = "lf";
    try {
      const fileInfo = await this.config.getFileSystemService().readTextFile({
        path: this.params.notebook_path
      });
      originalContent = fileInfo.content;
      bom = fileInfo._meta?.bom ?? false;
      encoding = fileInfo._meta?.encoding;
      lineEnding = fileInfo._meta?.lineEnding ?? detectLineEnding(fileInfo.content);
    } catch (error) {
      if (abortSignal.aborted) {
        throw error;
      }
      const code = error?.code;
      if (code === "ENOENT") {
        throw new StructuredToolError(
          `Notebook file not found: ${this.params.notebook_path}`,
          "file_not_found" /* FILE_NOT_FOUND */
        );
      }
      throw new StructuredToolError(
        `Error reading notebook: ${error instanceof Error ? error.message : String(error)}`,
        "read_content_failure" /* READ_CONTENT_FAILURE */
      );
    }
    const postDecision = await checkPriorNotebookRead(
      this.config,
      this.params.notebook_path,
      { expectExisting: true }
    );
    if (!postDecision.ok) {
      throw new StructuredToolError(postDecision.rawMessage, postDecision.type);
    }
    try {
      if (this.modifyMetadata?.modifiedNotebookContent !== void 0) {
        return {
          ...prepareModifiedNotebookContent(
            originalContent,
            this.modifyMetadata.modifiedNotebookContent,
            this.params
          ),
          originalContent,
          bom,
          encoding,
          lineEnding
        };
      }
      return {
        ...applyNotebookEdit(originalContent, this.params),
        originalContent,
        bom,
        encoding,
        lineEnding
      };
    } catch (error) {
      if (error instanceof NotebookEditError) {
        throw new StructuredToolError(error.message, error.type);
      }
      throw error;
    }
  }
  async execute(signal) {
    let prepared;
    try {
      prepared = await this.prepareEdit(signal);
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      const errorType = error instanceof StructuredToolError ? error.errorType : "notebook_edit_failure" /* NOTEBOOK_EDIT_FAILURE */;
      const message = error instanceof Error ? error.message : String(error);
      return {
        llmContent: message,
        returnDisplay: `Error: ${message}`,
        error: {
          message,
          type: errorType
        }
      };
    }
    const teamMemoryError = checkTeamMemorySecrets(
      this.params.notebook_path,
      prepared.updatedContent,
      this.config.getProjectRoot()
    );
    if (teamMemoryError) {
      return {
        llmContent: `[ERROR: ${teamMemoryError}]`,
        returnDisplay: teamMemoryError,
        error: {
          message: teamMemoryError,
          type: "invalid_tool_params" /* INVALID_TOOL_PARAMS */
        }
      };
    }
    try {
      try {
        await this.config.getFileHistoryService().trackEdit(this.params.notebook_path);
      } catch {
      }
      const writeDecision = await checkPriorNotebookRead(
        this.config,
        this.params.notebook_path,
        { expectExisting: true }
      );
      if (!writeDecision.ok) {
        return {
          llmContent: writeDecision.rawMessage,
          returnDisplay: `Error: ${writeDecision.displayMessage}`,
          error: {
            message: writeDecision.rawMessage,
            type: writeDecision.type
          }
        };
      }
      await this.config.getFileSystemService().writeTextFile({
        path: this.params.notebook_path,
        content: prepared.updatedContent,
        toolWriteOrigin: "notebook_edit",
        _meta: {
          bom: prepared.bom,
          encoding: prepared.encoding,
          lineEnding: prepared.lineEnding
        }
      });
      if (!this.modifyMetadata?.modifiedByUser) {
        CommitAttributionService.getInstance().recordEdit(
          this.params.notebook_path,
          prepared.originalContent,
          prepared.updatedContent
        );
      }
      try {
        const postWriteStats = fs.statSync(this.params.notebook_path);
        const cache = this.config.getFileReadCache();
        if (prepared.requiresReadAfterWrite) {
          cache.invalidate(postWriteStats);
        } else {
          cache.recordWrite(this.params.notebook_path, postWriteStats, {
            cacheable: false
          });
        }
      } catch (error) {
        debugLogger.warn(
          `[NotebookEdit] post-write cache update failed for ${this.params.notebook_path}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      const fileName = path.basename(this.params.notebook_path);
      const fileDiff = createPatchSmart(
        fileName,
        prepared.originalContent,
        prepared.updatedContent,
        "Current",
        "Proposed"
      );
      const diffStat = getDiffStat(
        fileName,
        prepared.originalContent,
        this.modifyMetadata?.aiProposedContent ?? prepared.updatedContent,
        prepared.updatedContent
      );
      logFileOperation(
        this.config,
        new FileOperationEvent(
          NotebookEditTool.Name,
          "update" /* UPDATE */,
          prepared.updatedContent.split("\n").length,
          getSpecificMimeType(this.params.notebook_path),
          ".ipynb",
          prepared.language
        )
      );
      const displayResult = {
        fileDiff,
        fileName,
        filePath: this.params.notebook_path,
        originalContent: prepared.originalContent,
        newContent: prepared.updatedContent,
        diffStat
      };
      const llmContent = this.modifyMetadata?.modifiedNotebookContent !== void 0 ? `Notebook ${this.params.notebook_path} has been updated. Notebook content was modified by the user before approval; the final saved notebook may differ from the original ${prepared.mode} cell ${prepared.editedCellId} proposal.` : `Notebook ${this.params.notebook_path} has been updated. ${prepared.mode} cell ${prepared.editedCellId}.${prepared.mode === "delete" ? "" : `

Updated source:

---

${normalizeSource(this.params.new_source ?? "")}`}`;
      return {
        llmContent,
        returnDisplay: displayResult,
        resultFilePaths: [this.params.notebook_path]
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        llmContent: `Error writing notebook: ${message}`,
        returnDisplay: `Error writing notebook: ${message}`,
        error: {
          message,
          type: "file_write_failure" /* FILE_WRITE_FAILURE */
        }
      };
    }
  }
};
var NotebookEditTool = class _NotebookEditTool extends BaseDeclarativeTool {
  constructor(config) {
    super(
      _NotebookEditTool.Name,
      ToolDisplayNames.NOTEBOOK_EDIT,
      `Edits a Jupyter notebook (.ipynb) safely at the cell level. Use this instead of ${ToolNames.EDIT} or ${ToolNames.WRITE_FILE} for notebook cells. Supports replacing, inserting, and deleting cells. Always read the notebook first with ${ToolNames.READ_FILE}; then use the cell IDs shown in that output.`,
      "edit" /* Edit */,
      {
        properties: {
          notebook_path: {
            description: "Absolute path to the Jupyter notebook file to edit. Must end with .ipynb.",
            type: "string"
          },
          cell_id: {
            description: "Target cell ID from read_file output, or cell-N 0-based fallback. Required for replace and delete. For insert, the new cell is inserted after this cell; if omitted, inserted at the beginning.",
            type: "string"
          },
          new_source: {
            description: "New source content for replace and insert operations. Not required for delete.",
            type: "string"
          },
          cell_type: {
            description: "Cell type for inserted cells or type conversion on replace.",
            type: "string",
            enum: ["code", "markdown"]
          },
          edit_mode: {
            description: "Notebook edit operation. Defaults to replace.",
            type: "string",
            enum: ["replace", "insert", "delete"]
          }
        },
        required: ["notebook_path"],
        additionalProperties: false,
        type: "object"
      }
    );
    this.config = config;
  }
  static {
    __name(this, "NotebookEditTool");
  }
  static Name = ToolNames.NOTEBOOK_EDIT;
  modifyMetadataByParams = /* @__PURE__ */ new WeakMap();
  modifyMetadataByKey = /* @__PURE__ */ new Map();
  validateToolParamValues(params) {
    params.notebook_path = unescapePath(params.notebook_path.trim());
    if (!params.notebook_path) {
      return "The 'notebook_path' parameter must be non-empty.";
    }
    if (!path.isAbsolute(params.notebook_path)) {
      return `Notebook path must be absolute: ${params.notebook_path}`;
    }
    if (path.extname(params.notebook_path).toLowerCase() !== ".ipynb") {
      return "File must be a Jupyter notebook (.ipynb). Use the edit tool for other file types.";
    }
    const mode = params.edit_mode ?? "replace";
    if (!["replace", "insert", "delete"].includes(mode)) {
      return "edit_mode must be 'replace', 'insert', or 'delete'.";
    }
    if (params.cell_type && !["code", "markdown"].includes(params.cell_type)) {
      return "cell_type must be 'code' or 'markdown'.";
    }
    if (mode !== "insert" && !params.cell_id) {
      return "cell_id is required for replace and delete operations.";
    }
    if (mode !== "delete" && typeof params.new_source !== "string") {
      return `new_source is required when edit_mode is "${mode}".`;
    }
    const fileService = this.config.getFileService();
    if (fileService.shouldQwenIgnoreFile(params.notebook_path)) {
      return `File path '${params.notebook_path}' is ignored by ${fileService.getQwenIgnoreFileDisplayForPath(params.notebook_path)} pattern(s).`;
    }
    if (typeof params.new_source === "string") {
      const teamMemoryError = checkTeamMemorySecrets(
        params.notebook_path,
        params.new_source,
        this.config.getProjectRoot()
      );
      if (teamMemoryError) {
        return teamMemoryError;
      }
    }
    return null;
  }
  createInvocation(params) {
    return new NotebookEditInvocation(
      this.config,
      params,
      this.consumeModifyMetadata(params)
    );
  }
  getModifyMetadataKey(params) {
    return JSON.stringify({
      notebook_path: unescapePath(params.notebook_path.trim()),
      cell_id: params.cell_id,
      new_source: params.new_source,
      cell_type: params.cell_type,
      edit_mode: params.edit_mode
    });
  }
  rememberModifyMetadata(params, metadata) {
    this.modifyMetadataByParams.set(params, metadata);
    const key = this.getModifyMetadataKey(params);
    const queue = this.modifyMetadataByKey.get(key) ?? [];
    queue.push(metadata);
    this.modifyMetadataByKey.set(key, queue);
  }
  consumeModifyMetadata(params) {
    const metadata = this.modifyMetadataByParams.get(params);
    if (metadata) {
      this.modifyMetadataByParams.delete(params);
      this.removeQueuedModifyMetadata(params, metadata);
      return metadata;
    }
    const key = this.getModifyMetadataKey(params);
    const queue = this.modifyMetadataByKey.get(key);
    const queuedMetadata = queue?.shift();
    if (queue && queue.length === 0) {
      this.modifyMetadataByKey.delete(key);
    }
    return queuedMetadata;
  }
  removeQueuedModifyMetadata(params, metadata) {
    const key = this.getModifyMetadataKey(params);
    const queue = this.modifyMetadataByKey.get(key);
    if (!queue) {
      return;
    }
    const index = queue.indexOf(metadata);
    if (index !== -1) {
      queue.splice(index, 1);
    }
    if (queue.length === 0) {
      this.modifyMetadataByKey.delete(key);
    }
  }
  getModifyContext(_abortSignal) {
    const currentContentSnapshots = /* @__PURE__ */ new Map();
    const readCurrentContentSnapshot = /* @__PURE__ */ __name(async (params) => {
      const cached = currentContentSnapshots.get(params.notebook_path);
      if (cached !== void 0) {
        return cached;
      }
      const { content } = await this.config.getFileSystemService().readTextFile({ path: params.notebook_path });
      currentContentSnapshots.set(params.notebook_path, content);
      return content;
    }, "readCurrentContentSnapshot");
    return {
      getFilePath: /* @__PURE__ */ __name((params) => params.notebook_path, "getFilePath"),
      getCurrentContent: /* @__PURE__ */ __name(async (params) => readCurrentContentSnapshot(params), "getCurrentContent"),
      getProposedContent: /* @__PURE__ */ __name(async (params) => {
        const content = await readCurrentContentSnapshot(params);
        return applyNotebookEdit(content, params).updatedContent;
      }, "getProposedContent"),
      createUpdatedParams: /* @__PURE__ */ __name((oldContent, modifiedProposedContent, originalParams) => {
        let aiProposedContent = this.modifyMetadataByParams.get(originalParams)?.aiProposedContent;
        if (aiProposedContent === void 0) {
          try {
            aiProposedContent = applyNotebookEdit(
              oldContent,
              originalParams
            ).updatedContent;
          } catch {
            aiProposedContent = modifiedProposedContent;
          }
        }
        const updatedParams = {
          ...originalParams
        };
        this.rememberModifyMetadata(updatedParams, {
          aiProposedContent,
          modifiedByUser: true,
          modifiedNotebookContent: modifiedProposedContent
        });
        return updatedParams;
      }, "createUpdatedParams")
    };
  }
};
export {
  NotebookEditTool,
  applyNotebookEdit
};
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
