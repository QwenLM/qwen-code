// Force strict mode and setup for ESM
"use strict";
import {
  isWithinRoot
} from "./chunk-25FMWESU.js";
import {
  BaseDeclarativeTool,
  BaseToolInvocation
} from "./chunk-VPGRGNNH.js";
import {
  ToolDisplayNames,
  ToolNames
} from "./chunk-ERIBG3BX.js";
import {
  isNodeError
} from "./chunk-S34QJ6IR.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/tools/record-artifact.ts
init_esbuild_shims();
import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import fs2 from "node:fs/promises";
import path3 from "node:path";

// packages/core/src/utils/workspace-artifact-directory.ts
init_esbuild_shims();
import { promises as fs } from "node:fs";
import path from "node:path";
var MAX_DIRECTORY_ARTIFACT_FILES = 100;
var MAX_DIRECTORY_ARTIFACT_DEPTH = 4;
var SKIP_DIRECTORY_ARTIFACT_NAMES = /* @__PURE__ */ new Set([
  "node_modules",
  ".git",
  "__pycache__",
  "dist",
  ".qwen"
]);
var OFFICE_DOCUMENT_EXTENSIONS = /* @__PURE__ */ new Set([
  ".doc",
  ".docx",
  ".docm",
  ".dotx",
  ".xls",
  ".xlsx",
  ".xlsm",
  ".xlsb",
  ".ppt",
  ".pptx",
  ".pptm",
  ".odt",
  ".ods",
  ".odp"
]);
function isOfficeDocumentExtension(ext) {
  return OFFICE_DOCUMENT_EXTENSIONS.has(ext);
}
__name(isOfficeDocumentExtension, "isOfficeDocumentExtension");
function shouldSkipDirectoryArtifactName(name) {
  return name.startsWith(".") || name.startsWith("~$") || SKIP_DIRECTORY_ARTIFACT_NAMES.has(name);
}
__name(shouldSkipDirectoryArtifactName, "shouldSkipDirectoryArtifactName");
var WORKTREE_ARTIFACT_PREFIX_RE = /^\.qwen\/worktrees\/[^/]+\//;
function stripWorktreeArtifactPrefix(workspacePath) {
  return workspacePath.replace(WORKTREE_ARTIFACT_PREFIX_RE, "");
}
__name(stripWorktreeArtifactPrefix, "stripWorktreeArtifactPrefix");
function pathHasSkippedDirectoryComponent(workspacePath) {
  return stripWorktreeArtifactPrefix(workspacePath).split("/").filter(Boolean).some((segment) => shouldSkipDirectoryArtifactName(segment));
}
__name(pathHasSkippedDirectoryComponent, "pathHasSkippedDirectoryComponent");
async function collectRecordableWorkspaceFiles(absoluteDir, relativeDir, realWorkspace, isRecordable) {
  const files = [];
  const walked = await walkRecordableWorkspaceFiles(
    absoluteDir,
    relativeDir,
    realWorkspace,
    files,
    0,
    isRecordable
  );
  return { files, ...walked };
}
__name(collectRecordableWorkspaceFiles, "collectRecordableWorkspaceFiles");
async function walkRecordableWorkspaceFiles(absoluteDir, relativeDir, realWorkspace, files, depth, isRecordable) {
  if (files.length >= MAX_DIRECTORY_ARTIFACT_FILES) {
    return {
      truncated: true,
      depthLimited: false,
      unreadable: false,
      skippedUnrecordable: 0
    };
  }
  if (depth > MAX_DIRECTORY_ARTIFACT_DEPTH) {
    return {
      truncated: false,
      depthLimited: await hasRecordableDescendant(
        absoluteDir,
        relativeDir,
        8,
        isRecordable
      ),
      unreadable: false,
      skippedUnrecordable: 0
    };
  }
  let entries;
  try {
    entries = await fs.readdir(absoluteDir, { withFileTypes: true });
  } catch (error) {
    if (depth === 0) {
      throw error;
    }
    return {
      truncated: false,
      depthLimited: false,
      unreadable: true,
      skippedUnrecordable: 0
    };
  }
  entries.sort(
    (left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0
  );
  let truncated = false;
  let depthLimited = false;
  let unreadable = false;
  let skippedUnrecordable = 0;
  for (const entry of entries) {
    if (files.length >= MAX_DIRECTORY_ARTIFACT_FILES) {
      return { truncated: true, depthLimited, unreadable, skippedUnrecordable };
    }
    if (entry.isSymbolicLink()) {
      continue;
    }
    const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    const absolutePath = path.join(absoluteDir, entry.name);
    const relativeToWorkspace = path.relative(realWorkspace, absolutePath);
    if (!relativeToWorkspace || isOutsidePath(relativeToWorkspace)) {
      continue;
    }
    if (entry.isDirectory()) {
      if (shouldSkipDirectoryArtifactName(entry.name)) {
        continue;
      }
      const nested = await walkRecordableWorkspaceFiles(
        absolutePath,
        relativePath,
        realWorkspace,
        files,
        depth + 1,
        isRecordable
      );
      truncated ||= nested.truncated;
      depthLimited ||= nested.depthLimited;
      unreadable ||= nested.unreadable;
      skippedUnrecordable += nested.skippedUnrecordable;
      if (truncated && files.length >= MAX_DIRECTORY_ARTIFACT_FILES) {
        return {
          truncated: true,
          depthLimited,
          unreadable,
          skippedUnrecordable
        };
      }
      continue;
    }
    if (entry.isFile()) {
      if (entry.name.startsWith(".") || entry.name.startsWith("~$")) {
        continue;
      }
      if (isRecordable && !isRecordable(relativePath)) {
        skippedUnrecordable++;
        continue;
      }
      files.push(relativePath);
    }
  }
  return { truncated, depthLimited, unreadable, skippedUnrecordable };
}
__name(walkRecordableWorkspaceFiles, "walkRecordableWorkspaceFiles");
async function hasRecordableDescendant(absoluteDir, relativeDir, remainingDepth, isRecordable) {
  if (remainingDepth < 0) {
    return true;
  }
  let entries;
  try {
    entries = await fs.readdir(absoluteDir, { withFileTypes: true });
  } catch {
    return true;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      continue;
    }
    const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    if (entry.isFile() && !entry.name.startsWith(".") && !entry.name.startsWith("~$")) {
      if (!isRecordable || isRecordable(relativePath)) {
        return true;
      }
      continue;
    }
    if (entry.isDirectory() && !shouldSkipDirectoryArtifactName(entry.name)) {
      try {
        if (await hasRecordableDescendant(
          path.join(absoluteDir, entry.name),
          relativePath,
          remainingDepth - 1,
          isRecordable
        )) {
          return true;
        }
      } catch {
        continue;
      }
    }
  }
  return false;
}
__name(hasRecordableDescendant, "hasRecordableDescendant");
function isOutsidePath(relative) {
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}
__name(isOutsidePath, "isOutsidePath");

