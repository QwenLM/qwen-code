// Force strict mode and setup for ESM
"use strict";
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
  ReadFileTool,
  getLanguageFromFilePath,
  logFileOperation
} from "./chunk-KKGSJZWK.js";
import "./chunk-5ETULJLP.js";
import "./chunk-VGC4I5JJ.js";
import {
  isAnyAutoMemPath,
  isTeamAutoMemPath
} from "./chunk-RVT5L74D.js";
import "./chunk-HD7O6WLV.js";
import {
  fileExists,
  getSpecificMimeType
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
import {
  safeLiteralReplace
} from "./chunk-B3XJFEEH.js";
import "./chunk-74TONY4F.js";
import "./chunk-ZRQGTRHA.js";
import {
  BaseDeclarativeTool,
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

// packages/core/src/tools/edit.ts
init_esbuild_shims();
import * as fs from "node:fs";
import * as path from "node:path";

// packages/core/src/utils/editHelper.ts
init_esbuild_shims();
var UNICODE_EQUIVALENT_MAP = {
  // Hyphen variations → ASCII hyphen-minus.
  "\u2010": "-",
  "\u2011": "-",
  "\u2012": "-",
  "\u2013": "-",
  "\u2014": "-",
  "\u2015": "-",
  "\u2212": "-",
  // Curly single quotes → straight apostrophe.
  "\u2018": "'",
  "\u2019": "'",
  "\u201A": "'",
  "\u201B": "'",
  // Curly double quotes → straight double quote.
  "\u201C": '"',
  "\u201D": '"',
  "\u201E": '"',
  "\u201F": '"',
  // Whitespace variants → normal space.
  "\xA0": " ",
  "\u2002": " ",
  "\u2003": " ",
  "\u2004": " ",
  "\u2005": " ",
  "\u2006": " ",
  "\u2007": " ",
  "\u2008": " ",
  "\u2009": " ",
  "\u200A": " ",
  "\u202F": " ",
  "\u205F": " ",
  "\u3000": " "
};
function normalizeBasicCharacters(text) {
  if (text === "") {
    return text;
  }
  let normalized = "";
  for (const char of text) {
    normalized += UNICODE_EQUIVALENT_MAP[char] ?? char;
  }
  return normalized;
}
__name(normalizeBasicCharacters, "normalizeBasicCharacters");
var LINE_COMPARISON_PASSES = [
  (value) => value,
  (value) => value.trimEnd()
];
function normalizeLineForComparison(value) {
  return normalizeBasicCharacters(value).trimEnd();
}
__name(normalizeLineForComparison, "normalizeLineForComparison");
function seekSequenceWithTransform(lines, pattern, transform) {
  if (pattern.length === 0) {
    return 0;
  }
  if (pattern.length > lines.length) {
    return null;
  }
  outer: for (let i = 0; i <= lines.length - pattern.length; i++) {
    for (let p = 0; p < pattern.length; p++) {
      if (transform(lines[i + p]) !== transform(pattern[p])) {
        continue outer;
      }
    }
    return i;
  }
  return null;
}
__name(seekSequenceWithTransform, "seekSequenceWithTransform");
function buildLineIndex(text) {
  const lines = text.split("\n");
  const offsets = new Array(lines.length + 1);
  let cursor = 0;
  for (let i = 0; i < lines.length; i++) {
    offsets[i] = cursor;
    cursor += lines[i].length;
    if (i < lines.length - 1) {
      cursor += 1;
    }
  }
  offsets[lines.length] = text.length;
  return { lines, offsets };
}
__name(buildLineIndex, "buildLineIndex");
function sliceFromLines(text, offsets, lines, startLine, lineCount, includeTrailingNewline) {
  if (lineCount === 0) {
    return includeTrailingNewline ? "\n" : "";
  }
  const startIndex = offsets[startLine] ?? 0;
  const lastLineIndex = startLine + lineCount - 1;
  const lastLineStart = offsets[lastLineIndex] ?? 0;
  let endIndex = lastLineStart + (lines[lastLineIndex]?.length ?? 0);
  if (includeTrailingNewline) {
    const nextLineStart = offsets[startLine + lineCount];
    if (nextLineStart !== void 0) {
      endIndex = nextLineStart;
    } else if (text.endsWith("\n")) {
      endIndex = text.length;
    }
  }
  return text.slice(startIndex, endIndex);
}
__name(sliceFromLines, "sliceFromLines");
function findLineBasedMatch(haystack, needle) {
  const { lines, offsets } = buildLineIndex(haystack);
  const patternLines = needle.split("\n");
  const endsWithNewline = needle.endsWith("\n");
  if (patternLines.length === 0) {
    return null;
  }
  const attemptMatch = /* @__PURE__ */ __name((candidate) => {
    for (const pass of LINE_COMPARISON_PASSES) {
      const idx = seekSequenceWithTransform(lines, candidate, pass);
      if (idx !== null) {
        return idx;
      }
    }
    return seekSequenceWithTransform(
      lines,
      candidate,
      normalizeLineForComparison
    );
  }, "attemptMatch");
  let matchIndex = attemptMatch(patternLines);
  if (matchIndex !== null) {
    return {
      slice: sliceFromLines(
        haystack,
        offsets,
        lines,
        matchIndex,
        patternLines.length,
        endsWithNewline
      ),
      removedTrailingFinalEmptyLine: false
    };
  }
  if (patternLines.at(-1) === "") {
    const trimmedPattern = patternLines.slice(0, -1);
    if (trimmedPattern.length === 0) {
      return null;
    }
    matchIndex = attemptMatch(trimmedPattern);
    if (matchIndex !== null) {
      return {
        slice: sliceFromLines(
          haystack,
          offsets,
          lines,
          matchIndex,
          trimmedPattern.length,
          false
        ),
        removedTrailingFinalEmptyLine: true
      };
    }
  }
  return null;
}
__name(findLineBasedMatch, "findLineBasedMatch");
function findMatchedSlice(haystack, needle) {
  if (needle === "") {
    return null;
  }
  const literalIndex = haystack.indexOf(needle);
  if (literalIndex !== -1) {
    return {
      slice: haystack.slice(literalIndex, literalIndex + needle.length),
      removedTrailingFinalEmptyLine: false
    };
  }
  const normalizedHaystack = normalizeBasicCharacters(haystack);
  const normalizedNeedleChars = normalizeBasicCharacters(needle);
  const normalizedIndex = normalizedHaystack.indexOf(normalizedNeedleChars);
  if (normalizedIndex !== -1) {
    return {
      slice: haystack.slice(normalizedIndex, normalizedIndex + needle.length),
      removedTrailingFinalEmptyLine: false
    };
  }
  return findLineBasedMatch(haystack, needle);
}
__name(findMatchedSlice, "findMatchedSlice");
function removeTrailingNewline(text) {
  if (text.endsWith("\r\n")) {
    return text.slice(0, -2);
  }
  if (text.endsWith("\n") || text.endsWith("\r")) {
    return text.slice(0, -1);
  }
  return text;
}
__name(removeTrailingNewline, "removeTrailingNewline");
function adjustNewStringForTrailingLine(newString, removedTrailingLine) {
  return removedTrailingLine ? removeTrailingNewline(newString) : newString;
}
__name(adjustNewStringForTrailingLine, "adjustNewStringForTrailingLine");
function normalizeEditStrings(fileContent, oldString, newString) {
  if (fileContent === null || oldString === "") {
    return {
      oldString,
      newString
    };
  }
  const canonicalOriginal = findMatchedSlice(fileContent, oldString);
  if (canonicalOriginal !== null) {
    return {
      oldString: canonicalOriginal.slice,
      newString: adjustNewStringForTrailingLine(
        newString,
        canonicalOriginal.removedTrailingFinalEmptyLine
      )
    };
  }
  return {
    oldString,
    newString
  };
}
__name(normalizeEditStrings, "normalizeEditStrings");
function maybeAugmentOldStringForDeletion(fileContent, oldString, newString) {
  if (fileContent === null || oldString === "" || newString !== "" || oldString.endsWith("\n")) {
    return oldString;
  }
  const candidate = `${oldString}
`;
  return fileContent.includes(candidate) ? candidate : oldString;
}
__name(maybeAugmentOldStringForDeletion, "maybeAugmentOldStringForDeletion");
function countOccurrences(source, substr) {
  if (substr === "") {
    return 0;
  }
  let count = 0;
  let index = source.indexOf(substr);
  while (index !== -1) {
    count++;
    index = source.indexOf(substr, index + substr.length);
  }
  return count;
}
__name(countOccurrences, "countOccurrences");
var SNIPPET_CONTEXT_LINES = 4;
var SNIPPET_MAX_LINES = 1e3;
function extractEditSnippet(oldContent, newContent) {
  const newLines = newContent.split("\n");
  const totalLines = newLines.length;
  if (oldContent === null) {
    return {
      startLine: 1,
      endLine: totalLines,
      totalLines,
      content: newContent
    };
  }
  if (oldContent === newContent || !newContent) {
    return null;
  }
  const oldLines = oldContent.split("\n");
  let firstDiffLine = 0;
  const minLength = Math.min(oldLines.length, newLines.length);
  while (firstDiffLine < minLength) {
    if (oldLines[firstDiffLine] !== newLines[firstDiffLine]) {
      break;
    }
    firstDiffLine++;
  }
  let oldEndIndex = oldLines.length - 1;
  let newEndIndex = newLines.length - 1;
  while (oldEndIndex >= firstDiffLine && newEndIndex >= firstDiffLine) {
    if (oldLines[oldEndIndex] !== newLines[newEndIndex]) {
      break;
    }
    oldEndIndex--;
    newEndIndex--;
  }
  const changeStart = firstDiffLine + 1;
  const changeEnd = newEndIndex + 1;
  if (changeEnd - changeStart > SNIPPET_MAX_LINES) {
    return null;
  }
  const snippetStart = Math.max(1, changeStart - SNIPPET_CONTEXT_LINES);
  const snippetEnd = Math.min(totalLines, changeEnd + SNIPPET_CONTEXT_LINES);
  const snippetLines = newLines.slice(snippetStart - 1, snippetEnd);
  return {
    startLine: snippetStart,
    endLine: snippetEnd,
    totalLines,
    content: snippetLines.join("\n")
  };
}
__name(extractEditSnippet, "extractEditSnippet");

// packages/core/src/tools/edit.ts
var debugLogger = createDebugLogger("EDIT_PRIOR_READ");
function applyReplacement(currentContent, oldString, newString, isNewFile) {
  if (isNewFile) {
    return newString;
  }
  if (currentContent === null) {
    return oldString === "" ? newString : "";
  }
  if (oldString === "" && !isNewFile) {
    return currentContent;
  }
  return safeLiteralReplace(currentContent, oldString, newString);
}
__name(applyReplacement, "applyReplacement");
var EditToolInvocation = class {
  constructor(config, params) {
    this.config = config;
    this.params = params;
  }
  static {
    __name(this, "EditToolInvocation");
  }
  toolLocations() {
    return [{ path: this.params.file_path }];
  }
  /**
   * Calculates the potential outcome of an edit operation.
   * @param params Parameters for the edit operation
   * @returns An object describing the potential edit outcome
   * @throws File system errors if reading the file fails unexpectedly (e.g., permissions)
   */
  async calculateEdit(params) {
    const replaceAll = params.replace_all ?? false;
    let currentContent = null;
    let fileExists2 = await fileExists(params.file_path);
    let isNewFile = false;
    let finalNewString = params.new_string;
    let finalOldString = params.old_string;
    let occurrences = 0;
    let error = void 0;
    let useBOM = false;
    let detectedEncoding = "utf-8";
    let detectedLineEnding = "lf";
    if (!this.config.getFileReadCacheDisabled()) {
      const decision = await checkPriorRead(
        this.config.getFileReadCache(),
        params.file_path,
        "editing"
      );
      if (!decision.ok) {
        return {
          currentContent: null,
          newContent: "",
          occurrences: 0,
          error: {
            display: decision.displayMessage,
            raw: decision.rawMessage,
            type: decision.type
          },
          isNewFile: false,
          encoding: "utf-8",
          bom: false,
          lineEnding: "lf"
        };
      }
    }
    if (fileExists2) {
      try {
        const fileInfo = await this.config.getFileSystemService().readTextFile({ path: params.file_path });
        if (fileInfo._meta?.bom !== void 0) {
          useBOM = fileInfo._meta.bom;
        } else {
          useBOM = fileInfo.content.length > 0 && fileInfo.content.codePointAt(0) === 65279;
        }
        detectedEncoding = fileInfo._meta?.encoding || "utf-8";
        detectedLineEnding = detectLineEnding(fileInfo.content);
        currentContent = fileInfo.content.replace(/\r\n/g, "\n");
        fileExists2 = true;
      } catch (err) {
        if (!isNodeError(err) || err.code !== "ENOENT") {
          throw err;
        }
        fileExists2 = false;
      }
    }
    if (fileExists2 && !this.config.getFileReadCacheDisabled()) {
      const postDecision = await checkPriorRead(
        this.config.getFileReadCache(),
        params.file_path,
        "editing",
        { expectExisting: true }
      );
      if (!postDecision.ok) {
        debugLogger.warn("post-read TOCTOU rejection", {
          path: params.file_path,
          reason: postDecision.type
        });
        return {
          currentContent: null,
          newContent: "",
          occurrences: 0,
          error: {
            display: postDecision.displayMessage,
            raw: postDecision.rawMessage,
            type: postDecision.type
          },
          isNewFile: false,
          encoding: "utf-8",
          bom: false,
          lineEnding: "lf"
        };
      }
    }
    const normalizedStrings = normalizeEditStrings(
      currentContent,
      finalOldString,
      finalNewString
    );
    finalOldString = normalizedStrings.oldString;
    finalNewString = normalizedStrings.newString;
    if (finalOldString === "" && !fileExists2) {
      isNewFile = true;
    } else if (!fileExists2) {
      error = {
        display: `File not found. Cannot apply edit. Use an empty old_string to create a new file.`,
        raw: `File not found: ${params.file_path}`,
        type: "file_not_found" /* FILE_NOT_FOUND */
      };
    } else if (currentContent !== null) {
      finalOldString = maybeAugmentOldStringForDeletion(
        currentContent,
        finalOldString,
        finalNewString
      );
      occurrences = countOccurrences(currentContent, finalOldString);
      if (params.old_string === "") {
        error = {
          display: `Failed to edit. Attempted to create a file that already exists.`,
          raw: `File already exists, cannot create: ${params.file_path}`,
          type: "attempt_to_create_existing_file" /* ATTEMPT_TO_CREATE_EXISTING_FILE */
        };
      } else if (occurrences === 0) {
        error = {
          display: `Failed to edit, could not find the string to replace.`,
          raw: `Failed to edit, 0 occurrences found for old_string in ${params.file_path}. No edits made. The exact text in old_string was not found. Ensure you're not escaping content incorrectly and check whitespace, indentation, and context. Use ${ReadFileTool.Name} tool to verify.`,
          type: "edit_no_occurrence_found" /* EDIT_NO_OCCURRENCE_FOUND */
        };
      } else if (!replaceAll && occurrences > 1) {
        error = {
          display: `Failed to edit because the text matches multiple locations. Provide more context or set replace_all to true.`,
          raw: `Failed to edit. Found ${occurrences} occurrences for old_string in ${params.file_path} but replace_all was not enabled.`,
          type: "edit_expected_occurrence_mismatch" /* EDIT_EXPECTED_OCCURRENCE_MISMATCH */
        };
      } else if (finalOldString === finalNewString) {
        error = {
          display: `No changes to apply. The old_string and new_string are identical.`,
          raw: `No changes to apply. The old_string and new_string are identical in file: ${params.file_path}`,
          type: "edit_no_change" /* EDIT_NO_CHANGE */
        };
      }
    } else {
      error = {
        display: `Failed to read content of file.`,
        raw: `Failed to read content of existing file: ${params.file_path}`,
        type: "read_content_failure" /* READ_CONTENT_FAILURE */
      };
    }
    const newContent = !error ? applyReplacement(
      currentContent,
      finalOldString,
      finalNewString,
      isNewFile
    ) : currentContent ?? "";
    if (!error && fileExists2 && currentContent === newContent) {
      error = {
        display: "No changes to apply. The new content is identical to the current content.",
        raw: `No changes to apply. The new content is identical to the current content in file: ${params.file_path}`,
        type: "edit_no_change" /* EDIT_NO_CHANGE */
      };
    }
    if (!error) {
      const teamMemoryError = checkTeamMemorySecrets(
        params.file_path,
        newContent,
        this.config.getProjectRoot()
      );
      if (teamMemoryError) {
        const preExisting = currentContent !== null && checkTeamMemorySecrets(
          params.file_path,
          currentContent,
          this.config.getProjectRoot()
        ) !== null;
        const message = preExisting ? `${teamMemoryError} Note: the secret already exists in the current file content, so removing it from your edit alone is not enough \u2014 delete the committed secret from the file.` : teamMemoryError;
        error = {
          display: message,
          raw: message,
          type: "invalid_tool_params" /* INVALID_TOOL_PARAMS */
        };
      }
    }
    return {
      currentContent,
      newContent,
      occurrences,
      error,
      isNewFile,
      bom: useBOM,
      encoding: detectedEncoding,
      lineEnding: detectedLineEnding
    };
  }
  /**
   * Edit operations always need user confirmation, except for the private
   * managed auto-memory files (user/project) which are written autonomously.
   * Team memory is shared and committed to the repo, so it is NOT auto-allowed
   * like the private tiers — edits default to 'ask'. (In AUTO_EDIT/YOLO the user
   * has globally opted into auto-approval; team writes still surface in the git
   * diff for review before commit.)
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
   * Constructs the edit diff confirmation details.
   */
  async getConfirmationDetails(abortSignal) {
    let editData;
    try {
      editData = await this.calculateEdit(this.params);
    } catch (error) {
      if (abortSignal.aborted) {
        throw error;
      }
      const errorMsg = getErrorMessage(error);
      throw new Error(`Error preparing edit: ${errorMsg}`);
    }
    if (editData.error) {
      throw new StructuredToolError(editData.error.raw, editData.error.type);
    }
    const fileName = path.basename(this.params.file_path);
    const fileDiff = createPatchSmart(
      fileName,
      editData.currentContent ?? "",
      editData.newContent,
      "Current",
      "Proposed"
    );
    const confirmationDetails = {
      type: "edit",
      title: `Confirm Edit: ${shortenPath(makeRelative(this.params.file_path, this.config.getTargetDir()))}`,
      fileName,
      filePath: this.params.file_path,
      fileDiff,
      originalContent: editData.currentContent,
      newContent: editData.newContent,
      onConfirm: /* @__PURE__ */ __name(async (outcome) => {
        if (outcome === "proceed_always" /* ProceedAlways */) {
          this.config.setApprovalMode("auto-edit" /* AUTO_EDIT */);
        }
      }, "onConfirm")
    };
    return confirmationDetails;
  }
  getDescription() {
    const relativePath = makeRelative(
      this.params.file_path,
      this.config.getTargetDir()
    );
    if (this.params.old_string === "") {
      return `Create ${shortenPath(relativePath)}`;
    }
    if (this.params.old_string === this.params.new_string) {
      return `No file changes to ${shortenPath(relativePath)}`;
    }
    return shortenPath(relativePath);
  }
  /**
   * Executes the edit operation with the given parameters.
   * @param params Parameters for the edit operation
   * @returns Result of the edit operation
   */
  async execute(signal) {
    let editData;
    try {
      editData = await this.calculateEdit(this.params);
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      const errorMsg = getErrorMessage(error);
      return {
        llmContent: `Error preparing edit: ${errorMsg}`,
        returnDisplay: `Error preparing edit: ${errorMsg}`,
        error: {
          message: errorMsg,
          type: "edit_preparation_failure" /* EDIT_PREPARATION_FAILURE */
        }
      };
    }
    if (editData.error) {
      return {
        llmContent: editData.error.raw,
        returnDisplay: `Error: ${editData.error.display}`,
        error: {
          message: editData.error.raw,
          type: editData.error.type
        }
      };
    }
    try {
      try {
        await this.config.getFileHistoryService().trackEdit(this.params.file_path);
      } catch {
      }
      if (!this.config.getFileReadCacheDisabled()) {
        const writeDecision = await checkPriorRead(
          this.config.getFileReadCache(),
          this.params.file_path,
          "editing",
          // For an in-place edit (`!isNewFile`), the file existed at
          // read time and must still exist now — an ENOENT here
          // means the original target disappeared and we should
          // reject rather than fall through to a new-file write
          // that would silently re-create a file from stale bytes.
          // For genuine new-file creation, ENOENT is the expected
          // pre-write state (ok:true → writeTextFile creates).
          { expectExisting: !editData.isNewFile }
        );
        if (!writeDecision.ok) {
          debugLogger.warn("pre-write TOCTOU rejection", {
            path: this.params.file_path,
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
      this.ensureParentDirectoriesExist(this.params.file_path);
      if (editData.isNewFile) {
        const userEncoding = this.config.getDefaultFileEncoding();
        let useBOM = false;
        if (userEncoding === FileEncoding.UTF8_BOM) {
          useBOM = true;
        } else if (userEncoding === void 0) {
          useBOM = needsUtf8Bom(this.params.file_path);
        }
        await this.config.getFileSystemService().writeTextFile({
          path: this.params.file_path,
          content: editData.newContent,
          toolWriteOrigin: "edit",
          _meta: {
            bom: useBOM
          }
        });
      } else {
        await this.config.getFileSystemService().writeTextFile({
          path: this.params.file_path,
          content: editData.newContent,
          toolWriteOrigin: "edit",
          _meta: {
            bom: editData.bom,
            encoding: editData.encoding,
            lineEnding: editData.lineEnding
          }
        });
      }
      if (!this.params.modified_by_user) {
        CommitAttributionService.getInstance().recordEdit(
          this.params.file_path,
          editData.currentContent,
          editData.newContent
        );
      }
      try {
        const postWriteStats = fs.statSync(this.params.file_path);
        this.config.getFileReadCache().recordWrite(this.params.file_path, postWriteStats);
      } catch {
      }
      const fileName = path.basename(this.params.file_path);
      const originallyProposedContent = this.params.ai_proposed_content || editData.newContent;
      const diffStat = getDiffStat(
        fileName,
        editData.currentContent ?? "",
        originallyProposedContent,
        editData.newContent
      );
      const fileDiff = createPatchSmart(
        fileName,
        editData.currentContent ?? "",
        editData.newContent,
        "Current",
        "Proposed"
      );
      const displayResult = {
        fileDiff,
        fileName,
        filePath: this.params.file_path,
        originalContent: editData.currentContent,
        newContent: editData.newContent,
        diffStat
      };
      const mimetype = getSpecificMimeType(this.params.file_path);
      const programmingLanguage = getLanguageFromFilePath(
        this.params.file_path
      );
      const extension = path.extname(this.params.file_path);
      const operation = editData.isNewFile ? "create" /* CREATE */ : "update" /* UPDATE */;
      logFileOperation(
        this.config,
        new FileOperationEvent(
          EditTool.Name,
          operation,
          editData.newContent.split("\n").length,
          mimetype,
          extension,
          programmingLanguage
        )
      );
      const llmSuccessMessageParts = [
        editData.isNewFile ? `Created new file: ${this.params.file_path} with provided content.` : `The file: ${this.params.file_path} has been updated.`
      ];
      const snippetResult = extractEditSnippet(
        editData.currentContent,
        editData.newContent
      );
      if (snippetResult) {
        const snippetText = `Showing lines ${snippetResult.startLine}-${snippetResult.endLine} of ${snippetResult.totalLines} from the edited file:

---

${snippetResult.content}`;
        llmSuccessMessageParts.push(snippetText);
      }
      return {
        llmContent: llmSuccessMessageParts.join(" "),
        returnDisplay: displayResult
      };
    } catch (error) {
      const errorMsg = getErrorMessage(error);
      return {
        llmContent: `Error executing edit: ${errorMsg}`,
        returnDisplay: `Error writing file: ${errorMsg}`,
        error: {
          message: errorMsg,
          type: "file_write_failure" /* FILE_WRITE_FAILURE */
        }
      };
    }
  }
  /**
   * Creates parent directories if they don't exist
   */
  ensureParentDirectoriesExist(filePath) {
    const dirName = path.dirname(filePath);
    if (!fs.existsSync(dirName)) {
      fs.mkdirSync(dirName, { recursive: true });
    }
  }
};
var EditTool = class _EditTool extends BaseDeclarativeTool {
  constructor(config) {
    super(
      _EditTool.Name,
      ToolDisplayNames.EDIT,
      `Replaces text within a file. By default, replaces a single occurrence. Set \`replace_all\` to true when you intend to modify every instance of \`old_string\`. This tool requires providing significant context around the change to ensure precise targeting. Always use the ${ReadFileTool.Name} tool to examine the file's current content before attempting a text replacement.

      The user has the ability to modify the \`new_string\` content. If modified, this will be stated in the response.

Expectation for required parameters:
1. \`file_path\` MUST be an absolute path; otherwise an error will be thrown.
2. \`old_string\` MUST be the exact literal text to replace (including all whitespace, indentation, newlines, and surrounding code etc.).
3. \`new_string\` MUST be the exact literal text to replace \`old_string\` with (also including all whitespace, indentation, newlines, and surrounding code etc.). Ensure the resulting code is correct and idiomatic.
4. NEVER escape \`old_string\` or \`new_string\`, that would break the exact literal text requirement.
**Important:** If ANY of the above are not satisfied, the tool will fail. CRITICAL for \`old_string\`: Must uniquely identify the single instance to change. Include at least 3 lines of context BEFORE and AFTER the target text, matching whitespace and indentation precisely. If this string matches multiple locations, or does not match exactly, the tool will fail.
**Multiple replacements:** Set \`replace_all\` to true when you want to replace every occurrence that matches \`old_string\`.`,
      "edit" /* Edit */,
      {
        properties: {
          file_path: {
            description: "The absolute path to the file to modify. Must start with '/'.",
            type: "string"
          },
          old_string: {
            description: "The exact literal text to replace, preferably unescaped. For single replacements (default), include at least 3 lines of context BEFORE and AFTER the target text, matching whitespace and indentation precisely. If this string is not the exact literal text (i.e. you escaped it) or does not match exactly, the tool will fail.",
            type: "string"
          },
          new_string: {
            description: "The exact literal text to replace `old_string` with, preferably unescaped. Provide the EXACT text. Ensure the resulting code is correct and idiomatic.",
            type: "string"
          },
          replace_all: {
            type: "boolean",
            description: "Replace all occurrences of old_string (default false)."
          }
        },
        required: ["file_path", "old_string", "new_string"],
        type: "object"
      }
    );
    this.config = config;
  }
  static {
    __name(this, "EditTool");
  }
  static Name = ToolNames.EDIT;
  /**
   * Validates the parameters for the Edit tool
   * @param params Parameters to validate
   * @returns Error message string or null if valid
   */
  validateToolParamValues(params) {
    params.file_path = unescapePath(params.file_path.trim());
    if (!params.file_path) {
      return "The 'file_path' parameter must be non-empty.";
    }
    if (!path.isAbsolute(params.file_path)) {
      return `File path must be absolute: ${params.file_path}`;
    }
    const teamMemoryError = checkTeamMemorySecrets(
      params.file_path,
      params.new_string ?? "",
      this.config.getProjectRoot()
    );
    if (teamMemoryError) {
      return teamMemoryError;
    }
    return null;
  }
  createInvocation(params) {
    return new EditToolInvocation(this.config, params);
  }
  toAutoClassifierInput(params) {
    const oldStr = params.old_string ?? "";
    const newStr = params.new_string ?? "";
    return {
      file_path: params.file_path,
      old_string_preview: oldStr.slice(0, 300),
      new_string_preview: newStr.slice(0, 300),
      old_string_truncated: oldStr.length > 300,
      new_string_truncated: newStr.length > 300,
      lines_changed: (newStr.match(/\n/g)?.length ?? 0) - (oldStr.match(/\n/g)?.length ?? 0)
    };
  }
  getModifyContext(_) {
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
      getProposedContent: /* @__PURE__ */ __name(async (params) => {
        if (fs.existsSync(params.file_path)) {
          try {
            const { content: currentContent } = await this.config.getFileSystemService().readTextFile({ path: params.file_path });
            return applyReplacement(
              currentContent,
              params.old_string,
              params.new_string,
              params.old_string === "" && currentContent === ""
            );
          } catch (err) {
            if (!isNodeError(err) || err.code !== "ENOENT") throw err;
            return "";
          }
        } else {
          return "";
        }
      }, "getProposedContent"),
      createUpdatedParams: /* @__PURE__ */ __name((oldContent, modifiedProposedContent, originalParams) => ({
        ...originalParams,
        ai_proposed_content: oldContent,
        old_string: oldContent,
        new_string: modifiedProposedContent,
        modified_by_user: true
      }), "createUpdatedParams")
    };
  }
};
export {
  EditTool,
  applyReplacement
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
