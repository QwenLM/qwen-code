// Force strict mode and setup for ESM
"use strict";
import {
  buildTrustPrecedenceRules,
  require_strip_json_comments,
  resolveTrustDecision,
  resolveTrustRule
} from "./chunk-NPQ5ZKRP.js";
import {
  arePathsEquivalent,
  getPathComparisonVariants
} from "./chunk-MR3PXB6E.js";
import {
  ideContextStore
} from "./chunk-MRTRBONQ.js";
import {
  require_proper_lockfile
} from "./chunk-MLXTMF7H.js";
import {
  atomicWriteFileSync
} from "./chunk-CA63HYHU.js";
import {
  Storage,
  createDebugLogger
} from "./chunk-ZYDMQCQP.js";
import {
  FatalConfigError,
  getErrorMessage
} from "./chunk-S34QJ6IR.js";
import {
  writeStderrLine
} from "./chunk-7FA2II6K.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name,
  __toESM
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/config/trustedFolders.ts
init_esbuild_shims();
var import_proper_lockfile = __toESM(require_proper_lockfile(), 1);
import * as fs3 from "node:fs";
import * as path from "node:path";
var import_strip_json_comments = __toESM(require_strip_json_comments(), 1);

// packages/cli/src/utils/jsonc-editor.ts
init_esbuild_shims();
import * as fs2 from "node:fs";
import { isDeepStrictEqual } from "node:util";

// node_modules/jsonc-parser/lib/esm/main.js
init_esbuild_shims();

// node_modules/jsonc-parser/lib/esm/impl/format.js
init_esbuild_shims();

// node_modules/jsonc-parser/lib/esm/impl/scanner.js
init_esbuild_shims();
function createScanner(text, ignoreTrivia = false) {
  const len = text.length;
  let pos = 0, value = "", tokenOffset = 0, token = 16, lineNumber = 0, lineStartOffset = 0, tokenLineStartOffset = 0, prevTokenLineStartOffset = 0, scanError = 0;
  function scanHexDigits(count, exact) {
    let digits = 0;
    let value2 = 0;
    while (digits < count || !exact) {
      let ch = text.charCodeAt(pos);
      if (ch >= 48 && ch <= 57) {
        value2 = value2 * 16 + ch - 48;
      } else if (ch >= 65 && ch <= 70) {
        value2 = value2 * 16 + ch - 65 + 10;
      } else if (ch >= 97 && ch <= 102) {
        value2 = value2 * 16 + ch - 97 + 10;
      } else {
        break;
      }
      pos++;
      digits++;
    }
    if (digits < count) {
      value2 = -1;
    }
    return value2;
  }
  __name(scanHexDigits, "scanHexDigits");
  function setPosition(newPosition) {
    pos = newPosition;
    value = "";
    tokenOffset = 0;
    token = 16;
    scanError = 0;
  }
  __name(setPosition, "setPosition");
  function scanNumber() {
    let start = pos;
    if (text.charCodeAt(pos) === 48) {
      pos++;
    } else {
      pos++;
      while (pos < text.length && isDigit(text.charCodeAt(pos))) {
        pos++;
      }
    }
    if (pos < text.length && text.charCodeAt(pos) === 46) {
      pos++;
      if (pos < text.length && isDigit(text.charCodeAt(pos))) {
        pos++;
        while (pos < text.length && isDigit(text.charCodeAt(pos))) {
          pos++;
        }
      } else {
        scanError = 3;
        return text.substring(start, pos);
      }
    }
    let end = pos;
    if (pos < text.length && (text.charCodeAt(pos) === 69 || text.charCodeAt(pos) === 101)) {
      pos++;
      if (pos < text.length && text.charCodeAt(pos) === 43 || text.charCodeAt(pos) === 45) {
        pos++;
      }
      if (pos < text.length && isDigit(text.charCodeAt(pos))) {
        pos++;
        while (pos < text.length && isDigit(text.charCodeAt(pos))) {
          pos++;
        }
        end = pos;
      } else {
        scanError = 3;
      }
    }
    return text.substring(start, end);
  }
  __name(scanNumber, "scanNumber");
  function scanString() {
    let result = "", start = pos;
    while (true) {
      if (pos >= len) {
        result += text.substring(start, pos);
        scanError = 2;
        break;
      }
      const ch = text.charCodeAt(pos);
      if (ch === 34) {
        result += text.substring(start, pos);
        pos++;
        break;
      }
      if (ch === 92) {
        result += text.substring(start, pos);
        pos++;
        if (pos >= len) {
          scanError = 2;
          break;
        }
        const ch2 = text.charCodeAt(pos++);
        switch (ch2) {
          case 34:
            result += '"';
            break;
          case 92:
            result += "\\";
            break;
          case 47:
            result += "/";
            break;
          case 98:
            result += "\b";
            break;
          case 102:
            result += "\f";
            break;
          case 110:
            result += "\n";
            break;
          case 114:
            result += "\r";
            break;
          case 116:
            result += "	";
            break;
          case 117:
            const ch3 = scanHexDigits(4, true);
            if (ch3 >= 0) {
              result += String.fromCharCode(ch3);
            } else {
              scanError = 4;
            }
            break;
          default:
            scanError = 5;
        }
        start = pos;
        continue;
      }
      if (ch >= 0 && ch <= 31) {
        if (isLineBreak(ch)) {
          result += text.substring(start, pos);
          scanError = 2;
          break;
        } else {
          scanError = 6;
        }
      }
      pos++;
    }
    return result;
  }
  __name(scanString, "scanString");
  function scanNext() {
    value = "";
    scanError = 0;
    tokenOffset = pos;
    lineStartOffset = lineNumber;
    prevTokenLineStartOffset = tokenLineStartOffset;
    if (pos >= len) {
      tokenOffset = len;
      return token = 17;
    }
    let code = text.charCodeAt(pos);
    if (isWhiteSpace(code)) {
      do {
        pos++;
        value += String.fromCharCode(code);
        code = text.charCodeAt(pos);
      } while (isWhiteSpace(code));
      return token = 15;
    }
    if (isLineBreak(code)) {
      pos++;
      value += String.fromCharCode(code);
      if (code === 13 && text.charCodeAt(pos) === 10) {
        pos++;
        value += "\n";
      }
      lineNumber++;
      tokenLineStartOffset = pos;
      return token = 14;
    }
    switch (code) {
      // tokens: []{}:,
      case 123:
        pos++;
        return token = 1;
      case 125:
        pos++;
        return token = 2;
      case 91:
        pos++;
        return token = 3;
      case 93:
        pos++;
        return token = 4;
      case 58:
        pos++;
        return token = 6;
      case 44:
        pos++;
        return token = 5;
      // strings
      case 34:
        pos++;
        value = scanString();
        return token = 10;
      // comments
      case 47:
        const start = pos - 1;
        if (text.charCodeAt(pos + 1) === 47) {
          pos += 2;
          while (pos < len) {
            if (isLineBreak(text.charCodeAt(pos))) {
              break;
            }
            pos++;
          }
          value = text.substring(start, pos);
          return token = 12;
        }
        if (text.charCodeAt(pos + 1) === 42) {
          pos += 2;
          const safeLength = len - 1;
          let commentClosed = false;
          while (pos < safeLength) {
            const ch = text.charCodeAt(pos);
            if (ch === 42 && text.charCodeAt(pos + 1) === 47) {
              pos += 2;
              commentClosed = true;
              break;
            }
            pos++;
            if (isLineBreak(ch)) {
              if (ch === 13 && text.charCodeAt(pos) === 10) {
                pos++;
              }
              lineNumber++;
              tokenLineStartOffset = pos;
            }
          }
          if (!commentClosed) {
            pos++;
            scanError = 1;
          }
          value = text.substring(start, pos);
          return token = 13;
        }
        value += String.fromCharCode(code);
        pos++;
        return token = 16;
      // numbers
      case 45:
        value += String.fromCharCode(code);
        pos++;
        if (pos === len || !isDigit(text.charCodeAt(pos))) {
          return token = 16;
        }
      // found a minus, followed by a number so
      // we fall through to proceed with scanning
      // numbers
      case 48:
      case 49:
      case 50:
      case 51:
      case 52:
      case 53:
      case 54:
      case 55:
      case 56:
      case 57:
        value += scanNumber();
        return token = 11;
      // literals and unknown symbols
      default:
        while (pos < len && isUnknownContentCharacter(code)) {
          pos++;
          code = text.charCodeAt(pos);
        }
        if (tokenOffset !== pos) {
          value = text.substring(tokenOffset, pos);
          switch (value) {
            case "true":
              return token = 8;
            case "false":
              return token = 9;
            case "null":
              return token = 7;
          }
          return token = 16;
        }
        value += String.fromCharCode(code);
        pos++;
        return token = 16;
    }
  }
  __name(scanNext, "scanNext");
  function isUnknownContentCharacter(code) {
    if (isWhiteSpace(code) || isLineBreak(code)) {
      return false;
    }
    switch (code) {
      case 125:
      case 93:
      case 123:
      case 91:
      case 34:
      case 58:
      case 44:
      case 47:
        return false;
    }
    return true;
  }
  __name(isUnknownContentCharacter, "isUnknownContentCharacter");
  function scanNextNonTrivia() {
    let result;
    do {
      result = scanNext();
    } while (result >= 12 && result <= 15);
    return result;
  }
  __name(scanNextNonTrivia, "scanNextNonTrivia");
  return {
    setPosition,
    getPosition: /* @__PURE__ */ __name(() => pos, "getPosition"),
    scan: ignoreTrivia ? scanNextNonTrivia : scanNext,
    getToken: /* @__PURE__ */ __name(() => token, "getToken"),
    getTokenValue: /* @__PURE__ */ __name(() => value, "getTokenValue"),
    getTokenOffset: /* @__PURE__ */ __name(() => tokenOffset, "getTokenOffset"),
    getTokenLength: /* @__PURE__ */ __name(() => pos - tokenOffset, "getTokenLength"),
    getTokenStartLine: /* @__PURE__ */ __name(() => lineStartOffset, "getTokenStartLine"),
    getTokenStartCharacter: /* @__PURE__ */ __name(() => tokenOffset - prevTokenLineStartOffset, "getTokenStartCharacter"),
    getTokenError: /* @__PURE__ */ __name(() => scanError, "getTokenError")
  };
}
__name(createScanner, "createScanner");
function isWhiteSpace(ch) {
  return ch === 32 || ch === 9;
}
__name(isWhiteSpace, "isWhiteSpace");
function isLineBreak(ch) {
  return ch === 10 || ch === 13;
}
__name(isLineBreak, "isLineBreak");
function isDigit(ch) {
  return ch >= 48 && ch <= 57;
}
__name(isDigit, "isDigit");
var CharacterCodes;
(function(CharacterCodes2) {
  CharacterCodes2[CharacterCodes2["lineFeed"] = 10] = "lineFeed";
  CharacterCodes2[CharacterCodes2["carriageReturn"] = 13] = "carriageReturn";
  CharacterCodes2[CharacterCodes2["space"] = 32] = "space";
  CharacterCodes2[CharacterCodes2["_0"] = 48] = "_0";
  CharacterCodes2[CharacterCodes2["_1"] = 49] = "_1";
  CharacterCodes2[CharacterCodes2["_2"] = 50] = "_2";
  CharacterCodes2[CharacterCodes2["_3"] = 51] = "_3";
  CharacterCodes2[CharacterCodes2["_4"] = 52] = "_4";
  CharacterCodes2[CharacterCodes2["_5"] = 53] = "_5";
  CharacterCodes2[CharacterCodes2["_6"] = 54] = "_6";
  CharacterCodes2[CharacterCodes2["_7"] = 55] = "_7";
  CharacterCodes2[CharacterCodes2["_8"] = 56] = "_8";
  CharacterCodes2[CharacterCodes2["_9"] = 57] = "_9";
  CharacterCodes2[CharacterCodes2["a"] = 97] = "a";
  CharacterCodes2[CharacterCodes2["b"] = 98] = "b";
  CharacterCodes2[CharacterCodes2["c"] = 99] = "c";
  CharacterCodes2[CharacterCodes2["d"] = 100] = "d";
  CharacterCodes2[CharacterCodes2["e"] = 101] = "e";
  CharacterCodes2[CharacterCodes2["f"] = 102] = "f";
  CharacterCodes2[CharacterCodes2["g"] = 103] = "g";
  CharacterCodes2[CharacterCodes2["h"] = 104] = "h";
  CharacterCodes2[CharacterCodes2["i"] = 105] = "i";
  CharacterCodes2[CharacterCodes2["j"] = 106] = "j";
  CharacterCodes2[CharacterCodes2["k"] = 107] = "k";
  CharacterCodes2[CharacterCodes2["l"] = 108] = "l";
  CharacterCodes2[CharacterCodes2["m"] = 109] = "m";
  CharacterCodes2[CharacterCodes2["n"] = 110] = "n";
  CharacterCodes2[CharacterCodes2["o"] = 111] = "o";
  CharacterCodes2[CharacterCodes2["p"] = 112] = "p";
  CharacterCodes2[CharacterCodes2["q"] = 113] = "q";
  CharacterCodes2[CharacterCodes2["r"] = 114] = "r";
  CharacterCodes2[CharacterCodes2["s"] = 115] = "s";
  CharacterCodes2[CharacterCodes2["t"] = 116] = "t";
  CharacterCodes2[CharacterCodes2["u"] = 117] = "u";
  CharacterCodes2[CharacterCodes2["v"] = 118] = "v";
  CharacterCodes2[CharacterCodes2["w"] = 119] = "w";
  CharacterCodes2[CharacterCodes2["x"] = 120] = "x";
  CharacterCodes2[CharacterCodes2["y"] = 121] = "y";
  CharacterCodes2[CharacterCodes2["z"] = 122] = "z";
  CharacterCodes2[CharacterCodes2["A"] = 65] = "A";
  CharacterCodes2[CharacterCodes2["B"] = 66] = "B";
  CharacterCodes2[CharacterCodes2["C"] = 67] = "C";
  CharacterCodes2[CharacterCodes2["D"] = 68] = "D";
  CharacterCodes2[CharacterCodes2["E"] = 69] = "E";
  CharacterCodes2[CharacterCodes2["F"] = 70] = "F";
  CharacterCodes2[CharacterCodes2["G"] = 71] = "G";
  CharacterCodes2[CharacterCodes2["H"] = 72] = "H";
  CharacterCodes2[CharacterCodes2["I"] = 73] = "I";
  CharacterCodes2[CharacterCodes2["J"] = 74] = "J";
  CharacterCodes2[CharacterCodes2["K"] = 75] = "K";
  CharacterCodes2[CharacterCodes2["L"] = 76] = "L";
  CharacterCodes2[CharacterCodes2["M"] = 77] = "M";
  CharacterCodes2[CharacterCodes2["N"] = 78] = "N";
  CharacterCodes2[CharacterCodes2["O"] = 79] = "O";
  CharacterCodes2[CharacterCodes2["P"] = 80] = "P";
  CharacterCodes2[CharacterCodes2["Q"] = 81] = "Q";
  CharacterCodes2[CharacterCodes2["R"] = 82] = "R";
  CharacterCodes2[CharacterCodes2["S"] = 83] = "S";
  CharacterCodes2[CharacterCodes2["T"] = 84] = "T";
  CharacterCodes2[CharacterCodes2["U"] = 85] = "U";
  CharacterCodes2[CharacterCodes2["V"] = 86] = "V";
  CharacterCodes2[CharacterCodes2["W"] = 87] = "W";
  CharacterCodes2[CharacterCodes2["X"] = 88] = "X";
  CharacterCodes2[CharacterCodes2["Y"] = 89] = "Y";
  CharacterCodes2[CharacterCodes2["Z"] = 90] = "Z";
  CharacterCodes2[CharacterCodes2["asterisk"] = 42] = "asterisk";
  CharacterCodes2[CharacterCodes2["backslash"] = 92] = "backslash";
  CharacterCodes2[CharacterCodes2["closeBrace"] = 125] = "closeBrace";
  CharacterCodes2[CharacterCodes2["closeBracket"] = 93] = "closeBracket";
  CharacterCodes2[CharacterCodes2["colon"] = 58] = "colon";
  CharacterCodes2[CharacterCodes2["comma"] = 44] = "comma";
  CharacterCodes2[CharacterCodes2["dot"] = 46] = "dot";
  CharacterCodes2[CharacterCodes2["doubleQuote"] = 34] = "doubleQuote";
  CharacterCodes2[CharacterCodes2["minus"] = 45] = "minus";
  CharacterCodes2[CharacterCodes2["openBrace"] = 123] = "openBrace";
  CharacterCodes2[CharacterCodes2["openBracket"] = 91] = "openBracket";
  CharacterCodes2[CharacterCodes2["plus"] = 43] = "plus";
  CharacterCodes2[CharacterCodes2["slash"] = 47] = "slash";
  CharacterCodes2[CharacterCodes2["formFeed"] = 12] = "formFeed";
  CharacterCodes2[CharacterCodes2["tab"] = 9] = "tab";
})(CharacterCodes || (CharacterCodes = {}));

