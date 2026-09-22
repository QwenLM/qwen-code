// Force strict mode and setup for ESM
"use strict";
import {
  createDebugLogger
} from "./chunk-ZYDMQCQP.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/utils/safeJsonParse.ts
init_esbuild_shims();

// node_modules/jsonrepair/lib/esm/index.js
init_esbuild_shims();

// node_modules/jsonrepair/lib/esm/regular/jsonrepair.js
init_esbuild_shims();

// node_modules/jsonrepair/lib/esm/utils/JSONRepairError.js
init_esbuild_shims();
var JSONRepairError = class extends Error {
  static {
    __name(this, "JSONRepairError");
  }
  constructor(message, position) {
    super(`${message} at position ${position}`);
    this.position = position;
  }
};

// node_modules/jsonrepair/lib/esm/utils/stringUtils.js
init_esbuild_shims();
var codeSpace = 32;
var codeNewline = 10;
var codeTab = 9;
var codeReturn = 13;
var codeNonBreakingSpace = 160;
var codeEnQuad = 8192;
var codeHairSpace = 8202;
var codeNarrowNoBreakSpace = 8239;
var codeMediumMathematicalSpace = 8287;
var codeIdeographicSpace = 12288;
function isHex(char) {
  return /^[0-9A-Fa-f]$/.test(char);
}
__name(isHex, "isHex");
function isDigit(char) {
  return char >= "0" && char <= "9";
}
__name(isDigit, "isDigit");
function isValidStringCharacter(char) {
  return char >= " ";
}
__name(isValidStringCharacter, "isValidStringCharacter");
function isDelimiter(char) {
  return ",:[]/{}()\n+".includes(char);
}
__name(isDelimiter, "isDelimiter");
function isFunctionNameCharStart(char) {
  return char >= "a" && char <= "z" || char >= "A" && char <= "Z" || char === "_" || char === "$";
}
__name(isFunctionNameCharStart, "isFunctionNameCharStart");
function isFunctionNameChar(char) {
  return char >= "a" && char <= "z" || char >= "A" && char <= "Z" || char === "_" || char === "$" || char >= "0" && char <= "9";
}
__name(isFunctionNameChar, "isFunctionNameChar");
var regexUrlStart = /^(http|https|ftp|mailto|file|data|irc):\/\/$/;
var regexUrlChar = /^[A-Za-z0-9-._~:/?#@!$&'()*+;=]$/;
function isUnquotedStringDelimiter(char) {
  return ",[]/{}\n+".includes(char);
}
__name(isUnquotedStringDelimiter, "isUnquotedStringDelimiter");
function isStartOfValue(char) {
  return isQuote(char) || regexStartOfValue.test(char);
}
__name(isStartOfValue, "isStartOfValue");
var regexStartOfValue = /^[[{\w-]$/;
function isControlCharacter(char) {
  return char === "\n" || char === "\r" || char === "	" || char === "\b" || char === "\f";
}
__name(isControlCharacter, "isControlCharacter");
function isWhitespace(text, index) {
  const code = text.charCodeAt(index);
  return code === codeSpace || code === codeNewline || code === codeTab || code === codeReturn;
}
__name(isWhitespace, "isWhitespace");
function isWhitespaceExceptNewline(text, index) {
  const code = text.charCodeAt(index);
  return code === codeSpace || code === codeTab || code === codeReturn;
}
__name(isWhitespaceExceptNewline, "isWhitespaceExceptNewline");
function isSpecialWhitespace(text, index) {
  const code = text.charCodeAt(index);
  return code === codeNonBreakingSpace || code >= codeEnQuad && code <= codeHairSpace || code === codeNarrowNoBreakSpace || code === codeMediumMathematicalSpace || code === codeIdeographicSpace;
}
__name(isSpecialWhitespace, "isSpecialWhitespace");
function isQuote(char) {
  return isDoubleQuoteLike(char) || isSingleQuoteLike(char);
}
__name(isQuote, "isQuote");
function isDoubleQuoteLike(char) {
  return char === '"' || char === "\u201C" || char === "\u201D";
}
__name(isDoubleQuoteLike, "isDoubleQuoteLike");
function isDoubleQuote(char) {
  return char === '"';
}
__name(isDoubleQuote, "isDoubleQuote");
function isSingleQuoteLike(char) {
  return char === "'" || char === "\u2018" || char === "\u2019" || char === "`" || char === "\xB4";
}
__name(isSingleQuoteLike, "isSingleQuoteLike");
function isSingleQuote(char) {
  return char === "'";
}
__name(isSingleQuote, "isSingleQuote");
function stripLastOccurrence(text, textToStrip) {
  let stripRemainingText = arguments.length > 2 && arguments[2] !== void 0 ? arguments[2] : false;
  const index = text.lastIndexOf(textToStrip);
  return index !== -1 ? text.substring(0, index) + (stripRemainingText ? "" : text.substring(index + 1)) : text;
}
__name(stripLastOccurrence, "stripLastOccurrence");
function insertBeforeLastWhitespace(text, textToInsert) {
  let index = text.length;
  if (!isWhitespace(text, index - 1)) {
    return text + textToInsert;
  }
  while (isWhitespace(text, index - 1)) {
    index--;
  }
  return text.substring(0, index) + textToInsert + text.substring(index);
}
__name(insertBeforeLastWhitespace, "insertBeforeLastWhitespace");
function removeAtIndex(text, start, count) {
  return text.substring(0, start) + text.substring(start + count);
}
__name(removeAtIndex, "removeAtIndex");
function endsWithCommaOrNewline(text) {
  return /[,\n][ \t\r]*$/.test(text);
}
__name(endsWithCommaOrNewline, "endsWithCommaOrNewline");

// node_modules/jsonrepair/lib/esm/regular/jsonrepair.js
var controlCharacters = {
  "\b": "\\b",
  "\f": "\\f",
  "\n": "\\n",
  "\r": "\\r",
  "	": "\\t"
};
var escapeCharacters = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "	"
  // note that \u is handled separately in parseString()
};
function jsonrepair(text) {
  let i = 0;
  let output = "";
  parseMarkdownCodeBlock(["```", "[```", "{```"]);
  const processed = parseValue();
  if (!processed) {
    throwUnexpectedEnd();
  }
  parseMarkdownCodeBlock(["```", "```]", "```}"]);
  const processedComma = parseCharacter(",");
  if (processedComma) {
    parseWhitespaceAndSkipComments();
  }
  if (isStartOfValue(text[i]) && endsWithCommaOrNewline(output)) {
    if (!processedComma) {
      output = insertBeforeLastWhitespace(output, ",");
    }
    parseNewlineDelimitedJSON();
  } else if (processedComma) {
    output = stripLastOccurrence(output, ",");
  }
  while (text[i] === "}" || text[i] === "]") {
    i++;
    parseWhitespaceAndSkipComments();
  }
  if (i >= text.length) {
    return output;
  }
  throwUnexpectedCharacter();
  function parseValue() {
    parseWhitespaceAndSkipComments();
    const processed2 = parseObject() || parseArray() || parseString() || parseNumber() || parseKeywords() || parseUnquotedString(false) || parseRegex();
    parseWhitespaceAndSkipComments();
    return processed2;
  }
  __name(parseValue, "parseValue");
  function parseWhitespaceAndSkipComments() {
    let skipNewline = arguments.length > 0 && arguments[0] !== void 0 ? arguments[0] : true;
    const start = i;
    let changed = parseWhitespace(skipNewline);
    do {
      changed = parseComment();
      if (changed) {
        changed = parseWhitespace(skipNewline);
      }
    } while (changed);
    return i > start;
  }
  __name(parseWhitespaceAndSkipComments, "parseWhitespaceAndSkipComments");
  function parseWhitespace(skipNewline) {
    const _isWhiteSpace = skipNewline ? isWhitespace : isWhitespaceExceptNewline;
    let whitespace = "";
    while (true) {
      if (_isWhiteSpace(text, i)) {
        whitespace += text[i];
        i++;
      } else if (isSpecialWhitespace(text, i)) {
        whitespace += " ";
        i++;
      } else {
        break;
      }
    }
    if (whitespace.length > 0) {
      output += whitespace;
      return true;
    }
    return false;
  }
  __name(parseWhitespace, "parseWhitespace");
  function parseComment() {
    if (text[i] === "/" && text[i + 1] === "*") {
      while (i < text.length && !atEndOfBlockComment(text, i)) {
        i++;
      }
      i += 2;
      return true;
    }
    if (text[i] === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") {
        i++;
      }
      return true;
    }
    return false;
  }
  __name(parseComment, "parseComment");
  function parseMarkdownCodeBlock(blocks) {
    if (skipMarkdownCodeBlock(blocks)) {
      if (isFunctionNameCharStart(text[i])) {
        while (i < text.length && isFunctionNameChar(text[i])) {
          i++;
        }
      }
      parseWhitespaceAndSkipComments();
      return true;
    }
    return false;
  }
  __name(parseMarkdownCodeBlock, "parseMarkdownCodeBlock");
  function skipMarkdownCodeBlock(blocks) {
    parseWhitespace(true);
    for (const block of blocks) {
      const end = i + block.length;
      if (text.slice(i, end) === block) {
        i = end;
        return true;
      }
    }
    return false;
  }
  __name(skipMarkdownCodeBlock, "skipMarkdownCodeBlock");
  function parseCharacter(char) {
    if (text[i] === char) {
      output += text[i];
      i++;
      return true;
    }
    return false;
  }
  __name(parseCharacter, "parseCharacter");
  function skipCharacter(char) {
    if (text[i] === char) {
      i++;
      return true;
    }
    return false;
  }
  __name(skipCharacter, "skipCharacter");
  function skipEscapeCharacter() {
    return skipCharacter("\\");
  }
  __name(skipEscapeCharacter, "skipEscapeCharacter");
  function skipEllipsis() {
    parseWhitespaceAndSkipComments();
    if (text[i] === "." && text[i + 1] === "." && text[i + 2] === ".") {
      i += 3;
      parseWhitespaceAndSkipComments();
      skipCharacter(",");
      return true;
    }
    return false;
  }
  __name(skipEllipsis, "skipEllipsis");
  function parseObject() {
    if (text[i] === "{") {
      output += "{";
      i++;
      parseWhitespaceAndSkipComments();
      if (skipCharacter(",")) {
        parseWhitespaceAndSkipComments();
      }
      let initial = true;
      while (i < text.length && text[i] !== "}") {
        let processedComma2;
        if (!initial) {
          processedComma2 = parseCharacter(",");
          if (!processedComma2) {
            output = insertBeforeLastWhitespace(output, ",");
          }
          parseWhitespaceAndSkipComments();
        } else {
          processedComma2 = true;
          initial = false;
        }
        skipEllipsis();
        const processedKey = parseString() || parseUnquotedString(true);
        if (!processedKey) {
          if (text[i] === "}" || text[i] === "{" || text[i] === "]" || text[i] === "[" || text[i] === void 0) {
            output = stripLastOccurrence(output, ",");
          } else {
            throwObjectKeyExpected();
          }
          break;
        }
        parseWhitespaceAndSkipComments();
        const processedColon = parseCharacter(":");
        const truncatedText = i >= text.length;
        if (!processedColon) {
          if (isStartOfValue(text[i]) || truncatedText) {
            output = insertBeforeLastWhitespace(output, ":");
          } else {
            throwColonExpected();
          }
        }
        const processedValue = parseValue();
        if (!processedValue) {
          if (processedColon || truncatedText) {
            output += "null";
          } else {
            throwColonExpected();
          }
        }
      }
      if (text[i] === "}") {
        output += "}";
        i++;
      } else {
        output = insertBeforeLastWhitespace(output, "}");
      }
      return true;
    }
    return false;
  }
  __name(parseObject, "parseObject");
  function parseArray() {
    if (text[i] === "[") {
      output += "[";
      i++;
      parseWhitespaceAndSkipComments();
      if (skipCharacter(",")) {
        parseWhitespaceAndSkipComments();
      }
      let initial = true;
      while (i < text.length && text[i] !== "]") {
        if (!initial) {
          const processedComma2 = parseCharacter(",");
          if (!processedComma2) {
            output = insertBeforeLastWhitespace(output, ",");
          }
        } else {
          initial = false;
        }
        skipEllipsis();
        const processedValue = parseValue();
        if (!processedValue) {
          output = stripLastOccurrence(output, ",");
          break;
        }
      }
      if (text[i] === "]") {
        output += "]";
        i++;
      } else {
        output = insertBeforeLastWhitespace(output, "]");
      }
      return true;
    }
    return false;
  }
  __name(parseArray, "parseArray");
  function parseNewlineDelimitedJSON() {
    let initial = true;
    let processedValue = true;
    while (processedValue) {
      if (!initial) {
        const processedComma2 = parseCharacter(",");
        if (!processedComma2) {
          output = insertBeforeLastWhitespace(output, ",");
        }
      } else {
        initial = false;
      }
      processedValue = parseValue();
    }
    if (!processedValue) {
      output = stripLastOccurrence(output, ",");
    }
    output = `[
${output}
]`;
  }
  __name(parseNewlineDelimitedJSON, "parseNewlineDelimitedJSON");
  function parseString() {
    let stopAtDelimiter = arguments.length > 0 && arguments[0] !== void 0 ? arguments[0] : false;
    let stopAtIndex = arguments.length > 1 && arguments[1] !== void 0 ? arguments[1] : -1;
    let skipEscapeChars = text[i] === "\\";
    if (skipEscapeChars) {
      i++;
      skipEscapeChars = true;
    }
    if (isQuote(text[i])) {
      const isEndQuote = isDoubleQuote(text[i]) ? isDoubleQuote : isSingleQuote(text[i]) ? isSingleQuote : isSingleQuoteLike(text[i]) ? isSingleQuoteLike : isDoubleQuoteLike;
      const iBefore = i;
      const oBefore = output.length;
      let str = '"';
      i++;
      while (true) {
        if (i >= text.length) {
          const iPrev = prevNonWhitespaceIndex(i - 1);
          if (!stopAtDelimiter && isDelimiter(text.charAt(iPrev))) {
            i = iBefore;
            output = output.substring(0, oBefore);
            return parseString(true);
          }
          str = insertBeforeLastWhitespace(str, '"');
          output += str;
          return true;
        }
        if (i === stopAtIndex) {
          str = insertBeforeLastWhitespace(str, '"');
          output += str;
          return true;
        }
        if (isEndQuote(text[i])) {
          const iQuote = i;
          const oQuote = str.length;
          str += '"';
          i++;
          output += str;
          parseWhitespaceAndSkipComments(false);
          if (stopAtDelimiter || i >= text.length || isDelimiter(text[i]) || isQuote(text[i]) || isDigit(text[i])) {
            parseConcatenatedString();
            return true;
          }
          const iPrevChar = prevNonWhitespaceIndex(iQuote - 1);
          const prevChar = text.charAt(iPrevChar);
          if (prevChar === ",") {
            i = iBefore;
            output = output.substring(0, oBefore);
            return parseString(false, iPrevChar);
          }
          if (isDelimiter(prevChar)) {
            i = iBefore;
            output = output.substring(0, oBefore);
            return parseString(true);
          }
          output = output.substring(0, oBefore);
          i = iQuote + 1;
          str = `${str.substring(0, oQuote)}\\${str.substring(oQuote)}`;
        } else if (stopAtDelimiter && isUnquotedStringDelimiter(text[i])) {
          if (text[i - 1] === ":" && regexUrlStart.test(text.substring(iBefore + 1, i + 2))) {
            while (i < text.length && regexUrlChar.test(text[i])) {
              str += text[i];
              i++;
            }
          }
          str = insertBeforeLastWhitespace(str, '"');
          output += str;
          parseConcatenatedString();
          return true;
        } else if (text[i] === "\\") {
          const char = text.charAt(i + 1);
          const escapeChar = escapeCharacters[char];
          if (escapeChar !== void 0) {
            str += text.slice(i, i + 2);
            i += 2;
          } else if (char === "u") {
            let j = 2;
            while (j < 6 && isHex(text[i + j])) {
              j++;
            }
            if (j === 6) {
              str += text.slice(i, i + 6);
              i += 6;
            } else if (i + j >= text.length) {
              i = text.length;
            } else {
              throwInvalidUnicodeCharacter();
            }
          } else {
            str += char;
            i += 2;
          }
        } else {
          const char = text.charAt(i);
          if (char === '"' && text[i - 1] !== "\\") {
            str += `\\${char}`;
            i++;
          } else if (isControlCharacter(char)) {
            str += controlCharacters[char];
            i++;
          } else {
            if (!isValidStringCharacter(char)) {
              throwInvalidCharacter(char);
            }
            str += char;
            i++;
          }
        }
        if (skipEscapeChars) {
          skipEscapeCharacter();
        }
      }
    }
    return false;
  }
  __name(parseString, "parseString");
  function parseConcatenatedString() {
    let processed2 = false;
    parseWhitespaceAndSkipComments();
    while (text[i] === "+") {
      processed2 = true;
      i++;
      parseWhitespaceAndSkipComments();
      output = stripLastOccurrence(output, '"', true);
      const start = output.length;
      const parsedStr = parseString();
      if (parsedStr) {
        output = removeAtIndex(output, start, 1);
      } else {
        output = insertBeforeLastWhitespace(output, '"');
      }
    }
    return processed2;
  }
  __name(parseConcatenatedString, "parseConcatenatedString");
  function parseNumber() {
    const start = i;
    if (text[i] === "-") {
      i++;
      if (atEndOfNumber()) {
        repairNumberEndingWithNumericSymbol(start);
        return true;
      }
      if (!isDigit(text[i])) {
        i = start;
        return false;
      }
    }
    while (isDigit(text[i])) {
      i++;
    }
    if (text[i] === ".") {
      i++;
      if (atEndOfNumber()) {
        repairNumberEndingWithNumericSymbol(start);
        return true;
      }
      if (!isDigit(text[i])) {
        i = start;
        return false;
      }
      while (isDigit(text[i])) {
        i++;
      }
    }
    if (text[i] === "e" || text[i] === "E") {
      i++;
      if (text[i] === "-" || text[i] === "+") {
        i++;
      }
      if (atEndOfNumber()) {
        repairNumberEndingWithNumericSymbol(start);
        return true;
      }
      if (!isDigit(text[i])) {
        i = start;
        return false;
      }
      while (isDigit(text[i])) {
        i++;
      }
    }
    if (!atEndOfNumber()) {
      i = start;
      return false;
    }
    if (i > start) {
      const num = text.slice(start, i);
      const hasInvalidLeadingZero = /^0\d/.test(num);
      output += hasInvalidLeadingZero ? `"${num}"` : num;
      return true;
    }
    return false;
  }
  __name(parseNumber, "parseNumber");
  function parseKeywords() {
    return parseKeyword("true", "true") || parseKeyword("false", "false") || parseKeyword("null", "null") || // repair Python keywords True, False, None
    parseKeyword("True", "true") || parseKeyword("False", "false") || parseKeyword("None", "null");
  }
  __name(parseKeywords, "parseKeywords");
  function parseKeyword(name, value) {
    if (text.slice(i, i + name.length) === name) {
      output += value;
      i += name.length;
      return true;
    }
    return false;
  }
  __name(parseKeyword, "parseKeyword");
  function parseUnquotedString(isKey) {
    const start = i;
    if (isFunctionNameCharStart(text[i])) {
      while (i < text.length && isFunctionNameChar(text[i])) {
        i++;
      }
      let j = i;
      while (isWhitespace(text, j)) {
        j++;
      }
      if (text[j] === "(") {
        i = j + 1;
        parseValue();
        if (text[i] === ")") {
          i++;
          if (text[i] === ";") {
            i++;
          }
        }
        return true;
      }
    }
    while (i < text.length && !isUnquotedStringDelimiter(text[i]) && !isQuote(text[i]) && (!isKey || text[i] !== ":")) {
      i++;
    }
    if (text[i - 1] === ":" && regexUrlStart.test(text.substring(start, i + 2))) {
      while (i < text.length && regexUrlChar.test(text[i])) {
        i++;
      }
    }
    if (i > start) {
      while (isWhitespace(text, i - 1) && i > 0) {
        i--;
      }
      const symbol = text.slice(start, i);
      output += symbol === "undefined" ? "null" : JSON.stringify(symbol);
      if (text[i] === '"') {
        i++;
      }
      return true;
    }
  }
  __name(parseUnquotedString, "parseUnquotedString");
  function parseRegex() {
    if (text[i] === "/") {
      const start = i;
      i++;
      while (i < text.length && (text[i] !== "/" || text[i - 1] === "\\")) {
        i++;
      }
      i++;
      output += `"${text.substring(start, i)}"`;
      return true;
    }
  }
  __name(parseRegex, "parseRegex");
  function prevNonWhitespaceIndex(start) {
    let prev = start;
    while (prev > 0 && isWhitespace(text, prev)) {
      prev--;
    }
    return prev;
  }
  __name(prevNonWhitespaceIndex, "prevNonWhitespaceIndex");
  function atEndOfNumber() {
    return i >= text.length || isDelimiter(text[i]) || isWhitespace(text, i);
  }
  __name(atEndOfNumber, "atEndOfNumber");
  function repairNumberEndingWithNumericSymbol(start) {
    output += `${text.slice(start, i)}0`;
  }
  __name(repairNumberEndingWithNumericSymbol, "repairNumberEndingWithNumericSymbol");
  function throwInvalidCharacter(char) {
    throw new JSONRepairError(`Invalid character ${JSON.stringify(char)}`, i);
  }
  __name(throwInvalidCharacter, "throwInvalidCharacter");
  function throwUnexpectedCharacter() {
    throw new JSONRepairError(`Unexpected character ${JSON.stringify(text[i])}`, i);
  }
  __name(throwUnexpectedCharacter, "throwUnexpectedCharacter");
  function throwUnexpectedEnd() {
    throw new JSONRepairError("Unexpected end of json string", text.length);
  }
  __name(throwUnexpectedEnd, "throwUnexpectedEnd");
  function throwObjectKeyExpected() {
    throw new JSONRepairError("Object key expected", i);
  }
  __name(throwObjectKeyExpected, "throwObjectKeyExpected");
  function throwColonExpected() {
    throw new JSONRepairError("Colon expected", i);
  }
  __name(throwColonExpected, "throwColonExpected");
  function throwInvalidUnicodeCharacter() {
    const chars = text.slice(i, i + 6);
    throw new JSONRepairError(`Invalid unicode character "${chars}"`, i);
  }
  __name(throwInvalidUnicodeCharacter, "throwInvalidUnicodeCharacter");
}
__name(jsonrepair, "jsonrepair");
function atEndOfBlockComment(text, i) {
  return text[i] === "*" && text[i + 1] === "/";
}
__name(atEndOfBlockComment, "atEndOfBlockComment");

// packages/core/src/utils/safeJsonParse.ts
var debugLogger = createDebugLogger("JSON_PARSE");
function safeJsonParse(jsonString, fallbackValue = {}) {
  if (!jsonString || typeof jsonString !== "string") {
    return fallbackValue;
  }
  try {
    return JSON.parse(jsonString);
  } catch (error) {
    try {
      const repairedJson = jsonrepair(jsonString);
      return JSON.parse(repairedJson);
    } catch (repairError) {
      debugLogger.error("Failed to parse JSON even with jsonrepair:", {
        originalError: error,
        repairError,
        jsonString
      });
      return fallbackValue;
    }
  }
}
__name(safeJsonParse, "safeJsonParse");

// packages/core/src/telemetry/gen-ai-usage.ts
init_esbuild_shims();
var usageProvenance = /* @__PURE__ */ new WeakMap();
function setGenAiUsageProvenance(usage, provenance) {
  usageProvenance.set(usage, provenance);
}
__name(setGenAiUsageProvenance, "setGenAiUsageProvenance");
function getGenAiUsageProvenance(usage) {
  return usage ? usageProvenance.get(usage) : void 0;
}
__name(getGenAiUsageProvenance, "getGenAiUsageProvenance");

export {
  safeJsonParse,
  setGenAiUsageProvenance,
  getGenAiUsageProvenance
};
/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
