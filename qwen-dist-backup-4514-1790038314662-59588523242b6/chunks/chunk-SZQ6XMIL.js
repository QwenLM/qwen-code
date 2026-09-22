// Force strict mode and setup for ESM
"use strict";
import {
  buildPermissionSettings
} from "./chunk-LFHY2NHU.js";
import {
  resolveVoiceStreamConfig,
  resolveVoiceTranscriptionConfig,
  transcribeVoiceAudio
} from "./chunk-DNDECZXY.js";
import {
  getVoiceSettingsScope,
  isSelectableVoiceModel,
  isVoiceEnabled,
  readVoiceLanguage,
  readVoiceMode,
  readVoiceModel,
  resolveVoiceTransport
} from "./chunk-JYTJ5FCM.js";
import {
  WorkspacePermissionRulesSessionRequiredError,
  WorkspaceSettingsPartialPersistError,
  WorkspaceSkillNotFoundError
} from "./chunk-FTJMWDND.js";
import {
  MCP_RESTART_SERVER_DEADLINE_MS
} from "./chunk-OCPBI7J5.js";
import {
  BridgeChannelClosedError,
  SERVE_CONTROL_EXT_METHODS,
  SERVE_STATUS_EXT_METHODS,
  STATUS_SCHEMA_VERSION,
  createIdleAcpPreflightCells,
  createIdleEnvStatus,
  createIdleWorkspaceExtensionsStatus,
  createIdleWorkspaceHooksStatus,
  createIdleWorkspaceMcpStatus,
  createIdleWorkspaceProvidersStatus,
  createIdleWorkspaceSkillsStatus,
  mapDomainErrorToErrorKind
} from "./chunk-SIUR4U2P.js";
import {
  publicProviderBaseUrl
} from "./chunk-Y3Q5OK4D.js";
import {
  McpServerNotFoundError,
  McpServerRestartFailedError,
  SessionNotFoundError,
  WorkspaceInitConflictError,
  WorkspaceInitPathEscapeError,
  WorkspaceInitRaceError,
  WorkspaceInitSymlinkError
} from "./chunk-YXHY6BKS.js";
import {
  getPersistScopeForModelSelection,
  loadSettings
} from "./chunk-DRYBBTI5.js";
import {
  getWorkspaceTrustStatus
} from "./chunk-36RKQ7ZS.js";
import {
  SkillManager,
  require_yauzl
} from "./chunk-MRTRBONQ.js";
import {
  ModelsConfig
} from "./chunk-TLS6QN2S.js";
import {
  Storage,
  createDebugLogger
} from "./chunk-ZYDMQCQP.js";
import {
  writeStderrLine,
  writeStderrLineSafe
} from "./chunk-7FA2II6K.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name,
  __toESM
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/serve/workspace-service/index.ts
init_esbuild_shims();
import { randomUUID } from "node:crypto";
import { promises as fs2, constants as fsConstants } from "node:fs";
import * as path2 from "node:path";

