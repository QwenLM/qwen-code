// Force strict mode and setup for ESM
"use strict";
import {
  DEFAULT_FILE_FILTERING_OPTIONS
} from "./chunk-IITTKFWM.js";
import {
  getMemoryBaseDir
} from "./chunk-RVT5L74D.js";
import "./chunk-HD7O6WLV.js";
import {
  BaseDeclarativeTool,
  BaseToolInvocation
} from "./chunk-VPGRGNNH.js";
import {
  ToolDisplayNames,
  ToolNames
} from "./chunk-ERIBG3BX.js";
import {
  Storage,
  createDebugLogger,
  isSubpath,
  isSubpaths,
  makeRelative,
  shortenPath,
  unescapePath
} from "./chunk-ZYDMQCQP.js";
import "./chunk-S34QJ6IR.js";
import "./chunk-TBWQLLFO.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/tools/ls.ts
init_esbuild_shims();
import fs from "node:fs/promises";
import path from "node:path";
var debugLogger = createDebugLogger("LS");
var MAX_ENTRY_COUNT = 100;
var LSToolInvocation = class extends BaseToolInvocation {
  constructor(config, params) {
    super(params);
    this.config = config;
  }
  static {
    __name(this, "LSToolInvocation");
  }
  /**
   * Checks if a filename matches any of the ignore patterns
   * @param filename Filename to check
   * @param patterns Array of glob patterns to check against
   * @returns True if the filename should be ignored
   */
  shouldIgnore(filename, patterns) {
    if (!patterns || patterns.length === 0) {
      return false;
    }
    for (const pattern of patterns) {
      const regexPattern = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
      const regex = new RegExp(`^${regexPattern}$`);
      if (regex.test(filename)) {
        return true;
      }
    }
    return false;
  }
  /**
   * Gets a description of the file reading operation
   * @returns A string describing the file being read
   */
  getDescription() {
    const relativePath = makeRelative(
      this.params.path,
      this.config.getTargetDir()
    );
    return shortenPath(relativePath);
  }
  /**
   * Returns 'ask' for paths outside the workspace/userSkills directories,
   * so that external directory listings require user confirmation.
   */
  async getDefaultPermission() {
    const dirPath = path.resolve(this.params.path);
    const workspaceContext = this.config.getWorkspaceContext();
    const userSkillsDirs = this.config.storage.getUserSkillsDirs();
    const userExtensionsDir = Storage.getUserExtensionsDir();
    if (workspaceContext.isPathWithinWorkspace(dirPath) || isSubpaths(userSkillsDirs, dirPath) || isSubpath(userExtensionsDir, dirPath) || isSubpath(getMemoryBaseDir(), dirPath)) {
      return "allow";
    }
    return "ask";
  }
  // Helper for consistent error formatting
  errorResult(llmContent, returnDisplay, type) {
    return {
      llmContent,
      // Keep returnDisplay simpler in core logic
      returnDisplay: `Error: ${returnDisplay}`,
      error: {
        message: llmContent,
        type
      }
    };
  }
  /**
   * Executes the LS operation with the given parameters
   * @returns Result of the LS operation
   */
  async execute(_signal) {
    try {
      const stats = await fs.stat(this.params.path);
      if (!stats) {
        return this.errorResult(
          `Error: Directory not found or inaccessible: ${this.params.path}`,
          `Directory not found or inaccessible.`,
          "file_not_found" /* FILE_NOT_FOUND */
        );
      }
      if (!stats.isDirectory()) {
        return this.errorResult(
          `Error: Path is not a directory: ${this.params.path}`,
          `Path is not a directory.`,
          "path_is_not_a_directory" /* PATH_IS_NOT_A_DIRECTORY */
        );
      }
      const files = await fs.readdir(this.params.path);
      if (files.length === 0) {
        return {
          llmContent: `Directory ${this.params.path} is empty.`,
          returnDisplay: `Directory is empty.`
        };
      }
      const relativePaths = files.map(
        (file) => path.relative(
          this.config.getTargetDir(),
          path.join(this.params.path, file)
        )
      );
      const fileDiscovery = this.config.getFileService();
      const { filteredPaths, gitIgnoredCount, qwenIgnoredCount } = fileDiscovery.filterFilesWithReport(relativePaths, {
        respectGitIgnore: this.params.file_filtering_options?.respect_git_ignore ?? this.config.getFileFilteringOptions().respectGitIgnore ?? DEFAULT_FILE_FILTERING_OPTIONS.respectGitIgnore,
        respectQwenIgnore: this.params.file_filtering_options?.respect_qwen_ignore ?? this.config.getFileFilteringOptions().respectQwenIgnore ?? DEFAULT_FILE_FILTERING_OPTIONS.respectQwenIgnore
      });
      const entries = [];
      for (const relativePath of filteredPaths) {
        const fullPath = path.resolve(this.config.getTargetDir(), relativePath);
        if (this.shouldIgnore(path.basename(fullPath), this.params.ignore)) {
          continue;
        }
        try {
          const stats2 = await fs.stat(fullPath);
          const isDir = stats2.isDirectory();
          entries.push({
            name: path.basename(fullPath),
            path: fullPath,
            isDirectory: isDir,
            size: isDir ? 0 : stats2.size,
            modifiedTime: stats2.mtime
          });
        } catch (error) {
          debugLogger.warn(`Error accessing ${fullPath}: ${error}`);
        }
      }
      entries.sort((a, b) => {
        if (a.isDirectory && !b.isDirectory) return -1;
        if (!a.isDirectory && b.isDirectory) return 1;
        return a.name.localeCompare(b.name);
      });
      const totalEntryCount = entries.length;
      const entryLimit = Math.min(
        MAX_ENTRY_COUNT,
        this.config.getTruncateToolOutputLines()
      );
      const truncated = totalEntryCount > entryLimit;
      const entriesToShow = truncated ? entries.slice(0, entryLimit) : entries;
      const directoryContent = entriesToShow.map((entry) => `${entry.isDirectory ? "[DIR] " : ""}${entry.name}`).join("\n");
      let resultMessage = `Listed ${totalEntryCount} item(s) in ${this.params.path}:
---
${directoryContent}`;
      if (truncated) {
        const omittedEntries = totalEntryCount - entryLimit;
        const entryTerm = omittedEntries === 1 ? "item" : "items";
        resultMessage += `
---
[${omittedEntries} ${entryTerm} truncated] ...`;
      }
      const ignoredMessages = [];
      if (gitIgnoredCount > 0) {
        ignoredMessages.push(`${gitIgnoredCount} git-ignored`);
      }
      if (qwenIgnoredCount > 0) {
        ignoredMessages.push(`${qwenIgnoredCount} qwen-ignored`);
      }
      if (ignoredMessages.length > 0) {
        resultMessage += `

(${ignoredMessages.join(", ")})`;
      }
      let displayMessage = `Listed ${totalEntryCount} item(s)`;
      if (ignoredMessages.length > 0) {
        displayMessage += ` (${ignoredMessages.join(", ")})`;
      }
      if (truncated) {
        displayMessage += " (truncated)";
      }
      return {
        llmContent: resultMessage,
        returnDisplay: displayMessage
      };
    } catch (error) {
      const errorMsg = `Error listing directory: ${error instanceof Error ? error.message : String(error)}`;
      return this.errorResult(
        errorMsg,
        "Failed to list directory.",
        "ls_execution_error" /* LS_EXECUTION_ERROR */
      );
    }
  }
};
var LSTool = class _LSTool extends BaseDeclarativeTool {
  constructor(config) {
    super(
      _LSTool.Name,
      ToolDisplayNames.LS,
      "Lists the names of files and subdirectories directly within a specified directory path. Can optionally ignore entries matching provided glob patterns.",
      "search" /* Search */,
      {
        properties: {
          path: {
            description: "The absolute path to the directory to list (must be absolute, not relative)",
            type: "string"
          },
          ignore: {
            description: "List of glob patterns to ignore",
            items: {
              type: "string"
            },
            type: "array"
          },
          file_filtering_options: {
            description: "Optional: Whether to respect ignore patterns from .gitignore, .qwenignore, and configured custom Qwen ignore files",
            type: "object",
            properties: {
              respect_git_ignore: {
                description: "Optional: Whether to respect .gitignore patterns when listing files. Only available in git repositories. Defaults to true.",
                type: "boolean"
              },
              respect_qwen_ignore: {
                description: "Optional: Whether to respect .qwenignore and configured custom Qwen ignore file patterns when listing files. Defaults to true.",
                type: "boolean"
              }
            }
          }
        },
        required: ["path"],
        type: "object"
      }
    );
    this.config = config;
  }
  static {
    __name(this, "LSTool");
  }
  static Name = ToolNames.LS;
  /**
   * Validates the parameters for the tool
   * @param params Parameters to validate
   * @returns An error message string if invalid, null otherwise
   */
  validateToolParamValues(params) {
    params.path = unescapePath(params.path.trim());
    if (!path.isAbsolute(params.path)) {
      return `Path must be absolute: ${params.path}`;
    }
    return null;
  }
  createInvocation(params) {
    return new LSToolInvocation(this.config, params);
  }
};
export {
  LSTool
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
