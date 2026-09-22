// Force strict mode and setup for ESM
"use strict";
import {
  AssistantMessage,
  AssistantMessageContent,
  Colors,
  MarkdownDisplay,
  RadioButtonSelect,
  RenderInline,
  SettingsContext,
  TOOL_ARGS_INLINE_MAX_LINES,
  TOOL_DISPLAY_BY_NAME,
  TOOL_SUCCESS_RATE_HIGH,
  TOOL_SUCCESS_RATE_MEDIUM,
  ThinkMessage,
  ThinkMessageContent,
  ToolConfirmationMessage,
  ToolMessage,
  USER_AGREEMENT_RATE_HIGH,
  USER_AGREEMENT_RATE_MEDIUM,
  UserMessage,
  UserShellMessage,
  checkExhaustive,
  flattenModelsBySource,
  formatTokenCount as formatTokenCount2,
  getArenaStatusLabel,
  getStatusColor,
  layoutRowForEvent,
  measureElementPosition,
  useContextMenu,
  useMouseEvents,
  useMouseTrackingEnabled,
  useSessionStats,
  useSettings,
  useTerminalSize,
  useVirtualViewport
} from "./chunk-TW7AK2SB.js";
import {
  CompactToolGroupDisplay,
  ICON,
  SCREEN_READER_MODEL_PREFIX,
  ToolElapsedTime,
  ToolStatusIndicator,
  buildResumedHistoryItems,
  build_default,
  coalesceFindingsHistoryItems,
  estimateCompactToolGroupHeight,
  getOverallStatus,
  isCollapsibleTool,
  isFindingsListDisplay
} from "./chunk-UOWURAPY.js";
import {
  useKeypress
} from "./chunk-CGGQFT4L.js";
import {
  calculateAverageLatency,
  calculateCacheHitRate,
  calculateCost,
  calculateErrorRate,
  computeDiffColumnWidths,
  computeSessionStats,
  formatSupportedModes,
  getCommandDisplayName,
  getCommandSourceBadge,
  getCommandSourceGroup,
  getCommandSubcommandNames,
  getCompressionStatusText,
  getSystemInfoFields,
  levelLabel
} from "./chunk-2XC3CR4F.js";
import {
  formatDuration,
  formatRelativeTime,
  formatTokenCount
} from "./chunk-WEUQIY3Q.js";
import {
  theme
} from "./chunk-3NHJLWOD.js";
import {
  require_jsx_runtime
} from "./chunk-SV5PQVQE.js";
import {
  Box_default,
  Static,
  Text,
  Transform,
  getFrameController,
  use_stdout_default
} from "./chunk-ZTBP4SFC.js";
import {
  require_react
} from "./chunk-5QWWOFGG.js";
import {
  isTerminalGoalStatusKind
} from "./chunk-EKTCKZV5.js";
import {
  getErrorMessage
} from "./chunk-6OHXRCXH.js";
import {
  relaunchApp
} from "./chunk-A4L3TDKL.js";
import {
  escapeAnsiCtrlCodes,
  getCachedStringWidth,
  sanitizeFilenameForDisplay,
  sanitizeMultilineForDisplay,
  sanitizeSensitiveText,
  sanitizeTerminalText
} from "./chunk-47ECGEJC.js";
import {
  stringWidth
} from "./chunk-2MIN6GRR.js";
import {
  createLoadedSettingsAdapter
} from "./chunk-E2DZNQEH.js";
import {
  require_has_flag,
  require_source
} from "./chunk-57OAHC2Y.js";
import {
  getPersistScopeForModelSelection
} from "./chunk-DRYBBTI5.js";
import {
  getCurrentLanguage,
  localizeToolDisplayName,
  t
} from "./chunk-POMFSBEC.js";
import {
  isWorkspaceTrusted
} from "./chunk-36RKQ7ZS.js";
import {
  IdeClient,
  getExtensionDisplayName,
  ideContextStore
} from "./chunk-MRTRBONQ.js";
import {
  stripAnsi
} from "./chunk-TWPJO254.js";
import {
  ALL_PROVIDERS,
  PROVIDER_METADATA_NS,
  applyProviderInstallPlan,
  buildInstallPlan,
  buildProviderTemplate,
  computeModelListVersion,
  getDefaultModelIds,
  getModelsForProviderProtocol,
  providerMatchesCredentials,
  resolveBaseUrl,
  resolveMetadataKey,
  resolveOwnsModel,
  tryResolveModelProtocol
} from "./chunk-TLS6QN2S.js";
import {
  getMCPServerStatus
} from "./chunk-KKGSJZWK.js";
import {
  createDebugLogger
} from "./chunk-ZYDMQCQP.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __commonJS,
  __name,
  __require,
  __toESM
} from "./chunk-J2S4EL5Y.js";

// node_modules/prop-types/lib/ReactPropTypesSecret.js
var require_ReactPropTypesSecret = __commonJS({
  "node_modules/prop-types/lib/ReactPropTypesSecret.js"(exports, module) {
    "use strict";
    init_esbuild_shims();
    var ReactPropTypesSecret = "SECRET_DO_NOT_PASS_THIS_OR_YOU_WILL_BE_FIRED";
    module.exports = ReactPropTypesSecret;
  }
});

// node_modules/prop-types/factoryWithThrowingShims.js
var require_factoryWithThrowingShims = __commonJS({
  "node_modules/prop-types/factoryWithThrowingShims.js"(exports, module) {
    "use strict";
    init_esbuild_shims();
    var ReactPropTypesSecret = require_ReactPropTypesSecret();
    function emptyFunction() {
    }
    __name(emptyFunction, "emptyFunction");
    function emptyFunctionWithReset() {
    }
    __name(emptyFunctionWithReset, "emptyFunctionWithReset");
    emptyFunctionWithReset.resetWarningCache = emptyFunction;
    module.exports = function() {
      function shim(props, propName, componentName, location, propFullName, secret) {
        if (secret === ReactPropTypesSecret) {
          return;
        }
        var err = new Error(
          "Calling PropTypes validators directly is not supported by the `prop-types` package. Use PropTypes.checkPropTypes() to call them. Read more at http://fb.me/use-check-prop-types"
        );
        err.name = "Invariant Violation";
        throw err;
      }
      __name(shim, "shim");
      ;
      shim.isRequired = shim;
      function getShim() {
        return shim;
      }
      __name(getShim, "getShim");
      ;
      var ReactPropTypes = {
        array: shim,
        bigint: shim,
        bool: shim,
        func: shim,
        number: shim,
        object: shim,
        string: shim,
        symbol: shim,
        any: shim,
        arrayOf: getShim,
        element: shim,
        elementType: shim,
        instanceOf: getShim,
        node: shim,
        objectOf: getShim,
        oneOf: getShim,
        oneOfType: getShim,
        shape: getShim,
        exact: getShim,
        checkPropTypes: emptyFunctionWithReset,
        resetWarningCache: emptyFunction
      };
      ReactPropTypes.PropTypes = ReactPropTypes;
      return ReactPropTypes;
    };
  }
});

// node_modules/prop-types/index.js
var require_prop_types = __commonJS({
  "node_modules/prop-types/index.js"(exports, module) {
    init_esbuild_shims();
    if (false) {
      ReactIs = null;
      throwOnDirectAccess = true;
      module.exports = null(ReactIs.isElement, throwOnDirectAccess);
    } else {
      module.exports = require_factoryWithThrowingShims()();
    }
    var ReactIs;
    var throwOnDirectAccess;
  }
});

// node_modules/ink-link/node_modules/supports-color/index.js
var require_supports_color = __commonJS({
  "node_modules/ink-link/node_modules/supports-color/index.js"(exports, module) {
    "use strict";
    init_esbuild_shims();
    var os = __require("os");
    var tty = __require("tty");
    var hasFlag = require_has_flag();
    var { env } = process;
    var forceColor;
    if (hasFlag("no-color") || hasFlag("no-colors") || hasFlag("color=false") || hasFlag("color=never")) {
      forceColor = 0;
    } else if (hasFlag("color") || hasFlag("colors") || hasFlag("color=true") || hasFlag("color=always")) {
      forceColor = 1;
    }
    if ("FORCE_COLOR" in env) {
      if (env.FORCE_COLOR === "true") {
        forceColor = 1;
      } else if (env.FORCE_COLOR === "false") {
        forceColor = 0;
      } else {
        forceColor = env.FORCE_COLOR.length === 0 ? 1 : Math.min(parseInt(env.FORCE_COLOR, 10), 3);
      }
    }
    function translateLevel(level) {
      if (level === 0) {
        return false;
      }
      return {
        level,
        hasBasic: true,
        has256: level >= 2,
        has16m: level >= 3
      };
    }
    __name(translateLevel, "translateLevel");
    function supportsColor(haveStream, streamIsTTY) {
      if (forceColor === 0) {
        return 0;
      }
      if (hasFlag("color=16m") || hasFlag("color=full") || hasFlag("color=truecolor")) {
        return 3;
      }
      if (hasFlag("color=256")) {
        return 2;
      }
      if (haveStream && !streamIsTTY && forceColor === void 0) {
        return 0;
      }
      const min = forceColor || 0;
      if (env.TERM === "dumb") {
        return min;
      }
      if (process.platform === "win32") {
        const osRelease = os.release().split(".");
        if (Number(osRelease[0]) >= 10 && Number(osRelease[2]) >= 10586) {
          return Number(osRelease[2]) >= 14931 ? 3 : 2;
        }
        return 1;
      }
      if ("CI" in env) {
        if (["TRAVIS", "CIRCLECI", "APPVEYOR", "GITLAB_CI", "GITHUB_ACTIONS", "BUILDKITE"].some((sign) => sign in env) || env.CI_NAME === "codeship") {
          return 1;
        }
        return min;
      }
      if ("TEAMCITY_VERSION" in env) {
        return /^(9\.(0*[1-9]\d*)\.|\d{2,}\.)/.test(env.TEAMCITY_VERSION) ? 1 : 0;
      }
      if (env.COLORTERM === "truecolor") {
        return 3;
      }
      if ("TERM_PROGRAM" in env) {
        const version = parseInt((env.TERM_PROGRAM_VERSION || "").split(".")[0], 10);
        switch (env.TERM_PROGRAM) {
          case "iTerm.app":
            return version >= 3 ? 3 : 2;
          case "Apple_Terminal":
            return 2;
        }
      }
      if (/-256(color)?$/i.test(env.TERM)) {
        return 2;
      }
      if (/^screen|^xterm|^vt100|^vt220|^rxvt|color|ansi|cygwin|linux/i.test(env.TERM)) {
        return 1;
      }
      if ("COLORTERM" in env) {
        return 1;
      }
      return min;
    }
    __name(supportsColor, "supportsColor");
    function getSupportLevel(stream) {
      const level = supportsColor(stream, stream && stream.isTTY);
      return translateLevel(level);
    }
    __name(getSupportLevel, "getSupportLevel");
    module.exports = {
      supportsColor: getSupportLevel,
      stdout: translateLevel(supportsColor(true, tty.isatty(1))),
      stderr: translateLevel(supportsColor(true, tty.isatty(2)))
    };
  }
});

// node_modules/ink-link/node_modules/supports-hyperlinks/index.js
var require_supports_hyperlinks = __commonJS({
  "node_modules/ink-link/node_modules/supports-hyperlinks/index.js"(exports, module) {
    "use strict";
    init_esbuild_shims();
    var supportsColor = require_supports_color();
    var hasFlag = require_has_flag();
    function parseVersion(versionString) {
      if (/^\d{3,4}$/.test(versionString)) {
        const m = /(\d{1,2})(\d{2})/.exec(versionString);
        return {
          major: 0,
          minor: parseInt(m[1], 10),
          patch: parseInt(m[2], 10)
        };
      }
      const versions = (versionString || "").split(".").map((n) => parseInt(n, 10));
      return {
        major: versions[0],
        minor: versions[1],
        patch: versions[2]
      };
    }
    __name(parseVersion, "parseVersion");
    function supportsHyperlink(stream) {
      const { env } = process;
      if ("FORCE_HYPERLINK" in env) {
        return !(env.FORCE_HYPERLINK.length > 0 && parseInt(env.FORCE_HYPERLINK, 10) === 0);
      }
      if (hasFlag("no-hyperlink") || hasFlag("no-hyperlinks") || hasFlag("hyperlink=false") || hasFlag("hyperlink=never")) {
        return false;
      }
      if (hasFlag("hyperlink=true") || hasFlag("hyperlink=always")) {
        return true;
      }
      if ("NETLIFY" in env) {
        return true;
      }
      if (!supportsColor.supportsColor(stream)) {
        return false;
      }
      if (stream && !stream.isTTY) {
        return false;
      }
      if (process.platform === "win32") {
        return false;
      }
      if ("CI" in env) {
        return false;
      }
      if ("TEAMCITY_VERSION" in env) {
        return false;
      }
      if ("TERM_PROGRAM" in env) {
        const version = parseVersion(env.TERM_PROGRAM_VERSION);
        switch (env.TERM_PROGRAM) {
          case "iTerm.app":
            if (version.major === 3) {
              return version.minor >= 1;
            }
            return version.major > 3;
          case "WezTerm":
            return version.major >= 20200620;
          case "vscode":
            return version.major > 1 || version.major === 1 && version.minor >= 72;
        }
      }
      if ("VTE_VERSION" in env) {
        if (env.VTE_VERSION === "0.50.0") {
          return false;
        }
        const version = parseVersion(env.VTE_VERSION);
        return version.major > 0 || version.minor >= 50;
      }
      return false;
    }
    __name(supportsHyperlink, "supportsHyperlink");
    module.exports = {
      supportsHyperlink,
      stdout: supportsHyperlink(process.stdout),
      stderr: supportsHyperlink(process.stderr)
    };
  }
});

// node_modules/tinycolor2/cjs/tinycolor.js
var require_tinycolor = __commonJS({
  "node_modules/tinycolor2/cjs/tinycolor.js"(exports, module) {
    init_esbuild_shims();
    (function(global, factory) {
      typeof exports === "object" && typeof module !== "undefined" ? module.exports = factory() : typeof define === "function" && define.amd ? define(factory) : (global = typeof globalThis !== "undefined" ? globalThis : global || self, global.tinycolor = factory());
    })(exports, function() {
      "use strict";
      function _typeof(obj) {
        "@babel/helpers - typeof";
        return _typeof = "function" == typeof Symbol && "symbol" == typeof Symbol.iterator ? function(obj2) {
          return typeof obj2;
        } : function(obj2) {
          return obj2 && "function" == typeof Symbol && obj2.constructor === Symbol && obj2 !== Symbol.prototype ? "symbol" : typeof obj2;
        }, _typeof(obj);
      }
      __name(_typeof, "_typeof");
      var trimLeft = /^\s+/;
      var trimRight = /\s+$/;
      function tinycolor(color, opts) {
        color = color ? color : "";
        opts = opts || {};
        if (color instanceof tinycolor) {
          return color;
        }
        if (!(this instanceof tinycolor)) {
          return new tinycolor(color, opts);
        }
        var rgb = inputToRGB(color);
        this._originalInput = color, this._r = rgb.r, this._g = rgb.g, this._b = rgb.b, this._a = rgb.a, this._roundA = Math.round(100 * this._a) / 100, this._format = opts.format || rgb.format;
        this._gradientType = opts.gradientType;
        if (this._r < 1) this._r = Math.round(this._r);
        if (this._g < 1) this._g = Math.round(this._g);
        if (this._b < 1) this._b = Math.round(this._b);
        this._ok = rgb.ok;
      }
      __name(tinycolor, "tinycolor");
      tinycolor.prototype = {
        isDark: /* @__PURE__ */ __name(function isDark() {
          return this.getBrightness() < 128;
        }, "isDark"),
        isLight: /* @__PURE__ */ __name(function isLight() {
          return !this.isDark();
        }, "isLight"),
        isValid: /* @__PURE__ */ __name(function isValid() {
          return this._ok;
        }, "isValid"),
        getOriginalInput: /* @__PURE__ */ __name(function getOriginalInput() {
          return this._originalInput;
        }, "getOriginalInput"),
        getFormat: /* @__PURE__ */ __name(function getFormat() {
          return this._format;
        }, "getFormat"),
        getAlpha: /* @__PURE__ */ __name(function getAlpha() {
          return this._a;
        }, "getAlpha"),
        getBrightness: /* @__PURE__ */ __name(function getBrightness() {
          var rgb = this.toRgb();
          return (rgb.r * 299 + rgb.g * 587 + rgb.b * 114) / 1e3;
        }, "getBrightness"),
        getLuminance: /* @__PURE__ */ __name(function getLuminance() {
          var rgb = this.toRgb();
          var RsRGB, GsRGB, BsRGB, R, G, B;
          RsRGB = rgb.r / 255;
          GsRGB = rgb.g / 255;
          BsRGB = rgb.b / 255;
          if (RsRGB <= 0.03928) R = RsRGB / 12.92;
          else R = Math.pow((RsRGB + 0.055) / 1.055, 2.4);
          if (GsRGB <= 0.03928) G = GsRGB / 12.92;
          else G = Math.pow((GsRGB + 0.055) / 1.055, 2.4);
          if (BsRGB <= 0.03928) B = BsRGB / 12.92;
          else B = Math.pow((BsRGB + 0.055) / 1.055, 2.4);
          return 0.2126 * R + 0.7152 * G + 0.0722 * B;
        }, "getLuminance"),
        setAlpha: /* @__PURE__ */ __name(function setAlpha(value) {
          this._a = boundAlpha(value);
          this._roundA = Math.round(100 * this._a) / 100;
          return this;
        }, "setAlpha"),
        toHsv: /* @__PURE__ */ __name(function toHsv() {
          var hsv = rgbToHsv(this._r, this._g, this._b);
          return {
            h: hsv.h * 360,
            s: hsv.s,
            v: hsv.v,
            a: this._a
          };
        }, "toHsv"),
        toHsvString: /* @__PURE__ */ __name(function toHsvString() {
          var hsv = rgbToHsv(this._r, this._g, this._b);
          var h = Math.round(hsv.h * 360), s = Math.round(hsv.s * 100), v = Math.round(hsv.v * 100);
          return this._a == 1 ? "hsv(" + h + ", " + s + "%, " + v + "%)" : "hsva(" + h + ", " + s + "%, " + v + "%, " + this._roundA + ")";
        }, "toHsvString"),
        toHsl: /* @__PURE__ */ __name(function toHsl() {
          var hsl = rgbToHsl(this._r, this._g, this._b);
          return {
            h: hsl.h * 360,
            s: hsl.s,
            l: hsl.l,
            a: this._a
          };
        }, "toHsl"),
        toHslString: /* @__PURE__ */ __name(function toHslString() {
          var hsl = rgbToHsl(this._r, this._g, this._b);
          var h = Math.round(hsl.h * 360), s = Math.round(hsl.s * 100), l = Math.round(hsl.l * 100);
          return this._a == 1 ? "hsl(" + h + ", " + s + "%, " + l + "%)" : "hsla(" + h + ", " + s + "%, " + l + "%, " + this._roundA + ")";
        }, "toHslString"),
        toHex: /* @__PURE__ */ __name(function toHex(allow3Char) {
          return rgbToHex(this._r, this._g, this._b, allow3Char);
        }, "toHex"),
        toHexString: /* @__PURE__ */ __name(function toHexString(allow3Char) {
          return "#" + this.toHex(allow3Char);
        }, "toHexString"),
        toHex8: /* @__PURE__ */ __name(function toHex8(allow4Char) {
          return rgbaToHex(this._r, this._g, this._b, this._a, allow4Char);
        }, "toHex8"),
        toHex8String: /* @__PURE__ */ __name(function toHex8String(allow4Char) {
          return "#" + this.toHex8(allow4Char);
        }, "toHex8String"),
        toRgb: /* @__PURE__ */ __name(function toRgb() {
          return {
            r: Math.round(this._r),
            g: Math.round(this._g),
            b: Math.round(this._b),
            a: this._a
          };
        }, "toRgb"),
        toRgbString: /* @__PURE__ */ __name(function toRgbString() {
          return this._a == 1 ? "rgb(" + Math.round(this._r) + ", " + Math.round(this._g) + ", " + Math.round(this._b) + ")" : "rgba(" + Math.round(this._r) + ", " + Math.round(this._g) + ", " + Math.round(this._b) + ", " + this._roundA + ")";
        }, "toRgbString"),
        toPercentageRgb: /* @__PURE__ */ __name(function toPercentageRgb() {
          return {
            r: Math.round(bound01(this._r, 255) * 100) + "%",
            g: Math.round(bound01(this._g, 255) * 100) + "%",
            b: Math.round(bound01(this._b, 255) * 100) + "%",
            a: this._a
          };
        }, "toPercentageRgb"),
        toPercentageRgbString: /* @__PURE__ */ __name(function toPercentageRgbString() {
          return this._a == 1 ? "rgb(" + Math.round(bound01(this._r, 255) * 100) + "%, " + Math.round(bound01(this._g, 255) * 100) + "%, " + Math.round(bound01(this._b, 255) * 100) + "%)" : "rgba(" + Math.round(bound01(this._r, 255) * 100) + "%, " + Math.round(bound01(this._g, 255) * 100) + "%, " + Math.round(bound01(this._b, 255) * 100) + "%, " + this._roundA + ")";
        }, "toPercentageRgbString"),
        toName: /* @__PURE__ */ __name(function toName() {
          if (this._a === 0) {
            return "transparent";
          }
          if (this._a < 1) {
            return false;
          }
          return hexNames[rgbToHex(this._r, this._g, this._b, true)] || false;
        }, "toName"),
        toFilter: /* @__PURE__ */ __name(function toFilter(secondColor) {
          var hex8String = "#" + rgbaToArgbHex(this._r, this._g, this._b, this._a);
          var secondHex8String = hex8String;
          var gradientType = this._gradientType ? "GradientType = 1, " : "";
          if (secondColor) {
            var s = tinycolor(secondColor);
            secondHex8String = "#" + rgbaToArgbHex(s._r, s._g, s._b, s._a);
          }
          return "progid:DXImageTransform.Microsoft.gradient(" + gradientType + "startColorstr=" + hex8String + ",endColorstr=" + secondHex8String + ")";
        }, "toFilter"),
        toString: /* @__PURE__ */ __name(function toString(format) {
          var formatSet = !!format;
          format = format || this._format;
          var formattedString = false;
          var hasAlpha = this._a < 1 && this._a >= 0;
          var needsAlphaFormat = !formatSet && hasAlpha && (format === "hex" || format === "hex6" || format === "hex3" || format === "hex4" || format === "hex8" || format === "name");
          if (needsAlphaFormat) {
            if (format === "name" && this._a === 0) {
              return this.toName();
            }
            return this.toRgbString();
          }
          if (format === "rgb") {
            formattedString = this.toRgbString();
          }
          if (format === "prgb") {
            formattedString = this.toPercentageRgbString();
          }
          if (format === "hex" || format === "hex6") {
            formattedString = this.toHexString();
          }
          if (format === "hex3") {
            formattedString = this.toHexString(true);
          }
          if (format === "hex4") {
            formattedString = this.toHex8String(true);
          }
          if (format === "hex8") {
            formattedString = this.toHex8String();
          }
          if (format === "name") {
            formattedString = this.toName();
          }
          if (format === "hsl") {
            formattedString = this.toHslString();
          }
          if (format === "hsv") {
            formattedString = this.toHsvString();
          }
          return formattedString || this.toHexString();
        }, "toString"),
        clone: /* @__PURE__ */ __name(function clone() {
          return tinycolor(this.toString());
        }, "clone"),
        _applyModification: /* @__PURE__ */ __name(function _applyModification(fn, args) {
          var color = fn.apply(null, [this].concat([].slice.call(args)));
          this._r = color._r;
          this._g = color._g;
          this._b = color._b;
          this.setAlpha(color._a);
          return this;
        }, "_applyModification"),
        lighten: /* @__PURE__ */ __name(function lighten() {
          return this._applyModification(_lighten, arguments);
        }, "lighten"),
        brighten: /* @__PURE__ */ __name(function brighten() {
          return this._applyModification(_brighten, arguments);
        }, "brighten"),
        darken: /* @__PURE__ */ __name(function darken() {
          return this._applyModification(_darken, arguments);
        }, "darken"),
        desaturate: /* @__PURE__ */ __name(function desaturate() {
          return this._applyModification(_desaturate, arguments);
        }, "desaturate"),
        saturate: /* @__PURE__ */ __name(function saturate() {
          return this._applyModification(_saturate, arguments);
        }, "saturate"),
        greyscale: /* @__PURE__ */ __name(function greyscale() {
          return this._applyModification(_greyscale, arguments);
        }, "greyscale"),
        spin: /* @__PURE__ */ __name(function spin() {
          return this._applyModification(_spin, arguments);
        }, "spin"),
        _applyCombination: /* @__PURE__ */ __name(function _applyCombination(fn, args) {
          return fn.apply(null, [this].concat([].slice.call(args)));
        }, "_applyCombination"),
        analogous: /* @__PURE__ */ __name(function analogous() {
          return this._applyCombination(_analogous, arguments);
        }, "analogous"),
        complement: /* @__PURE__ */ __name(function complement() {
          return this._applyCombination(_complement, arguments);
        }, "complement"),
        monochromatic: /* @__PURE__ */ __name(function monochromatic() {
          return this._applyCombination(_monochromatic, arguments);
        }, "monochromatic"),
        splitcomplement: /* @__PURE__ */ __name(function splitcomplement() {
          return this._applyCombination(_splitcomplement, arguments);
        }, "splitcomplement"),
        // Disabled until https://github.com/bgrins/TinyColor/issues/254
        // polyad: function (number) {
        //   return this._applyCombination(polyad, [number]);
        // },
        triad: /* @__PURE__ */ __name(function triad() {
          return this._applyCombination(polyad, [3]);
        }, "triad"),
        tetrad: /* @__PURE__ */ __name(function tetrad() {
          return this._applyCombination(polyad, [4]);
        }, "tetrad")
      };
      tinycolor.fromRatio = function(color, opts) {
        if (_typeof(color) == "object") {
          var newColor = {};
          for (var i in color) {
            if (color.hasOwnProperty(i)) {
              if (i === "a") {
                newColor[i] = color[i];
              } else {
                newColor[i] = convertToPercentage(color[i]);
              }
            }
          }
          color = newColor;
        }
        return tinycolor(color, opts);
      };
      function inputToRGB(color) {
        var rgb = {
          r: 0,
          g: 0,
          b: 0
        };
        var a = 1;
        var s = null;
        var v = null;
        var l = null;
        var ok = false;
        var format = false;
        if (typeof color == "string") {
          color = stringInputToObject(color);
        }
        if (_typeof(color) == "object") {
          if (isValidCSSUnit(color.r) && isValidCSSUnit(color.g) && isValidCSSUnit(color.b)) {
            rgb = rgbToRgb(color.r, color.g, color.b);
            ok = true;
            format = String(color.r).substr(-1) === "%" ? "prgb" : "rgb";
          } else if (isValidCSSUnit(color.h) && isValidCSSUnit(color.s) && isValidCSSUnit(color.v)) {
            s = convertToPercentage(color.s);
            v = convertToPercentage(color.v);
            rgb = hsvToRgb(color.h, s, v);
            ok = true;
            format = "hsv";
          } else if (isValidCSSUnit(color.h) && isValidCSSUnit(color.s) && isValidCSSUnit(color.l)) {
            s = convertToPercentage(color.s);
            l = convertToPercentage(color.l);
            rgb = hslToRgb(color.h, s, l);
            ok = true;
            format = "hsl";
          }
          if (color.hasOwnProperty("a")) {
            a = color.a;
          }
        }
        a = boundAlpha(a);
        return {
          ok,
          format: color.format || format,
          r: Math.min(255, Math.max(rgb.r, 0)),
          g: Math.min(255, Math.max(rgb.g, 0)),
          b: Math.min(255, Math.max(rgb.b, 0)),
          a
        };
      }
      __name(inputToRGB, "inputToRGB");
      function rgbToRgb(r, g, b) {
        return {
          r: bound01(r, 255) * 255,
          g: bound01(g, 255) * 255,
          b: bound01(b, 255) * 255
        };
      }
      __name(rgbToRgb, "rgbToRgb");
      function rgbToHsl(r, g, b) {
        r = bound01(r, 255);
        g = bound01(g, 255);
        b = bound01(b, 255);
        var max = Math.max(r, g, b), min = Math.min(r, g, b);
        var h, s, l = (max + min) / 2;
        if (max == min) {
          h = s = 0;
        } else {
          var d = max - min;
          s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
          switch (max) {
            case r:
              h = (g - b) / d + (g < b ? 6 : 0);
              break;
            case g:
              h = (b - r) / d + 2;
              break;
            case b:
              h = (r - g) / d + 4;
              break;
          }
          h /= 6;
        }
        return {
          h,
          s,
          l
        };
      }
      __name(rgbToHsl, "rgbToHsl");
      function hslToRgb(h, s, l) {
        var r, g, b;
        h = bound01(h, 360);
        s = bound01(s, 100);
        l = bound01(l, 100);
        function hue2rgb(p2, q2, t2) {
          if (t2 < 0) t2 += 1;
          if (t2 > 1) t2 -= 1;
          if (t2 < 1 / 6) return p2 + (q2 - p2) * 6 * t2;
          if (t2 < 1 / 2) return q2;
          if (t2 < 2 / 3) return p2 + (q2 - p2) * (2 / 3 - t2) * 6;
          return p2;
        }
        __name(hue2rgb, "hue2rgb");
        if (s === 0) {
          r = g = b = l;
        } else {
          var q = l < 0.5 ? l * (1 + s) : l + s - l * s;
          var p = 2 * l - q;
          r = hue2rgb(p, q, h + 1 / 3);
          g = hue2rgb(p, q, h);
          b = hue2rgb(p, q, h - 1 / 3);
        }
        return {
          r: r * 255,
          g: g * 255,
          b: b * 255
        };
      }
      __name(hslToRgb, "hslToRgb");
      function rgbToHsv(r, g, b) {
        r = bound01(r, 255);
        g = bound01(g, 255);
        b = bound01(b, 255);
        var max = Math.max(r, g, b), min = Math.min(r, g, b);
        var h, s, v = max;
        var d = max - min;
        s = max === 0 ? 0 : d / max;
        if (max == min) {
          h = 0;
        } else {
          switch (max) {
            case r:
              h = (g - b) / d + (g < b ? 6 : 0);
              break;
            case g:
              h = (b - r) / d + 2;
              break;
            case b:
              h = (r - g) / d + 4;
              break;
          }
          h /= 6;
        }
        return {
          h,
          s,
          v
        };
      }
      __name(rgbToHsv, "rgbToHsv");
      function hsvToRgb(h, s, v) {
        h = bound01(h, 360) * 6;
        s = bound01(s, 100);
        v = bound01(v, 100);
        var i = Math.floor(h), f = h - i, p = v * (1 - s), q = v * (1 - f * s), t2 = v * (1 - (1 - f) * s), mod = i % 6, r = [v, q, p, p, t2, v][mod], g = [t2, v, v, q, p, p][mod], b = [p, p, t2, v, v, q][mod];
        return {
          r: r * 255,
          g: g * 255,
          b: b * 255
        };
      }
      __name(hsvToRgb, "hsvToRgb");
      function rgbToHex(r, g, b, allow3Char) {
        var hex = [pad2(Math.round(r).toString(16)), pad2(Math.round(g).toString(16)), pad2(Math.round(b).toString(16))];
        if (allow3Char && hex[0].charAt(0) == hex[0].charAt(1) && hex[1].charAt(0) == hex[1].charAt(1) && hex[2].charAt(0) == hex[2].charAt(1)) {
          return hex[0].charAt(0) + hex[1].charAt(0) + hex[2].charAt(0);
        }
        return hex.join("");
      }
      __name(rgbToHex, "rgbToHex");
      function rgbaToHex(r, g, b, a, allow4Char) {
        var hex = [pad2(Math.round(r).toString(16)), pad2(Math.round(g).toString(16)), pad2(Math.round(b).toString(16)), pad2(convertDecimalToHex(a))];
        if (allow4Char && hex[0].charAt(0) == hex[0].charAt(1) && hex[1].charAt(0) == hex[1].charAt(1) && hex[2].charAt(0) == hex[2].charAt(1) && hex[3].charAt(0) == hex[3].charAt(1)) {
          return hex[0].charAt(0) + hex[1].charAt(0) + hex[2].charAt(0) + hex[3].charAt(0);
        }
        return hex.join("");
      }
      __name(rgbaToHex, "rgbaToHex");
      function rgbaToArgbHex(r, g, b, a) {
        var hex = [pad2(convertDecimalToHex(a)), pad2(Math.round(r).toString(16)), pad2(Math.round(g).toString(16)), pad2(Math.round(b).toString(16))];
        return hex.join("");
      }
      __name(rgbaToArgbHex, "rgbaToArgbHex");
      tinycolor.equals = function(color1, color2) {
        if (!color1 || !color2) return false;
        return tinycolor(color1).toRgbString() == tinycolor(color2).toRgbString();
      };
      tinycolor.random = function() {
        return tinycolor.fromRatio({
          r: Math.random(),
          g: Math.random(),
          b: Math.random()
        });
      };
      function _desaturate(color, amount) {
        amount = amount === 0 ? 0 : amount || 10;
        var hsl = tinycolor(color).toHsl();
        hsl.s -= amount / 100;
        hsl.s = clamp01(hsl.s);
        return tinycolor(hsl);
      }
      __name(_desaturate, "_desaturate");
      function _saturate(color, amount) {
        amount = amount === 0 ? 0 : amount || 10;
        var hsl = tinycolor(color).toHsl();
        hsl.s += amount / 100;
        hsl.s = clamp01(hsl.s);
        return tinycolor(hsl);
      }
      __name(_saturate, "_saturate");
      function _greyscale(color) {
        return tinycolor(color).desaturate(100);
      }
      __name(_greyscale, "_greyscale");
      function _lighten(color, amount) {
        amount = amount === 0 ? 0 : amount || 10;
        var hsl = tinycolor(color).toHsl();
        hsl.l += amount / 100;
        hsl.l = clamp01(hsl.l);
        return tinycolor(hsl);
      }
      __name(_lighten, "_lighten");
      function _brighten(color, amount) {
        amount = amount === 0 ? 0 : amount || 10;
        var rgb = tinycolor(color).toRgb();
        rgb.r = Math.max(0, Math.min(255, rgb.r - Math.round(255 * -(amount / 100))));
        rgb.g = Math.max(0, Math.min(255, rgb.g - Math.round(255 * -(amount / 100))));
        rgb.b = Math.max(0, Math.min(255, rgb.b - Math.round(255 * -(amount / 100))));
        return tinycolor(rgb);
      }
      __name(_brighten, "_brighten");
      function _darken(color, amount) {
        amount = amount === 0 ? 0 : amount || 10;
        var hsl = tinycolor(color).toHsl();
        hsl.l -= amount / 100;
        hsl.l = clamp01(hsl.l);
        return tinycolor(hsl);
      }
      __name(_darken, "_darken");
      function _spin(color, amount) {
        var hsl = tinycolor(color).toHsl();
        var hue = (hsl.h + amount) % 360;
        hsl.h = hue < 0 ? 360 + hue : hue;
        return tinycolor(hsl);
      }
      __name(_spin, "_spin");
      function _complement(color) {
        var hsl = tinycolor(color).toHsl();
        hsl.h = (hsl.h + 180) % 360;
        return tinycolor(hsl);
      }
      __name(_complement, "_complement");
      function polyad(color, number) {
        if (isNaN(number) || number <= 0) {
          throw new Error("Argument to polyad must be a positive number");
        }
        var hsl = tinycolor(color).toHsl();
        var result = [tinycolor(color)];
        var step = 360 / number;
        for (var i = 1; i < number; i++) {
          result.push(tinycolor({
            h: (hsl.h + i * step) % 360,
            s: hsl.s,
            l: hsl.l
          }));
        }
        return result;
      }
      __name(polyad, "polyad");
      function _splitcomplement(color) {
        var hsl = tinycolor(color).toHsl();
        var h = hsl.h;
        return [tinycolor(color), tinycolor({
          h: (h + 72) % 360,
          s: hsl.s,
          l: hsl.l
        }), tinycolor({
          h: (h + 216) % 360,
          s: hsl.s,
          l: hsl.l
        })];
      }
      __name(_splitcomplement, "_splitcomplement");
      function _analogous(color, results, slices) {
        results = results || 6;
        slices = slices || 30;
        var hsl = tinycolor(color).toHsl();
        var part = 360 / slices;
        var ret = [tinycolor(color)];
        for (hsl.h = (hsl.h - (part * results >> 1) + 720) % 360; --results; ) {
          hsl.h = (hsl.h + part) % 360;
          ret.push(tinycolor(hsl));
        }
        return ret;
      }
      __name(_analogous, "_analogous");
      function _monochromatic(color, results) {
        results = results || 6;
        var hsv = tinycolor(color).toHsv();
        var h = hsv.h, s = hsv.s, v = hsv.v;
        var ret = [];
        var modification = 1 / results;
        while (results--) {
          ret.push(tinycolor({
            h,
            s,
            v
          }));
          v = (v + modification) % 1;
        }
        return ret;
      }
      __name(_monochromatic, "_monochromatic");
      tinycolor.mix = function(color1, color2, amount) {
        amount = amount === 0 ? 0 : amount || 50;
        var rgb1 = tinycolor(color1).toRgb();
        var rgb2 = tinycolor(color2).toRgb();
        var p = amount / 100;
        var rgba = {
          r: (rgb2.r - rgb1.r) * p + rgb1.r,
          g: (rgb2.g - rgb1.g) * p + rgb1.g,
          b: (rgb2.b - rgb1.b) * p + rgb1.b,
          a: (rgb2.a - rgb1.a) * p + rgb1.a
        };
        return tinycolor(rgba);
      };
      tinycolor.readability = function(color1, color2) {
        var c1 = tinycolor(color1);
        var c2 = tinycolor(color2);
        return (Math.max(c1.getLuminance(), c2.getLuminance()) + 0.05) / (Math.min(c1.getLuminance(), c2.getLuminance()) + 0.05);
      };
      tinycolor.isReadable = function(color1, color2, wcag2) {
        var readability = tinycolor.readability(color1, color2);
        var wcag2Parms, out;
        out = false;
        wcag2Parms = validateWCAG2Parms(wcag2);
        switch (wcag2Parms.level + wcag2Parms.size) {
          case "AAsmall":
          case "AAAlarge":
            out = readability >= 4.5;
            break;
          case "AAlarge":
            out = readability >= 3;
            break;
          case "AAAsmall":
            out = readability >= 7;
            break;
        }
        return out;
      };
      tinycolor.mostReadable = function(baseColor, colorList, args) {
        var bestColor = null;
        var bestScore = 0;
        var readability;
        var includeFallbackColors, level, size;
        args = args || {};
        includeFallbackColors = args.includeFallbackColors;
        level = args.level;
        size = args.size;
        for (var i = 0; i < colorList.length; i++) {
          readability = tinycolor.readability(baseColor, colorList[i]);
          if (readability > bestScore) {
            bestScore = readability;
            bestColor = tinycolor(colorList[i]);
          }
        }
        if (tinycolor.isReadable(baseColor, bestColor, {
          level,
          size
        }) || !includeFallbackColors) {
          return bestColor;
        } else {
          args.includeFallbackColors = false;
          return tinycolor.mostReadable(baseColor, ["#fff", "#000"], args);
        }
      };
      var names = tinycolor.names = {
        aliceblue: "f0f8ff",
        antiquewhite: "faebd7",
        aqua: "0ff",
        aquamarine: "7fffd4",
        azure: "f0ffff",
        beige: "f5f5dc",
        bisque: "ffe4c4",
        black: "000",
        blanchedalmond: "ffebcd",
        blue: "00f",
        blueviolet: "8a2be2",
        brown: "a52a2a",
        burlywood: "deb887",
        burntsienna: "ea7e5d",
        cadetblue: "5f9ea0",
        chartreuse: "7fff00",
        chocolate: "d2691e",
        coral: "ff7f50",
        cornflowerblue: "6495ed",
        cornsilk: "fff8dc",
        crimson: "dc143c",
        cyan: "0ff",
        darkblue: "00008b",
        darkcyan: "008b8b",
        darkgoldenrod: "b8860b",
        darkgray: "a9a9a9",
        darkgreen: "006400",
        darkgrey: "a9a9a9",
        darkkhaki: "bdb76b",
        darkmagenta: "8b008b",
        darkolivegreen: "556b2f",
        darkorange: "ff8c00",
        darkorchid: "9932cc",
        darkred: "8b0000",
        darksalmon: "e9967a",
        darkseagreen: "8fbc8f",
        darkslateblue: "483d8b",
        darkslategray: "2f4f4f",
        darkslategrey: "2f4f4f",
        darkturquoise: "00ced1",
        darkviolet: "9400d3",
        deeppink: "ff1493",
        deepskyblue: "00bfff",
        dimgray: "696969",
        dimgrey: "696969",
        dodgerblue: "1e90ff",
        firebrick: "b22222",
        floralwhite: "fffaf0",
        forestgreen: "228b22",
        fuchsia: "f0f",
        gainsboro: "dcdcdc",
        ghostwhite: "f8f8ff",
        gold: "ffd700",
        goldenrod: "daa520",
        gray: "808080",
        green: "008000",
        greenyellow: "adff2f",
        grey: "808080",
        honeydew: "f0fff0",
        hotpink: "ff69b4",
        indianred: "cd5c5c",
        indigo: "4b0082",
        ivory: "fffff0",
        khaki: "f0e68c",
        lavender: "e6e6fa",
        lavenderblush: "fff0f5",
        lawngreen: "7cfc00",
        lemonchiffon: "fffacd",
        lightblue: "add8e6",
        lightcoral: "f08080",
        lightcyan: "e0ffff",
        lightgoldenrodyellow: "fafad2",
        lightgray: "d3d3d3",
        lightgreen: "90ee90",
        lightgrey: "d3d3d3",
        lightpink: "ffb6c1",
        lightsalmon: "ffa07a",
        lightseagreen: "20b2aa",
        lightskyblue: "87cefa",
        lightslategray: "789",
        lightslategrey: "789",
        lightsteelblue: "b0c4de",
        lightyellow: "ffffe0",
        lime: "0f0",
        limegreen: "32cd32",
        linen: "faf0e6",
        magenta: "f0f",
        maroon: "800000",
        mediumaquamarine: "66cdaa",
        mediumblue: "0000cd",
        mediumorchid: "ba55d3",
        mediumpurple: "9370db",
        mediumseagreen: "3cb371",
        mediumslateblue: "7b68ee",
        mediumspringgreen: "00fa9a",
        mediumturquoise: "48d1cc",
        mediumvioletred: "c71585",
        midnightblue: "191970",
        mintcream: "f5fffa",
        mistyrose: "ffe4e1",
        moccasin: "ffe4b5",
        navajowhite: "ffdead",
        navy: "000080",
        oldlace: "fdf5e6",
        olive: "808000",
        olivedrab: "6b8e23",
        orange: "ffa500",
        orangered: "ff4500",
        orchid: "da70d6",
        palegoldenrod: "eee8aa",
        palegreen: "98fb98",
        paleturquoise: "afeeee",
        palevioletred: "db7093",
        papayawhip: "ffefd5",
        peachpuff: "ffdab9",
        peru: "cd853f",
        pink: "ffc0cb",
        plum: "dda0dd",
        powderblue: "b0e0e6",
        purple: "800080",
        rebeccapurple: "663399",
        red: "f00",
        rosybrown: "bc8f8f",
        royalblue: "4169e1",
        saddlebrown: "8b4513",
        salmon: "fa8072",
        sandybrown: "f4a460",
        seagreen: "2e8b57",
        seashell: "fff5ee",
        sienna: "a0522d",
        silver: "c0c0c0",
        skyblue: "87ceeb",
        slateblue: "6a5acd",
        slategray: "708090",
        slategrey: "708090",
        snow: "fffafa",
        springgreen: "00ff7f",
        steelblue: "4682b4",
        tan: "d2b48c",
        teal: "008080",
        thistle: "d8bfd8",
        tomato: "ff6347",
        turquoise: "40e0d0",
        violet: "ee82ee",
        wheat: "f5deb3",
        white: "fff",
        whitesmoke: "f5f5f5",
        yellow: "ff0",
        yellowgreen: "9acd32"
      };
      var hexNames = tinycolor.hexNames = flip(names);
      function flip(o) {
        var flipped = {};
        for (var i in o) {
          if (o.hasOwnProperty(i)) {
            flipped[o[i]] = i;
          }
        }
        return flipped;
      }
      __name(flip, "flip");
      function boundAlpha(a) {
        a = parseFloat(a);
        if (isNaN(a) || a < 0 || a > 1) {
          a = 1;
        }
        return a;
      }
      __name(boundAlpha, "boundAlpha");
      function bound01(n, max) {
        if (isOnePointZero(n)) n = "100%";
        var processPercent = isPercentage(n);
        n = Math.min(max, Math.max(0, parseFloat(n)));
        if (processPercent) {
          n = parseInt(n * max, 10) / 100;
        }
        if (Math.abs(n - max) < 1e-6) {
          return 1;
        }
        return n % max / parseFloat(max);
      }
      __name(bound01, "bound01");
      function clamp01(val) {
        return Math.min(1, Math.max(0, val));
      }
      __name(clamp01, "clamp01");
      function parseIntFromHex(val) {
        return parseInt(val, 16);
      }
      __name(parseIntFromHex, "parseIntFromHex");
      function isOnePointZero(n) {
        return typeof n == "string" && n.indexOf(".") != -1 && parseFloat(n) === 1;
      }
      __name(isOnePointZero, "isOnePointZero");
      function isPercentage(n) {
        return typeof n === "string" && n.indexOf("%") != -1;
      }
      __name(isPercentage, "isPercentage");
      function pad2(c) {
        return c.length == 1 ? "0" + c : "" + c;
      }
      __name(pad2, "pad2");
      function convertToPercentage(n) {
        if (n <= 1) {
          n = n * 100 + "%";
        }
        return n;
      }
      __name(convertToPercentage, "convertToPercentage");
      function convertDecimalToHex(d) {
        return Math.round(parseFloat(d) * 255).toString(16);
      }
      __name(convertDecimalToHex, "convertDecimalToHex");
      function convertHexToDecimal(h) {
        return parseIntFromHex(h) / 255;
      }
      __name(convertHexToDecimal, "convertHexToDecimal");
      var matchers = function() {
        var CSS_INTEGER = "[-\\+]?\\d+%?";
        var CSS_NUMBER = "[-\\+]?\\d*\\.\\d+%?";
        var CSS_UNIT = "(?:" + CSS_NUMBER + ")|(?:" + CSS_INTEGER + ")";
        var PERMISSIVE_MATCH3 = "[\\s|\\(]+(" + CSS_UNIT + ")[,|\\s]+(" + CSS_UNIT + ")[,|\\s]+(" + CSS_UNIT + ")\\s*\\)?";
        var PERMISSIVE_MATCH4 = "[\\s|\\(]+(" + CSS_UNIT + ")[,|\\s]+(" + CSS_UNIT + ")[,|\\s]+(" + CSS_UNIT + ")[,|\\s]+(" + CSS_UNIT + ")\\s*\\)?";
        return {
          CSS_UNIT: new RegExp(CSS_UNIT),
          rgb: new RegExp("rgb" + PERMISSIVE_MATCH3),
          rgba: new RegExp("rgba" + PERMISSIVE_MATCH4),
          hsl: new RegExp("hsl" + PERMISSIVE_MATCH3),
          hsla: new RegExp("hsla" + PERMISSIVE_MATCH4),
          hsv: new RegExp("hsv" + PERMISSIVE_MATCH3),
          hsva: new RegExp("hsva" + PERMISSIVE_MATCH4),
          hex3: /^#?([0-9a-fA-F]{1})([0-9a-fA-F]{1})([0-9a-fA-F]{1})$/,
          hex6: /^#?([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/,
          hex4: /^#?([0-9a-fA-F]{1})([0-9a-fA-F]{1})([0-9a-fA-F]{1})([0-9a-fA-F]{1})$/,
          hex8: /^#?([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/
        };
      }();
      function isValidCSSUnit(color) {
        return !!matchers.CSS_UNIT.exec(color);
      }
      __name(isValidCSSUnit, "isValidCSSUnit");
      function stringInputToObject(color) {
        color = color.replace(trimLeft, "").replace(trimRight, "").toLowerCase();
        var named = false;
        if (names[color]) {
          color = names[color];
          named = true;
        } else if (color == "transparent") {
          return {
            r: 0,
            g: 0,
            b: 0,
            a: 0,
            format: "name"
          };
        }
        var match;
        if (match = matchers.rgb.exec(color)) {
          return {
            r: match[1],
            g: match[2],
            b: match[3]
          };
        }
        if (match = matchers.rgba.exec(color)) {
          return {
            r: match[1],
            g: match[2],
            b: match[3],
            a: match[4]
          };
        }
        if (match = matchers.hsl.exec(color)) {
          return {
            h: match[1],
            s: match[2],
            l: match[3]
          };
        }
        if (match = matchers.hsla.exec(color)) {
          return {
            h: match[1],
            s: match[2],
            l: match[3],
            a: match[4]
          };
        }
        if (match = matchers.hsv.exec(color)) {
          return {
            h: match[1],
            s: match[2],
            v: match[3]
          };
        }
        if (match = matchers.hsva.exec(color)) {
          return {
            h: match[1],
            s: match[2],
            v: match[3],
            a: match[4]
          };
        }
        if (match = matchers.hex8.exec(color)) {
          return {
            r: parseIntFromHex(match[1]),
            g: parseIntFromHex(match[2]),
            b: parseIntFromHex(match[3]),
            a: convertHexToDecimal(match[4]),
            format: named ? "name" : "hex8"
          };
        }
        if (match = matchers.hex6.exec(color)) {
          return {
            r: parseIntFromHex(match[1]),
            g: parseIntFromHex(match[2]),
            b: parseIntFromHex(match[3]),
            format: named ? "name" : "hex"
          };
        }
        if (match = matchers.hex4.exec(color)) {
          return {
            r: parseIntFromHex(match[1] + "" + match[1]),
            g: parseIntFromHex(match[2] + "" + match[2]),
            b: parseIntFromHex(match[3] + "" + match[3]),
            a: convertHexToDecimal(match[4] + "" + match[4]),
            format: named ? "name" : "hex8"
          };
        }
        if (match = matchers.hex3.exec(color)) {
          return {
            r: parseIntFromHex(match[1] + "" + match[1]),
            g: parseIntFromHex(match[2] + "" + match[2]),
            b: parseIntFromHex(match[3] + "" + match[3]),
            format: named ? "name" : "hex"
          };
        }
        return false;
      }
      __name(stringInputToObject, "stringInputToObject");
      function validateWCAG2Parms(parms) {
        var level, size;
        parms = parms || {
          level: "AA",
          size: "small"
        };
        level = (parms.level || "AA").toUpperCase();
        size = (parms.size || "small").toLowerCase();
        if (level !== "AA" && level !== "AAA") {
          level = "AA";
        }
        if (size !== "small" && size !== "large") {
          size = "small";
        }
        return {
          level,
          size
        };
      }
      __name(validateWCAG2Parms, "validateWCAG2Parms");
      return tinycolor;
    });
  }
});

// node_modules/tinygradient/index.js
var require_tinygradient = __commonJS({
  "node_modules/tinygradient/index.js"(exports, module) {
    init_esbuild_shims();
    var tinycolor = require_tinycolor();
    var RGBA_MAX = { r: 256, g: 256, b: 256, a: 1 };
    var HSVA_MAX = { h: 360, s: 1, v: 1, a: 1 };
    function stepize(start, end, steps) {
      let step = {};
      for (let k in start) {
        if (start.hasOwnProperty(k)) {
          step[k] = steps === 0 ? 0 : (end[k] - start[k]) / steps;
        }
      }
      return step;
    }
    __name(stepize, "stepize");
    function interpolate(step, start, i, max) {
      let color = {};
      for (let k in start) {
        if (start.hasOwnProperty(k)) {
          color[k] = step[k] * i + start[k];
          color[k] = color[k] < 0 ? color[k] + max[k] : max[k] !== 1 ? color[k] % max[k] : color[k];
        }
      }
      return color;
    }
    __name(interpolate, "interpolate");
    function interpolateRgb(stop1, stop2, steps) {
      const start = stop1.color.toRgb();
      const end = stop2.color.toRgb();
      const step = stepize(start, end, steps);
      let gradient = [stop1.color];
      for (let i = 1; i < steps; i++) {
        const color = interpolate(step, start, i, RGBA_MAX);
        gradient.push(tinycolor(color));
      }
      return gradient;
    }
    __name(interpolateRgb, "interpolateRgb");
    function interpolateHsv(stop1, stop2, steps, mode) {
      const start = stop1.color.toHsv();
      const end = stop2.color.toHsv();
      if (start.s === 0 || end.s === 0) {
        return interpolateRgb(stop1, stop2, steps);
      }
      let trigonometric;
      if (typeof mode === "boolean") {
        trigonometric = mode;
      } else {
        const trigShortest = start.h < end.h && end.h - start.h < 180 || start.h > end.h && start.h - end.h > 180;
        trigonometric = mode === "long" && trigShortest || mode === "short" && !trigShortest;
      }
      const step = stepize(start, end, steps);
      let gradient = [stop1.color];
      let diff;
      if (start.h <= end.h && !trigonometric || start.h >= end.h && trigonometric) {
        diff = end.h - start.h;
      } else if (trigonometric) {
        diff = 360 - end.h + start.h;
      } else {
        diff = 360 - start.h + end.h;
      }
      step.h = Math.pow(-1, trigonometric ? 1 : 0) * Math.abs(diff) / steps;
      for (let i = 1; i < steps; i++) {
        const color = interpolate(step, start, i, HSVA_MAX);
        gradient.push(tinycolor(color));
      }
      return gradient;
    }
    __name(interpolateHsv, "interpolateHsv");
    function computeSubsteps(stops, steps) {
      const l = stops.length;
      steps = parseInt(steps, 10);
      if (isNaN(steps) || steps < 2) {
        throw new Error("Invalid number of steps (< 2)");
      }
      if (steps < l) {
        throw new Error("Number of steps cannot be inferior to number of stops");
      }
      let substeps = [];
      for (let i = 1; i < l; i++) {
        const step = (steps - 1) * (stops[i].pos - stops[i - 1].pos);
        substeps.push(Math.max(1, Math.round(step)));
      }
      let totalSubsteps = 1;
      for (let n = l - 1; n--; ) totalSubsteps += substeps[n];
      while (totalSubsteps !== steps) {
        if (totalSubsteps < steps) {
          const min = Math.min.apply(null, substeps);
          substeps[substeps.indexOf(min)]++;
          totalSubsteps++;
        } else {
          const max = Math.max.apply(null, substeps);
          substeps[substeps.indexOf(max)]--;
          totalSubsteps--;
        }
      }
      return substeps;
    }
    __name(computeSubsteps, "computeSubsteps");
    function computeAt(stops, pos, method, max) {
      if (pos < 0 || pos > 1) {
        throw new Error("Position must be between 0 and 1");
      }
      let start, end;
      for (let i = 0, l = stops.length; i < l - 1; i++) {
        if (pos >= stops[i].pos && pos < stops[i + 1].pos) {
          start = stops[i];
          end = stops[i + 1];
          break;
        }
      }
      if (!start) {
        start = end = stops[stops.length - 1];
      }
      const step = stepize(start.color[method](), end.color[method](), (end.pos - start.pos) * 100);
      const color = interpolate(step, start.color[method](), (pos - start.pos) * 100, max);
      return tinycolor(color);
    }
    __name(computeAt, "computeAt");
    var TinyGradient = class _TinyGradient {
      static {
        __name(this, "TinyGradient");
      }
      /**
       * @param {StopInput[]|ColorInput[]} stops
       * @returns {TinyGradient}
       */
      constructor(stops) {
        if (stops.length < 2) {
          throw new Error("Invalid number of stops (< 2)");
        }
        const havingPositions = stops[0].pos !== void 0;
        let l = stops.length;
        let p = -1;
        let lastColorLess = false;
        this.stops = stops.map((stop, i) => {
          const hasPosition = stop.pos !== void 0;
          if (havingPositions ^ hasPosition) {
            throw new Error("Cannot mix positionned and not posionned color stops");
          }
          if (hasPosition) {
            const hasColor = stop.color !== void 0;
            if (!hasColor && (lastColorLess || i === 0 || i === l - 1)) {
              throw new Error("Cannot define two consecutive position-only stops");
            }
            lastColorLess = !hasColor;
            stop = {
              color: hasColor ? tinycolor(stop.color) : null,
              colorLess: !hasColor,
              pos: stop.pos
            };
            if (stop.pos < 0 || stop.pos > 1) {
              throw new Error("Color stops positions must be between 0 and 1");
            } else if (stop.pos < p) {
              throw new Error("Color stops positions are not ordered");
            }
            p = stop.pos;
          } else {
            stop = {
              color: tinycolor(stop.color !== void 0 ? stop.color : stop),
              pos: i / (l - 1)
            };
          }
          return stop;
        });
        if (this.stops[0].pos !== 0) {
          this.stops.unshift({
            color: this.stops[0].color,
            pos: 0
          });
          l++;
        }
        if (this.stops[l - 1].pos !== 1) {
          this.stops.push({
            color: this.stops[l - 1].color,
            pos: 1
          });
        }
      }
      /**
       * Return new instance with reversed stops
       * @return {TinyGradient}
       */
      reverse() {
        let stops = [];
        this.stops.forEach(function(stop) {
          stops.push({
            color: stop.color,
            pos: 1 - stop.pos
          });
        });
        return new _TinyGradient(stops.reverse());
      }
      /**
       * Return new instance with looped stops
       * @return {TinyGradient}
       */
      loop() {
        let stops1 = [];
        let stops2 = [];
        this.stops.forEach((stop) => {
          stops1.push({
            color: stop.color,
            pos: stop.pos / 2
          });
        });
        this.stops.slice(0, -1).forEach((stop) => {
          stops2.push({
            color: stop.color,
            pos: 1 - stop.pos / 2
          });
        });
        return new _TinyGradient(stops1.concat(stops2.reverse()));
      }
      /**
       * Generate gradient with RGBa interpolation
       * @param {number} steps
       * @return {tinycolor[]}
       */
      rgb(steps) {
        const substeps = computeSubsteps(this.stops, steps);
        let gradient = [];
        this.stops.forEach((stop, i) => {
          if (stop.colorLess) {
            stop.color = interpolateRgb(this.stops[i - 1], this.stops[i + 1], 2)[1];
          }
        });
        for (let i = 0, l = this.stops.length; i < l - 1; i++) {
          const rgb = interpolateRgb(this.stops[i], this.stops[i + 1], substeps[i]);
          gradient.splice(gradient.length, 0, ...rgb);
        }
        gradient.push(this.stops[this.stops.length - 1].color);
        return gradient;
      }
      /**
       * Generate gradient with HSVa interpolation
       * @param {number} steps
       * @param {boolean|'long'|'short'} [mode=false]
       *    - false to step in clockwise
       *    - true to step in trigonometric order
       *    - 'short' to use the shortest way
       *    - 'long' to use the longest way
       * @return {tinycolor[]}
       */
      hsv(steps, mode) {
        const substeps = computeSubsteps(this.stops, steps);
        let gradient = [];
        this.stops.forEach((stop, i) => {
          if (stop.colorLess) {
            stop.color = interpolateHsv(this.stops[i - 1], this.stops[i + 1], 2, mode)[1];
          }
        });
        for (let i = 0, l = this.stops.length; i < l - 1; i++) {
          const hsv = interpolateHsv(this.stops[i], this.stops[i + 1], substeps[i], mode);
          gradient.splice(gradient.length, 0, ...hsv);
        }
        gradient.push(this.stops[this.stops.length - 1].color);
        return gradient;
      }
      /**
       * Generate CSS3 command (no prefix) for this gradient
       * @param {String} [mode=linear] - 'linear' or 'radial'
       * @param {String} [direction] - default is 'to right' or 'ellipse at center'
       * @return {String}
       */
      css(mode, direction) {
        mode = mode || "linear";
        direction = direction || (mode === "linear" ? "to right" : "ellipse at center");
        let css = mode + "-gradient(" + direction;
        this.stops.forEach(function(stop) {
          css += ", " + (stop.colorLess ? "" : stop.color.toRgbString() + " ") + stop.pos * 100 + "%";
        });
        css += ")";
        return css;
      }
      /**
       * Returns the color at specific position with RGBa interpolation
       * @param {number} pos, between 0 and 1
       * @return {tinycolor}
       */
      rgbAt(pos) {
        return computeAt(this.stops, pos, "toRgb", RGBA_MAX);
      }
      /**
       * Returns the color at specific position with HSVa interpolation
       * @param {number} pos, between 0 and 1
       * @return {tinycolor}
       */
      hsvAt(pos) {
        return computeAt(this.stops, pos, "toHsv", HSVA_MAX);
      }
    };
    module.exports = function(stops) {
      if (arguments.length === 1) {
        if (!Array.isArray(arguments[0])) {
          throw new Error('"stops" is not an array');
        }
        stops = arguments[0];
      } else {
        stops = Array.prototype.slice.call(arguments);
      }
      return new TinyGradient(stops);
    };
  }
});

// node_modules/gradient-string/index.js
var require_gradient_string = __commonJS({
  "node_modules/gradient-string/index.js"(exports, module) {
    "use strict";
    init_esbuild_shims();
    var chalk = require_source();
    var tinygradient = require_tinygradient();
    var forbiddenChars = /\s/g;
    function InitGradient(...args) {
      const grad = tinygradient.apply(this, args);
      const ret = /* @__PURE__ */ __name((str, opts) => applyGradient(str ? str.toString() : "", grad, opts), "ret");
      ret.multiline = (str, opts) => multilineGradient(str ? str.toString() : "", grad, opts);
      return ret;
    }
    __name(InitGradient, "InitGradient");
    var getColors = /* @__PURE__ */ __name((gradient, options, count) => options.interpolation.toLowerCase() === "hsv" ? gradient.hsv(count, options.hsvSpin.toLowerCase()) : gradient.rgb(count), "getColors");
    function applyGradient(str, gradient, opts) {
      const options = validateOptions(opts);
      const colorsCount = Math.max(str.replace(forbiddenChars, "").length, gradient.stops.length);
      const colors = getColors(gradient, options, colorsCount);
      let result = "";
      for (const s of str) {
        result += s.match(forbiddenChars) ? s : chalk.hex(colors.shift().toHex())(s);
      }
      return result;
    }
    __name(applyGradient, "applyGradient");
    function multilineGradient(str, gradient, opts) {
      const options = validateOptions(opts);
      const lines = str.split("\n");
      const maxLength = Math.max.apply(null, lines.map((l) => l.length).concat([gradient.stops.length]));
      const colors = getColors(gradient, options, maxLength);
      const results = [];
      for (const line of lines) {
        const lineColors = colors.slice(0);
        let lineResult = "";
        for (const l of line) {
          lineResult += chalk.hex(lineColors.shift().toHex())(l);
        }
        results.push(lineResult);
      }
      return results.join("\n");
    }
    __name(multilineGradient, "multilineGradient");
    function validateOptions(opts) {
      const options = { interpolation: "rgb", hsvSpin: "short", ...opts };
      if (opts !== void 0 && typeof opts !== "object") {
        throw new TypeError(`Expected \`options\` to be an \`object\`, got \`${typeof opts}\``);
      }
      if (typeof options.interpolation !== "string") {
        throw new TypeError(`Expected \`options.interpolation\` to be a \`string\`, got \`${typeof options.interpolation}\``);
      }
      if (options.interpolation.toLowerCase() === "hsv" && typeof options.hsvSpin !== "string") {
        throw new TypeError(`Expected \`options.hsvSpin\` to be a \`string\`, got \`${typeof options.hsvSpin}\``);
      }
      return options;
    }
    __name(validateOptions, "validateOptions");
    var aliases = {
      atlas: { colors: ["#feac5e", "#c779d0", "#4bc0c8"], options: {} },
      cristal: { colors: ["#bdfff3", "#4ac29a"], options: {} },
      teen: { colors: ["#77a1d3", "#79cbca", "#e684ae"], options: {} },
      mind: { colors: ["#473b7b", "#3584a7", "#30d2be"], options: {} },
      morning: { colors: ["#ff5f6d", "#ffc371"], options: { interpolation: "hsv" } },
      vice: { colors: ["#5ee7df", "#b490ca"], options: { interpolation: "hsv" } },
      passion: { colors: ["#f43b47", "#453a94"], options: {} },
      fruit: { colors: ["#ff4e50", "#f9d423"], options: {} },
      instagram: { colors: ["#833ab4", "#fd1d1d", "#fcb045"], options: {} },
      retro: { colors: ["#3f51b1", "#5a55ae", "#7b5fac", "#8f6aae", "#a86aa4", "#cc6b8e", "#f18271", "#f3a469", "#f7c978"], options: {} },
      summer: { colors: ["#fdbb2d", "#22c1c3"], options: {} },
      rainbow: { colors: ["#ff0000", "#ff0100"], options: { interpolation: "hsv", hsvSpin: "long" } },
      pastel: { colors: ["#74ebd5", "#74ecd5"], options: { interpolation: "hsv", hsvSpin: "long" } }
    };
    module.exports = InitGradient;
    for (const a in aliases) {
      module.exports[a] = (str) => new InitGradient(aliases[a].colors)(str, aliases[a].options);
      module.exports[a].multiline = (str) => new InitGradient(aliases[a].colors).multiline(str, aliases[a].options);
    }
  }
});

// packages/cli/src/ui/contexts/ConfigContext.tsx
init_esbuild_shims();
var import_react = __toESM(require_react(), 1);
var ConfigContext = import_react.default.createContext(void 0);
var useConfig = /* @__PURE__ */ __name(() => {
  const context = (0, import_react.useContext)(ConfigContext);
  if (context === void 0) {
    throw new Error("useConfig must be used within a ConfigProvider");
  }
  return context;
}, "useConfig");

// packages/cli/src/ui/components/SessionPicker.tsx
init_esbuild_shims();

// packages/cli/src/ui/hooks/useSessionPicker.ts
init_esbuild_shims();
var import_react3 = __toESM(require_react(), 1);

// packages/cli/src/ui/utils/sessionPickerUtils.ts
init_esbuild_shims();
var graphemeSegmenter = new Intl.Segmenter(void 0, {
  granularity: "grapheme"
});
var SESSION_PAGE_SIZE = 20;
function truncateText(text, maxWidth) {
  const widthLimit = Math.max(0, Math.floor(maxWidth));
  if (widthLimit === 0) {
    return "";
  }
  const firstLine = text.split(/\r?\n/, 1)[0];
  if (getCachedStringWidth(firstLine) <= widthLimit) {
    return firstLine;
  }
  if (widthLimit <= 3) {
    return truncateToDisplayWidth(firstLine, widthLimit);
  }
  return `${truncateToDisplayWidth(firstLine, widthLimit - 3)}...`;
}
__name(truncateText, "truncateText");
function truncateToDisplayWidth(text, maxWidth) {
  let width = 0;
  let result = "";
  for (const { segment } of graphemeSegmenter.segment(text)) {
    const segmentWidth = getCachedStringWidth(segment);
    if (width + segmentWidth > maxWidth) {
      break;
    }
    result += segment;
    width += segmentWidth;
  }
  return result;
}
__name(truncateToDisplayWidth, "truncateToDisplayWidth");
function matchesQuery(session, normalizedQuery) {
  if (!normalizedQuery) return true;
  const haystacks = [
    session.customTitle,
    session.prompt,
    session.goalObjective,
    session.gitBranch
  ];
  for (const h of haystacks) {
    if (h && h.toLowerCase().includes(normalizedQuery)) return true;
  }
  return false;
}
__name(matchesQuery, "matchesQuery");
function filterSessions(sessions, filterByBranch, currentBranch, query) {
  const normalizedQuery = query?.toLowerCase().trim() ?? "";
  return sessions.filter((session) => {
    if (filterByBranch && currentBranch) {
      if (session.gitBranch !== currentBranch) return false;
    }
    return matchesQuery(session, normalizedQuery);
  });
}
__name(filterSessions, "filterSessions");
function formatMessageCount(count) {
  return count === 1 ? "1 message" : `${count} messages`;
}
__name(formatMessageCount, "formatMessageCount");

// packages/cli/src/ui/hooks/useSessionSearchInput.ts
init_esbuild_shims();
var import_react2 = __toESM(require_react(), 1);
var DELETION_KEY_NAMES = /* @__PURE__ */ new Set(["backspace", "delete"]);
var graphemeSegmenter2 = new Intl.Segmenter(void 0, {
  granularity: "grapheme"
});
function splitGraphemes(value) {
  return Array.from(graphemeSegmenter2.segment(value), ({ segment }) => segment);
}
__name(splitGraphemes, "splitGraphemes");
function removeLastGrapheme(value) {
  const graphemes = splitGraphemes(value);
  graphemes.pop();
  return graphemes.join("");
}
__name(removeLastGrapheme, "removeLastGrapheme");
var isDeletionKey = /* @__PURE__ */ __name((key) => DELETION_KEY_NAMES.has(key.name) || !key.ctrl && !key.meta && (key.sequence === "\x7F" || key.sequence === "\b"), "isDeletionKey");
function isPrintableSearchChar(key) {
  if (key.ctrl || key.meta || key.paste) return false;
  const graphemes = splitGraphemes(key.sequence);
  if (graphemes.length !== 1) return false;
  const code = graphemes[0].codePointAt(0);
  if (code === void 0) return false;
  return code >= 32 && code !== 127 && (code < 128 || code > 159);
}
__name(isPrintableSearchChar, "isPrintableSearchChar");
function useSessionSearchInput(options) {
  const { onExitToList } = options;
  const [searchQuery, rawSetSearchQuery] = (0, import_react2.useState)("");
  const searchQueryRef = (0, import_react2.useRef)("");
  const onExitToListRef = (0, import_react2.useRef)(onExitToList);
  onExitToListRef.current = onExitToList;
  const setSearchQuery = (0, import_react2.useCallback)(
    (nextValue) => {
      const prev = searchQueryRef.current;
      const next = typeof nextValue === "function" ? nextValue(prev) : nextValue;
      searchQueryRef.current = next;
      rawSetSearchQuery(next);
      if (prev !== "" && next === "") {
        onExitToListRef.current();
      }
    },
    []
  );
  const handleSearchKey = (0, import_react2.useCallback)(
    (key) => {
      const { name, sequence, ctrl } = key;
      if (name === "escape") {
        setSearchQuery("");
        return;
      }
      if (isDeletionKey(key)) {
        setSearchQuery(removeLastGrapheme);
        return;
      }
      if (ctrl && (name === "u" || name === "l")) {
        setSearchQuery("");
        return;
      }
      if (isPrintableSearchChar(key)) {
        setSearchQuery((q) => q + sequence);
        return;
      }
    },
    [setSearchQuery]
  );
  return { searchQuery, setSearchQuery, handleSearchKey };
}
__name(useSessionSearchInput, "useSessionSearchInput");

// packages/cli/src/ui/hooks/useSessionPicker.ts
function useSessionPicker({
  sessionService,
  currentBranch,
  onSelect,
  onCancel,
  maxVisibleItems,
  centerSelection = false,
  initialSessions,
  isActive = true,
  enablePreview = false,
  enableMultiSelect = false,
  onConfirmMulti,
  disabledIds
}) {
  if (enableMultiSelect && enablePreview) {
    throw new Error(
      "useSessionPicker: enableMultiSelect and enablePreview both bind Space; pick one or wire a different chord."
    );
  }
  if (enableMultiSelect && !onConfirmMulti) {
    throw new Error(
      "useSessionPicker: enableMultiSelect requires onConfirmMulti."
    );
  }
  const hasInitialSessions = initialSessions !== void 0;
  const [selectedIndex, setSelectedIndex] = (0, import_react3.useState)(0);
  const [sessionState, setSessionState] = (0, import_react3.useState)(
    hasInitialSessions ? { sessions: initialSessions, hasMore: false, nextCursor: void 0 } : { sessions: [], hasMore: true, nextCursor: void 0 }
  );
  const [filterByBranch, setFilterByBranch] = (0, import_react3.useState)(false);
  const [isLoading, setIsLoading] = (0, import_react3.useState)(!hasInitialSessions);
  const [followScrollOffset, setFollowScrollOffset] = (0, import_react3.useState)(0);
  const [viewMode, setViewMode] = (0, import_react3.useState)(
    "list"
  );
  const [previewSessionId, setPreviewSessionId] = (0, import_react3.useState)(null);
  const [checkedIds, setCheckedIds] = (0, import_react3.useState)(
    () => /* @__PURE__ */ new Set()
  );
  const disabledIdSet = (0, import_react3.useMemo)(
    () => new Set(disabledIds ?? []),
    [disabledIds]
  );
  const toggleChecked = (0, import_react3.useCallback)(
    (sessionId) => {
      if (disabledIdSet.has(sessionId)) return;
      setCheckedIds((prev) => {
        const next = new Set(prev);
        if (next.has(sessionId)) {
          next.delete(sessionId);
        } else {
          next.add(sessionId);
        }
        return next;
      });
    },
    [disabledIdSet]
  );
  const exitPreview = (0, import_react3.useCallback)(() => {
    setViewMode("list");
    setPreviewSessionId(null);
  }, []);
  const onExitToList = (0, import_react3.useCallback)(() => {
    setViewMode("list");
  }, []);
  const { searchQuery, setSearchQuery, handleSearchKey } = useSessionSearchInput({ onExitToList });
  const isLoadingMoreRef = (0, import_react3.useRef)(false);
  const filteredSessions = (0, import_react3.useMemo)(
    () => filterSessions(
      sessionState.sessions,
      filterByBranch,
      currentBranch,
      searchQuery
    ),
    [sessionState.sessions, filterByBranch, currentBranch, searchQuery]
  );
  const scrollOffset = (0, import_react3.useMemo)(() => {
    if (centerSelection) {
      if (filteredSessions.length <= maxVisibleItems) {
        return 0;
      }
      const halfVisible = Math.floor(maxVisibleItems / 2);
      let offset = selectedIndex - halfVisible;
      offset = Math.max(0, offset);
      offset = Math.min(filteredSessions.length - maxVisibleItems, offset);
      return offset;
    }
    return followScrollOffset;
  }, [
    centerSelection,
    filteredSessions.length,
    followScrollOffset,
    maxVisibleItems,
    selectedIndex
  ]);
  const visibleSessions = (0, import_react3.useMemo)(
    () => filteredSessions.slice(scrollOffset, scrollOffset + maxVisibleItems),
    [filteredSessions, maxVisibleItems, scrollOffset]
  );
  const showScrollUp = scrollOffset > 0;
  const showScrollDown = scrollOffset + maxVisibleItems < filteredSessions.length;
  (0, import_react3.useEffect)(() => {
    if (!sessionService || hasInitialSessions) {
      return;
    }
    const loadInitialSessions = /* @__PURE__ */ __name(async () => {
      try {
        const result = await sessionService.listSessions({
          size: SESSION_PAGE_SIZE
        });
        setSessionState({
          sessions: result.items,
          hasMore: result.hasMore,
          nextCursor: result.nextCursor
        });
      } finally {
        setIsLoading(false);
      }
    }, "loadInitialSessions");
    void loadInitialSessions();
  }, [sessionService, hasInitialSessions]);
  const loadMoreSessions = (0, import_react3.useCallback)(async () => {
    if (!sessionService || !sessionState.hasMore || isLoadingMoreRef.current) {
      return;
    }
    isLoadingMoreRef.current = true;
    try {
      const result = await sessionService.listSessions({
        size: SESSION_PAGE_SIZE,
        cursor: sessionState.nextCursor
      });
      setSessionState((prev) => ({
        sessions: [...prev.sessions, ...result.items],
        hasMore: result.hasMore && result.nextCursor !== void 0,
        nextCursor: result.nextCursor
      }));
    } finally {
      isLoadingMoreRef.current = false;
    }
  }, [sessionService, sessionState.hasMore, sessionState.nextCursor]);
  (0, import_react3.useEffect)(() => {
    setSelectedIndex(0);
    setFollowScrollOffset(0);
  }, [filterByBranch, searchQuery]);
  (0, import_react3.useEffect)(() => {
    if (selectedIndex >= filteredSessions.length && filteredSessions.length > 0) {
      setSelectedIndex(filteredSessions.length - 1);
    }
  }, [filteredSessions.length, selectedIndex]);
  (0, import_react3.useEffect)(() => {
    if (isLoading || !sessionState.hasMore || isLoadingMoreRef.current || !centerSelection) {
      return;
    }
    const sentinelVisible = scrollOffset + maxVisibleItems >= filteredSessions.length;
    const shouldLoadMore = filteredSessions.length === 0 || sentinelVisible;
    if (shouldLoadMore) {
      void loadMoreSessions();
    }
  }, [
    centerSelection,
    filteredSessions.length,
    isLoading,
    loadMoreSessions,
    maxVisibleItems,
    scrollOffset,
    sessionState.hasMore
  ]);
  const moveSelection = (0, import_react3.useCallback)(
    (delta) => {
      if (filteredSessions.length === 0) return;
      if (delta === -1) {
        setSelectedIndex((prev) => {
          const newIndex = Math.max(0, prev - 1);
          if (!centerSelection && newIndex < followScrollOffset) {
            setFollowScrollOffset(newIndex);
          }
          return newIndex;
        });
        return;
      }
      setSelectedIndex((prev) => {
        const newIndex = Math.min(filteredSessions.length - 1, prev + 1);
        if (!centerSelection && newIndex >= followScrollOffset + maxVisibleItems) {
          setFollowScrollOffset(newIndex - maxVisibleItems + 1);
        }
        if (!centerSelection && newIndex >= filteredSessions.length - 3) {
          void loadMoreSessions();
        }
        return newIndex;
      });
    },
    [
      centerSelection,
      filteredSessions.length,
      followScrollOffset,
      loadMoreSessions,
      maxVisibleItems
    ]
  );
  useKeypress(
    (key) => {
      const { name, sequence, ctrl } = key;
      if (ctrl && name === "c") {
        onCancel();
        return;
      }
      if (name === "return") {
        if (viewMode === "search") {
          if (filteredSessions.length === 0) {
            return;
          }
          setViewMode("list");
          return;
        }
        if (enableMultiSelect && checkedIds.size > 0 && onConfirmMulti) {
          const orderedIds = sessionState.sessions.map((s) => s.sessionId).filter((id) => checkedIds.has(id) && !disabledIdSet.has(id));
          if (orderedIds.length > 0) {
            onConfirmMulti(orderedIds);
            return;
          }
          return;
        }
        const session = filteredSessions[selectedIndex];
        if (session && !disabledIdSet.has(session.sessionId)) {
          onSelect(session.sessionId);
        }
        return;
      }
      const isNavUp = name === "up" || ctrl && name === "p";
      const isNavDown = name === "down" || ctrl && name === "n";
      if (isNavUp || isNavDown) {
        const delta = isNavUp ? -1 : 1;
        const inSearch = viewMode === "search";
        if (inSearch) {
          if (filteredSessions.length === 0) return;
          setViewMode("list");
          return;
        }
        if (delta === -1 && filteredSessions.length > 0 && selectedIndex === 0) {
          setViewMode("search");
          return;
        }
        moveSelection(delta);
        return;
      }
      if (viewMode === "search") {
        handleSearchKey(key);
        return;
      }
      if (name === "escape") {
        if (searchQuery !== "") {
          setSearchQuery("");
        } else {
          onCancel();
        }
        return;
      }
      if (name === "k") {
        moveSelection(-1);
        return;
      }
      if (name === "j") {
        moveSelection(1);
        return;
      }
      if (name === "space") {
        if (enableMultiSelect) {
          const session = filteredSessions[selectedIndex];
          if (session) {
            toggleChecked(session.sessionId);
          }
          return;
        }
        if (enablePreview) {
          const session = filteredSessions[selectedIndex];
          if (session) {
            setPreviewSessionId(session.sessionId);
            setViewMode("preview");
          }
          return;
        }
      }
      if (ctrl && (name === "b" || name === "B")) {
        if (currentBranch) {
          setFilterByBranch((prev) => !prev);
        }
        return;
      }
      if (sequence === "/") {
        setViewMode("search");
        return;
      }
      if (isPrintableSearchChar(key)) {
        if (sequence === " ") {
          return;
        }
        setViewMode("search");
        setSearchQuery((q) => q + sequence);
      }
    },
    { isActive: isActive && viewMode !== "preview" }
  );
  return {
    selectedIndex,
    sessionState,
    filteredSessions,
    filterByBranch,
    isLoading,
    scrollOffset,
    visibleSessions,
    showScrollUp,
    showScrollDown,
    loadMoreSessions,
    viewMode,
    previewSessionId,
    exitPreview,
    checkedIds,
    toggleChecked,
    disabledIdSet,
    searchQuery,
    isSearchActive: viewMode === "search"
  };
}
__name(useSessionPicker, "useSessionPicker");

// packages/cli/src/ui/components/SessionPreview.tsx
init_esbuild_shims();
var import_react23 = __toESM(require_react(), 1);

// packages/cli/src/ui/components/HistoryItemDisplay.tsx
init_esbuild_shims();
var import_react22 = __toESM(require_react(), 1);

// packages/cli/src/ui/components/messages/ToolGroupMessage.tsx
init_esbuild_shims();
var import_react6 = __toESM(require_react(), 1);

// packages/cli/src/ui/components/messages/InlineParallelAgentsDisplay.tsx
init_esbuild_shims();
var import_react4 = __toESM(require_react(), 1);
var import_jsx_runtime = __toESM(require_jsx_runtime(), 1);
function deriveAgentId(toolCall, resultDisplay) {
  return `${resultDisplay.subagentName}-${toolCall.callId}`;
}
__name(deriveAgentId, "deriveAgentId");
function isAgentResult(rd) {
  return typeof rd === "object" && rd !== null && "type" in rd && rd.type === "task_execution";
}
__name(isAgentResult, "isAgentResult");
function activityLabel(row) {
  const last = row.recentActivity;
  if (!last) return "";
  const display = localizeToolDisplayName(
    TOOL_DISPLAY_BY_NAME[last.name] ?? last.name
  );
  const desc = last.description?.replace(/\s*\n\s*/g, " ").trim();
  return desc ? `${display} ${desc}` : display;
}
__name(activityLabel, "activityLabel");
function statusGlyph(status) {
  switch (status) {
    case "running":
    case "background":
      return { glyph: ICON.CIRCLE_EMPTY, color: theme.status.warning };
    case "completed":
      return { glyph: "\u2714", color: theme.status.success };
    case "failed":
      return { glyph: "\u2716", color: theme.status.error };
    case "cancelled":
      return { glyph: "\u2716", color: theme.status.warning };
    default:
      return { glyph: "\xB7", color: theme.text.secondary };
  }
}
__name(statusGlyph, "statusGlyph");
function elapsedLabel(row, now) {
  let ms;
  if (row.startTime !== void 0) {
    const end = row.endTime ?? now;
    ms = Math.max(0, end - row.startTime);
  } else if (row.fallbackElapsedMs !== void 0) {
    ms = Math.max(0, row.fallbackElapsedMs);
  }
  if (ms === void 0) return "";
  return formatDuration(Math.floor(ms / 1e3) * 1e3, {
    hideTrailingZeros: true
  });
}
__name(elapsedLabel, "elapsedLabel");
var NAME_COL_WIDTH = 26;
function truncateMiddle(input, max) {
  if (input.length <= max) return input;
  if (max <= 1) return input.slice(0, max);
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return `${input.slice(0, head)}\u2026${input.slice(input.length - tail)}`;
}
__name(truncateMiddle, "truncateMiddle");
var InlineParallelAgentsDisplay = /* @__PURE__ */ __name(({ toolCalls, contentWidth, totalAgentCount, availableTerminalHeight }) => {
  const config = (0, import_react4.useContext)(ConfigContext);
  const agentEntries = (0, import_react4.useMemo)(() => {
    const out = [];
    for (const tc of toolCalls) {
      if (isAgentResult(tc.resultDisplay)) {
        out.push({ toolCall: tc, result: tc.resultDisplay });
      }
    }
    return out;
  }, [toolCalls]);
  const [now, setNow] = (0, import_react4.useState)(() => Date.now());
  const hasLiveAgent = (0, import_react4.useMemo)(
    () => agentEntries.some(
      (e) => e.result.status === "running" || e.result.status === "background"
    ),
    [agentEntries]
  );
  (0, import_react4.useEffect)(() => {
    if (!hasLiveAgent) return;
    const id = setInterval(() => setNow(Date.now()), 1e3);
    return () => clearInterval(id);
  }, [hasLiveAgent]);
  const rows = (0, import_react4.useMemo)(() => {
    const registry = config?.getBackgroundTaskRegistry();
    void now;
    return agentEntries.map(({ toolCall, result }) => {
      const agentId = deriveAgentId(toolCall, result);
      const live = registry?.get(agentId);
      const recent = live?.recentActivities?.at(-1);
      return {
        agentId,
        callId: toolCall.callId,
        name: result.taskDescription || result.subagentName,
        status: result.status,
        startTime: live?.startTime,
        endTime: live?.endTime,
        fallbackElapsedMs: result.executionSummary?.totalDurationMs,
        recentActivity: recent ? { name: recent.name, description: recent.description } : void 0,
        tokenCount: result.tokenCount ?? live?.stats?.outputTokens ?? result.executionSummary?.outputTokens
      };
    });
  }, [agentEntries, config, now]);
  if (rows.length === 0) return null;
  const doneCount = rows.filter(
    (r) => r.status === "completed" || r.status === "failed" || r.status === "cancelled"
  ).length;
  const total = totalAgentCount ?? rows.length;
  const headerLabel = `Parallel agents \xB7 ${total} \xB7 ${doneCount}/${total} done`;
  const hasBudget = availableTerminalHeight != null && availableTerminalHeight > 0;
  let overflowCount = 0;
  let visibleRows = rows;
  if (hasBudget && rows.length + 1 > availableTerminalHeight) {
    if (availableTerminalHeight >= 2) {
      const rowsFit = availableTerminalHeight - 2;
      overflowCount = rows.length - rowsFit;
      visibleRows = rowsFit > 0 ? rows.slice(rows.length - rowsFit) : [];
    } else {
      visibleRows = [];
    }
  }
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Box_default, { flexDirection: "column", width: contentWidth, paddingX: 1, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Box_default, { children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Text, { bold: true, color: theme.text.accent, wrap: "truncate-end", children: headerLabel }) }),
    overflowCount > 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Box_default, { children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Text, { color: theme.text.secondary, wrap: "truncate-end", children: [
      "\u2026 +",
      overflowCount,
      " more ",
      overflowCount === 1 ? "agent" : "agents"
    ] }) }),
    visibleRows.map((row) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(AgentRow, { row, now }, row.agentId))
  ] });
}, "InlineParallelAgentsDisplay");
var AgentRow = /* @__PURE__ */ __name(({ row, now }) => {
  const { glyph, color } = statusGlyph(row.status);
  const safeName = escapeAnsiCtrlCodes(row.name);
  const displayName = truncateMiddle(safeName, NAME_COL_WIDTH);
  const activity = sanitizeMultilineForDisplay(activityLabel(row));
  const elapsed = elapsedLabel(row, now);
  const tokens = row.tokenCount && row.tokenCount > 0 ? formatTokenCount(row.tokenCount) : "";
  const trailingParts = [];
  if (elapsed) trailingParts.push(elapsed);
  if (tokens) trailingParts.push(`${tokens} tok`);
  const trailing = trailingParts.join(" \xB7 ");
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Box_default, { flexDirection: "row", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Box_default, { flexShrink: 0, marginRight: 1, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Text, { color, wrap: "truncate-end", children: glyph }) }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Box_default, { flexShrink: 0, marginRight: 1, width: NAME_COL_WIDTH, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Text, { wrap: "truncate-end", children: displayName }) }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Box_default, { flexShrink: 1, flexGrow: 1, marginRight: 1, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Text, { color: theme.text.secondary, wrap: "truncate-end", children: activity }) }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Box_default, { flexShrink: 0, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Text, { color: theme.text.secondary, wrap: "truncate-end", children: trailing }) })
  ] });
}, "AgentRow");

// packages/cli/src/ui/hooks/use-show-tool-call-args.ts
init_esbuild_shims();
var import_react5 = __toESM(require_react(), 1);
function useShowToolCallArgs() {
  return (0, import_react5.useContext)(SettingsContext)?.merged.ui?.showToolCallArgs === true;
}
__name(useShowToolCallArgs, "useShowToolCallArgs");

// packages/cli/src/ui/components/messages/ToolGroupMessage.tsx
var import_jsx_runtime2 = __toESM(require_jsx_runtime(), 1);
function isAgentWithPendingConfirmation(rd) {
  return typeof rd === "object" && rd !== null && "type" in rd && rd.type === "task_execution" && rd.pendingConfirmation !== void 0;
}
__name(isAgentWithPendingConfirmation, "isAgentWithPendingConfirmation");
function isRunningAgent(rd) {
  return typeof rd === "object" && rd !== null && "type" in rd && rd.type === "task_execution" && rd.status === "running";
}
__name(isRunningAgent, "isRunningAgent");
function hasInlineImageOutput(tool) {
  return Boolean(tool.images?.length || tool.omittedImageCount);
}
__name(hasInlineImageOutput, "hasInlineImageOutput");
function isSubagentToolEntry(tool) {
  const rd = tool.resultDisplay;
  return typeof rd === "object" && rd !== null && "type" in rd && rd.type === "task_execution";
}
__name(isSubagentToolEntry, "isSubagentToolEntry");
function isPanelOwnedSubagentTool(tool) {
  if (!isSubagentToolEntry(tool)) return false;
  const status = tool.resultDisplay.status;
  return status === "running" || status === "background";
}
__name(isPanelOwnedSubagentTool, "isPanelOwnedSubagentTool");
function isPureParallelAgentGroup(toolCalls) {
  return toolCalls.length >= 2 && toolCalls.every(isSubagentToolEntry);
}
__name(isPureParallelAgentGroup, "isPureParallelAgentGroup");
function isTerminalSubagentTool(tool) {
  if (!isSubagentToolEntry(tool)) return false;
  const status = tool.resultDisplay.status;
  return status === "completed" || status === "failed" || status === "cancelled";
}
__name(isTerminalSubagentTool, "isTerminalSubagentTool");
var HiddenToolDetailsSummary = /* @__PURE__ */ __name(({ toolCalls, contentWidth, expandHint, summaryRef }) => {
  if (toolCalls.length === 0) return null;
  const status = getOverallStatus(toolCalls);
  const activeTool = toolCalls.find((tool) => tool.status === "Confirming" /* Confirming */) ?? toolCalls.find((tool) => tool.status === "Executing" /* Executing */) ?? toolCalls.find((tool) => tool.status === "Pending" /* Pending */) ?? toolCalls[toolCalls.length - 1];
  const names = Array.from(
    new Set(toolCalls.map((tool) => localizeToolDisplayName(tool.name)))
  );
  const label = toolCalls.length === 1 ? names[0] : names.length === 1 ? `${names[0]} \xD7 ${toolCalls.length}` : `${names.join(", ")} \xB7 ${toolCalls.length} tool calls`;
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(Box_default, { ref: summaryRef, flexDirection: "row", width: contentWidth, children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(ToolStatusIndicator, { status, name: activeTool.name }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(Box_default, { flexGrow: 1, children: /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(Text, { bold: true, wrap: "truncate-end", children: [
      label,
      expandHint && /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(Text, { bold: false, dimColor: true, children: [
        " ",
        "\xB7 ",
        expandHint
      ] })
    ] }) }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
      ToolElapsedTime,
      {
        status,
        executionStartTime: activeTool.executionStartTime
      }
    )
  ] });
}, "HiddenToolDetailsSummary");
var ToolGroupMessage = /* @__PURE__ */ __name(({
  toolCalls,
  availableTerminalHeight,
  contentWidth,
  isFocused = true,
  isPending = false,
  activeShellPtyId,
  embeddedShellFocused,
  memoryWriteCount,
  memoryReadCount,
  isUserInitiated,
  fullDetail = false,
  hideDetails = false,
  expandHint,
  summaryRef
}) => {
  const config = useConfig();
  const showToolCallArgs = useShowToolCallArgs();
  const hasConfirmingTool = toolCalls.some(
    (t2) => t2.status === "Confirming" /* Confirming */
  );
  const hasErrorTool = toolCalls.some((t2) => t2.status === "Error" /* Error */);
  const isEmbeddedShellFocused = embeddedShellFocused && toolCalls.some(
    (t2) => t2.ptyId === activeShellPtyId && t2.status === "Executing" /* Executing */
  );
  const toolAwaitingApproval = (0, import_react6.useMemo)(
    () => toolCalls.find((tc) => tc.status === "Confirming" /* Confirming */),
    [toolCalls]
  );
  const isMemoryOnlyGroup = (0, import_react6.useMemo)(
    () => toolCalls.length > 0 && toolCalls.every((t2) => t2.isMemoryOp != null),
    [toolCalls]
  );
  const inlineToolCalls = (0, import_react6.useMemo)(
    () => isPending ? toolCalls.filter(
      (tool) => !isPanelOwnedSubagentTool(tool) || isAgentWithPendingConfirmation(tool.resultDisplay)
    ) : toolCalls,
    [isPending, toolCalls]
  );
  const hasRenderableToolCallArgs = (0, import_react6.useMemo)(
    () => showToolCallArgs && inlineToolCalls.some(
      (t2) => t2.args != null && Object.keys(t2.args).length > 0
    ),
    [showToolCallArgs, inlineToolCalls]
  );
  const subagentsAwaitingApproval = (0, import_react6.useMemo)(
    () => toolCalls.filter(
      (tc) => isAgentWithPendingConfirmation(tc.resultDisplay)
    ),
    [toolCalls]
  );
  const focusedSubagentRef = (0, import_react6.useRef)(null);
  const stillPending = subagentsAwaitingApproval.some(
    (tc) => tc.callId === focusedSubagentRef.current
  );
  if (!stillPending) {
    focusedSubagentRef.current = subagentsAwaitingApproval[0]?.callId ?? null;
  }
  const focusedSubagentCallId = focusedSubagentRef.current;
  const runningSubagentCallId = (0, import_react6.useMemo)(
    () => toolCalls.find((tc) => isRunningAgent(tc.resultDisplay))?.callId ?? null,
    [toolCalls]
  );
  const keyboardFocusedSubagentCallId = focusedSubagentCallId ?? runningSubagentCallId;
  const hasSubagentPendingConfirmation = subagentsAwaitingApproval.length > 0;
  if (hideDetails) {
    if (isPending && inlineToolCalls.length === 0) return null;
    return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
      HiddenToolDetailsSummary,
      {
        toolCalls: inlineToolCalls,
        contentWidth,
        expandHint,
        summaryRef
      }
    );
  }
  if (!fullDetail && isPureParallelAgentGroup(toolCalls) && !hasSubagentPendingConfirmation) {
    if (inlineToolCalls.length === 0) {
      return null;
    }
    return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
      InlineParallelAgentsDisplay,
      {
        toolCalls: inlineToolCalls,
        contentWidth,
        totalAgentCount: toolCalls.length,
        availableTerminalHeight: isPending ? availableTerminalHeight : void 0
      }
    );
  }
  if (isPending && inlineToolCalls.length === 0) {
    return null;
  }
  const allMemOpsComplete = !fullDetail && !hasRenderableToolCallArgs && isMemoryOnlyGroup && !hasErrorTool && toolCalls.every((t2) => t2.status === "Success" /* Success */);
  if (allMemOpsComplete) {
    const readCount = memoryReadCount ?? 0;
    const writeCount = memoryWriteCount ?? 0;
    return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(Box_default, { flexDirection: "column", width: contentWidth, children: [
      readCount > 0 && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(Box_default, { paddingLeft: 1, children: /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(Text, { dimColor: true, children: [
        ICON.CIRCLE_FILLED + " ",
        "Recalled ",
        readCount,
        " ",
        readCount === 1 ? "memory" : "memories"
      ] }) }),
      writeCount > 0 && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(Box_default, { paddingLeft: 1, children: /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(Text, { dimColor: true, children: [
        ICON.CIRCLE_FILLED + " ",
        "Wrote ",
        writeCount,
        " ",
        writeCount === 1 ? "memory" : "memories"
      ] }) })
    ] });
  }
  const hasTerminalSubagent = inlineToolCalls.some(isTerminalSubagentTool);
  const forceExpandAll = fullDetail || hasRenderableToolCallArgs || hasConfirmingTool || hasSubagentPendingConfirmation || hasErrorTool || isEmbeddedShellFocused || isUserInitiated || hasTerminalSubagent;
  const collapsibleTools = forceExpandAll ? [] : inlineToolCalls.filter(
    (t2) => isCollapsibleTool(t2.name) && t2.status !== "Canceled" /* Canceled */ && !hasInlineImageOutput(t2)
  );
  const nonCollapsibleTools = forceExpandAll ? inlineToolCalls : inlineToolCalls.filter(
    (t2) => !isCollapsibleTool(t2.name) || t2.status === "Canceled" /* Canceled */ || hasInlineImageOutput(t2)
  );
  const hasMemoryBadge = !isMemoryOnlyGroup && ((memoryWriteCount ?? 0) > 0 || (memoryReadCount ?? 0) > 0);
  const memoryBadge = hasMemoryBadge ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(Box_default, { paddingLeft: 1, children: /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(Text, { dimColor: true, children: [
    ICON.CIRCLE_FILLED + " ",
    [
      (memoryReadCount ?? 0) > 0 && `Recalled ${memoryReadCount} ${memoryReadCount === 1 ? "memory" : "memories"}`,
      (memoryWriteCount ?? 0) > 0 && `Wrote ${memoryWriteCount} ${memoryWriteCount === 1 ? "memory" : "memories"}`
    ].filter(Boolean).join(", ")
  ] }) }) : null;
  if (collapsibleTools.length > 0 && nonCollapsibleTools.length === 0) {
    return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(Box_default, { flexDirection: "column", width: contentWidth, children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
        CompactToolGroupDisplay,
        {
          toolCalls: collapsibleTools,
          contentWidth
        }
      ),
      memoryBadge
    ] });
  }
  const collapsibleSummaryHeight = estimateCompactToolGroupHeight(
    collapsibleTools,
    contentWidth
  );
  const memoryBadgeHeight = hasMemoryBadge ? 1 : 0;
  const inlineArgsHeight = showToolCallArgs ? nonCollapsibleTools.filter(
    (t2) => t2.args != null && Object.keys(t2.args).length > 0
  ).length * TOOL_ARGS_INLINE_MAX_LINES : 0;
  const staticHeight = (
    /* marginBottom */
    1 + collapsibleSummaryHeight + memoryBadgeHeight + inlineArgsHeight
  );
  const confirmationInnerWidth = contentWidth - 2;
  let countToolCallsWithResults = 0;
  for (const tool of nonCollapsibleTools) {
    if (tool.resultDisplay !== void 0 && tool.resultDisplay !== "" || hasInlineImageOutput(tool)) {
      countToolCallsWithResults++;
    }
  }
  const countOneLineToolCalls = nonCollapsibleTools.length - countToolCallsWithResults;
  const availableTerminalHeightPerToolMessage = fullDetail ? void 0 : availableTerminalHeight ? Math.max(
    Math.floor(
      (availableTerminalHeight - staticHeight - countOneLineToolCalls) / Math.max(1, countToolCallsWithResults)
    ),
    1
  ) : void 0;
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(Box_default, { flexDirection: "column", width: contentWidth, gap: 0, children: [
    collapsibleTools.length > 0 && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
      CompactToolGroupDisplay,
      {
        toolCalls: collapsibleTools,
        contentWidth
      }
    ),
    memoryBadge,
    nonCollapsibleTools.map((tool) => {
      const isConfirming = toolAwaitingApproval?.callId === tool.callId;
      const isSubagentFocused = isFocused && !toolAwaitingApproval && keyboardFocusedSubagentCallId === tool.callId;
      return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(Box_default, { flexDirection: "column", minHeight: 1, children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(Box_default, { flexDirection: "row", alignItems: "center", children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
          ToolMessage,
          {
            ...tool,
            availableTerminalHeight: availableTerminalHeightPerToolMessage,
            contentWidth,
            emphasis: isConfirming ? "high" : toolAwaitingApproval ? "low" : "medium",
            activeShellPtyId,
            embeddedShellFocused,
            config,
            fullDetail,
            showToolCallArgs,
            forceShowResult: fullDetail || isUserInitiated || tool.status === "Confirming" /* Confirming */ || tool.status === "Error" /* Error */ || isAgentWithPendingConfirmation(tool.resultDisplay) || isTerminalSubagentTool(tool),
            isFocused: isSubagentFocused,
            isPending
          }
        ) }),
        tool.status === "Confirming" /* Confirming */ && isConfirming && tool.confirmationDetails && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
          ToolConfirmationMessage,
          {
            confirmationDetails: tool.confirmationDetails,
            config,
            isFocused,
            availableTerminalHeight: availableTerminalHeightPerToolMessage,
            contentWidth: confirmationInnerWidth
          }
        )
      ] }, tool.callId);
    })
  ] });
}, "ToolGroupMessage");

// packages/cli/src/ui/components/messages/CompressionMessage.tsx
init_esbuild_shims();
var import_jsx_runtime3 = __toESM(require_jsx_runtime(), 1);
function CompressionMessage({
  compression
}) {
  const {
    isPending,
    originalTokenCount,
    newTokenCount,
    compressionStatus,
    originalTokenCountIsEstimated,
    newTokenCountIsEstimated
  } = compression;
  const text = getCompressionStatusText({
    isPending,
    originalTokenCount,
    newTokenCount,
    compressionStatus,
    originalTokenCountIsEstimated,
    newTokenCountIsEstimated
  });
  return /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)(Box_default, { flexDirection: "row", children: [
    /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(Box_default, { width: 2, flexShrink: 0, children: isPending ? /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(build_default, { type: "dots" }) : /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(Text, { color: theme.text.accent, children: ICON.DIAMOND }) }),
    /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(Box_default, { flexGrow: 1, children: /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
      Text,
      {
        color: compression.isPending ? theme.text.accent : theme.status.success,
        "aria-label": SCREEN_READER_MODEL_PREFIX,
        children: text
      }
    ) })
  ] });
}
__name(CompressionMessage, "CompressionMessage");

// packages/cli/src/ui/components/messages/SummaryMessage.tsx
init_esbuild_shims();
var import_jsx_runtime4 = __toESM(require_jsx_runtime(), 1);
var SummaryMessage = /* @__PURE__ */ __name(({ summary }) => {
  const getText = /* @__PURE__ */ __name(() => {
    if (summary.isPending) {
      switch (summary.stage) {
        case "generating":
          return t("Generating project summary...");
        case "saving":
          return t("Saving project summary...");
        default:
          return t("Processing summary...");
      }
    }
    const baseMessage = t("Project summary generated and saved successfully!");
    if (summary.filePath) {
      return `${baseMessage} ${t("Saved to: {{filePath}}", {
        filePath: summary.filePath
      })}`;
    }
    return baseMessage;
  }, "getText");
  const getIcon = /* @__PURE__ */ __name(() => {
    if (summary.isPending) {
      return /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(build_default, { type: "dots" });
    }
    return /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(Text, { color: Colors.AccentGreen, children: "\u2713" });
  }, "getIcon");
  return /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)(Box_default, { flexDirection: "row", children: [
    /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(Box_default, { width: 2, flexShrink: 0, children: getIcon() }),
    /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(Box_default, { flexGrow: 1, children: /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(
      Text,
      {
        color: summary.isPending ? Colors.AccentPurple : Colors.AccentGreen,
        children: getText()
      }
    ) })
  ] });
}, "SummaryMessage");

// packages/cli/src/ui/components/messages/StatusMessages.tsx
init_esbuild_shims();

// node_modules/ink-link/dist/index.js
init_esbuild_shims();
var import_react7 = __toESM(require_react(), 1);
var import_prop_types = __toESM(require_prop_types(), 1);

// node_modules/ink-link/node_modules/terminal-link/index.js
init_esbuild_shims();

// node_modules/ink-link/node_modules/ansi-escapes/index.js
init_esbuild_shims();
var ESC = "\x1B[";
var OSC = "\x1B]";
var BEL = "\x07";
var SEP = ";";
var isTerminalApp = process.env.TERM_PROGRAM === "Apple_Terminal";
var ansiEscapes = {};
ansiEscapes.cursorTo = (x, y) => {
  if (typeof x !== "number") {
    throw new TypeError("The `x` argument is required");
  }
  if (typeof y !== "number") {
    return ESC + (x + 1) + "G";
  }
  return ESC + (y + 1) + ";" + (x + 1) + "H";
};
ansiEscapes.cursorMove = (x, y) => {
  if (typeof x !== "number") {
    throw new TypeError("The `x` argument is required");
  }
  let returnValue = "";
  if (x < 0) {
    returnValue += ESC + -x + "D";
  } else if (x > 0) {
    returnValue += ESC + x + "C";
  }
  if (y < 0) {
    returnValue += ESC + -y + "A";
  } else if (y > 0) {
    returnValue += ESC + y + "B";
  }
  return returnValue;
};
ansiEscapes.cursorUp = (count = 1) => ESC + count + "A";
ansiEscapes.cursorDown = (count = 1) => ESC + count + "B";
ansiEscapes.cursorForward = (count = 1) => ESC + count + "C";
ansiEscapes.cursorBackward = (count = 1) => ESC + count + "D";
ansiEscapes.cursorLeft = ESC + "G";
ansiEscapes.cursorSavePosition = isTerminalApp ? "\x1B7" : ESC + "s";
ansiEscapes.cursorRestorePosition = isTerminalApp ? "\x1B8" : ESC + "u";
ansiEscapes.cursorGetPosition = ESC + "6n";
ansiEscapes.cursorNextLine = ESC + "E";
ansiEscapes.cursorPrevLine = ESC + "F";
ansiEscapes.cursorHide = ESC + "?25l";
ansiEscapes.cursorShow = ESC + "?25h";
ansiEscapes.eraseLines = (count) => {
  let clear = "";
  for (let i = 0; i < count; i++) {
    clear += ansiEscapes.eraseLine + (i < count - 1 ? ansiEscapes.cursorUp() : "");
  }
  if (count) {
    clear += ansiEscapes.cursorLeft;
  }
  return clear;
};
ansiEscapes.eraseEndLine = ESC + "K";
ansiEscapes.eraseStartLine = ESC + "1K";
ansiEscapes.eraseLine = ESC + "2K";
ansiEscapes.eraseDown = ESC + "J";
ansiEscapes.eraseUp = ESC + "1J";
ansiEscapes.eraseScreen = ESC + "2J";
ansiEscapes.scrollUp = ESC + "S";
ansiEscapes.scrollDown = ESC + "T";
ansiEscapes.clearScreen = "\x1Bc";
ansiEscapes.clearTerminal = process.platform === "win32" ? `${ansiEscapes.eraseScreen}${ESC}0f` : (
  // 1. Erases the screen (Only done in case `2` is not supported)
  // 2. Erases the whole screen including scrollback buffer
  // 3. Moves cursor to the top-left position
  // More info: https://www.real-world-systems.com/docs/ANSIcode.html
  `${ansiEscapes.eraseScreen}${ESC}3J${ESC}H`
);
ansiEscapes.beep = BEL;
ansiEscapes.link = (text, url) => {
  return [
    OSC,
    "8",
    SEP,
    SEP,
    url,
    BEL,
    text,
    OSC,
    "8",
    SEP,
    SEP,
    BEL
  ].join("");
};
ansiEscapes.image = (buffer, options = {}) => {
  let returnValue = `${OSC}1337;File=inline=1`;
  if (options.width) {
    returnValue += `;width=${options.width}`;
  }
  if (options.height) {
    returnValue += `;height=${options.height}`;
  }
  if (options.preserveAspectRatio === false) {
    returnValue += ";preserveAspectRatio=0";
  }
  return returnValue + ":" + buffer.toString("base64") + BEL;
};
ansiEscapes.iTerm = {
  setCwd: /* @__PURE__ */ __name((cwd2 = process.cwd()) => `${OSC}50;CurrentDir=${cwd2}${BEL}`, "setCwd"),
  annotation: /* @__PURE__ */ __name((message, options = {}) => {
    let returnValue = `${OSC}1337;`;
    const hasX = typeof options.x !== "undefined";
    const hasY = typeof options.y !== "undefined";
    if ((hasX || hasY) && !(hasX && hasY && typeof options.length !== "undefined")) {
      throw new Error("`x`, `y` and `length` must be defined when `x` or `y` is defined");
    }
    message = message.replace(/\|/g, "");
    returnValue += options.isHidden ? "AddHiddenAnnotation=" : "AddAnnotation=";
    if (options.length > 0) {
      returnValue += (hasX ? [message, options.length, options.x, options.y] : [options.length, message]).join("|");
    } else {
      returnValue += message;
    }
    return returnValue + BEL;
  }, "annotation")
};
var ansi_escapes_default = ansiEscapes;

// node_modules/ink-link/node_modules/terminal-link/index.js
var import_supports_hyperlinks = __toESM(require_supports_hyperlinks(), 1);
function terminalLink(text, url, { target = "stdout", ...options } = {}) {
  if (!import_supports_hyperlinks.default[target]) {
    if (options.fallback === false) {
      return text;
    }
    return typeof options.fallback === "function" ? options.fallback(text, url) : `${text} (\u200B${url}\u200B)`;
  }
  return ansi_escapes_default.link(text, url);
}
__name(terminalLink, "terminalLink");
terminalLink.isSupported = import_supports_hyperlinks.default.stdout;
terminalLink.stderr = (text, url, options = {}) => terminalLink(text, url, { target: "stderr", ...options });
terminalLink.stderr.isSupported = import_supports_hyperlinks.default.stderr;

// node_modules/ink-link/dist/index.js
var Link = /* @__PURE__ */ __name(({ children, url, fallback = true }) => (
  // eslint-disable-line react/function-component-definition
  import_react7.default.createElement(
    Transform,
    { transform: /* @__PURE__ */ __name((children2) => terminalLink(children2, url, { fallback }), "transform") },
    import_react7.default.createElement(Text, null, children)
  )
), "Link");
Link.propTypes = {
  children: import_prop_types.default.oneOfType([
    import_prop_types.default.arrayOf(import_prop_types.default.node),
    import_prop_types.default.node
  ]).isRequired,
  url: import_prop_types.default.string.isRequired,
  fallback: import_prop_types.default.bool
  // eslint-disable-line react/boolean-prop-naming
};
var dist_default = Link;

// packages/cli/src/ui/components/messages/StatusMessages.tsx
var import_jsx_runtime5 = __toESM(require_jsx_runtime(), 1);
var StatusMessage = /* @__PURE__ */ __name(({
  text,
  prefix,
  prefixColor,
  textColor,
  children,
  footer
}) => {
  if ((!text || text.trim() === "") && !footer) {
    return null;
  }
  const prefixWidth = stringWidth(prefix) + 1;
  return /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)(Box_default, { flexDirection: "row", children: [
    /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(Box_default, { width: prefixWidth, flexShrink: 0, children: /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(Text, { color: prefixColor, children: prefix }) }),
    /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)(Box_default, { flexGrow: 1, flexDirection: "column", children: [
      text && text.trim() !== "" && /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)(Text, { wrap: "wrap", color: textColor, children: [
        /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(RenderInline, { text }),
        children
      ] }),
      footer
    ] })
  ] });
}, "StatusMessage");
var InfoMessage = /* @__PURE__ */ __name(({
  text,
  linkUrl,
  linkText
}) => /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(
  StatusMessage,
  {
    text,
    prefix: ICON.CIRCLE_FILLED,
    prefixColor: theme.text.primary,
    textColor: theme.text.primary,
    footer: linkUrl && /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(dist_default, { url: linkUrl, children: /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(Text, { color: theme.text.link, underline: true, children: linkText ?? linkUrl }) })
  }
), "InfoMessage");
var SuccessMessage = /* @__PURE__ */ __name(({ text }) => /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(
  StatusMessage,
  {
    text,
    prefix: "\u2713",
    prefixColor: theme.status.success,
    textColor: theme.status.success
  }
), "SuccessMessage");
var WarningMessage = /* @__PURE__ */ __name(({ text }) => /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(
  StatusMessage,
  {
    text,
    prefix: ICON.TRIANGLE,
    prefixColor: theme.status.warning,
    textColor: theme.status.warning
  }
), "WarningMessage");
var ErrorMessage = /* @__PURE__ */ __name(({
  text,
  hint
}) => /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(
  StatusMessage,
  {
    text,
    prefix: "\u2715",
    prefixColor: theme.status.error,
    textColor: theme.status.error,
    children: hint && /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)(Text, { color: theme.text.secondary, children: [
      " (",
      hint,
      ")"
    ] })
  }
), "ErrorMessage");
var RetryCountdownMessage = /* @__PURE__ */ __name(({ text }) => /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(
  StatusMessage,
  {
    text,
    prefix: "\u21BB",
    prefixColor: theme.text.secondary,
    textColor: theme.text.secondary
  }
), "RetryCountdownMessage");
var VisionNoticeMessage = /* @__PURE__ */ __name(({ text }) => /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(
  StatusMessage,
  {
    text,
    prefix: ICON.BULLSEYE,
    prefixColor: theme.text.secondary,
    textColor: theme.text.secondary
  }
), "VisionNoticeMessage");
var AwayRecapMessage = /* @__PURE__ */ __name(({ text }) => /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)(Box_default, { flexDirection: "row", children: [
  /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(Box_default, { width: 2, flexShrink: 0, children: /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(Text, { color: theme.text.secondary, children: ICON.REFERENCE }) }),
  /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)(Text, { wrap: "wrap", children: [
    /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)(Text, { color: theme.text.secondary, bold: true, children: [
      "recap:",
      " "
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(Text, { color: theme.text.secondary, italic: true, children: text })
  ] })
] }), "AwayRecapMessage");

// packages/cli/src/ui/components/AboutBox.tsx
init_esbuild_shims();
var import_jsx_runtime6 = __toESM(require_jsx_runtime(), 1);
var AboutBox = /* @__PURE__ */ __name(({ width, ...props }) => {
  const fields = getSystemInfoFields(props);
  return /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)(
    Box_default,
    {
      borderStyle: "round",
      borderColor: theme.border.default,
      flexDirection: "column",
      padding: 1,
      width,
      children: [
        /* @__PURE__ */ (0, import_jsx_runtime6.jsx)(Box_default, { marginBottom: 1, children: /* @__PURE__ */ (0, import_jsx_runtime6.jsx)(Text, { bold: true, color: theme.text.accent, children: t("Status") }) }),
        fields.map((field) => /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)(
          Box_default,
          {
            flexDirection: "row",
            marginTop: field.label === t("Auth") ? 1 : 0,
            children: [
              /* @__PURE__ */ (0, import_jsx_runtime6.jsx)(Box_default, { width: "35%", children: /* @__PURE__ */ (0, import_jsx_runtime6.jsx)(Text, { bold: true, color: theme.text.link, children: field.label }) }),
              /* @__PURE__ */ (0, import_jsx_runtime6.jsx)(Box_default, { children: /* @__PURE__ */ (0, import_jsx_runtime6.jsx)(Text, { color: theme.text.primary, children: field.value }) })
            ]
          },
          field.label
        ))
      ]
    }
  );
}, "AboutBox");

// packages/cli/src/ui/components/StatsDisplay.tsx
init_esbuild_shims();

// node_modules/ink-gradient/dist/index.js
init_esbuild_shims();
var import_react8 = __toESM(require_react(), 1);
var import_prop_types2 = __toESM(require_prop_types(), 1);
var import_gradient_string = __toESM(require_gradient_string(), 1);
var Gradient = /* @__PURE__ */ __name((props) => {
  if (props.name && props.colors) {
    throw new Error("The `name` and `colors` props are mutually exclusive");
  }
  let gradient;
  if (props.name) {
    gradient = import_gradient_string.default[props.name];
  } else if (props.colors) {
    gradient = (0, import_gradient_string.default)(props.colors);
  } else {
    throw new Error("Either `name` or `colors` prop must be provided");
  }
  const applyGradient = /* @__PURE__ */ __name((text) => gradient.multiline(stripAnsi(text)), "applyGradient");
  return import_react8.default.createElement(Transform, { transform: applyGradient }, props.children);
}, "Gradient");
Gradient.propTypes = {
  children: import_prop_types2.default.oneOfType([
    import_prop_types2.default.arrayOf(import_prop_types2.default.node),
    import_prop_types2.default.node
  ]).isRequired,
  name: import_prop_types2.default.oneOf([
    "cristal",
    "teen",
    "mind",
    "morning",
    "vice",
    "passion",
    "fruit",
    "instagram",
    "atlas",
    "retro",
    "summer",
    "pastel",
    "rainbow"
  ]),
  colors: import_prop_types2.default.arrayOf(import_prop_types2.default.oneOfType([
    import_prop_types2.default.string,
    import_prop_types2.default.object
  ]))
};
var dist_default2 = Gradient;

// packages/cli/src/ui/utils/gradientUtils.ts
init_esbuild_shims();
function getRenderableGradientColors(...candidates) {
  return candidates.find(
    (colors) => Array.isArray(colors) && colors.length >= 2 && colors.every(
      (color) => typeof color === "string" && color.trim().length > 0
    )
  );
}
__name(getRenderableGradientColors, "getRenderableGradientColors");

// packages/cli/src/ui/components/StatsDisplay.tsx
var import_jsx_runtime7 = __toESM(require_jsx_runtime(), 1);
var StatRow = /* @__PURE__ */ __name(({ title, children }) => /* @__PURE__ */ (0, import_jsx_runtime7.jsxs)(Box_default, { children: [
  /* @__PURE__ */ (0, import_jsx_runtime7.jsx)(Box_default, { width: 28, children: /* @__PURE__ */ (0, import_jsx_runtime7.jsx)(Text, { color: theme.text.link, children: title }) }),
  /* @__PURE__ */ (0, import_jsx_runtime7.jsx)(Box_default, { flexGrow: 1, children })
] }), "StatRow");
var SubStatRow = /* @__PURE__ */ __name(({ title, children }) => /* @__PURE__ */ (0, import_jsx_runtime7.jsxs)(Box_default, { paddingLeft: 2, children: [
  /* @__PURE__ */ (0, import_jsx_runtime7.jsx)(Box_default, { width: 26, children: /* @__PURE__ */ (0, import_jsx_runtime7.jsxs)(Text, { color: theme.text.secondary, children: [
    "\xBB ",
    title
  ] }) }),
  /* @__PURE__ */ (0, import_jsx_runtime7.jsx)(Box_default, { flexGrow: 1, children })
] }), "SubStatRow");
var Section = /* @__PURE__ */ __name(({ title, children }) => /* @__PURE__ */ (0, import_jsx_runtime7.jsxs)(Box_default, { flexDirection: "column", width: "100%", marginBottom: 1, children: [
  /* @__PURE__ */ (0, import_jsx_runtime7.jsx)(Text, { bold: true, color: theme.text.primary, children: title }),
  children
] }), "Section");
var ModelUsageTable = /* @__PURE__ */ __name(({ models, totalCachedTokens, cacheEfficiency }) => {
  const nameWidth = 35;
  const requestsWidth = 8;
  const inputTokensWidth = 15;
  const outputTokensWidth = 15;
  const entries = flattenModelsBySource(models);
  return /* @__PURE__ */ (0, import_jsx_runtime7.jsxs)(Box_default, { flexDirection: "column", marginTop: 1, children: [
    /* @__PURE__ */ (0, import_jsx_runtime7.jsxs)(Box_default, { children: [
      /* @__PURE__ */ (0, import_jsx_runtime7.jsx)(Box_default, { width: nameWidth, children: /* @__PURE__ */ (0, import_jsx_runtime7.jsx)(Text, { bold: true, color: theme.text.primary, children: t("Model Usage") }) }),
      /* @__PURE__ */ (0, import_jsx_runtime7.jsx)(Box_default, { width: requestsWidth, justifyContent: "flex-end", children: /* @__PURE__ */ (0, import_jsx_runtime7.jsx)(Text, { bold: true, color: theme.text.primary, children: t("Reqs") }) }),
      /* @__PURE__ */ (0, import_jsx_runtime7.jsx)(Box_default, { width: inputTokensWidth, justifyContent: "flex-end", children: /* @__PURE__ */ (0, import_jsx_runtime7.jsx)(Text, { bold: true, color: theme.text.primary, children: t("Input Tokens") }) }),
      /* @__PURE__ */ (0, import_jsx_runtime7.jsx)(Box_default, { width: outputTokensWidth, justifyContent: "flex-end", children: /* @__PURE__ */ (0, import_jsx_runtime7.jsx)(Text, { bold: true, color: theme.text.primary, children: t("Output Tokens") }) })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime7.jsx)(
      Box_default,
      {
        borderStyle: "round",
        borderBottom: true,
        borderTop: false,
        borderLeft: false,
        borderRight: false,
        borderColor: theme.border.default,
        width: nameWidth + requestsWidth + inputTokensWidth + outputTokensWidth
      }
    ),
    entries.map(({ key, label, metrics }) => /* @__PURE__ */ (0, import_jsx_runtime7.jsxs)(Box_default, { children: [
      /* @__PURE__ */ (0, import_jsx_runtime7.jsx)(Box_default, { width: nameWidth, children: /* @__PURE__ */ (0, import_jsx_runtime7.jsx)(Text, { color: theme.text.primary, children: label }) }),
      /* @__PURE__ */ (0, import_jsx_runtime7.jsx)(Box_default, { width: requestsWidth, justifyContent: "flex-end", children: /* @__PURE__ */ (0, import_jsx_runtime7.jsx)(Text, { color: theme.text.primary, children: metrics.api.totalRequests }) }),
      /* @__PURE__ */ (0, import_jsx_runtime7.jsx)(Box_default, { width: inputTokensWidth, justifyContent: "flex-end", children: /* @__PURE__ */ (0, import_jsx_runtime7.jsx)(Text, { color: theme.status.warning, children: metrics.tokens.prompt.toLocaleString() }) }),
      /* @__PURE__ */ (0, import_jsx_runtime7.jsx)(Box_default, { width: outputTokensWidth, justifyContent: "flex-end", children: /* @__PURE__ */ (0, import_jsx_runtime7.jsx)(Text, { color: theme.status.warning, children: metrics.tokens.candidates.toLocaleString() }) })
    ] }, key)),
    cacheEfficiency > 0 && /* @__PURE__ */ (0, import_jsx_runtime7.jsxs)(Box_default, { flexDirection: "column", marginTop: 1, children: [
      /* @__PURE__ */ (0, import_jsx_runtime7.jsxs)(Text, { color: theme.text.primary, children: [
        /* @__PURE__ */ (0, import_jsx_runtime7.jsx)(Text, { color: theme.status.success, children: t("Savings Highlight:") }),
        " ",
        totalCachedTokens.toLocaleString(),
        " (",
        cacheEfficiency.toFixed(1),
        "%)",
        " ",
        t("of input tokens were served from the cache, reducing costs.")
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime7.jsx)(Box_default, { height: 1 }),
      /* @__PURE__ */ (0, import_jsx_runtime7.jsxs)(Text, { color: theme.text.secondary, children: [
        "\xBB ",
        t("Tip: For a full token breakdown, run `/stats model`.")
      ] })
    ] })
  ] });
}, "ModelUsageTable");
var StatsDisplay = /* @__PURE__ */ __name(({
  duration,
  title,
  width
}) => {
  const { stats } = useSessionStats();
  const { metrics } = stats;
  const { models, tools, files } = metrics;
  const computed = computeSessionStats(metrics);
  const successThresholds = {
    green: TOOL_SUCCESS_RATE_HIGH,
    yellow: TOOL_SUCCESS_RATE_MEDIUM
  };
  const agreementThresholds = {
    green: USER_AGREEMENT_RATE_HIGH,
    yellow: USER_AGREEMENT_RATE_MEDIUM
  };
  const successColor = getStatusColor(computed.successRate, successThresholds);
  const agreementColor = getStatusColor(
    computed.agreementRate,
    agreementThresholds
  );
  const renderTitle = /* @__PURE__ */ __name(() => {
    if (title) {
      const gradientColors = getRenderableGradientColors(theme.ui.gradient);
      return gradientColors ? /* @__PURE__ */ (0, import_jsx_runtime7.jsx)(dist_default2, { colors: gradientColors, children: /* @__PURE__ */ (0, import_jsx_runtime7.jsx)(Text, { bold: true, color: theme.text.primary, children: title }) }) : /* @__PURE__ */ (0, import_jsx_runtime7.jsx)(Text, { bold: true, color: theme.text.accent, children: title });
    }
    return /* @__PURE__ */ (0, import_jsx_runtime7.jsx)(Text, { bold: true, color: theme.text.accent, children: t("Session Stats") });
  }, "renderTitle");
  return /* @__PURE__ */ (0, import_jsx_runtime7.jsxs)(
    Box_default,
    {
      borderStyle: "round",
      borderColor: theme.border.default,
      flexDirection: "column",
      paddingY: 1,
      paddingX: 2,
      width,
      children: [
        renderTitle(),
        /* @__PURE__ */ (0, import_jsx_runtime7.jsx)(Box_default, { height: 1 }),
        /* @__PURE__ */ (0, import_jsx_runtime7.jsxs)(Section, { title: t("Interaction Summary"), children: [
          /* @__PURE__ */ (0, import_jsx_runtime7.jsx)(StatRow, { title: t("Session ID:"), children: /* @__PURE__ */ (0, import_jsx_runtime7.jsx)(Text, { color: theme.text.primary, children: stats.sessionId }) }),
          /* @__PURE__ */ (0, import_jsx_runtime7.jsx)(StatRow, { title: t("Tool Calls:"), children: /* @__PURE__ */ (0, import_jsx_runtime7.jsxs)(Text, { color: theme.text.primary, children: [
            tools.totalCalls,
            " (",
            " ",
            /* @__PURE__ */ (0, import_jsx_runtime7.jsxs)(Text, { color: theme.status.success, children: [
              "\u2713 ",
              tools.totalSuccess
            ] }),
            " ",
            /* @__PURE__ */ (0, import_jsx_runtime7.jsxs)(Text, { color: theme.status.error, children: [
              "x ",
              tools.totalFail
            ] }),
            " )"
          ] }) }),
          /* @__PURE__ */ (0, import_jsx_runtime7.jsx)(StatRow, { title: t("Success Rate:"), children: /* @__PURE__ */ (0, import_jsx_runtime7.jsxs)(Text, { color: successColor, children: [
            computed.successRate.toFixed(1),
            "%"
          ] }) }),
          computed.totalDecisions > 0 && /* @__PURE__ */ (0, import_jsx_runtime7.jsx)(StatRow, { title: t("User Agreement:"), children: /* @__PURE__ */ (0, import_jsx_runtime7.jsxs)(Text, { color: agreementColor, children: [
            computed.agreementRate.toFixed(1),
            "%",
            " ",
            /* @__PURE__ */ (0, import_jsx_runtime7.jsxs)(Text, { color: theme.text.secondary, children: [
              "(",
              computed.totalDecisions,
              " ",
              t("reviewed"),
              ")"
            ] })
          ] }) }),
          files && (files.totalLinesAdded > 0 || files.totalLinesRemoved > 0) && /* @__PURE__ */ (0, import_jsx_runtime7.jsx)(StatRow, { title: t("Code Changes:"), children: /* @__PURE__ */ (0, import_jsx_runtime7.jsxs)(Text, { color: theme.text.primary, children: [
            /* @__PURE__ */ (0, import_jsx_runtime7.jsxs)(Text, { color: theme.status.success, children: [
              "+",
              files.totalLinesAdded
            ] }),
            " ",
            /* @__PURE__ */ (0, import_jsx_runtime7.jsxs)(Text, { color: theme.status.error, children: [
              "-",
              files.totalLinesRemoved
            ] })
          ] }) })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime7.jsxs)(Section, { title: t("Performance"), children: [
          /* @__PURE__ */ (0, import_jsx_runtime7.jsx)(StatRow, { title: t("Wall Time:"), children: /* @__PURE__ */ (0, import_jsx_runtime7.jsx)(Text, { color: theme.text.primary, children: duration }) }),
          /* @__PURE__ */ (0, import_jsx_runtime7.jsx)(StatRow, { title: t("Agent Active:"), children: /* @__PURE__ */ (0, import_jsx_runtime7.jsx)(Text, { color: theme.text.primary, children: formatDuration(computed.agentActiveTime) }) }),
          /* @__PURE__ */ (0, import_jsx_runtime7.jsx)(SubStatRow, { title: t("API Time:"), children: /* @__PURE__ */ (0, import_jsx_runtime7.jsxs)(Text, { color: theme.text.primary, children: [
            formatDuration(computed.totalApiTime),
            " ",
            /* @__PURE__ */ (0, import_jsx_runtime7.jsxs)(Text, { color: theme.text.secondary, children: [
              "(",
              computed.apiTimePercent.toFixed(1),
              "%)"
            ] })
          ] }) }),
          /* @__PURE__ */ (0, import_jsx_runtime7.jsx)(SubStatRow, { title: t("Tool Time:"), children: /* @__PURE__ */ (0, import_jsx_runtime7.jsxs)(Text, { color: theme.text.primary, children: [
            formatDuration(computed.totalToolTime),
            " ",
            /* @__PURE__ */ (0, import_jsx_runtime7.jsxs)(Text, { color: theme.text.secondary, children: [
              "(",
              computed.toolTimePercent.toFixed(1),
              "%)"
            ] })
          ] }) })
        ] }),
        Object.keys(models).length > 0 && /* @__PURE__ */ (0, import_jsx_runtime7.jsx)(
          ModelUsageTable,
          {
            models,
            totalCachedTokens: computed.totalCachedTokens,
            cacheEfficiency: computed.cacheEfficiency
          }
        )
      ]
    }
  );
}, "StatsDisplay");

// packages/cli/src/ui/components/ModelStatsDisplay.tsx
init_esbuild_shims();
var import_jsx_runtime8 = __toESM(require_jsx_runtime(), 1);
var METRIC_COL_WIDTH = 28;
var MODEL_COL_WIDTH = 24;
var PANEL_HORIZONTAL_CHROME_WIDTH = 6;
var StatRow2 = /* @__PURE__ */ __name(({
  title,
  values,
  modelColWidth,
  isSubtle = false,
  isSection = false
}) => /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)(Box_default, { children: [
  /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Box_default, { width: METRIC_COL_WIDTH, children: /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(
    Text,
    {
      bold: isSection,
      color: isSection ? theme.text.primary : theme.text.link,
      children: isSubtle ? `  \u21B3 ${title}` : title
    }
  ) }),
  values.map((value, index) => /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Box_default, { width: modelColWidth, children: /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Text, { color: theme.text.primary, children: value }) }, index))
] }), "StatRow");
var ModelStatsDisplay = /* @__PURE__ */ __name(({
  width
}) => {
  const { stats } = useSessionStats();
  const { models } = stats.metrics;
  const entries = flattenModelsBySource(models);
  const settings = useSettings();
  const modelPricing = settings.merged.modelPricing;
  if (entries.length === 0) {
    return /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(
      Box_default,
      {
        borderStyle: "round",
        borderColor: theme.border.default,
        paddingY: 1,
        paddingX: 2,
        width,
        children: /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Text, { color: theme.text.primary, children: t("No API calls have been made in this session.") })
      }
    );
  }
  const getModelValues = /* @__PURE__ */ __name((getter) => entries.map(({ metrics }) => getter(metrics)), "getModelValues");
  const hasThoughts = entries.some(
    ({ metrics }) => metrics.tokens.thoughts > 0
  );
  const hasCached = entries.some(({ metrics }) => metrics.tokens.cached > 0);
  const modelColWidth = entries.length === 1 && width ? Math.max(
    MODEL_COL_WIDTH,
    width - PANEL_HORIZONTAL_CHROME_WIDTH - METRIC_COL_WIDTH
  ) : MODEL_COL_WIDTH;
  const getModelName = /* @__PURE__ */ __name((key) => key.split("::")[0], "getModelName");
  const hasPricing = entries.some(
    ({ key, metrics }) => calculateCost({
      inputTokens: metrics.tokens.prompt,
      outputTokens: metrics.tokens.candidates + metrics.tokens.thoughts,
      pricing: modelPricing?.[getModelName(key)]
    }) != null
  );
  return /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)(
    Box_default,
    {
      borderStyle: "round",
      borderColor: theme.border.default,
      flexDirection: "column",
      paddingY: 1,
      paddingX: 2,
      width,
      children: [
        /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Text, { bold: true, color: theme.text.accent, children: t("Model Stats For Nerds") }),
        /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Box_default, { height: 1 }),
        /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)(Box_default, { children: [
          /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Box_default, { width: METRIC_COL_WIDTH, children: /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Text, { bold: true, color: theme.text.primary, children: t("Metric") }) }),
          entries.map(({ key, label }) => /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Box_default, { width: modelColWidth, children: /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Text, { bold: true, color: theme.text.primary, children: label }) }, key))
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(
          Box_default,
          {
            borderStyle: "single",
            borderBottom: true,
            borderTop: false,
            borderLeft: false,
            borderRight: false,
            borderColor: theme.border.default
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(
          StatRow2,
          {
            title: t("API"),
            values: [],
            modelColWidth,
            isSection: true
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(
          StatRow2,
          {
            title: t("Requests"),
            values: getModelValues((m) => m.api.totalRequests.toLocaleString()),
            modelColWidth
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(
          StatRow2,
          {
            title: t("Errors"),
            values: getModelValues((m) => {
              const errorRate = calculateErrorRate(m);
              return /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)(
                Text,
                {
                  color: m.api.totalErrors > 0 ? theme.status.error : theme.text.primary,
                  children: [
                    m.api.totalErrors.toLocaleString(),
                    " (",
                    errorRate.toFixed(1),
                    "%)"
                  ]
                }
              );
            }),
            modelColWidth
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(
          StatRow2,
          {
            title: t("Avg Latency"),
            values: getModelValues((m) => {
              const avgLatency = calculateAverageLatency(m);
              return formatDuration(avgLatency);
            }),
            modelColWidth
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Box_default, { height: 1 }),
        /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(
          StatRow2,
          {
            title: t("Tokens"),
            values: [],
            modelColWidth,
            isSection: true
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(
          StatRow2,
          {
            title: t("Total"),
            values: getModelValues((m) => /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Text, { color: theme.status.warning, children: m.tokens.total.toLocaleString() })),
            modelColWidth
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(
          StatRow2,
          {
            title: t("Prompt"),
            isSubtle: true,
            values: getModelValues((m) => m.tokens.prompt.toLocaleString()),
            modelColWidth
          }
        ),
        hasCached && /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(
          StatRow2,
          {
            title: t("Cached"),
            isSubtle: true,
            values: getModelValues((m) => {
              const cacheHitRate = calculateCacheHitRate(m);
              return /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)(Text, { color: theme.status.success, children: [
                m.tokens.cached.toLocaleString(),
                " (",
                cacheHitRate.toFixed(1),
                "%)"
              ] });
            }),
            modelColWidth
          }
        ),
        hasThoughts && /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(
          StatRow2,
          {
            title: t("Thoughts"),
            isSubtle: true,
            values: getModelValues((m) => m.tokens.thoughts.toLocaleString()),
            modelColWidth
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(
          StatRow2,
          {
            title: t("Output"),
            isSubtle: true,
            values: getModelValues((m) => m.tokens.candidates.toLocaleString()),
            modelColWidth
          }
        ),
        hasPricing && /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)(import_jsx_runtime8.Fragment, { children: [
          /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Box_default, { height: 1 }),
          /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(
            StatRow2,
            {
              title: t("Cost"),
              values: [],
              modelColWidth,
              isSection: true
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(
            StatRow2,
            {
              title: t("Estimated"),
              values: entries.map(({ key, metrics }) => {
                const cost = calculateCost({
                  inputTokens: metrics.tokens.prompt,
                  outputTokens: metrics.tokens.candidates + metrics.tokens.thoughts,
                  pricing: modelPricing?.[getModelName(key)]
                });
                return cost != null ? `$${cost.toFixed(4)}` : "N/A";
              }),
              modelColWidth
            }
          )
        ] })
      ]
    }
  );
}, "ModelStatsDisplay");

// packages/cli/src/ui/components/ToolStatsDisplay.tsx
init_esbuild_shims();
var import_jsx_runtime9 = __toESM(require_jsx_runtime(), 1);
var TOOL_NAME_COL_WIDTH = 25;
var CALLS_COL_WIDTH = 8;
var SUCCESS_RATE_COL_WIDTH = 15;
var AVG_DURATION_COL_WIDTH = 15;
var StatRow3 = /* @__PURE__ */ __name(({ name, stats }) => {
  const successRate = stats.count > 0 ? stats.success / stats.count * 100 : 0;
  const avgDuration = stats.count > 0 ? stats.durationMs / stats.count : 0;
  const successColor = getStatusColor(successRate, {
    green: TOOL_SUCCESS_RATE_HIGH,
    yellow: TOOL_SUCCESS_RATE_MEDIUM
  });
  return /* @__PURE__ */ (0, import_jsx_runtime9.jsxs)(Box_default, { children: [
    /* @__PURE__ */ (0, import_jsx_runtime9.jsx)(Box_default, { width: TOOL_NAME_COL_WIDTH, children: /* @__PURE__ */ (0, import_jsx_runtime9.jsx)(Text, { color: theme.text.link, children: name }) }),
    /* @__PURE__ */ (0, import_jsx_runtime9.jsx)(Box_default, { width: CALLS_COL_WIDTH, justifyContent: "flex-end", children: /* @__PURE__ */ (0, import_jsx_runtime9.jsx)(Text, { color: theme.text.primary, children: stats.count }) }),
    /* @__PURE__ */ (0, import_jsx_runtime9.jsx)(Box_default, { width: SUCCESS_RATE_COL_WIDTH, justifyContent: "flex-end", children: /* @__PURE__ */ (0, import_jsx_runtime9.jsxs)(Text, { color: successColor, children: [
      successRate.toFixed(1),
      "%"
    ] }) }),
    /* @__PURE__ */ (0, import_jsx_runtime9.jsx)(Box_default, { width: AVG_DURATION_COL_WIDTH, justifyContent: "flex-end", children: /* @__PURE__ */ (0, import_jsx_runtime9.jsx)(Text, { color: theme.text.primary, children: formatDuration(avgDuration) }) })
  ] });
}, "StatRow");
var ToolStatsDisplay = /* @__PURE__ */ __name(({
  width
}) => {
  const { stats } = useSessionStats();
  const { tools } = stats.metrics;
  const activeTools = Object.entries(tools.byName).filter(
    ([, metrics]) => metrics.count > 0
  );
  if (activeTools.length === 0) {
    return /* @__PURE__ */ (0, import_jsx_runtime9.jsx)(
      Box_default,
      {
        borderStyle: "round",
        borderColor: theme.border.default,
        paddingY: 1,
        paddingX: 2,
        width,
        children: /* @__PURE__ */ (0, import_jsx_runtime9.jsx)(Text, { color: theme.text.primary, children: t("No tool calls have been made in this session.") })
      }
    );
  }
  const totalDecisions = Object.values(tools.byName).reduce(
    (acc, tool) => {
      acc.accept += tool.decisions.accept;
      acc.reject += tool.decisions.reject;
      acc.modify += tool.decisions.modify;
      return acc;
    },
    { accept: 0, reject: 0, modify: 0 }
  );
  const totalReviewed = totalDecisions.accept + totalDecisions.reject + totalDecisions.modify;
  const agreementRate = totalReviewed > 0 ? totalDecisions.accept / totalReviewed * 100 : 0;
  const agreementColor = getStatusColor(agreementRate, {
    green: USER_AGREEMENT_RATE_HIGH,
    yellow: USER_AGREEMENT_RATE_MEDIUM
  });
  return /* @__PURE__ */ (0, import_jsx_runtime9.jsxs)(
    Box_default,
    {
      borderStyle: "round",
      borderColor: theme.border.default,
      flexDirection: "column",
      paddingY: 1,
      paddingX: 2,
      width,
      children: [
        /* @__PURE__ */ (0, import_jsx_runtime9.jsx)(Text, { bold: true, color: theme.text.accent, children: t("Tool Stats For Nerds") }),
        /* @__PURE__ */ (0, import_jsx_runtime9.jsx)(Box_default, { height: 1 }),
        /* @__PURE__ */ (0, import_jsx_runtime9.jsxs)(Box_default, { children: [
          /* @__PURE__ */ (0, import_jsx_runtime9.jsx)(Box_default, { width: TOOL_NAME_COL_WIDTH, children: /* @__PURE__ */ (0, import_jsx_runtime9.jsx)(Text, { bold: true, color: theme.text.primary, children: t("Tool Name") }) }),
          /* @__PURE__ */ (0, import_jsx_runtime9.jsx)(Box_default, { width: CALLS_COL_WIDTH, justifyContent: "flex-end", children: /* @__PURE__ */ (0, import_jsx_runtime9.jsx)(Text, { bold: true, color: theme.text.primary, children: t("Calls") }) }),
          /* @__PURE__ */ (0, import_jsx_runtime9.jsx)(Box_default, { width: SUCCESS_RATE_COL_WIDTH, justifyContent: "flex-end", children: /* @__PURE__ */ (0, import_jsx_runtime9.jsx)(Text, { bold: true, color: theme.text.primary, children: t("Success Rate") }) }),
          /* @__PURE__ */ (0, import_jsx_runtime9.jsx)(Box_default, { width: AVG_DURATION_COL_WIDTH, justifyContent: "flex-end", children: /* @__PURE__ */ (0, import_jsx_runtime9.jsx)(Text, { bold: true, color: theme.text.primary, children: t("Avg Duration") }) })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime9.jsx)(
          Box_default,
          {
            borderStyle: "single",
            borderBottom: true,
            borderTop: false,
            borderLeft: false,
            borderRight: false,
            borderColor: theme.border.default,
            width: "100%"
          }
        ),
        activeTools.map(([name, stats2]) => /* @__PURE__ */ (0, import_jsx_runtime9.jsx)(StatRow3, { name, stats: stats2 }, name)),
        /* @__PURE__ */ (0, import_jsx_runtime9.jsx)(Box_default, { height: 1 }),
        /* @__PURE__ */ (0, import_jsx_runtime9.jsx)(Text, { bold: true, color: theme.text.primary, children: t("User Decision Summary") }),
        /* @__PURE__ */ (0, import_jsx_runtime9.jsxs)(Box_default, { children: [
          /* @__PURE__ */ (0, import_jsx_runtime9.jsx)(
            Box_default,
            {
              width: TOOL_NAME_COL_WIDTH + CALLS_COL_WIDTH + SUCCESS_RATE_COL_WIDTH,
              children: /* @__PURE__ */ (0, import_jsx_runtime9.jsx)(Text, { color: theme.text.link, children: t("Total Reviewed Suggestions:") })
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime9.jsx)(Box_default, { width: AVG_DURATION_COL_WIDTH, justifyContent: "flex-end", children: /* @__PURE__ */ (0, import_jsx_runtime9.jsx)(Text, { color: theme.text.primary, children: totalReviewed }) })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime9.jsxs)(Box_default, { children: [
          /* @__PURE__ */ (0, import_jsx_runtime9.jsx)(
            Box_default,
            {
              width: TOOL_NAME_COL_WIDTH + CALLS_COL_WIDTH + SUCCESS_RATE_COL_WIDTH,
              children: /* @__PURE__ */ (0, import_jsx_runtime9.jsx)(Text, { color: theme.text.primary, children: t(" \xBB Accepted:") })
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime9.jsx)(Box_default, { width: AVG_DURATION_COL_WIDTH, justifyContent: "flex-end", children: /* @__PURE__ */ (0, import_jsx_runtime9.jsx)(Text, { color: theme.status.success, children: totalDecisions.accept }) })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime9.jsxs)(Box_default, { children: [
          /* @__PURE__ */ (0, import_jsx_runtime9.jsx)(
            Box_default,
            {
              width: TOOL_NAME_COL_WIDTH + CALLS_COL_WIDTH + SUCCESS_RATE_COL_WIDTH,
              children: /* @__PURE__ */ (0, import_jsx_runtime9.jsx)(Text, { color: theme.text.primary, children: t(" \xBB Rejected:") })
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime9.jsx)(Box_default, { width: AVG_DURATION_COL_WIDTH, justifyContent: "flex-end", children: /* @__PURE__ */ (0, import_jsx_runtime9.jsx)(Text, { color: theme.status.error, children: totalDecisions.reject }) })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime9.jsxs)(Box_default, { children: [
          /* @__PURE__ */ (0, import_jsx_runtime9.jsx)(
            Box_default,
            {
              width: TOOL_NAME_COL_WIDTH + CALLS_COL_WIDTH + SUCCESS_RATE_COL_WIDTH,
              children: /* @__PURE__ */ (0, import_jsx_runtime9.jsx)(Text, { color: theme.text.primary, children: t(" \xBB Modified:") })
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime9.jsx)(Box_default, { width: AVG_DURATION_COL_WIDTH, justifyContent: "flex-end", children: /* @__PURE__ */ (0, import_jsx_runtime9.jsx)(Text, { color: theme.status.warning, children: totalDecisions.modify }) })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime9.jsx)(
          Box_default,
          {
            borderStyle: "single",
            borderBottom: true,
            borderTop: false,
            borderLeft: false,
            borderRight: false,
            borderColor: theme.border.default,
            width: "100%"
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime9.jsxs)(Box_default, { children: [
          /* @__PURE__ */ (0, import_jsx_runtime9.jsx)(
            Box_default,
            {
              width: TOOL_NAME_COL_WIDTH + CALLS_COL_WIDTH + SUCCESS_RATE_COL_WIDTH,
              children: /* @__PURE__ */ (0, import_jsx_runtime9.jsx)(Text, { color: theme.text.primary, children: t(" Overall Agreement Rate:") })
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime9.jsx)(Box_default, { width: AVG_DURATION_COL_WIDTH, justifyContent: "flex-end", children: /* @__PURE__ */ (0, import_jsx_runtime9.jsx)(Text, { bold: true, color: totalReviewed > 0 ? agreementColor : void 0, children: totalReviewed > 0 ? `${agreementRate.toFixed(1)}%` : "--" }) })
        ] })
      ]
    }
  );
}, "ToolStatsDisplay");

// packages/cli/src/ui/components/SkillStatsDisplay.tsx
init_esbuild_shims();
var import_jsx_runtime10 = __toESM(require_jsx_runtime(), 1);
var SKILL_NAME_COL_WIDTH = 30;
var CALLS_COL_WIDTH2 = 8;
var SUCCESS_COL_WIDTH = 8;
var FAIL_COL_WIDTH = 8;
var SUCCESS_RATE_COL_WIDTH2 = 15;
var StatRow4 = /* @__PURE__ */ __name(({ name, stats }) => {
  const successRate = stats.count > 0 ? stats.success / stats.count * 100 : 0;
  const successColor = getStatusColor(successRate, {
    green: TOOL_SUCCESS_RATE_HIGH,
    yellow: TOOL_SUCCESS_RATE_MEDIUM
  });
  return /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)(Box_default, { children: [
    /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(Box_default, { width: SKILL_NAME_COL_WIDTH, children: /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(Text, { color: theme.text.link, children: name }) }),
    /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(Box_default, { width: CALLS_COL_WIDTH2, justifyContent: "flex-end", children: /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(Text, { color: theme.text.primary, children: stats.count }) }),
    /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(Box_default, { width: SUCCESS_COL_WIDTH, justifyContent: "flex-end", children: /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(Text, { color: theme.status.success, children: stats.success }) }),
    /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(Box_default, { width: FAIL_COL_WIDTH, justifyContent: "flex-end", children: /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(Text, { color: stats.fail > 0 ? theme.status.error : theme.text.primary, children: stats.fail }) }),
    /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(Box_default, { width: SUCCESS_RATE_COL_WIDTH2, justifyContent: "flex-end", children: /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)(Text, { color: successColor, children: [
      successRate.toFixed(1),
      "%"
    ] }) })
  ] });
}, "StatRow");
var SkillStatsDisplay = /* @__PURE__ */ __name(({
  width
}) => {
  const { stats } = useSessionStats();
  const skills = stats.metrics.skills ?? {
    totalCalls: 0,
    totalSuccess: 0,
    totalFail: 0,
    byName: {}
  };
  const activeSkills = Object.entries(skills.byName).filter(([, metrics]) => metrics.count > 0).sort(([leftName, left], [rightName, right]) => {
    const countDelta = right.count - left.count;
    return countDelta !== 0 ? countDelta : leftName.localeCompare(rightName);
  });
  if (activeSkills.length === 0) {
    return /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(
      Box_default,
      {
        borderStyle: "round",
        borderColor: theme.border.default,
        paddingY: 1,
        paddingX: 2,
        width,
        children: /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(Text, { color: theme.text.primary, children: t("No skill calls have been made in this session.") })
      }
    );
  }
  return /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)(
    Box_default,
    {
      borderStyle: "round",
      borderColor: theme.border.default,
      flexDirection: "column",
      paddingY: 1,
      paddingX: 2,
      width,
      children: [
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(Text, { bold: true, color: theme.text.accent, children: t("Skill Stats For Nerds") }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(Box_default, { height: 1 }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)(Box_default, { children: [
          /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(Box_default, { width: SKILL_NAME_COL_WIDTH, children: /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(Text, { bold: true, color: theme.text.primary, children: t("Skill Name") }) }),
          /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(Box_default, { width: CALLS_COL_WIDTH2, justifyContent: "flex-end", children: /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(Text, { bold: true, color: theme.text.primary, children: t("Calls") }) }),
          /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(Box_default, { width: SUCCESS_COL_WIDTH, justifyContent: "flex-end", children: /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(Text, { bold: true, color: theme.text.primary, children: t("OK") }) }),
          /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(Box_default, { width: FAIL_COL_WIDTH, justifyContent: "flex-end", children: /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(Text, { bold: true, color: theme.text.primary, children: t("Fail") }) }),
          /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(Box_default, { width: SUCCESS_RATE_COL_WIDTH2, justifyContent: "flex-end", children: /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(Text, { bold: true, color: theme.text.primary, children: t("Success Rate") }) })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(
          Box_default,
          {
            borderStyle: "single",
            borderBottom: true,
            borderTop: false,
            borderLeft: false,
            borderRight: false,
            borderColor: theme.border.default,
            width: "100%"
          }
        ),
        activeSkills.map(([name, skillStats]) => /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(StatRow4, { name, stats: skillStats }, name))
      ]
    }
  );
}, "SkillStatsDisplay");

// packages/cli/src/ui/components/SessionSummaryDisplay.tsx
init_esbuild_shims();
var import_jsx_runtime11 = __toESM(require_jsx_runtime(), 1);
var SessionSummaryDisplay = /* @__PURE__ */ __name(({
  duration,
  width
}) => {
  const config = useConfig();
  const { stats } = useSessionStats();
  const hasMessages = stats.promptCount > 0;
  const canResume = !!config.getChatRecordingService();
  return /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)(import_jsx_runtime11.Fragment, { children: [
    /* @__PURE__ */ (0, import_jsx_runtime11.jsx)(
      StatsDisplay,
      {
        title: t("Agent powering down. Goodbye!"),
        duration,
        width
      }
    ),
    hasMessages && canResume && /* @__PURE__ */ (0, import_jsx_runtime11.jsx)(Box_default, { marginTop: 1, children: /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)(Text, { color: theme.text.secondary, children: [
      t("To continue this session, run"),
      " ",
      /* @__PURE__ */ (0, import_jsx_runtime11.jsxs)(Text, { color: theme.text.accent, children: [
        "qwen --resume ",
        stats.sessionId
      ] })
    ] }) })
  ] });
}, "SessionSummaryDisplay");

// packages/cli/src/ui/components/Help.tsx
init_esbuild_shims();
var import_react9 = __toESM(require_react(), 1);
var import_jsx_runtime12 = __toESM(require_jsx_runtime(), 1);
var DEFAULT_WIDTH = 100;
var KEY_COL_WIDTH = 20;
var COMMAND_LIST_VISIBLE_LINES = 18;
var TAB_DEFS = [
  { tab: "general", labelKey: "general" },
  { tab: "commands", labelKey: "commands" },
  { tab: "custom-commands", labelKey: "custom-commands" }
];
var DOCS_URL = "https://qwenlm.github.io/qwen-code-docs/";
var Help = /* @__PURE__ */ __name(({
  commands,
  width = DEFAULT_WIDTH,
  activeTab = "general",
  onTabChange,
  onClose,
  isInteractive = false
}) => {
  const safeWidth = Math.max(72, width);
  const bodyWidth = safeWidth - 6;
  const handleTabChange = (0, import_react9.useCallback)(
    (direction) => {
      const currentIndex = TAB_DEFS.findIndex((tab) => tab.tab === activeTab);
      const nextIndex = (currentIndex + direction + TAB_DEFS.length) % TAB_DEFS.length;
      onTabChange?.(TAB_DEFS[nextIndex].tab);
    },
    [activeTab, onTabChange]
  );
  useKeypress(
    (key) => {
      if (key.name === "escape") {
        onClose?.();
        return;
      }
      if (key.name === "tab") {
        handleTabChange(key.shift ? -1 : 1);
      }
    },
    { isActive: isInteractive }
  );
  return /* @__PURE__ */ (0, import_jsx_runtime12.jsx)(Box_default, { flexDirection: "column", width: safeWidth, children: /* @__PURE__ */ (0, import_jsx_runtime12.jsx)(
    Box_default,
    {
      borderColor: theme.border.default,
      borderStyle: "single",
      width: safeWidth,
      children: /* @__PURE__ */ (0, import_jsx_runtime12.jsxs)(
        Box_default,
        {
          flexDirection: "column",
          paddingX: 2,
          paddingY: 1,
          width: safeWidth - 2,
          children: [
            /* @__PURE__ */ (0, import_jsx_runtime12.jsx)(HelpTabs, { activeTab }),
            /* @__PURE__ */ (0, import_jsx_runtime12.jsxs)(Box_default, { marginTop: 1, children: [
              activeTab === "general" && /* @__PURE__ */ (0, import_jsx_runtime12.jsx)(GeneralHelp, { width: bodyWidth }),
              activeTab === "commands" && /* @__PURE__ */ (0, import_jsx_runtime12.jsx)(
                CommandsHelp,
                {
                  commands,
                  width: bodyWidth,
                  customOnly: false,
                  isInteractive
                }
              ),
              activeTab === "custom-commands" && /* @__PURE__ */ (0, import_jsx_runtime12.jsx)(
                CommandsHelp,
                {
                  commands,
                  width: bodyWidth,
                  customOnly: true,
                  isInteractive
                }
              )
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime12.jsx)(Box_default, { marginTop: 1, children: /* @__PURE__ */ (0, import_jsx_runtime12.jsxs)(Text, { color: theme.text.secondary, children: [
              t("For more help:"),
              " ",
              /* @__PURE__ */ (0, import_jsx_runtime12.jsx)(Text, { underline: true, children: DOCS_URL })
            ] }) }),
            /* @__PURE__ */ (0, import_jsx_runtime12.jsx)(Box_default, { marginTop: 1, children: /* @__PURE__ */ (0, import_jsx_runtime12.jsx)(Text, { italic: true, color: theme.text.secondary, children: t("Tab/Shift+Tab to switch tabs  \xB7  Esc to cancel") }) })
          ]
        }
      )
    }
  ) });
}, "Help");
var HelpTabs = /* @__PURE__ */ __name(({ activeTab }) => /* @__PURE__ */ (0, import_jsx_runtime12.jsxs)(Box_default, { flexDirection: "row", children: [
  /* @__PURE__ */ (0, import_jsx_runtime12.jsx)(Text, { bold: true, color: theme.text.accent, children: "Qwen Code" }),
  /* @__PURE__ */ (0, import_jsx_runtime12.jsx)(Text, { color: theme.text.secondary, children: " " }),
  TAB_DEFS.map(({ tab, labelKey }) => {
    const active = tab === activeTab;
    return /* @__PURE__ */ (0, import_jsx_runtime12.jsx)(Box_default, { marginLeft: 1, children: /* @__PURE__ */ (0, import_jsx_runtime12.jsx)(
      Text,
      {
        color: active ? theme.background.primary : theme.text.primary,
        backgroundColor: active ? theme.text.accent : void 0,
        children: ` ${t(labelKey)} `
      }
    ) }, tab);
  })
] }), "HelpTabs");
var GeneralHelp = /* @__PURE__ */ __name(({ width }) => {
  const shortcuts = [
    ["@", t("Add files or folders as context")],
    ["!", t("Run shell commands")],
    ["/", t("Open command menu")],
    ["Tab", t("Accept ghost text or completion")],
    ["Esc Esc", t("Clear input or cancel operation")],
    ["Ctrl+L", t("Clear the screen")],
    ["Ctrl+Q", t("Queue message for the next turn")],
    [
      process.platform === "win32" ? "Ctrl+Enter" : "Ctrl+J",
      t("Insert a newline")
    ],
    [
      process.platform === "win32" ? "Tab" : "Shift+Tab",
      t("Cycle approval modes")
    ],
    ["Alt+\u2190/\u2192", t("Jump through words")],
    ["\u2191/\u2193", t("Cycle prompt history")]
  ];
  const left = shortcuts.slice(0, Math.ceil(shortcuts.length / 2));
  const right = shortcuts.slice(Math.ceil(shortcuts.length / 2));
  const colWidth = Math.floor((width - 2) / 2);
  return /* @__PURE__ */ (0, import_jsx_runtime12.jsxs)(Box_default, { flexDirection: "column", children: [
    /* @__PURE__ */ (0, import_jsx_runtime12.jsx)(Box_default, { marginBottom: 1, children: /* @__PURE__ */ (0, import_jsx_runtime12.jsx)(Text, { color: theme.text.primary, children: t(
      "Qwen Code understands your codebase, makes edits with your permission, and executes commands right from your terminal."
    ) }) }),
    /* @__PURE__ */ (0, import_jsx_runtime12.jsx)(Text, { bold: true, color: theme.text.primary, children: t("Shortcuts") }),
    /* @__PURE__ */ (0, import_jsx_runtime12.jsxs)(Box_default, { flexDirection: "row", gap: 2, children: [
      /* @__PURE__ */ (0, import_jsx_runtime12.jsx)(Box_default, { flexDirection: "column", width: colWidth, children: left.map(([key, desc]) => /* @__PURE__ */ (0, import_jsx_runtime12.jsx)(
        ShortcutRow,
        {
          shortcutKey: key,
          desc,
          width: colWidth
        },
        key
      )) }),
      /* @__PURE__ */ (0, import_jsx_runtime12.jsx)(Box_default, { flexDirection: "column", width: colWidth, children: right.map(([key, desc]) => /* @__PURE__ */ (0, import_jsx_runtime12.jsx)(
        ShortcutRow,
        {
          shortcutKey: key,
          desc,
          width: colWidth
        },
        key
      )) })
    ] })
  ] });
}, "GeneralHelp");
var ShortcutRow = /* @__PURE__ */ __name(({ shortcutKey, desc, width }) => /* @__PURE__ */ (0, import_jsx_runtime12.jsxs)(Box_default, { flexDirection: "row", width, children: [
  /* @__PURE__ */ (0, import_jsx_runtime12.jsx)(Box_default, { width: KEY_COL_WIDTH, flexShrink: 0, children: /* @__PURE__ */ (0, import_jsx_runtime12.jsx)(Text, { color: theme.text.accent, children: shortcutKey }) }),
  /* @__PURE__ */ (0, import_jsx_runtime12.jsx)(Text, { color: theme.text.primary, wrap: "truncate", children: truncateText2(desc, width - KEY_COL_WIDTH - 1) })
] }), "ShortcutRow");
var CommandsHelp = /* @__PURE__ */ __name(({ commands, width, customOnly, isInteractive }) => {
  const groups = (0, import_react9.useMemo)(
    () => groupCommands(commands, customOnly),
    [commands, customOnly]
  );
  const lines = (0, import_react9.useMemo)(
    () => renderCommandLines(groups, width),
    [groups, width]
  );
  const maxScroll = Math.max(0, lines.length - COMMAND_LIST_VISIBLE_LINES);
  const [scrollOffset, setScrollOffset] = (0, import_react9.useState)(0);
  (0, import_react9.useEffect)(() => {
    setScrollOffset(0);
  }, [customOnly, commands]);
  (0, import_react9.useEffect)(() => {
    setScrollOffset((offset) => Math.min(offset, maxScroll));
  }, [maxScroll]);
  useKeypress(
    (key) => {
      if (key.name === "up") {
        setScrollOffset((offset) => Math.max(0, offset - 1));
      } else if (key.name === "down") {
        setScrollOffset((offset) => Math.min(maxScroll, offset + 1));
      } else if (key.name === "pageup") {
        setScrollOffset(
          (offset) => Math.max(0, offset - COMMAND_LIST_VISIBLE_LINES)
        );
      } else if (key.name === "pagedown") {
        setScrollOffset(
          (offset) => Math.min(maxScroll, offset + COMMAND_LIST_VISIBLE_LINES)
        );
      }
    },
    { isActive: isInteractive }
  );
  if (groups.length === 0) {
    return /* @__PURE__ */ (0, import_jsx_runtime12.jsx)(Text, { color: theme.text.secondary, children: customOnly ? t("No custom commands are currently available.") : t("No commands are currently available.") });
  }
  const visibleLines = lines.slice(
    scrollOffset,
    scrollOffset + COMMAND_LIST_VISIBLE_LINES
  );
  return /* @__PURE__ */ (0, import_jsx_runtime12.jsxs)(Box_default, { flexDirection: "column", children: [
    /* @__PURE__ */ (0, import_jsx_runtime12.jsx)(Box_default, { marginBottom: 1, children: /* @__PURE__ */ (0, import_jsx_runtime12.jsx)(Text, { color: theme.text.primary, children: customOnly ? t("Browse custom, skill, plugin, and MCP commands:") : t("Browse built-in commands:") }) }),
    /* @__PURE__ */ (0, import_jsx_runtime12.jsx)(Box_default, { flexDirection: "column", height: COMMAND_LIST_VISIBLE_LINES, children: visibleLines.map((line, index) => {
      const stableKey = line.type === "blank" ? `blank:${index}` : `${line.type}:${line.text}:${index}`;
      return /* @__PURE__ */ (0, import_jsx_runtime12.jsx)(CommandLine, { line }, stableKey);
    }) }),
    maxScroll > 0 && (() => {
      const totalCommands = lines.filter(
        (l) => l.type === "signature"
      ).length;
      const visibleSignatures = visibleLines.filter(
        (l) => l.type === "signature"
      );
      const firstCmd = visibleSignatures.length > 0 ? visibleSignatures[0].commandIndex + 1 : 0;
      const lastCmd = visibleSignatures.length > 0 ? visibleSignatures[visibleSignatures.length - 1].commandIndex + 1 : 0;
      const range = firstCmd === lastCmd ? `${firstCmd}` : `${firstCmd}-${lastCmd}`;
      return /* @__PURE__ */ (0, import_jsx_runtime12.jsx)(Box_default, { marginTop: 1, children: /* @__PURE__ */ (0, import_jsx_runtime12.jsxs)(Text, { color: theme.text.secondary, children: [
        t("Use \u2191/\u2193 to scroll"),
        " ",
        `(${range}/${totalCommands})`
      ] }) });
    })()
  ] });
}, "CommandsHelp");
var CommandLine = /* @__PURE__ */ __name(({ line }) => {
  switch (line.type) {
    case "group":
      return /* @__PURE__ */ (0, import_jsx_runtime12.jsxs)(Text, { bold: true, color: theme.text.primary, children: [
        line.text,
        " ",
        /* @__PURE__ */ (0, import_jsx_runtime12.jsx)(Text, { color: theme.text.secondary, children: `(${line.count})` })
      ] });
    case "signature":
      return /* @__PURE__ */ (0, import_jsx_runtime12.jsxs)(Box_default, { flexDirection: "row", children: [
        /* @__PURE__ */ (0, import_jsx_runtime12.jsxs)(Text, { color: theme.text.accent, children: [
          " ",
          line.text
        ] }),
        line.meta && /* @__PURE__ */ (0, import_jsx_runtime12.jsxs)(Text, { color: theme.text.secondary, children: [
          " ",
          line.meta
        ] })
      ] });
    case "description":
      return /* @__PURE__ */ (0, import_jsx_runtime12.jsx)(Box_default, { paddingLeft: 4, children: /* @__PURE__ */ (0, import_jsx_runtime12.jsx)(Text, { color: theme.text.primary, wrap: "truncate", children: line.text }) });
    case "subcommands":
      return /* @__PURE__ */ (0, import_jsx_runtime12.jsx)(Box_default, { paddingLeft: 4, children: /* @__PURE__ */ (0, import_jsx_runtime12.jsx)(Text, { color: theme.text.secondary, wrap: "truncate", children: line.text }) });
    case "blank":
      return /* @__PURE__ */ (0, import_jsx_runtime12.jsx)(Text, { children: " " });
    default:
      return null;
  }
}, "CommandLine");
function renderCommandLines(groups, width) {
  const lines = [];
  let commandIndex = 0;
  groups.forEach((group, groupIndex) => {
    lines.push({
      type: "group",
      text: group.title,
      count: group.commands.length
    });
    group.commands.forEach((cmd) => {
      const sigLine = getCommandSignatureLine(cmd, width);
      lines.push({ ...sigLine, commandIndex: commandIndex++ });
      const descriptionLine = getCommandDescriptionLine(cmd, width);
      if (descriptionLine) {
        lines.push(descriptionLine);
      }
      const subcommandsLine = getCommandSubcommandsLine(cmd, width);
      if (subcommandsLine) {
        lines.push(subcommandsLine);
      }
    });
    if (groupIndex < groups.length - 1) {
      lines.push({ type: "blank" });
    }
  });
  return lines;
}
__name(renderCommandLines, "renderCommandLines");
function getCommandSignatureLine(command, width) {
  const badge = getCommandSourceBadge(command);
  const name = getCommandDisplayName(command, {
    prefix: "/",
    includeAliases: false
  });
  const signature = [name, command.argumentHint].filter(Boolean).join(" ");
  const meta = [
    badge,
    formatSupportedModes(command),
    command.modelInvocable ? "[model]" : void 0
  ].filter(Boolean).join(" ");
  return {
    type: "signature",
    text: truncateText2(signature, Math.floor(width * 0.42)),
    meta,
    commandIndex: -1
    // assigned by renderCommandLines
  };
}
__name(getCommandSignatureLine, "getCommandSignatureLine");
function getCommandDescriptionLine(command, width) {
  if (!command.description) {
    return null;
  }
  return {
    type: "description",
    text: truncateText2(command.description, Math.max(20, width - 4))
  };
}
__name(getCommandDescriptionLine, "getCommandDescriptionLine");
function getCommandSubcommandsLine(command, width) {
  const subcommands = getCommandSubcommandNames(command);
  if (subcommands.length === 0) {
    return null;
  }
  const descWidth = Math.max(20, width - 4);
  return {
    type: "subcommands",
    text: `${t("subcommands:")} ${truncateText2(subcommands.join(", "), descWidth - 13)}`
  };
}
__name(getCommandSubcommandsLine, "getCommandSubcommandsLine");
function groupCommands(commands, customOnly) {
  const groups = /* @__PURE__ */ new Map();
  commands.filter((cmd) => cmd.description && !cmd.hidden).forEach((cmd) => {
    const group = getCommandSourceGroup(cmd);
    if (customOnly ? group.key === "built-in" : group.key !== "built-in") {
      return;
    }
    const existing = groups.get(group.key);
    if (existing) {
      existing.commands.push(cmd);
    } else {
      groups.set(group.key, {
        key: group.key,
        title: group.title,
        order: group.order,
        commands: [cmd]
      });
    }
  });
  return Array.from(groups.values()).sort((a, b) => a.order - b.order).map((group) => ({
    ...group,
    commands: group.commands.sort((a, b) => a.name.localeCompare(b.name))
  }));
}
__name(groupCommands, "groupCommands");
function truncateText2(text, maxLength) {
  if (maxLength <= 1 || text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}\u2026`;
}
__name(truncateText2, "truncateText");

// packages/cli/src/ui/components/views/ExtensionsList.tsx
init_esbuild_shims();

// packages/cli/src/ui/contexts/UIStateContext.tsx
init_esbuild_shims();
var import_react16 = __toESM(require_react(), 1);

// packages/cli/src/ui/hooks/useHistoryManager.ts
init_esbuild_shims();
var import_react10 = __toESM(require_react(), 1);
import process2 from "node:process";
var debugLogger = createDebugLogger("HISTORY_MANAGER");
var UI_COMPACT_CLEARED_MESSAGE = "[Old tool result content cleared]";
var UI_COMPACT_CLEARED_IMAGE_MESSAGE = "[Old assistant image content cleared]";
var UI_COMPACT_KEEP_RECENT = 20;
function useHistory() {
  const [history, setHistory] = (0, import_react10.useState)([]);
  const messageIdCounterRef = (0, import_react10.useRef)(0);
  const lastMessageIdRef = (0, import_react10.useRef)(0);
  const getNextMessageId = (0, import_react10.useCallback)((baseTimestamp) => {
    messageIdCounterRef.current += 1;
    const id = Math.max(
      baseTimestamp + messageIdCounterRef.current,
      lastMessageIdRef.current + 1
    );
    lastMessageIdRef.current = id;
    return id;
  }, []);
  const loadHistory = (0, import_react10.useCallback)((newHistory) => {
    setHistory(newHistory);
    let maxLoadedId = 0;
    for (const item of newHistory) {
      if (item.id > maxLoadedId) {
        maxLoadedId = item.id;
      }
    }
    messageIdCounterRef.current = Math.max(
      messageIdCounterRef.current,
      maxLoadedId - Date.now()
    );
    lastMessageIdRef.current = Math.max(lastMessageIdRef.current, maxLoadedId);
  }, []);
  const addItem = (0, import_react10.useCallback)(
    (itemData, baseTimestamp) => {
      const id = getNextMessageId(baseTimestamp);
      const newItem = { ...itemData, id };
      setHistory((prevHistory) => {
        if (prevHistory.length > 0) {
          const lastItem = prevHistory[prevHistory.length - 1];
          if (lastItem.type === "user" && newItem.type === "user" && lastItem.text === newItem.text) {
            return prevHistory;
          }
        }
        const newHistory = [...prevHistory, newItem];
        if (debugLogger.isEnabled()) {
          const textSize = newItem.text?.length ?? 0;
          debugLogger.debug(
            `[ADD_ITEM] type=${newItem.type}, textSize=${textSize}, historyLength=${newHistory.length}`
          );
        }
        if (newItem.type === "tool_group" && newItem.tools.some(
          (tool) => isFindingsListDisplay(tool.resultDisplay)
        )) {
          return coalesceFindingsHistoryItems(newHistory);
        }
        return newHistory;
      });
      return id;
    },
    [getNextMessageId]
  );
  const updateItem = (0, import_react10.useCallback)(
    (id, updates) => {
      setHistory((prevHistory) => {
        let updated = false;
        const nextHistory = prevHistory.map((item) => {
          if (item.id === id) {
            updated = true;
            const newUpdates = typeof updates === "function" ? updates(item) : updates;
            return { ...item, ...newUpdates };
          }
          return item;
        });
        if (!updated) {
          debugLogger.debug(
            `Skipped history update; item ${id} was not found.`
          );
          return prevHistory;
        }
        return nextHistory;
      });
    },
    []
  );
  const clearItems = (0, import_react10.useCallback)(() => {
    if (debugLogger.isEnabled()) {
      debugLogger.debug(
        `[CLEAR_HISTORY] Clearing history, memory before=${(process2.memoryUsage().heapUsed / 1024 / 1024).toFixed(1)}MB`
      );
    }
    setHistory([]);
    messageIdCounterRef.current = 0;
    lastMessageIdRef.current = 0;
  }, []);
  const truncateToItem = (0, import_react10.useCallback)((itemId) => {
    setHistory((prev) => {
      const index = prev.findIndex((h) => h.id === itemId);
      return index === -1 ? prev : prev.slice(0, index);
    });
  }, []);
  const compactOldItems = (0, import_react10.useCallback)(() => {
    setHistory((prev) => {
      if (prev.length === 0) return prev;
      let thoughtRemoved = 0;
      let toolGroupsCompacted = 0;
      let assistantImageItemsCompacted = 0;
      let totalThoughts = 0;
      let totalToolGroupsWithOutput = 0;
      let totalAssistantItemsWithImages = 0;
      for (const item of prev) {
        if (item.type === "gemini_thought" || item.type === "gemini_thought_content") {
          totalThoughts++;
        } else if ((item.type === "gemini" || item.type === "gemini_content") && (item.images?.length || item.omittedImageCount)) {
          totalAssistantItemsWithImages++;
        } else if (item.type === "tool_group" && item.tools.some(
          (t2) => t2.resultDisplay != null && t2.resultDisplay !== UI_COMPACT_CLEARED_MESSAGE || t2.detailedDisplay != null || Boolean(t2.images?.length || t2.omittedImageCount)
        )) {
          totalToolGroupsWithOutput++;
        }
      }
      const thoughtsToDrop = Math.max(
        0,
        totalThoughts - UI_COMPACT_KEEP_RECENT
      );
      const toolGroupsToCompact = Math.max(
        0,
        totalToolGroupsWithOutput - UI_COMPACT_KEEP_RECENT
      );
      const assistantImageItemsToCompact = Math.max(
        0,
        totalAssistantItemsWithImages - UI_COMPACT_KEEP_RECENT
      );
      let thoughtsDropped = 0;
      let toolGroupsSeen = 0;
      let assistantImageItemsSeen = 0;
      const next = prev.filter((item) => {
        if (item.type === "gemini_thought" || item.type === "gemini_thought_content") {
          if (thoughtsDropped < thoughtsToDrop) {
            thoughtsDropped++;
            thoughtRemoved++;
            return false;
          }
        }
        return true;
      }).map((item) => {
        if ((item.type === "gemini" || item.type === "gemini_content") && (item.images?.length || item.omittedImageCount)) {
          assistantImageItemsSeen++;
          if (assistantImageItemsSeen <= assistantImageItemsToCompact) {
            assistantImageItemsCompacted++;
            return {
              ...item,
              text: item.text ? `${item.text}

${UI_COMPACT_CLEARED_IMAGE_MESSAGE}` : UI_COMPACT_CLEARED_IMAGE_MESSAGE,
              images: void 0,
              omittedImageCount: void 0
            };
          }
        }
        if (item.type !== "tool_group") return item;
        const hasOldOutput = item.tools.some(
          (t2) => t2.resultDisplay != null && t2.resultDisplay !== UI_COMPACT_CLEARED_MESSAGE || t2.detailedDisplay != null || Boolean(t2.images?.length || t2.omittedImageCount)
        );
        if (!hasOldOutput) return item;
        toolGroupsSeen++;
        if (toolGroupsSeen > toolGroupsToCompact) return item;
        toolGroupsCompacted++;
        return {
          ...item,
          tools: item.tools.map((t2) => {
            if (t2.resultDisplay != null && t2.resultDisplay !== UI_COMPACT_CLEARED_MESSAGE || t2.detailedDisplay != null || t2.images?.length || t2.omittedImageCount) {
              return {
                ...t2,
                resultDisplay: UI_COMPACT_CLEARED_MESSAGE,
                detailedDisplay: void 0,
                supersededFindingsDisplay: void 0,
                images: void 0,
                omittedImageCount: void 0
              };
            }
            return t2;
          })
        };
      });
      if (thoughtRemoved > 0 || toolGroupsCompacted > 0 || assistantImageItemsCompacted > 0) {
        if (debugLogger.isEnabled()) {
          debugLogger.debug(
            `[COMPACT_UI_HISTORY] removed ${thoughtRemoved} thought item(s), compacted ${assistantImageItemsCompacted} assistant image item(s), compacted ${toolGroupsCompacted} tool group(s), historyLength ${prev.length} -> ${next.length}, memory=${(process2.memoryUsage().heapUsed / 1024 / 1024).toFixed(1)}MB`
          );
        }
      }
      return thoughtRemoved > 0 || toolGroupsCompacted > 0 || assistantImageItemsCompacted > 0 ? next : prev;
    });
  }, []);
  return (0, import_react10.useMemo)(
    () => ({
      history,
      addItem,
      updateItem,
      clearItems,
      loadHistory,
      truncateToItem,
      compactOldItems
    }),
    [
      history,
      addItem,
      updateItem,
      clearItems,
      loadHistory,
      truncateToItem,
      compactOldItems
    ]
  );
}
__name(useHistory, "useHistory");

// packages/cli/src/ui/contexts/UIActionsContext.tsx
init_esbuild_shims();
var import_react13 = __toESM(require_react(), 1);

// packages/cli/src/ui/IdeIntegrationNudge.tsx
init_esbuild_shims();
var import_jsx_runtime13 = __toESM(require_jsx_runtime(), 1);
function IdeIntegrationNudge({
  ide,
  onComplete
}) {
  useKeypress(
    (key) => {
      if (key.name === "escape") {
        onComplete({
          userSelection: "no",
          isExtensionPreInstalled: false
        });
      }
    },
    { isActive: true }
  );
  const { displayName: ideName } = ide;
  const isInSandbox = !!process.env["SANDBOX"];
  const isExtensionPreInstalled = !!process.env["QWEN_CODE_IDE_SERVER_PORT"] && !!process.env["QWEN_CODE_IDE_WORKSPACE_PATH"];
  const OPTIONS = [
    {
      label: "Yes",
      value: {
        userSelection: "yes",
        isExtensionPreInstalled
      },
      key: "Yes"
    },
    {
      label: "No (esc)",
      value: {
        userSelection: "no",
        isExtensionPreInstalled
      },
      key: "No (esc)"
    },
    {
      label: "No, don't ask again",
      value: {
        userSelection: "dismiss",
        isExtensionPreInstalled
      },
      key: "No, don't ask again"
    }
  ];
  const installText = isInSandbox ? `Note: In sandbox environments, IDE integration requires manual setup on the host system. If you select Yes, you'll receive instructions on how to set this up.` : isExtensionPreInstalled ? `If you select Yes, the CLI will connect to your ${ideName ?? "editor"} and have access to your open files and display diffs directly.` : `If you select Yes, we'll install an extension that allows the CLI to access your open files and display diffs directly in ${ideName ?? "your editor"}.`;
  return /* @__PURE__ */ (0, import_jsx_runtime13.jsxs)(
    Box_default,
    {
      flexDirection: "column",
      borderStyle: "round",
      borderColor: theme.status.warning,
      padding: 1,
      width: "100%",
      marginLeft: 1,
      children: [
        /* @__PURE__ */ (0, import_jsx_runtime13.jsxs)(Box_default, { marginBottom: 1, flexDirection: "column", children: [
          /* @__PURE__ */ (0, import_jsx_runtime13.jsxs)(Text, { children: [
            /* @__PURE__ */ (0, import_jsx_runtime13.jsx)(Text, { color: theme.status.warning, children: "> " }),
            `Do you want to connect ${ideName ?? "your editor"} to Qwen Code?`
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime13.jsx)(Text, { color: theme.text.secondary, children: installText })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime13.jsx)(RadioButtonSelect, { items: OPTIONS, onSelect: onComplete })
      ]
    }
  );
}
__name(IdeIntegrationNudge, "IdeIntegrationNudge");

// packages/cli/src/ui/CommandFormatMigrationNudge.tsx
init_esbuild_shims();
var import_jsx_runtime14 = __toESM(require_jsx_runtime(), 1);
function CommandFormatMigrationNudge({
  tomlFiles,
  onComplete
}) {
  useKeypress(
    (key) => {
      if (key.name === "escape") {
        onComplete({
          userSelection: "no"
        });
      }
    },
    { isActive: true }
  );
  const OPTIONS = [
    {
      label: t("Yes"),
      value: {
        userSelection: "yes"
      },
      key: "Yes"
    },
    {
      label: t("No (esc)"),
      value: {
        userSelection: "no"
      },
      key: "No (esc)"
    }
  ];
  const count = tomlFiles.length;
  const fileList = count <= 3 ? tomlFiles.map((f) => `  \u2022 ${f}`).join("\n") : `  \u2022 ${tomlFiles.slice(0, 2).join("\n  \u2022 ")}
  \u2022 ${t("... and {{count}} more", { count: String(count - 2) })}`;
  return /* @__PURE__ */ (0, import_jsx_runtime14.jsxs)(
    Box_default,
    {
      flexDirection: "column",
      borderStyle: "round",
      borderColor: theme.status.warning,
      padding: 1,
      width: "100%",
      marginLeft: 1,
      children: [
        /* @__PURE__ */ (0, import_jsx_runtime14.jsxs)(Box_default, { marginBottom: 1, flexDirection: "column", children: [
          /* @__PURE__ */ (0, import_jsx_runtime14.jsxs)(Text, { children: [
            /* @__PURE__ */ (0, import_jsx_runtime14.jsx)(Text, { color: theme.status.warning, children: "\u26A0  " }),
            /* @__PURE__ */ (0, import_jsx_runtime14.jsx)(Text, { bold: true, children: t("Command Format Migration") })
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime14.jsx)(Text, { color: theme.text.secondary, children: count > 1 ? t("Found {{count}} TOML command files:", { count: String(count) }) : t("Found {{count}} TOML command file:", { count: String(count) }) }),
          /* @__PURE__ */ (0, import_jsx_runtime14.jsx)(Text, { color: theme.text.secondary, children: fileList }),
          /* @__PURE__ */ (0, import_jsx_runtime14.jsx)(Text, { children: "" }),
          /* @__PURE__ */ (0, import_jsx_runtime14.jsx)(Text, { color: theme.text.secondary, children: t(
            "The TOML format is deprecated. Would you like to migrate them to Markdown format?"
          ) }),
          /* @__PURE__ */ (0, import_jsx_runtime14.jsx)(Text, { color: theme.text.secondary, children: t("(Backups will be created and original files will be preserved)") })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime14.jsx)(RadioButtonSelect, { items: OPTIONS, onSelect: onComplete })
      ]
    }
  );
}
__name(CommandFormatMigrationNudge, "CommandFormatMigrationNudge");

// packages/cli/src/ui/components/FolderTrustDialog.tsx
init_esbuild_shims();
var import_react11 = __toESM(require_react(), 1);
import * as process3 from "node:process";
import * as path from "node:path";
var import_jsx_runtime15 = __toESM(require_jsx_runtime(), 1);
var FolderTrustDialog = /* @__PURE__ */ __name(({
  onSelect,
  isRestarting
}) => {
  (0, import_react11.useEffect)(() => {
    const doRelaunch = /* @__PURE__ */ __name(async () => {
      if (isRestarting) {
        setTimeout(async () => {
          await relaunchApp();
        }, 250);
      }
    }, "doRelaunch");
    doRelaunch();
  }, [isRestarting]);
  useKeypress(
    (key) => {
      if (key.name === "escape") {
        onSelect("do_not_trust" /* DO_NOT_TRUST */);
      }
    },
    { isActive: !isRestarting }
  );
  const dirName = path.basename(process3.cwd());
  const parentFolder = path.basename(path.dirname(process3.cwd()));
  const options = [
    {
      label: `Trust folder (${dirName})`,
      value: "trust_folder" /* TRUST_FOLDER */,
      key: `Trust folder (${dirName})`
    },
    {
      label: `Trust parent folder (${parentFolder})`,
      value: "trust_parent" /* TRUST_PARENT */,
      key: `Trust parent folder (${parentFolder})`
    },
    {
      label: "Don't trust (esc)",
      value: "do_not_trust" /* DO_NOT_TRUST */,
      key: "Don't trust (esc)"
    }
  ];
  return /* @__PURE__ */ (0, import_jsx_runtime15.jsxs)(Box_default, { flexDirection: "column", children: [
    /* @__PURE__ */ (0, import_jsx_runtime15.jsxs)(
      Box_default,
      {
        flexDirection: "column",
        borderStyle: "round",
        borderColor: theme.status.warning,
        padding: 1,
        width: "100%",
        marginLeft: 1,
        children: [
          /* @__PURE__ */ (0, import_jsx_runtime15.jsxs)(Box_default, { flexDirection: "column", marginBottom: 1, children: [
            /* @__PURE__ */ (0, import_jsx_runtime15.jsx)(Text, { bold: true, color: theme.text.primary, children: "Do you trust this folder?" }),
            /* @__PURE__ */ (0, import_jsx_runtime15.jsx)(Text, { color: theme.text.primary, children: "Trusting a folder allows Qwen Code to execute commands it suggests. This is a security feature to prevent accidental execution in untrusted directories." })
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime15.jsx)(
            RadioButtonSelect,
            {
              items: options,
              onSelect,
              isFocused: !isRestarting
            }
          )
        ]
      }
    ),
    isRestarting && /* @__PURE__ */ (0, import_jsx_runtime15.jsx)(Box_default, { marginLeft: 1, marginTop: 1, children: /* @__PURE__ */ (0, import_jsx_runtime15.jsx)(Text, { color: theme.status.warning, children: "Qwen Code is restarting to apply the trust changes..." }) })
  ] });
}, "FolderTrustDialog");

// packages/cli/src/ui/hooks/useArenaCommand.ts
init_esbuild_shims();
var import_react12 = __toESM(require_react(), 1);
function useArenaCommand() {
  const [activeArenaDialog, setActiveArenaDialog] = (0, import_react12.useState)(null);
  const openArenaDialog = (0, import_react12.useCallback)(
    (type) => {
      setActiveArenaDialog(type);
    },
    []
  );
  const closeArenaDialog = (0, import_react12.useCallback)(() => {
    setActiveArenaDialog(null);
  }, []);
  return {
    activeArenaDialog,
    openArenaDialog,
    closeArenaDialog
  };
}
__name(useArenaCommand, "useArenaCommand");

// packages/cli/src/ui/contexts/UIActionsContext.tsx
var UIActionsContext = (0, import_react13.createContext)(null);
var useUIActions = /* @__PURE__ */ __name(() => {
  const context = (0, import_react13.useContext)(UIActionsContext);
  if (!context) {
    throw new Error("useUIActions must be used within a UIActionsProvider");
  }
  return context;
}, "useUIActions");

// packages/cli/src/ui/hooks/useIdeTrustListener.ts
init_esbuild_shims();
var import_react14 = __toESM(require_react(), 1);
function useIdeTrustListener() {
  const settings = useSettings();
  const [connectionStatus, setConnectionStatus] = (0, import_react14.useState)(
    "disconnected" /* Disconnected */
  );
  const previousTrust = (0, import_react14.useRef)(void 0);
  const [restartReason, setRestartReason] = (0, import_react14.useState)("NONE");
  const [needsRestart, setNeedsRestart] = (0, import_react14.useState)(false);
  const subscribe = (0, import_react14.useCallback)((onStoreChange) => {
    const handleStatusChange = /* @__PURE__ */ __name((state) => {
      setConnectionStatus(state.status);
      setRestartReason("CONNECTION_CHANGE");
      onStoreChange();
    }, "handleStatusChange");
    const handleTrustChange = /* @__PURE__ */ __name(() => {
      setRestartReason("TRUST_CHANGE");
      onStoreChange();
    }, "handleTrustChange");
    (async () => {
      const ideClient = await IdeClient.getInstance();
      ideClient.addTrustChangeListener(handleTrustChange);
      ideClient.addStatusChangeListener(handleStatusChange);
      setConnectionStatus(ideClient.getConnectionStatus().status);
    })();
    return () => {
      (async () => {
        const ideClient = await IdeClient.getInstance();
        ideClient.removeTrustChangeListener(handleTrustChange);
        ideClient.removeStatusChangeListener(handleStatusChange);
      })();
    };
  }, []);
  const getSnapshot = /* @__PURE__ */ __name(() => {
    if (connectionStatus !== "connected" /* Connected */) {
      return void 0;
    }
    return ideContextStore.get()?.workspaceState?.isTrusted;
  }, "getSnapshot");
  const isIdeTrusted = (0, import_react14.useSyncExternalStore)(subscribe, getSnapshot);
  (0, import_react14.useEffect)(() => {
    const currentTrust = isWorkspaceTrusted(settings.merged).isTrusted;
    if (previousTrust.current !== void 0 && previousTrust.current !== currentTrust) {
      setNeedsRestart(true);
    }
    previousTrust.current = currentTrust;
  }, [isIdeTrusted, settings.merged]);
  return { isIdeTrusted, needsRestart, restartReason };
}
__name(useIdeTrustListener, "useIdeTrustListener");

// packages/cli/src/ui/hooks/useProviderUpdates.ts
init_esbuild_shims();
var import_react15 = __toESM(require_react(), 1);
var LATER_COOLDOWN_MS = 24 * 60 * 60 * 1e3;
function getProviderMetadata(settings, metadataKey) {
  const mergedSettings = settings.merged;
  const ns = mergedSettings[PROVIDER_METADATA_NS];
  if (!ns) return {};
  const metadata = ns[metadataKey];
  return metadata && typeof metadata === "object" ? metadata : {};
}
__name(getProviderMetadata, "getProviderMetadata");
var LEGACY_KEY_MAP = {
  codingPlan: "coding-plan",
  tokenPlan: "token-plan"
};
function migrateProviderMetadata(settings) {
  const mergedSettings = settings.merged;
  const persistScope = getPersistScopeForModelSelection(settings);
  let migrated = false;
  const migrateKey = /* @__PURE__ */ __name((oldKey, newKey) => {
    const data = mergedSettings[oldKey];
    if (!data || typeof data !== "object") return;
    const entries = data;
    for (const [field, value] of Object.entries(entries)) {
      if (value !== void 0) {
        settings.setValue(
          persistScope,
          `${PROVIDER_METADATA_NS}.${newKey}.${field}`,
          value
        );
      }
    }
    settings.setValue(persistScope, oldKey, void 0);
    migrated = true;
  }, "migrateKey");
  for (const [oldKey, newKey] of Object.entries(LEGACY_KEY_MAP)) {
    migrateKey(oldKey, newKey);
  }
  for (const provider of ALL_PROVIDERS) {
    const key = resolveMetadataKey(provider);
    if (!key) continue;
    if (mergedSettings[key] && typeof mergedSettings[key] === "object") {
      migrateKey(key, key);
    }
  }
  if (migrated) {
    console.log(
      "[info] Migrated provider metadata to providerMetadata namespace."
    );
  }
}
__name(migrateProviderMetadata, "migrateProviderMetadata");
function computeModelDiff(existingModelIds, newModelIds, currentModel) {
  const existingSet = new Set(existingModelIds);
  const newSet = new Set(newModelIds);
  const added = newModelIds.filter((id) => !existingSet.has(id));
  const removed = existingModelIds.filter((id) => !newSet.has(id));
  const currentModelAffected = removed.includes(currentModel);
  return { added, removed, currentModelAffected };
}
__name(computeModelDiff, "computeModelDiff");
function readInstalledOwnedIds(settings, provider) {
  const protocol = provider.protocol;
  if (!protocol) return [];
  const mergedSettings = settings.merged;
  const modelProviders = mergedSettings["modelProviders"];
  if (!modelProviders) return [];
  const allModels = (modelProviders[protocol] ?? []).filter(
    (model) => tryResolveModelProtocol(protocol, model) === protocol
  );
  const ownsFn = resolveOwnsModel(provider);
  return ownsFn ? allModels.filter(ownsFn).map((m) => m.id) : allModels.map((m) => m.id);
}
__name(readInstalledOwnedIds, "readInstalledOwnedIds");
function getInstalledOwnedModelIds(settings, provider) {
  const builtinIds = new Set(getDefaultModelIds(provider));
  return readInstalledOwnedIds(settings, provider).filter(
    (id) => builtinIds.has(id)
  );
}
__name(getInstalledOwnedModelIds, "getInstalledOwnedModelIds");
function findAllPendingUpdates(settings, currentModel) {
  const results = [];
  for (const provider of ALL_PROVIDERS) {
    const metadataKey = resolveMetadataKey(provider);
    if (!metadataKey) continue;
    const metadata = getProviderMetadata(settings, metadataKey);
    if (!metadata.version) continue;
    const baseUrl = metadata.baseUrl || resolveBaseUrl(provider);
    const currentVersion = computeModelListVersion(
      buildProviderTemplate(provider, baseUrl)
    );
    if (metadata.version === currentVersion) continue;
    if (metadata.ignoredVersion === currentVersion) continue;
    if (metadata.postponedVersion === currentVersion && typeof metadata.postponedAt === "number" && Date.now() - metadata.postponedAt >= 0 && Date.now() - metadata.postponedAt < LATER_COOLDOWN_MS) {
      continue;
    }
    const existingModelIds = getInstalledOwnedModelIds(settings, provider);
    const newModelIds = provider.models.map((s) => s.id);
    const diff = computeModelDiff(existingModelIds, newModelIds, currentModel);
    results.push({ provider, metadataKey, baseUrl, currentVersion, diff });
  }
  return results;
}
__name(findAllPendingUpdates, "findAllPendingUpdates");
function useProviderUpdates(settings, config, addItem) {
  const [updateRequest, setUpdateRequest] = (0, import_react15.useState)();
  const migrated = (0, import_react15.useRef)(false);
  const executeUpdate = (0, import_react15.useCallback)(
    async (pending) => {
      try {
        const providerCfg = pending.provider;
        const resolved = resolveBaseUrl(providerCfg, pending.baseUrl);
        const defaultIds = getDefaultModelIds(providerCfg);
        const ownsModel = resolveOwnsModel(providerCfg);
        const existingModels = getModelsForProviderProtocol(
          settings.merged.modelProviders,
          providerCfg.protocol,
          settings.merged.providerProtocol
        ).filter((model) => !ownsModel || ownsModel(model));
        const prebuiltModels = defaultIds.flatMap(
          (id) => {
            const installed = existingModels.filter((model) => model.id === id);
            return (installed.length ? installed : [void 0]).flatMap(
              (existing) => buildInstallPlan(providerCfg, {
                baseUrl: resolved,
                apiKey: "",
                modelIds: [id],
                wireApi: existing?.wireApi
              }).modelProviders[0].models.map((model) => ({
                ...existing,
                ...model,
                ...existing?.wireApi ? { wireApi: existing.wireApi } : {},
                envKey: existing?.envKey ?? model.envKey
              }))
            );
          }
        );
        prebuiltModels.push(
          ...existingModels.filter((model) => !defaultIds.includes(model.id))
        );
        const installPlan = buildInstallPlan(providerCfg, {
          baseUrl: resolved,
          apiKey: "",
          modelIds: prebuiltModels.map((model) => model.id),
          prebuiltModels
        });
        installPlan.providerState[`${PROVIDER_METADATA_NS}.${pending.metadataKey}`]["version"] = pending.currentVersion;
        delete installPlan.env;
        delete installPlan.modelSelection;
        const activeConfig = config.getContentGeneratorConfig();
        const updatesActiveProvider = activeConfig?.authType !== void 0 && prebuiltModels.some(
          (model) => tryResolveModelProtocol(providerCfg.protocol, model) === activeConfig.authType
        ) && providerMatchesCredentials(
          providerCfg,
          activeConfig.baseUrl,
          activeConfig.apiKeyEnvKey
        );
        const settingsAdapter = createLoadedSettingsAdapter(settings);
        await applyProviderInstallPlan(installPlan, {
          settings: {
            ...settingsAdapter,
            setValue: /* @__PURE__ */ __name((key, value) => {
              if (key !== "security.auth.selectedType") {
                settingsAdapter.setValue(key, value);
              }
            }, "setValue")
          },
          reloadModelProviders: /* @__PURE__ */ __name((mp) => config.reloadModelProvidersConfig(mp), "reloadModelProviders"),
          ...updatesActiveProvider && {
            refreshAuth: /* @__PURE__ */ __name(() => config.refreshAuth(activeConfig.authType), "refreshAuth")
          }
        });
        const displayName = t(providerCfg.label);
        addItem(
          {
            type: "info",
            text: t("{{plan}} configuration updated successfully.", {
              plan: displayName
            })
          },
          Date.now()
        );
        addItem(
          {
            type: "info",
            text: t(
              "Tip: Use /model to switch between available {{plan}} models.",
              { plan: displayName }
            )
          },
          Date.now()
        );
        return true;
      } catch (error) {
        addItem(
          {
            type: "error",
            text: t("Failed to update provider configuration: {{message}}", {
              message: getErrorMessage(error)
            })
          },
          Date.now()
        );
        return false;
      }
    },
    [settings, config, addItem]
  );
  const checkForUpdates = (0, import_react15.useCallback)(() => {
    if (!migrated.current) {
      migrated.current = true;
      migrateProviderMetadata(settings);
    }
    const currentModel = config.getModel();
    const pendingList = findAllPendingUpdates(settings, currentModel);
    if (pendingList.length === 0) return;
    const entries = pendingList.map((p) => ({
      providerLabel: t(p.provider.label),
      diff: p.diff
    }));
    setUpdateRequest({
      entries,
      onConfirm: /* @__PURE__ */ __name(async (choice) => {
        setUpdateRequest(void 0);
        if (choice === "update") {
          for (const p of pendingList) {
            await executeUpdate(p);
          }
        } else if (choice === "skip") {
          const persistScope = getPersistScopeForModelSelection(settings);
          for (const p of pendingList) {
            settings.setValue(
              persistScope,
              `${PROVIDER_METADATA_NS}.${p.metadataKey}.ignoredVersion`,
              p.currentVersion
            );
          }
        } else if (choice === "later") {
          const persistScope = getPersistScopeForModelSelection(settings);
          const postponedAt = Date.now();
          try {
            settings.setValues(
              pendingList.flatMap((p) => [
                {
                  scope: persistScope,
                  key: `${PROVIDER_METADATA_NS}.${p.metadataKey}.postponedVersion`,
                  value: p.currentVersion
                },
                {
                  scope: persistScope,
                  key: `${PROVIDER_METADATA_NS}.${p.metadataKey}.postponedAt`,
                  value: postponedAt
                }
              ])
            );
          } catch (error) {
            addItem(
              {
                type: "error",
                text: t("Failed to save update postponement: {{message}}", {
                  message: getErrorMessage(error)
                })
              },
              Date.now()
            );
          }
        }
      }, "onConfirm")
    });
  }, [settings, config, executeUpdate, addItem]);
  (0, import_react15.useEffect)(() => {
    checkForUpdates();
  }, [checkForUpdates]);
  const dismissProviderUpdate = (0, import_react15.useCallback)(() => {
    setUpdateRequest(void 0);
  }, []);
  return {
    providerUpdateRequest: updateRequest,
    dismissProviderUpdate
  };
}
__name(useProviderUpdates, "useProviderUpdates");

// packages/cli/src/ui/contexts/UIStateContext.tsx
var UIStateContext = (0, import_react16.createContext)(null);
var useUIState = /* @__PURE__ */ __name(() => {
  const context = (0, import_react16.useContext)(UIStateContext);
  if (!context) {
    throw new Error("useUIState must be used within a UIStateProvider");
  }
  return context;
}, "useUIState");

// packages/cli/src/ui/state/extensions.ts
init_esbuild_shims();
var initialExtensionUpdatesState = {
  extensionStatuses: /* @__PURE__ */ new Map(),
  batchChecksInProgress: 0
};
function extensionUpdatesReducer(state, action) {
  switch (action.type) {
    case "SET_STATE": {
      const existing = state.extensionStatuses.get(action.payload.name);
      if (existing?.status === action.payload.state) {
        return state;
      }
      const newStatuses = new Map(state.extensionStatuses);
      newStatuses.set(action.payload.name, {
        status: action.payload.state,
        processed: false
      });
      return { ...state, extensionStatuses: newStatuses };
    }
    case "SET_PROCESSED": {
      const existing = state.extensionStatuses.get(action.payload.name);
      if (!existing || existing.processed === action.payload.processed) {
        return state;
      }
      const newStatuses = new Map(state.extensionStatuses);
      newStatuses.set(action.payload.name, {
        ...existing,
        processed: action.payload.processed
      });
      return { ...state, extensionStatuses: newStatuses };
    }
    case "BATCH_CHECK_START":
      return {
        ...state,
        batchChecksInProgress: state.batchChecksInProgress + 1
      };
    case "BATCH_CHECK_END":
      return {
        ...state,
        batchChecksInProgress: state.batchChecksInProgress - 1
      };
    default:
      checkExhaustive(action);
  }
}
__name(extensionUpdatesReducer, "extensionUpdatesReducer");

// packages/cli/src/ui/components/views/ExtensionsList.tsx
var import_jsx_runtime16 = __toESM(require_jsx_runtime(), 1);
var debugLogger2 = createDebugLogger("EXTENSIONS_LIST");
var ExtensionsList = /* @__PURE__ */ __name(() => {
  const { extensionsUpdateState, commandContext } = useUIState();
  const extensions = commandContext.services.config?.getExtensions() || [];
  if (extensions.length === 0) {
    return /* @__PURE__ */ (0, import_jsx_runtime16.jsx)(Text, { children: "No extensions installed." });
  }
  return /* @__PURE__ */ (0, import_jsx_runtime16.jsxs)(Box_default, { flexDirection: "column", marginTop: 1, marginBottom: 1, children: [
    /* @__PURE__ */ (0, import_jsx_runtime16.jsx)(Text, { children: "Installed extensions:" }),
    /* @__PURE__ */ (0, import_jsx_runtime16.jsx)(Box_default, { flexDirection: "column", paddingLeft: 2, children: extensions.map((ext) => {
      const state = extensionsUpdateState.get(ext.name);
      const isActive = ext.isActive;
      const activeString = isActive ? "active" : "disabled";
      const activeColor = isActive ? "green" : "grey";
      let stateColor = "gray";
      const stateText = state || "unknown state";
      switch (state) {
        case "checking for updates" /* CHECKING_FOR_UPDATES */:
        case "updating" /* UPDATING */:
          stateColor = "cyan";
          break;
        case "update available" /* UPDATE_AVAILABLE */:
        case "updated, needs restart" /* UPDATED_NEEDS_RESTART */:
        case "updated with warnings" /* UPDATED_WITH_WARNINGS */:
          stateColor = "yellow";
          break;
        case "error" /* ERROR */:
          stateColor = "red";
          break;
        case "up to date" /* UP_TO_DATE */:
        case "not updatable" /* NOT_UPDATABLE */:
        case "updated" /* UPDATED */:
          stateColor = "green";
          break;
        default:
          debugLogger2.error(`Unhandled ExtensionUpdateState ${state}`);
          break;
      }
      return /* @__PURE__ */ (0, import_jsx_runtime16.jsxs)(Box_default, { flexDirection: "column", marginBottom: 1, children: [
        /* @__PURE__ */ (0, import_jsx_runtime16.jsxs)(Text, { children: [
          /* @__PURE__ */ (0, import_jsx_runtime16.jsx)(Text, { color: "cyan", children: `${getExtensionDisplayName(ext, getCurrentLanguage())} (v${ext.version})` }),
          /* @__PURE__ */ (0, import_jsx_runtime16.jsx)(Text, { color: activeColor, children: ` - ${activeString}` }),
          /* @__PURE__ */ (0, import_jsx_runtime16.jsx)(Text, { color: stateColor, children: ` (${stateText})` })
        ] }),
        ext.resolvedSettings && ext.resolvedSettings.length > 0 && /* @__PURE__ */ (0, import_jsx_runtime16.jsxs)(Box_default, { flexDirection: "column", paddingLeft: 2, children: [
          /* @__PURE__ */ (0, import_jsx_runtime16.jsx)(Text, { children: "settings:" }),
          ext.resolvedSettings.map((setting) => /* @__PURE__ */ (0, import_jsx_runtime16.jsxs)(Text, { children: [
            "- ",
            setting.name,
            ": ",
            setting.value
          ] }, setting.name))
        ] })
      ] }, ext.name);
    }) })
  ] });
}, "ExtensionsList");

// packages/cli/src/ui/components/views/SkillsList.tsx
init_esbuild_shims();
var import_jsx_runtime17 = __toESM(require_jsx_runtime(), 1);
var NAME_COLUMN = 24;
function truncate(text, max) {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}\u2026`;
}
__name(truncate, "truncate");
var SkillsList = /* @__PURE__ */ __name(({ skills }) => /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)(Box_default, { flexDirection: "column", marginBottom: 1, children: [
  /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(Text, { bold: true, color: theme.text.primary, children: t("Available skills:") }),
  /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(Box_default, { height: 1 }),
  skills.length > 0 ? skills.map((skill) => /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)(Box_default, { flexDirection: "row", children: [
    /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)(Text, { color: theme.text.primary, children: [
      "  ",
      "- "
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(Text, { bold: true, color: theme.text.accent, children: skill.description ? truncate(skill.name, NAME_COLUMN).padEnd(NAME_COLUMN) : skill.name }),
    skill.description && /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)(Text, { color: theme.text.secondary, children: [
      " ",
      truncate(skill.description, 80)
    ] }),
    skill.level && /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)(Text, { color: theme.text.secondary, children: [
      "  ",
      "(",
      levelLabel(skill.level),
      ")"
    ] })
  ] }, skill.name)) : /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)(Text, { color: theme.text.primary, children: [
    " ",
    t("No skills available")
  ] })
] }), "SkillsList");

// packages/cli/src/ui/components/views/ToolsList.tsx
init_esbuild_shims();
var import_jsx_runtime18 = __toESM(require_jsx_runtime(), 1);
var ToolsList = /* @__PURE__ */ __name(({
  tools,
  showDescriptions,
  contentWidth
}) => /* @__PURE__ */ (0, import_jsx_runtime18.jsxs)(Box_default, { flexDirection: "column", children: [
  /* @__PURE__ */ (0, import_jsx_runtime18.jsx)(Text, { bold: true, color: theme.text.primary, children: t("Available Qwen Code CLI tools:") }),
  /* @__PURE__ */ (0, import_jsx_runtime18.jsx)(Box_default, { height: 1 }),
  tools.length > 0 ? tools.map((tool) => /* @__PURE__ */ (0, import_jsx_runtime18.jsxs)(Box_default, { flexDirection: "row", children: [
    /* @__PURE__ */ (0, import_jsx_runtime18.jsxs)(Text, { color: theme.text.primary, children: [
      "  ",
      "- "
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime18.jsxs)(Box_default, { flexDirection: "column", children: [
      /* @__PURE__ */ (0, import_jsx_runtime18.jsxs)(Text, { bold: true, color: theme.text.accent, children: [
        tool.displayName,
        showDescriptions ? ` (${tool.name})` : "",
        tool.fixedOnly && /* @__PURE__ */ (0, import_jsx_runtime18.jsxs)(Text, { bold: false, color: theme.text.secondary, children: [
          " ",
          t("[fixed-only: runs via media policies, not the model]")
        ] }),
        tool.deferred ? /* @__PURE__ */ (0, import_jsx_runtime18.jsxs)(Text, { bold: false, color: theme.text.secondary, children: [
          " ",
          t("(on demand)")
        ] }) : null
      ] }),
      showDescriptions && tool.description && /* @__PURE__ */ (0, import_jsx_runtime18.jsx)(
        MarkdownDisplay,
        {
          contentWidth,
          text: tool.description,
          isPending: false
        }
      )
    ] })
  ] }, tool.name)) : /* @__PURE__ */ (0, import_jsx_runtime18.jsxs)(Text, { color: theme.text.primary, children: [
    " ",
    t("No tools available")
  ] }),
  tools.some((tool) => tool.deferred) && /* @__PURE__ */ (0, import_jsx_runtime18.jsxs)(import_jsx_runtime18.Fragment, { children: [
    /* @__PURE__ */ (0, import_jsx_runtime18.jsx)(Box_default, { height: 1 }),
    /* @__PURE__ */ (0, import_jsx_runtime18.jsxs)(Text, { color: theme.text.secondary, children: [
      "  ",
      t(
        'Tools marked "(on demand)" are not offered to the model upfront; tool_search can load them when enabled. Use tools.eager for eager-by-default tools or tools.visible for on-demand tools to send a schema upfront.'
      )
    ] })
  ] })
] }), "ToolsList");

// packages/cli/src/ui/components/views/McpStatus.tsx
init_esbuild_shims();
var import_jsx_runtime19 = __toESM(require_jsx_runtime(), 1);
var McpStatus = /* @__PURE__ */ __name(({
  servers,
  tools,
  prompts,
  blockedServers,
  serverStatus,
  authStatus,
  discoveryInProgress,
  connectingServers,
  showDescriptions,
  showSchema,
  showTips
}) => {
  const serverNames = Object.keys(servers);
  if (serverNames.length === 0 && blockedServers.length === 0) {
    return /* @__PURE__ */ (0, import_jsx_runtime19.jsx)(Box_default, { flexDirection: "column", children: /* @__PURE__ */ (0, import_jsx_runtime19.jsx)(Text, { children: t("No MCP servers configured.") }) });
  }
  return /* @__PURE__ */ (0, import_jsx_runtime19.jsxs)(Box_default, { flexDirection: "column", children: [
    discoveryInProgress && /* @__PURE__ */ (0, import_jsx_runtime19.jsxs)(Box_default, { flexDirection: "column", marginBottom: 1, children: [
      /* @__PURE__ */ (0, import_jsx_runtime19.jsx)(Text, { color: theme.status.warning, children: t("\u25CC MCP servers are starting up ({{count}} initializing)...", {
        count: String(connectingServers.length)
      }) }),
      /* @__PURE__ */ (0, import_jsx_runtime19.jsx)(Text, { color: theme.text.primary, children: t(
        "Note: First startup may take longer. Tool availability will update automatically."
      ) })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime19.jsx)(Text, { bold: true, children: t("Configured MCP servers:") }),
    /* @__PURE__ */ (0, import_jsx_runtime19.jsx)(Box_default, { height: 1 }),
    serverNames.map((serverName) => {
      const server = servers[serverName];
      const serverTools = tools.filter(
        (tool) => tool.serverName === serverName
      );
      const serverPrompts = prompts.filter(
        (prompt) => prompt.serverName === serverName
      );
      const originalStatus = serverStatus(serverName);
      const hasCachedItems = serverTools.length > 0 || serverPrompts.length > 0;
      const status = originalStatus === "disconnected" /* DISCONNECTED */ && hasCachedItems ? "connected" /* CONNECTED */ : originalStatus;
      let statusIndicator = "";
      let statusText = "";
      let statusColor = theme.text.primary;
      switch (status) {
        case "connected" /* CONNECTED */:
          statusIndicator = "\u25CF";
          statusText = t("Ready");
          statusColor = theme.status.success;
          break;
        case "connecting" /* CONNECTING */:
          statusIndicator = "\u25D0";
          statusText = t("Starting... (first startup may take longer)");
          statusColor = theme.status.warning;
          break;
        case "disconnected" /* DISCONNECTED */:
        default:
          statusIndicator = "\u25CF";
          statusText = t("Disconnected");
          statusColor = theme.status.error;
          break;
      }
      let serverDisplayName = serverName;
      if (server.extensionName) {
        serverDisplayName += ` ${t("(from {{extensionName}})", {
          extensionName: server.extensionName
        })}`;
      }
      const toolCount = serverTools.length;
      const promptCount = serverPrompts.length;
      const parts = [];
      if (toolCount > 0) {
        parts.push(
          toolCount === 1 ? t("{{count}} tool", { count: String(toolCount) }) : t("{{count}} tools", { count: String(toolCount) })
        );
      }
      if (promptCount > 0) {
        parts.push(
          promptCount === 1 ? t("{{count}} prompt", { count: String(promptCount) }) : t("{{count}} prompts", { count: String(promptCount) })
        );
      }
      const serverAuthStatus = authStatus[serverName];
      let authStatusNode = null;
      if (serverAuthStatus === "authenticated") {
        authStatusNode = /* @__PURE__ */ (0, import_jsx_runtime19.jsxs)(Text, { children: [
          " (",
          t("OAuth"),
          ")"
        ] });
      } else if (serverAuthStatus === "expired") {
        authStatusNode = /* @__PURE__ */ (0, import_jsx_runtime19.jsxs)(Text, { color: theme.status.error, children: [
          " (",
          t("OAuth expired"),
          ")"
        ] });
      } else if (serverAuthStatus === "unauthenticated") {
        authStatusNode = /* @__PURE__ */ (0, import_jsx_runtime19.jsxs)(Text, { color: theme.status.warning, children: [
          " ",
          "(",
          t("OAuth not authenticated"),
          ")"
        ] });
      }
      return /* @__PURE__ */ (0, import_jsx_runtime19.jsxs)(Box_default, { flexDirection: "column", marginBottom: 1, children: [
        /* @__PURE__ */ (0, import_jsx_runtime19.jsxs)(Box_default, { children: [
          /* @__PURE__ */ (0, import_jsx_runtime19.jsxs)(Text, { color: statusColor, children: [
            statusIndicator,
            " "
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime19.jsx)(Text, { bold: true, children: serverDisplayName }),
          /* @__PURE__ */ (0, import_jsx_runtime19.jsxs)(Text, { children: [
            " - ",
            statusText,
            status === "connected" /* CONNECTED */ && parts.length > 0 && ` (${parts.join(", ")})`
          ] }),
          authStatusNode
        ] }),
        status === "connecting" /* CONNECTING */ && /* @__PURE__ */ (0, import_jsx_runtime19.jsxs)(Text, { children: [
          " (",
          t("tools and prompts will appear when ready"),
          ")"
        ] }),
        status === "disconnected" /* DISCONNECTED */ && toolCount > 0 && /* @__PURE__ */ (0, import_jsx_runtime19.jsxs)(Text, { children: [
          "(",
          t("{{count}} tools cached", { count: String(toolCount) }),
          ")"
        ] }),
        showDescriptions && server?.description && /* @__PURE__ */ (0, import_jsx_runtime19.jsx)(Text, { color: theme.text.secondary, children: server.description.trim() }),
        serverTools.length > 0 && /* @__PURE__ */ (0, import_jsx_runtime19.jsxs)(Box_default, { flexDirection: "column", marginLeft: 2, children: [
          /* @__PURE__ */ (0, import_jsx_runtime19.jsx)(Text, { color: theme.text.primary, children: t("Tools:") }),
          serverTools.map((tool) => {
            const schemaContent = showSchema && tool.schema && (tool.schema.parametersJsonSchema || tool.schema.parameters) ? JSON.stringify(
              tool.schema.parametersJsonSchema ?? tool.schema.parameters,
              null,
              2
            ) : null;
            return /* @__PURE__ */ (0, import_jsx_runtime19.jsxs)(Box_default, { flexDirection: "column", children: [
              /* @__PURE__ */ (0, import_jsx_runtime19.jsxs)(Text, { children: [
                "- ",
                /* @__PURE__ */ (0, import_jsx_runtime19.jsx)(Text, { color: theme.text.primary, children: tool.name })
              ] }),
              showDescriptions && tool.description && /* @__PURE__ */ (0, import_jsx_runtime19.jsx)(Box_default, { marginLeft: 2, children: /* @__PURE__ */ (0, import_jsx_runtime19.jsx)(Text, { color: theme.text.secondary, children: tool.description.trim() }) }),
              schemaContent && /* @__PURE__ */ (0, import_jsx_runtime19.jsxs)(Box_default, { flexDirection: "column", marginLeft: 4, children: [
                /* @__PURE__ */ (0, import_jsx_runtime19.jsx)(Text, { color: theme.text.secondary, children: t("Parameters:") }),
                /* @__PURE__ */ (0, import_jsx_runtime19.jsx)(Text, { color: theme.text.secondary, children: schemaContent })
              ] })
            ] }, tool.name);
          })
        ] }),
        serverPrompts.length > 0 && /* @__PURE__ */ (0, import_jsx_runtime19.jsxs)(Box_default, { flexDirection: "column", marginLeft: 2, children: [
          /* @__PURE__ */ (0, import_jsx_runtime19.jsx)(Text, { color: theme.text.primary, children: t("Prompts:") }),
          serverPrompts.map((prompt) => /* @__PURE__ */ (0, import_jsx_runtime19.jsxs)(Box_default, { flexDirection: "column", children: [
            /* @__PURE__ */ (0, import_jsx_runtime19.jsxs)(Text, { children: [
              "- ",
              /* @__PURE__ */ (0, import_jsx_runtime19.jsx)(Text, { color: theme.text.primary, children: prompt.name })
            ] }),
            showDescriptions && prompt.description && /* @__PURE__ */ (0, import_jsx_runtime19.jsx)(Box_default, { marginLeft: 2, children: /* @__PURE__ */ (0, import_jsx_runtime19.jsx)(Text, { color: theme.text.primary, children: prompt.description.trim() }) })
          ] }, prompt.name))
        ] })
      ] }, serverName);
    }),
    blockedServers.map((server) => /* @__PURE__ */ (0, import_jsx_runtime19.jsxs)(Box_default, { marginBottom: 1, children: [
      /* @__PURE__ */ (0, import_jsx_runtime19.jsx)(Text, { color: theme.status.error, children: "\u25CF " }),
      /* @__PURE__ */ (0, import_jsx_runtime19.jsxs)(Text, { bold: true, children: [
        server.name,
        server.extensionName ? ` ${t("(from {{extensionName}})", {
          extensionName: server.extensionName
        })}` : ""
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime19.jsxs)(Text, { children: [
        " - ",
        t("Blocked")
      ] })
    ] }, server.name)),
    showTips && /* @__PURE__ */ (0, import_jsx_runtime19.jsxs)(Box_default, { flexDirection: "column", marginTop: 1, children: [
      /* @__PURE__ */ (0, import_jsx_runtime19.jsx)(Text, { color: theme.text.accent, children: t("\u2605 Tips:") }),
      /* @__PURE__ */ (0, import_jsx_runtime19.jsxs)(Text, { children: [
        "  ",
        "- ",
        t("Use"),
        " ",
        /* @__PURE__ */ (0, import_jsx_runtime19.jsx)(Text, { color: theme.text.accent, children: "/mcp desc" }),
        " ",
        t("to show server and tool descriptions")
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime19.jsxs)(Text, { children: [
        "  ",
        "- ",
        t("Use"),
        " ",
        /* @__PURE__ */ (0, import_jsx_runtime19.jsx)(Text, { color: theme.text.accent, children: "/mcp schema" }),
        " ",
        t("to show tool parameter schemas")
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime19.jsxs)(Text, { children: [
        "  ",
        "- ",
        t("Use"),
        " ",
        /* @__PURE__ */ (0, import_jsx_runtime19.jsx)(Text, { color: theme.text.accent, children: "/mcp nodesc" }),
        " ",
        t("to hide descriptions")
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime19.jsxs)(Text, { children: [
        "  ",
        "- ",
        t("Use"),
        " ",
        /* @__PURE__ */ (0, import_jsx_runtime19.jsx)(Text, { color: theme.text.accent, children: "/mcp" }),
        " ",
        t("to authenticate with OAuth-enabled servers")
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime19.jsxs)(Text, { children: [
        "  ",
        "- ",
        t("Press"),
        " ",
        /* @__PURE__ */ (0, import_jsx_runtime19.jsx)(Text, { color: theme.text.accent, children: "Ctrl+T" }),
        " ",
        t("to toggle tool descriptions on/off")
      ] })
    ] })
  ] });
}, "McpStatus");

// packages/cli/src/ui/components/views/ContextUsage.tsx
init_esbuild_shims();
var import_jsx_runtime20 = __toESM(require_jsx_runtime(), 1);
var FILLED = "\u2588";
var BUFFER = "\u2592";
var EMPTY = "\u2591";
var CONTENT_WIDTH = 56;
function truncateName(name, maxLen) {
  if (name.length <= maxLen) return name;
  return name.slice(0, maxLen - 1) + "\u2026";
}
__name(truncateName, "truncateName");
function formatTokens(tokens) {
  if (tokens >= 1e3) {
    return `${(tokens / 1e3).toFixed(1)}k`;
  }
  return `${tokens}`;
}
__name(formatTokens, "formatTokens");
var ProgressBar = /* @__PURE__ */ __name(({ usedPercentage, bufferPercentage, width }) => {
  const usedCount = Math.round(Math.min(usedPercentage, 100) / 100 * width);
  const bufferCount = Math.round(
    Math.min(bufferPercentage, 100 - usedPercentage) / 100 * width
  );
  const freeCount = Math.max(0, width - usedCount - bufferCount);
  const usedStr = FILLED.repeat(Math.max(0, usedCount));
  const freeStr = EMPTY.repeat(Math.max(0, freeCount));
  const bufferStr = BUFFER.repeat(Math.max(0, bufferCount));
  let usedColor = theme.text.accent;
  if (usedPercentage > 80) {
    usedColor = theme.status.error;
  } else if (usedPercentage > 60) {
    usedColor = theme.status.warning;
  }
  return /* @__PURE__ */ (0, import_jsx_runtime20.jsxs)(Text, { children: [
    /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(Text, { color: usedColor, children: usedStr }),
    /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(Text, { color: theme.text.secondary, children: freeStr }),
    /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(Text, { color: theme.status.warning, children: bufferStr })
  ] });
}, "ProgressBar");
function formatPercentage(tokens, contextWindowSize) {
  if (contextWindowSize <= 0) return "0.0";
  const percentage = tokens / contextWindowSize * 100;
  if (percentage > 100) {
    return ">100";
  }
  return percentage.toFixed(1);
}
__name(formatPercentage, "formatPercentage");
var CategoryRow = /* @__PURE__ */ __name(({
  symbol,
  label,
  tokens,
  contextWindowSize,
  symbolColor,
  isOverLimit
}) => {
  const percentageStr = formatPercentage(tokens, contextWindowSize);
  const tokenStr = `${formatTokens(tokens)} ${t("tokens")} (${percentageStr}%)`;
  return /* @__PURE__ */ (0, import_jsx_runtime20.jsxs)(Box_default, { width: CONTENT_WIDTH, children: [
    /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(Box_default, { width: 2, children: /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(Text, { color: symbolColor || theme.text.secondary, children: symbol }) }),
    /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(Box_default, { width: 24, children: /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(Text, { color: theme.text.primary, children: label }) }),
    /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(Box_default, { flexGrow: 1, justifyContent: "flex-end", children: /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(Text, { color: isOverLimit ? theme.status.error : theme.text.secondary, children: tokenStr }) })
  ] });
}, "CategoryRow");
var ThresholdRow = /* @__PURE__ */ __name(({ label, tokens, isCurrent, hint }) => {
  const tokenStr = `${formatTokens(tokens)} ${t("tokens")}`;
  return /* @__PURE__ */ (0, import_jsx_runtime20.jsxs)(Box_default, { width: CONTENT_WIDTH, children: [
    /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(Box_default, { width: 2, children: /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(Text, { color: isCurrent ? theme.status.warning : theme.text.secondary, children: isCurrent ? "\u25B6" : " " }) }),
    /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(Box_default, { width: 22, children: /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(Text, { color: theme.text.primary, children: label }) }),
    /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(Box_default, { flexGrow: 1, justifyContent: "flex-end", children: /* @__PURE__ */ (0, import_jsx_runtime20.jsxs)(Text, { color: theme.text.secondary, children: [
      tokenStr,
      hint ? `  ${hint}` : ""
    ] }) })
  ] });
}, "ThresholdRow");
function tierColor(tier) {
  switch (tier) {
    case "safe":
      return theme.status.success;
    case "warn":
      return theme.status.warning;
    case "auto":
      return theme.status.warning;
    case "hard":
      return theme.status.error;
    default:
      return theme.text.secondary;
  }
}
__name(tierColor, "tierColor");
var CompactionThresholds = /* @__PURE__ */ __name(({ thresholds, currentTier }) => /* @__PURE__ */ (0, import_jsx_runtime20.jsxs)(Box_default, { flexDirection: "column", marginTop: 1, children: [
  /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(Text, { bold: true, color: theme.text.primary, children: t("Compaction thresholds") }),
  /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(
    ThresholdRow,
    {
      label: t("Effective window"),
      tokens: thresholds.effectiveWindow
    }
  ),
  /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(
    ThresholdRow,
    {
      label: t("Warn threshold"),
      tokens: thresholds.warn,
      isCurrent: currentTier === "warn"
    }
  ),
  /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(
    ThresholdRow,
    {
      label: t("Auto threshold"),
      tokens: thresholds.auto,
      isCurrent: currentTier === "auto"
    }
  ),
  /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(
    ThresholdRow,
    {
      label: t("Hard threshold"),
      tokens: thresholds.hard,
      isCurrent: currentTier === "hard"
    }
  ),
  /* @__PURE__ */ (0, import_jsx_runtime20.jsxs)(Box_default, { width: CONTENT_WIDTH, children: [
    /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(Box_default, { width: 2, children: /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(Text, { children: " " }) }),
    /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(Box_default, { width: 22, children: /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(Text, { color: theme.text.primary, children: t("Current tier") }) }),
    /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(Box_default, { flexGrow: 1, justifyContent: "flex-end", children: /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(Text, { bold: true, color: tierColor(currentTier), children: currentTier }) })
  ] })
] }), "CompactionThresholds");
var DETAIL_NAME_MAX_LEN = 30;
var DetailRow = /* @__PURE__ */ __name(({ name, tokens }) => {
  const tokenStr = tokens > 0 ? `${formatTokens(tokens)} ${t("tokens")}` : `0 ${t("tokens")}`;
  return /* @__PURE__ */ (0, import_jsx_runtime20.jsxs)(Box_default, { width: CONTENT_WIDTH, paddingLeft: 2, children: [
    /* @__PURE__ */ (0, import_jsx_runtime20.jsxs)(Text, { color: theme.text.secondary, children: [
      "\u2514",
      " "
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(Box_default, { width: 32, children: /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(Text, { color: theme.text.link, children: truncateName(name, DETAIL_NAME_MAX_LEN) }) }),
    /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(Box_default, { flexGrow: 1, justifyContent: "flex-end", children: /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(Text, { color: theme.text.secondary, children: tokenStr }) })
  ] });
}, "DetailRow");
var ContextUsage = /* @__PURE__ */ __name(({
  modelName,
  totalTokens,
  contextWindowSize,
  breakdown,
  builtinTools,
  mcpTools,
  memoryFiles,
  skills,
  isEstimated,
  showDetails = false
}) => {
  const hasTokenCount = totalTokens > 0;
  const percentage = contextWindowSize > 0 ? totalTokens / contextWindowSize * 100 : 0;
  const isOverLimit = percentage > 100;
  const sortedBuiltinTools = [...builtinTools].sort(
    (a, b) => b.tokens - a.tokens
  );
  const sortedMcpTools = [...mcpTools].sort((a, b) => b.tokens - a.tokens);
  const sortedMemoryFiles = [...memoryFiles].sort(
    (a, b) => b.tokens - a.tokens
  );
  const sortedSkills = [...skills].sort((a, b) => {
    if (a.loaded !== b.loaded) return a.loaded ? -1 : 1;
    const aTotal = a.tokens + (a.bodyTokens ?? 0);
    const bTotal = b.tokens + (b.bodyTokens ?? 0);
    return bTotal - aTotal;
  });
  return /* @__PURE__ */ (0, import_jsx_runtime20.jsxs)(
    Box_default,
    {
      borderStyle: "round",
      borderColor: theme.border.default,
      flexDirection: "column",
      paddingY: 1,
      paddingX: 2,
      children: [
        /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(Text, { bold: true, color: theme.text.accent, children: t("Context Usage") }),
        /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(Box_default, { height: 1 }),
        !hasTokenCount ? /* @__PURE__ */ (0, import_jsx_runtime20.jsxs)(import_jsx_runtime20.Fragment, { children: [
          /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(Box_default, { marginBottom: 1, children: /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(Text, { color: theme.status.warning, italic: true, children: t("No API response yet. Send a message to see actual usage.") }) }),
          /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(Text, { bold: true, color: theme.text.primary, children: t("Estimated pre-conversation overhead") }),
          /* @__PURE__ */ (0, import_jsx_runtime20.jsxs)(Text, { color: theme.text.secondary, children: [
            t("Model"),
            ": ",
            modelName,
            "  ",
            t("Context window"),
            ": ",
            formatTokens(contextWindowSize),
            " ",
            t("tokens")
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(Box_default, { height: 1 })
        ] }) : /* @__PURE__ */ (0, import_jsx_runtime20.jsxs)(import_jsx_runtime20.Fragment, { children: [
          /* @__PURE__ */ (0, import_jsx_runtime20.jsxs)(Box_default, { width: CONTENT_WIDTH, marginBottom: 1, children: [
            /* @__PURE__ */ (0, import_jsx_runtime20.jsxs)(Text, { color: theme.text.secondary, children: [
              t("Model"),
              ": ",
              modelName
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(Box_default, { flexGrow: 1, justifyContent: "flex-end", children: /* @__PURE__ */ (0, import_jsx_runtime20.jsxs)(Text, { color: theme.text.secondary, children: [
              t("Context window"),
              ": ",
              formatTokens(contextWindowSize),
              " ",
              t("tokens")
            ] }) })
          ] }),
          isEstimated && /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(Box_default, { marginBottom: 1, children: /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(Text, { color: theme.status.warning, italic: true, children: t(
            "Token usage is estimated until provider usage is received."
          ) }) }),
          /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(Box_default, { width: CONTENT_WIDTH, children: /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(
            ProgressBar,
            {
              usedPercentage: Math.min(percentage, 100),
              bufferPercentage: contextWindowSize > 0 ? breakdown.autocompactBuffer / contextWindowSize * 100 : 0,
              width: CONTENT_WIDTH
            }
          ) }),
          isOverLimit && /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(Box_default, { marginBottom: 1, children: /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(Text, { color: theme.status.error, children: t("Context exceeds limit! Use /compress or /clear to reduce.") }) }),
          /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(Box_default, { height: 1 }),
          /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(
            CategoryRow,
            {
              symbol: FILLED,
              label: t("Used"),
              tokens: totalTokens,
              contextWindowSize,
              symbolColor: isOverLimit ? theme.status.error : theme.text.accent,
              isOverLimit
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(
            CategoryRow,
            {
              symbol: EMPTY,
              label: t("Free"),
              tokens: breakdown.freeSpace,
              contextWindowSize,
              symbolColor: theme.text.secondary
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(
            CategoryRow,
            {
              symbol: BUFFER,
              label: t("Autocompact buffer"),
              tokens: breakdown.autocompactBuffer,
              contextWindowSize,
              symbolColor: theme.status.warning
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(Box_default, { height: 1 }),
          /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(Text, { bold: true, color: theme.text.primary, children: t("Usage by category") })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(
          CategoryRow,
          {
            symbol: FILLED,
            label: t("System prompt"),
            tokens: breakdown.systemPrompt,
            contextWindowSize,
            symbolColor: theme.text.accent
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(
          CategoryRow,
          {
            symbol: FILLED,
            label: t("Built-in tools"),
            tokens: breakdown.builtinTools,
            contextWindowSize,
            symbolColor: theme.text.accent
          }
        ),
        breakdown.mcpTools > 0 && /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(
          CategoryRow,
          {
            symbol: FILLED,
            label: t("MCP tools"),
            tokens: breakdown.mcpTools,
            contextWindowSize,
            symbolColor: theme.text.accent
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(
          CategoryRow,
          {
            symbol: FILLED,
            label: t("Memory files"),
            tokens: breakdown.memoryFiles,
            contextWindowSize,
            symbolColor: theme.text.accent
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(
          CategoryRow,
          {
            symbol: FILLED,
            label: t("Skills"),
            tokens: breakdown.skills,
            contextWindowSize,
            symbolColor: theme.text.accent
          }
        ),
        hasTokenCount && /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(
          CategoryRow,
          {
            symbol: FILLED,
            label: t("Messages"),
            tokens: breakdown.messages,
            contextWindowSize,
            symbolColor: theme.text.accent
          }
        ),
        breakdown.thresholds && breakdown.currentTier && /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(
          CompactionThresholds,
          {
            thresholds: breakdown.thresholds,
            currentTier: breakdown.currentTier
          }
        ),
        showDetails ? /* @__PURE__ */ (0, import_jsx_runtime20.jsxs)(import_jsx_runtime20.Fragment, { children: [
          sortedBuiltinTools.length > 0 && /* @__PURE__ */ (0, import_jsx_runtime20.jsxs)(Box_default, { flexDirection: "column", marginTop: 1, children: [
            /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(Text, { bold: true, color: theme.text.primary, children: t("Built-in tools") }),
            sortedBuiltinTools.map((tool) => /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(
              DetailRow,
              {
                name: tool.name,
                tokens: tool.tokens
              },
              tool.name
            ))
          ] }),
          sortedMcpTools.length > 0 && /* @__PURE__ */ (0, import_jsx_runtime20.jsxs)(Box_default, { flexDirection: "column", marginTop: 1, children: [
            /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(Text, { bold: true, color: theme.text.primary, children: t("MCP tools") }),
            sortedMcpTools.map((tool) => /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(
              DetailRow,
              {
                name: tool.name,
                tokens: tool.tokens
              },
              tool.name
            ))
          ] }),
          sortedMemoryFiles.length > 0 && /* @__PURE__ */ (0, import_jsx_runtime20.jsxs)(Box_default, { flexDirection: "column", marginTop: 1, children: [
            /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(Text, { bold: true, color: theme.text.primary, children: t("Memory files") }),
            sortedMemoryFiles.map((file) => /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(
              DetailRow,
              {
                name: file.path,
                tokens: file.tokens
              },
              file.path
            ))
          ] }),
          sortedSkills.length > 0 && /* @__PURE__ */ (0, import_jsx_runtime20.jsxs)(Box_default, { flexDirection: "column", marginTop: 1, children: [
            /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(Text, { bold: true, color: theme.text.primary, children: t("Skills") }),
            sortedSkills.map((skill) => /* @__PURE__ */ (0, import_jsx_runtime20.jsxs)(Box_default, { flexDirection: "column", children: [
              /* @__PURE__ */ (0, import_jsx_runtime20.jsxs)(Box_default, { width: CONTENT_WIDTH, paddingLeft: 2, children: [
                /* @__PURE__ */ (0, import_jsx_runtime20.jsxs)(Text, { color: theme.text.secondary, children: [
                  "\u2514",
                  " "
                ] }),
                /* @__PURE__ */ (0, import_jsx_runtime20.jsxs)(Box_default, { width: 32, children: [
                  /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(Text, { color: theme.text.link, children: truncateName(skill.name, DETAIL_NAME_MAX_LEN) }),
                  skill.loaded && /* @__PURE__ */ (0, import_jsx_runtime20.jsxs)(Text, { color: theme.status.success, children: [
                    " ",
                    t("active")
                  ] })
                ] }),
                /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(Box_default, { flexGrow: 1, justifyContent: "flex-end", children: /* @__PURE__ */ (0, import_jsx_runtime20.jsxs)(Text, { color: theme.text.secondary, children: [
                  formatTokens(skill.tokens),
                  " ",
                  t("tokens")
                ] }) })
              ] }),
              skill.loaded && skill.bodyTokens != null && skill.bodyTokens > 0 && /* @__PURE__ */ (0, import_jsx_runtime20.jsxs)(Box_default, { width: CONTENT_WIDTH, paddingLeft: 4, children: [
                /* @__PURE__ */ (0, import_jsx_runtime20.jsxs)(Text, { color: theme.text.secondary, children: [
                  "  \u2514",
                  " "
                ] }),
                /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(Box_default, { width: 30, children: /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(Text, { color: theme.text.secondary, italic: true, children: t("body loaded") }) }),
                /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(Box_default, { flexGrow: 1, justifyContent: "flex-end", children: /* @__PURE__ */ (0, import_jsx_runtime20.jsxs)(Text, { color: theme.status.success, children: [
                  "+",
                  formatTokens(skill.bodyTokens),
                  " ",
                  t("tokens")
                ] }) })
              ] })
            ] }, skill.name))
          ] })
        ] }) : /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(Box_default, { marginTop: 1, children: /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(Text, { color: theme.text.secondary, italic: true, children: t("Run /context detail for per-item breakdown.") }) })
      ]
    }
  );
}, "ContextUsage");

// packages/cli/src/ui/components/views/DoctorReport.tsx
init_esbuild_shims();
var import_jsx_runtime21 = __toESM(require_jsx_runtime(), 1);
var STATUS_ICONS = {
  pass: "\u2713",
  // checkmark
  warn: "\u26A0",
  // warning triangle
  fail: "\u2717"
  // X mark
};
function getStatusColor2(status) {
  switch (status) {
    case "pass":
      return theme.status.success;
    case "warn":
      return theme.status.warning;
    case "fail":
      return theme.status.error;
    default:
      return theme.text.primary;
  }
}
__name(getStatusColor2, "getStatusColor");
function groupByCategory(checks) {
  const groups = /* @__PURE__ */ new Map();
  for (const check of checks) {
    const group = groups.get(check.category);
    if (group) {
      group.push(check);
    } else {
      groups.set(check.category, [check]);
    }
  }
  return groups;
}
__name(groupByCategory, "groupByCategory");
var DoctorReport = /* @__PURE__ */ __name(({
  checks,
  summary,
  width
}) => {
  const groups = groupByCategory(checks);
  const categoryEntries = Array.from(groups.entries());
  const nameColWidth = Math.max(20, ...checks.map((c) => c.name.length + 2));
  return /* @__PURE__ */ (0, import_jsx_runtime21.jsxs)(
    Box_default,
    {
      borderStyle: "round",
      borderColor: theme.border.default,
      flexDirection: "column",
      paddingY: 1,
      paddingX: 2,
      width,
      children: [
        /* @__PURE__ */ (0, import_jsx_runtime21.jsx)(Text, { bold: true, color: theme.text.accent, children: t("Doctor Report") }),
        /* @__PURE__ */ (0, import_jsx_runtime21.jsx)(Box_default, { height: 1 }),
        categoryEntries.map(([category, items], groupIdx) => /* @__PURE__ */ (0, import_jsx_runtime21.jsxs)(
          Box_default,
          {
            flexDirection: "column",
            marginTop: groupIdx > 0 ? 1 : 0,
            children: [
              /* @__PURE__ */ (0, import_jsx_runtime21.jsx)(Text, { bold: true, color: theme.text.link, children: category }),
              items.map((check) => /* @__PURE__ */ (0, import_jsx_runtime21.jsxs)(Box_default, { flexDirection: "column", children: [
                /* @__PURE__ */ (0, import_jsx_runtime21.jsxs)(Box_default, { flexDirection: "row", children: [
                  /* @__PURE__ */ (0, import_jsx_runtime21.jsxs)(Text, { color: getStatusColor2(check.status), children: [
                    "  ",
                    STATUS_ICONS[check.status],
                    " "
                  ] }),
                  /* @__PURE__ */ (0, import_jsx_runtime21.jsx)(Box_default, { width: nameColWidth, children: /* @__PURE__ */ (0, import_jsx_runtime21.jsx)(Text, { color: theme.text.primary, children: check.name }) }),
                  /* @__PURE__ */ (0, import_jsx_runtime21.jsx)(Text, { dimColor: true, children: check.message })
                ] }),
                check.detail && /* @__PURE__ */ (0, import_jsx_runtime21.jsx)(Box_default, { marginLeft: 6, children: /* @__PURE__ */ (0, import_jsx_runtime21.jsxs)(Text, { dimColor: true, children: [
                  "-> ",
                  check.detail
                ] }) })
              ] }, `${category}-${check.name}`))
            ]
          },
          category
        )),
        /* @__PURE__ */ (0, import_jsx_runtime21.jsxs)(Box_default, { marginTop: 1, children: [
          /* @__PURE__ */ (0, import_jsx_runtime21.jsx)(Text, { dimColor: true, children: "-- " }),
          /* @__PURE__ */ (0, import_jsx_runtime21.jsxs)(Text, { color: theme.status.success, children: [
            summary.pass,
            " ",
            t("passed")
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime21.jsx)(Text, { dimColor: true, children: ", " }),
          /* @__PURE__ */ (0, import_jsx_runtime21.jsxs)(Text, { color: theme.status.warning, children: [
            summary.warn,
            " ",
            t("warnings")
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime21.jsx)(Text, { dimColor: true, children: ", " }),
          /* @__PURE__ */ (0, import_jsx_runtime21.jsxs)(Text, { color: theme.status.error, children: [
            summary.fail,
            " ",
            t("failures")
          ] })
        ] })
      ]
    }
  );
}, "DoctorReport");

// packages/cli/src/ui/components/arena/ArenaCards.tsx
init_esbuild_shims();
var import_jsx_runtime22 = __toESM(require_jsx_runtime(), 1);
var ArenaAgentCard = /* @__PURE__ */ __name(({
  agent,
  width
}) => {
  const { icon, text, color } = getArenaStatusLabel(agent.status);
  const duration = formatDuration(agent.durationMs);
  const tokens = agent.totalTokens.toLocaleString();
  const inTokens = agent.inputTokens.toLocaleString();
  const outTokens = agent.outputTokens.toLocaleString();
  return /* @__PURE__ */ (0, import_jsx_runtime22.jsxs)(Box_default, { flexDirection: "column", width, children: [
    /* @__PURE__ */ (0, import_jsx_runtime22.jsx)(Box_default, { children: /* @__PURE__ */ (0, import_jsx_runtime22.jsxs)(Text, { color, children: [
      icon,
      " ",
      agent.label,
      " \xB7 ",
      text,
      " \xB7 ",
      duration
    ] }) }),
    /* @__PURE__ */ (0, import_jsx_runtime22.jsx)(Box_default, { marginLeft: 2, children: /* @__PURE__ */ (0, import_jsx_runtime22.jsxs)(Text, { color: theme.text.secondary, children: [
      "Tokens: ",
      tokens,
      " (in ",
      inTokens,
      ", out ",
      outTokens,
      ")"
    ] }) }),
    /* @__PURE__ */ (0, import_jsx_runtime22.jsx)(Box_default, { marginLeft: 2, children: /* @__PURE__ */ (0, import_jsx_runtime22.jsxs)(Text, { color: theme.text.secondary, children: [
      "Tool Calls: ",
      agent.toolCalls,
      agent.failedToolCalls > 0 && /* @__PURE__ */ (0, import_jsx_runtime22.jsxs)(import_jsx_runtime22.Fragment, { children: [
        " ",
        "(",
        /* @__PURE__ */ (0, import_jsx_runtime22.jsxs)(Text, { color: theme.status.success, children: [
          "\u2713 ",
          agent.successfulToolCalls
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime22.jsx)(Text, { color: theme.text.secondary, children: " " }),
        /* @__PURE__ */ (0, import_jsx_runtime22.jsxs)(Text, { color: theme.status.error, children: [
          "\u2715 ",
          agent.failedToolCalls
        ] }),
        ")"
      ] })
    ] }) }),
    agent.error && /* @__PURE__ */ (0, import_jsx_runtime22.jsx)(Box_default, { marginLeft: 2, children: /* @__PURE__ */ (0, import_jsx_runtime22.jsx)(Text, { color: theme.status.error, children: agent.error }) })
  ] });
}, "ArenaAgentCard");
function getDiffStats(diff, diffSummary) {
  if (diffSummary) {
    return {
      text: `+${diffSummary.additions}/-${diffSummary.deletions}`,
      additions: diffSummary.additions,
      deletions: diffSummary.deletions
    };
  }
  if (!diff) return { text: "", additions: 0, deletions: 0 };
  const lines = diff.split("\n");
  let additions = 0;
  let deletions = 0;
  for (const line of lines) {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      additions++;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      deletions++;
    }
  }
  return { text: `+${additions}/-${deletions}`, additions, deletions };
}
__name(getDiffStats, "getDiffStats");
var MAX_FILE_LIST_ITEMS = 4;
function formatFileList(files) {
  if (!files || files.length === 0) {
    return "none";
  }
  const visible = files.slice(0, MAX_FILE_LIST_ITEMS);
  const suffix = files.length > MAX_FILE_LIST_ITEMS ? `, +${files.length - MAX_FILE_LIST_ITEMS} more` : "";
  return `${visible.join(", ")}${suffix}`;
}
__name(formatFileList, "formatFileList");
function getAgentFiles(agent) {
  return agent.modifiedFiles ?? agent.diffSummary?.files.map((file) => file.path) ?? [];
}
__name(getAgentFiles, "getAgentFiles");
function getComparisonFileGroups(agents) {
  const counts = /* @__PURE__ */ new Map();
  for (const agent of agents) {
    for (const file of new Set(getAgentFiles(agent))) {
      counts.set(file, (counts.get(file) ?? 0) + 1);
    }
  }
  const common = [...counts.entries()].filter(([, count]) => count > 1).map(([file]) => file).sort();
  const groups = [{ label: "common", files: common }];
  for (const agent of agents) {
    const unique = getAgentFiles(agent).filter((file) => counts.get(file) === 1).sort();
    if (unique.length > 0) {
      groups.push({ label: `${agent.label}-only`, files: unique });
    }
  }
  return groups;
}
__name(getComparisonFileGroups, "getComparisonFileGroups");
function getTreeBranch(index, total) {
  return index === total - 1 ? "\u2514\u2500" : "\u251C\u2500";
}
__name(getTreeBranch, "getTreeBranch");
var ArenaSessionCard = /* @__PURE__ */ __name(({
  sessionStatus,
  agents,
  width
}) => {
  const titleLabel = sessionStatus === "idle" || sessionStatus === "completed" ? "Arena Comparison Summary" : sessionStatus === "cancelled" ? "Arena Cancelled" : "Arena Failed";
  return /* @__PURE__ */ (0, import_jsx_runtime22.jsxs)(
    Box_default,
    {
      borderStyle: "round",
      borderColor: theme.border.default,
      flexDirection: "column",
      paddingX: 2,
      paddingY: 1,
      width,
      children: [
        /* @__PURE__ */ (0, import_jsx_runtime22.jsx)(Box_default, { children: /* @__PURE__ */ (0, import_jsx_runtime22.jsx)(Text, { bold: true, color: theme.text.primary, children: titleLabel }) }),
        /* @__PURE__ */ (0, import_jsx_runtime22.jsx)(Box_default, { height: 1 }),
        (sessionStatus === "idle" || sessionStatus === "completed") && /* @__PURE__ */ (0, import_jsx_runtime22.jsxs)(import_jsx_runtime22.Fragment, { children: [
          /* @__PURE__ */ (0, import_jsx_runtime22.jsxs)(Box_default, { flexDirection: "column", children: [
            /* @__PURE__ */ (0, import_jsx_runtime22.jsx)(Text, { bold: true, color: theme.text.primary, children: "Status Summary:" }),
            agents.map((agent, index) => {
              const { text: statusText, color } = getArenaStatusLabel(
                agent.status
              );
              return /* @__PURE__ */ (0, import_jsx_runtime22.jsxs)(Box_default, { marginLeft: 2, children: [
                /* @__PURE__ */ (0, import_jsx_runtime22.jsxs)(Text, { color: theme.text.secondary, children: [
                  index === agents.length - 1 ? "\u2514\u2500" : "\u251C\u2500",
                  " ",
                  agent.label,
                  ":",
                  " "
                ] }),
                /* @__PURE__ */ (0, import_jsx_runtime22.jsx)(Text, { color, children: statusText })
              ] }, agent.label);
            })
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime22.jsx)(Box_default, { height: 1 }),
          /* @__PURE__ */ (0, import_jsx_runtime22.jsxs)(Box_default, { flexDirection: "column", children: [
            /* @__PURE__ */ (0, import_jsx_runtime22.jsx)(Text, { bold: true, color: theme.text.primary, children: "Files Modified:" }),
            getComparisonFileGroups(agents).map((group, index, groups) => /* @__PURE__ */ (0, import_jsx_runtime22.jsxs)(Box_default, { marginLeft: 2, children: [
              /* @__PURE__ */ (0, import_jsx_runtime22.jsxs)(Text, { color: theme.text.secondary, children: [
                getTreeBranch(index, groups.length),
                " ",
                group.label,
                ":",
                " "
              ] }),
              /* @__PURE__ */ (0, import_jsx_runtime22.jsx)(Text, { color: theme.text.primary, children: formatFileList(group.files) })
            ] }, group.label))
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime22.jsx)(Box_default, { height: 1 }),
          /* @__PURE__ */ (0, import_jsx_runtime22.jsxs)(Box_default, { flexDirection: "column", children: [
            /* @__PURE__ */ (0, import_jsx_runtime22.jsx)(Text, { bold: true, color: theme.text.primary, children: "Approach Summary:" }),
            agents.map((agent, index) => {
              const diffStats = getDiffStats(agent.diff, agent.diffSummary);
              const files = getAgentFiles(agent).length;
              const branch = index === agents.length - 1 ? "\u2514\u2500" : "\u251C\u2500";
              const summary = agent.approachSummary ?? "No approach summary available.";
              return /* @__PURE__ */ (0, import_jsx_runtime22.jsx)(Box_default, { marginLeft: 2, children: /* @__PURE__ */ (0, import_jsx_runtime22.jsxs)(Text, { children: [
                /* @__PURE__ */ (0, import_jsx_runtime22.jsxs)(Text, { color: theme.text.secondary, children: [
                  branch,
                  " ",
                  agent.label,
                  ":",
                  " "
                ] }),
                /* @__PURE__ */ (0, import_jsx_runtime22.jsxs)(Text, { color: theme.text.primary, children: [
                  summary,
                  " "
                ] }),
                /* @__PURE__ */ (0, import_jsx_runtime22.jsx)(Text, { color: theme.text.secondary, children: "(" }),
                /* @__PURE__ */ (0, import_jsx_runtime22.jsx)(Text, { color: theme.text.accent, children: files }),
                /* @__PURE__ */ (0, import_jsx_runtime22.jsx)(Text, { color: theme.text.secondary, children: files === 1 ? " file, " : " files, " }),
                /* @__PURE__ */ (0, import_jsx_runtime22.jsxs)(Text, { color: theme.status.success, children: [
                  "+",
                  diffStats.additions
                ] }),
                /* @__PURE__ */ (0, import_jsx_runtime22.jsx)(Text, { color: theme.text.secondary, children: " " }),
                /* @__PURE__ */ (0, import_jsx_runtime22.jsxs)(Text, { color: theme.status.error, children: [
                  "-",
                  diffStats.deletions
                ] }),
                /* @__PURE__ */ (0, import_jsx_runtime22.jsx)(Text, { color: theme.text.secondary, children: " lines, " }),
                /* @__PURE__ */ (0, import_jsx_runtime22.jsx)(Text, { color: theme.text.accent, children: agent.toolCalls }),
                /* @__PURE__ */ (0, import_jsx_runtime22.jsx)(Text, { color: theme.text.secondary, children: agent.toolCalls === 1 ? " tool call)" : " tool calls)" })
              ] }) }, agent.label);
            })
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime22.jsx)(Box_default, { height: 1 }),
          /* @__PURE__ */ (0, import_jsx_runtime22.jsxs)(Box_default, { flexDirection: "column", children: [
            /* @__PURE__ */ (0, import_jsx_runtime22.jsx)(Text, { bold: true, color: theme.text.primary, children: "Token Efficiency:" }),
            agents.map((agent, index) => /* @__PURE__ */ (0, import_jsx_runtime22.jsxs)(Box_default, { marginLeft: 2, children: [
              /* @__PURE__ */ (0, import_jsx_runtime22.jsxs)(Text, { color: theme.text.secondary, children: [
                index === agents.length - 1 ? "\u2514\u2500" : "\u251C\u2500",
                " ",
                agent.label,
                ":",
                " "
              ] }),
              /* @__PURE__ */ (0, import_jsx_runtime22.jsxs)(Text, { color: theme.text.primary, children: [
                agent.outputTokens.toLocaleString(),
                " tokens \xB7 runtime",
                " ",
                formatDuration(agent.durationMs)
              ] })
            ] }, agent.label))
          ] })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime22.jsx)(Box_default, { height: 1 }),
        sessionStatus === "idle" && /* @__PURE__ */ (0, import_jsx_runtime22.jsx)(Box_default, { flexDirection: "column", children: /* @__PURE__ */ (0, import_jsx_runtime22.jsxs)(Text, { color: theme.text.secondary, children: [
          "Run ",
          /* @__PURE__ */ (0, import_jsx_runtime22.jsx)(Text, { color: theme.text.accent, children: "/arena select" }),
          " to view detailed diff or pick a winner."
        ] }) }),
        sessionStatus === "completed" && /* @__PURE__ */ (0, import_jsx_runtime22.jsx)(Box_default, { children: /* @__PURE__ */ (0, import_jsx_runtime22.jsxs)(Text, { color: theme.text.secondary, children: [
          "Run ",
          /* @__PURE__ */ (0, import_jsx_runtime22.jsx)(Text, { color: theme.text.accent, children: "/arena select" }),
          " to pick a winner."
        ] }) })
      ]
    }
  );
}, "ArenaSessionCard");

// packages/cli/src/ui/components/messages/InsightProgressMessage.tsx
init_esbuild_shims();
var import_jsx_runtime23 = __toESM(require_jsx_runtime(), 1);
var InsightProgressMessage = /* @__PURE__ */ __name(({
  progress
}) => {
  const { stage, progress: percent, isComplete, error } = progress;
  const width = 30;
  const completedWidth = Math.round(percent / 100 * width);
  const remainingWidth = width - completedWidth;
  const bar = "\u2588".repeat(Math.max(0, completedWidth)) + "\u2591".repeat(Math.max(0, remainingWidth));
  if (error) {
    return /* @__PURE__ */ (0, import_jsx_runtime23.jsxs)(Box_default, { flexDirection: "column", children: [
      /* @__PURE__ */ (0, import_jsx_runtime23.jsxs)(Text, { color: theme.status.error, children: [
        "\u2715 ",
        stage
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime23.jsx)(Text, { color: theme.text.secondary, children: error })
    ] });
  }
  if (isComplete) {
    return /* @__PURE__ */ (0, import_jsx_runtime23.jsx)(Box_default, { flexDirection: "row", children: /* @__PURE__ */ (0, import_jsx_runtime23.jsxs)(Text, { color: theme.status.success, children: [
      "\u2713 ",
      stage
    ] }) });
  }
  return /* @__PURE__ */ (0, import_jsx_runtime23.jsxs)(Box_default, { flexDirection: "row", children: [
    /* @__PURE__ */ (0, import_jsx_runtime23.jsx)(Text, { color: theme.text.accent, children: /* @__PURE__ */ (0, import_jsx_runtime23.jsx)(build_default, { type: "dots" }) }),
    /* @__PURE__ */ (0, import_jsx_runtime23.jsx)(Text, { children: " " }),
    /* @__PURE__ */ (0, import_jsx_runtime23.jsxs)(Text, { color: theme.text.secondary, children: [
      bar,
      " "
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime23.jsxs)(Text, { color: theme.text.accent, children: [
      stage,
      progress.detail ? ` (${progress.detail})` : ""
    ] })
  ] });
}, "InsightProgressMessage");

// packages/cli/src/ui/components/messages/BtwMessage.tsx
init_esbuild_shims();
var import_react17 = __toESM(require_react(), 1);
var import_jsx_runtime24 = __toESM(require_jsx_runtime(), 1);
var BTW_SELF_CHROME = 4;
function normalizeCodeFences(text) {
  return text.replace(/([^\n])(```|~~~)/g, "$1\n$2");
}
__name(normalizeCodeFences, "normalizeCodeFences");
var BtwMessageInternal = /* @__PURE__ */ __name(({
  btw,
  containerWidth
}) => {
  const { columns: terminalWidth } = useTerminalSize();
  const baseWidth = containerWidth ?? terminalWidth;
  const contentWidth = Math.max(2, baseWidth - BTW_SELF_CHROME);
  return /* @__PURE__ */ (0, import_jsx_runtime24.jsxs)(
    Box_default,
    {
      flexDirection: "column",
      borderStyle: "round",
      borderColor: Colors.AccentYellow,
      paddingX: 1,
      width: "100%",
      children: [
        /* @__PURE__ */ (0, import_jsx_runtime24.jsxs)(Box_default, { flexDirection: "row", children: [
          /* @__PURE__ */ (0, import_jsx_runtime24.jsx)(Text, { color: Colors.AccentYellow, bold: true, children: "/btw " }),
          /* @__PURE__ */ (0, import_jsx_runtime24.jsx)(Text, { wrap: "wrap", color: Colors.AccentYellow, children: btw.question })
        ] }),
        btw.isPending ? /* @__PURE__ */ (0, import_jsx_runtime24.jsxs)(Box_default, { flexDirection: "column", marginTop: 1, children: [
          /* @__PURE__ */ (0, import_jsx_runtime24.jsxs)(Box_default, { children: [
            /* @__PURE__ */ (0, import_jsx_runtime24.jsx)(Text, { color: Colors.AccentYellow, children: "+ " }),
            /* @__PURE__ */ (0, import_jsx_runtime24.jsx)(Text, { color: Colors.AccentYellow, children: t("Answering...") })
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime24.jsx)(Box_default, { marginTop: 1, children: /* @__PURE__ */ (0, import_jsx_runtime24.jsx)(Text, { dimColor: true, children: t("Press Escape, Ctrl+C, or Ctrl+D to cancel") }) })
        ] }) : /* @__PURE__ */ (0, import_jsx_runtime24.jsxs)(Box_default, { flexDirection: "column", marginTop: 1, children: [
          /* @__PURE__ */ (0, import_jsx_runtime24.jsx)(
            MarkdownDisplay,
            {
              text: normalizeCodeFences(btw.answer),
              isPending: false,
              contentWidth
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime24.jsx)(Box_default, { marginTop: 1, children: /* @__PURE__ */ (0, import_jsx_runtime24.jsx)(Text, { dimColor: true, children: t("Press Space, Enter, or Escape to dismiss") }) })
        ] })
      ]
    }
  );
}, "BtwMessageInternal");
var BtwMessage = import_react17.default.memo(BtwMessageInternal);

// packages/cli/src/ui/components/messages/AdvisorMessage.tsx
init_esbuild_shims();
var import_react18 = __toESM(require_react(), 1);
var import_jsx_runtime25 = __toESM(require_jsx_runtime(), 1);
var ADVISOR_SELF_CHROME = 4;
var AdvisorMessageInternal = /* @__PURE__ */ __name(({
  text,
  model,
  containerWidth
}) => {
  const { columns: terminalWidth } = useTerminalSize();
  const baseWidth = containerWidth ?? terminalWidth;
  const contentWidth = Math.max(2, baseWidth - ADVISOR_SELF_CHROME);
  return /* @__PURE__ */ (0, import_jsx_runtime25.jsxs)(
    Box_default,
    {
      flexDirection: "column",
      borderStyle: "round",
      borderColor: Colors.AccentCyan,
      paddingX: 1,
      width: "100%",
      children: [
        /* @__PURE__ */ (0, import_jsx_runtime25.jsxs)(Box_default, { flexDirection: "row", children: [
          /* @__PURE__ */ (0, import_jsx_runtime25.jsx)(Text, { color: Colors.AccentCyan, bold: true, children: "/advisor" }),
          /* @__PURE__ */ (0, import_jsx_runtime25.jsx)(Text, { color: Colors.AccentCyan, children: ` \xB7 ${model}` })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime25.jsx)(Box_default, { flexDirection: "column", marginTop: 1, children: /* @__PURE__ */ (0, import_jsx_runtime25.jsx)(
          MarkdownDisplay,
          {
            text,
            isPending: false,
            contentWidth
          }
        ) })
      ]
    }
  );
}, "AdvisorMessageInternal");
var AdvisorMessage = import_react18.default.memo(AdvisorMessageInternal);

// packages/cli/src/ui/components/messages/MemorySavedMessage.tsx
init_esbuild_shims();
var import_jsx_runtime26 = __toESM(require_jsx_runtime(), 1);
var MemorySavedMessage = /* @__PURE__ */ __name(({
  item
}) => {
  const verb = item.verb ?? "Saved";
  const n = item.writtenCount;
  const label = n === 1 ? "memory" : "memories";
  return /* @__PURE__ */ (0, import_jsx_runtime26.jsxs)(Box_default, { flexDirection: "row", children: [
    /* @__PURE__ */ (0, import_jsx_runtime26.jsx)(Box_default, { width: 2, flexShrink: 0, children: /* @__PURE__ */ (0, import_jsx_runtime26.jsx)(Text, { dimColor: true, children: ICON.CIRCLE_FILLED }) }),
    /* @__PURE__ */ (0, import_jsx_runtime26.jsxs)(Text, { dimColor: true, children: [
      verb,
      " ",
      n,
      " ",
      label
    ] })
  ] });
}, "MemorySavedMessage");

// packages/cli/src/ui/components/messages/DiffStatsDisplay.tsx
init_esbuild_shims();
var import_jsx_runtime27 = __toESM(require_jsx_runtime(), 1);
var DiffStatsDisplay = /* @__PURE__ */ __name(({
  model
}) => {
  const { filesCount, linesAdded, linesRemoved, rows, hiddenCount } = model;
  const { addWidth, remWidth, statColumnWidth } = computeDiffColumnWidths(rows);
  const headerLabel = filesCount === 1 ? t("{{count}} file changed", { count: String(filesCount) }) : t("{{count}} files changed", { count: String(filesCount) });
  return /* @__PURE__ */ (0, import_jsx_runtime27.jsxs)(Box_default, { flexDirection: "column", children: [
    /* @__PURE__ */ (0, import_jsx_runtime27.jsxs)(Text, { children: [
      /* @__PURE__ */ (0, import_jsx_runtime27.jsx)(Text, { color: theme.text.primary, children: headerLabel }),
      /* @__PURE__ */ (0, import_jsx_runtime27.jsx)(Text, { color: theme.text.secondary, children: ", " }),
      /* @__PURE__ */ (0, import_jsx_runtime27.jsxs)(Text, { color: theme.status.success, children: [
        "+",
        linesAdded
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime27.jsx)(Text, { color: theme.text.secondary, children: " / " }),
      /* @__PURE__ */ (0, import_jsx_runtime27.jsxs)(Text, { color: theme.status.error, children: [
        "-",
        linesRemoved
      ] })
    ] }),
    rows.map((row) => /* @__PURE__ */ (0, import_jsx_runtime27.jsx)(
      DiffRow,
      {
        row,
        addWidth,
        remWidth,
        statColumnWidth
      },
      row.filename
    )),
    hiddenCount > 0 && rows.length > 0 && /* @__PURE__ */ (0, import_jsx_runtime27.jsx)(Box_default, { children: /* @__PURE__ */ (0, import_jsx_runtime27.jsxs)(Text, { color: theme.text.secondary, children: [
      "  ",
      t("\u2026and {{hidden}} more (showing first {{shown}})", {
        hidden: String(hiddenCount),
        shown: String(rows.length)
      })
    ] }) })
  ] });
}, "DiffStatsDisplay");
var DiffRow = /* @__PURE__ */ __name(({
  row,
  addWidth,
  remWidth,
  statColumnWidth
}) => {
  const safeName = sanitizeFilenameForDisplay(row.filename);
  const safeOldPath = row.oldPath ? sanitizeFilenameForDisplay(row.oldPath) : null;
  if (row.isBinary) {
    const marker = padRight("~", statColumnWidth);
    const suffix2 = row.isUntracked ? t("(binary, new)") : row.isDeleted ? t("(binary, deleted)") : t("(binary)");
    return /* @__PURE__ */ (0, import_jsx_runtime27.jsx)(Box_default, { children: /* @__PURE__ */ (0, import_jsx_runtime27.jsxs)(Text, { children: [
      /* @__PURE__ */ (0, import_jsx_runtime27.jsx)(Text, { color: theme.text.primary, children: "  " }),
      /* @__PURE__ */ (0, import_jsx_runtime27.jsx)(Text, { color: theme.text.secondary, children: marker }),
      /* @__PURE__ */ (0, import_jsx_runtime27.jsx)(Text, { color: theme.text.primary, children: "  " }),
      safeOldPath ? /* @__PURE__ */ (0, import_jsx_runtime27.jsxs)(Text, { color: theme.text.secondary, children: [
        safeOldPath,
        " \u2192 "
      ] }) : null,
      /* @__PURE__ */ (0, import_jsx_runtime27.jsx)(Text, { color: theme.text.primary, children: safeName }),
      /* @__PURE__ */ (0, import_jsx_runtime27.jsxs)(Text, { color: theme.text.secondary, children: [
        " ",
        suffix2
      ] })
    ] }) });
  }
  const added = String(row.added ?? 0).padStart(addWidth);
  const removed = String(row.removed ?? 0).padStart(remWidth);
  let suffix = null;
  if (row.isUntracked) {
    suffix = row.truncated ? t("(new, partial)") : t("(new)");
  } else if (row.isDeleted) {
    suffix = t("(deleted)");
  }
  return /* @__PURE__ */ (0, import_jsx_runtime27.jsx)(Box_default, { children: /* @__PURE__ */ (0, import_jsx_runtime27.jsxs)(Text, { children: [
    /* @__PURE__ */ (0, import_jsx_runtime27.jsx)(Text, { color: theme.text.primary, children: "  " }),
    /* @__PURE__ */ (0, import_jsx_runtime27.jsxs)(Text, { color: theme.status.success, children: [
      "+",
      added
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime27.jsx)(Text, { color: theme.text.primary, children: " " }),
    /* @__PURE__ */ (0, import_jsx_runtime27.jsxs)(Text, { color: theme.status.error, children: [
      "-",
      removed
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime27.jsx)(Text, { color: theme.text.primary, children: "  " }),
    safeOldPath ? /* @__PURE__ */ (0, import_jsx_runtime27.jsxs)(Text, { color: theme.text.secondary, children: [
      safeOldPath,
      " \u2192 "
    ] }) : null,
    /* @__PURE__ */ (0, import_jsx_runtime27.jsx)(Text, { color: theme.text.primary, children: safeName }),
    suffix && /* @__PURE__ */ (0, import_jsx_runtime27.jsxs)(Text, { color: theme.text.secondary, children: [
      " ",
      suffix
    ] })
  ] }) });
}, "DiffRow");
function padRight(s, width) {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}
__name(padRight, "padRight");

// packages/cli/src/ui/components/messages/GoalStatusMessage.tsx
init_esbuild_shims();
var import_react19 = __toESM(require_react(), 1);
var import_jsx_runtime28 = __toESM(require_jsx_runtime(), 1);
var pluralTurns = /* @__PURE__ */ __name((n) => n === 1 ? "turn" : "turns", "pluralTurns");
function assertNeverGoalStatusKind(kind) {
  throw new Error(`Unexpected goal status kind: ${kind}`);
}
__name(assertNeverGoalStatusKind, "assertNeverGoalStatusKind");
var GoalStateCard = /* @__PURE__ */ __name(({
  snapshot,
  cause
}) => {
  const goal = snapshot.goal;
  if (!goal) {
    if (cause !== "clear") return null;
    return /* @__PURE__ */ (0, import_jsx_runtime28.jsxs)(Box_default, { flexDirection: "row", children: [
      /* @__PURE__ */ (0, import_jsx_runtime28.jsx)(Box_default, { width: 2, flexShrink: 0, children: /* @__PURE__ */ (0, import_jsx_runtime28.jsx)(Text, { color: theme.text.secondary, children: ICON.CIRCLE_EMPTY }) }),
      /* @__PURE__ */ (0, import_jsx_runtime28.jsx)(Text, { color: theme.text.secondary, children: "Goal cleared" })
    ] });
  }
  const lifecycle = (() => {
    switch (goal.status) {
      case "active":
        if (snapshot.activity === "verifying") {
          return {
            prefix: ICON.CIRCLE_EMPTY,
            color: theme.text.secondary,
            title: "Goal checking"
          };
        }
        return {
          prefix: ICON.BULLSEYE,
          color: theme.text.accent,
          title: snapshot.activity === "running" ? "Goal running" : "Goal active"
        };
      case "paused":
        return {
          prefix: "!",
          color: theme.status.warning,
          title: "Goal paused"
        };
      case "blocked":
        return {
          prefix: ICON.CROSS,
          color: theme.status.error,
          title: "Goal blocked"
        };
      case "usage_limited":
        return {
          prefix: "!",
          color: theme.status.warning,
          title: "Goal usage limited"
        };
      case "complete":
        return {
          prefix: ICON.CHECK,
          color: theme.status.success,
          title: "Goal complete"
        };
      default: {
        const exhaustive = goal.status;
        void exhaustive;
        throw new Error("Unexpected Goal status");
      }
    }
  })();
  const stats = [];
  if (goal.turnCount > 0) {
    stats.push(
      goal.turnBudget === void 0 ? `${goal.turnCount} ${pluralTurns(goal.turnCount)}` : `${goal.turnCount}/${goal.turnBudget} ${pluralTurns(goal.turnBudget)}`
    );
  }
  if (goal.activeTimeMs > 0) {
    const used = formatDuration(goal.activeTimeMs, { hideTrailingZeros: true });
    stats.push(
      goal.activeTimeBudgetMs === void 0 ? used : `${used}/${formatDuration(goal.activeTimeBudgetMs, { hideTrailingZeros: true })}`
    );
  }
  if (goal.tokensUsed > 0) {
    const used = formatTokenCount2(goal.tokensUsed);
    stats.push(
      goal.tokenBudget === void 0 ? `${used} tokens` : `${used}/${formatTokenCount2(goal.tokenBudget)} tokens`
    );
  }
  const subtitle = stats.length > 0 ? stats.join(" \xB7 ") : null;
  const reason = goal.status !== "active" || snapshot.activity === "verifying" ? sanitizeTerminalText(goal.lastReason ?? "").trim() : void 0;
  return /* @__PURE__ */ (0, import_jsx_runtime28.jsxs)(Box_default, { flexDirection: "row", children: [
    /* @__PURE__ */ (0, import_jsx_runtime28.jsx)(Box_default, { width: 2, flexShrink: 0, children: /* @__PURE__ */ (0, import_jsx_runtime28.jsx)(Text, { color: lifecycle.color, children: lifecycle.prefix }) }),
    /* @__PURE__ */ (0, import_jsx_runtime28.jsxs)(Box_default, { flexGrow: 1, flexDirection: "column", children: [
      /* @__PURE__ */ (0, import_jsx_runtime28.jsxs)(Text, { color: lifecycle.color, children: [
        lifecycle.title,
        subtitle ? /* @__PURE__ */ (0, import_jsx_runtime28.jsxs)(Text, { color: theme.text.secondary, children: [
          " \xB7 ",
          subtitle
        ] }) : null
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime28.jsxs)(Box_default, { flexDirection: "row", children: [
        /* @__PURE__ */ (0, import_jsx_runtime28.jsx)(Box_default, { flexShrink: 0, marginRight: 1, children: /* @__PURE__ */ (0, import_jsx_runtime28.jsx)(Text, { color: theme.text.secondary, children: "Goal:" }) }),
        /* @__PURE__ */ (0, import_jsx_runtime28.jsx)(Box_default, { flexGrow: 1, children: /* @__PURE__ */ (0, import_jsx_runtime28.jsx)(Text, { wrap: "wrap", children: goal.objective }) })
      ] }),
      reason ? /* @__PURE__ */ (0, import_jsx_runtime28.jsxs)(Text, { color: theme.text.secondary, wrap: "wrap", children: [
        "Reason: ",
        reason
      ] }) : null
    ] })
  ] });
}, "GoalStateCard");
var GoalStatusMessageInternal = /* @__PURE__ */ __name((props) => {
  if (props.snapshot) return /* @__PURE__ */ (0, import_jsx_runtime28.jsx)(GoalStateCard, { ...props });
  const { kind, condition, iterations, durationMs, lastReason } = props;
  if (kind === "checking") {
    const reason = lastReason?.trim();
    return /* @__PURE__ */ (0, import_jsx_runtime28.jsxs)(Box_default, { flexDirection: "row", children: [
      /* @__PURE__ */ (0, import_jsx_runtime28.jsx)(Box_default, { width: 2, flexShrink: 0, children: /* @__PURE__ */ (0, import_jsx_runtime28.jsx)(Text, { color: theme.text.secondary, children: ICON.CIRCLE_EMPTY }) }),
      /* @__PURE__ */ (0, import_jsx_runtime28.jsxs)(Box_default, { flexGrow: 1, flexDirection: "column", children: [
        /* @__PURE__ */ (0, import_jsx_runtime28.jsxs)(Text, { color: theme.text.secondary, children: [
          "Goal check",
          typeof iterations === "number" && iterations > 0 ? ` \xB7 turn ${iterations}` : "",
          " ",
          "\xB7 not yet met"
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime28.jsxs)(Text, { color: theme.text.secondary, wrap: "wrap", children: [
          "Goal: ",
          condition
        ] }),
        reason ? /* @__PURE__ */ (0, import_jsx_runtime28.jsxs)(Text, { color: theme.text.secondary, wrap: "wrap", children: [
          "Judge: ",
          reason
        ] }) : null
      ] })
    ] });
  }
  const { prefix, prefixColor, title } = (() => {
    switch (kind) {
      case "set":
        return {
          prefix: ICON.BULLSEYE,
          prefixColor: theme.text.accent,
          title: "Goal set"
        };
      case "achieved":
        return {
          prefix: ICON.CHECK,
          prefixColor: theme.status.success,
          title: "Goal achieved"
        };
      case "cleared":
        return {
          prefix: ICON.CIRCLE_EMPTY,
          prefixColor: theme.text.secondary,
          title: "Goal cleared"
        };
      case "failed":
        return {
          prefix: ICON.CROSS,
          prefixColor: theme.status.error,
          title: "Goal could not be achieved"
        };
      case "aborted":
        return {
          prefix: "!",
          prefixColor: theme.status.warning,
          title: "Goal aborted"
        };
      case "paused":
        return {
          prefix: "!",
          prefixColor: theme.status.warning,
          title: "Goal paused"
        };
      default:
        return assertNeverGoalStatusKind(kind);
    }
  })();
  const stats = [];
  if (typeof iterations === "number" && iterations > 0) {
    stats.push(`${iterations} ${pluralTurns(iterations)}`);
  }
  if (typeof durationMs === "number") {
    stats.push(formatDuration(durationMs, { hideTrailingZeros: true }));
  }
  const subtitle = stats.length > 0 ? stats.join(" \xB7 ") : null;
  return /* @__PURE__ */ (0, import_jsx_runtime28.jsxs)(Box_default, { flexDirection: "row", children: [
    /* @__PURE__ */ (0, import_jsx_runtime28.jsx)(Box_default, { width: 2, flexShrink: 0, children: /* @__PURE__ */ (0, import_jsx_runtime28.jsx)(Text, { color: prefixColor, children: prefix }) }),
    /* @__PURE__ */ (0, import_jsx_runtime28.jsxs)(Box_default, { flexGrow: 1, flexDirection: "column", children: [
      /* @__PURE__ */ (0, import_jsx_runtime28.jsxs)(Text, { color: prefixColor, children: [
        title,
        subtitle ? /* @__PURE__ */ (0, import_jsx_runtime28.jsxs)(Text, { color: theme.text.secondary, children: [
          " \xB7 ",
          subtitle
        ] }) : null
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime28.jsxs)(Box_default, { flexDirection: "row", children: [
        /* @__PURE__ */ (0, import_jsx_runtime28.jsx)(Box_default, { flexShrink: 0, marginRight: 1, children: /* @__PURE__ */ (0, import_jsx_runtime28.jsx)(Text, { color: theme.text.secondary, children: "Goal:" }) }),
        /* @__PURE__ */ (0, import_jsx_runtime28.jsx)(Box_default, { flexGrow: 1, children: /* @__PURE__ */ (0, import_jsx_runtime28.jsx)(Text, { wrap: "wrap", children: condition }) })
      ] }),
      isTerminalGoalStatusKind(kind) && lastReason?.trim() ? /* @__PURE__ */ (0, import_jsx_runtime28.jsxs)(Text, { color: theme.text.secondary, wrap: "wrap", children: [
        "Last check: ",
        lastReason.trim()
      ] }) : null
    ] })
  ] });
}, "GoalStatusMessageInternal");
var GoalStatusMessage = import_react19.default.memo(GoalStatusMessageInternal);

// packages/cli/src/ui/contexts/ThoughtExpandedContext.tsx
init_esbuild_shims();
var import_react20 = __toESM(require_react(), 1);
var EMPTY_IDS = /* @__PURE__ */ new Set();
var ThoughtExpandedContext = (0, import_react20.createContext)({
  allExpanded: false,
  expandedHeadIds: EMPTY_IDS,
  toggle: /* @__PURE__ */ __name(() => {
  }, "toggle")
});
var useThoughtExpanded = /* @__PURE__ */ __name(() => (0, import_react20.useContext)(ThoughtExpandedContext), "useThoughtExpanded");
var ThoughtExpandedProvider = ThoughtExpandedContext.Provider;

// packages/cli/src/ui/contexts/ToolDetailsExpandedContext.tsx
init_esbuild_shims();
var import_react21 = __toESM(require_react(), 1);
var EMPTY_IDS2 = /* @__PURE__ */ new Set();
var ToolDetailsExpandedContext = (0, import_react21.createContext)({
  expandedBatchIds: EMPTY_IDS2,
  expandBatch: /* @__PURE__ */ __name(() => {
  }, "expandBatch")
});
var useToolDetailsExpanded = /* @__PURE__ */ __name(() => (0, import_react21.useContext)(ToolDetailsExpandedContext), "useToolDetailsExpanded");
var ToolDetailsExpandedProvider = ToolDetailsExpandedContext.Provider;

// packages/cli/src/ui/utils/hyperlink-at.ts
init_esbuild_shims();
function extractUrlFromOsc8Code(code) {
  const marker = code.indexOf("]8;");
  if (marker === -1) return void 0;
  const paramsEnd = code.indexOf(";", marker + 3);
  if (paramsEnd === -1) return void 0;
  const urlStart = paramsEnd + 1;
  let end = urlStart;
  while (end < code.length) {
    const c = code.charCodeAt(end);
    if (c < 32 || c >= 127 && c <= 159) break;
    end++;
  }
  const url = code.slice(urlStart, end);
  return url.length > 0 ? url : void 0;
}
__name(extractUrlFromOsc8Code, "extractUrlFromOsc8Code");
function hyperlinkAtCell(frame, x, y) {
  const row = frame?.cells[y];
  if (!row) return void 0;
  let cell = row[x];
  if (cell && cell.value === "" && x > 0 && row[x - 1]?.fullWidth) {
    cell = row[x - 1];
  }
  if (!cell) return void 0;
  for (const style of cell.styles) {
    if (typeof style === "object" && style !== null && typeof style.code === "string") {
      const url = extractUrlFromOsc8Code(style.code);
      if (url) return url;
    }
  }
  return void 0;
}
__name(hyperlinkAtCell, "hyperlinkAtCell");

// packages/cli/src/ui/selection/screen-buffer.ts
init_esbuild_shims();
var ScreenBuffer = class {
  constructor(controller) {
    this.controller = controller;
  }
  static {
    __name(this, "ScreenBuffer");
  }
  get frame() {
    return this.controller.getFrame();
  }
  get dimensions() {
    const frame = this.frame;
    return { width: frame?.width ?? 0, height: frame?.height ?? 0 };
  }
  getCellAt(x, y) {
    const cell = this.frame?.cells[y]?.[x];
    return cell ? { value: cell.value, fullWidth: cell.fullWidth } : null;
  }
  /** Visual text of a row, with trailing padding trimmed. */
  lineText(y) {
    const row = this.frame?.cells[y];
    if (!row) {
      return "";
    }
    return row.map((cell) => cell.value).join("").replace(/\s+$/u, "");
  }
  setSelection(selection) {
    this.controller.setSelection(selection);
  }
  subscribe(listener) {
    return this.controller.subscribe(listener);
  }
};
function getScreenBuffer(stdout) {
  const controller = getFrameController(stdout);
  return controller ? new ScreenBuffer(controller) : void 0;
}
__name(getScreenBuffer, "getScreenBuffer");

// packages/cli/src/ui/components/HistoryItemDisplay.tsx
var import_jsx_runtime29 = __toESM(require_jsx_runtime(), 1);
var ClickableThinkMessage = /* @__PURE__ */ __name(({
  text,
  isPending,
  expanded,
  availableTerminalHeight,
  contentWidth,
  durationMs,
  onToggle
}) => {
  const ref = (0, import_react22.useRef)(null);
  const pressRef = (0, import_react22.useRef)(null);
  const { rows: terminalHeight } = useTerminalSize();
  const { stdout } = use_stdout_default();
  const settings = useSettings();
  const mouseTrackingEnabled = useMouseTrackingEnabled();
  const clickable = useVirtualViewport(settings.merged.ui?.useTerminalBuffer) && mouseTrackingEnabled;
  const { menu: contextMenu } = useContextMenu();
  const isActive = !isPending && contextMenu === null;
  useMouseEvents(
    (0, import_react22.useCallback)(
      (event) => {
        if (!ref.current) return;
        if (event.name === "move") {
          if (pressRef.current && (event.col !== pressRef.current.col || event.row !== pressRef.current.row)) {
            pressRef.current = null;
          }
          return;
        }
        if (event.name !== "left-press" && event.name !== "left-release") {
          pressRef.current = null;
          return;
        }
        const metrics = measureElementPosition(ref.current);
        const col = event.col - 1;
        const row = layoutRowForEvent(ref.current, event.row, terminalHeight);
        const isInside = col >= metrics.x && col < metrics.x + metrics.width && row >= metrics.y && row < metrics.y + metrics.height;
        if (event.name === "left-press") {
          pressRef.current = isInside ? { col: event.col, row: event.row } : null;
          return;
        }
        const press = pressRef.current;
        pressRef.current = null;
        if (isInside && press?.col === event.col && press.row === event.row) {
          const url = hyperlinkAtCell(
            getScreenBuffer(stdout)?.frame ?? null,
            col,
            row
          );
          if (!url) {
            onToggle();
          }
        }
      },
      [onToggle, terminalHeight, stdout]
    ),
    { isActive }
  );
  return /* @__PURE__ */ (0, import_jsx_runtime29.jsx)(Box_default, { ref: isActive ? ref : void 0, children: /* @__PURE__ */ (0, import_jsx_runtime29.jsx)(
    ThinkMessage,
    {
      text,
      isPending,
      expanded,
      availableTerminalHeight,
      contentWidth,
      durationMs,
      clickable
    }
  ) });
}, "ClickableThinkMessage");
function hasRequiredToolInteraction(props) {
  if (props.isUserInitiated) return true;
  if (props.embeddedShellFocused && props.toolCalls.some(
    (tool) => tool.ptyId === props.activeShellPtyId && tool.status === "Executing" /* Executing */
  )) {
    return true;
  }
  return props.toolCalls.some((tool) => {
    if (tool.status === "Confirming" /* Confirming */) return true;
    const display = tool.resultDisplay;
    return typeof display === "object" && display !== null && "type" in display && display.type === "task_execution" && "pendingConfirmation" in display && display.pendingConfirmation !== void 0;
  });
}
__name(hasRequiredToolInteraction, "hasRequiredToolInteraction");
var CollapsibleToolGroupMessage = /* @__PURE__ */ __name(({ expansionKey, ...props }) => {
  const settings = useSettings();
  const [locallyExpanded, setLocallyExpanded] = (0, import_react22.useState)(false);
  const { expandedBatchIds, expandBatch } = useToolDetailsExpanded();
  const ref = (0, import_react22.useRef)(null);
  const pressRef = (0, import_react22.useRef)(null);
  const { rows: terminalHeight } = useTerminalSize();
  const mouseTrackingEnabled = useMouseTrackingEnabled();
  const clickable = useVirtualViewport(settings.merged.ui?.useTerminalBuffer) && mouseTrackingEnabled;
  const collapsed = settings.merged.ui?.showToolCallDetails === false && !locallyExpanded && !(expansionKey && expandedBatchIds.has(expansionKey)) && !props.fullDetail && !hasRequiredToolInteraction(props);
  useMouseEvents(
    (0, import_react22.useCallback)(
      (event) => {
        if (!collapsed || !ref.current) return;
        if (event.name === "move") {
          if (pressRef.current && (event.col !== pressRef.current.col || event.row !== pressRef.current.row)) {
            pressRef.current = null;
          }
          return;
        }
        if (event.name !== "left-press" && event.name !== "left-release") {
          pressRef.current = null;
          return;
        }
        const metrics = measureElementPosition(ref.current);
        const col = event.col - 1;
        const row = layoutRowForEvent(ref.current, event.row, terminalHeight);
        const isInside = col >= metrics.x && col < metrics.x + metrics.width && row >= metrics.y && row < metrics.y + metrics.height;
        if (event.name === "left-press") {
          pressRef.current = isInside ? { col: event.col, row: event.row } : null;
          return;
        }
        const press = pressRef.current;
        pressRef.current = null;
        if (isInside && press?.col === event.col && press.row === event.row) {
          if (expansionKey) {
            expandBatch(expansionKey);
          } else {
            setLocallyExpanded(true);
          }
        }
      },
      [collapsed, terminalHeight, expansionKey, expandBatch]
    ),
    { isActive: collapsed && clickable }
  );
  if (!collapsed) return /* @__PURE__ */ (0, import_jsx_runtime29.jsx)(ToolGroupMessage, { ...props });
  return /* @__PURE__ */ (0, import_jsx_runtime29.jsx)(
    ToolGroupMessage,
    {
      ...props,
      hideDetails: true,
      expandHint: clickable ? "click to expand" : "ctrl+o to expand",
      summaryRef: ref
    }
  );
}, "CollapsibleToolGroupMessage");
function getHistoryItemMarginTop(item) {
  switch (item.type) {
    case "gemini":
    case "gemini_thought":
      return 1;
    case "gemini_content":
    case "gemini_thought_content":
    case "info":
    case "success":
    case "warning":
    case "error":
    case "retry_countdown":
    case "memory_saved":
    case "tool_group":
    case "tool_use_summary":
    case "notification":
    case "compression":
    case "summary":
    case "insight_progress":
    case "btw":
    case "advisor":
    case "away_recap":
    case "user":
    case "user_prompt_submit_blocked":
    case "stop_hook_loop":
    case "stop_hook_system_message":
    case "goal_status":
    case "goal_state":
    case "vision_notice":
      return 0;
    default:
      return 1;
  }
}
__name(getHistoryItemMarginTop, "getHistoryItemMarginTop");
var HistoryItemDisplayComponent = /* @__PURE__ */ __name(({
  item,
  availableTerminalHeight,
  terminalWidth,
  mainAreaWidth,
  isPending,
  commands,
  isFocused = true,
  activeShellPtyId,
  embeddedShellFocused,
  availableTerminalHeightLlm,
  sourceCopyIndexOffsets,
  thoughtExpanded,
  fullDetail = false,
  thoughtHeadId
}) => {
  const marginTop = getHistoryItemMarginTop(item);
  const {
    allExpanded,
    expandedHeadIds,
    toggle: toggleThought
  } = useThoughtExpanded();
  const thoughtGroupHeadId = thoughtHeadId ?? item.id;
  const resolvedThoughtExpanded = fullDetail || (thoughtExpanded ?? (allExpanded || expandedHeadIds.has(thoughtGroupHeadId)));
  const settings = useSettings();
  const showTimestamps = settings.merged.output?.showTimestamps === true;
  const itemForDisplay = (0, import_react22.useMemo)(() => escapeAnsiCtrlCodes(item), [item]);
  const contentWidth = terminalWidth - 4;
  const boxWidth = mainAreaWidth || contentWidth;
  return /* @__PURE__ */ (0, import_jsx_runtime29.jsxs)(
    Box_default,
    {
      flexDirection: "column",
      marginTop,
      marginLeft: 2,
      marginRight: 2,
      children: [
        itemForDisplay.type === "user" && /* @__PURE__ */ (0, import_jsx_runtime29.jsx)(UserMessage, { text: itemForDisplay.text }),
        itemForDisplay.type === "notification" && /* @__PURE__ */ (0, import_jsx_runtime29.jsx)(InfoMessage, { text: itemForDisplay.text }),
        itemForDisplay.type === "user_shell" && /* @__PURE__ */ (0, import_jsx_runtime29.jsx)(UserShellMessage, { text: itemForDisplay.text }),
        itemForDisplay.type === "gemini" && /* @__PURE__ */ (0, import_jsx_runtime29.jsxs)(import_jsx_runtime29.Fragment, { children: [
          showTimestamps && itemForDisplay.timestamp != null && /* @__PURE__ */ (0, import_jsx_runtime29.jsxs)(Text, { dimColor: true, children: [
            "[",
            new Date(itemForDisplay.timestamp).toLocaleTimeString("en-US", {
              hour12: false,
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit"
            }),
            "]"
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime29.jsx)(
            AssistantMessage,
            {
              text: itemForDisplay.text,
              images: itemForDisplay.images,
              omittedImageCount: itemForDisplay.omittedImageCount,
              isPending,
              availableTerminalHeight: availableTerminalHeightLlm ?? availableTerminalHeight,
              contentWidth,
              sourceCopyIndexOffsets
            }
          )
        ] }),
        itemForDisplay.type === "gemini_content" && /* @__PURE__ */ (0, import_jsx_runtime29.jsx)(
          AssistantMessageContent,
          {
            text: itemForDisplay.text,
            images: itemForDisplay.images,
            omittedImageCount: itemForDisplay.omittedImageCount,
            isPending,
            availableTerminalHeight: availableTerminalHeightLlm ?? availableTerminalHeight,
            contentWidth,
            sourceCopyIndexOffsets
          }
        ),
        itemForDisplay.type === "gemini_thought" && /* @__PURE__ */ (0, import_jsx_runtime29.jsx)(
          ClickableThinkMessage,
          {
            text: itemForDisplay.text.trimEnd(),
            isPending,
            expanded: resolvedThoughtExpanded,
            availableTerminalHeight: availableTerminalHeightLlm ?? availableTerminalHeight,
            contentWidth,
            durationMs: itemForDisplay.durationMs,
            onToggle: () => toggleThought(thoughtGroupHeadId)
          }
        ),
        itemForDisplay.type === "gemini_thought_content" && /* @__PURE__ */ (0, import_jsx_runtime29.jsx)(
          ThinkMessageContent,
          {
            text: itemForDisplay.text.trimEnd(),
            isPending,
            expanded: resolvedThoughtExpanded,
            availableTerminalHeight: availableTerminalHeightLlm ?? availableTerminalHeight,
            contentWidth
          }
        ),
        itemForDisplay.type === "info" && /* @__PURE__ */ (0, import_jsx_runtime29.jsx)(
          InfoMessage,
          {
            text: itemForDisplay.text,
            linkUrl: itemForDisplay.linkUrl,
            linkText: itemForDisplay.linkText
          }
        ),
        itemForDisplay.type === "success" && /* @__PURE__ */ (0, import_jsx_runtime29.jsx)(SuccessMessage, { text: itemForDisplay.text }),
        itemForDisplay.type === "warning" && /* @__PURE__ */ (0, import_jsx_runtime29.jsx)(WarningMessage, { text: itemForDisplay.text }),
        itemForDisplay.type === "error" && /* @__PURE__ */ (0, import_jsx_runtime29.jsx)(ErrorMessage, { text: itemForDisplay.text, hint: itemForDisplay.hint }),
        itemForDisplay.type === "retry_countdown" && /* @__PURE__ */ (0, import_jsx_runtime29.jsx)(RetryCountdownMessage, { text: itemForDisplay.text }),
        itemForDisplay.type === "vision_notice" && /* @__PURE__ */ (0, import_jsx_runtime29.jsx)(VisionNoticeMessage, { text: itemForDisplay.text }),
        itemForDisplay.type === "about" && /* @__PURE__ */ (0, import_jsx_runtime29.jsx)(AboutBox, { ...itemForDisplay.systemInfo, width: boxWidth }),
        itemForDisplay.type === "help" && commands && /* @__PURE__ */ (0, import_jsx_runtime29.jsx)(Help, { commands, width: boxWidth }),
        itemForDisplay.type === "stats" && /* @__PURE__ */ (0, import_jsx_runtime29.jsx)(StatsDisplay, { duration: itemForDisplay.duration, width: boxWidth }),
        itemForDisplay.type === "diff_stats" && /* @__PURE__ */ (0, import_jsx_runtime29.jsx)(DiffStatsDisplay, { model: itemForDisplay.model }),
        itemForDisplay.type === "model_stats" && /* @__PURE__ */ (0, import_jsx_runtime29.jsx)(ModelStatsDisplay, { width: boxWidth }),
        itemForDisplay.type === "tool_stats" && /* @__PURE__ */ (0, import_jsx_runtime29.jsx)(ToolStatsDisplay, { width: boxWidth }),
        itemForDisplay.type === "skill_stats" && /* @__PURE__ */ (0, import_jsx_runtime29.jsx)(SkillStatsDisplay, { width: boxWidth }),
        itemForDisplay.type === "quit" && /* @__PURE__ */ (0, import_jsx_runtime29.jsx)(
          SessionSummaryDisplay,
          {
            duration: itemForDisplay.duration,
            width: boxWidth
          }
        ),
        itemForDisplay.type === "tool_group" && /* @__PURE__ */ (0, import_jsx_runtime29.jsx)(
          CollapsibleToolGroupMessage,
          {
            toolCalls: itemForDisplay.tools,
            groupId: itemForDisplay.id,
            availableTerminalHeight,
            contentWidth,
            isFocused,
            isPending,
            activeShellPtyId,
            embeddedShellFocused,
            memoryWriteCount: itemForDisplay.memoryWriteCount,
            memoryReadCount: itemForDisplay.memoryReadCount,
            isUserInitiated: itemForDisplay.isUserInitiated,
            fullDetail,
            expansionKey: itemForDisplay.batchId
          }
        ),
        itemForDisplay.type === "tool_use_summary" && /* @__PURE__ */ (0, import_jsx_runtime29.jsxs)(Box_default, { flexDirection: "row", children: [
          /* @__PURE__ */ (0, import_jsx_runtime29.jsx)(Box_default, { width: 2, flexShrink: 0, children: /* @__PURE__ */ (0, import_jsx_runtime29.jsx)(Text, { dimColor: true, children: ICON.CIRCLE_FILLED }) }),
          /* @__PURE__ */ (0, import_jsx_runtime29.jsx)(Text, { dimColor: true, children: itemForDisplay.summary })
        ] }),
        itemForDisplay.type === "compression" && /* @__PURE__ */ (0, import_jsx_runtime29.jsx)(CompressionMessage, { compression: itemForDisplay.compression }),
        itemForDisplay.type === "summary" && /* @__PURE__ */ (0, import_jsx_runtime29.jsx)(SummaryMessage, { summary: itemForDisplay.summary }),
        itemForDisplay.type === "extensions_list" && /* @__PURE__ */ (0, import_jsx_runtime29.jsx)(ExtensionsList, {}),
        itemForDisplay.type === "tools_list" && /* @__PURE__ */ (0, import_jsx_runtime29.jsx)(
          ToolsList,
          {
            contentWidth,
            tools: itemForDisplay.tools,
            showDescriptions: itemForDisplay.showDescriptions
          }
        ),
        itemForDisplay.type === "skills_list" && /* @__PURE__ */ (0, import_jsx_runtime29.jsx)(SkillsList, { skills: itemForDisplay.skills }),
        itemForDisplay.type === "mcp_status" && /* @__PURE__ */ (0, import_jsx_runtime29.jsx)(McpStatus, { ...itemForDisplay, serverStatus: getMCPServerStatus }),
        itemForDisplay.type === "context_usage" && /* @__PURE__ */ (0, import_jsx_runtime29.jsx)(
          ContextUsage,
          {
            modelName: itemForDisplay.modelName,
            totalTokens: itemForDisplay.totalTokens,
            contextWindowSize: itemForDisplay.contextWindowSize,
            breakdown: itemForDisplay.breakdown,
            builtinTools: itemForDisplay.builtinTools,
            mcpTools: itemForDisplay.mcpTools,
            memoryFiles: itemForDisplay.memoryFiles,
            skills: itemForDisplay.skills,
            isEstimated: itemForDisplay.isEstimated,
            showDetails: itemForDisplay.showDetails
          }
        ),
        itemForDisplay.type === "doctor" && /* @__PURE__ */ (0, import_jsx_runtime29.jsx)(
          DoctorReport,
          {
            checks: itemForDisplay.checks,
            summary: itemForDisplay.summary,
            width: boxWidth
          }
        ),
        itemForDisplay.type === "arena_agent_complete" && /* @__PURE__ */ (0, import_jsx_runtime29.jsx)(ArenaAgentCard, { agent: itemForDisplay.agent, width: boxWidth }),
        itemForDisplay.type === "arena_session_complete" && /* @__PURE__ */ (0, import_jsx_runtime29.jsx)(
          ArenaSessionCard,
          {
            sessionStatus: itemForDisplay.sessionStatus,
            task: itemForDisplay.task,
            totalDurationMs: itemForDisplay.totalDurationMs,
            agents: itemForDisplay.agents,
            width: boxWidth
          }
        ),
        itemForDisplay.type === "insight_progress" && /* @__PURE__ */ (0, import_jsx_runtime29.jsx)(InsightProgressMessage, { progress: itemForDisplay.progress }),
        itemForDisplay.type === "btw" && itemForDisplay.btw && /* @__PURE__ */ (0, import_jsx_runtime29.jsx)(BtwMessage, { btw: itemForDisplay.btw, containerWidth: contentWidth }),
        itemForDisplay.type === "advisor" && /* @__PURE__ */ (0, import_jsx_runtime29.jsx)(
          AdvisorMessage,
          {
            text: itemForDisplay.text,
            model: itemForDisplay.model,
            containerWidth: contentWidth
          }
        ),
        itemForDisplay.type === "user_prompt_submit_blocked" && /* @__PURE__ */ (0, import_jsx_runtime29.jsx)(Box_default, { flexDirection: "column", children: /* @__PURE__ */ (0, import_jsx_runtime29.jsx)(Text, { color: theme.status.warning, children: `\u2715 UserPromptSubmit operation blocked by hook:
${itemForDisplay.reason}

Original prompt: ${sanitizeSensitiveText(itemForDisplay.originalPrompt)}` }) }),
        itemForDisplay.type === "stop_hook_loop" && /* @__PURE__ */ (0, import_jsx_runtime29.jsx)(
          InfoMessage,
          {
            text: `Ran ${itemForDisplay.stopHookCount} stop hooks
  \u23BF  Stop hook error: ${itemForDisplay.reasons[itemForDisplay.reasons.length - 1]}`
          }
        ),
        itemForDisplay.type === "stop_hook_system_message" && /* @__PURE__ */ (0, import_jsx_runtime29.jsxs)(Box_default, { flexDirection: "column", children: [
          /* @__PURE__ */ (0, import_jsx_runtime29.jsx)(Text, { color: theme.text.primary, children: " \u23BF Stop says:" }),
          /* @__PURE__ */ (0, import_jsx_runtime29.jsx)(Box_default, { marginLeft: 4, flexDirection: "column", children: /* @__PURE__ */ (0, import_jsx_runtime29.jsx)(
            MarkdownDisplay,
            {
              text: itemForDisplay.message,
              isPending: false,
              contentWidth: contentWidth - 4
            }
          ) })
        ] }),
        itemForDisplay.type === "memory_saved" && /* @__PURE__ */ (0, import_jsx_runtime29.jsx)(MemorySavedMessage, { item: itemForDisplay }),
        itemForDisplay.type === "away_recap" && /* @__PURE__ */ (0, import_jsx_runtime29.jsx)(AwayRecapMessage, { text: itemForDisplay.text }),
        itemForDisplay.type === "goal_status" && /* @__PURE__ */ (0, import_jsx_runtime29.jsx)(
          GoalStatusMessage,
          {
            kind: itemForDisplay.kind,
            condition: itemForDisplay.condition,
            iterations: itemForDisplay.iterations,
            durationMs: itemForDisplay.durationMs,
            lastReason: itemForDisplay.lastReason
          }
        ),
        itemForDisplay.type === "goal_state" && /* @__PURE__ */ (0, import_jsx_runtime29.jsx)(
          GoalStatusMessage,
          {
            snapshot: itemForDisplay.snapshot,
            cause: itemForDisplay.cause
          }
        )
      ]
    },
    itemForDisplay.id
  );
}, "HistoryItemDisplayComponent");
var HistoryItemDisplay = (0, import_react22.memo)(HistoryItemDisplayComponent);
HistoryItemDisplay.displayName = "HistoryItemDisplay";

// packages/cli/src/ui/components/SessionPreview.tsx
var import_jsx_runtime30 = __toESM(require_jsx_runtime(), 1);
function SessionPreview(props) {
  const {
    sessionService,
    sessionId,
    sessionTitle,
    messageCount,
    mtime,
    gitBranch,
    onExit,
    onResume
  } = props;
  const { columns } = useTerminalSize();
  const [data, setData] = (0, import_react23.useState)(null);
  const [error, setError] = (0, import_react23.useState)(null);
  (0, import_react23.useEffect)(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    sessionService.loadSession(sessionId).then((d) => {
      if (cancelled) return;
      if (!d) {
        setError("Session not found");
        return;
      }
      setData(d);
    }).catch((e) => {
      if (cancelled) return;
      setError(e instanceof Error ? e.message : String(e));
    });
    return () => {
      cancelled = true;
    };
  }, [sessionService, sessionId]);
  const items = (0, import_react23.useMemo)(() => {
    if (!data) return [];
    return buildResumedHistoryItems(data, null);
  }, [data]);
  const computedMessageCount = (0, import_react23.useMemo)(() => {
    if (!data) return void 0;
    const seen = /* @__PURE__ */ new Set();
    for (const msg of data.conversation.messages) {
      if (msg.type === "user" || msg.type === "assistant") {
        seen.add(msg.uuid);
      }
    }
    return seen.size;
  }, [data]);
  const displayMessageCount = messageCount ?? computedMessageCount;
  useKeypress(
    (key) => {
      const { name, ctrl } = key;
      if (name === "escape" || ctrl && name === "c") {
        onExit();
        return;
      }
      if (name === "return") {
        onResume(sessionId);
      }
    },
    { isActive: true }
  );
  const boxWidth = Math.max(10, columns - 4);
  const separatorWidth = Math.max(0, boxWidth - 2);
  const metaParts = [];
  if (typeof displayMessageCount === "number") {
    metaParts.push(formatMessageCount(displayMessageCount));
  }
  if (typeof mtime === "number") {
    metaParts.push(formatRelativeTime(mtime));
  }
  if (gitBranch) {
    metaParts.push(gitBranch);
  }
  const metaLine = metaParts.join(" \xB7 ");
  const header = /* @__PURE__ */ (0, import_jsx_runtime30.jsx)(Box_default, { paddingX: 1, children: /* @__PURE__ */ (0, import_jsx_runtime30.jsx)(Text, { bold: true, color: theme.text.primary, children: sessionTitle ?? t("Session Preview") }) }, "header");
  const topSeparator = /* @__PURE__ */ (0, import_jsx_runtime30.jsx)(Box_default, { children: /* @__PURE__ */ (0, import_jsx_runtime30.jsx)(Text, { color: theme.border.default, children: "\u2500".repeat(separatorWidth) }) }, "top-separator");
  const footerSeparator = /* @__PURE__ */ (0, import_jsx_runtime30.jsx)(Box_default, { children: /* @__PURE__ */ (0, import_jsx_runtime30.jsx)(Text, { color: theme.border.default, children: "\u2500".repeat(separatorWidth) }) }, "footer-separator");
  const meta = metaLine ? /* @__PURE__ */ (0, import_jsx_runtime30.jsx)(Box_default, { paddingX: 1, children: /* @__PURE__ */ (0, import_jsx_runtime30.jsx)(Text, { color: theme.text.secondary, children: metaLine }) }, "meta") : null;
  const footer = /* @__PURE__ */ (0, import_jsx_runtime30.jsx)(Box_default, { paddingX: 1, children: /* @__PURE__ */ (0, import_jsx_runtime30.jsx)(Text, { color: theme.text.secondary, children: t("Enter to resume \xB7 Esc to back") }) }, "footer");
  if (data && !error) {
    return /* @__PURE__ */ (0, import_jsx_runtime30.jsx)(Box_default, { flexDirection: "column", width: boxWidth, children: /* @__PURE__ */ (0, import_jsx_runtime30.jsx)(
      Static,
      {
        items: [
          header,
          topSeparator,
          ...items.map((item) => /* @__PURE__ */ (0, import_jsx_runtime30.jsx)(
            HistoryItemDisplay,
            {
              item,
              terminalWidth: boxWidth,
              isPending: false,
              thoughtExpanded: true
            },
            item.id
          )),
          footerSeparator,
          ...meta ? [meta] : [],
          footer
        ],
        children: (item) => item
      },
      sessionId
    ) });
  }
  return /* @__PURE__ */ (0, import_jsx_runtime30.jsxs)(Box_default, { flexDirection: "column", width: boxWidth, children: [
    header,
    topSeparator,
    error ? /* @__PURE__ */ (0, import_jsx_runtime30.jsx)(Box_default, { paddingY: 1, justifyContent: "center", children: /* @__PURE__ */ (0, import_jsx_runtime30.jsx)(Text, { color: theme.status.error, children: error }) }) : /* @__PURE__ */ (0, import_jsx_runtime30.jsx)(Box_default, { paddingY: 1, justifyContent: "center", children: /* @__PURE__ */ (0, import_jsx_runtime30.jsx)(Text, { color: theme.text.secondary, children: t("Loading session preview...") }) }),
    footerSeparator,
    meta,
    footer
  ] });
}
__name(SessionPreview, "SessionPreview");

// packages/cli/src/ui/components/SessionPicker.tsx
var import_jsx_runtime31 = __toESM(require_jsx_runtime(), 1);
var PREFIX_CHARS = {
  selected: "\u203A ",
  scrollUp: "\u2191 ",
  scrollDown: "\u2193 ",
  normal: "  "
};
function SessionListItemView({
  session,
  isSelected,
  isFirst,
  isLast,
  showScrollUp,
  showScrollDown,
  maxPromptWidth,
  prefixChars = PREFIX_CHARS,
  boldSelectedPrefix = true,
  isChecked,
  isDisabled = false,
  disabledHint
}) {
  const timeAgo = formatRelativeTime(session.mtime);
  const messageText = typeof session.messageCount === "number" ? formatMessageCount(session.messageCount) : void 0;
  const showUpIndicator = isFirst && showScrollUp;
  const showDownIndicator = isLast && showScrollDown;
  const prefix = isSelected ? prefixChars.selected : showUpIndicator ? prefixChars.scrollUp : showDownIndicator ? prefixChars.scrollDown : prefixChars.normal;
  const promptText = session.customTitle || session.prompt || session.goalObjective || "(empty prompt)";
  const checkboxWidth = isChecked === void 0 ? 0 : 4;
  const truncatedPrompt = truncateText(
    promptText,
    Math.max(1, maxPromptWidth - checkboxWidth)
  );
  const isAutoTitle = session.titleSource === "auto" && Boolean(session.customTitle);
  return /* @__PURE__ */ (0, import_jsx_runtime31.jsxs)(Box_default, { flexDirection: "column", marginBottom: isLast ? 0 : 1, children: [
    /* @__PURE__ */ (0, import_jsx_runtime31.jsxs)(Box_default, { children: [
      /* @__PURE__ */ (0, import_jsx_runtime31.jsx)(
        Text,
        {
          color: isSelected ? theme.text.accent : showUpIndicator || showDownIndicator ? theme.text.secondary : void 0,
          bold: isSelected && boldSelectedPrefix,
          children: prefix
        }
      ),
      isChecked !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime31.jsx)(
        Text,
        {
          color: isDisabled ? theme.text.secondary : isChecked ? theme.text.accent : isSelected ? theme.text.accent : theme.text.secondary,
          bold: isChecked,
          children: isChecked ? "[x] " : "[ ] "
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime31.jsx)(
        Text,
        {
          color: isDisabled ? theme.text.secondary : isSelected ? theme.text.accent : isAutoTitle ? theme.text.secondary : theme.text.primary,
          bold: isSelected && !isDisabled,
          children: truncatedPrompt
        }
      )
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime31.jsx)(Box_default, { paddingLeft: 2, children: /* @__PURE__ */ (0, import_jsx_runtime31.jsxs)(Text, { color: theme.text.secondary, children: [
      timeAgo,
      messageText !== void 0 && ` \xB7 ${messageText}`,
      session.gitBranch && ` \xB7 ${session.gitBranch}`,
      isDisabled && disabledHint ? ` \xB7 ${disabledHint}` : ""
    ] }) })
  ] });
}
__name(SessionListItemView, "SessionListItemView");
function SessionPicker(props) {
  const {
    sessionService,
    onSelect,
    onCancel,
    currentBranch,
    title,
    centerSelection = true,
    initialSessions,
    enablePreview = false,
    enableMultiSelect = false,
    onConfirmMulti,
    disabledIds
  } = props;
  const { columns: width, rows: height } = useTerminalSize();
  const boxWidth = width - 4;
  const reservedLines = 7;
  const itemHeight = 3;
  const maxVisibleItems = Math.max(
    1,
    Math.floor((height - reservedLines) / itemHeight)
  );
  const picker = useSessionPicker({
    sessionService,
    currentBranch,
    onSelect,
    onCancel,
    maxVisibleItems,
    centerSelection,
    initialSessions,
    isActive: true,
    enablePreview,
    enableMultiSelect,
    onConfirmMulti,
    disabledIds
  });
  if (enablePreview && picker.viewMode === "preview" && picker.previewSessionId && sessionService) {
    const previewed = picker.filteredSessions.find(
      (s) => s.sessionId === picker.previewSessionId
    );
    return /* @__PURE__ */ (0, import_jsx_runtime31.jsx)(
      SessionPreview,
      {
        sessionService,
        sessionId: picker.previewSessionId,
        sessionTitle: previewed?.customTitle || previewed?.prompt || previewed?.goalObjective,
        messageCount: previewed?.messageCount,
        mtime: previewed?.mtime,
        gitBranch: previewed?.gitBranch,
        onExit: picker.exitPreview,
        onResume: onSelect
      }
    );
  }
  return /* @__PURE__ */ (0, import_jsx_runtime31.jsx)(
    Box_default,
    {
      flexDirection: "column",
      width: boxWidth,
      height: height - 1,
      overflow: "hidden",
      children: /* @__PURE__ */ (0, import_jsx_runtime31.jsxs)(
        Box_default,
        {
          flexDirection: "column",
          borderStyle: "round",
          borderColor: theme.border.default,
          width: boxWidth,
          height: height - 1,
          overflow: "hidden",
          children: [
            /* @__PURE__ */ (0, import_jsx_runtime31.jsxs)(Box_default, { paddingX: 1, children: [
              /* @__PURE__ */ (0, import_jsx_runtime31.jsx)(Text, { bold: true, color: theme.text.primary, children: title ?? t("Resume Session") }),
              picker.filterByBranch && currentBranch && /* @__PURE__ */ (0, import_jsx_runtime31.jsxs)(Text, { color: theme.text.secondary, children: [
                " ",
                t("(branch: {{branch}})", { branch: currentBranch })
              ] }),
              picker.searchQuery !== "" && /* @__PURE__ */ (0, import_jsx_runtime31.jsxs)(Text, { color: theme.text.secondary, children: [
                " ",
                t("({{count}} matches)", {
                  count: String(picker.filteredSessions.length)
                })
              ] })
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime31.jsx)(Box_default, { paddingX: 1, children: picker.isSearchActive ? /* @__PURE__ */ (0, import_jsx_runtime31.jsxs)(import_jsx_runtime31.Fragment, { children: [
              /* @__PURE__ */ (0, import_jsx_runtime31.jsx)(Text, { color: theme.text.secondary, children: t("Search: ") }),
              /* @__PURE__ */ (0, import_jsx_runtime31.jsxs)(Text, { color: theme.text.primary, children: [
                picker.searchQuery,
                /* @__PURE__ */ (0, import_jsx_runtime31.jsx)(Text, { color: theme.text.secondary, children: "\u258C" })
              ] })
            ] }) : picker.searchQuery !== "" ? /* @__PURE__ */ (0, import_jsx_runtime31.jsxs)(import_jsx_runtime31.Fragment, { children: [
              /* @__PURE__ */ (0, import_jsx_runtime31.jsx)(Text, { color: theme.text.secondary, children: t("Filter: ") }),
              /* @__PURE__ */ (0, import_jsx_runtime31.jsx)(Text, { color: theme.text.primary, children: picker.searchQuery })
            ] }) : /* @__PURE__ */ (0, import_jsx_runtime31.jsx)(Text, { color: theme.text.secondary, children: t("Press / to search") }) }),
            /* @__PURE__ */ (0, import_jsx_runtime31.jsx)(Box_default, { children: /* @__PURE__ */ (0, import_jsx_runtime31.jsx)(Text, { color: theme.border.default, children: "\u2500".repeat(boxWidth - 2) }) }),
            /* @__PURE__ */ (0, import_jsx_runtime31.jsx)(Box_default, { flexDirection: "column", flexGrow: 1, paddingX: 1, overflow: "hidden", children: !sessionService || picker.isLoading ? /* @__PURE__ */ (0, import_jsx_runtime31.jsx)(Box_default, { paddingY: 1, justifyContent: "center", children: /* @__PURE__ */ (0, import_jsx_runtime31.jsx)(Text, { color: theme.text.secondary, children: t("Loading sessions...") }) }) : picker.filteredSessions.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime31.jsx)(Box_default, { paddingY: 1, justifyContent: "center", children: /* @__PURE__ */ (0, import_jsx_runtime31.jsx)(Text, { color: theme.text.secondary, children: picker.searchQuery !== "" ? t('No sessions match "{{query}}"', {
              query: picker.searchQuery
            }) : picker.filterByBranch ? t('No sessions found for branch "{{branch}}"', {
              branch: currentBranch ?? ""
            }) : t("No sessions found") }) }) : picker.visibleSessions.map((session, visibleIndex) => {
              const actualIndex = picker.scrollOffset + visibleIndex;
              const isDisabled = picker.disabledIdSet.has(session.sessionId);
              return /* @__PURE__ */ (0, import_jsx_runtime31.jsx)(
                SessionListItemView,
                {
                  session,
                  isSelected: !picker.isSearchActive && actualIndex === picker.selectedIndex,
                  isFirst: visibleIndex === 0,
                  isLast: visibleIndex === picker.visibleSessions.length - 1,
                  showScrollUp: picker.showScrollUp,
                  showScrollDown: picker.showScrollDown,
                  maxPromptWidth: boxWidth - 6,
                  prefixChars: PREFIX_CHARS,
                  boldSelectedPrefix: false,
                  isChecked: enableMultiSelect ? picker.checkedIds.has(session.sessionId) : void 0,
                  isDisabled: enableMultiSelect && isDisabled,
                  disabledHint: enableMultiSelect && isDisabled ? t("current \u2014 cannot delete") : void 0
                },
                session.sessionId
              );
            }) }),
            /* @__PURE__ */ (0, import_jsx_runtime31.jsx)(Box_default, { children: /* @__PURE__ */ (0, import_jsx_runtime31.jsx)(Text, { color: theme.border.default, children: "\u2500".repeat(boxWidth - 2) }) }),
            /* @__PURE__ */ (0, import_jsx_runtime31.jsx)(Box_default, { paddingX: 1, children: /* @__PURE__ */ (0, import_jsx_runtime31.jsx)(Box_default, { flexDirection: "row", children: picker.isSearchActive ? /* @__PURE__ */ (0, import_jsx_runtime31.jsx)(Text, { color: theme.text.secondary, children: t("Type to search \xB7 Enter to commit \xB7 Esc to clear") }) : /* @__PURE__ */ (0, import_jsx_runtime31.jsxs)(import_jsx_runtime31.Fragment, { children: [
              currentBranch && /* @__PURE__ */ (0, import_jsx_runtime31.jsxs)(Text, { color: theme.text.secondary, children: [
                /* @__PURE__ */ (0, import_jsx_runtime31.jsx)(
                  Text,
                  {
                    bold: picker.filterByBranch,
                    color: picker.filterByBranch ? theme.text.accent : void 0,
                    children: "Ctrl+B"
                  }
                ),
                t(" to toggle branch \xB7 ")
              ] }),
              enablePreview && /* @__PURE__ */ (0, import_jsx_runtime31.jsx)(Text, { color: theme.text.secondary, children: t("Space to preview \xB7 ") }),
              enableMultiSelect && (() => {
                let committableCheckedCount = 0;
                for (const id of picker.checkedIds) {
                  if (!picker.disabledIdSet.has(id)) {
                    committableCheckedCount++;
                  }
                }
                return /* @__PURE__ */ (0, import_jsx_runtime31.jsx)(Text, { color: theme.text.secondary, children: committableCheckedCount > 0 ? t("Space to toggle \xB7 {{count}} selected \xB7 ", {
                  count: String(committableCheckedCount)
                }) : t("Space to select multiple \xB7 ") });
              })(),
              /* @__PURE__ */ (0, import_jsx_runtime31.jsx)(Text, { color: theme.text.secondary, children: t("\u2191\u2193 to navigate \xB7 Type to search \xB7 Esc to cancel") })
            ] }) }) })
          ]
        }
      )
    }
  );
}
__name(SessionPicker, "SessionPicker");

export {
  ConfigContext,
  useConfig,
  truncateText,
  removeLastGrapheme,
  isDeletionKey,
  isPrintableSearchChar,
  dist_default,
  AboutBox,
  dist_default2,
  getRenderableGradientColors,
  Help,
  useHistory,
  IdeIntegrationNudge,
  CommandFormatMigrationNudge,
  FolderTrustDialog,
  useArenaCommand,
  UIActionsContext,
  useUIActions,
  useIdeTrustListener,
  useProviderUpdates,
  UIStateContext,
  useUIState,
  initialExtensionUpdatesState,
  extensionUpdatesReducer,
  BtwMessage,
  useThoughtExpanded,
  ThoughtExpandedProvider,
  ToolDetailsExpandedProvider,
  hyperlinkAtCell,
  getScreenBuffer,
  HistoryItemDisplay,
  SessionPicker
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
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