// packages/cli/src/services/voice-service.ts
init_esbuild_shims();
var debugLogger = createDebugLogger("VOICE_SERVICE");
var EMPTY_WORKSPACE_VOICE_UPDATE_ERROR = "At least one of `enabled`, `mode`, `language`, or `voiceModel` must be provided";
var WorkspaceVoiceError = class extends Error {
  static {
    __name(this, "WorkspaceVoiceError");
  }
  status;
  code;
  constructor(status, code, message) {
    super(message);
    this.name = "WorkspaceVoiceError";
    this.status = status;
    this.code = code;
  }
};
function voiceSettingsScopeToWire(scope) {
  return scope === "Workspace" /* Workspace */ ? "workspace" : "user";
}
__name(voiceSettingsScopeToWire, "voiceSettingsScopeToWire");
function buildWorkspaceVoiceSettingsWrites(settings, update, opts = {}) {
  const voiceSettingsScope = opts.scopeOverride ?? getVoiceSettingsScope(settings, opts.workspaceTrusted);
  const writes = [];
  if (update.voiceModel !== void 0) {
    writes.push({
      scope: opts.scopeOverride ?? getPersistScopeForModelSelection(settings),
      key: "voiceModel",
      value: update.voiceModel
    });
  }
  if (update.mode !== void 0) {
    writes.push({
      scope: voiceSettingsScope,
      key: "general.voice.mode",
      value: update.mode
    });
  }
  if (update.language !== void 0) {
    writes.push({
      scope: voiceSettingsScope,
      key: "general.voice.language",
      value: update.language
    });
  }
  if (update.enabled !== void 0) {
    writes.push({
      scope: voiceSettingsScope,
      key: "general.voice.enabled",
      value: update.enabled
    });
  }
  return writes;
}
__name(buildWorkspaceVoiceSettingsWrites, "buildWorkspaceVoiceSettingsWrites");
function createVoiceModelSource(settings) {
  return new ModelsConfig({
    modelProvidersConfig: settings.merged.modelProviders,
    providerProtocolConfig: settings.merged.providerProtocol
  });
}
__name(createVoiceModelSource, "createVoiceModelSource");
function listAvailableVoiceModels(settings) {
  const models = createVoiceModelSource(settings).getAllConfiguredModels();
  const idCounts = /* @__PURE__ */ new Map();
  for (const model of models) {
    idCounts.set(model.id, (idCounts.get(model.id) ?? 0) + 1);
  }
  const duplicateIds = [...idCounts.entries()].filter(([, count]) => count > 1).map(([id]) => id);
  if (duplicateIds.length > 0) {
    debugLogger.debug(
      `Skipping duplicate voice model ids: ${duplicateIds.join(", ")}`
    );
  }
  return models.filter((model) => (idCounts.get(model.id) ?? 0) === 1).filter(isSelectableVoiceModel).map((model) => ({
    id: model.id,
    ...model.label ? { name: model.label } : {},
    ...model.baseUrl ? { baseUrl: publicProviderBaseUrl(model.baseUrl) } : {},
    ...model.contextWindowSize ? { contextWindow: model.contextWindowSize } : {},
    transport: resolveVoiceTransport(model.id)
  })).filter(
    (model) => model.transport !== "unsupported"
  );
}
__name(listAvailableVoiceModels, "listAvailableVoiceModels");
function hasConfiguredBatchVoiceTranscriptionModel(settings, opts = {}) {
  for (const model of listAvailableVoiceModels(settings)) {
    if (model.transport !== "qwen-asr-chat") {
      continue;
    }
    try {
      validateWorkspaceVoiceConfig(settings, model.id, opts);
      return true;
    } catch (err) {
      debugLogger.debug(
        `Skipping unavailable batch voice model '${model.id}': ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  return false;
}
__name(hasConfiguredBatchVoiceTranscriptionModel, "hasConfiguredBatchVoiceTranscriptionModel");
function buildWorkspaceVoiceStatus(workspaceCwd, settings) {
  return {
    v: 1,
    workspaceCwd,
    enabled: isVoiceEnabled(settings),
    mode: readVoiceMode(settings),
    language: readVoiceLanguage(settings),
    voiceModel: readVoiceModel(settings) ?? null,
    availableVoiceModels: listAvailableVoiceModels(settings)
  };
}
__name(buildWorkspaceVoiceStatus, "buildWorkspaceVoiceStatus");
function validateWorkspaceVoiceModel(settings, voiceModel) {
  const models = createVoiceModelSource(settings).getAllConfiguredModels();
  const matches = models.filter((model2) => model2.id === voiceModel);
  if (matches.length === 0) {
    throw new WorkspaceVoiceError(
      400,
      "unknown_voice_model",
      `Voice model '${voiceModel}' is not configured.`
    );
  }
  if (matches.length > 1) {
    throw new WorkspaceVoiceError(
      400,
      "ambiguous_voice_model",
      `Voice model '${voiceModel}' is ambiguous.`
    );
  }
  const [model] = matches;
  if (!model || !isSelectableVoiceModel(model)) {
    throw new WorkspaceVoiceError(
      400,
      "unsupported_voice_model",
      `Voice model '${voiceModel}' cannot be used for transcription.`
    );
  }
  const transport = resolveVoiceTransport(model.id);
  if (transport === "unsupported") {
    throw new WorkspaceVoiceError(
      400,
      "unsupported_voice_model",
      `Voice model '${voiceModel}' cannot be used for transcription.`
    );
  }
  return { id: model.id, transport };
}
__name(validateWorkspaceVoiceModel, "validateWorkspaceVoiceModel");
function validateWorkspaceVoiceConfig(settings, voiceModel, opts = {}) {
  const descriptor = validateWorkspaceVoiceModel(settings, voiceModel);
  try {
    const config = createVoiceModelSource(settings);
    if (descriptor.transport === "qwen-asr-chat") {
      resolveVoiceTranscriptionConfig({
        config,
        settings,
        voiceModel,
        env: opts.env
      });
    } else {
      resolveVoiceStreamConfig({
        config,
        settings,
        voiceModel,
        env: opts.env
      });
    }
  } catch (err) {
    throw new WorkspaceVoiceError(
      400,
      "invalid_voice_model",
      err instanceof Error ? err.message : `Voice model '${voiceModel}' is not configured for transcription.`
    );
  }
  return descriptor;
}
__name(validateWorkspaceVoiceConfig, "validateWorkspaceVoiceConfig");
function validateWorkspaceVoiceState(settings, update, opts = {}) {
  if (update.enabled === void 0 && update.mode === void 0 && update.language === void 0 && update.voiceModel === void 0) {
    throw new WorkspaceVoiceError(
      400,
      "invalid_voice_update",
      EMPTY_WORKSPACE_VOICE_UPDATE_ERROR
    );
  }
  const nextEnabled = update.enabled ?? isVoiceEnabled(settings);
  const nextVoiceModel = update.voiceModel ?? readVoiceModel(settings);
  if (update.voiceModel) {
    validateWorkspaceVoiceModel(settings, update.voiceModel);
  }
  if (!nextEnabled) {
    return;
  }
  if (!nextVoiceModel) {
    throw new WorkspaceVoiceError(
      400,
      "voice_model_required",
      "A valid voiceModel is required before enabling voice."
    );
  }
  validateWorkspaceVoiceConfig(settings, nextVoiceModel, opts);
}
__name(validateWorkspaceVoiceState, "validateWorkspaceVoiceState");
async function transcribeWorkspaceVoiceAudio(input) {
  const descriptor = validateWorkspaceVoiceModel(
    input.settings,
    input.voiceModel
  );
  if (descriptor.transport !== "qwen-asr-chat") {
    throw new WorkspaceVoiceError(
      400,
      "unsupported_voice_model",
      `Voice model '${input.voiceModel}' requires realtime transcription, which is not supported by this daemon endpoint.`
    );
  }
  const text = await transcribeVoiceAudio(
    { data: input.data, mimeType: input.mimeType },
    {
      config: createVoiceModelSource(input.settings),
      settings: input.settings,
      voiceModel: input.voiceModel,
      env: input.env,
      abortSignal: input.abortSignal
    }
  );
  return {
    text,
    model: input.voiceModel,
    transport: descriptor.transport
  };
}
__name(transcribeWorkspaceVoiceAudio, "transcribeWorkspaceVoiceAudio");

// packages/cli/src/serve/workspace-skill-management.ts
init_esbuild_shims();
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
var import_yauzl = __toESM(require_yauzl(), 1);
var MAX_FILES = 128;
var MAX_FILE_BYTES = 2 * 1024 * 1024;
var MAX_TOTAL_BYTES = 6 * 1024 * 1024;
var MAX_PATH_LENGTH = 512;
var MAX_PATH_DEPTH = 16;
var MAX_WORKSPACE_SKILL_NAME_LENGTH = 256;
var execFileAsync = promisify(execFile);
var WorkspaceSkillManagementError = class extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
    this.name = "WorkspaceSkillManagementError";
  }
  static {
    __name(this, "WorkspaceSkillManagementError");
  }
};
function skillError(code, message, statusCode = 400) {
  throw new WorkspaceSkillManagementError(code, message, statusCode);
}
__name(skillError, "skillError");
function validateWorkspaceSkillName(name) {
  const normalized = name.trim();
  if (!normalized || normalized === "." || normalized === ".." || normalized.length > MAX_WORKSPACE_SKILL_NAME_LENGTH || !/^[A-Za-z0-9._-]+$/.test(normalized)) {
    skillError("invalid_skill_name", "Invalid skill name");
  }
  return normalized;
}
__name(validateWorkspaceSkillName, "validateWorkspaceSkillName");
function rejectInstallArtifactSkillName(name) {
  if (/\.(backup|installing)-\d+-\d+$/.test(name)) {
    skillError(
      "invalid_skill_name",
      "Skill name ends with a reserved install-artifact suffix"
    );
  }
}
__name(rejectInstallArtifactSkillName, "rejectInstallArtifactSkillName");
function decodeBase64(value) {
  if (!value || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    skillError("invalid_skill_source", "Invalid base64 skill content");
  }
  const content = Buffer.from(value, "base64");
  if (content.length > MAX_TOTAL_BYTES) {
    skillError(
      "skill_package_too_large",
      "Skill package exceeds the allowed size",
      413
    );
  }
  return content;
}
__name(decodeBase64, "decodeBase64");
function normalizeRelativePath(value) {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  const segments = normalized.split("/");
  if (!normalized || normalized.length > MAX_PATH_LENGTH || normalized.startsWith("/") || segments.length > MAX_PATH_DEPTH || segments.some((segment) => !segment || segment === "." || segment === "..")) {
    skillError("invalid_skill_package", `Invalid skill file path: ${value}`);
  }
  return segments.join("/");
}
__name(normalizeRelativePath, "normalizeRelativePath");
function isPlatformMetadataPath(value) {
  return value.replaceAll("\\", "/").split("/").some(
    (segment) => segment === "__MACOSX" || segment === ".DS_Store" || segment.startsWith("._")
  );
}
__name(isPlatformMetadataPath, "isPlatformMetadataPath");
function normalizePackageFiles(files) {
  files = files.filter((file) => !isPlatformMetadataPath(file.relativePath));
  if (!files.length || files.length > MAX_FILES) {
    skillError(
      "invalid_skill_package",
      "Skill package has an invalid file count"
    );
  }
  let normalized = files.map((file) => ({
    relativePath: normalizeRelativePath(file.relativePath),
    content: file.content
  }));
  if (!normalized.some((file) => file.relativePath === "SKILL.md")) {
    const roots = new Set(
      normalized.map((file) => file.relativePath.split("/")[0])
    );
    if (roots.size !== 1) {
      skillError(
        "skill_manifest_missing",
        "Skill package must contain a root SKILL.md"
      );
    }
    const [root] = roots;
    normalized = normalized.map((file) => ({
      ...file,
      relativePath: file.relativePath.slice(root.length + 1)
    }));
  }
  const seen = /* @__PURE__ */ new Set();
  let totalBytes = 0;
  for (const file of normalized) {
    file.relativePath = normalizeRelativePath(file.relativePath);
    if (seen.has(file.relativePath)) {
      skillError(
        "invalid_skill_package",
        `Duplicate skill file path: ${file.relativePath}`
      );
    }
    seen.add(file.relativePath);
    if (file.content.length > MAX_FILE_BYTES) {
      skillError(
        "skill_package_too_large",
        `Skill file is too large: ${file.relativePath}`,
        413
      );
    }
    totalBytes += file.content.length;
    if (totalBytes > MAX_TOTAL_BYTES) {
      skillError(
        "skill_package_too_large",
        "Skill package exceeds the allowed size",
        413
      );
    }
  }
  if (!seen.has("SKILL.md")) {
    skillError(
      "skill_manifest_missing",
      "Skill package must contain a root SKILL.md"
    );
  }
  return normalized;
}
__name(normalizePackageFiles, "normalizePackageFiles");
function githubRequestError(code, status, resource) {
  const message = status === 404 ? `GitHub ${resource} was not found; check the repository URL, branch, and path` : status === 401 ? "GitHub authentication failed; check GH_TOKEN or GITHUB_TOKEN" : status === 403 ? "GitHub access was denied; the repository may be private or API rate-limited" : status === 429 ? "GitHub API rate limit exceeded; try again later or configure GH_TOKEN" : `GitHub request failed (HTTP ${status})`;
  return new WorkspaceSkillManagementError(
    code,
    message,
    status === 404 ? 404 : 502
  );
}
__name(githubRequestError, "githubRequestError");
async function fetchBytes(url, githubToken) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "qwen-code",
      ...githubToken ? { Authorization: `Bearer ${githubToken}` } : {}
    }
  });
  if (!response.ok) {
    throw githubRequestError(
      "github_skill_download_failed",
      response.status,
      "Skill file"
    );
  }
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_FILE_BYTES) {
    skillError("skill_package_too_large", "Skill file is too large", 413);
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_FILE_BYTES) {
        await reader.cancel().catch(() => void 0);
        skillError("skill_package_too_large", "Skill file is too large", 413);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}
__name(fetchBytes, "fetchBytes");
async function downloadGitHubDirectory(owner, repo, ref, directory, githubToken, relativeRoot = "", depth = 0, state = {
  files: [],
  totalBytes: 0
}) {
  if (depth > MAX_PATH_DEPTH)
    skillError("invalid_skill_package", "GitHub Skill is nested too deeply");
  const encodedDirectory = directory.split("/").filter(Boolean).map(encodeURIComponent).join("/");
  const apiUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents${encodedDirectory ? `/${encodedDirectory}` : ""}?ref=${encodeURIComponent(ref)}`;
  const response = await fetch(apiUrl, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "qwen-code",
      ...githubToken ? { Authorization: `Bearer ${githubToken}` } : {}
    }
  });
  if (!response.ok) {
    throw githubRequestError(
      "github_api_failed",
      response.status,
      "Skill path"
    );
  }
  const items = await response.json();
  if (!Array.isArray(items))
    skillError("invalid_skill_source", "GitHub URL must point to SKILL.md");
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const record = item;
    const itemName = typeof record["name"] === "string" ? record["name"] : "";
    const itemPath = typeof record["path"] === "string" ? record["path"] : "";
    const itemType = typeof record["type"] === "string" ? record["type"] : "";
    const relativePath = relativeRoot ? `${relativeRoot}/${itemName}` : itemName;
    if (itemType === "dir") {
      await downloadGitHubDirectory(
        owner,
        repo,
        ref,
        itemPath,
        githubToken,
        relativePath,
        depth + 1,
        state
      );
    } else if (itemType === "file") {
      const downloadUrl = record["download_url"];
      if (typeof downloadUrl !== "string") continue;
      const parsedDownloadUrl = new URL(downloadUrl);
      if (parsedDownloadUrl.protocol !== "https:" || parsedDownloadUrl.hostname !== "raw.githubusercontent.com") {
        skillError(
          "github_skill_download_failed",
          "GitHub returned an invalid Skill file URL",
          502
        );
      }
      const content = await fetchBytes(downloadUrl, githubToken);
      state.files.push({ relativePath, content });
      state.totalBytes += content.length;
      if (state.files.length > MAX_FILES)
        skillError("invalid_skill_package", "Skill package has too many files");
      if (state.totalBytes > MAX_TOTAL_BYTES) {
        skillError(
          "skill_package_too_large",
          "Skill package exceeds the allowed size",
          413
        );
      }
    }
  }
  return state.files;
}
__name(downloadGitHubDirectory, "downloadGitHubDirectory");
async function downloadGitHubDirectoryWithGit(owner, repo, ref, directory) {
  const checkout = await fs.mkdtemp(path.join(os.tmpdir(), "qwen-skill-git-"));
  try {
    await execFileAsync(
      "git",
      [
        "clone",
        "--depth",
        "1",
        "--filter=blob:none",
        "--sparse",
        "--branch",
        ref,
        `https://github.com/${owner}/${repo}.git`,
        checkout
      ],
      { timeout: 6e4, maxBuffer: 1024 * 1024 }
    );
    if (directory) {
      await execFileAsync(
        "git",
        ["-C", checkout, "sparse-checkout", "set", "--cone", directory],
        { timeout: 3e4, maxBuffer: 1024 * 1024 }
      );
    } else {
      await execFileAsync(
        "git",
        ["-C", checkout, "sparse-checkout", "disable"],
        { timeout: 3e4, maxBuffer: 1024 * 1024 }
      );
    }
    return await filesFromFolder(path.join(checkout, directory));
  } catch (error) {
    if (error instanceof WorkspaceSkillManagementError) throw error;
    throw new WorkspaceSkillManagementError(
      "github_skill_download_failed",
      `Failed to download GitHub Skill: ${error instanceof Error ? error.message : String(error)}`,
      502
    );
  } finally {
    await fs.rm(checkout, { recursive: true, force: true });
  }
}
__name(downloadGitHubDirectoryWithGit, "downloadGitHubDirectoryWithGit");
async function downloadGitHubSkill(sourceUrl, githubToken) {
  let url;
  try {
    url = new URL(sourceUrl);
  } catch {
    skillError("invalid_skill_source", "Invalid GitHub Skill URL");
  }
  if (url.protocol !== "https:")
    skillError("invalid_skill_source", "GitHub URL must use HTTPS");
  if (url.hostname === "raw.githubusercontent.com") {
    if (!url.pathname.endsWith("/SKILL.md")) {
      skillError("invalid_skill_source", "GitHub URL must point to SKILL.md");
    }
    return [
      {
        relativePath: "SKILL.md",
        content: await fetchBytes(url.toString(), githubToken)
      }
    ];
  }
  if (url.hostname !== "github.com") {
    skillError("invalid_skill_source", "Only GitHub Skill URLs are supported");
  }
  let segments;
  try {
    segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    skillError("invalid_skill_source", "Invalid GitHub Skill URL");
  }
  if (segments.length < 5 || segments[2] !== "blob" || segments.at(-1) !== "SKILL.md") {
    skillError(
      "invalid_skill_source",
      "GitHub URL must point to a repository SKILL.md file"
    );
  }
  const [owner, repo, , ref, ...filePath] = segments;
  if (!owner || !repo || !ref || ref.startsWith("-") || !/^[A-Za-z0-9._/+-]+$/.test(ref) || !/^[A-Za-z0-9._-]+$/.test(owner) || !/^[A-Za-z0-9._-]+$/.test(repo)) {
    skillError("invalid_skill_source", "Invalid GitHub Skill URL");
  }
  const directory = filePath.slice(0, -1).join("/");
  const directorySegments = directory.split("/");
  if (directory && (directory.length > MAX_PATH_LENGTH || directory.includes("\\") || directory.startsWith("/") || directorySegments.length > MAX_PATH_DEPTH || directorySegments.some(
    (segment) => !segment || segment === "." || segment === ".."
  ))) {
    skillError("invalid_skill_source", "Invalid GitHub Skill URL path");
  }
  try {
    return await downloadGitHubDirectory(
      owner,
      repo,
      ref,
      directory,
      githubToken
    );
  } catch (error) {
    if (!(error instanceof WorkspaceSkillManagementError) || error.code !== "github_api_failed" || error.statusCode === 404) {
      throw error;
    }
    return downloadGitHubDirectoryWithGit(owner, repo, ref, directory);
  }
}
__name(downloadGitHubSkill, "downloadGitHubSkill");
function openZip(content) {
  return new Promise((resolve3, reject) => {
    (0, import_yauzl.fromBuffer)(content, { lazyEntries: true }, (error, zipFile) => {
      if (error) reject(error);
      else resolve3(zipFile);
    });
  });
}
__name(openZip, "openZip");
function readZipEntry(zipFile, entry) {
  return new Promise((resolve3, reject) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error) {
        reject(error);
        return;
      }
      const chunks = [];
      let size = 0;
      stream.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_FILE_BYTES) {
          stream.destroy(
            new WorkspaceSkillManagementError(
              "skill_package_too_large",
              `Skill ZIP entry is too large: ${entry.fileName}`,
              413
            )
          );
        } else {
          chunks.push(chunk);
        }
      });
      stream.on("error", reject);
      stream.on("end", () => resolve3(Buffer.concat(chunks)));
    });
  });
}
__name(readZipEntry, "readZipEntry");
async function filesFromZip(content) {
  const zipFile = await openZip(content);
  const files = [];
  let totalBytes = 0;
  return new Promise((resolve3, reject) => {
    let settled = false;
    const finish = /* @__PURE__ */ __name((error) => {
      if (settled) return;
      settled = true;
      zipFile.close();
      if (error) reject(error);
      else resolve3(files);
    }, "finish");
    zipFile.on("error", finish);
    zipFile.on("entry", (entry) => {
      const mode = entry.externalFileAttributes >>> 16 & 65535;
      const fileType = mode & 61440;
      if (fileType === 40960) {
        finish(new Error("Skill ZIP contains a symbolic link"));
        return;
      }
      if (entry.generalPurposeBitFlag & 1) {
        finish(new Error("Encrypted Skill ZIP entries are not supported"));
        return;
      }
      if (entry.fileName.endsWith("/") || fileType === 16384) {
        zipFile.readEntry();
        return;
      }
      if (files.length >= MAX_FILES) {
        finish(
          new WorkspaceSkillManagementError(
            "invalid_skill_package",
            "Skill ZIP contains too many files"
          )
        );
        return;
      }
      if (entry.uncompressedSize > MAX_FILE_BYTES) {
        finish(
          new WorkspaceSkillManagementError(
            "skill_package_too_large",
            "Skill ZIP entry exceeds the allowed size",
            413
          )
        );
        return;
      }
      if (totalBytes + entry.uncompressedSize > MAX_TOTAL_BYTES) {
        finish(
          new WorkspaceSkillManagementError(
            "skill_package_too_large",
            "Skill ZIP expands beyond the allowed size",
            413
          )
        );
        return;
      }
      void readZipEntry(zipFile, entry).then((entryContent) => {
        totalBytes += entryContent.length;
        if (totalBytes > MAX_TOTAL_BYTES) {
          finish(
            new WorkspaceSkillManagementError(
              "skill_package_too_large",
              "Skill ZIP expands beyond the allowed size",
              413
            )
          );
          return;
        }
        files.push({ relativePath: entry.fileName, content: entryContent });
        if (!settled) zipFile.readEntry();
      }, finish);
    });
    zipFile.on("end", () => finish());
    zipFile.readEntry();
  });
}
__name(filesFromZip, "filesFromZip");
async function filesFromSource(source, githubToken) {
  try {
    if (source.type === "github")
      return normalizePackageFiles(
        await downloadGitHubSkill(source.url, githubToken)
      );
    if (source.type === "folder")
      return normalizePackageFiles(await filesFromFolder(source.path));
    const archive = decodeBase64(source.contentBase64);
    return normalizePackageFiles(await filesFromZip(archive));
  } catch (error) {
    if (error instanceof WorkspaceSkillManagementError) throw error;
    const code = source.type === "github" ? "github_skill_download_failed" : source.type === "folder" ? "invalid_skill_folder" : "invalid_skill_package";
    throw new WorkspaceSkillManagementError(
      code,
      error instanceof Error ? error.message : String(error),
      source.type === "github" ? 502 : 400
    );
  }
}
__name(filesFromSource, "filesFromSource");
async function filesFromFolder(folderPath) {
  if (!path.isAbsolute(folderPath)) {
    skillError("invalid_skill_folder", "Skill folder path must be absolute");
  }
  if ((await fs.lstat(folderPath)).isSymbolicLink()) {
    skillError(
      "invalid_skill_folder",
      "Skill folder path must not be a symbolic link"
    );
  }
  const root = await fs.realpath(folderPath);
  if (!(await fs.stat(root)).isDirectory()) {
    skillError(
      "invalid_skill_folder",
      "Skill folder path must point to a directory"
    );
  }
  const files = [];
  let totalBytes = 0;
  const visit = /* @__PURE__ */ __name(async (directory, relativeRoot = "", depth = 0) => {
    if (depth > MAX_PATH_DEPTH)
      skillError("invalid_skill_package", "Skill folder is nested too deeply");
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (depth === 0 && entry.name === ".git") continue;
      const absolutePath = path.join(directory, entry.name);
      const relativePath = relativeRoot ? `${relativeRoot}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        skillError(
          "unsafe_skill_path",
          "Skill folder contains a symbolic link"
        );
      }
      if (entry.isDirectory()) {
        await visit(absolutePath, relativePath, depth + 1);
        continue;
      }
      if (!entry.isFile())
        skillError("unsafe_skill_path", "Skill folder contains a special file");
      if (files.length >= MAX_FILES) {
        skillError("invalid_skill_package", "Skill package has too many files");
      }
      const stats = await fs.lstat(absolutePath);
      if (stats.isSymbolicLink() || !stats.isFile()) {
        skillError("unsafe_skill_path", "Skill folder contains an unsafe file");
      }
      if (stats.size > MAX_FILE_BYTES) {
        skillError(
          "skill_package_too_large",
          `Skill file is too large: ${relativePath}`,
          413
        );
      }
      totalBytes += stats.size;
      if (totalBytes > MAX_TOTAL_BYTES) {
        skillError(
          "skill_package_too_large",
          "Skill package exceeds the allowed size",
          413
        );
      }
      const content = await fs.readFile(absolutePath);
      if (content.length !== stats.size) {
        skillError(
          "invalid_skill_package",
          `Skill file changed while reading: ${relativePath}`
        );
      }
      files.push({ relativePath, content });
    }
  }, "visit");
  await visit(root);
  return files;
}
__name(filesFromFolder, "filesFromFolder");
function skillBaseDir(workspace, scope) {
  return scope === "workspace" ? path.join(workspace, ".qwen", "skills") : path.join(Storage.getGlobalQwenDir(), "skills");
}
__name(skillBaseDir, "skillBaseDir");
async function removeInstallArtifacts(baseDir, skillName, assertGenerationOpen) {
  const workDir = path.dirname(baseDir);
  const workPrefix = `.${path.basename(baseDir)}-${skillName}`;
  const locations = [
    {
      directory: baseDir,
      prefixes: [`.${skillName}.installing-`, `.${skillName}.backup-`]
    },
    {
      directory: workDir,
      prefixes: [`${workPrefix}.installing-`, `${workPrefix}.backup-`]
    }
  ];
  for (const { directory, prefixes } of locations) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    await Promise.all(
      entries.filter(
        (entry) => prefixes.some((prefix) => entry.name.startsWith(prefix))
      ).map(async (entry) => {
        assertGenerationOpen?.();
        await fs.rm(path.join(directory, entry.name), {
          recursive: true,
          force: true
        });
      })
    );
  }
}
__name(removeInstallArtifacts, "removeInstallArtifacts");
async function ensureDirectoryWithoutSymlinks(directory, assertGenerationOpen) {
  const missing = [];
  let current = directory;
  while (true) {
    try {
      const stats = await fs.lstat(current);
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        skillError("unsafe_skill_path", `Unsafe Skill directory: ${current}`);
      }
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      missing.push(current);
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
  for (const entry of missing.reverse()) {
    assertGenerationOpen?.();
    await fs.mkdir(entry);
  }
}
__name(ensureDirectoryWithoutSymlinks, "ensureDirectoryWithoutSymlinks");
async function installWorkspaceSkill(workspace, request, githubToken, assertGenerationOpen) {
  assertGenerationOpen?.();
  const skillName = validateWorkspaceSkillName(request.name);
  rejectInstallArtifactSkillName(skillName);
  const files = await filesFromSource(request.source, githubToken);
  const baseDir = skillBaseDir(workspace, request.scope);
  assertGenerationOpen?.();
  await ensureDirectoryWithoutSymlinks(baseDir, assertGenerationOpen);
  assertGenerationOpen?.();
  await removeInstallArtifacts(baseDir, skillName, assertGenerationOpen);
  const destination = path.join(baseDir, skillName);
  const existing = await fs.lstat(destination).catch(() => void 0);
  if (existing?.isSymbolicLink() || existing && !existing.isDirectory()) {
    skillError("unsafe_skill_path", "Refusing to replace an unsafe Skill path");
  }
  const workDir = path.dirname(baseDir);
  const workPrefix = `.${path.basename(baseDir)}-${skillName}`;
  assertGenerationOpen?.();
  const staging = await fs.mkdtemp(
    path.join(workDir, `${workPrefix}.installing-`)
  );
  const backup = path.join(workDir, `${workPrefix}.backup-${Date.now()}`);
  let movedExisting = false;
  let committedStaging = false;
  try {
    for (const file of files) {
      const target = path.join(staging, ...file.relativePath.split("/"));
      assertGenerationOpen?.();
      await fs.mkdir(path.dirname(target), { recursive: true });
      assertGenerationOpen?.();
      await fs.writeFile(target, file.content);
    }
    const skillFile = path.join(staging, "SKILL.md");
    let parsed;
    try {
      parsed = new SkillManager({}).parseSkillContent(
        await fs.readFile(skillFile, "utf8"),
        skillFile,
        request.scope === "workspace" ? "project" : "user"
      );
    } catch (error) {
      throw new WorkspaceSkillManagementError(
        "invalid_skill_manifest",
        error instanceof Error ? error.message : String(error)
      );
    }
    if (parsed.name !== skillName) {
      skillError(
        "skill_name_mismatch",
        `Skill name "${parsed.name}" does not match requested name "${skillName}"`
      );
    }
    if (existing) {
      assertGenerationOpen?.();
      await fs.rename(destination, backup);
      movedExisting = true;
    }
    assertGenerationOpen?.();
    await fs.rename(staging, destination);
    committedStaging = true;
    assertGenerationOpen?.();
  } catch (error) {
    await fs.rm(committedStaging ? destination : staging, {
      recursive: true,
      force: true
    }).catch(() => void 0);
    if (movedExisting) {
      await fs.rename(backup, destination).catch(() => void 0);
    }
    throw error;
  }
  if (movedExisting) {
    await fs.rm(backup, { recursive: true, force: true }).catch(() => void 0);
  }
  return {
    skillName,
    scope: request.scope,
    installedPath: path.join(destination, "SKILL.md")
  };
}
__name(installWorkspaceSkill, "installWorkspaceSkill");
async function deleteWorkspaceSkill(workspace, scope, skillNameInput, installedPath, assertGenerationOpen) {
  assertGenerationOpen?.();
  const skillName = validateWorkspaceSkillName(skillNameInput);
  const skillDir = path.resolve(path.dirname(installedPath));
  const skillFile = path.resolve(installedPath);
  const allowedBaseDirs = new SkillManager({
    getProjectRoot: /* @__PURE__ */ __name(() => workspace, "getProjectRoot")
  }).getSkillsBaseDirs(scope === "workspace" ? "project" : "user").map((directory) => path.resolve(directory));
  const baseDir = path.dirname(skillDir);
  if (skillFile !== path.join(skillDir, "SKILL.md") || !allowedBaseDirs.includes(baseDir) || path.basename(skillDir) !== skillName) {
    skillError(
      "skill_not_managed",
      "Skill is not managed in the requested scope",
      409
    );
  }
  const baseRealPath = await fs.realpath(baseDir);
  const skillDirStats = await fs.lstat(skillDir);
  const skillFileStats = await fs.lstat(skillFile);
  if (skillDirStats.isSymbolicLink() || !skillDirStats.isDirectory() || skillFileStats.isSymbolicLink() || !skillFileStats.isFile()) {
    skillError("unsafe_skill_path", "Refusing to delete an unsafe Skill path");
  }
  const skillDirRealPath = await fs.realpath(skillDir);
  if (path.dirname(skillDirRealPath) !== baseRealPath) {
    skillError("unsafe_skill_path", "Refusing to delete an unsafe Skill path");
  }
  const parsed = new SkillManager({}).parseSkillContent(
    await fs.readFile(skillFile, "utf8"),
    skillFile,
    scope === "workspace" ? "project" : "user"
  );
  if (parsed.name !== skillName) {
    skillError(
      "skill_name_mismatch",
      "Skill name does not match its installed directory"
    );
  }
  assertGenerationOpen?.();
  await fs.rm(skillDir, { recursive: true, force: true });
  return { skillName, scope, deleted: true };
}
__name(deleteWorkspaceSkill, "deleteWorkspaceSkill");

// packages/cli/src/serve/workspace-service/index.ts
var WORKSPACE_SKILLS_SNAPSHOT_TTL_MS = 5e3;
function createSkillToggleMutation(input) {
  return {
    id: randomUUID(),
    kind: "skill_toggle",
    skills: input.skills.map((skill) => ({
      name: skill.name,
      enabled: skill.enabled
    })),
    activation: input.activation,
    sessionsRefreshed: input.sessionsRefreshed,
    sessionsFailed: input.sessionsFailed
  };
}
__name(createSkillToggleMutation, "createSkillToggleMutation");
async function canonicalizeExistingAncestor(inputPath) {
  let current = inputPath;
  while (true) {
    try {
      return await fs2.realpath(current);
    } catch (err) {
      const code = err?.code;
      if (code !== "ENOENT" && code !== "ENOTDIR" && code !== "ELOOP") {
        throw err;
      }
      const parent = path2.dirname(current);
      if (parent === current) throw err;
      current = parent;
    }
  }
}
__name(canonicalizeExistingAncestor, "canonicalizeExistingAncestor");
async function verifyParentPostOpen(target, wsCanonical, _fh) {
  const parentCanonical = await canonicalizeExistingAncestor(
    path2.dirname(target)
  );
  const within = parentCanonical === wsCanonical || parentCanonical.startsWith(wsCanonical + path2.sep);
  if (within) return;
  throw new WorkspaceInitSymlinkError(
    target,
    "parent",
    `Workspace context file ${JSON.stringify(target)}'s parent moved outside the workspace between the pre-open canonicalize and the post-open verify (parent canonicalizes to ${JSON.stringify(parentCanonical)}, workspace canonicalizes to ${JSON.stringify(wsCanonical)}). Refusing to write \u2014 investigate the concurrent writer or the parent-directory permissions.`
  );
}
__name(verifyParentPostOpen, "verifyParentPostOpen");
var TimeoutError = class extends Error {
  static {
    __name(this, "TimeoutError");
  }
};
async function withTimeout(promise, timeoutMs, label) {
  return await new Promise((resolve3, reject) => {
    const timeout = setTimeout(() => {
      reject(new TimeoutError(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve3(value);
      },
      (err) => {
        clearTimeout(timeout);
        reject(err);
      }
    );
  });
}
__name(withTimeout, "withTimeout");
function createDaemonWorkspaceService(deps) {
  const {
    boundWorkspace,
    isWorkspaceTrusted,
    assertGenerationOpen,
    contextFilename,
    statusProvider,
    workspaceProvidersStatusProvider,
    workspaceSkillsStatusProvider,
    isChannelLive,
    persistDisabledTools,
    persistDisabledSkills,
    persistDisabledSkillsBatch,
    persistSetting,
    persistSettings,
    skillInstallEnv,
    voiceEnv,
    voiceSettingsScope,
    preheatAcpChild: preheatAcpChildOnBridge,
    queryWorkspaceStatus,
    invokeWorkspaceCommand,
    refreshExtensionsForAllSessions: refreshExtensionsForAllSessionsOnBridge,
    publishWorkspaceEvent
  } = deps;
  const loadBoundSettings = /* @__PURE__ */ __name((skipLoadEnvironment = false) => {
    const workspaceTrusted = isWorkspaceTrusted();
    return loadSettings(boundWorkspace, {
      skipLoadEnvironment: skipLoadEnvironment || !workspaceTrusted,
      skipWorkspaceSettings: !workspaceTrusted,
      workspaceTrusted
    });
  }, "loadBoundSettings");
  const assertActiveGeneration = /* @__PURE__ */ __name(() => assertGenerationOpen?.(), "assertActiveGeneration");
  const loggedPreheatFailures = /* @__PURE__ */ new WeakSet();
  const logPreheatFailure = /* @__PURE__ */ __name((err) => {
    if (typeof err === "object" && err !== null) {
      if (loggedPreheatFailures.has(err)) return;
      loggedPreheatFailures.add(err);
    }
    writeStderrLineSafe(
      `qwen serve: ACP preheat failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }, "logPreheatFailure");
  let lastWorkspaceSkillsStatus;
  let lastWorkspaceSkillsStatusAt = 0;
  let workspaceSkillsGeneration = 0;
  let inFlightWorkspaceSkillsStatus;
  const invalidateWorkspaceSkillsSnapshot = /* @__PURE__ */ __name(() => {
    workspaceSkillsGeneration += 1;
    lastWorkspaceSkillsStatus = void 0;
    lastWorkspaceSkillsStatusAt = 0;
    workspaceSkillsStatusProvider?.invalidate?.(boundWorkspace);
  }, "invalidateWorkspaceSkillsSnapshot");
  const getWorkspaceSkillsConfigStatus = /* @__PURE__ */ __name(async () => {
    if (workspaceSkillsStatusProvider) {
      try {
        return await workspaceSkillsStatusProvider(boundWorkspace);
      } catch (err) {
        writeStderrLine(
          `qwen serve: getWorkspaceSkillsConfigStatus local provider failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    return createIdleWorkspaceSkillsStatus(boundWorkspace);
  }, "getWorkspaceSkillsConfigStatus");
  const readWorkspaceSkillsStatus = /* @__PURE__ */ __name(async (generation) => {
    let status;
    try {
      status = await queryWorkspaceStatus(
        SERVE_STATUS_EXT_METHODS.workspaceSkills,
        () => createIdleWorkspaceSkillsStatus(boundWorkspace)
      );
    } catch (err) {
      writeStderrLine(
        `qwen serve: getWorkspaceSkillsStatus query failed: ${err instanceof Error ? err.message : String(err)}`
      );
      status = createIdleWorkspaceSkillsStatus(boundWorkspace);
    }
    if (status.initialized && generation === workspaceSkillsGeneration) {
      lastWorkspaceSkillsStatus = status;
      lastWorkspaceSkillsStatusAt = Date.now();
      return status;
    }
    if (lastWorkspaceSkillsStatus) {
      if (generation === workspaceSkillsGeneration) {
        lastWorkspaceSkillsStatusAt = Date.now();
      }
      return lastWorkspaceSkillsStatus;
    }
    if (workspaceSkillsStatusProvider) {
      try {
        const localStatus = await workspaceSkillsStatusProvider(boundWorkspace);
        if (localStatus.initialized && generation === workspaceSkillsGeneration) {
          lastWorkspaceSkillsStatus = localStatus;
          lastWorkspaceSkillsStatusAt = Date.now();
        }
        return localStatus;
      } catch (err) {
        writeStderrLine(
          `qwen serve: getWorkspaceSkillsStatus local provider failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    return status;
  }, "readWorkspaceSkillsStatus");
  const getWorkspaceSkillsStatus = /* @__PURE__ */ __name(() => {
    const cacheAgeMs = Date.now() - lastWorkspaceSkillsStatusAt;
    if (lastWorkspaceSkillsStatus && cacheAgeMs >= 0 && cacheAgeMs < WORKSPACE_SKILLS_SNAPSHOT_TTL_MS) {
      return Promise.resolve(lastWorkspaceSkillsStatus);
    }
    const generation = workspaceSkillsGeneration;
    if (inFlightWorkspaceSkillsStatus?.generation === generation) {
      return inFlightWorkspaceSkillsStatus.promise;
    }
    const promise = readWorkspaceSkillsStatus(generation);
    inFlightWorkspaceSkillsStatus = { generation, promise };
    const clearInFlight = /* @__PURE__ */ __name(() => {
      if (inFlightWorkspaceSkillsStatus?.promise === promise) {
        inFlightWorkspaceSkillsStatus = void 0;
      }
    }, "clearInFlight");
    void promise.then(clearInFlight, clearInFlight);
    return promise;
  }, "getWorkspaceSkillsStatus");
  const refreshWorkspaceSkillsAfterMutation = /* @__PURE__ */ __name(async () => {
    invalidateWorkspaceSkillsSnapshot();
    if (!(isChannelLive?.() ?? false)) return;
    try {
      const refreshed = await invokeWorkspaceCommand(
        SERVE_CONTROL_EXT_METHODS.workspaceSkillsRefresh,
        { cwd: boundWorkspace, reason: "content" }
      );
      if ((refreshed.configsFailed ?? 0) > 0) {
        writeStderrLine(
          `qwen serve: ${refreshed.configsFailed} skill cache refresh(es) failed after mutation`
        );
      }
    } catch (err) {
      if (!(err instanceof SessionNotFoundError) && !(err instanceof BridgeChannelClosedError)) {
        writeStderrLine(
          `qwen serve: workspace skill refresh after mutation failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    } finally {
      invalidateWorkspaceSkillsSnapshot();
    }
  }, "refreshWorkspaceSkillsAfterMutation");
  return {
    // -- Status queries (delegate to ACP child via queryWorkspaceStatus) --
    async getWorkspaceMcpStatus(_ctx) {
      return queryWorkspaceStatus(
        SERVE_STATUS_EXT_METHODS.workspaceMcp,
        () => createIdleWorkspaceMcpStatus(boundWorkspace)
      );
    },
    async getWorkspaceSkillsStatus(_ctx) {
      return getWorkspaceSkillsStatus();
    },
    async getWorkspaceSkillsRuntimeStatus(_ctx) {
      return queryWorkspaceStatus(
        SERVE_STATUS_EXT_METHODS.workspaceSkills,
        () => createIdleWorkspaceSkillsStatus(boundWorkspace)
      );
    },
    async getWorkspaceSkillsConfigStatus(_ctx) {
      return getWorkspaceSkillsConfigStatus();
    },
    async getWorkspaceProvidersStatus(_ctx) {
      if (workspaceProvidersStatusProvider) {
        return workspaceProvidersStatusProvider(
          boundWorkspace,
          isChannelLive?.() ?? false
        );
      }
      return queryWorkspaceStatus(
        SERVE_STATUS_EXT_METHODS.workspaceProviders,
        () => createIdleWorkspaceProvidersStatus(boundWorkspace)
      );
    },
    async preheatAcpChild(_ctx, opts) {
      assertActiveGeneration();
      const startedAt = performance.now();
      const channelLive = /* @__PURE__ */ __name(() => isChannelLive?.() ?? false, "channelLive");
      const finish = /* @__PURE__ */ __name((result) => ({
        ...result,
        durationMs: Math.max(0, Math.round(performance.now() - startedAt))
      }), "finish");
      if (!preheatAcpChildOnBridge) {
        if (channelLive()) {
          return finish({ ready: true, channelLive: true });
        }
        return finish({
          ready: false,
          channelLive: false,
          reason: "error",
          error: "ACP preheat is unavailable"
        });
      }
      const preheat = Promise.resolve().then(() => preheatAcpChildOnBridge());
      void preheat.catch(logPreheatFailure);
      try {
        await withTimeout(preheat, opts?.timeoutMs ?? 5e3, "ACP preheat");
      } catch (err) {
        if (err instanceof TimeoutError) {
          writeStderrLineSafe(
            `qwen serve: ACP preheat timed out after ${opts?.timeoutMs ?? 5e3}ms`
          );
        }
        const live2 = channelLive();
        if (live2) {
          return finish({ ready: true, channelLive: true });
        }
        return finish({
          ready: false,
          channelLive: false,
          reason: err instanceof TimeoutError ? "timeout" : "error",
          error: err instanceof TimeoutError ? "ACP preheat did not complete before the timeout" : "ACP preheat failed"
        });
      }
      const live = channelLive();
      if (!live) {
        writeStderrLineSafe(
          "qwen serve: ACP preheat resolved without a live channel"
        );
      }
      return live ? finish({ ready: true, channelLive: true }) : finish({
        ready: false,
        channelLive: false,
        reason: "error",
        error: "ACP preheat did not produce a live channel"
      });
    },
    async getWorkspaceAcpStatus(_ctx) {
      return { channelLive: isChannelLive?.() ?? false };
    },
    async getWorkspaceEnvStatus(_ctx) {
      const acpChannelLive = isChannelLive?.() ?? false;
      if (!statusProvider) {
        return createIdleEnvStatus(boundWorkspace, acpChannelLive);
      }
      try {
        return await statusProvider.getEnvStatus(
          boundWorkspace,
          acpChannelLive
        );
      } catch (err) {
        writeStderrLine(
          `qwen serve: getEnvStatus failed: ${err instanceof Error ? err.message : String(err)}`
        );
        return createIdleEnvStatus(boundWorkspace, acpChannelLive);
      }
    },
    async getWorkspacePreflightStatus(_ctx) {
      const acpChannelLive = isChannelLive?.() ?? false;
      const idleCells = createIdleAcpPreflightCells();
      let daemonCells = [];
      if (statusProvider) {
        try {
          daemonCells = await statusProvider.getDaemonPreflightCells(boundWorkspace);
        } catch (err) {
          writeStderrLine(
            `qwen serve: getDaemonPreflightCells failed: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
      let acpCells = idleCells;
      let errors;
      if (acpChannelLive) {
        try {
          const acpResult = await queryWorkspaceStatus(
            SERVE_STATUS_EXT_METHODS.workspacePreflight,
            () => ({ cells: idleCells })
          );
          if (acpResult && "cells" in acpResult) {
            const result = acpResult;
            acpCells = result.cells.filter((c) => c.locality !== "daemon");
            errors = result.errors;
          }
        } catch (err) {
          acpCells = idleCells;
          const errorKind = mapDomainErrorToErrorKind(err);
          errors = [
            {
              kind: "preflight",
              status: "error",
              error: err instanceof Error ? err.message : String(err),
              ...errorKind ? { errorKind } : {}
            }
          ];
        }
      }
      return {
        v: STATUS_SCHEMA_VERSION,
        workspaceCwd: boundWorkspace,
        initialized: true,
        acpChannelLive,
        cells: [...daemonCells, ...acpCells],
        ...errors && errors.length > 0 ? { errors } : {}
      };
    },
    async getWorkspaceHooksStatus(_ctx) {
      return queryWorkspaceStatus(
        SERVE_STATUS_EXT_METHODS.workspaceHooks,
        () => createIdleWorkspaceHooksStatus(boundWorkspace)
      );
    },
    async getWorkspaceExtensionsStatus(_ctx) {
      return queryWorkspaceStatus(
        SERVE_STATUS_EXT_METHODS.workspaceExtensions,
        () => createIdleWorkspaceExtensionsStatus(boundWorkspace)
      );
    },
    async getWorkspaceTrustStatus(_ctx) {
      return getWorkspaceTrustStatus(
        loadBoundSettings(true).merged,
        boundWorkspace
      );
    },
    async getWorkspacePermissionsStatus(_ctx) {
      return buildPermissionSettings(loadBoundSettings());
    },
    async getWorkspaceVoiceStatus(_ctx) {
      return buildWorkspaceVoiceStatus(
        boundWorkspace,
        loadBoundSettings(Boolean(voiceEnv))
      );
    },
    // -- Mutations --
    async requestWorkspaceTrustChange(ctx, request) {
      assertActiveGeneration();
      publishWorkspaceEvent({
        type: "trust_change_requested",
        data: {
          workspaceCwd: boundWorkspace,
          desiredState: request.desiredState,
          ...request.reason !== void 0 ? { reason: request.reason } : {}
        },
        originatorClientId: ctx.originatorClientId
      });
      return {
        accepted: false,
        desiredState: request.desiredState,
        requiresOperatorAction: true
      };
    },
    async setWorkspacePermissionRules(ctx, request) {
      assertActiveGeneration();
      const key = `permissions.${request.ruleType}`;
      try {
        const result = await invokeWorkspaceCommand(
          "qwen/permissions/setRules",
          {
            cwd: boundWorkspace,
            scope: request.scope,
            ruleType: request.ruleType,
            rules: request.rules
          }
        );
        assertActiveGeneration();
        publishWorkspaceEvent({
          type: "settings_changed",
          data: { key, value: request.rules, scope: request.scope },
          originatorClientId: ctx.originatorClientId
        });
        return result;
      } catch (err) {
        if (!(err instanceof SessionNotFoundError)) {
          throw err;
        }
        throw new WorkspacePermissionRulesSessionRequiredError();
      }
    },
    async setWorkspaceVoiceSettings(ctx, request) {
      assertActiveGeneration();
      if (!persistSettings && !persistSetting) {
        throw new WorkspaceVoiceError(
          501,
          "not_implemented",
          "Workspace voice settings persistence is not available"
        );
      }
      const settings = loadBoundSettings(Boolean(voiceEnv));
      validateWorkspaceVoiceState(settings, request, { env: voiceEnv });
      const writes = buildWorkspaceVoiceSettingsWrites(settings, request, {
        workspaceTrusted: isWorkspaceTrusted(),
        ...voiceSettingsScope ? { scopeOverride: voiceSettingsScope } : {}
      });
      const publishWrite = /* @__PURE__ */ __name((write) => {
        publishWorkspaceEvent({
          type: "settings_changed",
          data: {
            key: write.key,
            value: write.value,
            scope: voiceSettingsScopeToWire(write.scope)
          },
          originatorClientId: ctx.originatorClientId
        });
      }, "publishWrite");
      if (persistSettings) {
        try {
          await persistSettings(boundWorkspace, writes, assertGenerationOpen);
        } catch (err) {
          if (err instanceof WorkspaceSettingsPartialPersistError) {
            assertActiveGeneration();
            for (const write of err.committedWrites) {
              publishWrite(write);
            }
          }
          throw err;
        }
        assertActiveGeneration();
        for (const write of writes) {
          publishWrite(write);
        }
      } else {
        const committed = [];
        for (const write of writes) {
          try {
            await persistSetting(
              boundWorkspace,
              write.scope,
              write.key,
              write.value,
              assertGenerationOpen
            );
          } catch (err) {
            assertActiveGeneration();
            writeStderrLine(
              `qwen serve: workspace voice partial persist error (workspace=${boundWorkspace}, committed=${committed.length}/${writes.length}, failedKey=${write.key}, failedScope=${voiceSettingsScopeToWire(write.scope)}): ${err instanceof Error ? err.message : String(err)}`
            );
            for (const committedWrite of committed) {
              publishWrite(committedWrite);
            }
            throw new WorkspaceSettingsPartialPersistError(
              `Voice settings partial persist failed: committed=${committed.length}/${writes.length}`,
              committed,
              err
            );
          }
          assertActiveGeneration();
          committed.push(write);
        }
        assertActiveGeneration();
        for (const write of committed) {
          publishWrite(write);
        }
      }
      return buildWorkspaceVoiceStatus(
        boundWorkspace,
        loadBoundSettings(Boolean(voiceEnv))
      );
    },
    async setWorkspaceToolEnabled(ctx, toolName, enabled) {
      assertActiveGeneration();
      await persistDisabledTools(
        boundWorkspace,
        toolName,
        enabled,
        assertGenerationOpen
      );
      assertActiveGeneration();
      publishWorkspaceEvent({
        type: "tool_toggled",
        data: { toolName, enabled },
        originatorClientId: ctx.originatorClientId
      });
      return { toolName, enabled };
    },
    async setWorkspaceSkillEnabled(ctx, requestedSkillName, enabled, opts) {
      assertActiveGeneration();
      const skillName = requestedSkillName.trim();
      const persisted = await persistDisabledSkills(
        boundWorkspace,
        skillName,
        enabled,
        assertGenerationOpen
      );
      assertActiveGeneration();
      const channelLive = isChannelLive?.() ?? false;
      const refreshRuntime = opts?.refreshRuntime !== false;
      let activation = channelLive ? persisted.changed && !refreshRuntime ? "reconciling" : "applied" : "deferred";
      let sessionsRefreshed = 0;
      let sessionsFailed = 0;
      if (persisted.changed) {
        invalidateWorkspaceSkillsSnapshot();
        if (channelLive && refreshRuntime) {
          try {
            const refreshed = await invokeWorkspaceCommand(
              SERVE_CONTROL_EXT_METHODS.workspaceSkillsRefresh,
              { cwd: boundWorkspace, reason: "settings" }
            );
            assertActiveGeneration();
            sessionsRefreshed = refreshed.sessionsRefreshed;
            sessionsFailed = refreshed.sessionsFailed;
            if (sessionsFailed > 0) activation = "partial";
          } catch (err) {
            if (err instanceof SessionNotFoundError || err instanceof BridgeChannelClosedError) {
              activation = "deferred";
            } else {
              activation = "partial";
              sessionsFailed = 1;
              writeStderrLine(
                `qwen serve: workspace skill refresh failed: ${err instanceof Error ? err.message : String(err)}`
              );
            }
          }
          invalidateWorkspaceSkillsSnapshot();
        }
        assertActiveGeneration();
        const settingsChanges = persisted.settingsChanges ?? [
          {
            key: "skills.disabled",
            value: persisted.disabled.length > 0 ? persisted.disabled : void 0
          }
        ];
        const mutation = createSkillToggleMutation({
          skills: [{ name: skillName, enabled }],
          activation,
          sessionsRefreshed,
          sessionsFailed
        });
        for (const change of settingsChanges) {
          publishWorkspaceEvent({
            type: "settings_changed",
            data: {
              key: change.key,
              value: change.value,
              scope: "workspace",
              mutation
            },
            originatorClientId: ctx.originatorClientId
          });
        }
      }
      return {
        skillName,
        enabled,
        changed: persisted.changed,
        ...persisted.block ? { block: persisted.block } : {},
        activation,
        sessionsRefreshed,
        sessionsFailed
      };
    },
    async setWorkspaceSkillsEnabled(ctx, requestedSkillNames, enabled) {
      assertActiveGeneration();
      const skillNames = requestedSkillNames.map((name) => name.trim());
      const persisted = skillNames.length > 0 ? await persistDisabledSkillsBatch(
        boundWorkspace,
        skillNames,
        enabled,
        assertGenerationOpen
      ) : { outcomes: [], settingsChanges: [] };
      assertActiveGeneration();
      const persistedByName = new Map(
        persisted.outcomes.map((outcome) => [
          outcome.skillName.trim().toLowerCase(),
          outcome
        ])
      );
      const results = [];
      for (const skillName of skillNames) {
        const outcome = persistedByName.get(skillName.toLowerCase());
        if (!outcome) {
          throw new Error(
            `Missing persisted Skill batch outcome: ${skillName}`
          );
        }
        results.push({
          skillName: outcome.skillName,
          enabled,
          changed: outcome.changed
        });
      }
      const changed = results.some((result) => result.changed);
      const channelLive = isChannelLive?.() ?? false;
      let activation = channelLive ? "applied" : "deferred";
      let sessionsRefreshed = 0;
      let sessionsFailed = 0;
      if (changed) {
        invalidateWorkspaceSkillsSnapshot();
        if (channelLive) {
          try {
            const refreshed = await invokeWorkspaceCommand(
              SERVE_CONTROL_EXT_METHODS.workspaceSkillsRefresh,
              { cwd: boundWorkspace, reason: "settings" }
            );
            assertActiveGeneration();
            sessionsRefreshed = refreshed.sessionsRefreshed;
            sessionsFailed = refreshed.sessionsFailed;
            if (sessionsFailed > 0) activation = "partial";
          } catch (err) {
            if (err instanceof SessionNotFoundError || err instanceof BridgeChannelClosedError) {
              activation = "deferred";
            } else {
              activation = "partial";
              sessionsFailed = 1;
              writeStderrLine(
                `qwen serve: workspace skill refresh failed: ${err instanceof Error ? err.message : String(err)}`
              );
            }
          }
          invalidateWorkspaceSkillsSnapshot();
        }
        assertActiveGeneration();
        const mutation = createSkillToggleMutation({
          skills: results.filter((result) => result.changed).map((result) => ({
            name: result.skillName,
            enabled: result.enabled
          })),
          activation,
          sessionsRefreshed,
          sessionsFailed
        });
        for (const change of persisted.settingsChanges) {
          publishWorkspaceEvent({
            type: "settings_changed",
            data: { ...change, scope: "workspace", mutation },
            originatorClientId: ctx.originatorClientId
          });
        }
      }
      return {
        enabled,
        activation,
        sessionsRefreshed,
        sessionsFailed,
        results,
        errors: []
      };
    },
    async installWorkspaceSkill(_ctx, request, opts) {
      assertActiveGeneration();
      const result = await installWorkspaceSkill(
        boundWorkspace,
        request,
        skillInstallEnv?.["GH_TOKEN"] ?? skillInstallEnv?.["GITHUB_TOKEN"],
        assertGenerationOpen
      );
      assertActiveGeneration();
      if (opts?.refreshRuntime === false) invalidateWorkspaceSkillsSnapshot();
      else await refreshWorkspaceSkillsAfterMutation();
      assertActiveGeneration();
      return result;
    },
    async deleteWorkspaceSkill(_ctx, requestedSkillName, scope, opts) {
      assertActiveGeneration();
      const normalizedName = requestedSkillName.trim().toLowerCase();
      const exactName = requestedSkillName.trim();
      if (opts?.refreshRuntime === false) invalidateWorkspaceSkillsSnapshot();
      const status = opts?.refreshRuntime === false ? await getWorkspaceSkillsConfigStatus() : await getWorkspaceSkillsStatus();
      if (opts?.refreshRuntime === false && (!status.initialized || status.errors?.length)) {
        throw new WorkspaceSkillManagementError(
          "skills_config_unavailable",
          "Skills configuration could not be enumerated",
          503
        );
      }
      const expectedLevel = scope === "workspace" ? "project" : "user";
      const matches = status.skills.filter(
        (candidate) => candidate.name.trim().toLowerCase() === normalizedName
      );
      const scopedMatches = matches.filter(
        (candidate) => candidate.level === expectedLevel
      );
      const skill = scopedMatches.find((candidate) => candidate.name === exactName) ?? (scopedMatches.length === 1 ? scopedMatches[0] : void 0);
      if (!skill && matches.length === 0) {
        throw new WorkspaceSkillNotFoundError(requestedSkillName);
      }
      if (!skill?.installedPath) {
        throw new WorkspaceSkillManagementError(
          "skill_not_managed",
          "Skill is not managed in the requested scope",
          409
        );
      }
      let result;
      try {
        result = await deleteWorkspaceSkill(
          boundWorkspace,
          scope,
          skill.name,
          skill.installedPath,
          assertGenerationOpen
        );
      } catch (error) {
        if (error.code === "ENOENT") {
          throw new WorkspaceSkillNotFoundError(requestedSkillName);
        }
        throw error;
      }
      assertActiveGeneration();
      if (opts?.refreshRuntime === false) invalidateWorkspaceSkillsSnapshot();
      else await refreshWorkspaceSkillsAfterMutation();
      assertActiveGeneration();
      return result;
    },
    async initWorkspace(ctx, opts) {
      assertActiveGeneration();
      const filename = contextFilename;
      const target = path2.resolve(boundWorkspace, filename);
      const withinWorkspace = target === boundWorkspace || target.startsWith(boundWorkspace + path2.sep);
      if (!withinWorkspace) {
        throw new WorkspaceInitPathEscapeError(filename, boundWorkspace);
      }
      const wsCanonical = await fs2.realpath(boundWorkspace);
      const parentCanonical = await canonicalizeExistingAncestor(
        path2.dirname(target)
      );
      const parentWithinWorkspace = parentCanonical === wsCanonical || parentCanonical.startsWith(wsCanonical + path2.sep);
      if (!parentWithinWorkspace) {
        throw new WorkspaceInitSymlinkError(
          target,
          "parent",
          `Configured workspace context filename ${JSON.stringify(filename)} has a parent path that resolves outside the bound workspace (parent canonicalizes to ${JSON.stringify(parentCanonical)}, workspace canonicalizes to ${JSON.stringify(wsCanonical)}). Refusing to write \u2014 replace any symlinked parent directory with a real directory before re-running init.`
        );
      }
      try {
        const lst = await fs2.lstat(target);
        if (lst.isSymbolicLink()) {
          throw new WorkspaceInitSymlinkError(
            target,
            "target",
            `Workspace context file ${JSON.stringify(target)} is a symlink. Refusing to follow it for write \u2014 replace the symlink with a regular file (or remove it) before re-running init.`
          );
        }
        if (!lst.isFile()) {
          throw new WorkspaceInitSymlinkError(
            target,
            "target",
            `Workspace context file ${JSON.stringify(target)} is not a regular file (mode=${lst.mode.toString(8)}). Refusing to proceed \u2014 FIFOs, sockets, and device nodes can block or misbehave on read/write.`
          );
        }
      } catch (err) {
        if (err instanceof WorkspaceInitSymlinkError) throw err;
        const code = err?.code;
        if (code !== "ENOENT") throw err;
      }
      let action = "created";
      try {
        const existing = await fs2.readFile(target, "utf8");
        if (existing.trim().length > 0) {
          const existingSize = Buffer.byteLength(existing, "utf8");
          if (opts.force !== true) {
            throw new WorkspaceInitConflictError(target, existingSize);
          }
          action = "overwrote";
        } else {
          action = "noop";
        }
      } catch (err) {
        if (err instanceof WorkspaceInitConflictError) throw err;
        const code = err?.code;
        if (code !== "ENOENT") throw err;
      }
      if (action === "created") {
        let fh;
        try {
          assertActiveGeneration();
          fh = await fs2.open(target, "wx");
        } catch (err) {
          const code = err?.code;
          if (code === "EEXIST") {
            throw new WorkspaceInitRaceError(
              target,
              "eexist",
              `Workspace context file ${JSON.stringify(target)} appeared between our absence check and the create \u2014 refusing to proceed (a regular file or symlink was just placed at the target path, and following it could escape the workspace).`
            );
          }
          throw err;
        }
        try {
          await verifyParentPostOpen(target, wsCanonical, fh);
          assertActiveGeneration();
          await fh.writeFile("", "utf8");
        } finally {
          await fh.close();
        }
      } else if (action === "overwrote") {
        let overwriteFh;
        try {
          assertActiveGeneration();
          overwriteFh = await fs2.open(
            target,
            fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0)
          );
        } catch (err) {
          const code = err?.code;
          if (code === "ELOOP") {
            throw new WorkspaceInitSymlinkError(
              target,
              "target",
              `Workspace context file ${JSON.stringify(target)} could not be opened with O_NOFOLLOW (ELOOP); the path may have been swapped to a symlink between the content check and the overwrite. Refusing to follow it.`
            );
          }
          if (code === "ENOENT") {
            throw new WorkspaceInitRaceError(
              target,
              "enoent",
              `Workspace context file ${JSON.stringify(target)} was deleted between the content check and the overwrite (likely a concurrent writer). Refusing to recreate blindly; rerun init.`
            );
          }
          throw err;
        }
        try {
          await verifyParentPostOpen(target, wsCanonical, overwriteFh);
          assertActiveGeneration();
          await overwriteFh.truncate(0);
        } finally {
          await overwriteFh.close();
        }
      }
      assertActiveGeneration();
      publishWorkspaceEvent({
        type: "workspace_initialized",
        data: { path: target, action },
        originatorClientId: ctx.originatorClientId
      });
      return { path: target, action };
    },
    async restartMcpServer(ctx, serverName, opts) {
      assertActiveGeneration();
      const params = { serverName };
      if (opts?.entryIndex !== void 0) {
        params["entryIndex"] = opts.entryIndex;
      }
      let result;
      try {
        result = await invokeWorkspaceCommand(
          SERVE_CONTROL_EXT_METHODS.workspaceMcpRestart,
          params,
          { timeoutMs: MCP_RESTART_SERVER_DEADLINE_MS }
        );
      } catch (err) {
        const data = err?.data;
        if (data && typeof data === "object") {
          const kind = data.errorKind;
          const sn = data.serverName;
          if (kind === "mcp_server_not_found" && typeof sn === "string") {
            throw new McpServerNotFoundError(sn);
          }
          if (kind === "mcp_restart_failed" && typeof sn === "string") {
            const status = data.mcpStatus;
            throw new McpServerRestartFailedError(
              sn,
              typeof status === "string" ? status : "unknown"
            );
          }
        }
        throw err;
      }
      assertActiveGeneration();
      if ("entries" in result) {
        const entries = Array.isArray(result.entries) ? result.entries : [];
        if (!Array.isArray(result.entries)) {
          writeStderrLine(
            `qwen serve: pool restart response carried 'entries' field but it is not an array (server=${serverName}); treating as empty.`
          );
        }
        for (const entry of entries) {
          if (typeof entry !== "object" || entry === null || typeof entry.entryIndex !== "number") {
            writeStderrLine(
              `qwen serve: skipping malformed pool restart entry (server=${serverName}): ${JSON.stringify(entry)}`
            );
            continue;
          }
          if (entry.restarted) {
            publishWorkspaceEvent({
              type: "mcp_server_restarted",
              data: {
                serverName: result.serverName,
                durationMs: entry.durationMs ?? 0,
                entryIndex: entry.entryIndex
              },
              originatorClientId: ctx.originatorClientId
            });
          } else {
            publishWorkspaceEvent({
              type: "mcp_server_restart_refused",
              data: {
                serverName: result.serverName,
                reason: "restart_failed",
                entryIndex: entry.entryIndex,
                ...entry.reason ? { details: entry.reason } : {}
              },
              originatorClientId: ctx.originatorClientId
            });
          }
        }
      } else if (result.restarted === true) {
        publishWorkspaceEvent({
          type: "mcp_server_restarted",
          data: {
            serverName: result.serverName,
            durationMs: result.durationMs
          },
          originatorClientId: ctx.originatorClientId
        });
      } else {
        publishWorkspaceEvent({
          type: "mcp_server_restart_refused",
          data: {
            serverName: result.serverName,
            reason: result.reason
          },
          originatorClientId: ctx.originatorClientId
        });
      }
      return result;
    },
    async reload(ctx) {
      assertActiveGeneration();
      let runtimeEnvironmentApplied;
      if (deps.reloadDaemonEnv) {
        try {
          const result = await deps.reloadDaemonEnv(
            boundWorkspace,
            assertGenerationOpen
          );
          runtimeEnvironmentApplied = result.runtimeEnvironmentApplied;
        } catch (err) {
          runtimeEnvironmentApplied = false;
          writeStderrLine(
            `qwen serve: daemon reload failed: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
      assertActiveGeneration();
      let childReloaded = false;
      let env = {
        updatedKeys: [],
        removedKeys: []
      };
      let changedKeys = [];
      let sessionsRefreshed;
      let sessionsSkipped;
      let childError;
      try {
        const childResult = await invokeWorkspaceCommand(
          SERVE_CONTROL_EXT_METHODS.workspaceReload,
          { cwd: boundWorkspace },
          { timeoutMs: 3e4 }
        );
        childReloaded = true;
        env = childResult.env;
        changedKeys = childResult.changedKeys;
        sessionsRefreshed = childResult.sessionsRefreshed;
        sessionsSkipped = childResult.sessionsSkipped;
      } catch (err) {
        if (err instanceof SessionNotFoundError) {
          childError = "ACP child not running";
        } else {
          childError = err instanceof Error ? err.message : String(err);
          writeStderrLine(`qwen serve: reload failed: ${childError}`);
        }
      }
      assertActiveGeneration();
      publishWorkspaceEvent({
        type: "settings_reloaded",
        data: {
          env,
          changedKeys,
          childReloaded,
          sessionsRefreshed,
          sessionsSkipped,
          childError,
          ...runtimeEnvironmentApplied === void 0 ? {} : { runtimeEnvironmentApplied }
        },
        originatorClientId: ctx.originatorClientId
      });
      return {
        env,
        changedKeys,
        childReloaded,
        sessionsRefreshed,
        sessionsSkipped,
        childError,
        ...runtimeEnvironmentApplied === void 0 ? {} : { runtimeEnvironmentApplied }
      };
    },
    async reloadModelProviders(_ctx) {
      assertActiveGeneration();
      let failed = false;
      const reloadModelProvidersDaemonEnv = deps.reloadModelProvidersDaemonEnv ?? deps.reloadDaemonEnv;
      if (reloadModelProvidersDaemonEnv) {
        try {
          const result = await reloadModelProvidersDaemonEnv(
            boundWorkspace,
            assertGenerationOpen
          );
          failed = result.runtimeEnvironmentApplied === false;
        } catch {
          assertActiveGeneration();
          failed = true;
          writeStderrLine(
            "qwen serve: model-provider parent environment sync failed"
          );
        }
      }
      assertActiveGeneration();
      try {
        const child = await invokeWorkspaceCommand(
          SERVE_CONTROL_EXT_METHODS.workspaceModelProvidersReload,
          { cwd: boundWorkspace },
          { timeoutMs: 3e4 }
        );
        if ((child.configsFailed ?? 0) > 0) failed = true;
        return { status: failed ? "failed" : "applied" };
      } catch (err) {
        assertActiveGeneration();
        if (err instanceof SessionNotFoundError || err instanceof BridgeChannelClosedError) {
          return { status: failed ? "failed" : "deferred" };
        }
        writeStderrLine("qwen serve: model-provider ACP child sync failed");
        return { status: "failed" };
      }
    },
    invalidateWorkspaceSkillsStatus() {
      invalidateWorkspaceSkillsSnapshot();
    },
    async refreshExtensionsForAllSessions() {
      assertActiveGeneration();
      try {
        if (!refreshExtensionsForAllSessionsOnBridge) {
          throw new Error("refreshExtensionsForAllSessions is not wired");
        }
        return await refreshExtensionsForAllSessionsOnBridge();
      } catch (err) {
        writeStderrLine(
          `qwen serve: refreshExtensionsForAllSessions failed: ${err instanceof Error ? err.message : String(err)}`
        );
        return { refreshed: 0, failed: 1 };
      } finally {
        invalidateWorkspaceSkillsSnapshot();
      }
    }
  };
}
__name(createDaemonWorkspaceService, "createDaemonWorkspaceService");

export {
  MAX_WORKSPACE_SKILL_NAME_LENGTH,
  WorkspaceSkillManagementError,
  validateWorkspaceSkillName,
  installWorkspaceSkill,
  deleteWorkspaceSkill,
  EMPTY_WORKSPACE_VOICE_UPDATE_ERROR,
  WorkspaceVoiceError,
  voiceSettingsScopeToWire,
  buildWorkspaceVoiceSettingsWrites,
  hasConfiguredBatchVoiceTranscriptionModel,
  buildWorkspaceVoiceStatus,
  validateWorkspaceVoiceState,
  transcribeWorkspaceVoiceAudio,
  createDaemonWorkspaceService
};
/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