// node_modules/jsonc-parser/lib/esm/impl/string-intern.js
init_esbuild_shims();
var cachedSpaces = new Array(20).fill(0).map((_, index) => {
  return " ".repeat(index);
});
var maxCachedValues = 200;
var cachedBreakLinesWithSpaces = {
  " ": {
    "\n": new Array(maxCachedValues).fill(0).map((_, index) => {
      return "\n" + " ".repeat(index);
    }),
    "\r": new Array(maxCachedValues).fill(0).map((_, index) => {
      return "\r" + " ".repeat(index);
    }),
    "\r\n": new Array(maxCachedValues).fill(0).map((_, index) => {
      return "\r\n" + " ".repeat(index);
    })
  },
  "	": {
    "\n": new Array(maxCachedValues).fill(0).map((_, index) => {
      return "\n" + "	".repeat(index);
    }),
    "\r": new Array(maxCachedValues).fill(0).map((_, index) => {
      return "\r" + "	".repeat(index);
    }),
    "\r\n": new Array(maxCachedValues).fill(0).map((_, index) => {
      return "\r\n" + "	".repeat(index);
    })
  }
};
var supportedEols = ["\n", "\r", "\r\n"];

// node_modules/jsonc-parser/lib/esm/impl/format.js
function format(documentText, range, options) {
  let initialIndentLevel;
  let formatText;
  let formatTextStart;
  let rangeStart;
  let rangeEnd;
  if (range) {
    rangeStart = range.offset;
    rangeEnd = rangeStart + range.length;
    formatTextStart = rangeStart;
    while (formatTextStart > 0 && !isEOL(documentText, formatTextStart - 1)) {
      formatTextStart--;
    }
    let endOffset = rangeEnd;
    while (endOffset < documentText.length && !isEOL(documentText, endOffset)) {
      endOffset++;
    }
    formatText = documentText.substring(formatTextStart, endOffset);
    initialIndentLevel = computeIndentLevel(formatText, options);
  } else {
    formatText = documentText;
    initialIndentLevel = 0;
    formatTextStart = 0;
    rangeStart = 0;
    rangeEnd = documentText.length;
  }
  const eol = getEOL(options, documentText);
  const eolFastPathSupported = supportedEols.includes(eol);
  let numberLineBreaks = 0;
  let indentLevel = 0;
  let indentValue;
  if (options.insertSpaces) {
    indentValue = cachedSpaces[options.tabSize || 4] ?? repeat(cachedSpaces[1], options.tabSize || 4);
  } else {
    indentValue = "	";
  }
  const indentType = indentValue === "	" ? "	" : " ";
  let scanner = createScanner(formatText, false);
  let hasError = false;
  function newLinesAndIndent() {
    if (numberLineBreaks > 1) {
      return repeat(eol, numberLineBreaks) + repeat(indentValue, initialIndentLevel + indentLevel);
    }
    const amountOfSpaces = indentValue.length * (initialIndentLevel + indentLevel);
    if (!eolFastPathSupported || amountOfSpaces > cachedBreakLinesWithSpaces[indentType][eol].length) {
      return eol + repeat(indentValue, initialIndentLevel + indentLevel);
    }
    if (amountOfSpaces <= 0) {
      return eol;
    }
    return cachedBreakLinesWithSpaces[indentType][eol][amountOfSpaces];
  }
  __name(newLinesAndIndent, "newLinesAndIndent");
  function scanNext() {
    let token = scanner.scan();
    numberLineBreaks = 0;
    while (token === 15 || token === 14) {
      if (token === 14 && options.keepLines) {
        numberLineBreaks += 1;
      } else if (token === 14) {
        numberLineBreaks = 1;
      }
      token = scanner.scan();
    }
    hasError = token === 16 || scanner.getTokenError() !== 0;
    return token;
  }
  __name(scanNext, "scanNext");
  const editOperations = [];
  function addEdit(text, startOffset, endOffset) {
    if (!hasError && (!range || startOffset < rangeEnd && endOffset > rangeStart) && documentText.substring(startOffset, endOffset) !== text) {
      editOperations.push({ offset: startOffset, length: endOffset - startOffset, content: text });
    }
  }
  __name(addEdit, "addEdit");
  let firstToken = scanNext();
  if (options.keepLines && numberLineBreaks > 0) {
    addEdit(repeat(eol, numberLineBreaks), 0, 0);
  }
  if (firstToken !== 17) {
    let firstTokenStart = scanner.getTokenOffset() + formatTextStart;
    let initialIndent = indentValue.length * initialIndentLevel < 20 && options.insertSpaces ? cachedSpaces[indentValue.length * initialIndentLevel] : repeat(indentValue, initialIndentLevel);
    addEdit(initialIndent, formatTextStart, firstTokenStart);
  }
  while (firstToken !== 17) {
    let firstTokenEnd = scanner.getTokenOffset() + scanner.getTokenLength() + formatTextStart;
    let secondToken = scanNext();
    let replaceContent = "";
    let needsLineBreak = false;
    while (numberLineBreaks === 0 && (secondToken === 12 || secondToken === 13)) {
      let commentTokenStart = scanner.getTokenOffset() + formatTextStart;
      addEdit(cachedSpaces[1], firstTokenEnd, commentTokenStart);
      firstTokenEnd = scanner.getTokenOffset() + scanner.getTokenLength() + formatTextStart;
      needsLineBreak = secondToken === 12;
      replaceContent = needsLineBreak ? newLinesAndIndent() : "";
      secondToken = scanNext();
    }
    if (secondToken === 2) {
      if (firstToken !== 1) {
        indentLevel--;
      }
      ;
      if (options.keepLines && numberLineBreaks > 0 || !options.keepLines && firstToken !== 1) {
        replaceContent = newLinesAndIndent();
      } else if (options.keepLines) {
        replaceContent = cachedSpaces[1];
      }
    } else if (secondToken === 4) {
      if (firstToken !== 3) {
        indentLevel--;
      }
      ;
      if (options.keepLines && numberLineBreaks > 0 || !options.keepLines && firstToken !== 3) {
        replaceContent = newLinesAndIndent();
      } else if (options.keepLines) {
        replaceContent = cachedSpaces[1];
      }
    } else {
      switch (firstToken) {
        case 3:
        case 1:
          indentLevel++;
          if (options.keepLines && numberLineBreaks > 0 || !options.keepLines) {
            replaceContent = newLinesAndIndent();
          } else {
            replaceContent = cachedSpaces[1];
          }
          break;
        case 5:
          if (options.keepLines && numberLineBreaks > 0 || !options.keepLines) {
            replaceContent = newLinesAndIndent();
          } else {
            replaceContent = cachedSpaces[1];
          }
          break;
        case 12:
          replaceContent = newLinesAndIndent();
          break;
        case 13:
          if (numberLineBreaks > 0) {
            replaceContent = newLinesAndIndent();
          } else if (!needsLineBreak) {
            replaceContent = cachedSpaces[1];
          }
          break;
        case 6:
          if (options.keepLines && numberLineBreaks > 0) {
            replaceContent = newLinesAndIndent();
          } else if (!needsLineBreak) {
            replaceContent = cachedSpaces[1];
          }
          break;
        case 10:
          if (options.keepLines && numberLineBreaks > 0) {
            replaceContent = newLinesAndIndent();
          } else if (secondToken === 6 && !needsLineBreak) {
            replaceContent = "";
          }
          break;
        case 7:
        case 8:
        case 9:
        case 11:
        case 2:
        case 4:
          if (options.keepLines && numberLineBreaks > 0) {
            replaceContent = newLinesAndIndent();
          } else {
            if ((secondToken === 12 || secondToken === 13) && !needsLineBreak) {
              replaceContent = cachedSpaces[1];
            } else if (secondToken !== 5 && secondToken !== 17) {
              hasError = true;
            }
          }
          break;
        case 16:
          hasError = true;
          break;
      }
      if (numberLineBreaks > 0 && (secondToken === 12 || secondToken === 13)) {
        replaceContent = newLinesAndIndent();
      }
    }
    if (secondToken === 17) {
      if (options.keepLines && numberLineBreaks > 0) {
        replaceContent = newLinesAndIndent();
      } else {
        replaceContent = options.insertFinalNewline ? eol : "";
      }
    }
    const secondTokenStart = scanner.getTokenOffset() + formatTextStart;
    addEdit(replaceContent, firstTokenEnd, secondTokenStart);
    firstToken = secondToken;
  }
  return editOperations;
}
__name(format, "format");
function repeat(s, count) {
  let result = "";
  for (let i = 0; i < count; i++) {
    result += s;
  }
  return result;
}
__name(repeat, "repeat");
function computeIndentLevel(content, options) {
  let i = 0;
  let nChars = 0;
  const tabSize = options.tabSize || 4;
  while (i < content.length) {
    let ch = content.charAt(i);
    if (ch === cachedSpaces[1]) {
      nChars++;
    } else if (ch === "	") {
      nChars += tabSize;
    } else {
      break;
    }
    i++;
  }
  return Math.floor(nChars / tabSize);
}
__name(computeIndentLevel, "computeIndentLevel");
function getEOL(options, text) {
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    if (ch === "\r") {
      if (i + 1 < text.length && text.charAt(i + 1) === "\n") {
        return "\r\n";
      }
      return "\r";
    } else if (ch === "\n") {
      return "\n";
    }
  }
  return options && options.eol || "\n";
}
__name(getEOL, "getEOL");
function isEOL(text, offset) {
  return "\r\n".indexOf(text.charAt(offset)) !== -1;
}
__name(isEOL, "isEOL");

