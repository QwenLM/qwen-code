// Force strict mode and setup for ESM
"use strict";
import {
  ARTIFACT_TITLE_MAX_LENGTH,
  ARTIFACT_WORKSPACE_PATH_MAX_LENGTH,
  OFFICE_DOCUMENT_EXTENSIONS,
  hasControlCharacter,
  hasUnsafeDisplayPayload,
  pathHasSkippedDirectoryComponent,
  toCanonicalWorkspaceArtifactPath
} from "./chunk-FXPP7VLM.js";
import {
  checkTeamMemorySecrets
} from "./chunk-7PQ65Z5F.js";
import {
  CommitAttributionService,
  FileEncoding,
  checkPriorRead,
  createPatchSmart,
  detectLineEnding,
  getDiffStat,
  needsUtf8Bom
} from "./chunk-MRTRBONQ.js";
import {
  FileOperationEvent,
  getLanguageFromFilePath,
  logFileOperation
} from "./chunk-KKGSJZWK.js";
import {
  isAnyAutoMemPath,
  isTeamAutoMemPath
} from "./chunk-RVT5L74D.js";
import {
  fileExists,
  getSpecificMimeType
} from "./chunk-25FMWESU.js";
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
import {
  getErrorMessage,
  isNodeError
} from "./chunk-S34QJ6IR.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/tools/write-file.ts
init_esbuild_shims();
import fs from "node:fs";
import path from "node:path";
var debugLogger = createDebugLogger("WRITE_FILE");
var ARTIFACT_KIND_BY_EXTENSION = /* @__PURE__ */ new Map([
  [".csv", "file"],
  [".htm", "html"],
  [".html", "html"],
  [".ipynb", "notebook"],
  [".jpeg", "image"],
  [".jpg", "image"],
  [".pdf", "pdf"],
  [".png", "image"],
  [".svg", "image"],
  [".webp", "image"]
]);
for (const ext of OFFICE_DOCUMENT_EXTENSIONS) {
  ARTIFACT_KIND_BY_EXTENSION.set(ext, "document");
}
var WriteFileToolInvocation = class extends BaseToolInvocation {
  constructor(config, params) {
    super(params);
    this.config = config;
  }
  static {
    __name(this, "WriteFileToolInvocation");
  }
  toolLocations() {
    return [{ path: this.params.file_path }];
  }
  getDescription() {
    const relativePath = makeRelative(
      this.params.file_path,
      this.config.getTargetDir()
    );
    return `Writing to ${shortenPath(relativePath)}`;
  }
  /**
   * Write operations always need user confirmation, except for the private
   * managed auto-memory files (user/project) which are written autonomously.
   * Team memory is shared and committed to the repo, so it is NOT auto-allowed
   * like the private tiers — writes default to 'ask'. (In AUTO_EDIT/YOLO the
   * user has globally opted into auto-approval; team writes still surface in the
   * git diff for review before commit.)
   */
  async getDefaultPermission() {
    const projectRoot = this.config.getProjectRoot();
    const filePath = path.resolve(this.params.file_path);
    if (isTeamAutoMemPath(filePath, projectRoot)) {
      return "ask";
    }
    if (isAnyAutoMemPath(filePath, projectRoot)) {
      return "allow";
    }
    return "ask";
  }
  /**
   * Constructs the write-file diff confirmation details.
   */
  async getConfirmationDetails(_abortSignal) {
    let originalContent = "";
    let fileExists2 = await fileExists(this.params.file_path);
    if (!this.config.getFileReadCacheDisabled()) {
      const decision = await checkPriorRead(
        this.config.getFileReadCache(),
        this.params.file_path,
        "overwriting"
      );
      if (!decision.ok) {
        throw new StructuredToolError(decision.rawMessage, decision.type);
      }
    }
    if (fileExists2) {
      try {
        const { content } = await this.config.getFileSystemService().readTextFile({ path: this.params.file_path });
        originalContent = content;
      } catch (err) {
        if (isNodeError(err) && err.code === "ENOENT") {
          fileExists2 = false;
        } else {
          throw new Error(
            `Error reading existing file for confirmation: ${getErrorMessage(err)}`
          );
        }
      }
    }
    if (fileExists2 && !this.config.getFileReadCacheDisabled()) {
      const postDecision = await checkPriorRead(
        this.config.getFileReadCache(),
        this.params.file_path,
        "overwriting",
        { expectExisting: true }
      );
      if (!postDecision.ok) {
        debugLogger.warn("post-read TOCTOU rejection (confirmation)", {
          path: this.params.file_path,
          reason: postDecision.type
        });
        throw new StructuredToolError(
          postDecision.rawMessage,
          postDecision.type
        );
      }
    }
    const relativePath = makeRelative(
      this.params.file_path,
      this.config.getTargetDir()
    );
    const fileName = path.basename(this.params.file_path);
    const fileDiff = createPatchSmart(
      fileName,
      originalContent,
      this.params.content,
      "Current",
      "Proposed"
    );
    const confirmationDetails = {
      type: "edit",
      title: `Confirm Write: ${shortenPath(relativePath)}`,
      fileName,
      filePath: this.params.file_path,
      fileDiff,
      originalContent,
      newContent: this.params.content,
      onConfirm: /* @__PURE__ */ __name(async (outcome) => {
        if (outcome === "proceed_always" /* ProceedAlways */) {
          this.config.setApprovalMode("auto-edit" /* AUTO_EDIT */);
        }
      }, "onConfirm")
    };
    return confirmationDetails;
  }
  async execute(_abortSignal) {
    const { file_path, content, ai_proposed_content, modified_by_user } = this.params;
    let fileExists2 = await fileExists(file_path);
    let originalContent = "";
    let useBOM = false;
    let detectedEncoding;
    let detectedLineEnding;
    const dirName = path.dirname(file_path);
    const teamMemoryError = checkTeamMemorySecrets(
      file_path,
      content,
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
    if (!this.config.getFileReadCacheDisabled()) {
      const decision = await checkPriorRead(
        this.config.getFileReadCache(),
        file_path,
        "overwriting"
      );
      if (!decision.ok) {
        return {
          llmContent: decision.rawMessage,
          returnDisplay: `Error: ${decision.displayMessage}`,
          error: {
            message: decision.rawMessage,
            type: decision.type
          }
        };
      }
    }
    if (fileExists2) {
      try {
        const fileInfo = await this.config.getFileSystemService().readTextFile({ path: file_path });
        if (fileInfo._meta?.bom !== void 0) {
          useBOM = fileInfo._meta.bom;
        } else {
          useBOM = fileInfo.content.length > 0 && fileInfo.content.codePointAt(0) === 65279;
        }
        detectedEncoding = fileInfo._meta?.encoding || "utf-8";
        detectedLineEnding = detectLineEnding(fileInfo.content);
        originalContent = fileInfo.content;
        fileExists2 = true;
      } catch (err) {
        if (isNodeError(err) && err.code === "ENOENT") {
          fileExists2 = false;
        } else {
          const error = {
            message: getErrorMessage(err),
            code: isNodeError(err) ? err.code : void 0
          };
          const errorMsg = error.code ? `Error checking existing file '${file_path}': ${error.message} (${error.code})` : `Error checking existing file: ${error.message}`;
          return {
            llmContent: errorMsg,
            returnDisplay: errorMsg,
            error: {
              message: errorMsg,
              type: "file_write_failure" /* FILE_WRITE_FAILURE */
            }
          };
        }
      }
    }
    if (fileExists2 && !this.config.getFileReadCacheDisabled()) {
      const postDecision = await checkPriorRead(
        this.config.getFileReadCache(),
        file_path,
        "overwriting",
        { expectExisting: true }
      );
      if (!postDecision.ok) {
        debugLogger.warn("post-read TOCTOU rejection (execute)", {
          path: file_path,
          reason: postDecision.type
        });
        return {
          llmContent: postDecision.rawMessage,
          returnDisplay: `Error: ${postDecision.displayMessage}`,
          error: {
            message: postDecision.rawMessage,
            type: postDecision.type
          }
        };
      }
    }
    if (!fileExists2) {
      const userEncoding = this.config.getDefaultFileEncoding();
      if (userEncoding === FileEncoding.UTF8_BOM) {
        useBOM = true;
      } else if (userEncoding === void 0) {
        useBOM = needsUtf8Bom(file_path);
      }
      detectedEncoding = void 0;
    }
    try {
      await this.config.getFileHistoryService().trackEdit(file_path);
    } catch {
    }
    if (!this.config.getFileReadCacheDisabled()) {
      const writeDecision = await checkPriorRead(
        this.config.getFileReadCache(),
        file_path,
        "overwriting",
        // If the file existed when we read it (`fileExists` is still
        // true after readTextFile), ENOENT here means the original
        // target disappeared between the post-read check and now —
        // reject rather than fall through and silently re-create the
        // file from stale bytes. For new-file creation
        // (`fileExists === false`), ENOENT is the expected pre-write
        // state (ok:true → writeTextFile creates).
        { expectExisting: fileExists2 }
      );
      if (!writeDecision.ok) {
        debugLogger.warn("pre-write TOCTOU rejection", {
          path: file_path,
          reason: writeDecision.type
        });
        return {
          llmContent: writeDecision.rawMessage,
          returnDisplay: `Error: ${writeDecision.displayMessage}`,
          error: {
            message: writeDecision.rawMessage,
            type: writeDecision.type
          }
        };
      }
    }
    if (!fileExists2) {
      fs.mkdirSync(dirName, { recursive: true });
    }
    try {
      await this.config.getFileSystemService().writeTextFile({
        path: file_path,
        content,
        toolWriteOrigin: "write_file",
        _meta: {
          bom: useBOM,
          encoding: detectedEncoding,
          lineEnding: detectedLineEnding
        }
      });
      if (!modified_by_user) {
        CommitAttributionService.getInstance().recordEdit(
          file_path,
          fileExists2 ? originalContent : null,
          content
        );
      }
      let postWriteSizeBytes;
      try {
        const postWriteStats = fs.statSync(file_path);
        postWriteSizeBytes = postWriteStats.size;
        this.config.getFileReadCache().recordWrite(file_path, postWriteStats);
      } catch {
      }
      const fileName = path.basename(file_path);
      const currentContentForDiff = originalContent;
      const fileDiff = createPatchSmart(
        fileName,
        currentContentForDiff,
        content,
        "Original",
        "Written"
      );
      const originallyProposedContent = ai_proposed_content || content;
      const diffStat = getDiffStat(
        fileName,
        currentContentForDiff,
        originallyProposedContent,
        content
      );
      const llmSuccessMessageParts = [
        !fileExists2 ? `Successfully created and wrote to new file: ${file_path}.` : `Successfully overwrote file: ${file_path}.`
      ];
      if (modified_by_user) {
        llmSuccessMessageParts.push(
          `User modified the \`content\` to be: ${content}`
        );
      }
      const artifact = this.params.record_as_artifact === false ? null : buildWorkspaceArtifactMetadata(
        this.config,
        file_path,
        postWriteSizeBytes
      );
      if (artifact) {
        llmSuccessMessageParts.push(
          formatRecordArtifactReminder(artifact.workspacePath)
        );
      }
      const mimetype = getSpecificMimeType(file_path);
      const programmingLanguage = getLanguageFromFilePath(file_path);
      const extension = path.extname(file_path);
      const operation = !fileExists2 ? "create" /* CREATE */ : "update" /* UPDATE */;
      const lineCount = content.split("\n").length;
      logFileOperation(
        this.config,
        new FileOperationEvent(
          WriteFileTool.Name,
          operation,
          lineCount,
          mimetype,
          extension,
          programmingLanguage
        )
      );
      const displayResult = {
        fileDiff,
        fileName,
        filePath: file_path,
        originalContent,
        newContent: content,
        diffStat
      };
      return {
        llmContent: llmSuccessMessageParts.join(" "),
        returnDisplay: displayResult,
        ...artifact ? { artifacts: [artifact] } : {}
      };
    } catch (error) {
      let errorMsg;
      let errorType = "file_write_failure" /* FILE_WRITE_FAILURE */;
      if (isNodeError(error)) {
        errorMsg = `Error writing to file '${file_path}': ${error.message} (${error.code})`;
        if (error.code === "EACCES") {
          errorMsg = `Permission denied writing to file: ${file_path} (${error.code})`;
          errorType = "permission_denied" /* PERMISSION_DENIED */;
        } else if (error.code === "ENOSPC") {
          errorMsg = `No space left on device: ${file_path} (${error.code})`;
          errorType = "no_space_left" /* NO_SPACE_LEFT */;
        } else if (error.code === "EISDIR") {
          errorMsg = `Target is a directory, not a file: ${file_path} (${error.code})`;
          errorType = "target_is_directory" /* TARGET_IS_DIRECTORY */;
        }
        if (this.config.getDebugMode() && error.stack) {
          debugLogger.debug("Write file error stack:", error.stack);
        }
      } else {
        errorMsg = `Error writing to file: ${getErrorMessage(error)}`;
      }
      return {
        llmContent: errorMsg,
        returnDisplay: errorMsg,
        error: {
          message: errorMsg,
          type: errorType
        }
      };
    }
  }
};
function buildRecordArtifactReminder(config, filePath) {
  const artifact = buildWorkspaceArtifactMetadata(config, filePath);
  return artifact ? formatRecordArtifactReminder(artifact.workspacePath) : null;
}
__name(buildRecordArtifactReminder, "buildRecordArtifactReminder");
function formatRecordArtifactReminder(workspacePath) {
  return `This file was automatically recorded as a workspace artifact with workspacePath "${workspacePath}". No extra artifact registration step is needed.`;
}
__name(formatRecordArtifactReminder, "formatRecordArtifactReminder");
function buildWorkspaceArtifactMetadata(config, filePath, sizeBytes) {
  const recorded = resolveRecordedWorkspaceFile(config, filePath);
  if (!recorded) {
    return null;
  }
  const title = path.basename(recorded.filePath);
  if (title.length > ARTIFACT_TITLE_MAX_LENGTH || hasControlCharacter(title) || hasUnsafeDisplayPayload(title) || recorded.workspacePath.length > ARTIFACT_WORKSPACE_PATH_MAX_LENGTH || hasControlCharacter(recorded.workspacePath) || hasUnsafeDisplayPayload(recorded.workspacePath)) {
    debugLogger.debug("workspace artifact skipped (safety checks)", {
      path: filePath
    });
    return null;
  }
  return {
    title,
    kind: inferWorkspaceArtifactKind(recorded.filePath),
    storage: "workspace",
    workspacePath: recorded.workspacePath,
    mimeType: getSpecificMimeType(recorded.filePath) ?? (recorded.filePath.toLowerCase().endsWith(".ipynb") ? "application/x-ipynb+json" : void 0),
    sizeBytes
  };
}
__name(buildWorkspaceArtifactMetadata, "buildWorkspaceArtifactMetadata");
function resolveRecordedWorkspaceFile(config, filePath) {
  if (!config.isRecordArtifactEnabled()) {
    return null;
  }
  let resolvedFile = filePath;
  let resolvedRoot = config.getTargetDir();
  try {
    resolvedFile = fs.realpathSync(filePath);
    resolvedRoot = fs.realpathSync(resolvedRoot);
  } catch {
  }
  if (!ARTIFACT_KIND_BY_EXTENSION.has(path.extname(resolvedFile).toLowerCase())) {
    return null;
  }
  const workspacePath = toCanonicalWorkspaceArtifactPath(
    resolvedFile,
    resolvedRoot
  );
  if (!workspacePath) {
    return null;
  }
  if (pathHasSkippedDirectoryComponent(workspacePath)) {
    return null;
  }
  return { filePath: resolvedFile, workspacePath };
}
__name(resolveRecordedWorkspaceFile, "resolveRecordedWorkspaceFile");
function inferWorkspaceArtifactKind(filePath) {
  return ARTIFACT_KIND_BY_EXTENSION.get(path.extname(filePath).toLowerCase()) ?? "file";
}
__name(inferWorkspaceArtifactKind, "inferWorkspaceArtifactKind");
var WriteFileTool = class _WriteFileTool extends BaseDeclarativeTool {
  constructor(config) {
    super(
      _WriteFileTool.Name,
      ToolDisplayNames.WRITE_FILE,
      `Writes content to a specified file in the local filesystem. A request to create or generate a file does not establish that the target path is new. Unless the target's absence or current text contents have already been established in this session, you MUST use the ${ToolNames.READ_FILE} tool first; if the file does not exist, then create it. With prior-read enforcement enabled, blind overwrites are rejected. The file_path argument MUST be an absolute path. Always construct it by combining the project root with the file's relative path (e.g. project root '/path/to/project/' + relative 'foo/bar.txt' = '/path/to/project/foo/bar.txt'). If the user provides a relative path, resolve it against the project root first.

Artifact-like files such as HTML, PDF, images, notebooks, and office documents are automatically registered as session artifacts. Intermediate files that exist only to produce another artifact \u2014 for example HTML written solely to print a PDF \u2014 must set record_as_artifact=false, or be written under .qwen/tmp/ so they are not registered. Delete those intermediates when done.

The user has the ability to modify \`content\`. If modified, this will be stated in the response.`,
      "edit" /* Edit */,
      {
        properties: {
          file_path: {
            description: "The absolute path to the file to write to (e.g., '/home/user/project/file.txt'). Relative paths are not supported.",
            type: "string"
          },
          content: {
            description: "The content to write to the file.",
            type: "string"
          },
          record_as_artifact: {
            description: "Set false for intermediate files that should not appear as session artifacts, such as HTML used only to print a PDF. Defaults to true for artifact-like extensions.",
            type: "boolean"
          }
        },
        required: ["file_path", "content"],
        type: "object"
      }
    );
    this.config = config;
  }
  static {
    __name(this, "WriteFileTool");
  }
  static Name = ToolNames.WRITE_FILE;
  validateToolParamValues(params) {
    const filePath = unescapePath(params.file_path.trim());
    params.file_path = filePath;
    if (!filePath) {
      return `Missing or empty "file_path"`;
    }
    if (!path.isAbsolute(filePath)) {
      return `File path must be absolute: ${filePath}`;
    }
    try {
      if (fs.existsSync(filePath)) {
        const stats = fs.lstatSync(filePath);
        if (stats.isDirectory()) {
          return `Path is a directory, not a file: ${filePath}`;
        }
      }
    } catch (statError) {
      return `Error accessing path properties for validation: ${filePath}. Reason: ${getErrorMessage(
        statError
      )}`;
    }
    const teamMemoryError = checkTeamMemorySecrets(
      filePath,
      params.content ?? "",
      this.config.getProjectRoot()
    );
    if (teamMemoryError) {
      return teamMemoryError;
    }
    return null;
  }
  createInvocation(params) {
    return new WriteFileToolInvocation(this.config, params);
  }
  toAutoClassifierInput(params) {
    const content = params.content ?? "";
    return {
      file_path: params.file_path,
      byte_count: Buffer.byteLength(content, "utf8"),
      content_preview: content.slice(0, 300),
      content_truncated: content.length > 300
    };
  }
  getModifyContext(_abortSignal) {
    return {
      getFilePath: /* @__PURE__ */ __name((params) => params.file_path, "getFilePath"),
      getCurrentContent: /* @__PURE__ */ __name(async (params) => {
        const fileExists2 = await fileExists(params.file_path);
        if (fileExists2) {
          try {
            const { content } = await this.config.getFileSystemService().readTextFile({ path: params.file_path });
            return content;
          } catch (err) {
            if (!isNodeError(err) || err.code !== "ENOENT") throw err;
            return "";
          }
        } else {
          return "";
        }
      }, "getCurrentContent"),
      getProposedContent: /* @__PURE__ */ __name(async (params) => params.content, "getProposedContent"),
      createUpdatedParams: /* @__PURE__ */ __name((_oldContent, modifiedProposedContent, originalParams) => {
        const content = originalParams.content;
        return {
          ...originalParams,
          ai_proposed_content: content,
          content: modifiedProposedContent,
          modified_by_user: true
        };
      }, "createUpdatedParams")
    };
  }
};

export {
  buildRecordArtifactReminder,
  buildWorkspaceArtifactMetadata,
  WriteFileTool
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
