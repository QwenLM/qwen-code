// Force strict mode and setup for ESM
"use strict";
import "./chunk-MRTRBONQ.js";
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
import {
  escape,
  globStream
} from "./chunk-QJNDUTOL.js";
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
import {
  DEFAULT_FILE_FILTERING_OPTIONS,
  isPathWithinRoot
} from "./chunk-IITTKFWM.js";
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
import "./chunk-KKGSJZWK.js";
import "./chunk-5ETULJLP.js";
import "./chunk-VGC4I5JJ.js";
import {
  getMemoryBaseDir
} from "./chunk-RVT5L74D.js";
import "./chunk-HD7O6WLV.js";
import "./chunk-25FMWESU.js";
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
  BaseToolInvocation
} from "./chunk-VPGRGNNH.js";
import {
  ToolDisplayNames,
  ToolNames
} from "./chunk-ERIBG3BX.js";
import {
  createDebugLogger,
  formatDisplayPath,
  isSubpath,
  resolveAndValidatePath,
  resolvePath,
  unescapePath
} from "./chunk-ZYDMQCQP.js";
import {
  getErrorMessage
} from "./chunk-S34QJ6IR.js";
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

// packages/core/src/tools/glob.ts
init_esbuild_shims();
import fs from "node:fs";
import path from "node:path";
var debugLogger = createDebugLogger("GLOB");
var MAX_FILE_COUNT = 100;
var MAX_GLOB_COLLECTED_ENTRIES = MAX_FILE_COUNT * 10;
var normalizePathForComparison = /* @__PURE__ */ __name((p) => process.platform === "win32" || process.platform === "darwin" ? p.toLowerCase() : p, "normalizePathForComparison");
function sortFileEntries(entries, nowTimestamp, recencyThresholdMs) {
  const sortedEntries = [...entries];
  sortedEntries.sort((a, b) => {
    const mtimeA = a.mtimeMs ?? 0;
    const mtimeB = b.mtimeMs ?? 0;
    const aIsRecent = nowTimestamp - mtimeA < recencyThresholdMs;
    const bIsRecent = nowTimestamp - mtimeB < recencyThresholdMs;
    if (aIsRecent && bIsRecent) {
      return mtimeB - mtimeA;
    } else if (aIsRecent) {
      return -1;
    } else if (bIsRecent) {
      return 1;
    } else {
      return a.fullpath().localeCompare(b.fullpath());
    }
  });
  return sortedEntries;
}
__name(sortFileEntries, "sortFileEntries");
var GlobToolInvocation = class extends BaseToolInvocation {
  constructor(config, params) {
    super(params);
    this.config = config;
    this.fileService = config.getFileService();
  }
  static {
    __name(this, "GlobToolInvocation");
  }
  fileService;
  getDescription() {
    let description = `'${this.params.pattern}'`;
    if (this.params.path) {
      const displayPath = formatDisplayPath(
        this.params.path,
        this.config.getTargetDir()
      );
      description += ` in ${displayPath}`;
    }
    return description;
  }
  /**
   * Returns 'ask' for paths outside the workspace, so that external glob
   * searches require user confirmation.
   */
  async getDefaultPermission() {
    if (!this.params.path) {
      return "allow";
    }
    const workspaceContext = this.config.getWorkspaceContext();
    const resolvedPath = resolvePath(
      this.config.getTargetDir(),
      this.params.path
    );
    if (workspaceContext.isPathWithinWorkspace(resolvedPath) || isSubpath(getMemoryBaseDir(), resolvedPath)) {
      return "allow";
    }
    return "ask";
  }
  /**
   * Runs glob search in a single directory and returns filtered entries.
   */
  async globInDirectory(searchDir, pattern, signal, entryLimit) {
    let effectivePattern = pattern;
    const fullPath = path.join(searchDir, effectivePattern);
    if (fs.existsSync(fullPath)) {
      effectivePattern = escape(effectivePattern);
    }
    const projectRoot = this.config.getTargetDir();
    const fileFilteringOptions = this.getFileFilteringOptions();
    const isTraversalIgnored = /* @__PURE__ */ __name((entry) => {
      try {
        const relativePath = path.relative(projectRoot, entry.fullpath());
        if (!relativePath || !isPathWithinRoot(entry.fullpath(), projectRoot)) {
          return false;
        }
        const ignorePath = entry.isDirectory() ? relativePath + "/" : relativePath;
        return this.fileService.shouldIgnoreFile(
          ignorePath,
          fileFilteringOptions
        );
      } catch (error) {
        debugLogger.debug(
          `traversal ignore check failed for ${entry.fullpath()}: ${getErrorMessage(error)}`
        );
        return false;
      }
    }, "isTraversalIgnored");
    const isAllowedByFileFilters = /* @__PURE__ */ __name((entry) => {
      const relativePath = path.relative(projectRoot, entry.fullpath());
      return this.fileService.filterFiles([relativePath], fileFilteringOptions).length > 0;
    }, "isAllowedByFileFilters");
    const stream = globStream(effectivePattern, {
      cwd: searchDir,
      withFileTypes: true,
      nodir: true,
      stat: true,
      nocase: true,
      dot: true,
      follow: false,
      signal,
      ignore: {
        ignored: isTraversalIgnored,
        childrenIgnored: isTraversalIgnored
      }
    });
    const entries = [];
    let hitLimit = false;
    for await (const entry of stream) {
      if (!isAllowedByFileFilters(entry)) {
        continue;
      }
      if (entries.length >= entryLimit) {
        hitLimit = true;
        break;
      }
      entries.push(entry);
    }
    if (hitLimit) {
      stream.destroy?.();
    }
    return { entries, hitLimit };
  }
  async execute(signal) {
    try {
      const searchDirs = [];
      let searchLocationDescription;
      if (this.params.path) {
        const searchDirAbs = resolveAndValidatePath(
          this.config,
          this.params.path,
          { allowExternalPaths: true }
        );
        searchDirs.push(searchDirAbs);
        searchLocationDescription = `within ${searchDirAbs}`;
      } else {
        const workspaceDirs = this.config.getWorkspaceContext().getDirectories();
        searchDirs.push(...workspaceDirs);
        searchLocationDescription = workspaceDirs.length > 1 ? `across ${workspaceDirs.length} workspace directories` : `in the workspace directory`;
      }
      const pattern = this.params.pattern;
      const allFilteredEntries = [];
      const seenPaths = /* @__PURE__ */ new Set();
      let hitCollectionLimit = false;
      for (const searchDir of searchDirs) {
        const remainingEntries = MAX_GLOB_COLLECTED_ENTRIES - allFilteredEntries.length;
        if (remainingEntries <= 0) {
          hitCollectionLimit = true;
          break;
        }
        const { entries, hitLimit } = await this.globInDirectory(
          searchDir,
          pattern,
          signal,
          remainingEntries
        );
        hitCollectionLimit ||= hitLimit;
        for (const entry of entries) {
          const normalized = normalizePathForComparison(entry.fullpath());
          if (!seenPaths.has(normalized)) {
            seenPaths.add(normalized);
            allFilteredEntries.push(entry);
          }
        }
      }
      const filteredEntries = allFilteredEntries;
      if (!filteredEntries || filteredEntries.length === 0) {
        return {
          llmContent: `No files found matching pattern "${this.params.pattern}" ${searchLocationDescription}`,
          returnDisplay: `No files found`
        };
      }
      const oneDayInMs = 24 * 60 * 60 * 1e3;
      const nowTimestamp = (/* @__PURE__ */ new Date()).getTime();
      const sortedEntries = sortFileEntries(
        filteredEntries,
        nowTimestamp,
        oneDayInMs
      );
      const totalFileCount = sortedEntries.length;
      const fileLimit = Math.min(
        MAX_FILE_COUNT,
        this.config.getTruncateToolOutputLines()
      );
      const truncated = hitCollectionLimit || totalFileCount > fileLimit;
      const entriesToShow = truncated ? sortedEntries.slice(0, fileLimit) : sortedEntries;
      const sortedAbsolutePaths = entriesToShow.map(
        (entry) => entry.fullpath()
      );
      const fileListDescription = sortedAbsolutePaths.join("\n");
      let resultMessage = hitCollectionLimit ? `Found at least ${totalFileCount} file(s) matching "${this.params.pattern}" ${searchLocationDescription}` : `Found ${totalFileCount} file(s) matching "${this.params.pattern}" ${searchLocationDescription}`;
      resultMessage += `, sorted by modification time (newest first):
---
${fileListDescription}`;
      if (hitCollectionLimit) {
        resultMessage += `
---
[Results truncated after scanning ${totalFileCount} matching files. Narrow the pattern or path.]`;
      } else if (truncated) {
        const omittedFiles = totalFileCount - fileLimit;
        const fileTerm = omittedFiles === 1 ? "file" : "files";
        resultMessage += `
---
[${omittedFiles} ${fileTerm} truncated] ...`;
      }
      return {
        llmContent: resultMessage,
        returnDisplay: `${hitCollectionLimit ? "Found at least" : "Found"} ${totalFileCount} matching file(s)${truncated ? " (truncated)" : ""}`,
        resultFilePaths: sortedAbsolutePaths
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      debugLogger.error(`GlobLogic execute Error: ${errorMessage}`, error);
      const rawError = `Error during glob search operation: ${errorMessage}`;
      return {
        llmContent: rawError,
        returnDisplay: `Error: ${errorMessage || "An unexpected error occurred."}`,
        error: {
          message: rawError,
          type: "glob_execution_error" /* GLOB_EXECUTION_ERROR */
        }
      };
    }
  }
  getFileFilteringOptions() {
    const options = this.config.getFileFilteringOptions?.();
    return {
      respectGitIgnore: options?.respectGitIgnore ?? DEFAULT_FILE_FILTERING_OPTIONS.respectGitIgnore,
      respectQwenIgnore: options?.respectQwenIgnore ?? DEFAULT_FILE_FILTERING_OPTIONS.respectQwenIgnore,
      customIgnoreFiles: options?.customIgnoreFiles ?? DEFAULT_FILE_FILTERING_OPTIONS.customIgnoreFiles
    };
  }
};
var GlobTool = class _GlobTool extends BaseDeclarativeTool {
  constructor(config) {
    super(
      _GlobTool.Name,
      ToolDisplayNames.GLOB,
      'Fast file pattern matching tool that works with any codebase size\n- Supports glob patterns like "**/*.js" or "src/**/*.ts"\n- Returns matching file paths sorted by modification time\n- Use this tool when you need to find files by name patterns\n- When you are doing an open ended search that may require multiple rounds of globbing and grepping, use the Agent tool instead\n- You have the capability to call multiple tools in a single response. It is always better to speculatively perform multiple searches as a batch that are potentially useful.',
      "search" /* Search */,
      {
        properties: {
          pattern: {
            description: "The glob pattern to match files against",
            type: "string"
          },
          path: {
            description: 'The directory to search in. If not specified, the current working directory will be used. IMPORTANT: Omit this field to use the default directory. DO NOT enter "undefined" or "null" - simply omit it for the default behavior. Must be a valid directory path if provided.',
            type: "string"
          }
        },
        required: ["pattern"],
        type: "object"
      }
    );
    this.config = config;
  }
  static {
    __name(this, "GlobTool");
  }
  static Name = ToolNames.GLOB;
  /**
   * Validates the parameters for the tool.
   */
  validateToolParamValues(params) {
    if (!params.pattern || typeof params.pattern !== "string" || params.pattern.trim() === "") {
      return "The 'pattern' parameter cannot be empty.";
    }
    if (params.path) {
      params.path = unescapePath(params.path.trim());
      try {
        resolveAndValidatePath(this.config, params.path, {
          allowExternalPaths: true
        });
      } catch (error) {
        return getErrorMessage(error);
      }
    }
    return null;
  }
  createInvocation(params) {
    return new GlobToolInvocation(this.config, params);
  }
};
export {
  GlobTool,
  sortFileEntries
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