// node_modules/jsonc-parser/lib/esm/impl/edit.js
init_esbuild_shims();

// node_modules/jsonc-parser/lib/esm/impl/parser.js
init_esbuild_shims();
var ParseOptions;
(function(ParseOptions2) {
  ParseOptions2.DEFAULT = {
    allowTrailingComma: false
  };
})(ParseOptions || (ParseOptions = {}));
function parseTree(text, errors = [], options = ParseOptions.DEFAULT) {
  let currentParent = { type: "array", offset: -1, length: -1, children: [], parent: void 0 };
  function ensurePropertyComplete(endOffset) {
    if (currentParent.type === "property") {
      currentParent.length = endOffset - currentParent.offset;
      currentParent = currentParent.parent;
    }
  }
  __name(ensurePropertyComplete, "ensurePropertyComplete");
  function onValue(valueNode) {
    currentParent.children.push(valueNode);
    return valueNode;
  }
  __name(onValue, "onValue");
  const visitor = {
    onObjectBegin: /* @__PURE__ */ __name((offset) => {
      currentParent = onValue({ type: "object", offset, length: -1, parent: currentParent, children: [] });
    }, "onObjectBegin"),
    onObjectProperty: /* @__PURE__ */ __name((name, offset, length) => {
      currentParent = onValue({ type: "property", offset, length: -1, parent: currentParent, children: [] });
      currentParent.children.push({ type: "string", value: name, offset, length, parent: currentParent });
    }, "onObjectProperty"),
    onObjectEnd: /* @__PURE__ */ __name((offset, length) => {
      ensurePropertyComplete(offset + length);
      currentParent.length = offset + length - currentParent.offset;
      currentParent = currentParent.parent;
      ensurePropertyComplete(offset + length);
    }, "onObjectEnd"),
    onArrayBegin: /* @__PURE__ */ __name((offset, length) => {
      currentParent = onValue({ type: "array", offset, length: -1, parent: currentParent, children: [] });
    }, "onArrayBegin"),
    onArrayEnd: /* @__PURE__ */ __name((offset, length) => {
      currentParent.length = offset + length - currentParent.offset;
      currentParent = currentParent.parent;
      ensurePropertyComplete(offset + length);
    }, "onArrayEnd"),
    onLiteralValue: /* @__PURE__ */ __name((value, offset, length) => {
      onValue({ type: getNodeType(value), offset, length, parent: currentParent, value });
      ensurePropertyComplete(offset + length);
    }, "onLiteralValue"),
    onSeparator: /* @__PURE__ */ __name((sep, offset, length) => {
      if (currentParent.type === "property") {
        if (sep === ":") {
          currentParent.colonOffset = offset;
        } else if (sep === ",") {
          ensurePropertyComplete(offset);
        }
      }
    }, "onSeparator"),
    onError: /* @__PURE__ */ __name((error, offset, length) => {
      errors.push({ error, offset, length });
    }, "onError")
  };
  visit(text, visitor, options);
  const result = currentParent.children[0];
  if (result) {
    delete result.parent;
  }
  return result;
}
__name(parseTree, "parseTree");
function findNodeAtLocation(root, path2) {
  if (!root) {
    return void 0;
  }
  let node = root;
  for (let segment of path2) {
    if (typeof segment === "string") {
      if (node.type !== "object" || !Array.isArray(node.children)) {
        return void 0;
      }
      let found = false;
      for (const propertyNode of node.children) {
        if (Array.isArray(propertyNode.children) && propertyNode.children[0].value === segment && propertyNode.children.length === 2) {
          node = propertyNode.children[1];
          found = true;
          break;
        }
      }
      if (!found) {
        return void 0;
      }
    } else {
      const index = segment;
      if (node.type !== "array" || index < 0 || !Array.isArray(node.children) || index >= node.children.length) {
        return void 0;
      }
      node = node.children[index];
    }
  }
  return node;
}
__name(findNodeAtLocation, "findNodeAtLocation");
function getNodeValue(node) {
  switch (node.type) {
    case "array":
      return node.children.map(getNodeValue);
    case "object":
      const obj = /* @__PURE__ */ Object.create(null);
      for (let prop of node.children) {
        const valueNode = prop.children[1];
        if (valueNode) {
          obj[prop.children[0].value] = getNodeValue(valueNode);
        }
      }
      return obj;
    case "null":
    case "string":
    case "number":
    case "boolean":
      return node.value;
    default:
      return void 0;
  }
}
__name(getNodeValue, "getNodeValue");
function visit(text, visitor, options = ParseOptions.DEFAULT) {
  const _scanner = createScanner(text, false);
  const _jsonPath = [];
  let suppressedCallbacks = 0;
  function toNoArgVisit(visitFunction) {
    return visitFunction ? () => suppressedCallbacks === 0 && visitFunction(_scanner.getTokenOffset(), _scanner.getTokenLength(), _scanner.getTokenStartLine(), _scanner.getTokenStartCharacter()) : () => true;
  }
  __name(toNoArgVisit, "toNoArgVisit");
  function toOneArgVisit(visitFunction) {
    return visitFunction ? (arg) => suppressedCallbacks === 0 && visitFunction(arg, _scanner.getTokenOffset(), _scanner.getTokenLength(), _scanner.getTokenStartLine(), _scanner.getTokenStartCharacter()) : () => true;
  }
  __name(toOneArgVisit, "toOneArgVisit");
  function toOneArgVisitWithPath(visitFunction) {
    return visitFunction ? (arg) => suppressedCallbacks === 0 && visitFunction(arg, _scanner.getTokenOffset(), _scanner.getTokenLength(), _scanner.getTokenStartLine(), _scanner.getTokenStartCharacter(), () => _jsonPath.slice()) : () => true;
  }
  __name(toOneArgVisitWithPath, "toOneArgVisitWithPath");
  function toBeginVisit(visitFunction) {
    return visitFunction ? () => {
      if (suppressedCallbacks > 0) {
        suppressedCallbacks++;
      } else {
        let cbReturn = visitFunction(_scanner.getTokenOffset(), _scanner.getTokenLength(), _scanner.getTokenStartLine(), _scanner.getTokenStartCharacter(), () => _jsonPath.slice());
        if (cbReturn === false) {
          suppressedCallbacks = 1;
        }
      }
    } : () => true;
  }
  __name(toBeginVisit, "toBeginVisit");
  function toEndVisit(visitFunction) {
    return visitFunction ? () => {
      if (suppressedCallbacks > 0) {
        suppressedCallbacks--;
      }
      if (suppressedCallbacks === 0) {
        visitFunction(_scanner.getTokenOffset(), _scanner.getTokenLength(), _scanner.getTokenStartLine(), _scanner.getTokenStartCharacter());
      }
    } : () => true;
  }
  __name(toEndVisit, "toEndVisit");
  const onObjectBegin = toBeginVisit(visitor.onObjectBegin), onObjectProperty = toOneArgVisitWithPath(visitor.onObjectProperty), onObjectEnd = toEndVisit(visitor.onObjectEnd), onArrayBegin = toBeginVisit(visitor.onArrayBegin), onArrayEnd = toEndVisit(visitor.onArrayEnd), onLiteralValue = toOneArgVisitWithPath(visitor.onLiteralValue), onSeparator = toOneArgVisit(visitor.onSeparator), onComment = toNoArgVisit(visitor.onComment), onError = toOneArgVisit(visitor.onError);
  const disallowComments = options && options.disallowComments;
  const allowTrailingComma = options && options.allowTrailingComma;
  function scanNext() {
    while (true) {
      const token = _scanner.scan();
      switch (_scanner.getTokenError()) {
        case 4:
          handleError(
            14
            /* ParseErrorCode.InvalidUnicode */
          );
          break;
        case 5:
          handleError(
            15
            /* ParseErrorCode.InvalidEscapeCharacter */
          );
          break;
        case 3:
          handleError(
            13
            /* ParseErrorCode.UnexpectedEndOfNumber */
          );
          break;
        case 1:
          if (!disallowComments) {
            handleError(
              11
              /* ParseErrorCode.UnexpectedEndOfComment */
            );
          }
          break;
        case 2:
          handleError(
            12
            /* ParseErrorCode.UnexpectedEndOfString */
          );
          break;
        case 6:
          handleError(
            16
            /* ParseErrorCode.InvalidCharacter */
          );
          break;
      }
      switch (token) {
        case 12:
        case 13:
          if (disallowComments) {
            handleError(
              10
              /* ParseErrorCode.InvalidCommentToken */
            );
          } else {
            onComment();
          }
          break;
        case 16:
          handleError(
            1
            /* ParseErrorCode.InvalidSymbol */
          );
          break;
        case 15:
        case 14:
          break;
        default:
          return token;
      }
    }
  }
  __name(scanNext, "scanNext");
  function handleError(error, skipUntilAfter = [], skipUntil = []) {
    onError(error);
    if (skipUntilAfter.length + skipUntil.length > 0) {
      let token = _scanner.getToken();
      while (token !== 17) {
        if (skipUntilAfter.indexOf(token) !== -1) {
          scanNext();
          break;
        } else if (skipUntil.indexOf(token) !== -1) {
          break;
        }
        token = scanNext();
      }
    }
  }
  __name(handleError, "handleError");
  function parseString(isValue) {
    const value = _scanner.getTokenValue();
    if (isValue) {
      onLiteralValue(value);
    } else {
      onObjectProperty(value);
      _jsonPath.push(value);
    }
    scanNext();
    return true;
  }
  __name(parseString, "parseString");
  function parseLiteral() {
    switch (_scanner.getToken()) {
      case 11:
        const tokenValue = _scanner.getTokenValue();
        let value = Number(tokenValue);
        if (isNaN(value)) {
          handleError(
            2
            /* ParseErrorCode.InvalidNumberFormat */
          );
          value = 0;
        }
        onLiteralValue(value);
        break;
      case 7:
        onLiteralValue(null);
        break;
      case 8:
        onLiteralValue(true);
        break;
      case 9:
        onLiteralValue(false);
        break;
      default:
        return false;
    }
    scanNext();
    return true;
  }
  __name(parseLiteral, "parseLiteral");
  function parseProperty() {
    if (_scanner.getToken() !== 10) {
      handleError(3, [], [
        2,
        5
        /* SyntaxKind.CommaToken */
      ]);
      return false;
    }
    parseString(false);
    if (_scanner.getToken() === 6) {
      onSeparator(":");
      scanNext();
      if (!parseValue()) {
        handleError(4, [], [
          2,
          5
          /* SyntaxKind.CommaToken */
        ]);
      }
    } else {
      handleError(5, [], [
        2,
        5
        /* SyntaxKind.CommaToken */
      ]);
    }
    _jsonPath.pop();
    return true;
  }
  __name(parseProperty, "parseProperty");
  function parseObject() {
    onObjectBegin();
    scanNext();
    let needsComma = false;
    while (_scanner.getToken() !== 2 && _scanner.getToken() !== 17) {
      if (_scanner.getToken() === 5) {
        if (!needsComma) {
          handleError(4, [], []);
        }
        onSeparator(",");
        scanNext();
        if (_scanner.getToken() === 2 && allowTrailingComma) {
          break;
        }
      } else if (needsComma) {
        handleError(6, [], []);
      }
      if (!parseProperty()) {
        handleError(4, [], [
          2,
          5
          /* SyntaxKind.CommaToken */
        ]);
      }
      needsComma = true;
    }
    onObjectEnd();
    if (_scanner.getToken() !== 2) {
      handleError(7, [
        2
        /* SyntaxKind.CloseBraceToken */
      ], []);
    } else {
      scanNext();
    }
    return true;
  }
  __name(parseObject, "parseObject");
  function parseArray() {
    onArrayBegin();
    scanNext();
    let isFirstElement = true;
    let needsComma = false;
    while (_scanner.getToken() !== 4 && _scanner.getToken() !== 17) {
      if (_scanner.getToken() === 5) {
        if (!needsComma) {
          handleError(4, [], []);
        }
        onSeparator(",");
        scanNext();
        if (_scanner.getToken() === 4 && allowTrailingComma) {
          break;
        }
      } else if (needsComma) {
        handleError(6, [], []);
      }
      if (isFirstElement) {
        _jsonPath.push(0);
        isFirstElement = false;
      } else {
        _jsonPath[_jsonPath.length - 1]++;
      }
      if (!parseValue()) {
        handleError(4, [], [
          4,
          5
          /* SyntaxKind.CommaToken */
        ]);
      }
      needsComma = true;
    }
    onArrayEnd();
    if (!isFirstElement) {
      _jsonPath.pop();
    }
    if (_scanner.getToken() !== 4) {
      handleError(8, [
        4
        /* SyntaxKind.CloseBracketToken */
      ], []);
    } else {
      scanNext();
    }
    return true;
  }
  __name(parseArray, "parseArray");
  function parseValue() {
    switch (_scanner.getToken()) {
      case 3:
        return parseArray();
      case 1:
        return parseObject();
      case 10:
        return parseString(true);
      default:
        return parseLiteral();
    }
  }
  __name(parseValue, "parseValue");
  scanNext();
  if (_scanner.getToken() === 17) {
    if (options.allowEmptyContent) {
      return true;
    }
    handleError(4, [], []);
    return false;
  }
  if (!parseValue()) {
    handleError(4, [], []);
    return false;
  }
  if (_scanner.getToken() !== 17) {
    handleError(9, [], []);
  }
  return true;
}
__name(visit, "visit");
function getNodeType(value) {
  switch (typeof value) {
    case "boolean":
      return "boolean";
    case "number":
      return "number";
    case "string":
      return "string";
    case "object": {
      if (!value) {
        return "null";
      } else if (Array.isArray(value)) {
        return "array";
      }
      return "object";
    }
    default:
      return "null";
  }
}
__name(getNodeType, "getNodeType");

