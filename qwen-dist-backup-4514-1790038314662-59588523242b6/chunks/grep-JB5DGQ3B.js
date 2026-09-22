// Force strict mode and setup for ESM
"use strict";
import {
  recordGrepResultFileReads
} from "./chunk-LAE6RY3L.js";
import {
  globStream
} from "./chunk-QJNDUTOL.js";
import {
  isCommandAvailable
} from "./chunk-QPTE6BKL.js";
import {
  NO_EXEC_CONFIG,
  isGitRepository
} from "./chunk-AUFTA63J.js";
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
  createDebugLogger,
  formatDisplayPath,
  isSubpath,
  resolveAndValidatePath,
  resolvePath,
  unescapePath
} from "./chunk-ZYDMQCQP.js";
import {
  getErrorMessage,
  isNodeError
} from "./chunk-S34QJ6IR.js";
import "./chunk-TBWQLLFO.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/tools/grep.ts
init_esbuild_shims();
import fsPromises from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
var debugLogger = createDebugLogger("GREP");
var GrepToolInvocation = class extends BaseToolInvocation {
  constructor(config, params) {
    super(params);
    this.config = config;
    this.fileExclusions = config.getFileExclusions();
  }
  static {
    __name(this, "GrepToolInvocation");
  }
  fileExclusions;
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
    if (workspaceContext.isPathWithinWorkspace(resolvedPath) || isSubpath(getMemoryBaseDir(), resolvedPath)) {
      return "allow";
    }
    return "ask";
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
        searchLocationDescription = `in path "${this.params.path}"`;
      } else {
        const workspaceDirs = this.config.getWorkspaceContext().getDirectories();
        searchDirs.push(...workspaceDirs);
        searchLocationDescription = workspaceDirs.length > 1 ? `across ${workspaceDirs.length} workspace directories` : `in the workspace directory`;
      }
      let rawMatches = [];
      for (const searchDir of searchDirs) {
        const matches = await this.performGrepSearch({
          pattern: this.params.pattern,
          path: searchDir,
          glob: this.params.glob,
          signal
        });
        if (searchDirs.length > 1) {
          for (const match of matches) {
            if (!path.isAbsolute(match.filePath)) {
              match.filePath = path.resolve(searchDir, match.filePath);
            }
          }
        }
        rawMatches.push(...matches);
      }
      if (searchDirs.length > 1) {
        const seen = /* @__PURE__ */ new Set();
        rawMatches = rawMatches.filter((match) => {
          const key = `${match.filePath}:${match.lineNumber}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      }
      const filterDescription = this.params.glob ? ` (filter: "${this.params.glob}")` : "";
      if (rawMatches.length === 0) {
        const noMatchMsg = `No matches found for pattern "${this.params.pattern}" ${searchLocationDescription}${filterDescription}.`;
        return { llmContent: noMatchMsg, returnDisplay: `No matches found` };
      }
      const charLimit = this.config.getTruncateToolOutputThreshold();
      const lineLimit = Math.min(
        this.config.getTruncateToolOutputLines(),
        this.params.limit ?? Number.POSITIVE_INFINITY
      );
      let truncatedByLineLimit = false;
      let matchesToInclude = rawMatches;
      if (rawMatches.length > lineLimit) {
        matchesToInclude = rawMatches.slice(0, lineLimit);
        truncatedByLineLimit = true;
      }
      const totalMatches = rawMatches.length;
      const matchTerm = totalMatches === 1 ? "match" : "matches";
      const header = `Found ${totalMatches} ${matchTerm} for pattern "${this.params.pattern}" ${searchLocationDescription}${filterDescription}:
---
`;
      const matchesByFile = matchesToInclude.reduce(
        (acc, match) => {
          const fileKey = match.filePath;
          if (!acc[fileKey]) {
            acc[fileKey] = [];
          }
          acc[fileKey].push(match);
          acc[fileKey].sort((a, b) => a.lineNumber - b.lineNumber);
          return acc;
        },
        {}
      );
      let grepOutput = "";
      const visibleMatches = [];
      let truncatedByCharLimit = false;
      const appendChunk = /* @__PURE__ */ __name((chunk, match) => {
        if (Number.isFinite(charLimit) && grepOutput.length + chunk.length > charLimit) {
          grepOutput += chunk.slice(
            0,
            Math.max(charLimit - grepOutput.length, 0)
          );
          grepOutput += "...";
          if (match) visibleMatches.push(match);
          truncatedByCharLimit = true;
          return false;
        }
        grepOutput += chunk;
        if (match) visibleMatches.push(match);
        return true;
      }, "appendChunk");
      for (const filePath in matchesByFile) {
        if (!appendChunk(`File: ${filePath}
`)) break;
        let stopRendering = false;
        for (const match of matchesByFile[filePath]) {
          const trimmedLine = match.line.trim();
          if (!appendChunk(`L${match.lineNumber}: ${trimmedLine}
`, match)) {
            stopRendering = true;
            break;
          }
        }
        if (stopRendering || !appendChunk("---\n")) break;
      }
      const finalLines = grepOutput.split("\n").filter(
        (line) => line.trim() && !line.startsWith("File:") && !line.startsWith("---")
      );
      const includedLines = finalLines.length;
      let llmContent = header + grepOutput;
      if (truncatedByLineLimit || truncatedByCharLimit) {
        const omittedMatches = totalMatches - includedLines;
        llmContent += ` [${omittedMatches} ${omittedMatches === 1 ? "line" : "lines"} truncated] ...`;
      }
      let displayMessage = `Found ${totalMatches} ${matchTerm}`;
      if (truncatedByLineLimit || truncatedByCharLimit) {
        displayMessage += ` (truncated)`;
      }
      const resultFilePaths = Array.from(
        new Set(
          visibleMatches.map((match) => match.absoluteFilePath).filter((filePath) => filePath !== "")
        )
      );
      await recordGrepResultFileReads(this.config, resultFilePaths);
      return {
        llmContent: llmContent.trim(),
        returnDisplay: displayMessage,
        resultFilePaths
      };
    } catch (error) {
      debugLogger.error(`Error during GrepLogic execution: ${error}`);
      const errorMessage = getErrorMessage(error);
      return {
        llmContent: `Error during grep search operation: ${errorMessage}`,
        returnDisplay: `Error: ${errorMessage}`,
        error: {
          message: errorMessage,
          type: "grep_execution_error" /* GREP_EXECUTION_ERROR */
        }
      };
    }
  }
  /**
   * Parses the standard output of grep-like commands (git grep, system grep).
   * Primary formats are null-delimited:
   * - git grep -z -n: filePath\0lineNumber\0lineContent\n
   * - grep --null -n: filePath\0lineNumber:lineContent\n
   * Also accepts legacy colon-delimited output as a fallback.
   * Handles colons within file paths and line content correctly for null-delimited output.
   * @param {string} output The raw stdout string.
   * @param {string} basePath The absolute directory the search was run from, for relative paths.
   * @returns {GrepMatch[]} Array of match objects.
   */
  parseGrepOutput(output, basePath) {
    const results = [];
    if (!output) return results;
    const pushMatch = /* @__PURE__ */ __name((filePathRaw, lineNumberStr, lineContent) => {
      const lineNumber = parseInt(lineNumberStr, 10);
      if (!isNaN(lineNumber)) {
        const absoluteFilePath = path.resolve(basePath, filePathRaw);
        const relativeFilePath = path.relative(basePath, absoluteFilePath);
        results.push({
          filePath: relativeFilePath || path.basename(absoluteFilePath),
          absoluteFilePath,
          lineNumber,
          line: lineContent.replace(/\r$/, "")
        });
      }
    }, "pushMatch");
    if (output.includes("\0")) {
      let index = 0;
      while (index < output.length) {
        const pathEnd = output.indexOf("\0", index);
        if (pathEnd === -1) break;
        const nextNewline = output.indexOf("\n", index);
        if (nextNewline !== -1 && nextNewline < pathEnd) {
          debugLogger.debug(
            `Skipping unframed grep output line: ${output.substring(
              index,
              nextNewline
            )}`
          );
          index = nextNewline + 1;
          continue;
        }
        const filePathRaw = output.substring(index, pathEnd);
        const afterPath = pathEnd + 1;
        const nextNull = output.indexOf("\0", afterPath);
        let lineEnd = output.indexOf("\n", afterPath);
        if (lineEnd === -1) lineEnd = output.length;
        if (nextNull !== -1 && nextNull < lineEnd) {
          const lineNumberStr = output.substring(afterPath, nextNull);
          let contentEnd = output.indexOf("\n", nextNull + 1);
          if (contentEnd === -1) contentEnd = output.length;
          const lineContent = output.substring(nextNull + 1, contentEnd);
          pushMatch(filePathRaw, lineNumberStr, lineContent);
          index = contentEnd + 1;
          continue;
        }
        const rest = output.substring(afterPath, lineEnd);
        const separator = rest.indexOf(":");
        if (separator !== -1) {
          pushMatch(
            filePathRaw,
            rest.substring(0, separator),
            rest.substring(separator + 1)
          );
        } else {
          debugLogger.debug(
            `Skipping malformed grep --null record for ${filePathRaw}`
          );
        }
        index = lineEnd + 1;
      }
      return results;
    }
    const lines = output.split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      const normalizedLine = line.replace(/\r$/, "");
      const match = normalizedLine.match(/^(.+?):(\d+):(.*)$/);
      if (!match) continue;
      const [, filePathRaw, lineNumberStr, lineContent] = match;
      pushMatch(filePathRaw, lineNumberStr, lineContent);
    }
    return results;
  }
  /**
   * Gets a description of the grep operation
   * @returns A string describing the grep
   */
  getDescription() {
    const displayPath = formatDisplayPath(
      this.params.path || ".",
      this.config.getTargetDir()
    );
    let description = `'${this.params.pattern}' in ${displayPath}`;
    if (this.params.glob) {
      description += ` (filter: '${this.params.glob}')`;
    }
    return description;
  }
  /**
   * Performs the actual search using the prioritized strategies.
   * @param options Search options including pattern, absolute path, and glob filter.
   * @returns A promise resolving to an array of match objects.
   */
  async performGrepSearch(options) {
    const { pattern, path: absolutePath, glob } = options;
    let strategyUsed = "none";
    try {
      const isGit = isGitRepository(absolutePath);
      const gitAvailable = isGit && isCommandAvailable("git").available;
      if (gitAvailable) {
        strategyUsed = "git grep";
        const gitArgs = [
          // `git grep` refreshes the index, which is what runs a
          // repository-planted `core.fsmonitor` helper; only the `--untracked`
          // below keeps this particular argv from doing so.
          ...NO_EXEC_CONFIG,
          "grep",
          "--untracked",
          "-n",
          "-z",
          "-E",
          "--ignore-case",
          "-e",
          pattern
        ];
        if (glob) {
          gitArgs.push("--", glob);
        }
        try {
          const output = await new Promise((resolve, reject) => {
            const child = spawn("git", gitArgs, {
              cwd: absolutePath,
              windowsHide: true
            });
            const stdoutChunks = [];
            const stderrChunks = [];
            child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
            child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
            child.on(
              "error",
              (err) => reject(new Error(`Failed to start git grep: ${err.message}`))
            );
            child.on("close", (code) => {
              const stdoutData = Buffer.concat(stdoutChunks).toString("utf8");
              const stderrData = Buffer.concat(stderrChunks).toString("utf8");
              if (code === 0) resolve(stdoutData);
              else if (code === 1)
                resolve("");
              else
                reject(
                  new Error(`git grep exited with code ${code}: ${stderrData}`)
                );
            });
          });
          return this.parseGrepOutput(output, absolutePath);
        } catch (gitError) {
          debugLogger.debug(
            `GrepLogic: git grep failed: ${getErrorMessage(
              gitError
            )}. Falling back...`
          );
        }
      }
      const { available: grepAvailable } = isCommandAvailable("grep");
      if (grepAvailable) {
        strategyUsed = "system grep";
        const grepArgs = ["-r", "-n", "-H", "-E", "--null"];
        const globExcludes = this.fileExclusions.getGlobExcludes();
        const commonExcludes = globExcludes.map((pattern2) => {
          let dir = pattern2;
          if (dir.startsWith("**/")) {
            dir = dir.substring(3);
          }
          if (dir.endsWith("/**")) {
            dir = dir.slice(0, -3);
          } else if (dir.endsWith("/")) {
            dir = dir.slice(0, -1);
          }
          if (dir && !dir.includes("/") && !dir.includes("*")) {
            return dir;
          }
          return null;
        }).filter((dir) => !!dir);
        commonExcludes.forEach((dir) => grepArgs.push(`--exclude-dir=${dir}`));
        if (glob) {
          grepArgs.push(`--include=${glob}`);
        }
        grepArgs.push("-e", pattern);
        grepArgs.push(".");
        try {
          const output = await new Promise((resolve, reject) => {
            const child = spawn("grep", grepArgs, {
              cwd: absolutePath,
              windowsHide: true
            });
            const stdoutChunks = [];
            const stderrChunks = [];
            const onData = /* @__PURE__ */ __name((chunk) => stdoutChunks.push(chunk), "onData");
            const onStderr = /* @__PURE__ */ __name((chunk) => {
              const stderrStr = chunk.toString();
              if (!stderrStr.includes("Permission denied") && !/grep:.*: Is a directory/i.test(stderrStr)) {
                stderrChunks.push(chunk);
              }
            }, "onStderr");
            const onError = /* @__PURE__ */ __name((err) => {
              cleanup();
              reject(new Error(`Failed to start system grep: ${err.message}`));
            }, "onError");
            const onClose = /* @__PURE__ */ __name((code) => {
              const stdoutData = Buffer.concat(stdoutChunks).toString("utf8");
              const stderrData = Buffer.concat(stderrChunks).toString("utf8").trim();
              cleanup();
              if (code === 0) resolve(stdoutData);
              else if (code === 1)
                resolve("");
              else {
                if (stderrData)
                  reject(
                    new Error(
                      `System grep exited with code ${code}: ${stderrData}`
                    )
                  );
                else resolve("");
              }
            }, "onClose");
            const cleanup = /* @__PURE__ */ __name(() => {
              child.stdout.removeListener("data", onData);
              child.stderr.removeListener("data", onStderr);
              child.removeListener("error", onError);
              child.removeListener("close", onClose);
              if (child.connected) {
                child.disconnect();
              }
            }, "cleanup");
            child.stdout.on("data", onData);
            child.stderr.on("data", onStderr);
            child.on("error", onError);
            child.on("close", onClose);
          });
          return this.parseGrepOutput(output, absolutePath);
        } catch (grepError) {
          debugLogger.debug(
            `GrepLogic: System grep failed: ${getErrorMessage(
              grepError
            )}. Falling back...`
          );
        }
      }
      debugLogger.debug(
        "GrepLogic: Falling back to JavaScript grep implementation."
      );
      strategyUsed = "javascript fallback";
      const globPattern = glob ? glob : "**/*";
      const ignorePatterns = this.fileExclusions.getGlobExcludes();
      const filesIterator = globStream(globPattern, {
        cwd: absolutePath,
        dot: true,
        ignore: ignorePatterns,
        absolute: true,
        nodir: true,
        signal: options.signal
      });
      const regex = new RegExp(pattern, "i");
      const allMatches = [];
      for await (const filePath of filesIterator) {
        const fileAbsolutePath = filePath;
        try {
          const content = await fsPromises.readFile(fileAbsolutePath, "utf8");
          const lines = content.split(/\r?\n/);
          lines.forEach((line, index) => {
            if (regex.test(line)) {
              allMatches.push({
                filePath: path.relative(absolutePath, fileAbsolutePath) || path.basename(fileAbsolutePath),
                absoluteFilePath: fileAbsolutePath,
                lineNumber: index + 1,
                line
              });
            }
          });
        } catch (readError) {
          if (!isNodeError(readError) || readError.code !== "ENOENT") {
            debugLogger.debug(
              `GrepLogic: Could not read/process ${fileAbsolutePath}: ${getErrorMessage(
                readError
              )}`
            );
          }
        }
      }
      return allMatches;
    } catch (error) {
      debugLogger.error(
        `GrepLogic: Error in performGrepSearch (Strategy: ${strategyUsed}): ${getErrorMessage(
          error
        )}`
      );
      throw error;
    }
  }
};
var GrepTool = class _GrepTool extends BaseDeclarativeTool {
  constructor(config) {
    super(
      _GrepTool.Name,
      ToolDisplayNames.GREP,
      'A powerful search tool for finding patterns in files\n\n  Usage:\n  - ALWAYS use Grep for search tasks. NEVER invoke `grep` or `rg` as a Bash command. The Grep tool has been optimized for correct permissions and access.\n  - Supports full regex syntax (e.g., "log.*Error", "function\\s+\\w+")\n  - Filter files with glob parameter (e.g., "*.js", "**/*.tsx")\n  - Case-insensitive by default\n  - Use Agent tool for open-ended searches requiring multiple rounds\n',
      "search" /* Search */,
      {
        properties: {
          pattern: {
            type: "string",
            description: "The regular expression pattern to search for in file contents"
          },
          glob: {
            type: "string",
            description: 'Glob pattern to filter files (e.g. "*.js", "*.{ts,tsx}")'
          },
          path: {
            type: "string",
            description: "File or directory to search in. Defaults to current working directory."
          },
          limit: {
            type: "integer",
            minimum: 1,
            description: "Limit output to first N matching lines. Must be a positive integer. Optional - shows all matches if not specified."
          }
        },
        required: ["pattern"],
        type: "object"
      }
    );
    this.config = config;
  }
  static {
    __name(this, "GrepTool");
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
  GrepTool
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