// packages/core/src/utils/workspace-artifact-path.ts
init_esbuild_shims();
import path2 from "node:path";
var WORKTREE_DIR_RE = /^(.*)[\\/]\.qwen[\\/]worktrees[\\/][^\\/]+$/;
function resolveBoundWorkspaceRoot(targetDir) {
  const resolved = path2.resolve(targetDir);
  const match = resolved.match(WORKTREE_DIR_RE);
  if (!match) {
    return resolved;
  }
  const base = match[1];
  if (!base) {
    return path2.parse(resolved).root;
  }
  if (/^[A-Za-z]:$/.test(base)) {
    return `${base}${path2.sep}`;
  }
  return base;
}
__name(resolveBoundWorkspaceRoot, "resolveBoundWorkspaceRoot");
function toCanonicalWorkspaceArtifactPath(absoluteFilePath, targetDir) {
  const baseDir = resolveBoundWorkspaceRoot(targetDir);
  const relativePath = path2.relative(baseDir, path2.resolve(absoluteFilePath));
  if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${path2.sep}`) || path2.isAbsolute(relativePath)) {
    return null;
  }
  return relativePath.split(path2.sep).join("/");
}
__name(toCanonicalWorkspaceArtifactPath, "toCanonicalWorkspaceArtifactPath");

// packages/core/src/tools/record-artifact.ts
var DESCRIPTION = `Registers a session artifact so clients can show it in an artifacts panel. Use it after creating a useful file, URL, image, report, notebook, or other intermediate result that the user may want to open later, unless the producing tool already returned artifact metadata. For example, write_file automatically records HTML, image, PDF, notebook, CSV, and office documents it writes inside the workspace, so do not call record_artifact again for the same workspacePath; still call it for other formats such as Markdown, JSON, and plain text, and for files produced outside write_file. When the session creates a remote resource, such as a pull request, issue, or comment submitted via gh, record its URL with kind "link" and the url locator so the user can reopen it later.

Provide exactly one locator: workspacePath, managedId, or url. Do not use the old "path" field. Use the Artifact tool, not record_artifact, for published interactive HTML artifacts.

For workspace files, workspacePath must be relative to the current execution directory (for example "report.csv" or "reports/summary.html") or an absolute path inside the bound workspace. Do not add workspace folder prefixes such as "w/agent/", and do not use ".." to walk up from a worktree. This tool resolves the path and verifies it stays inside the workspace. A regular file is stored as one workspace-root-relative canonical workspacePath. A directory is never stored as an artifact; each recordable file inside it is recorded separately. Word, Excel, PowerPoint, and other office documents use kind "document". A successful file result includes status=available, the canonical workspacePath, and resolvedPath. A successful directory result lists the expanded files instead of "Recorded artifact". If verification fails, the tool returns an error \u2014 do not tell the user the artifact can be opened or downloaded.`;
var ARTIFACT_TITLE_MAX_LENGTH = 200;
var ARTIFACT_WORKSPACE_PATH_MAX_LENGTH = 500;
var WORKSPACE_PATH_HINT = '"workspacePath" must be relative to the current execution directory (for example "report.csv") or an absolute path inside the workspace. Do not add workspace folder prefixes such as "w/agent/".';
var RecordArtifactInvocation = class extends BaseToolInvocation {
  constructor(params, config) {
    super(params);
    this.config = config;
  }
  static {
    __name(this, "RecordArtifactInvocation");
  }
  getDescription() {
    return `Recording artifact ${this.params.title}`;
  }
  async execute(_signal) {
    const workspacePathInput = trimOptional(this.params.workspacePath);
    if (workspacePathInput) {
      const locator = await resolveWorkspaceArtifactLocator(
        workspacePathInput,
        this.config
      );
      if (!locator.ok) {
        return {
          llmContent: locator.message,
          returnDisplay: locator.message,
          error: {
            message: locator.message,
            type: locator.type
          }
        };
      }
      if (locator.isDirectory) {
        return this.expandDirectoryLocator(locator);
      }
      const artifact2 = {
        title: this.params.title.trim(),
        kind: this.params.kind,
        storage: "workspace",
        description: trimOptional(this.params.description),
        workspacePath: locator.workspacePath,
        mimeType: trimOptional(this.params.mimeType),
        sizeBytes: this.params.sizeBytes ?? locator.sizeBytes,
        metadata: this.params.metadata
      };
      return {
        llmContent: formatWorkspaceSuccess(artifact2.title, locator),
        returnDisplay: formatWorkspaceSuccess(artifact2.title, locator),
        artifacts: [artifact2]
      };
    }
    const artifact = {
      title: this.params.title.trim(),
      kind: this.params.kind,
      storage: this.params.storage ?? inferStorage(this.params),
      description: trimOptional(this.params.description),
      managedId: trimOptional(this.params.managedId),
      url: trimOptional(this.params.url),
      mimeType: trimOptional(this.params.mimeType),
      sizeBytes: this.params.sizeBytes,
      metadata: this.params.metadata
    };
    return {
      llmContent: `Recorded artifact "${artifact.title}".`,
      returnDisplay: `Recorded artifact **${artifact.title}**.`,
      artifacts: [artifact]
    };
  }
  async expandDirectoryLocator(locator) {
    if (pathHasSkippedDirectoryComponent(locator.workspacePath)) {
      const message2 = [
        `Failed to record artifact: "${locator.workspacePath}" is a skipped directory and cannot be recorded.`,
        WORKSPACE_PATH_HINT
      ].join("\n");
      return {
        llmContent: message2,
        returnDisplay: message2,
        error: {
          message: message2,
          type: "target_is_directory" /* TARGET_IS_DIRECTORY */
        }
      };
    }
    let collected;
    try {
      collected = await collectRecordableWorkspaceFiles(
        locator.resolvedPath,
        locator.workspacePath,
        locator.workspaceRoot,
        (workspacePath) => isRecordableDerivedChild(
          path3.posix.basename(workspacePath),
          workspacePath
        )
      );
    } catch (error) {
      const failure = pathInspectFailure(
        error,
        locator.resolvedPath,
        locator.workspacePath,
        `Failed to record artifact: could not inspect "${locator.workspacePath}" (${error instanceof Error ? error.message : String(error)}).`
      );
      return {
        llmContent: failure.message,
        returnDisplay: failure.message,
        error: {
          message: failure.message,
          type: failure.type
        }
      };
    }
    if (collected.files.length === 0) {
      const message2 = [
        collected.depthLimited ? `Failed to record artifact: "${locator.workspacePath}" is a directory whose recordable files are deeper than ${MAX_DIRECTORY_ARTIFACT_DEPTH} levels.` : `Failed to record artifact: "${locator.workspacePath}" is a directory with no recordable files.`,
        WORKSPACE_PATH_HINT
      ].join("\n");
      return {
        llmContent: message2,
        returnDisplay: message2,
        error: {
          message: message2,
          type: "target_is_directory" /* TARGET_IS_DIRECTORY */
        }
      };
    }
    if (metadataExceedsBudget(this.params.metadata)) {
      const message2 = "Failed to record artifact: metadata is too large to expand a directory.";
      return {
        llmContent: message2,
        returnDisplay: message2,
        error: {
          message: message2,
          type: "invalid_tool_params" /* INVALID_TOOL_PARAMS */
        }
      };
    }
    const parentTitle = this.params.title.trim();
    const parentDescription = trimOptional(this.params.description);
    const artifacts = [];
    for (const workspacePath of collected.files) {
      const title = path3.posix.basename(workspacePath).trim();
      const description = parentDescription || (parentTitle && parentTitle !== title ? parentTitle : void 0);
      artifacts.push({
        title,
        storage: "workspace",
        workspacePath,
        metadata: {
          ...this.params.metadata,
          expandedFromDirectory: true
        },
        ...description ? { description } : {}
      });
    }
    const message = formatDirectoryExpansion(locator, {
      ...collected,
      files: artifacts.map((artifact) => artifact.workspacePath)
    });
    return {
      llmContent: message,
      returnDisplay: message,
      artifacts
    };
  }
};
var RecordArtifactTool = class _RecordArtifactTool extends BaseDeclarativeTool {
  constructor(config) {
    super(
      _RecordArtifactTool.Name,
      ToolDisplayNames.RECORD_ARTIFACT,
      DESCRIPTION,
      "other" /* Other */,
      {
        type: "object",
        additionalProperties: false,
        properties: {
          title: {
            type: "string",
            description: "Concise title shown in the client artifact list."
          },
          kind: {
            type: "string",
            enum: [
              "file",
              "link",
              "html",
              "image",
              "video",
              "audio",
              "pdf",
              "notebook",
              "document",
              "other"
            ],
            description: "Best-effort artifact type for client rendering."
          },
          storage: {
            type: "string",
            enum: ["workspace", "external_url", "managed"],
            description: "Storage class. Omit it to infer from the provided locator."
          },
          description: {
            type: "string",
            description: "Optional short description for the user."
          },
          workspacePath: {
            type: "string",
            description: "Path relative to the current execution directory, or an absolute path inside the bound workspace. The tool verifies a regular file, or expands a directory into one artifact per recordable file."
          },
          managedId: {
            type: "string",
            description: "Opaque identifier for a resource managed by an extension or tool."
          },
          url: {
            type: "string",
            description: "HTTP or HTTPS URL that the user can open for details."
          },
          mimeType: {
            type: "string",
            description: "Optional MIME type."
          },
          sizeBytes: {
            type: "integer",
            minimum: 0,
            description: "Optional size in bytes."
          },
          metadata: {
            type: "object",
            additionalProperties: {
              anyOf: [
                { type: "string" },
                { type: "number" },
                { type: "boolean" },
                { type: "null" }
              ]
            },
            description: "Small primitive metadata bag for client-specific display hints."
          }
        },
        required: ["title"]
      },
      true,
      false,
      true,
      false,
      "artifact url link file image report notebook dashboard"
    );
    this.config = config;
  }
  static {
    __name(this, "RecordArtifactTool");
  }
  static Name = ToolNames.RECORD_ARTIFACT;
  validateToolParams(params) {
    if (hasLegacyPathField(params)) {
      return '"path" is not supported; use "workspacePath" for a file in the current execution directory (relative to that directory, or an absolute path inside the workspace). Example: "report.csv".';
    }
    return super.validateToolParams(params);
  }
  validateToolParamValues(params) {
    params.title = (params.title ?? "").trim();
    const titleError = validateString(
      params.title,
      "title",
      ARTIFACT_TITLE_MAX_LENGTH,
      true
    );
    if (titleError) {
      return titleError;
    }
    const descriptionError = validateString(
      params.description,
      "description",
      1e3,
      false
    );
    if (descriptionError) {
      return descriptionError;
    }
    const mimeTypeError = validateString(
      params.mimeType,
      "mimeType",
      120,
      false
    );
    if (mimeTypeError) {
      return mimeTypeError;
    }
    if (params.kind && !isArtifactKind(params.kind)) {
      return '"kind" must be a supported artifact kind';
    }
    if (params.storage && params.storage !== "workspace" && params.storage !== "external_url" && params.storage !== "managed") {
      return '"storage" must be workspace, external_url, or managed';
    }
    const locators = [
      trimOptional(params.workspacePath),
      trimOptional(params.managedId),
      trimOptional(params.url)
    ].filter(Boolean);
    if (locators.length !== 1) {
      return 'Provide exactly one of "workspacePath", "managedId", or "url"';
    }
    const inferredStorage = inferStorage(params);
    if (params.storage && params.storage !== inferredStorage) {
      return `"storage" must be "${inferredStorage}" for the provided locator`;
    }
    if (params.workspacePath) {
      const workspacePathError = validateWorkspacePath(
        params.workspacePath,
        this.config.getTargetDir()
      );
      if (workspacePathError) {
        return workspacePathError;
      }
    }
    if (params.managedId) {
      const managedIdError = validateManagedId(params.managedId);
      if (managedIdError) {
        return managedIdError;
      }
    }
    if (params.url) {
      try {
        const parsed = new URL(params.url);
        if (parsed.username || parsed.password) {
          return '"url" must not include credentials';
        }
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          return '"url" must use http or https';
        }
      } catch {
        return '"url" must be a valid URL';
      }
    }
    if (params.sizeBytes !== void 0 && (!Number.isSafeInteger(params.sizeBytes) || params.sizeBytes < 0)) {
      return '"sizeBytes" must be a non-negative safe integer';
    }
    const metadataError = validateMetadata(params.metadata);
    if (metadataError) {
      return metadataError;
    }
    return null;
  }
  createInvocation(params) {
    return new RecordArtifactInvocation(params, this.config);
  }
};
function inferStorage(params) {
  if (trimOptional(params.workspacePath)) {
    return "workspace";
  }
  if (trimOptional(params.managedId)) {
    return "managed";
  }
  return "external_url";
}
__name(inferStorage, "inferStorage");
function trimOptional(value) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : void 0;
}
__name(trimOptional, "trimOptional");
function validateString(value, field, maxLength, required) {
  const trimmed = value?.trim();
  if (!trimmed) {
    return required ? `Missing or empty "${field}"` : null;
  }
  if (trimmed.length > maxLength) {
    return `"${field}" exceeds ${maxLength} characters`;
  }
  if (hasControlCharacter(trimmed, field === "description")) {
    return `"${field}" contains control characters`;
  }
  if (isDisplayField(field) && hasUnsafeDisplayPayload(trimmed)) {
    return `"${field}" contains unsafe markup`;
  }
  return null;
}
__name(validateString, "validateString");
function validateManagedId(value) {
  const trimmed = value.trim();
  const stringError = validateString(trimmed, "managedId", 200, true);
  if (stringError) {
    return stringError;
  }
  if (trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("..") || path3.isAbsolute(trimmed) || path3.win32.isAbsolute(trimmed)) {
    return '"managedId" must be an opaque managed resource id';
  }
  return null;
}
__name(validateManagedId, "validateManagedId");
function isDisplayField(field) {
  return field === "title" || field === "description" || field === "mimeType" || field === "workspacePath" || field === "managedId";
}
__name(isDisplayField, "isDisplayField");
function hasControlCharacter(value, allowLineWhitespace = false) {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (allowLineWhitespace && (code === 9 || code === 10 || code === 13)) {
      continue;
    }
    if (code <= 31 || code === 127 || code >= 8203 && code <= 8207 || code === 8232 || code === 8233 || code >= 8234 && code <= 8238 || code >= 8294 && code <= 8297 || code === 65279) {
      return true;
    }
  }
  return false;
}
__name(hasControlCharacter, "hasControlCharacter");
function hasUnsafeDisplayPayload(value) {
  return /<\s*\/?[a-z!]|&(?:#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]+);|javascript\s*:|data\s*:\s*(?:text\/(?:html|javascript)|application\/javascript|image\/svg\+xml)/i.test(
    value
  ) || /(?:^|[\s"'`<])on[a-z][a-z0-9-]*\s*=/i.test(value);
}
__name(hasUnsafeDisplayPayload, "hasUnsafeDisplayPayload");
function validateWorkspacePath(value, cwd) {
  const trimmed = value.trim();
  if (!trimmed) {
    return 'Missing or empty "workspacePath"';
  }
  if (hasControlCharacter(trimmed) || hasUnsafeDisplayPayload(trimmed)) {
    return hasControlCharacter(trimmed) ? '"workspacePath" contains control characters' : '"workspacePath" contains unsafe markup';
  }
  if (isRedirectorRoutedPath(trimmed) || isForeignWindowsAbsolute(trimmed)) {
    return WORKSPACE_PATH_HINT;
  }
  if (isAbsoluteWorkspaceInput(trimmed)) {
    if (trimmed.length > 4096) {
      return '"workspacePath" exceeds 4096 characters';
    }
    const root = resolveBoundWorkspaceRoot(
      tryResolveForContainment(path3.resolve(cwd)) ?? path3.resolve(cwd)
    );
    const comparable = tryResolveForContainment(path3.resolve(trimmed));
    if (comparable && !isWithinRoot(comparable, root)) {
      return '"workspacePath" must stay inside the workspace';
    }
    return null;
  }
  if (trimmed.length > ARTIFACT_WORKSPACE_PATH_MAX_LENGTH) {
    return `"workspacePath" exceeds ${ARTIFACT_WORKSPACE_PATH_MAX_LENGTH} characters`;
  }
  const portableNormalized = path3.posix.normalize(trimmed.replace(/\\/g, "/"));
  if (portableNormalized === ".." || portableNormalized.startsWith("../") || path3.posix.isAbsolute(portableNormalized)) {
    return '"workspacePath" must stay inside the current execution directory';
  }
  return null;
}
__name(validateWorkspacePath, "validateWorkspacePath");
function validateMetadata(metadata) {
  if (metadata === void 0) {
    return null;
  }
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    return '"metadata" must be an object';
  }
  for (const [key, value] of Object.entries(metadata)) {
    if (!key) {
      return '"metadata" keys must not be empty';
    }
    if (key.length > 120) {
      return '"metadata" keys must be 120 characters or fewer';
    }
    if (hasControlCharacter(key) || hasUnsafeDisplayPayload(key)) {
      return '"metadata" keys contain unsafe content';
    }
    if (value !== null && typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      return '"metadata" values must be primitive';
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      return '"metadata" numbers must be finite';
    }
    if (typeof value === "string" && (hasControlCharacter(value) || hasUnsafeDisplayPayload(value))) {
      return '"metadata" string values contain unsafe content';
    }
  }
  if (Buffer.byteLength(JSON.stringify(metadata), "utf8") > 4096) {
    return '"metadata" must be 4096 bytes or fewer';
  }
  return null;
}
__name(validateMetadata, "validateMetadata");
function isArtifactKind(kind) {
  return kind === "file" || kind === "link" || kind === "html" || kind === "image" || kind === "video" || kind === "audio" || kind === "pdf" || kind === "notebook" || kind === "document" || kind === "other";
}
__name(isArtifactKind, "isArtifactKind");
function hasLegacyPathField(params) {
  const raw = params;
  return Object.prototype.hasOwnProperty.call(raw, "path") && raw.path != null && raw.path !== "";
}
__name(hasLegacyPathField, "hasLegacyPathField");
function isRedirectorRoutedPath(value) {
  const slashes = value.replace(/\//g, "\\").replace(/^\\\?\?\\/, "\\\\?\\");
  if (/\\Device\\Mup\\/i.test(slashes)) {
    return true;
  }
  const posixDoubleSlash = process.platform !== "win32" && !value.includes("\\") && /^\/\//.test(value);
  if (!posixDoubleSlash && (/^\\\\[^\\?]+(?:\\|$)/.test(slashes) || /^\\\\\?\\[Uu][Nn][Cc]\\/.test(slashes))) {
    return true;
  }
  return /^\\\\\?\\/.test(slashes) && !/^\\\\\?\\[A-Za-z]:\\/.test(slashes);
}
__name(isRedirectorRoutedPath, "isRedirectorRoutedPath");
function isForeignWindowsAbsolute(value) {
  if (process.platform === "win32") {
    return false;
  }
  return /^[A-Za-z]:/.test(value) || value.startsWith("\\");
}
__name(isForeignWindowsAbsolute, "isForeignWindowsAbsolute");
function isAbsoluteWorkspaceInput(value) {
  return path3.isAbsolute(value) || process.platform === "win32" && path3.win32.isAbsolute(value);
}
__name(isAbsoluteWorkspaceInput, "isAbsoluteWorkspaceInput");
function formatWorkspaceSuccess(title, locator) {
  return [
    `Recorded artifact "${title}".`,
    "status: available",
    `workspacePath: ${locator.workspacePath}`,
    `resolvedPath: ${locator.resolvedPath}`
  ].join("\n");
}
__name(formatWorkspaceSuccess, "formatWorkspaceSuccess");
function formatDirectoryExpansion(locator, collected) {
  const lines = [
    `Expanded directory "${locator.workspacePath}" into ${collected.files.length} artifacts.`,
    "status: available",
    `workspacePath: ${locator.workspacePath}`,
    `resolvedPath: ${locator.resolvedPath}`,
    "files:",
    ...collected.files.map((file) => `- ${file}`)
  ];
  if (collected.truncated) {
    lines.push(`Recorded the first ${collected.files.length} files.`);
  }
  if (collected.depthLimited) {
    lines.push(
      `Skipped files deeper than ${MAX_DIRECTORY_ARTIFACT_DEPTH} directory levels.`
    );
  }
  if (collected.unreadable) {
    lines.push("Skipped subdirectories that could not be read.");
  }
  if ((collected.skippedUnrecordable ?? 0) > 0) {
    lines.push(
      `Skipped ${collected.skippedUnrecordable} files whose names cannot be recorded as artifact titles.`
    );
  }
  return lines.join("\n");
}
__name(formatDirectoryExpansion, "formatDirectoryExpansion");
function metadataExceedsBudget(metadata) {
  const withMarker = { ...metadata, expandedFromDirectory: true };
  return Buffer.byteLength(JSON.stringify(withMarker), "utf8") > 4096;
}
__name(metadataExceedsBudget, "metadataExceedsBudget");
function isRecordableDerivedChild(title, workspacePath) {
  const trimmedTitle = title.trim();
  const trimmedPath = workspacePath.trim();
  if (title !== trimmedTitle || workspacePath !== trimmedPath) {
    return false;
  }
  return trimmedTitle.length > 0 && trimmedTitle.length <= ARTIFACT_TITLE_MAX_LENGTH && trimmedPath.length <= ARTIFACT_WORKSPACE_PATH_MAX_LENGTH && !hasControlCharacter(trimmedTitle) && !hasUnsafeDisplayPayload(trimmedTitle) && !hasControlCharacter(trimmedPath) && !hasUnsafeDisplayPayload(trimmedPath);
}
__name(isRecordableDerivedChild, "isRecordableDerivedChild");
function locatorFailure(type, message) {
  return { ok: false, type, message };
}
__name(locatorFailure, "locatorFailure");
async function resolveExistingDir(dir) {
  const resolved = path3.resolve(dir);
  try {
    return await fs2.realpath(resolved);
  } catch {
    return resolved;
  }
}
__name(resolveExistingDir, "resolveExistingDir");
function tryResolveForContainment(absolutePath) {
  const resolved = path3.resolve(absolutePath);
  if (pathHasRedirectorHop(resolved)) {
    return void 0;
  }
  try {
    return realpathSync(resolved);
  } catch {
    try {
      const parent = path3.dirname(resolved);
      if (pathHasRedirectorHop(parent)) {
        return void 0;
      }
      return path3.join(realpathSync(parent), path3.basename(resolved));
    } catch {
      return void 0;
    }
  }
}
__name(tryResolveForContainment, "tryResolveForContainment");
var REDIRECTOR_HOP_LIMIT = 8;
function pathHasRedirectorHop(absolutePath) {
  if (isRedirectorRoutedPath(absolutePath)) {
    return true;
  }
  const resolved = path3.resolve(absolutePath);
  const root = path3.parse(resolved).root;
  const relative = path3.relative(root, resolved);
  if (!relative || relative.startsWith("..")) {
    return symlinkChainHitsRedirector(resolved);
  }
  let acc = root;
  for (const segment of relative.split(path3.sep).filter(Boolean)) {
    acc = path3.join(acc, segment);
    if (isRedirectorRoutedPath(acc) || symlinkChainHitsRedirector(acc)) {
      return true;
    }
  }
  return false;
}
__name(pathHasRedirectorHop, "pathHasRedirectorHop");
function symlinkChainHitsRedirector(absolutePath) {
  let current = absolutePath;
  for (let hop = 0; hop < REDIRECTOR_HOP_LIMIT; hop++) {
    let lst;
    try {
      lst = lstatSync(current);
    } catch {
      return false;
    }
    if (!lst.isSymbolicLink()) {
      return false;
    }
    let target;
    try {
      target = readlinkSync(current);
    } catch {
      return false;
    }
    if (isRedirectorRoutedPath(target)) {
      return true;
    }
    const next = path3.isAbsolute(target) ? target : path3.resolve(path3.dirname(current), target);
    if (isRedirectorRoutedPath(next)) {
      return true;
    }
    current = next;
  }
  return false;
}
__name(symlinkChainHitsRedirector, "symlinkChainHitsRedirector");
async function resolveWorkspaceArtifactLocator(rawPath, config) {
  const cwd = await resolveExistingDir(config.getTargetDir());
  const root = await resolveExistingDir(resolveBoundWorkspaceRoot(cwd));
  const first = workspacePathCandidate(rawPath, cwd, root, true);
  if (!first.ok) {
    return first;
  }
  const inspected = await inspectWorkspaceCandidate(
    first.path,
    rawPath,
    cwd,
    root
  );
  if (inspected.ok || inspected.type !== "file_not_found" /* FILE_NOT_FOUND */ || process.platform === "win32" || !rawPath.includes("\\")) {
    return inspected;
  }
  const fallback = workspacePathCandidate(rawPath, cwd, root, false);
  if (!fallback.ok || fallback.path === first.path) {
    return inspected;
  }
  return inspectWorkspaceCandidate(fallback.path, rawPath, cwd, root);
}
__name(resolveWorkspaceArtifactLocator, "resolveWorkspaceArtifactLocator");
function workspacePathCandidate(locator, cwd, root, preservePosixBackslash) {
  if (isRedirectorRoutedPath(locator) || isForeignWindowsAbsolute(locator)) {
    return locatorFailure(
      "invalid_tool_params" /* INVALID_TOOL_PARAMS */,
      WORKSPACE_PATH_HINT
    );
  }
  if (isAbsoluteWorkspaceInput(locator)) {
    const absolute = path3.resolve(locator);
    const comparable = tryResolveForContainment(absolute);
    if (comparable && !isWithinRoot(comparable, root)) {
      return locatorFailure(
        "path_not_in_workspace" /* PATH_NOT_IN_WORKSPACE */,
        `Failed to record artifact: "${locator}" is outside the workspace.
${WORKSPACE_PATH_HINT}`
      );
    }
    return { ok: true, path: absolute };
  }
  const relative = preservePosixBackslash && process.platform !== "win32" ? locator : locator.replace(/\\/g, "/");
  return { ok: true, path: path3.resolve(cwd, relative) };
}
__name(workspacePathCandidate, "workspacePathCandidate");
async function inspectWorkspaceCandidate(candidate, rawPath, cwd, root) {
  if (pathHasRedirectorHop(candidate)) {
    return locatorFailure(
      "path_not_in_workspace" /* PATH_NOT_IN_WORKSPACE */,
      `Failed to record artifact: "${rawPath}" resolves outside the workspace.
${WORKSPACE_PATH_HINT}`
    );
  }
  try {
    await fs2.lstat(candidate);
  } catch (error) {
    return pathInspectFailure(
      error,
      candidate,
      rawPath,
      `Failed to record artifact: could not inspect "${candidate}" (${error instanceof Error ? error.message : String(error)}).`
    );
  }
  let resolved;
  try {
    resolved = await fs2.realpath(candidate);
  } catch (error) {
    return pathInspectFailure(
      error,
      candidate,
      rawPath,
      `Failed to record artifact: could not resolve "${rawPath}" (${error instanceof Error ? error.message : String(error)}).`
    );
  }
  if (!isWithinRoot(resolved, root)) {
    return locatorFailure(
      "path_not_in_workspace" /* PATH_NOT_IN_WORKSPACE */,
      `Failed to record artifact: "${rawPath}" resolves outside the workspace.
${WORKSPACE_PATH_HINT}`
    );
  }
  let st;
  try {
    st = await fs2.stat(resolved);
  } catch (error) {
    return pathInspectFailure(
      error,
      resolved,
      rawPath,
      `Failed to record artifact: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!st.isFile() && !st.isDirectory()) {
    return locatorFailure(
      "target_not_regular_file" /* TARGET_NOT_REGULAR_FILE */,
      `Failed to record artifact: "${resolved}" is not a regular file.
${WORKSPACE_PATH_HINT}`
    );
  }
  if (st.isDirectory() && path3.resolve(resolved) === path3.resolve(cwd)) {
    return locatorFailure(
      "target_is_directory" /* TARGET_IS_DIRECTORY */,
      `Failed to record artifact: "${rawPath}" is the workspace root, which cannot be recorded as a directory artifact.`
    );
  }
  const workspacePath = toCanonicalWorkspaceArtifactPath(resolved, cwd);
  if (!workspacePath) {
    if (st.isDirectory()) {
      return locatorFailure(
        "target_is_directory" /* TARGET_IS_DIRECTORY */,
        `Failed to record artifact: "${rawPath}" is the workspace root, which cannot be recorded as a directory artifact.`
      );
    }
    return locatorFailure(
      "path_not_in_workspace" /* PATH_NOT_IN_WORKSPACE */,
      `Failed to record artifact: "${rawPath}" could not be converted to a workspace-root-relative path.
${WORKSPACE_PATH_HINT}`
    );
  }
  const canonicalError = validateString(
    workspacePath,
    "workspacePath",
    ARTIFACT_WORKSPACE_PATH_MAX_LENGTH,
    true
  );
  if (canonicalError) {
    return locatorFailure(
      "invalid_tool_params" /* INVALID_TOOL_PARAMS */,
      canonicalError.includes("exceeds") ? `Failed to record artifact: the stored workspace-root-relative path "${workspacePath}" exceeds ${ARTIFACT_WORKSPACE_PATH_MAX_LENGTH} characters.` : canonicalError
    );
  }
  return {
    ok: true,
    workspacePath,
    resolvedPath: resolved,
    workspaceRoot: root,
    sizeBytes: st.isDirectory() ? 0 : st.size,
    ...st.isDirectory() ? { isDirectory: true } : {}
  };
}
__name(inspectWorkspaceCandidate, "inspectWorkspaceCandidate");
function classifyPathError(error) {
  if (!isNodeError(error)) {
    return "execution_failed" /* EXECUTION_FAILED */;
  }
  if (error.code === "ENOENT" || error.code === "ENOTDIR") {
    return "file_not_found" /* FILE_NOT_FOUND */;
  }
  if (error.code === "EACCES" || error.code === "EPERM") {
    return "permission_denied" /* PERMISSION_DENIED */;
  }
  return "execution_failed" /* EXECUTION_FAILED */;
}
__name(classifyPathError, "classifyPathError");
function pathInspectFailure(error, candidate, rawPath, fallbackMessage) {
  const type = classifyPathError(error);
  if (type === "file_not_found" /* FILE_NOT_FOUND */) {
    return locatorFailure(
      type,
      [
        `Failed to record artifact: file not found at "${candidate}".`,
        WORKSPACE_PATH_HINT
      ].join("\n")
    );
  }
  if (type === "permission_denied" /* PERMISSION_DENIED */) {
    return locatorFailure(
      type,
      `Failed to record artifact: permission denied for "${rawPath}".
${WORKSPACE_PATH_HINT}`
    );
  }
  return locatorFailure(type, fallbackMessage);
}
__name(pathInspectFailure, "pathInspectFailure");

export {
  MAX_DIRECTORY_ARTIFACT_FILES,
  MAX_DIRECTORY_ARTIFACT_DEPTH,
  OFFICE_DOCUMENT_EXTENSIONS,
  isOfficeDocumentExtension,
  pathHasSkippedDirectoryComponent,
  collectRecordableWorkspaceFiles,
  toCanonicalWorkspaceArtifactPath,
  ARTIFACT_TITLE_MAX_LENGTH,
  ARTIFACT_WORKSPACE_PATH_MAX_LENGTH,
  RecordArtifactTool,
  hasControlCharacter,
  hasUnsafeDisplayPayload,
  isRecordableDerivedChild
};
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