// node_modules/jsonc-parser/lib/esm/impl/edit.js
function setProperty(text, originalPath, value, options) {
  const path2 = originalPath.slice();
  const errors = [];
  const root = parseTree(text, errors);
  let parent = void 0;
  let lastSegment = void 0;
  while (path2.length > 0) {
    lastSegment = path2.pop();
    parent = findNodeAtLocation(root, path2);
    if (parent === void 0 && value !== void 0) {
      if (typeof lastSegment === "string") {
        value = { [lastSegment]: value };
      } else {
        value = [value];
      }
    } else {
      break;
    }
  }
  if (!parent) {
    if (value === void 0) {
      throw new Error("Can not delete in empty document");
    }
    return withFormatting(text, { offset: root ? root.offset : 0, length: root ? root.length : 0, content: JSON.stringify(value) }, options);
  } else if (parent.type === "object" && typeof lastSegment === "string" && Array.isArray(parent.children)) {
    const existing = findNodeAtLocation(parent, [lastSegment]);
    if (existing !== void 0) {
      if (value === void 0) {
        if (!existing.parent) {
          throw new Error("Malformed AST");
        }
        const propertyIndex = parent.children.indexOf(existing.parent);
        let removeBegin;
        let removeEnd = existing.parent.offset + existing.parent.length;
        if (propertyIndex > 0) {
          let previous = parent.children[propertyIndex - 1];
          removeBegin = previous.offset + previous.length;
        } else {
          removeBegin = parent.offset + 1;
          if (parent.children.length > 1) {
            let next = parent.children[1];
            removeEnd = next.offset;
          }
        }
        return withFormatting(text, { offset: removeBegin, length: removeEnd - removeBegin, content: "" }, options);
      } else {
        return withFormatting(text, { offset: existing.offset, length: existing.length, content: JSON.stringify(value) }, options);
      }
    } else {
      if (value === void 0) {
        return [];
      }
      const newProperty = `${JSON.stringify(lastSegment)}: ${JSON.stringify(value)}`;
      const index = options.getInsertionIndex ? options.getInsertionIndex(parent.children.map((p) => p.children[0].value)) : parent.children.length;
      let edit;
      if (index > 0) {
        let previous = parent.children[index - 1];
        edit = { offset: previous.offset + previous.length, length: 0, content: "," + newProperty };
      } else if (parent.children.length === 0) {
        edit = { offset: parent.offset + 1, length: 0, content: newProperty };
      } else {
        edit = { offset: parent.offset + 1, length: 0, content: newProperty + "," };
      }
      return withFormatting(text, edit, options);
    }
  } else if (parent.type === "array" && typeof lastSegment === "number" && Array.isArray(parent.children)) {
    const insertIndex = lastSegment;
    if (insertIndex === -1) {
      const newProperty = `${JSON.stringify(value)}`;
      let edit;
      if (parent.children.length === 0) {
        edit = { offset: parent.offset + 1, length: 0, content: newProperty };
      } else {
        const previous = parent.children[parent.children.length - 1];
        edit = { offset: previous.offset + previous.length, length: 0, content: "," + newProperty };
      }
      return withFormatting(text, edit, options);
    } else if (value === void 0 && parent.children.length >= 0) {
      const removalIndex = lastSegment;
      const toRemove = parent.children[removalIndex];
      let edit;
      if (parent.children.length === 1) {
        edit = { offset: parent.offset + 1, length: parent.length - 2, content: "" };
      } else if (parent.children.length - 1 === removalIndex) {
        let previous = parent.children[removalIndex - 1];
        let offset = previous.offset + previous.length;
        let parentEndOffset = parent.offset + parent.length;
        edit = { offset, length: parentEndOffset - 2 - offset, content: "" };
      } else {
        edit = { offset: toRemove.offset, length: parent.children[removalIndex + 1].offset - toRemove.offset, content: "" };
      }
      return withFormatting(text, edit, options);
    } else if (value !== void 0) {
      let edit;
      const newProperty = `${JSON.stringify(value)}`;
      if (!options.isArrayInsertion && parent.children.length > lastSegment) {
        const toModify = parent.children[lastSegment];
        edit = { offset: toModify.offset, length: toModify.length, content: newProperty };
      } else if (parent.children.length === 0 || lastSegment === 0) {
        edit = { offset: parent.offset + 1, length: 0, content: parent.children.length === 0 ? newProperty : newProperty + "," };
      } else {
        const index = lastSegment > parent.children.length ? parent.children.length : lastSegment;
        const previous = parent.children[index - 1];
        edit = { offset: previous.offset + previous.length, length: 0, content: "," + newProperty };
      }
      return withFormatting(text, edit, options);
    } else {
      throw new Error(`Can not ${value === void 0 ? "remove" : options.isArrayInsertion ? "insert" : "modify"} Array index ${insertIndex} as length is not sufficient`);
    }
  } else {
    throw new Error(`Can not add ${typeof lastSegment !== "number" ? "index" : "property"} to parent of type ${parent.type}`);
  }
}
__name(setProperty, "setProperty");
function withFormatting(text, edit, options) {
  if (!options.formattingOptions) {
    return [edit];
  }
  let newText = applyEdit(text, edit);
  let begin = edit.offset;
  let end = edit.offset + edit.content.length;
  if (edit.length === 0 || edit.content.length === 0) {
    while (begin > 0 && !isEOL(newText, begin - 1)) {
      begin--;
    }
    while (end < newText.length && !isEOL(newText, end)) {
      end++;
    }
  }
  const edits = format(newText, { offset: begin, length: end - begin }, { ...options.formattingOptions, keepLines: false });
  for (let i = edits.length - 1; i >= 0; i--) {
    const edit2 = edits[i];
    newText = applyEdit(newText, edit2);
    begin = Math.min(begin, edit2.offset);
    end = Math.max(end, edit2.offset + edit2.length);
    end += edit2.content.length - edit2.length;
  }
  const editLength = text.length - (newText.length - end) - begin;
  return [{ offset: begin, length: editLength, content: newText.substring(begin, end) }];
}
__name(withFormatting, "withFormatting");
function applyEdit(text, edit) {
  return text.substring(0, edit.offset) + edit.content + text.substring(edit.offset + edit.length);
}
__name(applyEdit, "applyEdit");

