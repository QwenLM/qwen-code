// Force strict mode and setup for ESM
"use strict";
import {
  createDebugLogger
} from "./chunk-ZYDMQCQP.js";
import {
  isNodeError
} from "./chunk-S34QJ6IR.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __commonJS,
  __name,
  __toESM
} from "./chunk-J2S4EL5Y.js";

// packages/core/node_modules/ignore/index.js
var require_ignore = __commonJS({
  "packages/core/node_modules/ignore/index.js"(exports, module) {
    init_esbuild_shims();
    function makeArray(subject) {
      return Array.isArray(subject) ? subject : [subject];
    }
    __name(makeArray, "makeArray");
    var UNDEFINED = void 0;
    var EMPTY = "";
    var SPACE = " ";
    var ESCAPE = "\\";
    var REGEX_TEST_BLANK_LINE = /^\s+$/;
    var REGEX_INVALID_TRAILING_BACKSLASH = /(?:[^\\]|^)\\$/;
    var REGEX_REPLACE_LEADING_EXCAPED_EXCLAMATION = /^\\!/;
    var REGEX_REPLACE_LEADING_EXCAPED_HASH = /^\\#/;
    var REGEX_SPLITALL_CRLF = /\r?\n/g;
    var REGEX_TEST_INVALID_PATH = /^\.{0,2}\/|^\.{1,2}$/;
    var REGEX_TEST_TRAILING_SLASH = /\/$/;
    var SLASH = "/";
    var TMP_KEY_IGNORE = "node-ignore";
    if (typeof Symbol !== "undefined") {
      TMP_KEY_IGNORE = Symbol.for("node-ignore");
    }
    var KEY_IGNORE = TMP_KEY_IGNORE;
    var define = /* @__PURE__ */ __name((object, key, value) => {
      Object.defineProperty(object, key, { value });
      return value;
    }, "define");
    var REGEX_REGEXP_RANGE = /([0-z])-([0-z])/g;
    var RETURN_FALSE = /* @__PURE__ */ __name(() => false, "RETURN_FALSE");
    var sanitizeRange = /* @__PURE__ */ __name((range) => range.replace(
      REGEX_REGEXP_RANGE,
      (match, from, to) => from.charCodeAt(0) <= to.charCodeAt(0) ? match : EMPTY
    ), "sanitizeRange");
    var cleanRangeBackSlash = /* @__PURE__ */ __name((slashes) => {
      const { length } = slashes;
      return slashes.slice(0, length - length % 2);
    }, "cleanRangeBackSlash");
    var REPLACERS = [
      [
        // Remove BOM
        // TODO:
        // Other similar zero-width characters?
        /^\uFEFF/,
        () => EMPTY
      ],
      // > Trailing spaces are ignored unless they are quoted with backslash ("\")
      [
        // (a\ ) -> (a )
        // (a  ) -> (a)
        // (a ) -> (a)
        // (a \ ) -> (a  )
        /((?:\\\\)*?)(\\?\s+)$/,
        (_, m1, m2) => m1 + (m2.indexOf("\\") === 0 ? SPACE : EMPTY)
      ],
      // Replace (\ ) with ' '
      // (\ ) -> ' '
      // (\\ ) -> '\\ '
      // (\\\ ) -> '\\ '
      [
        /(\\+?)\s/g,
        (_, m1) => {
          const { length } = m1;
          return m1.slice(0, length - length % 2) + SPACE;
        }
      ],
      // Escape metacharacters
      // which is written down by users but means special for regular expressions.
      // > There are 12 characters with special meanings:
      // > - the backslash \,
      // > - the caret ^,
      // > - the dollar sign $,
      // > - the period or dot .,
      // > - the vertical bar or pipe symbol |,
      // > - the question mark ?,
      // > - the asterisk or star *,
      // > - the plus sign +,
      // > - the opening parenthesis (,
      // > - the closing parenthesis ),
      // > - and the opening square bracket [,
      // > - the opening curly brace {,
      // > These special characters are often called "metacharacters".
      [
        /[\\$.|*+(){^]/g,
        (match) => `\\${match}`
      ],
      [
        // > a question mark (?) matches a single character
        /(?!\\)\?/g,
        () => "[^/]"
      ],
      // leading slash
      [
        // > A leading slash matches the beginning of the pathname.
        // > For example, "/*.c" matches "cat-file.c" but not "mozilla-sha1/sha1.c".
        // A leading slash matches the beginning of the pathname
        /^\//,
        () => "^"
      ],
      // replace special metacharacter slash after the leading slash
      [
        /\//g,
        () => "\\/"
      ],
      [
        // > A leading "**" followed by a slash means match in all directories.
        // > For example, "**/foo" matches file or directory "foo" anywhere,
        // > the same as pattern "foo".
        // > "**/foo/bar" matches file or directory "bar" anywhere that is directly
        // >   under directory "foo".
        // Notice that the '*'s have been replaced as '\\*'
        /^\^*\\\*\\\*\\\//,
        // '**/foo' <-> 'foo'
        () => "^(?:.*\\/)?"
      ],
      // starting
      [
        // there will be no leading '/'
        //   (which has been replaced by section "leading slash")
        // If starts with '**', adding a '^' to the regular expression also works
        /^(?=[^^])/,
        /* @__PURE__ */ __name(function startingReplacer() {
          return !/\/(?!$)/.test(this) ? "(?:^|\\/)" : "^";
        }, "startingReplacer")
      ],
      // two globstars
      [
        // Use lookahead assertions so that we could match more than one `'/**'`
        /\\\/\\\*\\\*(?=\\\/|$)/g,
        // Zero, one or several directories
        // should not use '*', or it will be replaced by the next replacer
        // Check if it is not the last `'/**'`
        (_, index, str) => index + 6 < str.length ? "(?:\\/[^\\/]+)*" : "\\/.+"
      ],
      // normal intermediate wildcards
      [
        // Never replace escaped '*'
        // ignore rule '\*' will match the path '*'
        // 'abc.*/' -> go
        // 'abc.*'  -> skip this rule,
        //    coz trailing single wildcard will be handed by [trailing wildcard]
        /(^|[^\\]+)(\\\*)+(?=.+)/g,
        // '*.js' matches '.js'
        // '*.js' doesn't match 'abc'
        (_, p1, p2) => {
          const unescaped = p2.replace(/\\\*/g, "[^\\/]*");
          return p1 + unescaped;
        }
      ],
      [
        // unescape, revert step 3 except for back slash
        // For example, if a user escape a '\\*',
        // after step 3, the result will be '\\\\\\*'
        /\\\\\\(?=[$.|*+(){^])/g,
        () => ESCAPE
      ],
      [
        // '\\\\' -> '\\'
        /\\\\/g,
        () => ESCAPE
      ],
      [
        // > The range notation, e.g. [a-zA-Z],
        // > can be used to match one of the characters in a range.
        // `\` is escaped by step 3
        /(\\)?\[([^\]/]*?)(\\*)($|\])/g,
        (match, leadEscape, range, endEscape, close) => leadEscape === ESCAPE ? `\\[${range}${cleanRangeBackSlash(endEscape)}${close}` : close === "]" ? endEscape.length % 2 === 0 ? `[${sanitizeRange(range)}${endEscape}]` : "[]" : "[]"
      ],
      // ending
      [
        // 'js' will not match 'js.'
        // 'ab' will not match 'abc'
        /(?:[^*])$/,
        // WTF!
        // https://git-scm.com/docs/gitignore
        // changes in [2.22.1](https://git-scm.com/docs/gitignore/2.22.1)
        // which re-fixes #24, #38
        // > If there is a separator at the end of the pattern then the pattern
        // > will only match directories, otherwise the pattern can match both
        // > files and directories.
        // 'js*' will not match 'a.js'
        // 'js/' will not match 'a.js'
        // 'js' will match 'a.js' and 'a.js/'
        (match) => /\/$/.test(match) ? `${match}$` : `${match}(?=$|\\/$)`
      ]
    ];
    var REGEX_REPLACE_TRAILING_WILDCARD = /(^|\\\/)?\\\*$/;
    var MODE_IGNORE = "regex";
    var MODE_CHECK_IGNORE = "checkRegex";
    var UNDERSCORE = "_";
    var TRAILING_WILD_CARD_REPLACERS = {
      [MODE_IGNORE](_, p1) {
        const prefix = p1 ? `${p1}[^/]+` : "[^/]*";
        return `${prefix}(?=$|\\/$)`;
      },
      [MODE_CHECK_IGNORE](_, p1) {
        const prefix = p1 ? `${p1}[^/]*` : "[^/]*";
        return `${prefix}(?=$|\\/$)`;
      }
    };
    var makeRegexPrefix = /* @__PURE__ */ __name((pattern) => REPLACERS.reduce(
      (prev, [matcher, replacer]) => prev.replace(matcher, replacer.bind(pattern)),
      pattern
    ), "makeRegexPrefix");
    var isString = /* @__PURE__ */ __name((subject) => typeof subject === "string", "isString");
    var checkPattern = /* @__PURE__ */ __name((pattern) => pattern && isString(pattern) && !REGEX_TEST_BLANK_LINE.test(pattern) && !REGEX_INVALID_TRAILING_BACKSLASH.test(pattern) && pattern.indexOf("#") !== 0, "checkPattern");
    var splitPattern = /* @__PURE__ */ __name((pattern) => pattern.split(REGEX_SPLITALL_CRLF).filter(Boolean), "splitPattern");
    var IgnoreRule = class {
      static {
        __name(this, "IgnoreRule");
      }
      constructor(pattern, mark, body, ignoreCase, negative, prefix) {
        this.pattern = pattern;
        this.mark = mark;
        this.negative = negative;
        define(this, "body", body);
        define(this, "ignoreCase", ignoreCase);
        define(this, "regexPrefix", prefix);
      }
      get regex() {
        const key = UNDERSCORE + MODE_IGNORE;
        if (this[key]) {
          return this[key];
        }
        return this._make(MODE_IGNORE, key);
      }
      get checkRegex() {
        const key = UNDERSCORE + MODE_CHECK_IGNORE;
        if (this[key]) {
          return this[key];
        }
        return this._make(MODE_CHECK_IGNORE, key);
      }
      _make(mode, key) {
        const str = this.regexPrefix.replace(
          REGEX_REPLACE_TRAILING_WILDCARD,
          // It does not need to bind pattern
          TRAILING_WILD_CARD_REPLACERS[mode]
        );
        const regex = this.ignoreCase ? new RegExp(str, "i") : new RegExp(str);
        return define(this, key, regex);
      }
    };
    var createRule = /* @__PURE__ */ __name(({
      pattern,
      mark
    }, ignoreCase) => {
      let negative = false;
      let body = pattern;
      if (body.indexOf("!") === 0) {
        negative = true;
        body = body.substr(1);
      }
      body = body.replace(REGEX_REPLACE_LEADING_EXCAPED_EXCLAMATION, "!").replace(REGEX_REPLACE_LEADING_EXCAPED_HASH, "#");
      const regexPrefix = makeRegexPrefix(body);
      return new IgnoreRule(
        pattern,
        mark,
        body,
        ignoreCase,
        negative,
        regexPrefix
      );
    }, "createRule");
    var RuleManager = class {
      static {
        __name(this, "RuleManager");
      }
      constructor(ignoreCase) {
        this._ignoreCase = ignoreCase;
        this._rules = [];
      }
      _add(pattern) {
        if (pattern && pattern[KEY_IGNORE]) {
          this._rules = this._rules.concat(pattern._rules._rules);
          this._added = true;
          return;
        }
        if (isString(pattern)) {
          pattern = {
            pattern
          };
        }
        if (checkPattern(pattern.pattern)) {
          const rule = createRule(pattern, this._ignoreCase);
          this._added = true;
          this._rules.push(rule);
        }
      }
      // @param {Array<string> | string | Ignore} pattern
      add(pattern) {
        this._added = false;
        makeArray(
          isString(pattern) ? splitPattern(pattern) : pattern
        ).forEach(this._add, this);
        return this._added;
      }
      // Test one single path without recursively checking parent directories
      //
      // - checkUnignored `boolean` whether should check if the path is unignored,
      //   setting `checkUnignored` to `false` could reduce additional
      //   path matching.
      // - check `string` either `MODE_IGNORE` or `MODE_CHECK_IGNORE`
      // @returns {TestResult} true if a file is ignored
      test(path3, checkUnignored, mode) {
        let ignored = false;
        let unignored = false;
        let matchedRule;
        this._rules.forEach((rule) => {
          const { negative } = rule;
          if (unignored === negative && ignored !== unignored || negative && !ignored && !unignored && !checkUnignored) {
            return;
          }
          const matched = rule[mode].test(path3);
          if (!matched) {
            return;
          }
          ignored = !negative;
          unignored = negative;
          matchedRule = negative ? UNDEFINED : rule;
        });
        const ret = {
          ignored,
          unignored
        };
        if (matchedRule) {
          ret.rule = matchedRule;
        }
        return ret;
      }
    };
    var throwError = /* @__PURE__ */ __name((message, Ctor) => {
      throw new Ctor(message);
    }, "throwError");
    var checkPath = /* @__PURE__ */ __name((path3, originalPath, doThrow) => {
      if (!isString(path3)) {
        return doThrow(
          `path must be a string, but got \`${originalPath}\``,
          TypeError
        );
      }
      if (!path3) {
        return doThrow(`path must not be empty`, TypeError);
      }
      if (checkPath.isNotRelative(path3)) {
        const r = "`path.relative()`d";
        return doThrow(
          `path should be a ${r} string, but got "${originalPath}"`,
          RangeError
        );
      }
      return true;
    }, "checkPath");
    var isNotRelative = /* @__PURE__ */ __name((path3) => REGEX_TEST_INVALID_PATH.test(path3), "isNotRelative");
    checkPath.isNotRelative = isNotRelative;
    checkPath.convert = (p) => p;
    var Ignore = class {
      static {
        __name(this, "Ignore");
      }
      constructor({
        ignorecase = true,
        ignoreCase = ignorecase,
        allowRelativePaths = false
      } = {}) {
        define(this, KEY_IGNORE, true);
        this._rules = new RuleManager(ignoreCase);
        this._strictPathCheck = !allowRelativePaths;
        this._initCache();
      }
      _initCache() {
        this._ignoreCache = /* @__PURE__ */ Object.create(null);
        this._testCache = /* @__PURE__ */ Object.create(null);
      }
      add(pattern) {
        if (this._rules.add(pattern)) {
          this._initCache();
        }
        return this;
      }
      // legacy
      addPattern(pattern) {
        return this.add(pattern);
      }
      // @returns {TestResult}
      _test(originalPath, cache, checkUnignored, slices) {
        const path3 = originalPath && checkPath.convert(originalPath);
        checkPath(
          path3,
          originalPath,
          this._strictPathCheck ? throwError : RETURN_FALSE
        );
        return this._t(path3, cache, checkUnignored, slices);
      }
      checkIgnore(path3) {
        if (!REGEX_TEST_TRAILING_SLASH.test(path3)) {
          return this.test(path3);
        }
        const slices = path3.split(SLASH).filter(Boolean);
        slices.pop();
        if (slices.length) {
          const parent = this._t(
            slices.join(SLASH) + SLASH,
            this._testCache,
            true,
            slices
          );
          if (parent.ignored) {
            return parent;
          }
        }
        return this._rules.test(path3, false, MODE_CHECK_IGNORE);
      }
      _t(path3, cache, checkUnignored, slices) {
        if (path3 in cache) {
          return cache[path3];
        }
        if (!slices) {
          slices = path3.split(SLASH).filter(Boolean);
        }
        slices.pop();
        if (!slices.length) {
          return cache[path3] = this._rules.test(path3, checkUnignored, MODE_IGNORE);
        }
        const parent = this._t(
          slices.join(SLASH) + SLASH,
          cache,
          checkUnignored,
          slices
        );
        return cache[path3] = parent.ignored ? parent : this._rules.test(path3, checkUnignored, MODE_IGNORE);
      }
      ignores(path3) {
        return this._test(path3, this._ignoreCache, false).ignored;
      }
      createFilter() {
        return (path3) => !this.ignores(path3);
      }
      filter(paths) {
        return makeArray(paths).filter(this.createFilter());
      }
      // @returns {TestResult}
      test(path3) {
        return this._test(path3, this._testCache, true);
      }
    };
    var factory = /* @__PURE__ */ __name((options) => new Ignore(options), "factory");
    var isPathValid = /* @__PURE__ */ __name((path3) => checkPath(path3 && checkPath.convert(path3), path3, RETURN_FALSE), "isPathValid");
    var setupWindows = /* @__PURE__ */ __name(() => {
      const makePosix = /* @__PURE__ */ __name((str) => /^\\\\\?\\/.test(str) || /["<>|\u0000-\u001F]+/u.test(str) ? str : str.replace(/\\/g, "/"), "makePosix");
      checkPath.convert = makePosix;
      const REGEX_TEST_WINDOWS_PATH_ABSOLUTE = /^[a-z]:\//i;
      checkPath.isNotRelative = (path3) => REGEX_TEST_WINDOWS_PATH_ABSOLUTE.test(path3) || isNotRelative(path3);
    }, "setupWindows");
    if (
      // Detect `process` so that it can run in browsers.
      typeof process !== "undefined" && process.platform === "win32"
    ) {
      setupWindows();
    }
    module.exports = factory;
    factory.default = factory;
    module.exports.isPathValid = isPathValid;
    define(module.exports, Symbol.for("setupWindows"), setupWindows);
  }
});

// packages/core/src/utils/workspaceContext.ts
init_esbuild_shims();
import * as fs from "node:fs";
import * as path from "node:path";
import * as process2 from "node:process";
var debugLogger = createDebugLogger("WORKSPACE");
var WorkspaceContext = class _WorkspaceContext {
  static {
    __name(this, "WorkspaceContext");
  }
  directories = /* @__PURE__ */ new Set();
  initialDirectories;
  onDirectoriesChangedListeners = /* @__PURE__ */ new Set();
  /**
   * Memoized realpath results. Every workspace-bounded tool call ultimately
   * routes through {@link fullyResolvedPath} → `fs.realpathSync`; without
   * this cache the same path gets re-resolved on every Read/Glob/Grep/Ls
   * invocation. Bounded so long sessions touching many files don't grow
   * without limit; FIFO eviction is good enough — the working set tends to
   * be the small set of paths the model is actively manipulating.
   */
  resolvedPathCache = /* @__PURE__ */ new Map();
  static RESOLVED_PATH_CACHE_MAX = 1024;
  /**
   * Creates a new WorkspaceContext with the given initial directory and optional additional directories.
   * @param directory The initial working directory (usually cwd)
   * @param additionalDirectories Optional array of additional directories to include
   */
  constructor(directory, additionalDirectories = []) {
    this.addDirectory(directory);
    this.initialDirectories = new Set(this.directories);
    for (const additionalDirectory of additionalDirectories) {
      this.addDirectory(additionalDirectory);
    }
  }
  /**
   * Registers a listener that is called when the workspace directories change.
   * @param listener The listener to call.
   * @returns A function to unsubscribe the listener.
   */
  onDirectoriesChanged(listener) {
    this.onDirectoriesChangedListeners.add(listener);
    return () => {
      this.onDirectoriesChangedListeners.delete(listener);
    };
  }
  notifyDirectoriesChanged() {
    for (const listener of [...this.onDirectoriesChangedListeners]) {
      try {
        listener();
      } catch (e) {
        debugLogger.error("Error in WorkspaceContext listener:", e);
      }
    }
  }
  /**
   * Adds a directory to the workspace.
   * @param directory The directory path to add (can be relative or absolute)
   * @param basePath Optional base path for resolving relative paths (defaults to cwd)
   */
  addDirectory(directory, basePath = process2.cwd()) {
    try {
      const resolved = _WorkspaceContext.resolveAndValidateDir(
        directory,
        basePath
      );
      if (this.directories.has(resolved)) {
        return;
      }
      this.directories.add(resolved);
      this.notifyDirectoriesChanged();
    } catch (err) {
      debugLogger.warn(
        `Skipping unreadable directory: ${directory} (${err instanceof Error ? err.message : String(err)})`
      );
    }
  }
  static resolveAndValidateDir(directory, basePath = process2.cwd()) {
    const absolutePath = path.isAbsolute(directory) ? directory : path.resolve(basePath, directory);
    if (!fs.existsSync(absolutePath)) {
      throw new Error(`Directory does not exist: ${absolutePath}`);
    }
    const stats = fs.statSync(absolutePath);
    if (!stats.isDirectory()) {
      throw new Error(`Path is not a directory: ${absolutePath}`);
    }
    return fs.realpathSync(absolutePath);
  }
  static resolveRootDirectories(directory, additionalDirectories = []) {
    const primaryDirectory = _WorkspaceContext.resolveAndValidateDir(directory);
    const directories = /* @__PURE__ */ new Set([primaryDirectory]);
    for (const additionalDirectory of additionalDirectories) {
      directories.add(
        _WorkspaceContext.resolveAndValidateDir(additionalDirectory)
      );
    }
    return {
      directories,
      initialDirectories: /* @__PURE__ */ new Set([primaryDirectory])
    };
  }
  /**
   * Gets a copy of all workspace directories.
   * @returns Array of absolute directory paths
   */
  getDirectories() {
    return Array.from(this.directories);
  }
  getInitialDirectories() {
    return Array.from(this.initialDirectories);
  }
  /**
   * Removes a directory from the workspace.
   * Cannot remove initial directories (those set at construction time).
   * @param directory The directory path to remove
   * @returns True if the directory was removed, false if not found or is an initial directory
   */
  removeDirectory(directory) {
    let resolved;
    try {
      resolved = _WorkspaceContext.resolveAndValidateDir(directory);
    } catch {
      resolved = path.isAbsolute(directory) ? directory : path.resolve(process2.cwd(), directory);
    }
    if (this.initialDirectories.has(resolved)) {
      debugLogger.warn(`Cannot remove initial directory: ${resolved}`);
      return false;
    }
    if (!this.directories.has(resolved)) {
      return false;
    }
    this.directories.delete(resolved);
    this.notifyDirectoriesChanged();
    return true;
  }
  /**
   * Checks whether a directory is an initial (non-removable) directory.
   */
  isInitialDirectory(directory) {
    try {
      const resolved = _WorkspaceContext.resolveAndValidateDir(directory);
      return this.initialDirectories.has(resolved);
    } catch {
      const absolutePath = path.isAbsolute(directory) ? directory : path.resolve(process2.cwd(), directory);
      return this.initialDirectories.has(absolutePath);
    }
  }
  setDirectories(directories) {
    const newDirectories = /* @__PURE__ */ new Set();
    for (const dir of directories) {
      newDirectories.add(_WorkspaceContext.resolveAndValidateDir(dir));
    }
    if (newDirectories.size !== this.directories.size || ![...newDirectories].every((d) => this.directories.has(d))) {
      this.directories = newDirectories;
      this.notifyDirectoriesChanged();
    }
  }
  applyRootDirectories(resolved) {
    const newDirectories = new Set(resolved.directories);
    const newInitialDirectories = new Set(resolved.initialDirectories);
    for (const existing of this.directories) {
      if (!this.initialDirectories.has(existing)) {
        newDirectories.add(existing);
      }
    }
    const directoriesChanged = newDirectories.size !== this.directories.size || ![...newDirectories].every((d) => this.directories.has(d));
    const initialDirectoriesChanged = newInitialDirectories.size !== this.initialDirectories.size || ![...newInitialDirectories].every((d) => this.initialDirectories.has(d));
    this.directories = newDirectories;
    this.initialDirectories = newInitialDirectories;
    this.resolvedPathCache.clear();
    if (directoriesChanged || initialDirectoriesChanged) {
      this.notifyDirectoriesChanged();
    }
  }
  /**
   * Checks if a given path is within any of the workspace directories.
   * @param pathToCheck The path to validate
   * @returns True if the path is within the workspace, false otherwise
   */
  isPathWithinWorkspace(pathToCheck) {
    try {
      const fullyResolvedPath = this.fullyResolvedPath(pathToCheck);
      for (const dir of this.directories) {
        if (isPathWithinRoot(fullyResolvedPath, dir)) {
          return true;
        }
      }
      return false;
    } catch (_error) {
      return false;
    }
  }
  /**
   * Fully resolves a path, including symbolic links.
   * If the path does not exist, it returns the fully resolved path as it would be
   * if it did exist.
   *
   * Result is memoized in {@link resolvedPathCache}. Filesystem-state cache:
   * if a file is renamed / a symlink is retargeted mid-session the cache
   * goes stale, which is the same correctness profile as any single
   * `realpathSync` call (it captures a moment in time). The win is cutting
   * 8+ syscalls per tool-heavy prompt down to 1.
   */
  fullyResolvedPath(pathToCheck) {
    const cached = this.resolvedPathCache.get(pathToCheck);
    if (cached !== void 0) {
      return cached;
    }
    const resolved = resolveWorkspacePath(pathToCheck);
    if (this.resolvedPathCache.size >= _WorkspaceContext.RESOLVED_PATH_CACHE_MAX) {
      const oldest = this.resolvedPathCache.keys().next().value;
      if (oldest !== void 0) this.resolvedPathCache.delete(oldest);
    }
    this.resolvedPathCache.set(pathToCheck, resolved);
    return resolved;
  }
};
function resolveWorkspacePath(pathToCheck) {
  try {
    const resolved = fs.realpathSync(pathToCheck);
    return typeof resolved === "string" ? resolved : pathToCheck;
  } catch (error) {
    if (isResolvableMissingPathError(error)) {
      return resolveMissingPath(pathToCheck);
    }
    throw error;
  }
}
__name(resolveWorkspacePath, "resolveWorkspacePath");
function resolveMissingPath(pathToCheck) {
  const missingTail = [];
  let ancestor = pathToCheck;
  while (true) {
    try {
      const resolvedAncestor = fs.realpathSync(ancestor);
      return path.join(resolvedAncestor, ...missingTail);
    } catch (error) {
      if (!isResolvableMissingPathError(error)) {
        throw error;
      }
      const parent = path.dirname(ancestor);
      if (parent === ancestor) {
        return pathToCheck;
      }
      missingTail.unshift(path.basename(ancestor));
      ancestor = parent;
    }
  }
}
__name(resolveMissingPath, "resolveMissingPath");
function isResolvableMissingPathError(error) {
  return isNodeError(error) && error.code === "ENOENT" && !!error.path && // realpathSync does not set error.path correctly for symlinks to
  // non-existent files.
  !isFileSymlink(error.path);
}
__name(isResolvableMissingPathError, "isResolvableMissingPathError");
function isFileSymlink(filePath) {
  try {
    return !fs.readlinkSync(filePath).endsWith("/");
  } catch (_error) {
    return false;
  }
}
__name(isFileSymlink, "isFileSymlink");
function isPathWithinRoot(pathToCheck, rootDirectory) {
  const relative3 = path.relative(rootDirectory, pathToCheck);
  return !relative3.startsWith(`..${path.sep}`) && relative3 !== ".." && !path.isAbsolute(relative3);
}
__name(isPathWithinRoot, "isPathWithinRoot");

// packages/core/src/utils/qwenIgnoreParser.ts
init_esbuild_shims();
var import_ignore = __toESM(require_ignore(), 1);
import * as fs2 from "node:fs";
import * as path2 from "node:path";
var QWEN_IGNORE_FILE_NAME = ".qwenignore";
var debugLogger2 = createDebugLogger("QWEN_IGNORE");
var DEFAULT_QWEN_CUSTOM_IGNORE_FILE_NAMES = [
  ".agentignore",
  ".aiignore"
];
function normalizeQwenCustomIgnoreFileNames(ignoreFileNames = DEFAULT_QWEN_CUSTOM_IGNORE_FILE_NAMES) {
  const normalized = [];
  const seen = /* @__PURE__ */ new Set();
  for (const ignoreFileName of ignoreFileNames) {
    const candidate = ignoreFileName.trim().replace(/\\/g, "/");
    const skipReason = getCustomIgnoreFileNameSkipReason(candidate);
    if (skipReason) {
      debugLogger2.debug(
        `Skipping customIgnoreFiles entry "${ignoreFileName}": ${skipReason}`
      );
      continue;
    }
    if (seen.has(candidate)) {
      debugLogger2.debug(
        `Skipping customIgnoreFiles entry "${ignoreFileName}": duplicate`
      );
      continue;
    }
    normalized.push(candidate);
    seen.add(candidate);
  }
  return normalized;
}
__name(normalizeQwenCustomIgnoreFileNames, "normalizeQwenCustomIgnoreFileNames");
function getCustomIgnoreFileNameSkipReason(candidate) {
  if (candidate === "") {
    return "empty path";
  }
  if (path2.isAbsolute(candidate) || candidate.startsWith("/")) {
    return "absolute paths are not allowed";
  }
  if (candidate.includes("\0")) {
    return "null bytes are not allowed";
  }
  if (candidate === QWEN_IGNORE_FILE_NAME) {
    return ".qwenignore is always included";
  }
  if (candidate.split("/").includes("..")) {
    return "parent directory segments are not allowed";
  }
  return null;
}
__name(getCustomIgnoreFileNameSkipReason, "getCustomIgnoreFileNameSkipReason");
function getQwenIgnoreFileNames(customIgnoreFileNames) {
  return [
    QWEN_IGNORE_FILE_NAME,
    ...normalizeQwenCustomIgnoreFileNames(customIgnoreFileNames)
  ];
}
__name(getQwenIgnoreFileNames, "getQwenIgnoreFileNames");
function formatQwenIgnoreFileNames(customIgnoreFileNames) {
  return getQwenIgnoreFileNames(customIgnoreFileNames).join(", ");
}
__name(formatQwenIgnoreFileNames, "formatQwenIgnoreFileNames");
var QwenIgnoreParser = class {
  static {
    __name(this, "QwenIgnoreParser");
  }
  projectRoot;
  patterns = [];
  ignoreFileNames;
  sourceIgnorers = [];
  constructor(projectRoot, customIgnoreFileNames) {
    this.projectRoot = path2.resolve(projectRoot);
    this.ignoreFileNames = getQwenIgnoreFileNames(customIgnoreFileNames);
    this.loadPatterns();
  }
  loadPatterns() {
    for (const ignoreFileName of this.ignoreFileNames) {
      const patternsFilePath = path2.join(this.projectRoot, ignoreFileName);
      let content;
      try {
        content = fs2.readFileSync(patternsFilePath, "utf-8");
      } catch (_error) {
        const error = _error;
        if (error.code !== "ENOENT") {
          debugLogger2.debug(
            `Failed to read ${patternsFilePath}: ${error.message}`
          );
        }
        continue;
      }
      const patterns = (content ?? "").split("\n").map((p) => p.endsWith("\r") ? p.slice(0, -1) : p).filter((p) => p.trim() !== "" && !p.startsWith("#"));
      if (patterns.length > 0) {
        const sourceIgnorer = (0, import_ignore.default)();
        sourceIgnorer.add(patterns);
        this.sourceIgnorers.push({
          ignoreFileName,
          ignorer: sourceIgnorer
        });
      }
      this.patterns.push(...patterns);
    }
  }
  isIgnored(filePath) {
    if (this.patterns.length === 0) {
      return false;
    }
    const normalizedPath = this.normalizePathForIgnore(filePath);
    if (!normalizedPath) {
      return false;
    }
    return this.sourceIgnorers.some(
      ({ ignorer }) => ignorer.ignores(normalizedPath)
    );
  }
  getIgnoreFileNameForPath(filePath) {
    const normalizedPath = this.normalizePathForIgnore(filePath);
    if (!normalizedPath) {
      return void 0;
    }
    return this.sourceIgnorers.find(
      ({ ignorer }) => ignorer.ignores(normalizedPath)
    )?.ignoreFileName;
  }
  normalizePathForIgnore(filePath) {
    if (!filePath || typeof filePath !== "string") {
      return null;
    }
    if (filePath.startsWith("\\") || filePath === "/" || filePath.includes("\0")) {
      return null;
    }
    const isDir = filePath.endsWith("/");
    const resolved = path2.resolve(this.projectRoot, filePath);
    const relativePath = path2.relative(this.projectRoot, resolved);
    if (relativePath === "" || !isPathWithinRoot(resolved, this.projectRoot)) {
      return null;
    }
    let normalizedPath = relativePath.replace(/\\/g, "/");
    if (isDir && !normalizedPath.endsWith("/")) {
      normalizedPath += "/";
    }
    if (normalizedPath.startsWith("/") || normalizedPath === "") {
      return null;
    }
    return normalizedPath;
  }
  getPatterns() {
    return this.patterns;
  }
  getIgnoreFileNames() {
    return this.ignoreFileNames;
  }
};

// packages/core/src/utils/file-filtering-options.ts
init_esbuild_shims();
var DEFAULT_MEMORY_FILE_FILTERING_OPTIONS = {
  respectGitIgnore: false,
  respectQwenIgnore: true,
  customIgnoreFiles: [...DEFAULT_QWEN_CUSTOM_IGNORE_FILE_NAMES]
};
var DEFAULT_FILE_FILTERING_OPTIONS = {
  respectGitIgnore: true,
  respectQwenIgnore: true,
  customIgnoreFiles: [...DEFAULT_QWEN_CUSTOM_IGNORE_FILE_NAMES]
};

export {
  require_ignore,
  WorkspaceContext,
  isPathWithinRoot,
  DEFAULT_QWEN_CUSTOM_IGNORE_FILE_NAMES,
  getQwenIgnoreFileNames,
  formatQwenIgnoreFileNames,
  QwenIgnoreParser,
  DEFAULT_FILE_FILTERING_OPTIONS
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
