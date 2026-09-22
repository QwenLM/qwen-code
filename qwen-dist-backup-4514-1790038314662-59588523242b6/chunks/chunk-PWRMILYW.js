// Force strict mode and setup for ESM
"use strict";
import {
  recordGrepResultFileReads
} from "./chunk-LAE6RY3L.js";
import {
  runRipgrep
} from "./chunk-IWMYX5LB.js";
import {
  DEFAULT_FILE_FILTERING_OPTIONS,
  QwenIgnoreParser,
  getQwenIgnoreFileNames
} from "./chunk-IITTKFWM.js";
import {
  RipgrepRuntimeRecoveryEvent,
  logRipgrepRuntimeRecovery
} from "./chunk-KKGSJZWK.js";
import {
  BaseDeclarativeTool,
  BaseToolInvocation
} from "./chunk-VPGRGNNH.js";
import {
  SchemaValidator,
  ToolNames
} from "./chunk-ERIBG3BX.js";
import {
  createDebugLogger,
  formatDisplayPath,
  resolveAndValidatePath,
  resolvePath,
  unescapePath
} from "./chunk-ZYDMQCQP.js";
import {
  getErrorMessage
} from "./chunk-S34QJ6IR.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/tools/ripGrep.ts
init_esbuild_shims();
import fs from "node:fs";
import path from "node:path";
var debugLogger = createDebugLogger("RIPGREP");
var RIPGREP_FIELD_SEPARATOR = "";
var RIPGREP_INCOMPLETE_NOTICE = "Search did not complete: the results above may not include all matches.";
function isRipgrepJsonMatch(value) {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value;
  return candidate.type === "match" && (typeof candidate.data?.path?.text === "string" || typeof candidate.data?.path?.bytes === "string") && typeof candidate.data?.line_number === "number";
}
__name(isRipgrepJsonMatch, "isRipgrepJsonMatch");
function getRipgrepJsonPath(match) {
  if (match.data.path.text !== void 0) {
    return match.data.path.text;
  }
  if (match.data.path.bytes !== void 0) {
    return Buffer.from(match.data.path.bytes, "base64").toString("utf8");
  }
  return void 0;
}
__name(getRipgrepJsonPath, "getRipgrepJsonPath");
var qwenIgnoreCache = /* @__PURE__ */ new Map();
var RIPGREP_CACHE_MAX = 256;
function trimCache(m) {
  if (m.size <= RIPGREP_CACHE_MAX) return;
  const oldest = m.keys().next().value;
  if (oldest !== void 0) m.delete(oldest);
}
__name(trimCache, "trimCache");
function toAbsoluteResultPath(filePath, searchPaths, cache) {
  const cachedPath = cache?.get(filePath);
  if (cachedPath !== void 0) {
    return cachedPath;
  }
  let absolutePath;
  if (path.isAbsolute(filePath) || path.win32.isAbsolute(filePath)) {
    absolutePath = filePath;
  } else {
    absolutePath = path.resolve(searchPaths[0], filePath);
    for (const searchPath of searchPaths) {
      const candidate = path.resolve(searchPath, filePath);
      if (fs.existsSync(candidate)) {
        absolutePath = candidate;
        break;
      }
    }
  }
  cache?.set(filePath, absolutePath);
  return absolutePath;
}
__name(toAbsoluteResultPath, "toAbsoluteResultPath");
function isQwenIgnoreFileName(ignoreFileName) {
  return ignoreFileName === ".qwenignore";
}
__name(isQwenIgnoreFileName, "isQwenIgnoreFileName");
function _resetRipGrepCachesForTest() {
  qwenIgnoreCache.clear();
}
__name(_resetRipGrepCachesForTest, "_resetRipGrepCachesForTest");
var GrepToolInvocation = class extends BaseToolInvocation {
  constructor(config, params) {
    super(params);
    this.config = config;
  }
  static {
    __name(this, "GrepToolInvocation");
  }
  /**
   * Returns 'ask' for paths outside the workspace, so that external grep
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
    if (workspaceContext.isPathWithinWorkspace(resolvedPath)) {
      return "allow";
    }
    return "ask";
  }
  async execute(signal) {
    try {
      const searchPaths = [];
      let searchDirDisplay;
      if (this.params.path) {
        const searchDirAbs = resolveAndValidatePath(
          this.config,
          this.params.path,
          { allowFiles: true, allowExternalPaths: true }
        );
        searchPaths.push(searchDirAbs);
        searchDirDisplay = this.params.path;
      } else {
        const workspaceDirs = this.config.getWorkspaceContext().getDirectories();
        searchPaths.push(...workspaceDirs);
        searchDirDisplay = ".";
      }
      const searchResult = await this.performRipgrepSearch({
        pattern: this.params.pattern,
        paths: searchPaths,
        glob: this.params.glob,
        signal
      });
      const rawOutput = searchResult.stdout;
      const searchLocationDescription = this.params.path ? `in path "${searchDirDisplay}"` : searchPaths.length > 1 ? `across ${searchPaths.length} workspace directories` : `in the workspace directory`;
      const filterDescription = this.params.glob ? ` (filter: "${this.params.glob}")` : "";
      if (!rawOutput.trim()) {
        if (searchResult.incomplete) {
          const incompleteMsg = this.buildIncompleteSearchMessage(
            searchLocationDescription,
            filterDescription,
            searchResult.error
          );
          return {
            llmContent: incompleteMsg,
            returnDisplay: "Error: Search incomplete"
          };
        }
        const noMatchMsg = `No matches found for pattern "${this.params.pattern}" ${searchLocationDescription}${filterDescription}.`;
        return { llmContent: noMatchMsg, returnDisplay: `No matches found` };
      }
      const resolvedPathCache = /* @__PURE__ */ new Map();
      let allLines = rawOutput.split("\n").filter((line) => line.trim()).flatMap((line) => {
        if (line.startsWith("{")) {
          if (!line.startsWith('{"type":"match"')) return [];
          try {
            const parsed = JSON.parse(line);
            if (!isRipgrepJsonMatch(parsed)) return [];
            const filePath2 = getRipgrepJsonPath(parsed);
            if (filePath2 === void 0) return [];
            const lineNumber2 = String(parsed.data.line_number);
            const content2 = parsed.data.lines?.text ?? "";
            return [
              {
                rawLine: `${filePath2}:${lineNumber2}:${content2.replace(/\r?\n$/, "")}`,
                filePath: filePath2,
                key: `${filePath2}:${lineNumber2}`
              }
            ];
          } catch {
            return [];
          }
        }
        const fields = line.split(RIPGREP_FIELD_SEPARATOR);
        if (fields.length === 1) {
          const firstColon = line.indexOf(":");
          const secondColon = firstColon === -1 ? -1 : line.indexOf(":", firstColon + 1);
          if (firstColon === -1 || secondColon === -1) return [];
          const filePath2 = line.substring(0, firstColon);
          const lineNumber2 = line.substring(firstColon + 1, secondColon);
          if (!/^[0-9]+$/.test(lineNumber2)) return [];
          return [
            {
              rawLine: line,
              filePath: filePath2,
              key: `${filePath2}:${lineNumber2}`
            }
          ];
        }
        if (fields.length !== 3) return [];
        const [filePath, lineNumber, content] = fields;
        return [
          {
            rawLine: `${filePath}:${lineNumber}:${content}`,
            filePath,
            key: `${filePath}:${lineNumber}`
          }
        ];
      });
      const filteringOptions = this.getFileFilteringOptions();
      if (filteringOptions.respectQwenIgnore) {
        allLines = this.filterQwenIgnoredMatches(
          allLines,
          searchPaths,
          resolvedPathCache,
          filteringOptions.customIgnoreFiles
        );
      }
      if (searchPaths.length > 1) {
        const seen = /* @__PURE__ */ new Set();
        allLines = allLines.filter((line) => {
          if (seen.has(line.key)) return false;
          seen.add(line.key);
          return true;
        });
      }
      const totalMatches = allLines.length;
      if (totalMatches === 0) {
        if (searchResult.incomplete) {
          const incompleteMsg = this.buildIncompleteSearchMessage(
            searchLocationDescription,
            filterDescription,
            searchResult.error
          );
          return {
            llmContent: incompleteMsg,
            returnDisplay: "Error: Search incomplete"
          };
        }
        const noMatchMsg = `No matches found for pattern "${this.params.pattern}" ${searchLocationDescription}${filterDescription}.`;
        return { llmContent: noMatchMsg, returnDisplay: `No matches found` };
      }
      const matchTerm = totalMatches === 1 ? "match" : "matches";
      const header = `Found ${totalMatches} ${matchTerm} for pattern "${this.params.pattern}" ${searchLocationDescription}${filterDescription}:
---
`;
      const charLimit = this.config.getTruncateToolOutputThreshold();
      const lineLimit = Math.min(
        this.config.getTruncateToolOutputLines(),
        this.params.limit ?? Number.POSITIVE_INFINITY
      );
      let truncatedByLineLimit = false;
      let linesToInclude = allLines;
      if (allLines.length > lineLimit) {
        linesToInclude = allLines.slice(0, lineLimit);
        truncatedByLineLimit = true;
      }
      let grepOutput = "";
      let truncatedByCharLimit = false;
      let includedLines = 0;
      const visibleLines = [];
      if (Number.isFinite(charLimit)) {
        const parts = [];
        let currentLength = 0;
        for (const line of linesToInclude) {
          const sep = includedLines > 0 ? 1 : 0;
          const projectedLength = currentLength + line.rawLine.length + sep;
          if (projectedLength <= charLimit) {
            parts.push(line.rawLine);
            visibleLines.push(line);
            includedLines++;
            currentLength = projectedLength;
          } else {
            const remaining = Math.max(charLimit - currentLength - sep, 10);
            const partialLine = line.rawLine.slice(0, remaining);
            parts.push(partialLine + "...");
            visibleLines.push(line);
            truncatedByCharLimit = true;
            break;
          }
        }
        grepOutput = parts.join("\n");
      } else {
        grepOutput = linesToInclude.map((line) => line.rawLine).join("\n");
        visibleLines.push(...linesToInclude);
        includedLines = linesToInclude.length;
      }
      let llmContent = header + grepOutput;
      if (truncatedByLineLimit || truncatedByCharLimit) {
        const omittedMatches = totalMatches - includedLines;
        llmContent += `
---
[${omittedMatches} ${omittedMatches === 1 ? "line" : "lines"} truncated] ...`;
      }
      if (searchResult.incomplete) {
        llmContent += `
---
[${RIPGREP_INCOMPLETE_NOTICE}]`;
      }
      let displayMessage = `Found ${totalMatches} ${matchTerm}`;
      const displayTags = [];
      if (truncatedByLineLimit || truncatedByCharLimit) {
        displayTags.push("truncated");
      }
      if (searchResult.incomplete) {
        displayTags.push("incomplete");
      }
      if (displayTags.length > 0) {
        displayMessage += ` (${displayTags.join(", ")})`;
      }
      const resultFilePaths = Array.from(
        new Set(
          visibleLines.map(
            (line) => toAbsoluteResultPath(line.filePath, searchPaths, resolvedPathCache)
          )
        )
      );
      await recordGrepResultFileReads(this.config, resultFilePaths);
      return {
        llmContent: llmContent.trim(),
        returnDisplay: displayMessage,
        resultFilePaths
      };
    } catch (error) {
      debugLogger.error("Error during ripgrep search operation:", error);
      const errorMessage = getErrorMessage(error);
      return {
        llmContent: `Error during grep search operation: ${errorMessage}`,
        returnDisplay: `Error: ${errorMessage}`
      };
    }
  }
  filterQwenIgnoredMatches(lines, searchPaths, resolvedPathCache, customIgnoreFiles) {
    const parsers = /* @__PURE__ */ new Map();
    return lines.filter((line) => {
      const absolutePath = toAbsoluteResultPath(
        line.filePath,
        searchPaths,
        resolvedPathCache
      );
      const ignoreRoot = this.getIgnoreRootForSearchPath(absolutePath);
      if (ignoreRoot === void 0) {
        return true;
      }
      let parser = parsers.get(ignoreRoot);
      if (parser === void 0) {
        parser = new QwenIgnoreParser(ignoreRoot, customIgnoreFiles);
        parsers.set(ignoreRoot, parser);
      }
      return !parser.isIgnored(absolutePath);
    });
  }
  async performRipgrepSearch(options) {
    const { pattern, paths, glob } = options;
    const rgArgs = [
      "--json",
      "--no-messages",
      "--path-separator",
      "/",
      "--ignore-case",
      "--regexp",
      pattern
    ];
    const filteringOptions = this.getFileFilteringOptions();
    if (!filteringOptions.respectGitIgnore) {
      rgArgs.push("--no-ignore-vcs");
    }
    if (filteringOptions.respectQwenIgnore) {
      const seenIgnoreFiles = /* @__PURE__ */ new Set();
      const nonQwenIgnorePaths = [];
      const qwenIgnorePathsForRipgrep = [];
      const ignoreFileNames = getQwenIgnoreFileNames(
        filteringOptions.customIgnoreFiles
      );
      for (const searchPath of paths) {
        const ignoreRoot = this.getIgnoreRootForSearchPath(searchPath);
        if (ignoreRoot === void 0) {
          continue;
        }
        const cacheKey = [ignoreRoot, ...ignoreFileNames].join("\0");
        let qwenIgnoreFiles = qwenIgnoreCache.get(cacheKey);
        if (qwenIgnoreFiles === void 0) {
          qwenIgnoreFiles = ignoreFileNames.map((ignoreFileName) => ({
            ignoreFileName,
            ignoreFilePath: path.join(ignoreRoot, ignoreFileName)
          })).filter(({ ignoreFilePath }) => fs.existsSync(ignoreFilePath));
          qwenIgnoreCache.set(cacheKey, qwenIgnoreFiles);
          trimCache(qwenIgnoreCache);
        }
        for (const { ignoreFileName, ignoreFilePath } of qwenIgnoreFiles) {
          if (!seenIgnoreFiles.has(ignoreFilePath)) {
            if (isQwenIgnoreFileName(ignoreFileName)) {
              qwenIgnorePathsForRipgrep.push(ignoreFilePath);
            } else {
              nonQwenIgnorePaths.push(ignoreFilePath);
            }
            seenIgnoreFiles.add(ignoreFilePath);
          }
        }
      }
      for (const qwenIgnorePath of [
        ...nonQwenIgnorePaths,
        ...qwenIgnorePathsForRipgrep
      ]) {
        rgArgs.push("--ignore-file", qwenIgnorePath);
      }
    }
    if (glob) {
      rgArgs.push("--glob", glob);
    }
    rgArgs.push("--threads", "4");
    rgArgs.push(...paths);
    const result = await runRipgrep(
      rgArgs,
      options.signal,
      this.config.getUseBuiltinRipgrep()
    );
    this.logRipgrepRuntimeRecovery(result);
    if (result.error && !result.stdout.trim()) {
      throw result.error;
    }
    return result;
  }
  buildIncompleteSearchMessage(searchLocationDescription, filterDescription, error) {
    const errorDetail = error ? ` Error: ${getErrorMessage(error)}` : "";
    return `Search did not complete for pattern "${this.params.pattern}" ${searchLocationDescription}${filterDescription}. No valid matches were returned; do not treat this as no matches.${errorDetail}`;
  }
  logRipgrepRuntimeRecovery(result) {
    const { recovery } = result;
    if (recovery === void 0) {
      return;
    }
    if (recovery.failureKind === void 0) {
      return;
    }
    if (!recovery.retryTriggered && !result.incomplete && !result.error) {
      return;
    }
    const eventParams = {
      selection_mode: recovery.selectionMode,
      retry_triggered: recovery.retryTriggered,
      failure_kind: recovery.failureKind
    };
    if (recovery.retrySucceeded !== void 0) {
      eventParams.retry_succeeded = recovery.retrySucceeded;
    }
    logRipgrepRuntimeRecovery(
      this.config,
      new RipgrepRuntimeRecoveryEvent(eventParams)
    );
  }
  getIgnoreRootForSearchPath(searchPath) {
    const resolvedSearchPath = path.resolve(searchPath);
    for (const workspaceDir of this.config.getWorkspaceContext().getDirectories()) {
      const resolvedWorkspaceDir = path.resolve(workspaceDir);
      const relative = path.relative(resolvedWorkspaceDir, resolvedSearchPath);
      if (relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
        return resolvedWorkspaceDir;
      }
    }
    return void 0;
  }
  getFileFilteringOptions() {
    const options = this.config.getFileFilteringOptions?.();
    return {
      respectGitIgnore: options?.respectGitIgnore ?? DEFAULT_FILE_FILTERING_OPTIONS.respectGitIgnore,
      respectQwenIgnore: options?.respectQwenIgnore ?? DEFAULT_FILE_FILTERING_OPTIONS.respectQwenIgnore,
      customIgnoreFiles: options?.customIgnoreFiles ?? DEFAULT_FILE_FILTERING_OPTIONS.customIgnoreFiles
    };
  }
  /**
   * Gets a description of the grep operation
   * @returns A string describing the grep
   */
  getDescription() {
    let description = `'${this.params.pattern}'`;
    if (this.params.path) {
      const displayPath = formatDisplayPath(
        this.params.path,
        this.config.getTargetDir()
      );
      description += ` in ${displayPath}`;
    }
    if (this.params.glob) {
      description += ` (filter: '${this.params.glob}')`;
    }
    return description;
  }
};
var RipGrepTool = class _RipGrepTool extends BaseDeclarativeTool {
  constructor(config) {
    super(
      _RipGrepTool.Name,
      "Grep",
      'A powerful search tool built on ripgrep\n\n  Usage:\n  - ALWAYS use Grep for search tasks. NEVER invoke `grep` or `rg` as a Bash command. The Grep tool has been optimized for correct permissions and access.\n  - Supports full regex syntax (e.g., "log.*Error", "function\\s+\\w+")\n  - Filter files with glob parameter (e.g., "*.js", "**/*.tsx")\n  - Use Agent tool for open-ended searches requiring multiple rounds\n  - Pattern syntax: Uses ripgrep (not grep) - special regex characters need escaping (use `interface\\{\\}` to find `interface{}` in Go code)\n',
      "search" /* Search */,
      {
        properties: {
          pattern: {
            type: "string",
            description: "The regular expression pattern to search for in file contents"
          },
          glob: {
            type: "string",
            description: 'Glob pattern to filter files (e.g. "*.js", "*.{ts,tsx}") - maps to rg --glob'
          },
          path: {
            type: "string",
            description: "File or directory to search in (rg PATH). Defaults to current working directory."
          },
          limit: {
            type: "integer",
            minimum: 1,
            description: "Limit output to first N lines/entries. Must be a positive integer. Optional - shows all matches if not specified."
          }
        },
        required: ["pattern"],
        type: "object"
      }
    );
    this.config = config;
  }
  static {
    __name(this, "RipGrepTool");
  }
  static Name = ToolNames.GREP;
  get maxOutputChars() {
    return 2e4;
  }
  /**
   * Validates the parameters for the tool
   * @param params Parameters to validate
   * @returns An error message string if invalid, null otherwise
   */
  validateToolParamValues(params) {
    const errors = SchemaValidator.validate(
      this.schema.parametersJsonSchema,
      params
    );
    if (errors) {
      return errors;
    }
    if (params.limit !== void 0 && (!Number.isInteger(params.limit) || params.limit <= 0)) {
      return "limit must be a positive integer";
    }
    try {
      new RegExp(params.pattern);
    } catch (error) {
      return `Invalid regular expression pattern: ${params.pattern}. Error: ${getErrorMessage(error)}`;
    }
    if (params.path) {
      params.path = unescapePath(params.path.trim());
      try {
        resolveAndValidatePath(this.config, params.path, {
          allowFiles: true,
          allowExternalPaths: true
        });
      } catch (error) {
        return getErrorMessage(error);
      }
    }
    return null;
  }
  createInvocation(params) {
    return new GrepToolInvocation(this.config, params);
  }
};

export {
  _resetRipGrepCachesForTest,
  RipGrepTool
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