// node_modules/jsonc-parser/lib/esm/main.js
var ScanError;
(function(ScanError2) {
  ScanError2[ScanError2["None"] = 0] = "None";
  ScanError2[ScanError2["UnexpectedEndOfComment"] = 1] = "UnexpectedEndOfComment";
  ScanError2[ScanError2["UnexpectedEndOfString"] = 2] = "UnexpectedEndOfString";
  ScanError2[ScanError2["UnexpectedEndOfNumber"] = 3] = "UnexpectedEndOfNumber";
  ScanError2[ScanError2["InvalidUnicode"] = 4] = "InvalidUnicode";
  ScanError2[ScanError2["InvalidEscapeCharacter"] = 5] = "InvalidEscapeCharacter";
  ScanError2[ScanError2["InvalidCharacter"] = 6] = "InvalidCharacter";
})(ScanError || (ScanError = {}));
var SyntaxKind;
(function(SyntaxKind2) {
  SyntaxKind2[SyntaxKind2["OpenBraceToken"] = 1] = "OpenBraceToken";
  SyntaxKind2[SyntaxKind2["CloseBraceToken"] = 2] = "CloseBraceToken";
  SyntaxKind2[SyntaxKind2["OpenBracketToken"] = 3] = "OpenBracketToken";
  SyntaxKind2[SyntaxKind2["CloseBracketToken"] = 4] = "CloseBracketToken";
  SyntaxKind2[SyntaxKind2["CommaToken"] = 5] = "CommaToken";
  SyntaxKind2[SyntaxKind2["ColonToken"] = 6] = "ColonToken";
  SyntaxKind2[SyntaxKind2["NullKeyword"] = 7] = "NullKeyword";
  SyntaxKind2[SyntaxKind2["TrueKeyword"] = 8] = "TrueKeyword";
  SyntaxKind2[SyntaxKind2["FalseKeyword"] = 9] = "FalseKeyword";
  SyntaxKind2[SyntaxKind2["StringLiteral"] = 10] = "StringLiteral";
  SyntaxKind2[SyntaxKind2["NumericLiteral"] = 11] = "NumericLiteral";
  SyntaxKind2[SyntaxKind2["LineCommentTrivia"] = 12] = "LineCommentTrivia";
  SyntaxKind2[SyntaxKind2["BlockCommentTrivia"] = 13] = "BlockCommentTrivia";
  SyntaxKind2[SyntaxKind2["LineBreakTrivia"] = 14] = "LineBreakTrivia";
  SyntaxKind2[SyntaxKind2["Trivia"] = 15] = "Trivia";
  SyntaxKind2[SyntaxKind2["Unknown"] = 16] = "Unknown";
  SyntaxKind2[SyntaxKind2["EOF"] = 17] = "EOF";
})(SyntaxKind || (SyntaxKind = {}));
var parseTree2 = parseTree;
var findNodeAtLocation2 = findNodeAtLocation;
var getNodeValue2 = getNodeValue;
var ParseErrorCode;
(function(ParseErrorCode2) {
  ParseErrorCode2[ParseErrorCode2["InvalidSymbol"] = 1] = "InvalidSymbol";
  ParseErrorCode2[ParseErrorCode2["InvalidNumberFormat"] = 2] = "InvalidNumberFormat";
  ParseErrorCode2[ParseErrorCode2["PropertyNameExpected"] = 3] = "PropertyNameExpected";
  ParseErrorCode2[ParseErrorCode2["ValueExpected"] = 4] = "ValueExpected";
  ParseErrorCode2[ParseErrorCode2["ColonExpected"] = 5] = "ColonExpected";
  ParseErrorCode2[ParseErrorCode2["CommaExpected"] = 6] = "CommaExpected";
  ParseErrorCode2[ParseErrorCode2["CloseBraceExpected"] = 7] = "CloseBraceExpected";
  ParseErrorCode2[ParseErrorCode2["CloseBracketExpected"] = 8] = "CloseBracketExpected";
  ParseErrorCode2[ParseErrorCode2["EndOfFileExpected"] = 9] = "EndOfFileExpected";
  ParseErrorCode2[ParseErrorCode2["InvalidCommentToken"] = 10] = "InvalidCommentToken";
  ParseErrorCode2[ParseErrorCode2["UnexpectedEndOfComment"] = 11] = "UnexpectedEndOfComment";
  ParseErrorCode2[ParseErrorCode2["UnexpectedEndOfString"] = 12] = "UnexpectedEndOfString";
  ParseErrorCode2[ParseErrorCode2["UnexpectedEndOfNumber"] = 13] = "UnexpectedEndOfNumber";
  ParseErrorCode2[ParseErrorCode2["InvalidUnicode"] = 14] = "InvalidUnicode";
  ParseErrorCode2[ParseErrorCode2["InvalidEscapeCharacter"] = 15] = "InvalidEscapeCharacter";
  ParseErrorCode2[ParseErrorCode2["InvalidCharacter"] = 16] = "InvalidCharacter";
})(ParseErrorCode || (ParseErrorCode = {}));
function printParseErrorCode(code) {
  switch (code) {
    case 1:
      return "InvalidSymbol";
    case 2:
      return "InvalidNumberFormat";
    case 3:
      return "PropertyNameExpected";
    case 4:
      return "ValueExpected";
    case 5:
      return "ColonExpected";
    case 6:
      return "CommaExpected";
    case 7:
      return "CloseBraceExpected";
    case 8:
      return "CloseBracketExpected";
    case 9:
      return "EndOfFileExpected";
    case 10:
      return "InvalidCommentToken";
    case 11:
      return "UnexpectedEndOfComment";
    case 12:
      return "UnexpectedEndOfString";
    case 13:
      return "UnexpectedEndOfNumber";
    case 14:
      return "InvalidUnicode";
    case 15:
      return "InvalidEscapeCharacter";
    case 16:
      return "InvalidCharacter";
  }
  return "<unknown ParseErrorCode>";
}
__name(printParseErrorCode, "printParseErrorCode");
function modify(text, path2, value, options) {
  return setProperty(text, path2, value, options);
}
__name(modify, "modify");
function applyEdits(text, edits) {
  let sortedEdits = edits.slice(0).sort((a, b) => {
    const diff = a.offset - b.offset;
    if (diff === 0) {
      return a.length - b.length;
    }
    return diff;
  });
  let lastModifiedOffset = text.length;
  for (let i = sortedEdits.length - 1; i >= 0; i--) {
    let e = sortedEdits[i];
    if (e.offset + e.length <= lastModifiedOffset) {
      text = applyEdit(text, e);
    } else {
      throw new Error("Overlapping edit");
    }
    lastModifiedOffset = e.offset;
  }
  return text;
}
__name(applyEdits, "applyEdits");

