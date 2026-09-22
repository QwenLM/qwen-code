// Force strict mode and setup for ESM
"use strict";
import {
  isTool
} from "./chunk-VPGRGNNH.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __commonJS,
  __name,
  __toESM
} from "./chunk-J2S4EL5Y.js";

// node_modules/shell-quote/quote.js
var require_quote = __commonJS({
  "node_modules/shell-quote/quote.js"(exports, module) {
    "use strict";
    init_esbuild_shims();
    var OPS = (
      /** @type {const} */
      [
        "||",
        "&&",
        ";;",
        "|&",
        "<(",
        "<<<",
        ">>",
        ">&",
        "<&",
        "&",
        ";",
        "(",
        ")",
        "|",
        "<",
        ">"
      ]
    );
    var LINE_TERMINATORS = /[\n\r\u2028\u2029]/;
    var GLOB_SHELL_SPECIAL = /[\s#!"$&'():;<=>@\\^`|]/g;
    module.exports = /* @__PURE__ */ __name(function quote2(xs) {
      return xs.map(function(s) {
        if (s === "") {
          return (
            /** @type {const} */
            "''"
          );
        }
        if (s && typeof s === "object") {
          if ("op" in s && s.op === "glob") {
            if (typeof s.pattern !== "string") {
              throw new TypeError("glob token requires a string `pattern`");
            }
            if (LINE_TERMINATORS.test(s.pattern)) {
              throw new TypeError("glob `pattern` must not contain line terminators");
            }
            return s.pattern.replace(GLOB_SHELL_SPECIAL, "\\$&");
          }
          if ("op" in s && typeof s.op === "string") {
            if (OPS.indexOf(s.op) < 0) {
              throw new TypeError("invalid `op` value: " + JSON.stringify(s.op));
            }
            return s.op.replace(/[\s\S]/g, "\\$&");
          }
          if ("comment" in s && typeof s.comment === "string") {
            if (LINE_TERMINATORS.test(s.comment)) {
              throw new TypeError("`comment` must not contain line terminators");
            }
            return "#" + s.comment;
          }
          throw new TypeError("unrecognized object token shape");
        }
        if (/["\s\\]/.test(s) && !/'/.test(s)) {
          return "'" + s.replace(/(['])/g, "\\$1") + "'";
        }
        if (/["'\s]/.test(s)) {
          return '"' + s.replace(/(["\\$`!])/g, "\\$1") + '"';
        }
        return String(s).replace(/([A-Za-z]:)?([#!"$&'()*,:;<=>?@[\\\]^`{|}~])/g, "$1\\$2");
      }).join(" ");
    }, "quote");
  }
});

// node_modules/shell-quote/parse.js
var require_parse = __commonJS({
  "node_modules/shell-quote/parse.js"(exports, module) {
    "use strict";
    init_esbuild_shims();
    var CONTROL = (
      /** @type {const} */
      "(?:" + /** @type {const} */
      [
        "\\|\\|",
        "\\&\\&",
        ";;",
        "\\|\\&",
        "\\<\\(",
        "\\<\\<\\<",
        ">>",
        ">\\&",
        "<\\&",
        "[&;()|<>]"
      ].join(
        /** @type {const} */
        "|"
      ) + /** @type {const} */
      ")"
    );
    var controlRE = new RegExp("^" + CONTROL + "$");
    var META = (
      /** @type {const} */
      "|&;()<> \\t"
    );
    var SINGLE_QUOTE = (
      /** @type {const} */
      '"((\\\\"|[^"])*?)"'
    );
    var DOUBLE_QUOTE = (
      /** @type {const} */
      "'((\\\\'|[^'])*?)'"
    );
    var hash = /^#$/;
    var SQ = (
      /** @type {const} */
      "'"
    );
    var DQ = (
      /** @type {const} */
      '"'
    );
    var DS = (
      /** @type {const} */
      "$"
    );
    var TOKEN = "";
    var mult = (
      /** @type {const} */
      4294967296
    );
    for (i = 0; i < 4; i++) {
      TOKEN += (mult * Math.random()).toString(16);
    }
    var i;
    var startsWithToken = new RegExp("^" + TOKEN);
    function matchAll(s, r) {
      var origIndex = r.lastIndex;
      var matches = [];
      var matchObj;
      while (matchObj = r.exec(s)) {
        matches[matches.length] = matchObj;
        if (r.lastIndex === matchObj.index) {
          r.lastIndex += 1;
        }
      }
      r.lastIndex = origIndex;
      return matches;
    }
    __name(matchAll, "matchAll");
    function getVar(env, pre, key) {
      var r = typeof env === "function" ? env(key) : env[key];
      if (typeof r === "undefined" && key != "") {
        r = "";
      } else if (typeof r === "undefined") {
        r = "$";
      }
      if (typeof r === "object") {
        return pre + TOKEN + JSON.stringify(r) + TOKEN;
      }
      return pre + r;
    }
    __name(getVar, "getVar");
    function parseInternal(string, env, opts) {
      if (!opts) {
        opts = {};
      }
      var BS = opts.escape || "\\";
      var BAREWORD = "(\\" + BS + `['"` + META + `]|[^\\s'"` + META + "])+";
      var chunker = new RegExp([
        "(" + CONTROL + ")",
        // control chars
        "(" + BAREWORD + "|" + SINGLE_QUOTE + "|" + DOUBLE_QUOTE + ")+"
      ].join("|"), "g");
      var matches = matchAll(string, chunker);
      if (matches.length === 0) {
        return [];
      }
      if (!env) {
        env = {};
      }
      var commented = false;
      return matches.map(function(match) {
        var s = match[0];
        if (!s || commented) {
          return void 0;
        }
        if (controlRE.test(s)) {
          return (
            /** @type {ControlOperator} */
            { op: s }
          );
        }
        var quote2 = false;
        var esc = false;
        var out = "";
        var isGlob = false;
        var i2;
        function parseEnvVar() {
          i2 += 1;
          var varend;
          var varname;
          var char = s.charAt(i2);
          if (char === "{") {
            i2 += 1;
            if (s.charAt(i2) === "}") {
              throw new Error("Bad substitution: " + s.slice(i2 - 2, i2 + 1));
            }
            varend = s.indexOf("}", i2);
            if (varend < 0) {
              throw new Error("Bad substitution: " + s.slice(i2));
            }
            varname = s.slice(i2, varend);
            i2 = varend;
          } else if (/[*@#?$!_-]/.test(char)) {
            varname = char;
            i2 += 1;
          } else {
            var slicedFromI = s.slice(i2);
            varend = slicedFromI.match(/[^\w\d_]/);
            if (!varend) {
              varname = slicedFromI;
              i2 = s.length;
            } else {
              varname = slicedFromI.slice(0, varend.index);
              i2 += /** @type {number} */
              varend.index - 1;
            }
          }
          return getVar(
            /** @type {NonNullable<typeof env>} */
            env,
            "",
            varname
          );
        }
        __name(parseEnvVar, "parseEnvVar");
        for (i2 = 0; i2 < s.length; i2++) {
          var c = s.charAt(i2);
          isGlob = isGlob || !quote2 && (c === "*" || c === "?");
          if (esc) {
            out += c;
            esc = false;
          } else if (quote2) {
            if (c === quote2) {
              quote2 = false;
            } else if (quote2 == SQ) {
              out += c;
            } else {
              if (c === BS) {
                i2 += 1;
                c = s.charAt(i2);
                if (c === DQ || c === BS || c === DS) {
                  out += c;
                } else {
                  out += BS + c;
                }
              } else if (c === DS) {
                out += parseEnvVar();
              } else {
                out += c;
              }
            }
          } else if (c === DQ || c === SQ) {
            quote2 = c;
          } else if (controlRE.test(c)) {
            return (
              /** @type {ControlOperator} */
              { op: s }
            );
          } else if (hash.test(c)) {
            commented = true;
            var commentObj = { comment: string.slice(match.index + i2 + 1) };
            if (out.length) {
              return (
                /** @type {const} */
                [out, commentObj]
              );
            }
            return (
              /** @type {const} */
              [commentObj]
            );
          } else if (c === BS) {
            esc = true;
          } else if (c === DS) {
            out += parseEnvVar();
          } else {
            out += c;
          }
        }
        if (isGlob) {
          return (
            /** @type {GlobPattern} */
            { op: "glob", pattern: out }
          );
        }
        return out;
      }).reduce(
        function(prev, arg) {
          if (typeof arg === "undefined") {
            return prev;
          }
          [].concat(arg).forEach(function(entry) {
            prev[prev.length] = entry;
          });
          return prev;
        },
        /** @type {ParseEntry[]} */
        []
      );
    }
    __name(parseInternal, "parseInternal");
    module.exports = /* @__PURE__ */ __name(function parse3(s, env, opts) {
      var mapped = parseInternal(s, env, opts);
      if (typeof env !== "function") {
        return mapped;
      }
      return mapped.reduce(
        function(acc, s2) {
          if (typeof s2 === "object") {
            acc[acc.length] = s2;
            return acc;
          }
          var xs = s2.split(RegExp("(" + TOKEN + ".*?" + TOKEN + ")", "g"));
          if (xs.length === 1) {
            acc[acc.length] = xs[0];
            return acc;
          }
          xs.filter(Boolean).forEach(function(x) {
            acc[acc.length] = startsWithToken.test(x) ? JSON.parse(x.split(TOKEN)[1]) : x;
          });
          return acc;
        },
        /** @type {ParseEntry[]} */
        []
      );
    }, "parse");
  }
});

// node_modules/shell-quote/index.js
var require_shell_quote = __commonJS({
  "node_modules/shell-quote/index.js"(exports) {
    "use strict";
    init_esbuild_shims();
    exports.quote = require_quote();
    exports.parse = require_parse();
  }
});

// packages/core/src/utils/shell-utils.ts
init_esbuild_shims();
var import_shell_quote2 = __toESM(require_shell_quote(), 1);
import os from "node:os";
import path from "node:path";

// packages/core/src/utils/shellReadOnlyChecker.ts
init_esbuild_shims();
var import_shell_quote = __toESM(require_shell_quote(), 1);

// packages/core/src/utils/shell-safety-rules.ts
init_esbuild_shims();
var SED_ADDRESS = /^\s*(?:(?:\d+|\$)(?:\s*,\s*(?:\d+|\$))?|\/(?:\\[\s\S]|[^/\\])*\/)?\s*/;
var SED_ADDRESS_AT = /\s*(?:(?:\d+|\$)(?:\s*,\s*(?:\d+|\$))?|\/(?:\\[\s\S]|[^/\\])*\/)?\s*/y;
var SAFE_SED_COMMAND = /^[dDgGhHlnNpPqQxz=]$/;
var SAFE_SUBSTITUTION_FLAGS = /^[0-9gIpM]*$/;
var SAFE_SED_OPTION = /^(?:-[nElrsuz]|--(?:quiet|silent|line-length(?:=.*)?))$/;
var SED_VALUE_OPTIONS = "-f --file -e --expression -l --line-length".split(
  " "
);
var AWK_STATIC_WRITE = /^\s*(?:print|printf)\b(?!\s*\()(?:(?:"(?:\\[\s\S]|[^"\\])*")|[^">|])*>>?\s*"[^"]*"\s*$/;
var AWK_UNKNOWN_OPERATION = /(?:system|close)\s*\(|getline\b/;
var AWK_PRINT = /\b(?:print|printf)\b/;
function scanDelimitedSection(script, start, delimiter) {
  let escaped = false;
  for (let i = start; i < script.length; i++) {
    const char = script[i];
    if (escaped) {
      escaped = false;
    } else if (char === "\\") {
      escaped = true;
    } else if (char === delimiter) {
      return i + 1;
    }
  }
  return -1;
}
__name(scanDelimitedSection, "scanDelimitedSection");
function classifySingleSedCommandSafety(script) {
  const compatibilityUnknown = /(?:^|[^\\])[ewr]\s/.test(script);
  const commandOffset = SED_ADDRESS.exec(script)?.[0].length ?? 0;
  if (commandOffset === script.length) return "read-only";
  const command = script[commandOffset];
  if (command === "w" || command === "W")
    return script.slice(commandOffset + 1).trim() ? "write" : "unknown";
  if (/[eErR]/.test(command)) return "unknown";
  if (command === "s") {
    const delimiter = script[commandOffset + 1];
    if (!delimiter || delimiter === "\\" || /\s/.test(delimiter))
      return "unknown";
    const replacementStart = scanDelimitedSection(
      script,
      commandOffset + 2,
      delimiter
    );
    if (replacementStart < 0) return "unknown";
    const flagsStart = scanDelimitedSection(
      script,
      replacementStart,
      delimiter
    );
    if (flagsStart < 0) return "unknown";
    const flags = script.slice(flagsStart).trim();
    if (/[;\n{}]/.test(flags)) return "unknown";
    const writeFlag = flags.indexOf("w");
    if (writeFlag >= 0)
      return flags.slice(writeFlag + 1).trim() ? "write" : "unknown";
    if (/[eErRwW]/.test(flags)) return "unknown";
    if (!SAFE_SUBSTITUTION_FLAGS.test(flags)) return "unknown";
    return compatibilityUnknown ? "unknown" : "read-only";
  }
  if (/[;\n{}]/.test(script.slice(commandOffset + 1))) return "unknown";
  if (!SAFE_SED_COMMAND.test(command)) return "unknown";
  return compatibilityUnknown ? "unknown" : "read-only";
}
__name(classifySingleSedCommandSafety, "classifySingleSedCommandSafety");
function nextSedSeparator(script, start) {
  for (let i = start; i < script.length; i++) {
    if (script[i] === ";" || script[i] === "\n") return i;
  }
  return script.length;
}
__name(nextSedSeparator, "nextSedSeparator");
function classifySedScriptSafety(script) {
  let result = "read-only";
  let start = 0;
  while (start < script.length) {
    SED_ADDRESS_AT.lastIndex = start;
    const address = SED_ADDRESS_AT.exec(script);
    if (!address) return "unknown";
    const commandOffset = SED_ADDRESS_AT.lastIndex;
    if (commandOffset === script.length) return result;
    const command = script[commandOffset];
    if (command === "w" || command === "W") {
      const writer = classifySingleSedCommandSafety(script.slice(start));
      return writer === "write" ? "write" : "unknown";
    }
    if (/[eErR]/.test(command)) return "unknown";
    if (command !== "s" && !SAFE_SED_COMMAND.test(command)) return "unknown";
    let separator;
    if (command === "s") {
      const delimiter = script[commandOffset + 1];
      if (!delimiter || delimiter === "\\" || /\s/.test(delimiter))
        return "unknown";
      const replacementStart = scanDelimitedSection(
        script,
        commandOffset + 2,
        delimiter
      );
      if (replacementStart < 0) return "unknown";
      const flagsStart = scanDelimitedSection(
        script,
        replacementStart,
        delimiter
      );
      if (flagsStart < 0) return "unknown";
      separator = nextSedSeparator(script, flagsStart);
    } else {
      separator = nextSedSeparator(script, commandOffset + 1);
    }
    const current = classifySingleSedCommandSafety(
      script.slice(start, separator)
    );
    if (current === "write") return "write";
    if (current === "unknown") result = "unknown";
    if (separator === script.length) return result;
    start = separator + 1;
  }
  return result;
}
__name(classifySedScriptSafety, "classifySedScriptSafety");
function classifySedCommandSafety(args) {
  const terminator = args.indexOf("--");
  const options = args.slice(0, terminator < 0 ? args.length : terminator);
  if (options.some(
    (arg, index) => /^(?:--help|--version)$/i.test(arg) && !SED_VALUE_OPTIONS.includes(options[index - 1])
  ))
    return "unknown";
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") break;
    if (SED_VALUE_OPTIONS.includes(arg)) i++;
    else if (/^-[nErsuz]*e.+/.test(arg)) continue;
    else if (/^(?:-[nErsuz]*[iI]|--in-place(?:=|$))/.test(arg)) return "write";
  }
  const scripts = [];
  const scriptArguments = /* @__PURE__ */ new Set();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      if (scripts.length === 0) {
        const script = args[i + 1];
        if (script === void 0 || script.startsWith("-")) return "unknown";
        scripts.push(script);
        scriptArguments.add(i + 1);
      }
      break;
    }
    if (/^(?:-l|--line-length)$/.test(arg) && !args[++i]) return "unknown";
    if (/^(?:-f|--file(?:=|$))/.test(arg)) return "unknown";
    if (arg === "-e" || arg === "--expression") {
      const script = args[++i];
      if (!script || script.startsWith("-")) return "unknown";
      scripts.push(script);
      scriptArguments.add(i);
    } else if (/^(?:-e.+|--expression=)/.test(arg)) {
      const script = arg.slice(arg.startsWith("-e") ? 2 : 13);
      if (script.startsWith("-")) return "unknown";
      scripts.push(script);
      scriptArguments.add(i);
    } else if (/^--(?!line-length(?:=|$))/.test(arg)) {
      return "unknown";
    } else if (arg.startsWith("-") && !SAFE_SED_OPTION.test(arg)) {
      return "unknown";
    } else if (!arg.startsWith("-") && scripts.length === 0) {
      scripts.push(arg);
      scriptArguments.add(i);
    }
  }
  let result = "read-only";
  for (const script of scripts) {
    const current = classifySedScriptSafety(script);
    if (current === "write") return "write";
    if (current === "unknown") result = "unknown";
  }
  const remainingArgs = args.filter((_, index) => !scriptArguments.has(index));
  return /(?:^|[^\\])[ewr]\s/.test(remainingArgs.join(" ")) ? "unknown" : result;
}
__name(classifySedCommandSafety, "classifySedCommandSafety");
function splitAwkStatements(script) {
  const statements = [];
  let ambiguousSlash = false;
  let unsupportedAt = false;
  let start = 0;
  let escaped = false;
  let inString = false;
  let inRegex = false;
  let previousSignificant = "";
  for (let i = 0; i < script.length; i++) {
    const char = script[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if ((inString || inRegex) && char === "\\") {
      escaped = true;
      continue;
    }
    if (inString) {
      if (char === '"') inString = false;
      continue;
    }
    if (inRegex) {
      if (char === "/") inRegex = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "/" && (!previousSignificant || "({[=,:;!~?&|".includes(previousSignificant))) {
      inRegex = true;
      continue;
    }
    if (char === "/") ambiguousSlash = true;
    if (char === "@") unsupportedAt = true;
    if (char === "#") {
      statements.push(script.slice(start, i));
      const newline = script.indexOf("\n", i + 1);
      if (newline < 0) return { statements, ambiguousSlash, unsupportedAt };
      start = newline + 1;
      i = newline;
      previousSignificant = "\n";
      continue;
    }
    if (/[;{}\n]/.test(char)) {
      statements.push(script.slice(start, i));
      start = i + 1;
      previousSignificant = char;
      continue;
    }
    if (!/\s/.test(char)) previousSignificant = char;
  }
  statements.push(script.slice(start));
  return { statements, ambiguousSlash, unsupportedAt };
}
__name(splitAwkStatements, "splitAwkStatements");
function classifyAwkScriptSafety(script) {
  const { statements, ambiguousSlash, unsupportedAt } = splitAwkStatements(script);
  if (!ambiguousSlash && statements.some((statement) => AWK_STATIC_WRITE.test(statement)))
    return "write";
  if (unsupportedAt || AWK_UNKNOWN_OPERATION.test(script)) return "unknown";
  return AWK_PRINT.test(script) && /[>|]/.test(script) ? "unknown" : "read-only";
}
__name(classifyAwkScriptSafety, "classifyAwkScriptSafety");
function classifyAwkCommandSafety(args) {
  let programIndex = -1;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      programIndex = i + 1;
      break;
    }
    if (arg === "-F" || arg === "-v") {
      if (!args[++i]) return "unknown";
      continue;
    }
    if (/^-[Fv].+/.test(arg)) continue;
    if (arg.startsWith("-")) return "unknown";
    programIndex = i;
    break;
  }
  if (programIndex < 0) return "read-only";
  const program = args[programIndex];
  if (program === void 0) return "unknown";
  const result = classifyAwkScriptSafety(program);
  if (result !== "read-only") return result;
  return classifyAwkScriptSafety(args.join(" ")) === "read-only" ? "read-only" : "unknown";
}
__name(classifyAwkCommandSafety, "classifyAwkCommandSafety");
function hasShellBraceExpansion(text) {
  let braceDepth = 0;
  let previousDot = false;
  for (const char of text) {
    if (char === "{") {
      braceDepth++;
      previousDot = false;
    } else if (char === "}") {
      braceDepth = Math.max(0, braceDepth - 1);
      previousDot = false;
    } else if (braceDepth > 0) {
      if (char === "," || char === "." && previousDot) return true;
      previousDot = char === ".";
    }
  }
  return false;
}
__name(hasShellBraceExpansion, "hasShellBraceExpansion");
function hasShellPatternExpansion(text) {
  return /[[*?]/.test(text) || hasShellBraceExpansion(text);
}
__name(hasShellPatternExpansion, "hasShellPatternExpansion");

// packages/core/src/utils/shellReadOnlyChecker.ts
var READ_ONLY_ROOT_COMMANDS = /* @__PURE__ */ new Set([
  "awk",
  "basename",
  "cat",
  "cd",
  "column",
  "cut",
  "df",
  "dirname",
  "du",
  "echo",
  "find",
  "git",
  "grep",
  "head",
  "ls",
  "printenv",
  "ps",
  "pwd",
  "sed",
  "stat",
  "tail",
  "wc",
  "which",
  "where",
  "whoami"
]);
var BLOCKED_FIND_FLAGS = /* @__PURE__ */ new Set([
  "-delete",
  "-exec",
  "-execdir",
  "-ok",
  "-okdir"
]);
var BLOCKED_FIND_PREFIXES = ["-fls", "-fprint", "-fprintf"];
var READ_ONLY_GIT_SUBCOMMANDS = /* @__PURE__ */ new Set([
  "blame",
  "branch",
  "cat-file",
  "diff",
  "grep",
  "log",
  "ls-files",
  "remote",
  "rev-parse",
  "show",
  "status",
  "describe"
]);
var BLOCKED_GIT_REMOTE_ACTIONS = /* @__PURE__ */ new Set([
  "add",
  "remove",
  "rm",
  "rename",
  "set-branches",
  "set-head",
  "set-url",
  "prune",
  "update"
]);
var GIT_EXTERNAL_HELPER_OPTION = /(?:^--(?:ext-diff|filters|show-signature|textconv|open-files-in-pager)(?:=|$)|%G[?GKFPST])/;
var SAFE_SED_OPTION2 = /^(?:-[nErsuz]|--(?:quiet|silent))$/;
var ENV_ASSIGNMENT_REGEX = /^[A-Za-z_][A-Za-z0-9_]*=/;
var MALFORMED_CONTROL_OPERATOR = /(?:^|[({])\s*(?:&&|\|\||\|&|[|;&])|(?:&&|\|\||\|&|[|;&])\s+(?:&&|\|\||\|&|[|;&])|(?!(?:&&|\|\||\|&))[|;&]{2}|[|;&]{3,}|(?:\|&?|&&|\|\|)\s*[)}]*\s*$/;
function containsWriteRedirection(command) {
  let inSingleQuotes = false;
  let inDoubleQuotes = false;
  let escapeNext = false;
  for (const char of command) {
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (char === "\\" && !inSingleQuotes) {
      escapeNext = true;
      continue;
    }
    if (char === "'" && !inDoubleQuotes) {
      inSingleQuotes = !inSingleQuotes;
      continue;
    }
    if (char === '"' && !inSingleQuotes) {
      inDoubleQuotes = !inDoubleQuotes;
      continue;
    }
    if (!inSingleQuotes && !inDoubleQuotes && char === ">") {
      return true;
    }
  }
  return false;
}
__name(containsWriteRedirection, "containsWriteRedirection");
function normalizeTokens(segment) {
  const parsed = (0, import_shell_quote.parse)(segment, (key) => `\0${key}`);
  const tokens = [];
  for (const token of parsed) {
    if (typeof token === "string") {
      tokens.push(token);
    } else if ("op" in token && token.op === "glob") {
      tokens.push(`\0${token.pattern}`);
    }
  }
  return tokens;
}
__name(normalizeTokens, "normalizeTokens");
function skipEnvironmentAssignments(tokens) {
  let index = 0;
  while (index < tokens.length && ENV_ASSIGNMENT_REGEX.test(tokens[index])) {
    index++;
  }
  if (index >= tokens.length) {
    return { args: [] };
  }
  return {
    root: tokens[index],
    args: tokens.slice(index + 1)
  };
}
__name(skipEnvironmentAssignments, "skipEnvironmentAssignments");
function evaluateFindCommand(tokens) {
  const [, ...rest] = tokens;
  if (rest.at(-1)?.startsWith("-")) return false;
  for (const token of rest) {
    const lower = token.toLowerCase();
    if (BLOCKED_FIND_FLAGS.has(lower)) {
      return false;
    }
    if (BLOCKED_FIND_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
      return false;
    }
  }
  return true;
}
__name(evaluateFindCommand, "evaluateFindCommand");
function evaluateSedCommand(tokens) {
  const [, ...rest] = tokens;
  for (const token of rest) {
    if (["-i", "-I"].some((prefix) => token.startsWith(prefix)) || token === "--in-place" || token.startsWith("--in-place=") || token === "-f" || token === "--file" || token.startsWith("-f") && token.length > 2 || token.startsWith("--file=") || token.startsWith("-") && !SAFE_SED_OPTION2.test(token)) {
      return false;
    }
  }
  return classifySedCommandSafety(rest) === "read-only";
}
__name(evaluateSedCommand, "evaluateSedCommand");
function evaluateAwkCommand(tokens) {
  const [, ...rest] = tokens;
  return classifyAwkCommandSafety(rest) === "read-only";
}
__name(evaluateAwkCommand, "evaluateAwkCommand");
function evaluateGitRemoteArgs(args) {
  const action = args.find((arg) => !arg.startsWith("-"))?.toLowerCase();
  if (action && !["show", "get-url"].includes(action)) return false;
  for (const arg of args) {
    if (BLOCKED_GIT_REMOTE_ACTIONS.has(arg.toLowerCase())) return false;
  }
  return true;
}
__name(evaluateGitRemoteArgs, "evaluateGitRemoteArgs");
function evaluateGitBranchArgs(args) {
  return args.length === 0 || args.length === 1 && args[0] === "--list";
}
__name(evaluateGitBranchArgs, "evaluateGitBranchArgs");
function evaluateGitCommand(tokens) {
  let index = 1;
  while (index < tokens.length && tokens[index].startsWith("-")) {
    const flag = tokens[index++].toLowerCase();
    if (flag === "--version") return true;
    if (flag === "--help") return tokens.length === 2;
    return false;
  }
  if (index >= tokens.length) {
    return true;
  }
  const subcommand = tokens[index].toLowerCase();
  if (!READ_ONLY_GIT_SUBCOMMANDS.has(subcommand)) {
    return false;
  }
  const args = tokens.slice(index + 1);
  const end = args.indexOf("--");
  const options = args.slice(0, end < 0 ? args.length : end);
  if (options.some((arg) => GIT_EXTERNAL_HELPER_OPTION.test(arg)) || subcommand === "grep" && options.some((arg) => arg.startsWith("-O")))
    return false;
  if (options.some((arg) => /^(?:--help|--version)$/i.test(arg))) return false;
  if (subcommand === "remote") {
    return evaluateGitRemoteArgs(args);
  }
  if (subcommand === "branch") {
    return evaluateGitBranchArgs(args);
  }
  if (["blame", "diff", "log", "show"].includes(subcommand)) {
    return !options.some((arg) => /^--output(?:=|$)/.test(arg));
  }
  return true;
}
__name(evaluateGitCommand, "evaluateGitCommand");
function evaluateShellSegment(segment) {
  if (!segment.trim()) {
    return true;
  }
  if (detectCommandSubstitution(segment)) {
    return false;
  }
  const stripped = stripShellWrapper(segment);
  if (!stripped) {
    return true;
  }
  if (stripped !== segment.trim()) return false;
  if (detectCommandSubstitution(stripped)) {
    return false;
  }
  if (containsWriteRedirection(stripped)) {
    return false;
  }
  const tokens = normalizeTokens(stripped);
  if (tokens.length === 0) {
    return true;
  }
  const { root, args } = skipEnvironmentAssignments(tokens);
  if (!root) {
    return true;
  }
  if (root !== tokens[0]) return false;
  const normalizedRoot = root.toLowerCase();
  if (root !== normalizedRoot) return false;
  if (/^(awk|find|git|sed)$/.test(normalizedRoot) && args.some(
    (arg) => !arg || arg.includes("\0") || hasShellBraceExpansion(arg)
  ))
    return false;
  if (!READ_ONLY_ROOT_COMMANDS.has(normalizedRoot)) {
    return false;
  }
  if (normalizedRoot === "find") {
    return evaluateFindCommand([normalizedRoot, ...args]);
  }
  if (normalizedRoot === "sed") {
    return evaluateSedCommand([normalizedRoot, ...args]);
  }
  if (normalizedRoot === "awk") {
    return evaluateAwkCommand([normalizedRoot, ...args]);
  }
  if (normalizedRoot === "git") {
    return evaluateGitCommand([normalizedRoot, ...args]);
  }
  return true;
}
__name(evaluateShellSegment, "evaluateShellSegment");
function isShellCommandReadOnly(command) {
  if (typeof command !== "string" || !command.trim()) {
    return false;
  }
  if (MALFORMED_CONTROL_OPERATOR.test(command)) return false;
  if (/[({;&|]\s*[A-Za-z_][A-Za-z0-9_]*=/.test(command) || /^[A-Za-z_][A-Za-z0-9_]*=.*[;&|]/s.test(command))
    return false;
  const segments = splitCommands(command);
  for (const segment of segments) {
    if (!evaluateShellSegment(segment)) {
      return false;
    }
  }
  return segments.length > 0;
}
__name(isShellCommandReadOnly, "isShellCommandReadOnly");

// packages/core/src/utils/shell-utils.ts
import {
  execFile,
  execFileSync
} from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
var SHELL_TOOL_NAMES = ["run_shell_command", "ShellTool"];
function doesToolInvocationMatch(toolOrToolName, invocation, patterns) {
  let toolNames;
  if (isTool(toolOrToolName)) {
    toolNames = [toolOrToolName.name, toolOrToolName.constructor.name];
  } else {
    toolNames = [toolOrToolName];
  }
  if (toolNames.some((name) => SHELL_TOOL_NAMES.includes(name))) {
    toolNames = [.../* @__PURE__ */ new Set([...toolNames, ...SHELL_TOOL_NAMES])];
  }
  for (const pattern of patterns) {
    const openParen = pattern.indexOf("(");
    if (openParen === -1) {
      if (toolNames.includes(pattern)) {
        return true;
      }
      continue;
    }
    const patternToolName = pattern.substring(0, openParen);
    if (!toolNames.includes(patternToolName)) {
      continue;
    }
    if (!pattern.endsWith(")")) {
      continue;
    }
    const argPattern = pattern.substring(openParen + 1, pattern.length - 1);
    if ("command" in invocation.params && toolNames.includes("run_shell_command")) {
      const argValue = String(
        invocation.params.command
      );
      if (argValue === argPattern || argValue.startsWith(argPattern + " ")) {
        return true;
      }
    }
  }
  return false;
}
__name(doesToolInvocationMatch, "doesToolInvocationMatch");
var cachedBashPath;
var ENV_ASSIGNMENT_REGEX2 = /^[A-Za-z_][A-Za-z0-9_]*=/;
function findGitBashPath() {
  if (cachedBashPath) {
    return cachedBashPath;
  }
  const pathEnv = process.env["PATH"] || "";
  const pathDirs = pathEnv.split(path.delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    const bashPath = path.join(dir, "bash.exe");
    try {
      accessSync(bashPath, fsConstants.X_OK);
      cachedBashPath = bashPath;
      return bashPath;
    } catch {
    }
  }
  const commonPaths = [
    path.join("C:", "Program Files", "Git", "bin", "bash.exe"),
    path.join("C:", "Program Files", "Git", "usr", "bin", "bash.exe"),
    path.join("C:", "Program Files (x86)", "Git", "bin", "bash.exe"),
    path.join("C:", "Program Files (x86)", "Git", "usr", "bin", "bash.exe"),
    path.join(
      process.env["ProgramFiles"] || path.join("C:", "Program Files"),
      "Git",
      "bin",
      "bash.exe"
    ),
    path.join(
      process.env["ProgramFiles(x86)"] || path.join("C:", "Program Files (x86)"),
      "Git",
      "bin",
      "bash.exe"
    )
  ];
  for (const bashPath of commonPaths) {
    try {
      accessSync(bashPath, fsConstants.X_OK);
      cachedBashPath = bashPath;
      return bashPath;
    } catch {
    }
  }
  cachedBashPath = "bash";
  return "bash";
}
__name(findGitBashPath, "findGitBashPath");
function getShellConfiguration() {
  if (isWindows()) {
    const msystem = process.env["MSYSTEM"];
    const term = process.env["TERM"] || "";
    const isGitBash = msystem?.startsWith("MINGW") || msystem?.startsWith("MSYS") || term.includes("msys") || term.includes("cygwin");
    if (isGitBash) {
      return {
        executable: findGitBashPath(),
        argsPrefix: ["-c"],
        shell: "bash"
      };
    }
    const comSpec = process.env["ComSpec"] || "cmd.exe";
    const executable = comSpec.toLowerCase();
    if (executable.endsWith("powershell.exe") || executable.endsWith("pwsh.exe")) {
      return {
        executable: comSpec,
        argsPrefix: ["-NoProfile", "-Command"],
        shell: "powershell"
      };
    }
    return {
      executable: comSpec,
      argsPrefix: ["/d", "/s", "/c"],
      shell: "cmd"
    };
  }
  return { executable: "bash", argsPrefix: ["-c"], shell: "bash" };
}
__name(getShellConfiguration, "getShellConfiguration");
var isWindows = /* @__PURE__ */ __name(() => os.platform() === "win32", "isWindows");
function escapeShellArg(arg, shell) {
  if (!arg) {
    return "";
  }
  switch (shell) {
    case "powershell":
      return `'${arg.replace(/'/g, "''")}'`;
    case "cmd":
      return `"${arg.replace(/"/g, '""')}"`;
    case "bash":
    default:
      return (0, import_shell_quote2.quote)([arg]);
  }
}
__name(escapeShellArg, "escapeShellArg");
function splitCommands(command) {
  const commands = [];
  let currentCommand = "";
  let inSingleQuotes = false;
  let inDoubleQuotes = false;
  let inBackticks = false;
  let substitutionDepth = 0;
  const quoteStack = [];
  let i = 0;
  const previousNonWhitespaceChar = /* @__PURE__ */ __name((index) => {
    for (let j = index - 1; j >= 0; j--) {
      const ch = command[j];
      if (ch && !/\s/.test(ch)) {
        return ch;
      }
    }
    return void 0;
  }, "previousNonWhitespaceChar");
  while (i < command.length) {
    const char = command[i];
    const nextChar = command[i + 1];
    if (!inSingleQuotes && char === "\\" && nextChar === "\n") {
      i += 2;
      continue;
    }
    if (!inSingleQuotes && char === "\\" && i < command.length - 1) {
      currentCommand += char + command[i + 1];
      i += 2;
      continue;
    }
    if (!inSingleQuotes && char === "`") {
      inBackticks = !inBackticks;
    } else if (!inSingleQuotes && !inBackticks && char === "$" && nextChar === "(") {
      quoteStack.push({ single: inSingleQuotes, double: inDoubleQuotes });
      inSingleQuotes = false;
      inDoubleQuotes = false;
      substitutionDepth++;
      currentCommand += "$(";
      i += 2;
      continue;
    } else if (!inBackticks && substitutionDepth > 0 && char === ")" && !inSingleQuotes && !inDoubleQuotes) {
      const enclosing = quoteStack.pop();
      inSingleQuotes = enclosing?.single ?? false;
      inDoubleQuotes = enclosing?.double ?? false;
      substitutionDepth--;
    } else if (!inBackticks && char === "'" && !inDoubleQuotes) {
      inSingleQuotes = !inSingleQuotes;
    } else if (!inBackticks && char === '"' && !inSingleQuotes) {
      inDoubleQuotes = !inDoubleQuotes;
    }
    if (!inSingleQuotes && !inDoubleQuotes && !inBackticks && substitutionDepth === 0) {
      if (char === "&" && nextChar === "&" || char === "|" && (nextChar === "|" || nextChar === "&")) {
        commands.push(currentCommand.trim());
        currentCommand = "";
        i++;
      } else if (char === ";") {
        commands.push(currentCommand.trim());
        currentCommand = "";
      } else if (char === "&") {
        const prevChar = previousNonWhitespaceChar(i);
        if (prevChar === ">" || prevChar === "<") {
          currentCommand += char;
        } else {
          commands.push(currentCommand.trim());
          currentCommand = "";
        }
      } else if (char === "|") {
        const prevChar = previousNonWhitespaceChar(i);
        if (prevChar === ">") {
          currentCommand += char;
        } else {
          commands.push(currentCommand.trim());
          currentCommand = "";
        }
      } else if (char === "\r" && nextChar === "\n") {
        commands.push(currentCommand.trim());
        currentCommand = "";
        i++;
      } else if (char === "\n") {
        commands.push(currentCommand.trim());
        currentCommand = "";
      } else {
        currentCommand += char;
      }
    } else {
      currentCommand += char;
    }
    i++;
  }
  if (currentCommand.trim()) {
    commands.push(currentCommand.trim());
  }
  return commands.filter(Boolean);
}
__name(splitCommands, "splitCommands");
var PARAMETER_EXPANSION_COMMAND = /^("?)\$(?:\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?-)([^}]*))?\}|([A-Za-z_][A-Za-z0-9_]*))\1$/;
function resolveLeadingParameterExpansion(command) {
  let rest = command;
  while (true) {
    const t = takeLeadingToken(rest);
    if (!t || !isEnvAssignmentToken(t.token)) break;
    rest = t.rest;
  }
  const head = takeLeadingToken(rest);
  if (!head) return void 0;
  const m = PARAMETER_EXPANSION_COMMAND.exec(head.token);
  if (!m) return void 0;
  const quoted = m[1] === '"';
  const name = m[2] ?? m[5];
  const op = m[3];
  const value = process.env[name];
  const useDefault = op === void 0 ? false : op === ":-" ? !value : value === void 0;
  const resolved = useDefault ? stripSymmetricQuotes(m[4] ?? "").value : value ?? "";
  if (quoted) {
    return resolved || void 0;
  }
  const fields = resolved.split(/[ \t\n]+/).filter(Boolean);
  if (fields.length === 0) {
    const next = head.rest.trim();
    return next ? getCommandRoot(next) : void 0;
  }
  return fields[0];
}
__name(resolveLeadingParameterExpansion, "resolveLeadingParameterExpansion");
function getCommandRoot(command) {
  const trimmedCommand = command.trim();
  if (!trimmedCommand) {
    return void 0;
  }
  const expanded = resolveLeadingParameterExpansion(trimmedCommand);
  if (expanded !== void 0) {
    return expanded.split(/[\\/]/).pop();
  }
  try {
    const tokens = (0, import_shell_quote2.parse)(trimmedCommand).filter(
      (token) => typeof token === "string"
    );
    let idx = 0;
    while (idx < tokens.length && ENV_ASSIGNMENT_REGEX2.test(tokens[idx])) {
      idx++;
    }
    const firstToken = tokens[idx];
    return firstToken ? firstToken.split(/[\\/]/).pop() : void 0;
  } catch {
    const match = trimmedCommand.match(/^"([^"]+)"|^'([^']+)'|^(\S+)/);
    if (match) {
      const commandRoot = match[1] || match[2] || match[3];
      if (commandRoot) {
        return commandRoot.split(/[\\/]/).pop();
      }
    }
    return void 0;
  }
}
__name(getCommandRoot, "getCommandRoot");
function getCommandRoots(command) {
  if (!command) {
    return [];
  }
  return splitCommands(command).map((c) => getCommandRoot(c)).filter((c) => !!c);
}
__name(getCommandRoots, "getCommandRoots");
function stripShellWrapper(command) {
  const trimmed = command.trim();
  let rest = trimmed;
  while (true) {
    const token = takeLeadingToken(rest);
    if (!token || !isEnvAssignmentToken(token.token)) break;
    rest = token.rest;
  }
  const wrapperToken = takeLeadingToken(rest);
  if (!wrapperToken || !isKnownMonitorWrapperToken(wrapperToken.token)) {
    return trimmed;
  }
  rest = wrapperToken.rest;
  while (true) {
    const token = takeLeadingToken(rest);
    if (!token) return trimmed;
    if (isMonitorCommandMarker(wrapperToken.token, token.token)) {
      const commandToken = takeLeadingToken(token.rest);
      if (!commandToken) return trimmed;
      const { value: innerCommand, quote: quote2 } = stripSymmetricQuotes(
        commandToken.token
      );
      if (!quote2 && shellWrapperCommandConsumesRest(wrapperToken.token)) {
        return token.rest.trimStart() || trimmed;
      }
      return innerCommand || trimmed;
    }
    const normalized = getNormalizedShellToken(token.token);
    if (!isShellWrapperFlagToken(normalized)) {
      return trimmed;
    }
    rest = token.rest;
    if (shellWrapperFlagConsumesOperand(token.token)) {
      const operandToken = takeLeadingToken(rest);
      if (!operandToken) return trimmed;
      rest = operandToken.rest;
    }
  }
}
__name(stripShellWrapper, "stripShellWrapper");
var SELF_KILL_PROCESS_PATTERN = /(^|[^a-z0-9_-])(node(?:\.exe)?|qwen(?:-code)?(?:\.exe)?)(?=$|[^a-z0-9_-])/i;
var QWEN_PROCESS_PATTERN = /(^|[^a-z0-9_-])qwen(?:-code)?(?:\.exe)?(?=$|[^a-z0-9_-])/i;
var TASKKILL_IMAGE_FILTER_PATTERN = /\bimagename\s+eq\s+(.+)$/i;
var SUDO_OPTIONS_WITH_VALUES = /* @__PURE__ */ new Set([
  "-u",
  "--user",
  "-g",
  "--group",
  "-h",
  "--host",
  "-p",
  "--prompt",
  "-C",
  "--close-from",
  "-T",
  "--command-timeout"
]);
var COMMAND_OPTIONS_WITH_VALUES = /* @__PURE__ */ new Set();
var ENV_OPTIONS_WITH_VALUES = /* @__PURE__ */ new Set([
  "-u",
  "--unset",
  "-S",
  "--split-string",
  "-C",
  "--chdir"
]);
var KILLALL_OPTIONS_WITH_VALUES = /* @__PURE__ */ new Set([
  "-n",
  "--ns",
  "-o",
  "--older-than",
  "-s",
  "--signal",
  "-t",
  "--tty",
  "-u",
  "--user",
  "-y",
  "--younger-than",
  "-Z",
  "--context"
]);
var PKILL_OPTIONS_WITH_VALUES = /* @__PURE__ */ new Set([
  "-F",
  "--pidfile",
  "-G",
  "--group",
  "-g",
  "--pgroup",
  "-P",
  "--parent",
  "-s",
  "--session",
  "-t",
  "--terminal",
  "-T",
  "--thread",
  "-U",
  "--uid",
  "-u",
  "--euid"
]);
var XARGS_OPTIONS_WITH_VALUES = /* @__PURE__ */ new Set([
  "-I",
  "-n",
  "-P",
  "-s",
  "-E",
  "-d",
  "-L",
  "-l",
  "-a",
  "-J",
  "-R",
  "--replace",
  "--max-args",
  "--max-procs",
  "--max-chars",
  "--eof",
  "--delimiter",
  "--max-lines",
  "--arg-file"
]);
var SHELL_SELF_KILL_REJECTION = "Blocked: this command may terminate the running qwen-code process because it targets all node/qwen-code processes. Use task_stop for managed background shells, or kill a specific PID instead.";
function parseShellSegment(segment) {
  try {
    return (0, import_shell_quote2.parse)(segment, (key) => "$" + key).map((token) => {
      if (typeof token === "string") {
        return token;
      }
      if (typeof token === "object" && token !== null && "pattern" in token && typeof token.pattern === "string") {
        return token.pattern;
      }
      return null;
    }).filter((token) => token !== null);
  } catch {
    return null;
  }
}
__name(parseShellSegment, "parseShellSegment");
function normalizeExecutableName(token) {
  const executable = token.split(/[\\/]/).pop() ?? token;
  return executable.toLowerCase().replace(/\.exe$/, "");
}
__name(normalizeExecutableName, "normalizeExecutableName");
function isOptionToken(token) {
  return token.startsWith("-");
}
__name(isOptionToken, "isOptionToken");
function optionKey(token) {
  return token.startsWith("--") ? token.toLowerCase() : token;
}
__name(optionKey, "optionKey");
function optionHasInlineValue(token) {
  return token.includes("=") || token.includes(":");
}
__name(optionHasInlineValue, "optionHasInlineValue");
function shortOptionBundleHasFlag(token, flag) {
  return token.startsWith("-") && !token.startsWith("--") && token.length > 2 && token.slice(1).toLowerCase().includes(flag.toLowerCase().slice(1));
}
__name(shortOptionBundleHasFlag, "shortOptionBundleHasFlag");
function matchesSelfProcessPattern(value) {
  return SELF_KILL_PROCESS_PATTERN.test(value);
}
__name(matchesSelfProcessPattern, "matchesSelfProcessPattern");
function matchesQwenProcessPattern(value) {
  return QWEN_PROCESS_PATTERN.test(value);
}
__name(matchesQwenProcessPattern, "matchesQwenProcessPattern");
function isBroadNodeFullPattern(value) {
  const normalized = value.trim().replace(/^(\^|\\b|\.\*)+/, "").replace(/(\$|\\b|\.\*)+$/, "");
  const base = normalized.split(/[\\/]/).pop()?.toLowerCase();
  return base === "node" || base === "node.exe" || /^node(?:\.exe)?[*?]+$/.test(base ?? "");
}
__name(isBroadNodeFullPattern, "isBroadNodeFullPattern");
function consumeOptionsWithValues(tokens, startIndex, optionsWithValues) {
  let index = startIndex;
  while (index < tokens.length) {
    const token = tokens[index];
    const normalized = optionKey(token);
    if (!isOptionToken(token)) {
      break;
    }
    index++;
    if ((optionsWithValues.has(normalized) || [...optionsWithValues].some(
      (option) => shortOptionBundleHasFlag(token, option)
    )) && !optionHasInlineValue(token)) {
      index++;
    }
  }
  return index;
}
__name(consumeOptionsWithValues, "consumeOptionsWithValues");
function unwrapExecutionPrefixes(tokens) {
  let index = 0;
  while (index < tokens.length && ENV_ASSIGNMENT_REGEX2.test(tokens[index])) {
    index++;
  }
  while (index < tokens.length) {
    const root = normalizeExecutableName(tokens[index]);
    if (root === "sudo") {
      index = consumeOptionsWithValues(
        tokens,
        index + 1,
        SUDO_OPTIONS_WITH_VALUES
      );
      continue;
    }
    if (root === "command") {
      index = consumeOptionsWithValues(
        tokens,
        index + 1,
        COMMAND_OPTIONS_WITH_VALUES
      );
      continue;
    }
    if (root === "env") {
      index = consumeOptionsWithValues(
        tokens,
        index + 1,
        ENV_OPTIONS_WITH_VALUES
      );
      while (index < tokens.length && ENV_ASSIGNMENT_REGEX2.test(tokens[index])) {
        index++;
      }
      continue;
    }
    break;
  }
  return tokens.slice(index);
}
__name(unwrapExecutionPrefixes, "unwrapExecutionPrefixes");
function getCommandSegments(command, depth = 0) {
  const segments = [];
  for (const segment of splitCommands(command)) {
    const stripped = stripShellWrapper(segment);
    if (stripped !== segment && depth < 3) {
      segments.push(...getCommandSegments(stripped, depth + 1));
    } else if (stripped !== segment) {
      segments.push(stripped);
    } else {
      segments.push(segment);
    }
  }
  return segments;
}
__name(getCommandSegments, "getCommandSegments");
function commandArguments(tokens, optionsWithValues) {
  const args = [];
  for (let index = 1; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === "--") {
      args.push(...tokens.slice(index + 1));
      break;
    }
    const normalized = optionKey(token);
    if (isOptionToken(token)) {
      if (optionsWithValues.has(normalized) && !optionHasInlineValue(token)) {
        index++;
      }
      continue;
    }
    args.push(token);
  }
  return args;
}
__name(commandArguments, "commandArguments");
function taskkillTargetsSelf(tokens) {
  for (let index = 1; index < tokens.length; index++) {
    const token = tokens[index];
    const normalized = token.toLowerCase();
    if (normalized === "/im" || normalized === "-im") {
      const imageName = tokens[index + 1];
      if (imageName && matchesSelfProcessPattern(imageName)) {
        return true;
      }
      index++;
      continue;
    }
    if (normalized.startsWith("/im:") || normalized.startsWith("-im:")) {
      if (matchesSelfProcessPattern(token.slice(4))) {
        return true;
      }
      continue;
    }
    if (normalized === "/fi" || normalized === "-fi") {
      const filter = tokens[index + 1];
      const imageName = filter?.match(TASKKILL_IMAGE_FILTER_PATTERN)?.[1];
      if (imageName && matchesSelfProcessPattern(imageName)) {
        return true;
      }
      index++;
      continue;
    }
    if (normalized.startsWith("/fi:") || normalized.startsWith("-fi:")) {
      const imageName = token.slice(4).match(TASKKILL_IMAGE_FILTER_PATTERN)?.[1];
      if (imageName && matchesSelfProcessPattern(imageName)) {
        return true;
      }
    }
  }
  return false;
}
__name(taskkillTargetsSelf, "taskkillTargetsSelf");
function killallTargetsSelf(tokens) {
  return commandArguments(tokens, KILLALL_OPTIONS_WITH_VALUES).some(
    (arg) => matchesSelfProcessPattern(arg)
  );
}
__name(killallTargetsSelf, "killallTargetsSelf");
function pkillTargetsSelf(tokens) {
  let usesFullCommandLine = false;
  const args = [];
  for (let index = 1; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === "--") {
      args.push(...tokens.slice(index + 1));
      break;
    }
    const normalized = optionKey(token);
    if (normalized === "-f" || normalized === "--full" || shortOptionBundleHasFlag(token, "-f")) {
      usesFullCommandLine = true;
      continue;
    }
    if (isOptionToken(token)) {
      if (PKILL_OPTIONS_WITH_VALUES.has(normalized) && !optionHasInlineValue(token)) {
        index++;
      }
      continue;
    }
    args.push(token);
  }
  if (usesFullCommandLine) {
    return args.some(
      (arg) => matchesQwenProcessPattern(arg) || isBroadNodeFullPattern(arg)
    );
  }
  return args.some((arg) => matchesSelfProcessPattern(arg));
}
__name(pkillTargetsSelf, "pkillTargetsSelf");
function pgrepTargetsSelf(tokens) {
  return pkillTargetsSelf(["pkill", ...tokens.slice(1)]);
}
__name(pgrepTargetsSelf, "pgrepTargetsSelf");
function pgrepSubstitutionArgs(segment) {
  let quote2 = "";
  let escaped = false;
  const args = [];
  for (let index = 0; index < segment.length; index++) {
    const char = segment[index];
    if (quote2 === "'") {
      if (char === "'") quote2 = "";
      continue;
    }
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      quote2 = quote2 === '"' ? "" : '"';
      continue;
    }
    if (char === "'" && quote2 === "") {
      quote2 = "'";
      continue;
    }
    if (char === "`") {
      let end2 = index + 1;
      let innerEscaped = false;
      for (; end2 < segment.length; end2++) {
        const innerChar = segment[end2];
        if (innerEscaped) {
          innerEscaped = false;
          continue;
        }
        if (innerChar === "\\") {
          innerEscaped = true;
          continue;
        }
        if (innerChar === "`") break;
      }
      if (end2 >= segment.length) {
        break;
      }
      const inner2 = segment.slice(index + 1, end2).trim();
      const match2 = inner2.match(/^pgrep\b(.*)$/i);
      if (match2) {
        args.push(match2[1] ?? "");
      }
      index = end2;
      continue;
    }
    if (char !== "$" || segment[index + 1] !== "(") {
      continue;
    }
    const end = segment.indexOf(")", index + 2);
    if (end === -1) {
      break;
    }
    const inner = segment.slice(index + 2, end).trim();
    const match = inner.match(/^pgrep\b(.*)$/i);
    if (match) {
      args.push(match[1] ?? "");
    }
    index = end;
  }
  return args;
}
__name(pgrepSubstitutionArgs, "pgrepSubstitutionArgs");
function killCommandTargetsSelf(segment) {
  return pgrepSubstitutionArgs(segment).some((args) => {
    const parsed = parseShellSegment(`pgrep ${args}`);
    return parsed !== null && pgrepTargetsSelf(parsed);
  });
}
__name(killCommandTargetsSelf, "killCommandTargetsSelf");
function xargsInvokesKill(segment) {
  if (!segment) {
    return false;
  }
  const parsed = parseShellSegment(segment);
  if (!parsed) {
    return false;
  }
  const tokens = unwrapExecutionPrefixes(parsed);
  if (normalizeExecutableName(tokens[0] ?? "") !== "xargs") {
    return false;
  }
  const commandTokens = unwrapExecutionPrefixes(
    commandArguments(tokens, XARGS_OPTIONS_WITH_VALUES)
  );
  const command = commandTokens.find((token) => !isOptionToken(token));
  return normalizeExecutableName(command ?? "") === "kill";
}
__name(xargsInvokesKill, "xargsInvokesKill");
function detectSelfKillCommand(command) {
  if (!/kill/i.test(command)) {
    return false;
  }
  const segments = getCommandSegments(command);
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    const parsed = parseShellSegment(segment);
    if (!parsed) {
      continue;
    }
    const tokens = unwrapExecutionPrefixes(parsed);
    if (tokens.length === 0) {
      continue;
    }
    const root = normalizeExecutableName(tokens[0]);
    if (root === "taskkill" && taskkillTargetsSelf(tokens)) {
      return true;
    }
    if (root === "killall" && killallTargetsSelf(tokens)) {
      return true;
    }
    if (root === "pkill" && pkillTargetsSelf(tokens)) {
      return true;
    }
    if (root === "kill" && killCommandTargetsSelf(segment)) {
      return true;
    }
    if (root === "pgrep" && pgrepTargetsSelf(tokens)) {
      for (let j = index + 1; j < segments.length; j++) {
        if (xargsInvokesKill(segments[j])) {
          return true;
        }
      }
    }
  }
  return false;
}
__name(detectSelfKillCommand, "detectSelfKillCommand");
function stripTrailingBackgroundAmp(command) {
  const trimmed = command.trimEnd();
  if (!trimmed.endsWith("&")) return command;
  if (trimmed.endsWith("&&")) return command;
  if (trimmed.endsWith("\\&")) return command;
  return trimmed.slice(0, -1).trimEnd();
}
__name(stripTrailingBackgroundAmp, "stripTrailingBackgroundAmp");
function hasNonFinalTopLevelBackgroundOperator(command) {
  let quote2 = "";
  let escaped = false;
  let inBackticks = false;
  let commandSubstitutionDepth = 0;
  const previousNonWhitespace = /* @__PURE__ */ __name((index) => {
    for (let i = index - 1; i >= 0; i--) {
      const char = command[i];
      if (char !== void 0 && !/\s/.test(char)) return char;
    }
    return void 0;
  }, "previousNonWhitespace");
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (quote2 === "'") {
      if (char === "'") quote2 = "";
      continue;
    }
    if (quote2 === '"') {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        quote2 = "";
      }
      continue;
    }
    if (inBackticks) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "`") {
        inBackticks = false;
      }
      continue;
    }
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"' || char === "'") {
      quote2 = char;
      continue;
    }
    if (char === "`") {
      inBackticks = true;
      continue;
    }
    if ((char === "$" || char === "<" || char === ">") && command[i + 1] === "(") {
      commandSubstitutionDepth++;
      i++;
      continue;
    }
    if (char === ")" && commandSubstitutionDepth > 0) {
      commandSubstitutionDepth--;
      continue;
    }
    if (char !== "&" || commandSubstitutionDepth > 0) {
      continue;
    }
    const next = command[i + 1];
    const previous = previousNonWhitespace(i);
    if (next === "&" || next === ">" || previous === "&" || previous === ">" || previous === "<" || previous === "|") {
      continue;
    }
    return command.slice(i + 1).trim().length > 0;
  }
  return false;
}
__name(hasNonFinalTopLevelBackgroundOperator, "hasNonFinalTopLevelBackgroundOperator");
function takeLeadingToken(input) {
  const trimmed = input.trimStart();
  if (!trimmed) {
    return null;
  }
  let quote2 = "";
  let escaped = false;
  let inBackticks = false;
  let commandSubstitutionDepth = 0;
  let idx = 0;
  while (idx < trimmed.length) {
    const char = trimmed[idx];
    if (!char) {
      break;
    }
    if (quote2 === "'") {
      if (char === "'") {
        quote2 = "";
      }
      idx++;
      continue;
    }
    if (quote2 === '"') {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        quote2 = "";
      }
      idx++;
      continue;
    }
    if (inBackticks) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "`") {
        inBackticks = false;
      }
      idx++;
      continue;
    }
    if (escaped) {
      escaped = false;
      idx++;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      idx++;
      continue;
    }
    if (char === '"' || char === "'") {
      quote2 = char;
      idx++;
      continue;
    }
    if (char === "`") {
      inBackticks = true;
      idx++;
      continue;
    }
    if ((char === "$" || char === "<" || char === ">") && trimmed[idx + 1] === "(") {
      commandSubstitutionDepth++;
      idx += 2;
      continue;
    }
    if (char === ")" && commandSubstitutionDepth > 0) {
      commandSubstitutionDepth--;
      idx++;
      continue;
    }
    if (/\s/.test(char) && commandSubstitutionDepth === 0) {
      break;
    }
    idx++;
  }
  if (idx === 0 || quote2 || escaped || inBackticks || commandSubstitutionDepth) {
    return null;
  }
  return {
    token: trimmed.slice(0, idx),
    rest: trimmed.slice(idx)
  };
}
__name(takeLeadingToken, "takeLeadingToken");
function stripSymmetricQuotes(command) {
  const trimmed = command.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') || trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return {
      value: trimmed.substring(1, trimmed.length - 1),
      quote: trimmed[0]
    };
  }
  return { value: trimmed, quote: "" };
}
__name(stripSymmetricQuotes, "stripSymmetricQuotes");
function getNormalizedShellToken(token) {
  return stripSymmetricQuotes(token).value.replace(/\\/g, "/").toLowerCase();
}
__name(getNormalizedShellToken, "getNormalizedShellToken");
function isEnvAssignmentToken(token) {
  return ENV_ASSIGNMENT_REGEX2.test(stripSymmetricQuotes(token).value);
}
__name(isEnvAssignmentToken, "isEnvAssignmentToken");
function getShellWrapperBase(token) {
  return getNormalizedShellToken(token).split("/").pop();
}
__name(getShellWrapperBase, "getShellWrapperBase");
function isKnownMonitorWrapperToken(token) {
  const base = getShellWrapperBase(token);
  return base === "sh" || base === "sh.exe" || base === "bash" || base === "bash.exe" || base === "zsh" || base === "zsh.exe" || base === "cmd" || base === "cmd.exe" || base === "powershell" || base === "powershell.exe" || base === "pwsh" || base === "pwsh.exe";
}
__name(isKnownMonitorWrapperToken, "isKnownMonitorWrapperToken");
function isShellWrapperFlagToken(normalizedToken) {
  return normalizedToken.startsWith("-") || normalizedToken.startsWith("/") || normalizedToken === "+o";
}
__name(isShellWrapperFlagToken, "isShellWrapperFlagToken");
function shellWrapperFlagConsumesOperand(token) {
  const normalized = getNormalizedShellToken(token);
  if (optionHasInlineValue(token)) {
    return false;
  }
  return normalized === "-o" || normalized === "+o" || normalized === "-executionpolicy" || normalized === "-file" || normalized === "-encodedcommand";
}
__name(shellWrapperFlagConsumesOperand, "shellWrapperFlagConsumesOperand");
function shellWrapperCommandConsumesRest(wrapperToken) {
  const base = getShellWrapperBase(wrapperToken);
  return base === "cmd" || base === "cmd.exe" || base === "powershell" || base === "powershell.exe" || base === "pwsh" || base === "pwsh.exe";
}
__name(shellWrapperCommandConsumesRest, "shellWrapperCommandConsumesRest");
function isMonitorCommandMarker(wrapperToken, token) {
  const base = getShellWrapperBase(wrapperToken);
  const normalized = getNormalizedShellToken(token);
  if (base === "cmd" || base === "cmd.exe") {
    return normalized === "/c";
  }
  if (base === "powershell" || base === "powershell.exe" || base === "pwsh" || base === "pwsh.exe") {
    return normalized === "-command" || normalized === "-c";
  }
  return normalized === "-c" || /^-[a-z]*c[a-z]*$/i.test(normalized);
}
__name(isMonitorCommandMarker, "isMonitorCommandMarker");
function parseMonitorShellWrapper(command) {
  const trimmed = command.trim();
  let rest = trimmed;
  const leadingEnvTokens = [];
  while (true) {
    const token = takeLeadingToken(rest);
    if (!token || !isEnvAssignmentToken(token.token)) {
      break;
    }
    leadingEnvTokens.push(token.token);
    rest = token.rest;
  }
  const wrapperToken = takeLeadingToken(rest);
  if (!wrapperToken || !isKnownMonitorWrapperToken(wrapperToken.token)) {
    return {
      innerCommand: trimmed,
      innerQuote: ""
    };
  }
  rest = wrapperToken.rest;
  const wrapperTokens = [...leadingEnvTokens, wrapperToken.token];
  while (true) {
    const token = takeLeadingToken(rest);
    if (!token) {
      return {
        innerCommand: trimmed,
        innerQuote: ""
      };
    }
    if (isMonitorCommandMarker(wrapperToken.token, token.token)) {
      wrapperTokens.push(token.token);
      const commandToken = takeLeadingToken(token.rest);
      if (!commandToken) {
        return {
          innerCommand: trimmed,
          innerQuote: ""
        };
      }
      const { value: innerCommand, quote: innerQuote } = stripSymmetricQuotes(
        commandToken.token
      );
      return {
        wrapperTokens,
        innerCommand,
        innerQuote,
        innerArgsSuffix: commandToken.rest.trimStart()
      };
    }
    const normalized = getNormalizedShellToken(token.token);
    if (!isShellWrapperFlagToken(normalized)) {
      return {
        innerCommand: trimmed,
        innerQuote: ""
      };
    }
    wrapperTokens.push(token.token);
    rest = token.rest;
    if (shellWrapperFlagConsumesOperand(token.token)) {
      const operandToken = takeLeadingToken(rest);
      if (!operandToken) {
        return {
          innerCommand: trimmed,
          innerQuote: ""
        };
      }
      wrapperTokens.push(operandToken.token);
      rest = operandToken.rest;
    }
  }
}
__name(parseMonitorShellWrapper, "parseMonitorShellWrapper");
function normalizeMonitorCommand(command) {
  const { wrapperTokens, innerCommand, innerQuote, innerArgsSuffix } = parseMonitorShellWrapper(command);
  const leadingEnvTokens = wrapperTokens?.filter((token) => isEnvAssignmentToken(token)) ?? [];
  const analysisCommand = stripTrailingBackgroundAmp(innerCommand);
  const rawInnerArgsSuffix = innerArgsSuffix?.trim() ?? "";
  const normalizedInnerArgsSuffix = stripTrailingBackgroundAmp(rawInnerArgsSuffix);
  const safetyParts = [
    ...wrapperTokens ? leadingEnvTokens : [],
    analysisCommand,
    ...normalizedInnerArgsSuffix ? [normalizedInnerArgsSuffix] : []
  ];
  const safetyCommand = wrapperTokens && safetyParts.length > 0 ? safetyParts.join(" ").trim() : analysisCommand;
  const strippedTrailingAmp = analysisCommand !== innerCommand || normalizedInnerArgsSuffix !== rawInnerArgsSuffix;
  const spawnCommand = wrapperTokens ? [
    wrapperTokens.join(" "),
    innerQuote ? `${innerQuote}${analysisCommand}${innerQuote}` : analysisCommand,
    normalizedInnerArgsSuffix
  ].filter(Boolean).join(" ") : analysisCommand;
  return {
    analysisCommand,
    safetyCommand,
    spawnCommand,
    strippedTrailingAmp
  };
}
__name(normalizeMonitorCommand, "normalizeMonitorCommand");
function hasUnsafeMonitorBackgroundOperator(command) {
  const { innerCommand, innerArgsSuffix } = parseMonitorShellWrapper(command);
  return hasNonFinalTopLevelBackgroundOperator(innerCommand) || hasNonFinalTopLevelBackgroundOperator(innerArgsSuffix ?? "");
}
__name(hasUnsafeMonitorBackgroundOperator, "hasUnsafeMonitorBackgroundOperator");
function detectCommandSubstitution(command) {
  const isCommentStart = /* @__PURE__ */ __name((index) => {
    if (command[index] !== "#") return false;
    if (index === 0) return true;
    const prev = command[index - 1];
    if (prev === " " || prev === "	" || prev === "\n" || prev === "\r") {
      return true;
    }
    return [";", "&", "|", "(", ")", "<", ">"].includes(prev);
  }, "isCommentStart");
  const isWordBoundary = /* @__PURE__ */ __name((char) => {
    if (char === " " || char === "	" || char === "\n" || char === "\r") {
      return true;
    }
    return [";", "&", "|", "<", ">", "(", ")"].includes(char);
  }, "isWordBoundary");
  const parseHeredocOperator = /* @__PURE__ */ __name((startIndex) => {
    if (command[startIndex] !== "<" || command[startIndex + 1] !== "<") {
      return null;
    }
    let i2 = startIndex + 2;
    const stripLeadingTabs = command[i2] === "-";
    if (stripLeadingTabs) i2++;
    while (i2 < command.length && (command[i2] === " " || command[i2] === "	")) {
      i2++;
    }
    let delimiter = "";
    let isQuotedDelimiter = false;
    let inSingleQuotes2 = false;
    let inDoubleQuotes2 = false;
    while (i2 < command.length) {
      const char = command[i2];
      if (!inSingleQuotes2 && !inDoubleQuotes2 && isWordBoundary(char)) {
        break;
      }
      if (!inSingleQuotes2 && !inDoubleQuotes2) {
        if (char === "'") {
          isQuotedDelimiter = true;
          inSingleQuotes2 = true;
          i2++;
          continue;
        }
        if (char === '"') {
          isQuotedDelimiter = true;
          inDoubleQuotes2 = true;
          i2++;
          continue;
        }
        if (char === "\\") {
          isQuotedDelimiter = true;
          i2++;
          if (i2 >= command.length) break;
          delimiter += command[i2];
          i2++;
          continue;
        }
        delimiter += char;
        i2++;
        continue;
      }
      if (inSingleQuotes2) {
        if (char === "'") {
          inSingleQuotes2 = false;
          i2++;
          continue;
        }
        delimiter += char;
        i2++;
        continue;
      }
      if (char === '"') {
        inDoubleQuotes2 = false;
        i2++;
        continue;
      }
      if (char === "\\") {
        isQuotedDelimiter = true;
        i2++;
        if (i2 >= command.length) break;
        delimiter += command[i2];
        i2++;
        continue;
      }
      delimiter += char;
      i2++;
    }
    if (delimiter.length === 0) {
      return null;
    }
    return {
      nextIndex: i2,
      heredoc: {
        delimiter,
        isQuotedDelimiter,
        stripLeadingTabs
      }
    };
  }, "parseHeredocOperator");
  const lineHasCommandSubstitution = /* @__PURE__ */ __name((line) => {
    for (let i2 = 0; i2 < line.length; i2++) {
      const char = line[i2];
      const nextChar = line[i2 + 1];
      if (char === "\\") {
        i2++;
        continue;
      }
      if (char === "$" && nextChar === "(") {
        return true;
      }
      if (char === "`") {
        return true;
      }
    }
    return false;
  }, "lineHasCommandSubstitution");
  const consumeHeredocBodies = /* @__PURE__ */ __name((startIndex, pending) => {
    let i2 = startIndex;
    for (const heredoc of pending) {
      let pendingDollarLineContinuation = false;
      while (i2 <= command.length) {
        const lineStart = i2;
        while (i2 < command.length && command[i2] !== "\n" && command[i2] !== "\r") {
          i2++;
        }
        const lineEnd = i2;
        let newlineLength = 0;
        if (i2 < command.length && command[i2] === "\r" && command[i2 + 1] === "\n") {
          newlineLength = 2;
        } else if (i2 < command.length && (command[i2] === "\n" || command[i2] === "\r")) {
          newlineLength = 1;
        }
        const rawLine = command.slice(lineStart, lineEnd);
        const effectiveLine = heredoc.stripLeadingTabs ? rawLine.replace(/^\t+/, "") : rawLine;
        if (effectiveLine === heredoc.delimiter) {
          i2 = lineEnd + newlineLength;
          break;
        }
        if (!heredoc.isQuotedDelimiter) {
          if (pendingDollarLineContinuation && effectiveLine.startsWith("(")) {
            return { nextIndex: i2, hasSubstitution: true };
          }
          if (lineHasCommandSubstitution(effectiveLine)) {
            return { nextIndex: i2, hasSubstitution: true };
          }
          pendingDollarLineContinuation = false;
          if (newlineLength > 0 && rawLine.length >= 2 && rawLine.endsWith("\\") && rawLine[rawLine.length - 2] === "$") {
            let backslashCount = 0;
            for (let j = rawLine.length - 3; j >= 0 && rawLine[j] === "\\"; j--) {
              backslashCount++;
            }
            const isEscapedDollar = backslashCount % 2 === 1;
            pendingDollarLineContinuation = !isEscapedDollar;
          }
        }
        i2 = lineEnd + newlineLength;
        if (newlineLength === 0) {
          break;
        }
      }
    }
    return { nextIndex: i2, hasSubstitution: false };
  }, "consumeHeredocBodies");
  let inSingleQuotes = false;
  let inDoubleQuotes = false;
  let inBackticks = false;
  let inComment = false;
  const pendingHeredocs = [];
  let i = 0;
  while (i < command.length) {
    const char = command[i];
    const nextChar = command[i + 1];
    if (!inSingleQuotes && !inDoubleQuotes && !inBackticks) {
      if (char === "\r" && nextChar === "\n") {
        inComment = false;
        if (pendingHeredocs.length > 0) {
          const result = consumeHeredocBodies(i + 2, pendingHeredocs);
          if (result.hasSubstitution) return true;
          pendingHeredocs.length = 0;
          i = result.nextIndex;
          continue;
        }
      } else if (char === "\n" || char === "\r") {
        inComment = false;
        if (pendingHeredocs.length > 0) {
          const result = consumeHeredocBodies(i + 1, pendingHeredocs);
          if (result.hasSubstitution) return true;
          pendingHeredocs.length = 0;
          i = result.nextIndex;
          continue;
        }
      }
    }
    if (!inSingleQuotes && !inDoubleQuotes && !inBackticks) {
      if (!inComment && isCommentStart(i)) {
        inComment = true;
        i++;
        continue;
      }
      if (inComment) {
        i++;
        continue;
      }
    }
    if (char === "\\" && !inSingleQuotes) {
      if (nextChar === "\n" && command[i - 1] === "$") {
        let dollarStart = i - 1;
        while (dollarStart > 0 && command[dollarStart - 1] === "$") {
          dollarStart--;
        }
        let escapeStart = dollarStart;
        while (escapeStart > 0 && command[escapeStart - 1] === "\\") {
          escapeStart--;
        }
        if ((i - dollarStart) % 2 === 1 && (dollarStart - escapeStart) % 2 === 0 && command[i + 2] === "(") {
          return true;
        }
      }
      i += 2;
      continue;
    }
    if (char === "'" && !inDoubleQuotes && !inBackticks) {
      inSingleQuotes = !inSingleQuotes;
    } else if (char === '"' && !inSingleQuotes && !inBackticks) {
      inDoubleQuotes = !inDoubleQuotes;
    } else if (char === "`" && !inSingleQuotes) {
      inBackticks = !inBackticks;
    }
    if (!inSingleQuotes && !inDoubleQuotes && !inBackticks && char === "<" && nextChar === "<") {
      const parsed = parseHeredocOperator(i);
      if (parsed) {
        pendingHeredocs.push(parsed.heredoc);
        i = parsed.nextIndex;
        continue;
      }
    }
    if (!inSingleQuotes) {
      if (char === "$" && nextChar === "(") {
        return true;
      }
      if (char === "$" && nextChar === "{" && /^\$\{[A-Za-z_][A-Za-z0-9_]*@P\}/.test(command.slice(i))) {
        return true;
      }
      if (char === "<" && nextChar === "(" && !inDoubleQuotes && !inBackticks) {
        return true;
      }
      if (char === ">" && nextChar === "(" && !inDoubleQuotes && !inBackticks) {
        return true;
      }
      if (char === "`") {
        return true;
      }
    }
    i++;
  }
  return false;
}
__name(detectCommandSubstitution, "detectCommandSubstitution");
var COMMAND_SUBSTITUTION_WARNING = "Contains command substitution ($(...), backticks, <(...), >(...), or ${parameter@P}).";
function hasShellSubstitution(rawCommand) {
  if (typeof rawCommand !== "string" || rawCommand.length === 0) return false;
  if (detectCommandSubstitution(rawCommand)) return true;
  const stripped = stripShellWrapper(rawCommand);
  return stripped !== rawCommand && detectCommandSubstitution(stripped);
}
__name(hasShellSubstitution, "hasShellSubstitution");
function buildShellExecWarnings(strippedCommand, rawCommand) {
  if (hasShellSubstitution(rawCommand) || detectCommandSubstitution(strippedCommand)) {
    return [COMMAND_SUBSTITUTION_WARNING];
  }
  return void 0;
}
__name(buildShellExecWarnings, "buildShellExecWarnings");
async function checkCommandPermissions(command, config, sessionAllowlist) {
  if (detectCommandSubstitution(command)) {
    return {
      allAllowed: false,
      disallowedCommands: [command],
      blockReason: "Command substitution using $(), `` ` ``, <(), >(), or ${parameter@P} is not allowed for security reasons",
      isHardDenial: true
    };
  }
  const normalize = /* @__PURE__ */ __name((cmd) => cmd.trim().replace(/\s+/g, " "), "normalize");
  const commandsToValidate = splitCommands(command).map(normalize);
  const invocation = {
    params: { command: "" }
  };
  const pm = config.getPermissionManager?.();
  if (pm) {
    const disallowedCommands2 = [];
    for (const cmd of commandsToValidate) {
      if (sessionAllowlist) {
        invocation.params["command"] = cmd;
        const isSessionAllowed = doesToolInvocationMatch(
          "run_shell_command",
          invocation,
          [...sessionAllowlist].flatMap(
            (c) => SHELL_TOOL_NAMES.map((name) => `${name}(${c})`)
          )
        );
        if (isSessionAllowed) continue;
      }
      const decision = await pm.isCommandAllowed(cmd);
      if (decision === "deny") {
        return {
          allAllowed: false,
          disallowedCommands: [cmd],
          blockReason: `Command '${cmd}' is blocked by permission rules`,
          isHardDenial: true
        };
      }
      if (decision === "allow") continue;
      if (decision === "ask") {
        disallowedCommands2.push(cmd);
        continue;
      }
      if (sessionAllowlist !== void 0) {
        disallowedCommands2.push(cmd);
      }
    }
    if (disallowedCommands2.length > 0) {
      return {
        allAllowed: false,
        disallowedCommands: disallowedCommands2,
        blockReason: `Command(s) require confirmation. Disallowed commands: ${disallowedCommands2.map((c) => JSON.stringify(c)).join(", ")}`,
        isHardDenial: false
      };
    }
    return { allAllowed: true, disallowedCommands: [] };
  }
  const excludeTools = config.getPermissionsDeny() || [];
  const isWildcardBlocked = SHELL_TOOL_NAMES.some(
    (name) => excludeTools.includes(name)
  );
  if (isWildcardBlocked) {
    return {
      allAllowed: false,
      disallowedCommands: commandsToValidate,
      blockReason: "Shell tool is globally disabled in configuration",
      isHardDenial: true
    };
  }
  for (const cmd of commandsToValidate) {
    invocation.params["command"] = cmd;
    if (doesToolInvocationMatch("run_shell_command", invocation, excludeTools)) {
      return {
        allAllowed: false,
        disallowedCommands: [cmd],
        blockReason: `Command '${cmd}' is blocked by configuration`,
        isHardDenial: true
      };
    }
  }
  const coreTools = config.getCoreTools() || [];
  const isWildcardAllowed = SHELL_TOOL_NAMES.some(
    (name) => coreTools.includes(name)
  );
  if (isWildcardAllowed) {
    return { allAllowed: true, disallowedCommands: [] };
  }
  const disallowedCommands = [];
  if (sessionAllowlist) {
    const normalizedSessionAllowlist = new Set(
      [...sessionAllowlist].flatMap(
        (cmd) => SHELL_TOOL_NAMES.map((name) => `${name}(${cmd})`)
      )
    );
    for (const cmd of commandsToValidate) {
      invocation.params["command"] = cmd;
      const isSessionAllowed = doesToolInvocationMatch(
        "run_shell_command",
        invocation,
        [...normalizedSessionAllowlist]
      );
      if (isSessionAllowed) continue;
      const isGloballyAllowed = doesToolInvocationMatch(
        "run_shell_command",
        invocation,
        coreTools
      );
      if (isGloballyAllowed) continue;
      disallowedCommands.push(cmd);
    }
    if (disallowedCommands.length > 0) {
      return {
        allAllowed: false,
        disallowedCommands,
        blockReason: `Command(s) not on the global or session allowlist. Disallowed commands: ${disallowedCommands.map((c) => JSON.stringify(c)).join(", ")}`,
        isHardDenial: false
        // This is a soft denial; confirmation is possible.
      };
    }
  } else {
    const hasSpecificAllowedCommands = coreTools.filter(
      (tool) => SHELL_TOOL_NAMES.some((name) => tool.startsWith(`${name}(`))
    ).length > 0;
    if (hasSpecificAllowedCommands) {
      for (const cmd of commandsToValidate) {
        invocation.params["command"] = cmd;
        const isGloballyAllowed = doesToolInvocationMatch(
          "run_shell_command",
          invocation,
          coreTools
        );
        if (!isGloballyAllowed) {
          disallowedCommands.push(cmd);
        }
      }
      if (disallowedCommands.length > 0) {
        return {
          allAllowed: false,
          disallowedCommands,
          blockReason: `Command(s) not in the allowed commands list. Disallowed commands: ${disallowedCommands.map((c) => JSON.stringify(c)).join(", ")}`,
          isHardDenial: false
          // This is a soft denial.
        };
      }
    }
  }
  return { allAllowed: true, disallowedCommands: [] };
}
__name(checkCommandPermissions, "checkCommandPermissions");
function execCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      args,
      { encoding: "utf8", ...options },
      (error, stdout, stderr) => {
        if (error) {
          if (!options.preserveOutputOnError) {
            reject(error);
          } else {
            resolve({
              stdout: String(stdout ?? ""),
              stderr: String(stderr ?? ""),
              code: typeof error.code === "number" ? error.code : 1
            });
          }
          return;
        }
        resolve({
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
          code: 0
        });
      }
    );
    child.on("error", reject);
  });
}
__name(execCommand, "execCommand");
function resolveCommandPath(command) {
  try {
    const isWin = process.platform === "win32";
    if (isWin) {
      const checkCommand = "where.exe";
      const checkArgs = [command];
      let result = null;
      try {
        result = execFileSync(checkCommand, checkArgs, {
          encoding: "utf8",
          shell: false
        }).trim();
      } catch {
        return { path: null, error: void 0 };
      }
      return result ? { path: result } : { path: null };
    } else {
      const shell = "/bin/sh";
      const checkArgs = ["-c", `command -v ${escapeShellArg(command, "bash")}`];
      let result = null;
      try {
        result = execFileSync(shell, checkArgs, {
          encoding: "utf8",
          shell: false
        }).trim();
      } catch {
        return { path: null, error: void 0 };
      }
      if (!result) return { path: null, error: void 0 };
      accessSync(result, fsConstants.X_OK);
      return { path: result, error: void 0 };
    }
  } catch (error) {
    return {
      path: null,
      error: error instanceof Error ? error : new Error(String(error))
    };
  }
}
__name(resolveCommandPath, "resolveCommandPath");
function isCommandAvailable(command) {
  const { path: path2, error } = resolveCommandPath(command);
  return { available: path2 !== null, error };
}
__name(isCommandAvailable, "isCommandAvailable");
function checkArgumentSafety(args) {
  const dangerousPatterns = [];
  if (args.includes("$(")) dangerousPatterns.push("$() command substitution");
  if (args.includes("`"))
    dangerousPatterns.push("backtick command substitution");
  if (args.includes("<(")) dangerousPatterns.push("<() process substitution");
  if (args.includes(">(")) dangerousPatterns.push(">() process substitution");
  if (args.includes(";")) dangerousPatterns.push("; command separator");
  if (args.includes("|")) dangerousPatterns.push("| pipe");
  if (args.includes("&&")) dangerousPatterns.push("&& AND operator");
  if (args.includes("||")) dangerousPatterns.push("|| OR operator");
  if (args.includes(" &") || args.includes("& "))
    dangerousPatterns.push("& background operator");
  if (args.includes(">") || args.includes("<")) {
    if (/>\s|\d>/.test(args)) dangerousPatterns.push("> output redirection");
    if (/<\s|\d</.test(args)) dangerousPatterns.push("< input redirection");
  }
  return {
    isSafe: dangerousPatterns.length === 0,
    dangerousPatterns
  };
}
__name(checkArgumentSafety, "checkArgumentSafety");
var CONPTY_MIN_WINDOWS_BUILD = 19042;
function shouldDefaultToNodePty() {
  if (os.platform() !== "win32") return true;
  const build = parseInt(os.release().split(".")[2] ?? "", 10);
  return !isNaN(build) && build >= CONPTY_MIN_WINDOWS_BUILD;
}
__name(shouldDefaultToNodePty, "shouldDefaultToNodePty");

export {
  require_shell_quote,
  getShellConfiguration,
  escapeShellArg,
  splitCommands,
  getCommandRoot,
  getCommandRoots,
  stripShellWrapper,
  SHELL_SELF_KILL_REJECTION,
  detectSelfKillCommand,
  normalizeMonitorCommand,
  hasUnsafeMonitorBackgroundOperator,
  hasShellSubstitution,
  buildShellExecWarnings,
  checkCommandPermissions,
  execCommand,
  isCommandAvailable,
  checkArgumentSafety,
  shouldDefaultToNodePty,
  classifySedCommandSafety,
  classifyAwkCommandSafety,
  hasShellPatternExpansion,
  isShellCommandReadOnly
};
/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