// packages/cli/src/utils/writeWithBackup.ts
init_esbuild_shims();
import * as fs from "node:fs";
function writeWithBackupSync(targetPath, content, options = {}) {
  const { backupSuffix = ".orig", encoding = "utf-8" } = options;
  const tempPath = `${targetPath}.tmp`;
  const backupPath = `${targetPath}${backupSuffix}`;
  let backupCreated = false;
  try {
    if (fs.existsSync(tempPath)) {
      fs.unlinkSync(tempPath);
    }
  } catch (_e) {
  }
  try {
    fs.writeFileSync(tempPath, content, { encoding, flush: true });
    if (fs.existsSync(targetPath)) {
      const targetStat = fs.statSync(targetPath);
      if (targetStat.isDirectory()) {
        try {
          fs.unlinkSync(tempPath);
        } catch (_e) {
        }
        throw new Error(
          `Cannot write to '${targetPath}' because it is a directory`
        );
      }
      try {
        fs.renameSync(targetPath, backupPath);
        backupCreated = true;
      } catch (backupError) {
        try {
          fs.unlinkSync(tempPath);
        } catch (_e) {
        }
        throw new Error(
          `Failed to backup existing file: ${backupError instanceof Error ? backupError.message : String(backupError)}`
        );
      }
    }
    try {
      fs.renameSync(tempPath, targetPath);
      if (backupCreated) {
        try {
          fs.unlinkSync(backupPath);
        } catch (_e) {
        }
      }
    } catch (renameError) {
      let restoreFailedMessage;
      let backupExisted = false;
      if (fs.existsSync(backupPath)) {
        backupExisted = true;
        try {
          fs.renameSync(backupPath, targetPath);
        } catch (restoreError) {
          restoreFailedMessage = restoreError instanceof Error ? restoreError.message : String(restoreError);
        }
      }
      const writeFailureMessage = renameError instanceof Error ? renameError.message : String(renameError);
      if (restoreFailedMessage) {
        throw new Error(
          `Failed to write file: ${writeFailureMessage}. Automatic restore failed: ${restoreFailedMessage}. Manual recovery may be required using backup file '${backupPath}'.`
        );
      }
      if (backupExisted) {
        throw new Error(
          `Failed to write file: ${writeFailureMessage}. Target was automatically restored from backup '${backupPath}'.`
        );
      }
      throw new Error(
        `Failed to write file: ${writeFailureMessage}. No backup file was available for restoration.`
      );
    }
  } catch (error) {
    try {
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
    } catch (_e) {
    }
    throw error;
  }
}
__name(writeWithBackupSync, "writeWithBackupSync");

// packages/cli/src/utils/jsonc-editor.ts
var PARSE_OPTIONS = { allowTrailingComma: true };
function updateSettingsFilePreservingFormat(filePath, updates, sync = false, replacePath = []) {
  if (!fs2.existsSync(filePath)) {
    const content = JSON.stringify(updates, null, 2);
    writeWithBackupSync(filePath, content);
    return true;
  }
  const originalContent = fs2.readFileSync(filePath, "utf-8");
  try {
    parseJsoncObject(originalContent);
  } catch (_error) {
    writeStderrLine("Error parsing settings file.");
    writeStderrLine(
      `Settings file may be corrupted: ${_error instanceof Error ? _error.message : String(_error)}`
    );
    return false;
  }
  let updatedContent;
  try {
    updatedContent = updateJsoncContent(
      originalContent,
      updates,
      sync,
      replacePath
    );
  } catch (validationError) {
    writeStderrLine(
      "Error: Refusing to write settings file \u2014 the result would not be valid JSON."
    );
    writeStderrLine(
      validationError instanceof Error ? validationError.message : String(validationError)
    );
    return false;
  }
  writeWithBackupSync(filePath, updatedContent);
  return true;
}
__name(updateSettingsFilePreservingFormat, "updateSettingsFilePreservingFormat");
function parseJsoncObject(content) {
  const errors = [];
  const root = parseTree2(stripBom(content), errors, PARSE_OPTIONS);
  if (errors.length > 0) {
    const error = errors[0];
    throw new Error(
      `${printParseErrorCode(error.error)} at offset ${error.offset}`
    );
  }
  if (root?.type !== "object") {
    throw new Error("JSONC document root is not a JSON object.");
  }
  return JSON.parse(JSON.stringify(getNodeValue2(root)));
}
__name(parseJsoncObject, "parseJsoncObject");
function updateJsoncContent(content, updates, sync = false, replacePath = []) {
  const bom = content.startsWith("\uFEFF") ? "\uFEFF" : "";
  const editableContent = stripBom(content);
  const parsed = parseJsoncObject(editableContent);
  const targetWithUndefined = applyUpdates(
    structuredClone(parsed),
    updates,
    sync,
    replacePath
  );
  const target = JSON.parse(JSON.stringify(targetWithUndefined));
  const options = {
    formattingOptions: detectFormattingOptions(editableContent)
  };
  let updated = normalizeDuplicateProperties(editableContent, options);
  const current = parseJsoncObject(updated);
  for (const operation of collectOperations(current, target)) {
    if (operation.value === void 0) {
      updated = removeTrailingInlineComment(updated, operation.path);
    }
    updated = applyEdits(
      updated,
      modify(updated, operation.path, operation.value, options)
    );
  }
  const reparsed = parseJsoncObject(updated);
  if (!isDeepStrictEqual(reparsed, target)) {
    throw new Error("Edited JSONC does not match the intended settings.");
  }
  return bom + updated;
}
__name(updateJsoncContent, "updateJsoncContent");
function applyUpdates(current, updates, sync = false, replacePath = [], currentPath = []) {
  const result = current;
  if (sync) {
    const keysToRemove = Object.keys(result).filter(
      (key) => !Object.hasOwn(updates, key)
    );
    for (const key of keysToRemove) {
      delete result[key];
    }
  }
  for (const key of Object.getOwnPropertyNames(updates)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      continue;
    }
    const value = updates[key];
    const nextPath = [...currentPath, key];
    const valueIsObject = typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length > 0;
    if (pathsEqual(nextPath, replacePath)) {
      result[key] = valueIsObject ? applyUpdates({}, value) : value;
      continue;
    }
    if (valueIsObject && (typeof result[key] !== "object" || result[key] === null || Array.isArray(result[key]))) {
      result[key] = applyUpdates(
        {},
        value,
        sync,
        replacePath,
        nextPath
      );
    } else if (valueIsObject && typeof result[key] === "object" && result[key] !== null && !Array.isArray(result[key])) {
      result[key] = applyUpdates(
        result[key],
        value,
        sync,
        replacePath,
        nextPath
      );
    } else {
      result[key] = value;
    }
  }
  return result;
}
__name(applyUpdates, "applyUpdates");
function stripBom(content) {
  return content.startsWith("\uFEFF") ? content.slice(1) : content;
}
__name(stripBom, "stripBom");
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
__name(isRecord, "isRecord");
function detectFormattingOptions(content) {
  const root = parseTree2(content, [], PARSE_OPTIONS);
  const firstKey = root?.children?.[0]?.children?.[0];
  const lineStart = firstKey === void 0 ? -1 : content.lastIndexOf("\n", firstKey.offset - 1);
  const candidate = firstKey === void 0 ? void 0 : content.slice(lineStart + 1, firstKey.offset);
  const indentation = candidate !== void 0 && /^[ \t]*$/.test(candidate) ? candidate : "  ";
  return {
    eol: content.includes("\r\n") ? "\r\n" : "\n",
    insertSpaces: !indentation.startsWith("	"),
    tabSize: indentation.startsWith("	") ? 1 : indentation.length,
    insertFinalNewline: content.endsWith("\n")
  };
}
__name(detectFormattingOptions, "detectFormattingOptions");
function collectOperations(current, target, path2 = [], operations = []) {
  for (const key of Object.keys(current)) {
    if (!Object.hasOwn(target, key)) {
      operations.push({ path: [...path2, key], value: void 0 });
    }
  }
  for (const key of Object.keys(target)) {
    const nextPath = [...path2, key];
    if (!Object.hasOwn(current, key)) {
      operations.push({ path: nextPath, value: target[key] });
    } else if (isRecord(current[key]) && isRecord(target[key])) {
      collectOperations(current[key], target[key], nextPath, operations);
    } else if (!isDeepStrictEqual(current[key], target[key])) {
      operations.push({ path: nextPath, value: target[key] });
    }
  }
  return operations;
}
__name(collectOperations, "collectOperations");
function findDuplicateProperty(node, path2 = []) {
  if (node.type !== "object" || node.children === void 0) {
    return void 0;
  }
  const properties = /* @__PURE__ */ new Map();
  for (const property of node.children) {
    const keyNode = property.children?.[0];
    const key = keyNode?.value;
    if (typeof key !== "string" || keyNode === void 0) {
      continue;
    }
    const previous = properties.get(key);
    if (previous !== void 0) {
      return {
        objectPath: [...path2],
        keyNode: previous,
        propertyNames: new Set(properties.keys())
      };
    }
    properties.set(key, keyNode);
  }
  for (const property of node.children) {
    const key = property.children?.[0]?.value;
    const valueNode = property.children?.[1];
    if (typeof key !== "string" || valueNode === void 0) {
      continue;
    }
    const duplicate = findDuplicateProperty(valueNode, [...path2, key]);
    if (duplicate !== void 0) {
      return duplicate;
    }
  }
  return void 0;
}
__name(findDuplicateProperty, "findDuplicateProperty");
function normalizeDuplicateProperties(content, options) {
  let normalized = content;
  let duplicateIndex = 0;
  while (true) {
    const root = parseTree2(normalized, [], PARSE_OPTIONS);
    if (root === void 0) {
      return normalized;
    }
    const duplicate = findDuplicateProperty(root);
    if (duplicate === void 0) {
      return normalized;
    }
    let temporaryKey;
    do {
      temporaryKey = `__qwen_duplicate_${duplicateIndex}`;
      duplicateIndex += 1;
    } while (duplicate.propertyNames.has(temporaryKey));
    let renamed = normalized.slice(0, duplicate.keyNode.offset) + JSON.stringify(temporaryKey) + normalized.slice(duplicate.keyNode.offset + duplicate.keyNode.length);
    renamed = removeTrailingInlineComment(renamed, [
      ...duplicate.objectPath,
      temporaryKey
    ]);
    normalized = applyEdits(
      renamed,
      modify(
        renamed,
        [...duplicate.objectPath, temporaryKey],
        void 0,
        options
      )
    );
  }
}
__name(normalizeDuplicateProperties, "normalizeDuplicateProperties");
function removeTrailingInlineComment(content, path2) {
  const root = parseTree2(content, [], PARSE_OPTIONS);
  if (root === void 0) {
    return content;
  }
  const node = findNodeAtLocation2(root, [...path2]);
  if (node === void 0) {
    return content;
  }
  const tail = content.slice(node.offset + node.length);
  const match = tail.match(
    /^[ \t]*(?:,[ \t]*)?(\/\/[^\r\n]*|\/\*[\s\S]*?\*\/)/
  );
  const comment = match?.[1];
  if (comment === void 0 || match === null) {
    return content;
  }
  const commentOffset = node.offset + node.length + match[0].indexOf(comment);
  return content.slice(0, commentOffset) + content.slice(commentOffset + comment.length);
}
__name(removeTrailingInlineComment, "removeTrailingInlineComment");
function pathsEqual(left, right) {
  return left.length === right.length && left.every((segment, index) => segment === right[index]);
}
__name(pathsEqual, "pathsEqual");

// packages/cli/src/config/trustedFolders.ts
var debugLogger = createDebugLogger("TRUSTED_FOLDERS");
var TRUSTED_FOLDERS_FILENAME = "trustedFolders.json";
function getTrustedFoldersPath() {
  if (process.env["QWEN_CODE_TRUSTED_FOLDERS_PATH"]) {
    return process.env["QWEN_CODE_TRUSTED_FOLDERS_PATH"];
  }
  return path.join(Storage.getGlobalQwenDir(), TRUSTED_FOLDERS_FILENAME);
}
__name(getTrustedFoldersPath, "getTrustedFoldersPath");
var TrustLevel = /* @__PURE__ */ ((TrustLevel2) => {
  TrustLevel2["TRUST_FOLDER"] = "TRUST_FOLDER";
  TrustLevel2["TRUST_PARENT"] = "TRUST_PARENT";
  TrustLevel2["DO_NOT_TRUST"] = "DO_NOT_TRUST";
  return TrustLevel2;
})(TrustLevel || {});
var trustedFoldersChangeListeners = /* @__PURE__ */ new Set();
function onTrustedFoldersChanged(listener) {
  trustedFoldersChangeListeners.add(listener);
  return () => trustedFoldersChangeListeners.delete(listener);
}
__name(onTrustedFoldersChanged, "onTrustedFoldersChanged");
function notifyTrustedFoldersChanged() {
  for (const listener of trustedFoldersChangeListeners) listener();
}
__name(notifyTrustedFoldersChanged, "notifyTrustedFoldersChanged");
var LoadedTrustedFolders = class {
  constructor(user, errors) {
    this.user = user;
    this.errors = errors;
  }
  static {
    __name(this, "LoadedTrustedFolders");
  }
  get rules() {
    return Object.entries(this.user.config).map(([path2, trustLevel]) => ({
      path: path2,
      trustLevel
    }));
  }
  /**
   * Returns true or false if the path should be "trusted". This function
   * should only be invoked when the folder trust setting is active.
   *
   * @param location path
   * @returns
   */
  isPathTrusted(location) {
    return resolveTrustDecision(
      buildTrustPrecedenceRules(this.rules),
      getPathComparisonVariants(location)
    );
  }
  setValue(path2, trustLevel) {
    const committedConfig = writeTrustedFolders(
      this.user.path,
      (diskConfig) => ({ ...diskConfig, [path2]: trustLevel })
    );
    this.user.config = committedConfig;
    notifyTrustedFoldersChanged();
  }
};
var loadedTrustedFolders;
function resetTrustedFoldersForTesting() {
  loadedTrustedFolders = void 0;
}
__name(resetTrustedFoldersForTesting, "resetTrustedFoldersForTesting");
function loadTrustedFolders() {
  if (loadedTrustedFolders) {
    return loadedTrustedFolders;
  }
  const errors = [];
  let userConfig = {};
  const userPath = getTrustedFoldersPath();
  try {
    if (fs3.existsSync(userPath)) {
      const content = fs3.readFileSync(userPath, "utf-8");
      const parsed = JSON.parse((0, import_strip_json_comments.default)(content));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        errors.push({
          message: "Trusted folders file is not a valid JSON object.",
          path: userPath
        });
      } else {
        userConfig = parsed;
      }
    }
  } catch (error) {
    errors.push({
      message: getErrorMessage(error),
      path: userPath
    });
  }
  loadedTrustedFolders = new LoadedTrustedFolders(
    { path: userPath, config: userConfig },
    errors
  );
  return loadedTrustedFolders;
}
__name(loadTrustedFolders, "loadTrustedFolders");
function saveTrustedFolders(trustedFoldersFile) {
  writeTrustedFolders(trustedFoldersFile.path, () => ({
    ...trustedFoldersFile.config
  }));
}
__name(saveTrustedFolders, "saveTrustedFolders");
function assertTrustedFoldersConfig(config) {
  for (const [rulePath, trustLevel] of Object.entries(config)) {
    if (!Object.values(TrustLevel).includes(trustLevel)) {
      throw new FatalConfigError(
        `Invalid trusted folder rule for ${JSON.stringify(rulePath)}.`
      );
    }
  }
}
__name(assertTrustedFoldersConfig, "assertTrustedFoldersConfig");
function writeTrustedFolders(filePath, update) {
  const dirPath = path.dirname(filePath);
  if (!fs3.existsSync(dirPath)) {
    fs3.mkdirSync(dirPath, { recursive: true });
  }
  const release = import_proper_lockfile.default.lockSync(filePath, {
    realpath: false,
    stale: 1e4,
    onCompromised: /* @__PURE__ */ __name((err) => {
      debugLogger.warn("trusted folders lock compromised:", err);
    }, "onCompromised")
  });
  try {
    let originalContent = "{}";
    if (fs3.existsSync(filePath)) {
      const stat = fs3.lstatSync(filePath);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new FatalConfigError(
          "Trusted folders path must be a regular file."
        );
      }
      originalContent = fs3.readFileSync(filePath, "utf-8");
    }
    let parsed;
    try {
      parsed = parseJsoncObject(originalContent);
    } catch (error) {
      if (error instanceof Error && error.message === "JSONC document root is not a JSON object.") {
        throw new FatalConfigError(
          "Trusted folders file is not a valid JSON object."
        );
      }
      throw error;
    }
    const diskConfig = Object.fromEntries(Object.entries(parsed));
    assertTrustedFoldersConfig(diskConfig);
    const nextConfig = update({ ...diskConfig });
    assertTrustedFoldersConfig(nextConfig);
    const content = updateJsoncContent(originalContent, nextConfig, true);
    atomicWriteFileSync(
      filePath,
      content,
      // noFollow: refuse to follow any pre-placed symlink at the
      // config path — a redirected write could either leak the
      // trusted-folder list to an attacker target or leave the user's
      // real config silently stale. Matches the credential write
      // sites' security posture (sharedTokenManager, oauth-token-storage,
      // file-token-storage all use noFollow:true).
      { encoding: "utf-8", mode: 384, forceMode: true, noFollow: true }
    );
    return nextConfig;
  } finally {
    try {
      release();
    } catch {
    }
  }
}
__name(writeTrustedFolders, "writeTrustedFolders");
function isFolderTrustEnabled(settings) {
  const folderTrustSetting = settings.security?.folderTrust?.enabled ?? false;
  return folderTrustSetting;
}
__name(isFolderTrustEnabled, "isFolderTrustEnabled");
function getExplicitTrustLevel(trustConfig, workspaceCwd) {
  const winner = resolveTrustRule(
    buildTrustPrecedenceRules(
      Object.entries(trustConfig).map(([rulePath, trustLevel]) => ({
        path: rulePath,
        trustLevel
      }))
    ),
    getPathComparisonVariants(workspaceCwd)
  );
  return winner?.payload ?? null;
}
__name(getExplicitTrustLevel, "getExplicitTrustLevel");
function loadTrustedFoldersWithOverrides(trustConfig) {
  const folders = loadTrustedFolders();
  if (folders.errors.length > 0) {
    const errorMessages = folders.errors.map(
      (error) => `Error in ${error.path}: ${error.message}`
    );
    throw new FatalConfigError(
      `${errorMessages.join("\n")}
Please fix the configuration file and try again.`
    );
  }
  if (trustConfig) {
    return new LoadedTrustedFolders(
      { ...folders.user, config: trustConfig },
      folders.errors
    );
  }
  return folders;
}
__name(loadTrustedFoldersWithOverrides, "loadTrustedFoldersWithOverrides");
function trustStatusToResult(status) {
  if (status.effective.source === "disabled") {
    return { isTrusted: true, source: void 0 };
  }
  return {
    isTrusted: status.effective.state === "trusted" ? true : status.effective.state === "untrusted" ? false : void 0,
    source: status.effective.source === "file" || status.effective.source === "ide" ? status.effective.source : void 0
  };
}
__name(trustStatusToResult, "trustStatusToResult");
function getWorkspaceTrustStatus(settings, workspaceCwd, trustConfig) {
  if (!isFolderTrustEnabled(settings)) {
    return {
      v: 1,
      workspaceCwd,
      folderTrustEnabled: false,
      effective: { state: "trusted", source: "disabled" },
      explicitTrustLevel: null,
      requiresDaemonRestartForChanges: true
    };
  }
  const ideTrust = ideContextStore.get()?.workspaceState?.isTrusted;
  if (ideTrust !== void 0 && arePathsEquivalent(workspaceCwd, process.cwd())) {
    return {
      v: 1,
      workspaceCwd,
      folderTrustEnabled: true,
      effective: {
        state: ideTrust ? "trusted" : "untrusted",
        source: "ide"
      },
      explicitTrustLevel: null,
      requiresDaemonRestartForChanges: true
    };
  }
  const folders = loadTrustedFoldersWithOverrides(trustConfig);
  const isTrusted = folders.isPathTrusted(workspaceCwd);
  const state = isTrusted === true ? "trusted" : isTrusted === false ? "untrusted" : "unknown";
  return {
    v: 1,
    workspaceCwd,
    folderTrustEnabled: true,
    effective: {
      state,
      source: isTrusted === void 0 ? "none" : "file"
    },
    explicitTrustLevel: getExplicitTrustLevel(
      folders.user.config,
      workspaceCwd
    ),
    requiresDaemonRestartForChanges: true
  };
}
__name(getWorkspaceTrustStatus, "getWorkspaceTrustStatus");
function isWorkspaceTrusted(settings, trustConfig, workspacePath) {
  if (!isFolderTrustEnabled(settings)) {
    return { isTrusted: true, source: void 0 };
  }
  const ideTrust = ideContextStore.get()?.workspaceState?.isTrusted;
  if (ideTrust !== void 0 && (workspacePath === void 0 || arePathsEquivalent(workspacePath, process.cwd()))) {
    return { isTrusted: ideTrust, source: "ide" };
  }
  return trustStatusToResult(
    getWorkspaceTrustStatus(
      settings,
      workspacePath ?? process.cwd(),
      trustConfig
    )
  );
}
__name(isWorkspaceTrusted, "isWorkspaceTrusted");

export {
  writeWithBackupSync,
  updateSettingsFilePreservingFormat,
  parseJsoncObject,
  TRUSTED_FOLDERS_FILENAME,
  getTrustedFoldersPath,
  TrustLevel,
  onTrustedFoldersChanged,
  LoadedTrustedFolders,
  resetTrustedFoldersForTesting,
  loadTrustedFolders,
  saveTrustedFolders,
  isFolderTrustEnabled,
  getExplicitTrustLevel,
  getWorkspaceTrustStatus,
  isWorkspaceTrusted
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
