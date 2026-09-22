// Force strict mode and setup for ESM
"use strict";
import {
  ICON,
  SCREEN_READER_MODEL_PREFIX,
  SCREEN_READER_USER_PREFIX,
  SHELL_COMMAND_NAME,
  SHELL_NAME,
  STATUS_INDICATOR_WIDTH,
  ToolElapsedTime,
  ToolStatusIndicator,
  isCollapsibleTool,
  wrapAnsi
} from "./chunk-UOWURAPY.js";
import {
  disableMouseEvents,
  enableMouseEvents,
  useKeypress,
  useKeypressContext
} from "./chunk-CGGQFT4L.js";
import {
  INLINE_CODE_SPAN_PATTERN_SOURCE,
  mergeInlineMathMatches,
  readInlineMathSpanAt,
  unescapeMarkdownBeforeMath,
  unescapeMarkdownDollars
} from "./chunk-2XC3CR4F.js";
import {
  formatDuration,
  formatTokenCount
} from "./chunk-WEUQIY3Q.js";
import {
  MINIMUM_MAX_HEIGHT,
  MaxSizedBox
} from "./chunk-XYAB5R6E.js";
import {
  theme
} from "./chunk-3NHJLWOD.js";
import {
  require_jsx_runtime
} from "./chunk-SV5PQVQE.js";
import {
  Box_default,
  Text,
  use_is_screen_reader_enabled_default,
  use_stdin_default,
  use_stdout_default
} from "./chunk-ZTBP4SFC.js";
import {
  require_react
} from "./chunk-5QWWOFGG.js";
import {
  markKittyImageWritten,
  prepareInlineTerminalImage,
  renderMermaidImageAsync,
  renderTerminalImage,
  wasKittyImageWritten
} from "./chunk-TS4JJ7NN.js";
import {
  formatInlineImageOverflow
} from "./chunk-U3MTHCJF.js";
import {
  resolveColor,
  themeManager
} from "./chunk-S7BE3FMA.js";
import {
  cpLen,
  cpSlice,
  escapeAnsiCtrlCodes,
  getCachedStringWidth,
  sanitizeMultilineForDisplay,
  sanitizeTerminalText,
  stripUnsafeCharacters,
  toCodePoints,
  truncateToWidth
} from "./chunk-47ECGEJC.js";
import {
  stringWidth
} from "./chunk-2MIN6GRR.js";
import {
  require_source
} from "./chunk-57OAHC2Y.js";
import {
  localizeToolDisplayName,
  t
} from "./chunk-POMFSBEC.js";
import {
  IdeClient,
  ShellExecutionService,
  allowEditorTypeInSandbox,
  buildHumanReadableRuleLabel,
  getEditorExecutable,
  getExternalEditorCommand,
  isValidEditorType
} from "./chunk-MRTRBONQ.js";
import {
  stripAnsi
} from "./chunk-TWPJO254.js";
import {
  formatMemoryUsage
} from "./chunk-CHEIIBT3.js";
import {
  sanitizeForOsc,
  supportsHyperlinks,
  wrapForMultiplexer
} from "./chunk-6DB6UHY3.js";
import {
  MAIN_SOURCE,
  formatVisionBridgeNoticeDisplay,
  isVisionBridgeNoticeDisplay,
  uiTelemetryService
} from "./chunk-KKGSJZWK.js";
import {
  isTerminalImageDisplay
} from "./chunk-VPGRGNNH.js";
import {
  ToolDisplayNames,
  ToolNames,
  ToolNamesMigration
} from "./chunk-ERIBG3BX.js";
import {
  createDebugLogger,
  escapePath,
  unescapePath
} from "./chunk-ZYDMQCQP.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name,
  __toESM
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/ui/contexts/SettingsContext.tsx
init_esbuild_shims();
var import_react = __toESM(require_react(), 1);
var SettingsContext = import_react.default.createContext(
  void 0
);
var useSettings = /* @__PURE__ */ __name(() => {
  const context = (0, import_react.useContext)(SettingsContext);
  if (context === void 0) {
    throw new Error("useSettings must be used within a SettingsProvider");
  }
  return context;
}, "useSettings");

// packages/cli/src/ui/components/shared/ErrorBoundary.tsx
init_esbuild_shims();
var import_react2 = __toESM(require_react(), 1);
var import_jsx_runtime = __toESM(require_jsx_runtime(), 1);
function normalizeError(error) {
  if (error instanceof Error) {
    return error;
  }
  return new Error(String(error));
}
__name(normalizeError, "normalizeError");
var lastRenderError;
function consumeLastRenderError() {
  const err = lastRenderError;
  lastRenderError = void 0;
  return err;
}
__name(consumeLastRenderError, "consumeLastRenderError");
var ErrorBoundary = class extends import_react2.Component {
  static {
    __name(this, "ErrorBoundary");
  }
  state = { error: null };
  static getDerivedStateFromError(error) {
    return { error: normalizeError(error) };
  }
  componentDidCatch(error, info) {
    const normalized = normalizeError(error);
    if (this.props.recordForExitEcho) {
      lastRenderError = normalized;
    }
    this.props.onError?.(normalized, info);
  }
  reset = /* @__PURE__ */ __name(() => {
    this.setState({ error: null });
  }, "reset");
  render() {
    const { error } = this.state;
    if (error) {
      if (this.props.fallback) {
        return this.props.fallback(error, this.reset);
      }
      return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Box_default, { flexDirection: "column", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Text, { color: theme.status.error, bold: true, children: "Something went wrong while rendering." }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Text, { color: theme.text.secondary, children: sanitizeTerminalText(error.message) })
      ] });
    }
    return this.props.children;
  }
};

// packages/cli/src/ui/contexts/SessionContext.tsx
init_esbuild_shims();
var import_react3 = __toESM(require_react(), 1);
var import_jsx_runtime2 = __toESM(require_jsx_runtime(), 1);
var EMPTY_SKILL_METRICS = {
  totalCalls: 0,
  totalSuccess: 0,
  totalFail: 0,
  byName: {}
};
function areModelMetricsCoreEqual(a, b) {
  if (a.api.totalRequests !== b.api.totalRequests || a.api.totalErrors !== b.api.totalErrors || a.api.totalLatencyMs !== b.api.totalLatencyMs) {
    return false;
  }
  if (a.tokens.prompt !== b.tokens.prompt || a.tokens.candidates !== b.tokens.candidates || a.tokens.total !== b.tokens.total || a.tokens.cached !== b.tokens.cached || a.tokens.thoughts !== b.tokens.thoughts) {
    return false;
  }
  return true;
}
__name(areModelMetricsCoreEqual, "areModelMetricsCoreEqual");
function areModelMetricsEqual(a, b) {
  if (!areModelMetricsCoreEqual(a, b)) return false;
  const aKeys = Object.keys(a.bySource);
  const bKeys = Object.keys(b.bySource);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    const aSource = a.bySource[key];
    const bSource = b.bySource[key];
    if (!bSource || !areModelMetricsCoreEqual(aSource, bSource)) {
      return false;
    }
  }
  return true;
}
__name(areModelMetricsEqual, "areModelMetricsEqual");
function areToolCallStatsEqual(a, b) {
  if (a.count !== b.count || a.success !== b.success || a.fail !== b.fail || a.durationMs !== b.durationMs) {
    return false;
  }
  if (a.decisions["accept" /* ACCEPT */] !== b.decisions["accept" /* ACCEPT */] || a.decisions["reject" /* REJECT */] !== b.decisions["reject" /* REJECT */] || a.decisions["modify" /* MODIFY */] !== b.decisions["modify" /* MODIFY */] || a.decisions["auto_accept" /* AUTO_ACCEPT */] !== b.decisions["auto_accept" /* AUTO_ACCEPT */]) {
    return false;
  }
  return true;
}
__name(areToolCallStatsEqual, "areToolCallStatsEqual");
function areSkillCallStatsEqual(a, b) {
  return a.count === b.count && a.success === b.success && a.fail === b.fail;
}
__name(areSkillCallStatsEqual, "areSkillCallStatsEqual");
function areSkillMetricsEqual(a, b) {
  if (a.totalCalls !== b.totalCalls || a.totalSuccess !== b.totalSuccess || a.totalFail !== b.totalFail) {
    return false;
  }
  const aKeys = Object.keys(a.byName);
  const bKeys = Object.keys(b.byName);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    const skillA = a.byName[key];
    const skillB = b.byName[key];
    if (!skillB || !areSkillCallStatsEqual(skillA, skillB)) {
      return false;
    }
  }
  return true;
}
__name(areSkillMetricsEqual, "areSkillMetricsEqual");
function areGenerationMetricsEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.timedRequests !== b.timedRequests || a.totalTtftMs !== b.totalTtftMs || a.totalGenerationDurationMs !== b.totalGenerationDurationMs || a.totalThroughputOutputTokens !== b.totalThroughputOutputTokens) {
    return false;
  }
  if (a.last === b.last) return true;
  if (!a.last || !b.last) return false;
  return a.last.model === b.last.model && a.last.ttftMs === b.last.ttftMs && a.last.generationDurationMs === b.last.generationDurationMs && a.last.outputTokens === b.last.outputTokens;
}
__name(areGenerationMetricsEqual, "areGenerationMetricsEqual");
function areMetricsEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  if (!areGenerationMetricsEqual(a.generation, b.generation)) {
    return false;
  }
  if (a.files.totalLinesAdded !== b.files.totalLinesAdded || a.files.totalLinesRemoved !== b.files.totalLinesRemoved) {
    return false;
  }
  const toolsA = a.tools;
  const toolsB = b.tools;
  if (toolsA.totalCalls !== toolsB.totalCalls || toolsA.totalSuccess !== toolsB.totalSuccess || toolsA.totalFail !== toolsB.totalFail || toolsA.totalDurationMs !== toolsB.totalDurationMs) {
    return false;
  }
  if (toolsA.totalDecisions["accept" /* ACCEPT */] !== toolsB.totalDecisions["accept" /* ACCEPT */] || toolsA.totalDecisions["reject" /* REJECT */] !== toolsB.totalDecisions["reject" /* REJECT */] || toolsA.totalDecisions["modify" /* MODIFY */] !== toolsB.totalDecisions["modify" /* MODIFY */] || toolsA.totalDecisions["auto_accept" /* AUTO_ACCEPT */] !== toolsB.totalDecisions["auto_accept" /* AUTO_ACCEPT */]) {
    return false;
  }
  const toolsByNameAKeys = Object.keys(toolsA.byName);
  const toolsByNameBKeys = Object.keys(toolsB.byName);
  if (toolsByNameAKeys.length !== toolsByNameBKeys.length) return false;
  for (const key of toolsByNameAKeys) {
    const toolA = toolsA.byName[key];
    const toolB = toolsB.byName[key];
    if (!toolB || !areToolCallStatsEqual(toolA, toolB)) {
      return false;
    }
  }
  if (!areSkillMetricsEqual(
    a.skills ?? EMPTY_SKILL_METRICS,
    b.skills ?? EMPTY_SKILL_METRICS
  )) {
    return false;
  }
  const modelsAKeys = Object.keys(a.models);
  const modelsBKeys = Object.keys(b.models);
  if (modelsAKeys.length !== modelsBKeys.length) return false;
  for (const key of modelsAKeys) {
    if (!b.models[key] || !areModelMetricsEqual(a.models[key], b.models[key])) {
      return false;
    }
  }
  return true;
}
__name(areMetricsEqual, "areMetricsEqual");
function cloneSessionMetrics(metrics) {
  return {
    models: Object.fromEntries(
      Object.entries(metrics.models).map(([name, model]) => [
        name,
        {
          api: { ...model.api },
          tokens: { ...model.tokens },
          bySource: Object.fromEntries(
            Object.entries(model.bySource).map(([source, sourceMetrics]) => [
              source,
              {
                api: { ...sourceMetrics.api },
                tokens: { ...sourceMetrics.tokens }
              }
            ])
          )
        }
      ])
    ),
    ...metrics.generation ? {
      generation: {
        timedRequests: metrics.generation.timedRequests,
        totalTtftMs: metrics.generation.totalTtftMs,
        totalGenerationDurationMs: metrics.generation.totalGenerationDurationMs,
        totalThroughputOutputTokens: metrics.generation.totalThroughputOutputTokens,
        ...metrics.generation.last ? { last: { ...metrics.generation.last } } : {}
      }
    } : {},
    tools: {
      totalCalls: metrics.tools.totalCalls,
      totalSuccess: metrics.tools.totalSuccess,
      totalFail: metrics.tools.totalFail,
      totalDurationMs: metrics.tools.totalDurationMs,
      totalDecisions: { ...metrics.tools.totalDecisions },
      byName: Object.fromEntries(
        Object.entries(metrics.tools.byName).map(([name, stats]) => [
          name,
          {
            count: stats.count,
            success: stats.success,
            fail: stats.fail,
            durationMs: stats.durationMs,
            decisions: { ...stats.decisions }
          }
        ])
      )
    },
    files: {
      totalLinesAdded: metrics.files.totalLinesAdded,
      totalLinesRemoved: metrics.files.totalLinesRemoved
    },
    ...metrics.skills ? {
      skills: {
        totalCalls: metrics.skills.totalCalls,
        totalSuccess: metrics.skills.totalSuccess,
        totalFail: metrics.skills.totalFail,
        byName: Object.fromEntries(
          Object.entries(metrics.skills.byName).map(([name, stats]) => [
            name,
            {
              count: stats.count,
              success: stats.success,
              fail: stats.fail
            }
          ])
        )
      }
    } : {}
  };
}
__name(cloneSessionMetrics, "cloneSessionMetrics");
function getMetricsForDisplay(sessionId) {
  return cloneSessionMetrics(
    sessionId ? uiTelemetryService.getMetricsForSession(sessionId) : uiTelemetryService.getMetrics()
  );
}
__name(getMetricsForDisplay, "getMetricsForDisplay");
var SessionStatsContext = (0, import_react3.createContext)(
  void 0
);
var createDefaultStats = /* @__PURE__ */ __name((sessionId = "") => ({
  sessionId,
  sessionStartTime: /* @__PURE__ */ new Date(),
  metrics: getMetricsForDisplay(sessionId),
  lastPromptTokenCount: 0,
  promptCount: 0
}), "createDefaultStats");
var SessionStatsProvider = /* @__PURE__ */ __name(({ sessionId, children }) => {
  const [stats, setStats] = (0, import_react3.useState)(
    () => createDefaultStats(sessionId ?? "")
  );
  (0, import_react3.useEffect)(() => {
    const handleUpdate = /* @__PURE__ */ __name(({
      metrics,
      lastPromptTokenCount
    }) => {
      setStats((prevState) => {
        const nextMetrics = prevState.sessionId ? getMetricsForDisplay(prevState.sessionId) : cloneSessionMetrics(metrics);
        if (prevState.lastPromptTokenCount === lastPromptTokenCount && areMetricsEqual(prevState.metrics, nextMetrics)) {
          return prevState;
        }
        return {
          ...prevState,
          metrics: nextMetrics,
          lastPromptTokenCount
        };
      });
    }, "handleUpdate");
    uiTelemetryService.on("update", handleUpdate);
    handleUpdate({
      metrics: uiTelemetryService.getMetrics(),
      lastPromptTokenCount: uiTelemetryService.getLastPromptTokenCount()
    });
    return () => {
      uiTelemetryService.off("update", handleUpdate);
    };
  }, []);
  const startNewSession = (0, import_react3.useCallback)((sessionId2) => {
    setStats(() => ({
      ...createDefaultStats(sessionId2),
      lastPromptTokenCount: uiTelemetryService.getLastPromptTokenCount()
    }));
  }, []);
  const startNewPrompt = (0, import_react3.useCallback)(() => {
    setStats((prevState) => ({
      ...prevState,
      promptCount: prevState.promptCount + 1
    }));
  }, []);
  const getPromptCount = (0, import_react3.useCallback)(
    () => stats.promptCount,
    [stats.promptCount]
  );
  const seedPromptCount = (0, import_react3.useCallback)((count) => {
    setStats((prevState) => ({
      ...prevState,
      promptCount: Math.max(prevState.promptCount, count)
    }));
  }, []);
  const value = (0, import_react3.useMemo)(
    () => ({
      stats,
      startNewSession,
      startNewPrompt,
      getPromptCount,
      seedPromptCount
    }),
    [stats, startNewSession, startNewPrompt, getPromptCount, seedPromptCount]
  );
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(SessionStatsContext.Provider, { value, children });
}, "SessionStatsProvider");
var useSessionStats = /* @__PURE__ */ __name(() => {
  const context = (0, import_react3.useContext)(SessionStatsContext);
  if (context === void 0) {
    throw new Error(
      "useSessionStats must be used within a SessionStatsProvider"
    );
  }
  return context;
}, "useSessionStats");

// packages/cli/src/ui/hooks/useTerminalSize.ts
init_esbuild_shims();
var import_react4 = __toESM(require_react(), 1);
function getTerminalSize() {
  return {
    columns: process.stdout.columns || 80,
    rows: process.stdout.rows || 24
  };
}
__name(getTerminalSize, "getTerminalSize");
var currentSize = getTerminalSize();
var subscribers = /* @__PURE__ */ new Set();
function handleResize() {
  currentSize = getTerminalSize();
  for (const notify of subscribers) {
    notify(currentSize);
  }
}
__name(handleResize, "handleResize");
function subscribe(callback) {
  if (subscribers.size === 0) {
    currentSize = getTerminalSize();
    process.stdout.on("resize", handleResize);
  }
  subscribers.add(callback);
  return () => {
    subscribers.delete(callback);
    if (subscribers.size === 0) {
      process.stdout.off("resize", handleResize);
    }
  };
}
__name(subscribe, "subscribe");
function useTerminalSize() {
  const [size, setSize] = (0, import_react4.useState)(getTerminalSize);
  (0, import_react4.useEffect)(() => {
    const unsubscribe = subscribe(setSize);
    setSize(currentSize);
    return unsubscribe;
  }, []);
  return size;
}
__name(useTerminalSize, "useTerminalSize");

// packages/cli/src/ui/utils/lowlightLoader.ts
init_esbuild_shims();
var lowlightInstance = null;
var lowlightLoad = null;
var LOWLIGHT_RETRY_COOLDOWN_MS = 3e4;
var lowlightLastFailureAt = 0;
var lowlightError = null;
function getLowlightInstance() {
  return lowlightInstance;
}
__name(getLowlightInstance, "getLowlightInstance");
function isLowlightCoolingDown() {
  return lowlightLastFailureAt > 0 && Date.now() - lowlightLastFailureAt < LOWLIGHT_RETRY_COOLDOWN_MS;
}
__name(isLowlightCoolingDown, "isLowlightCoolingDown");
function loadLowlight() {
  if (lowlightInstance) return Promise.resolve(lowlightInstance);
  if (isLowlightCoolingDown()) {
    return Promise.reject(
      lowlightError ?? new Error("lowlight import previously failed")
    );
  }
  if (lowlightLoad) return lowlightLoad;
  lowlightLoad = import("./lowlight-BTE423KL.js").then((mod) => {
    const instance = mod.createLowlight(mod.common);
    if (typeof instance?.registered !== "function" || typeof instance?.highlight !== "function" || typeof instance?.highlightAuto !== "function") {
      throw new Error(
        "lowlight instance does not match expected API (registered/highlight/highlightAuto)"
      );
    }
    lowlightInstance = instance;
    lowlightLastFailureAt = 0;
    lowlightError = null;
    return lowlightInstance;
  }).catch((err) => {
    lowlightLastFailureAt = Date.now();
    lowlightError = err instanceof Error ? err : new Error(String(err));
    lowlightLoad = null;
    throw err;
  });
  return lowlightLoad;
}
__name(loadLowlight, "loadLowlight");

// packages/cli/src/ui/utils/osc8.ts
init_esbuild_shims();
function osc8Open(url) {
  return wrapForMultiplexer(`\x1B]8;;${sanitizeForOsc(url)}\x07`);
}
__name(osc8Open, "osc8Open");
function osc8Close() {
  return wrapForMultiplexer(`\x1B]8;;\x07`);
}
__name(osc8Close, "osc8Close");
var SAFE_OSC8_SCHEMES = /* @__PURE__ */ new Set([
  "http:",
  "https:",
  "mailto:",
  "ftp:",
  "ftps:",
  "sftp:",
  "ssh:"
]);
function isSafeOscScheme(url) {
  const match = url.match(/^([a-z][a-z0-9+.-]*:)/i);
  if (!match) return false;
  return SAFE_OSC8_SCHEMES.has(match[1].toLowerCase());
}
__name(isSafeOscScheme, "isSafeOscScheme");
var BARE_URL_BREAK_CHARACTERS = String.raw`\u3001-\u3004\u3008-\u3020\u302e-\u3030\u3036-\u3037\u303d-\u303f\uff01-\uff0f\uff1a-\uff20\uff3b-\uff40\uff5b-\uff65\ufe10-\ufe1f\ufe30-\ufe32\ufe35-\ufe6f`;
var BARE_URL_BREAK_PATTERN = new RegExp(`[${BARE_URL_BREAK_CHARACTERS}]`);
function trimTrailingUrlPunctuation(url, nextCharacter = "") {
  let openParen = 0;
  let openBracket = 0;
  let openBrace = 0;
  let closeParen = 0;
  let closeBracket = 0;
  let closeBrace = 0;
  for (let i = 0; i < url.length; i++) {
    const cc = url.charCodeAt(i);
    if (cc === 40) openParen++;
    else if (cc === 91) openBracket++;
    else if (cc === 123) openBrace++;
    else if (cc === 41) closeParen++;
    else if (cc === 93) closeBracket++;
    else if (cc === 125) closeBrace++;
  }
  let end = url.length;
  if (url.charCodeAt(end - 1) === 95 && BARE_URL_BREAK_PATTERN.test(nextCharacter)) {
    end--;
  }
  while (end > 0) {
    const c = url.charCodeAt(end - 1);
    if (c === 46 || c === 44 || c === 59 || c === 58 || c === 33 || c === 63 || c === 39 || c === 34 || c === 96 || c === 62) {
      end--;
      continue;
    }
    if (c === 41 && closeParen > openParen) {
      closeParen--;
      end--;
      continue;
    }
    if (c === 93 && closeBracket > openBracket) {
      closeBracket--;
      end--;
      continue;
    }
    if (c === 125 && closeBrace > openBrace) {
      closeBrace--;
      end--;
      continue;
    }
    break;
  }
  return url.slice(0, end);
}
__name(trimTrailingUrlPunctuation, "trimTrailingUrlPunctuation");
var MD_LINK_PATTERN = String.raw`\[.*?\]\((?:[^()]|\([^()]*\))*\)`;
var MD_LINK_CAPTURE = /^\[(.*?)\]\(((?:[^()]|\([^()]*\))*)\)$/;
var BARE_URL_PATTERN = String.raw`https?:\/\/[^\s${BARE_URL_BREAK_CHARACTERS}]+`;
function shouldWrapMarkdownLink(url, canHyperlink) {
  return canHyperlink && isSafeOscScheme(url) && !/\s/.test(url);
}
__name(shouldWrapMarkdownLink, "shouldWrapMarkdownLink");
var HOST_LIKE_RE = /\b[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)*\.[a-z]{2,}\b/gi;
var IPV4_LIKE_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
function targetHostname(url) {
  try {
    const u = new URL(url);
    if (u.protocol === "mailto:") {
      const at = u.pathname.lastIndexOf("@");
      return at >= 0 ? u.pathname.slice(at + 1).toLowerCase() || void 0 : void 0;
    }
    return u.hostname.toLowerCase() || void 0;
  } catch {
    return void 0;
  }
}
__name(targetHostname, "targetHostname");
function labelMayDeceive(label, url) {
  if (label === url) return false;
  if (/:\/\//.test(label) || /^[a-z][a-z0-9+.-]*:/i.test(label.trim())) {
    return true;
  }
  const lower = label.toLowerCase();
  const labelHosts = [
    ...lower.match(HOST_LIKE_RE) ?? [],
    ...lower.match(IPV4_LIKE_RE) ?? []
  ];
  if (labelHosts.length === 0) return false;
  const target = targetHostname(url);
  if (!target) return true;
  return labelHosts.some((h) => h !== target);
}
__name(labelMayDeceive, "labelMayDeceive");

// packages/cli/src/ui/contexts/TerminalOutputContext.tsx
init_esbuild_shims();
var import_react5 = __toESM(require_react(), 1);
var import_jsx_runtime3 = __toESM(require_jsx_runtime(), 1);
var defaultWriteRaw = /* @__PURE__ */ __name((data) => {
  process.stdout.write(data);
}, "defaultWriteRaw");
var TerminalOutputContext = (0, import_react5.createContext)(defaultWriteRaw);
var TerminalOutputProvider = /* @__PURE__ */ __name(({ value, children }) => /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(TerminalOutputContext.Provider, { value, children }), "TerminalOutputProvider");
function useTerminalOutput() {
  return (0, import_react5.useContext)(TerminalOutputContext);
}
__name(useTerminalOutput, "useTerminalOutput");

// packages/cli/src/ui/contexts/RenderModeContext.tsx
init_esbuild_shims();
var import_react6 = __toESM(require_react(), 1);
var RenderModeContext = import_react6.default.createContext({
  renderMode: "render",
  setRenderMode: /* @__PURE__ */ __name(() => void 0, "setRenderMode")
});
var RenderModeProvider = RenderModeContext.Provider;
function useRenderMode() {
  return import_react6.default.useContext(RenderModeContext);
}
__name(useRenderMode, "useRenderMode");

// packages/cli/src/ui/utils/displayUtils.ts
init_esbuild_shims();
function getArenaStatusLabel(status) {
  switch (status) {
    case "idle" /* IDLE */:
      return { icon: "\u2713", text: "Idle", color: theme.status.success };
    case "completed" /* COMPLETED */:
      return { icon: "\u2713", text: "Done", color: theme.status.success };
    case "cancelled" /* CANCELLED */:
      return { icon: "\u2298", text: "Cancelled", color: theme.status.warning };
    case "failed" /* FAILED */:
      return { icon: "\u2717", text: "Failed", color: theme.status.error };
    case "running" /* RUNNING */:
      return {
        icon: ICON.CIRCLE_EMPTY,
        text: "Running",
        color: theme.text.secondary
      };
    case "initializing" /* INITIALIZING */:
      return {
        icon: ICON.CIRCLE_EMPTY,
        text: "Initializing",
        color: theme.text.secondary
      };
    default:
      return {
        icon: ICON.CIRCLE_EMPTY,
        text: status,
        color: theme.text.secondary
      };
  }
}
__name(getArenaStatusLabel, "getArenaStatusLabel");
var TOOL_SUCCESS_RATE_HIGH = 95;
var TOOL_SUCCESS_RATE_MEDIUM = 85;
var USER_AGREEMENT_RATE_HIGH = 75;
var USER_AGREEMENT_RATE_MEDIUM = 45;
var getStatusColor = /* @__PURE__ */ __name((value, thresholds, options = {}) => {
  if (value >= thresholds.green) {
    return theme.status.success;
  }
  if (value >= thresholds.yellow) {
    return theme.status.warning;
  }
  if (thresholds.red != null && value >= thresholds.red) {
    return theme.status.error;
  }
  return options.defaultColor ?? theme.status.error;
}, "getStatusColor");
function formatDuration2(ms) {
  const totalSeconds = Math.round(ms / 1e3);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}
__name(formatDuration2, "formatDuration");

// packages/cli/src/config/keyBindings.ts
init_esbuild_shims();
var Command = /* @__PURE__ */ ((Command2) => {
  Command2["RETURN"] = "return";
  Command2["ESCAPE"] = "escape";
  Command2["HOME"] = "home";
  Command2["END"] = "end";
  Command2["KILL_LINE_RIGHT"] = "killLineRight";
  Command2["KILL_LINE_LEFT"] = "killLineLeft";
  Command2["CLEAR_INPUT"] = "clearInput";
  Command2["DELETE_WORD_BACKWARD"] = "deleteWordBackward";
  Command2["CLEAR_SCREEN"] = "clearScreen";
  Command2["HISTORY_UP"] = "historyUp";
  Command2["HISTORY_DOWN"] = "historyDown";
  Command2["NAVIGATION_UP"] = "navigationUp";
  Command2["NAVIGATION_DOWN"] = "navigationDown";
  Command2["SELECTION_UP"] = "selectionUp";
  Command2["SELECTION_DOWN"] = "selectionDown";
  Command2["ACCEPT_SUGGESTION"] = "acceptSuggestion";
  Command2["COMPLETION_UP"] = "completionUp";
  Command2["COMPLETION_DOWN"] = "completionDown";
  Command2["COMPLETION_TAB_LEFT"] = "completionTabLeft";
  Command2["COMPLETION_TAB_RIGHT"] = "completionTabRight";
  Command2["SUBMIT"] = "submit";
  Command2["QUEUE_MESSAGE"] = "queueMessage";
  Command2["NEWLINE"] = "newline";
  Command2["VOICE_PUSH_TO_TALK"] = "voicePushToTalk";
  Command2["OPEN_EXTERNAL_EDITOR"] = "openExternalEditor";
  Command2["PASTE_CLIPBOARD_IMAGE"] = "pasteClipboardImage";
  Command2["TOGGLE_TOOL_DESCRIPTIONS"] = "toggleToolDescriptions";
  Command2["TOGGLE_IDE_CONTEXT_DETAIL"] = "toggleIDEContextDetail";
  Command2["QUIT"] = "quit";
  Command2["EXIT"] = "exit";
  Command2["SHOW_MORE_LINES"] = "showMoreLines";
  Command2["RETRY_LAST"] = "retryLast";
  Command2["TOGGLE_RENDER_MODE"] = "toggleRenderMode";
  Command2["PROMOTE_SHELL_TO_BACKGROUND"] = "promoteShellToBackground";
  Command2["REVERSE_SEARCH"] = "reverseSearch";
  Command2["SUBMIT_REVERSE_SEARCH"] = "submitReverseSearch";
  Command2["ACCEPT_SUGGESTION_REVERSE_SEARCH"] = "acceptSuggestionReverseSearch";
  Command2["TOGGLE_SHELL_INPUT_FOCUS"] = "toggleShellInputFocus";
  Command2["EXPAND_SUGGESTION"] = "expandSuggestion";
  Command2["COLLAPSE_SUGGESTION"] = "collapseSuggestion";
  Command2["TOGGLE_THINKING_EXPANDED"] = "toggleThinkingExpanded";
  Command2["SCROLL_UP"] = "scrollUp";
  Command2["SCROLL_DOWN"] = "scrollDown";
  Command2["PAGE_UP"] = "pageUp";
  Command2["PAGE_DOWN"] = "pageDown";
  Command2["SCROLL_HOME"] = "scrollHome";
  Command2["SCROLL_END"] = "scrollEnd";
  return Command2;
})(Command || {});
var defaultKeyBindings = {
  // Basic bindings
  ["return" /* RETURN */]: [{ key: "return" }],
  ["escape" /* ESCAPE */]: [{ key: "escape" }],
  // Cursor movement
  ["home" /* HOME */]: [{ key: "a", ctrl: true }],
  ["end" /* END */]: [{ key: "e", ctrl: true }],
  // Text deletion
  ["killLineRight" /* KILL_LINE_RIGHT */]: [{ key: "k", ctrl: true }],
  ["killLineLeft" /* KILL_LINE_LEFT */]: [{ key: "u", ctrl: true }],
  ["clearInput" /* CLEAR_INPUT */]: [{ key: "c", ctrl: true, shift: false }],
  // Added command (meta/alt/option) for mac compatibility
  ["deleteWordBackward" /* DELETE_WORD_BACKWARD */]: [
    { key: "backspace", ctrl: true },
    { key: "backspace", command: true },
    // MinTTY (Git Bash on Windows) emits the byte \x1f (ASCII Unit
    // Separator, rendered as "^_" by `cat -v`) for Ctrl+Backspace under
    // its standard Ctrl-modifies-meta-keys convention. The same byte is
    // the historical Ctrl-mapping of the Unit Separator on traditional
    // ANSI/VT terminals (Ctrl+_ and Ctrl+/ also emit it), but qwen-code
    // doesn't bind those keystrokes elsewhere so this entry is additive
    // and non-conflicting on every platform.
    { sequence: "" }
  ],
  // Screen control
  ["clearScreen" /* CLEAR_SCREEN */]: [{ key: "l", ctrl: true }],
  // History navigation
  ["historyUp" /* HISTORY_UP */]: [{ key: "p", ctrl: true }],
  ["historyDown" /* HISTORY_DOWN */]: [{ key: "n", ctrl: true }],
  ["navigationUp" /* NAVIGATION_UP */]: [{ key: "up", shift: false }],
  ["navigationDown" /* NAVIGATION_DOWN */]: [{ key: "down", shift: false }],
  // Selection-list nav: arrows + k/j + Ctrl+P/Ctrl+N
  // ctrl: false on bare k/j skips Ctrl+K and Ctrl+J
  ["selectionUp" /* SELECTION_UP */]: [
    { key: "up", shift: false },
    { key: "k", ctrl: false },
    { key: "p", ctrl: true }
  ],
  ["selectionDown" /* SELECTION_DOWN */]: [
    { key: "down", shift: false },
    { key: "j", ctrl: false },
    { key: "n", ctrl: true }
  ],
  // Auto-completion
  ["acceptSuggestion" /* ACCEPT_SUGGESTION */]: [
    { key: "tab" },
    { key: "return", ctrl: false, shift: false }
  ],
  // Completion navigation: arrows + readline/Vim-style Ctrl+P/Ctrl+N
  ["completionUp" /* COMPLETION_UP */]: [
    { key: "up", shift: false },
    { key: "p", ctrl: true }
  ],
  ["completionDown" /* COMPLETION_DOWN */]: [
    { key: "down", shift: false },
    { key: "n", ctrl: true }
  ],
  // Completion category tab switching (for the tabbed @ completion UI).
  // Bound to the BARE arrow keys: Ctrl+←/→ was the original binding but many
  // terminals intercept it for word-jump, and on macOS the system claims it
  // for Mission Control, so the documented gesture was unreachable for most
  // users (#8069).
  //
  // Tradeoff, accepted deliberately: while the `@` category tabs are visible,
  // the bare arrows no longer move the caret in the input buffer — press Esc
  // to dismiss the menu first. InputPrompt only renders and handles the tabs
  // when they own the arrows, so search and attachment navigation keep their
  // normal behavior.
  //
  // Modifiers are pinned false so Alt/Option+arrow word movement and any
  // Ctrl+arrow terminal binding fall through untouched.
  ["completionTabLeft" /* COMPLETION_TAB_LEFT */]: [
    { key: "left", shift: false, ctrl: false, meta: false }
  ],
  ["completionTabRight" /* COMPLETION_TAB_RIGHT */]: [
    { key: "right", shift: false, ctrl: false, meta: false }
  ],
  // Text input
  // Must also exclude shift to allow shift+enter for newline
  ["submit" /* SUBMIT */]: [
    {
      key: "return",
      ctrl: false,
      command: false,
      paste: false,
      shift: false
    }
  ],
  ["queueMessage" /* QUEUE_MESSAGE */]: [
    { key: "q", ctrl: true, command: false, shift: false, paste: false }
  ],
  // Split into multiple data-driven bindings
  // Now also includes shift+enter for multi-line input
  ["newline" /* NEWLINE */]: [
    { key: "return", ctrl: true },
    { key: "return", command: true },
    { key: "return", paste: true },
    { key: "return", shift: true },
    { key: "j", ctrl: true }
  ],
  ["voicePushToTalk" /* VOICE_PUSH_TO_TALK */]: [{ key: "space", ctrl: false, meta: false }],
  // External tools
  ["openExternalEditor" /* OPEN_EXTERNAL_EDITOR */]: [
    { key: "x", ctrl: true },
    { sequence: "", ctrl: true }
  ],
  ["pasteClipboardImage" /* PASTE_CLIPBOARD_IMAGE */]: process.platform === "win32" ? [
    { key: "v", command: true },
    { key: "v", meta: true }
  ] : [
    { key: "v", ctrl: true },
    { key: "v", command: true }
  ],
  // App level bindings
  ["toggleToolDescriptions" /* TOGGLE_TOOL_DESCRIPTIONS */]: [{ key: "t", ctrl: true }],
  ["toggleIDEContextDetail" /* TOGGLE_IDE_CONTEXT_DETAIL */]: [{ key: "g", ctrl: true }],
  ["quit" /* QUIT */]: [{ key: "c", ctrl: true, shift: false }],
  ["exit" /* EXIT */]: [{ key: "d", ctrl: true }],
  ["showMoreLines" /* SHOW_MORE_LINES */]: [{ key: "s", ctrl: true }],
  ["retryLast" /* RETRY_LAST */]: [{ key: "y", ctrl: true }],
  ["toggleRenderMode" /* TOGGLE_RENDER_MODE */]: [{ key: "m", meta: true }],
  ["promoteShellToBackground" /* PROMOTE_SHELL_TO_BACKGROUND */]: [{ key: "b", ctrl: true }],
  // Shell commands
  ["reverseSearch" /* REVERSE_SEARCH */]: [{ key: "r", ctrl: true }],
  // Note: original logic ONLY checked ctrl=false, ignored meta/shift/paste
  ["submitReverseSearch" /* SUBMIT_REVERSE_SEARCH */]: [{ key: "return", ctrl: false }],
  ["acceptSuggestionReverseSearch" /* ACCEPT_SUGGESTION_REVERSE_SEARCH */]: [{ key: "tab" }],
  ["toggleShellInputFocus" /* TOGGLE_SHELL_INPUT_FOCUS */]: [{ key: "f", ctrl: true }],
  // Suggestion expansion
  ["expandSuggestion" /* EXPAND_SUGGESTION */]: [{ key: "right" }],
  ["collapseSuggestion" /* COLLAPSE_SUGGESTION */]: [{ key: "left" }],
  // Thinking expansion (Ctrl+O primary, Alt+T legacy)
  ["toggleThinkingExpanded" /* TOGGLE_THINKING_EXPANDED */]: [
    { key: "o", ctrl: true },
    { key: "t", meta: true }
  ],
  // Scroll commands
  ["scrollUp" /* SCROLL_UP */]: [{ key: "up", shift: true }],
  ["scrollDown" /* SCROLL_DOWN */]: [{ key: "down", shift: true }],
  ["pageUp" /* PAGE_UP */]: [{ key: "pageup" }],
  ["pageDown" /* PAGE_DOWN */]: [{ key: "pagedown" }],
  ["scrollHome" /* SCROLL_HOME */]: [{ key: "home", ctrl: true }],
  ["scrollEnd" /* SCROLL_END */]: [{ key: "end", ctrl: true }]
};

// packages/cli/src/ui/keyMatchers.ts
init_esbuild_shims();
function matchKeyBinding(keyBinding, key) {
  let keyMatches = false;
  if (keyBinding.key !== void 0) {
    keyMatches = keyBinding.key === key.name;
  } else if (keyBinding.sequence !== void 0) {
    keyMatches = keyBinding.sequence === key.sequence;
  } else {
    return false;
  }
  if (!keyMatches) {
    return false;
  }
  if (keyBinding.ctrl !== void 0 && !!key.ctrl !== keyBinding.ctrl) {
    return false;
  }
  if (keyBinding.shift !== void 0 && !!key.shift !== keyBinding.shift) {
    return false;
  }
  if (keyBinding.command !== void 0 && !!key.meta !== keyBinding.command) {
    return false;
  }
  if (keyBinding.paste !== void 0 && !!key.paste !== keyBinding.paste) {
    return false;
  }
  if (keyBinding.meta !== void 0 && !!key.meta !== keyBinding.meta) {
    return false;
  }
  return true;
}
__name(matchKeyBinding, "matchKeyBinding");
function matchCommand(command, key, config = defaultKeyBindings) {
  const bindings = config[command];
  return bindings.some((binding) => matchKeyBinding(binding, key));
}
__name(matchCommand, "matchCommand");
function createKeyMatchers(config = defaultKeyBindings) {
  const matchers = {};
  for (const command of Object.values(Command)) {
    matchers[command] = (key) => matchCommand(command, key, config);
  }
  return matchers;
}
__name(createKeyMatchers, "createKeyMatchers");
var keyMatchers = createKeyMatchers(defaultKeyBindings);

// packages/cli/src/ui/contexts/VirtualViewportContext.tsx
init_esbuild_shims();
var import_react7 = __toESM(require_react(), 1);
var VirtualViewportContext = (0, import_react7.createContext)(
  void 0
);
function useVirtualViewport(fallback) {
  return (0, import_react7.useContext)(VirtualViewportContext) ?? fallback ?? false;
}
__name(useVirtualViewport, "useVirtualViewport");

// packages/cli/src/ui/context-menu/ContextMenuContext.tsx
init_esbuild_shims();
var import_react8 = __toESM(require_react(), 1);
var import_jsx_runtime4 = __toESM(require_jsx_runtime(), 1);
var ContextMenuContext = (0, import_react8.createContext)({
  menu: null,
  selectedIndex: 0,
  openMenu: /* @__PURE__ */ __name(() => {
  }, "openMenu"),
  closeMenu: /* @__PURE__ */ __name(() => {
  }, "closeMenu"),
  setSelectedIndex: /* @__PURE__ */ __name(() => {
  }, "setSelectedIndex"),
  executeIndex: /* @__PURE__ */ __name(() => {
  }, "executeIndex")
});
var ContextMenuProvider = /* @__PURE__ */ __name(({ children, onMenuChange }) => {
  const [menu, setMenu] = (0, import_react8.useState)(null);
  const [selectedIndex, setSelectedIndexState] = (0, import_react8.useState)(0);
  const menuRef = (0, import_react8.useRef)(null);
  menuRef.current = menu;
  const openMenu = (0, import_react8.useCallback)(
    (items, position) => {
      if (items.length === 0) return;
      setMenu({ items, position });
      setSelectedIndexState(0);
    },
    []
  );
  const closeMenu = (0, import_react8.useCallback)(() => {
    menuRef.current = null;
    setMenu(null);
  }, []);
  (0, import_react8.useEffect)(() => {
    onMenuChange?.(menu !== null);
  }, [menu, onMenuChange]);
  const setSelectedIndex = (0, import_react8.useCallback)((index) => {
    setSelectedIndexState(index);
  }, []);
  const executeIndex = (0, import_react8.useCallback)((index) => {
    const current = menuRef.current;
    menuRef.current = null;
    setMenu(null);
    current?.items[index]?.onSelect();
  }, []);
  const value = (0, import_react8.useMemo)(
    () => ({
      menu,
      selectedIndex,
      openMenu,
      closeMenu,
      setSelectedIndex,
      executeIndex
    }),
    [menu, selectedIndex, openMenu, closeMenu, setSelectedIndex, executeIndex]
  );
  return /* @__PURE__ */ (0, import_jsx_runtime4.jsx)(ContextMenuContext.Provider, { value, children });
}, "ContextMenuProvider");
function useContextMenu() {
  return (0, import_react8.useContext)(ContextMenuContext);
}
__name(useContextMenu, "useContextMenu");
function contextMenuSize(items) {
  const longest = items.reduce(
    (max, item) => Math.max(max, item.label.length),
    0
  );
  return { width: longest + 4, height: items.length + 2 };
}
__name(contextMenuSize, "contextMenuSize");
function clampMenuPosition(desired, size, terminalColumns, terminalRows) {
  return {
    x: Math.max(0, Math.min(desired.x, terminalColumns - size.width)),
    y: Math.max(0, Math.min(desired.y, terminalRows - size.height))
  };
}
__name(clampMenuPosition, "clampMenuPosition");

// packages/cli/src/ui/components/shared/text-buffer.ts
init_esbuild_shims();
var import_react9 = __toESM(require_react(), 1);
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import pathMod from "node:path";

// packages/cli/src/ui/components/shared/vim-buffer-actions.ts
init_esbuild_shims();

// packages/cli/src/utils/checks.ts
init_esbuild_shims();
function assumeExhaustive(_value) {
}
__name(assumeExhaustive, "assumeExhaustive");
function checkExhaustive(value, msg = `unexpected value ${value}!`) {
  assumeExhaustive(value);
  throw new Error(msg);
}
__name(checkExhaustive, "checkExhaustive");

// packages/cli/src/ui/components/shared/vim-buffer-actions.ts
function isAtEndOfBaseWord(lineCodePoints, col) {
  if (!isWordCharStrict(lineCodePoints[col])) return false;
  let i = col + 1;
  while (i < lineCodePoints.length && isCombiningMark(lineCodePoints[i])) {
    i++;
  }
  return i >= lineCodePoints.length || !isWordCharStrict(lineCodePoints[i]);
}
__name(isAtEndOfBaseWord, "isAtEndOfBaseWord");
function handleVimAction(state, action) {
  const { lines, cursorRow, cursorCol } = state;
  switch (action.type) {
    case "vim_delete_word_forward":
    case "vim_change_word_forward": {
      const { count } = action.payload;
      let endRow = cursorRow;
      let endCol = cursorCol;
      for (let i = 0; i < count; i++) {
        const nextWord = findNextWordAcrossLines(lines, endRow, endCol, true);
        if (nextWord) {
          endRow = nextWord.row;
          endCol = nextWord.col;
        } else {
          const currentLine = lines[endRow] || "";
          const wordEnd = findWordEndInLine(currentLine, endCol);
          if (wordEnd !== null) {
            endCol = wordEnd + 1;
          } else {
            endCol = cpLen(currentLine);
          }
          break;
        }
      }
      if (endRow !== cursorRow || endCol !== cursorCol) {
        const nextState = pushUndo(state);
        return replaceRangeInternal(
          nextState,
          cursorRow,
          cursorCol,
          endRow,
          endCol,
          ""
        );
      }
      return state;
    }
    case "vim_delete_word_backward":
    case "vim_change_word_backward": {
      const { count } = action.payload;
      let startRow = cursorRow;
      let startCol = cursorCol;
      for (let i = 0; i < count; i++) {
        const prevWord = findPrevWordAcrossLines(lines, startRow, startCol);
        if (prevWord) {
          startRow = prevWord.row;
          startCol = prevWord.col;
        } else {
          break;
        }
      }
      if (startRow !== cursorRow || startCol !== cursorCol) {
        const nextState = pushUndo(state);
        return replaceRangeInternal(
          nextState,
          startRow,
          startCol,
          cursorRow,
          cursorCol,
          ""
        );
      }
      return state;
    }
    case "vim_delete_word_end":
    case "vim_change_word_end": {
      const { count } = action.payload;
      let row = cursorRow;
      let col = cursorCol;
      let endRow = cursorRow;
      let endCol = cursorCol;
      for (let i = 0; i < count; i++) {
        const wordEnd = findNextWordAcrossLines(lines, row, col, false);
        if (wordEnd) {
          endRow = wordEnd.row;
          endCol = wordEnd.col + 1;
          if (i < count - 1) {
            const nextWord = findNextWordAcrossLines(
              lines,
              wordEnd.row,
              wordEnd.col + 1,
              true
            );
            if (nextWord) {
              row = nextWord.row;
              col = nextWord.col;
            } else {
              break;
            }
          }
        } else {
          break;
        }
      }
      if (endRow < lines.length) {
        const lineLen = cpLen(lines[endRow] || "");
        endCol = Math.min(endCol, lineLen);
      }
      if (endRow !== cursorRow || endCol !== cursorCol) {
        const nextState = pushUndo(state);
        return replaceRangeInternal(
          nextState,
          cursorRow,
          cursorCol,
          endRow,
          endCol,
          ""
        );
      }
      return state;
    }
    case "vim_delete_line": {
      const { count } = action.payload;
      if (lines.length === 0) return state;
      const linesToDelete = Math.min(count, lines.length - cursorRow);
      const totalLines = lines.length;
      if (totalLines === 1 || linesToDelete >= totalLines) {
        const nextState2 = pushUndo(state);
        return {
          ...nextState2,
          lines: [""],
          cursorRow: 0,
          cursorCol: 0,
          preferredCol: null
        };
      }
      const nextState = pushUndo(state);
      const newLines = [...nextState.lines];
      newLines.splice(cursorRow, linesToDelete);
      const newCursorRow = Math.min(cursorRow, newLines.length - 1);
      const newCursorCol = 0;
      return {
        ...nextState,
        lines: newLines,
        cursorRow: newCursorRow,
        cursorCol: newCursorCol,
        preferredCol: null
      };
    }
    case "vim_change_line": {
      const { count } = action.payload;
      if (lines.length === 0) return state;
      const linesToChange = Math.min(count, lines.length - cursorRow);
      const nextState = pushUndo(state);
      const { startOffset, endOffset } = getLineRangeOffsets(
        cursorRow,
        linesToChange,
        nextState.lines
      );
      const { startRow, startCol, endRow, endCol } = getPositionFromOffsets(
        startOffset,
        endOffset,
        nextState.lines
      );
      return replaceRangeInternal(
        nextState,
        startRow,
        startCol,
        endRow,
        endCol,
        ""
      );
    }
    case "vim_delete_to_end_of_line":
    case "vim_change_to_end_of_line": {
      const currentLine = lines[cursorRow] || "";
      if (cursorCol < cpLen(currentLine)) {
        const nextState = pushUndo(state);
        return replaceRangeInternal(
          nextState,
          cursorRow,
          cursorCol,
          cursorRow,
          cpLen(currentLine),
          ""
        );
      }
      return state;
    }
    case "vim_change_movement": {
      const { movement, count } = action.payload;
      const totalLines = lines.length;
      switch (movement) {
        case "h": {
          const startCol = Math.max(0, cursorCol - count);
          return replaceRangeInternal(
            pushUndo(state),
            cursorRow,
            startCol,
            cursorRow,
            cursorCol,
            ""
          );
        }
        case "j": {
          const linesToChange = Math.min(count + 1, totalLines - cursorRow);
          if (linesToChange > 0) {
            if (totalLines === 1) {
              const currentLine = state.lines[0] || "";
              return replaceRangeInternal(
                pushUndo(state),
                0,
                0,
                0,
                cpLen(currentLine),
                ""
              );
            } else {
              const nextState = pushUndo(state);
              const { startOffset, endOffset } = getLineRangeOffsets(
                cursorRow,
                linesToChange,
                nextState.lines
              );
              const { startRow, startCol, endRow, endCol } = getPositionFromOffsets(startOffset, endOffset, nextState.lines);
              return replaceRangeInternal(
                nextState,
                startRow,
                startCol,
                endRow,
                endCol,
                ""
              );
            }
          }
          return state;
        }
        case "k": {
          const upLines = Math.min(count + 1, cursorRow + 1);
          if (upLines > 0) {
            if (state.lines.length === 1) {
              const currentLine = state.lines[0] || "";
              return replaceRangeInternal(
                pushUndo(state),
                0,
                0,
                0,
                cpLen(currentLine),
                ""
              );
            } else {
              const startRow = Math.max(0, cursorRow - count);
              const linesToChange = cursorRow - startRow + 1;
              const nextState = pushUndo(state);
              const { startOffset, endOffset } = getLineRangeOffsets(
                startRow,
                linesToChange,
                nextState.lines
              );
              const {
                startRow: newStartRow,
                startCol,
                endRow,
                endCol
              } = getPositionFromOffsets(
                startOffset,
                endOffset,
                nextState.lines
              );
              const resultState = replaceRangeInternal(
                nextState,
                newStartRow,
                startCol,
                endRow,
                endCol,
                ""
              );
              return {
                ...resultState,
                cursorRow: startRow,
                cursorCol: 0
              };
            }
          }
          return state;
        }
        case "l": {
          return replaceRangeInternal(
            pushUndo(state),
            cursorRow,
            cursorCol,
            cursorRow,
            Math.min(cpLen(lines[cursorRow] || ""), cursorCol + count),
            ""
          );
        }
        default:
          return state;
      }
    }
    case "vim_delete_movement": {
      const { movement, count } = action.payload;
      const totalLines = lines.length;
      switch (movement) {
        case "h": {
          const startCol = Math.max(0, cursorCol - count);
          return replaceRangeInternal(
            pushUndo(state),
            cursorRow,
            startCol,
            cursorRow,
            cursorCol,
            ""
          );
        }
        case "j": {
          const linesToDelete = Math.min(count + 1, totalLines - cursorRow);
          if (linesToDelete > 0) {
            if (totalLines === 1) {
              const currentLine = state.lines[0] || "";
              return replaceRangeInternal(
                pushUndo(state),
                0,
                0,
                0,
                cpLen(currentLine),
                ""
              );
            } else {
              const nextState = pushUndo(state);
              const { startOffset, endOffset } = getLineRangeOffsets(
                cursorRow,
                linesToDelete,
                nextState.lines
              );
              const { startRow, startCol, endRow, endCol } = getPositionFromOffsets(startOffset, endOffset, nextState.lines);
              return replaceRangeInternal(
                nextState,
                startRow,
                startCol,
                endRow,
                endCol,
                ""
              );
            }
          }
          return state;
        }
        case "k": {
          const upLines = Math.min(count + 1, cursorRow + 1);
          if (upLines > 0) {
            if (state.lines.length === 1) {
              const currentLine = state.lines[0] || "";
              return replaceRangeInternal(
                pushUndo(state),
                0,
                0,
                0,
                cpLen(currentLine),
                ""
              );
            } else {
              const startRow = Math.max(0, cursorRow - count);
              const linesToDelete = cursorRow - startRow + 1;
              const nextState = pushUndo(state);
              const { startOffset, endOffset } = getLineRangeOffsets(
                startRow,
                linesToDelete,
                nextState.lines
              );
              const {
                startRow: newStartRow,
                startCol,
                endRow,
                endCol
              } = getPositionFromOffsets(
                startOffset,
                endOffset,
                nextState.lines
              );
              const resultState = replaceRangeInternal(
                nextState,
                newStartRow,
                startCol,
                endRow,
                endCol,
                ""
              );
              return {
                ...resultState,
                cursorRow: startRow,
                cursorCol: 0
              };
            }
          }
          return state;
        }
        case "l": {
          return replaceRangeInternal(
            pushUndo(state),
            cursorRow,
            cursorCol,
            cursorRow,
            Math.min(cpLen(lines[cursorRow] || ""), cursorCol + count),
            ""
          );
        }
        default:
          return state;
      }
    }
    case "vim_move_left": {
      const { count } = action.payload;
      const { cursorRow: cursorRow2, cursorCol: cursorCol2, lines: lines2 } = state;
      let newRow = cursorRow2;
      let newCol = cursorCol2;
      for (let i = 0; i < count; i++) {
        if (newCol > 0) {
          newCol--;
        } else if (newRow > 0) {
          newRow--;
          const prevLine = lines2[newRow] || "";
          const prevLineLength = cpLen(prevLine);
          newCol = prevLineLength === 0 ? 0 : prevLineLength - 1;
        }
      }
      return {
        ...state,
        cursorRow: newRow,
        cursorCol: newCol,
        preferredCol: null
      };
    }
    case "vim_move_right": {
      const { count } = action.payload;
      const { cursorRow: cursorRow2, cursorCol: cursorCol2, lines: lines2 } = state;
      let newRow = cursorRow2;
      let newCol = cursorCol2;
      for (let i = 0; i < count; i++) {
        const currentLine = lines2[newRow] || "";
        const lineLength = cpLen(currentLine);
        if (lineLength === 0) {
          if (newRow < lines2.length - 1) {
            newRow++;
            newCol = 0;
          }
        } else if (newCol < lineLength - 1) {
          newCol++;
          const currentLinePoints = toCodePoints(currentLine);
          while (newCol < currentLinePoints.length && isCombiningMark(currentLinePoints[newCol]) && newCol < lineLength - 1) {
            newCol++;
          }
        } else if (newRow < lines2.length - 1) {
          newRow++;
          newCol = 0;
        }
      }
      return {
        ...state,
        cursorRow: newRow,
        cursorCol: newCol,
        preferredCol: null
      };
    }
    case "vim_move_up": {
      const { count } = action.payload;
      const { cursorRow: cursorRow2, cursorCol: cursorCol2, lines: lines2 } = state;
      const newRow = Math.max(0, cursorRow2 - count);
      const targetLine = lines2[newRow] || "";
      const targetLineLength = cpLen(targetLine);
      const newCol = Math.min(
        cursorCol2,
        targetLineLength > 0 ? targetLineLength - 1 : 0
      );
      return {
        ...state,
        cursorRow: newRow,
        cursorCol: newCol,
        preferredCol: null
      };
    }
    case "vim_move_down": {
      const { count } = action.payload;
      const { cursorRow: cursorRow2, cursorCol: cursorCol2, lines: lines2 } = state;
      const newRow = Math.min(lines2.length - 1, cursorRow2 + count);
      const targetLine = lines2[newRow] || "";
      const targetLineLength = cpLen(targetLine);
      const newCol = Math.min(
        cursorCol2,
        targetLineLength > 0 ? targetLineLength - 1 : 0
      );
      return {
        ...state,
        cursorRow: newRow,
        cursorCol: newCol,
        preferredCol: null
      };
    }
    case "vim_move_word_forward": {
      const { count } = action.payload;
      let row = cursorRow;
      let col = cursorCol;
      for (let i = 0; i < count; i++) {
        const nextWord = findNextWordAcrossLines(lines, row, col, true);
        if (nextWord) {
          row = nextWord.row;
          col = nextWord.col;
        } else {
          break;
        }
      }
      return {
        ...state,
        cursorRow: row,
        cursorCol: col,
        preferredCol: null
      };
    }
    case "vim_move_word_backward": {
      const { count } = action.payload;
      let row = cursorRow;
      let col = cursorCol;
      for (let i = 0; i < count; i++) {
        const prevWord = findPrevWordAcrossLines(lines, row, col);
        if (prevWord) {
          row = prevWord.row;
          col = prevWord.col;
        } else {
          break;
        }
      }
      return {
        ...state,
        cursorRow: row,
        cursorCol: col,
        preferredCol: null
      };
    }
    case "vim_move_word_end": {
      const { count } = action.payload;
      let row = cursorRow;
      let col = cursorCol;
      for (let i = 0; i < count; i++) {
        if (i === 0) {
          const currentLine = lines[row] || "";
          const lineCodePoints = toCodePoints(currentLine);
          const atEndOfWord = col < lineCodePoints.length && isWordCharStrict(lineCodePoints[col]) && (col + 1 >= lineCodePoints.length || !isWordCharWithCombining(lineCodePoints[col + 1]) || // Or if we're on a base char followed only by combining marks until non-word
          isWordCharStrict(lineCodePoints[col]) && isAtEndOfBaseWord(lineCodePoints, col));
          if (atEndOfWord) {
            const nextWord = findNextWordAcrossLines(
              lines,
              row,
              col + 1,
              false
            );
            if (nextWord) {
              row = nextWord.row;
              col = nextWord.col;
              continue;
            }
          }
        }
        const wordEnd = findNextWordAcrossLines(lines, row, col, false);
        if (wordEnd) {
          row = wordEnd.row;
          col = wordEnd.col;
        } else {
          break;
        }
      }
      return {
        ...state,
        cursorRow: row,
        cursorCol: col,
        preferredCol: null
      };
    }
    case "vim_delete_char": {
      const { count } = action.payload;
      const { cursorRow: cursorRow2, cursorCol: cursorCol2, lines: lines2 } = state;
      const currentLine = lines2[cursorRow2] || "";
      const lineLength = cpLen(currentLine);
      if (cursorCol2 < lineLength) {
        const deleteCount = Math.min(count, lineLength - cursorCol2);
        const nextState = pushUndo(state);
        return replaceRangeInternal(
          nextState,
          cursorRow2,
          cursorCol2,
          cursorRow2,
          cursorCol2 + deleteCount,
          ""
        );
      }
      return state;
    }
    case "vim_insert_at_cursor": {
      return state;
    }
    case "vim_append_at_cursor": {
      const { cursorRow: cursorRow2, cursorCol: cursorCol2, lines: lines2 } = state;
      const currentLine = lines2[cursorRow2] || "";
      const newCol = cursorCol2 < cpLen(currentLine) ? cursorCol2 + 1 : cursorCol2;
      return {
        ...state,
        cursorCol: newCol,
        preferredCol: null
      };
    }
    case "vim_open_line_below": {
      const { cursorRow: cursorRow2, lines: lines2 } = state;
      const nextState = pushUndo(state);
      const endOfLine = cpLen(lines2[cursorRow2] || "");
      return replaceRangeInternal(
        nextState,
        cursorRow2,
        endOfLine,
        cursorRow2,
        endOfLine,
        "\n"
      );
    }
    case "vim_open_line_above": {
      const { cursorRow: cursorRow2 } = state;
      const nextState = pushUndo(state);
      const resultState = replaceRangeInternal(
        nextState,
        cursorRow2,
        0,
        cursorRow2,
        0,
        "\n"
      );
      return {
        ...resultState,
        cursorRow: cursorRow2,
        cursorCol: 0
      };
    }
    case "vim_append_at_line_end": {
      const { cursorRow: cursorRow2, lines: lines2 } = state;
      const lineLength = cpLen(lines2[cursorRow2] || "");
      return {
        ...state,
        cursorCol: lineLength,
        preferredCol: null
      };
    }
    case "vim_insert_at_line_start": {
      const { cursorRow: cursorRow2, lines: lines2 } = state;
      const currentLine = lines2[cursorRow2] || "";
      let col = 0;
      const lineCodePoints = toCodePoints(currentLine);
      while (col < lineCodePoints.length && /\s/.test(lineCodePoints[col])) {
        col++;
      }
      return {
        ...state,
        cursorCol: col,
        preferredCol: null
      };
    }
    case "vim_move_to_line_start": {
      return {
        ...state,
        cursorCol: 0,
        preferredCol: null
      };
    }
    case "vim_move_to_line_end": {
      const { cursorRow: cursorRow2, lines: lines2 } = state;
      const lineLength = cpLen(lines2[cursorRow2] || "");
      return {
        ...state,
        cursorCol: lineLength > 0 ? lineLength - 1 : 0,
        preferredCol: null
      };
    }
    case "vim_move_to_first_nonwhitespace": {
      const { cursorRow: cursorRow2, lines: lines2 } = state;
      const currentLine = lines2[cursorRow2] || "";
      let col = 0;
      const lineCodePoints = toCodePoints(currentLine);
      while (col < lineCodePoints.length && /\s/.test(lineCodePoints[col])) {
        col++;
      }
      return {
        ...state,
        cursorCol: col,
        preferredCol: null
      };
    }
    case "vim_move_to_first_line": {
      return {
        ...state,
        cursorRow: 0,
        cursorCol: 0,
        preferredCol: null
      };
    }
    case "vim_move_to_last_line": {
      const { lines: lines2 } = state;
      const lastRow = lines2.length - 1;
      return {
        ...state,
        cursorRow: lastRow,
        cursorCol: 0,
        preferredCol: null
      };
    }
    case "vim_move_to_line": {
      const { lineNumber } = action.payload;
      const { lines: lines2 } = state;
      const targetRow = Math.min(Math.max(0, lineNumber - 1), lines2.length - 1);
      return {
        ...state,
        cursorRow: targetRow,
        cursorCol: 0,
        preferredCol: null
      };
    }
    case "vim_escape_insert_mode": {
      const { cursorCol: cursorCol2 } = state;
      const newCol = cursorCol2 > 0 ? cursorCol2 - 1 : 0;
      return {
        ...state,
        cursorCol: newCol,
        preferredCol: null
      };
    }
    default: {
      assumeExhaustive(action);
      return state;
    }
  }
}
__name(handleVimAction, "handleVimAction");

// packages/cli/src/ui/components/shared/text-buffer.ts
var debugLogger = createDebugLogger("TEXT_BUFFER");
var isWordCharStrict = /* @__PURE__ */ __name((char) => /[\w\p{L}\p{N}]/u.test(char), "isWordCharStrict");
var isWhitespace = /* @__PURE__ */ __name((char) => /\s/.test(char), "isWhitespace");
var isCombiningMark = /* @__PURE__ */ __name((char) => new RegExp("\\p{M}", "u").test(char), "isCombiningMark");
var isWordCharWithCombining = /* @__PURE__ */ __name((char) => isWordCharStrict(char) || isCombiningMark(char), "isWordCharWithCombining");
var getCharScript = /* @__PURE__ */ __name((char) => {
  if (/[\p{Script=Latin}]/u.test(char)) return "latin";
  if (/[\p{Script=Han}]/u.test(char)) return "han";
  if (/[\p{Script=Arabic}]/u.test(char)) return "arabic";
  if (/[\p{Script=Hiragana}]/u.test(char)) return "hiragana";
  if (/[\p{Script=Katakana}]/u.test(char)) return "katakana";
  if (/[\p{Script=Cyrillic}]/u.test(char)) return "cyrillic";
  return "other";
}, "getCharScript");
var isDifferentScript = /* @__PURE__ */ __name((char1, char2) => {
  if (!isWordCharStrict(char1) || !isWordCharStrict(char2)) return false;
  return getCharScript(char1) !== getCharScript(char2);
}, "isDifferentScript");
var CJK_CHAR_REGEX = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/;
var isCjkChar = /* @__PURE__ */ __name((char) => CJK_CHAR_REGEX.test(char), "isCjkChar");
var WORD_BOUNDARIES_CACHE_MAX = 500;
var SEGMENTER_LENGTH_LIMIT = 1500;
var wordBoundariesCache = null;
var segmenter = null;
function ensureSegmenterLoaded() {
  if (segmenter !== null) return;
  try {
    segmenter = new Intl.Segmenter("zh", { granularity: "word" });
    debugLogger.info("Intl.Segmenter: initialized successfully");
  } catch (err) {
    debugLogger.warn("Intl.Segmenter: failed to initialize", err);
    segmenter = false;
  }
}
__name(ensureSegmenterLoaded, "ensureSegmenterLoaded");
function charByCharFallback(line) {
  const codePoints = toCodePoints(line);
  const fallback = [];
  for (let i = 0; i < codePoints.length; i++) {
    if (isCjkChar(codePoints[i])) {
      fallback.push({ start: i, end: i + 1 });
    }
  }
  return fallback;
}
__name(charByCharFallback, "charByCharFallback");
function evictCacheIfNeeded() {
  if (wordBoundariesCache && wordBoundariesCache.size >= WORD_BOUNDARIES_CACHE_MAX) {
    const firstKey = wordBoundariesCache.keys().next().value;
    if (firstKey !== void 0) {
      wordBoundariesCache.delete(firstKey);
    }
  }
}
__name(evictCacheIfNeeded, "evictCacheIfNeeded");
function getWordBoundaries(line, codePoints) {
  const cps = codePoints ?? toCodePoints(line);
  if (cps.length > SEGMENTER_LENGTH_LIMIT) {
    if (!wordBoundariesCache) wordBoundariesCache = /* @__PURE__ */ new Map();
    if (wordBoundariesCache.has(line)) return wordBoundariesCache.get(line);
    const fallback = charByCharFallback(line);
    evictCacheIfNeeded();
    wordBoundariesCache.set(line, fallback);
    return fallback;
  }
  if (!wordBoundariesCache) wordBoundariesCache = /* @__PURE__ */ new Map();
  const cached = wordBoundariesCache.get(line);
  if (cached) {
    return cached;
  }
  ensureSegmenterLoaded();
  if (!segmenter) {
    const fallback = charByCharFallback(line);
    evictCacheIfNeeded();
    wordBoundariesCache.set(line, fallback);
    return fallback;
  }
  try {
    const segments = segmenter.segment(line);
    const cpToStrIdx = [];
    let strIdx = 0;
    for (let i = 0; i < cps.length; i++) {
      cpToStrIdx[i] = strIdx;
      strIdx += cps[i].length;
    }
    const boundaries = [];
    for (const { index, segment, isWordLike } of segments) {
      const trimmedSegment = segment.trim();
      if (!isWordLike && trimmedSegment.length === 0) {
        continue;
      }
      if (isWordLike && segment.includes(".")) {
        let currentOffset = index;
        const parts = segment.split(/(\.)/);
        for (const part of parts) {
          if (part.length === 0) continue;
          const partStartCpIdx = binarySearchCpIndex(cpToStrIdx, currentOffset);
          const partEndStrPos = currentOffset + part.length;
          const partEndCpIdxRaw = binarySearchCpIndex(
            cpToStrIdx,
            partEndStrPos
          );
          const partEndCpIdx = partEndCpIdxRaw === -1 ? cps.length : partEndCpIdxRaw;
          if (partStartCpIdx >= 0 && partStartCpIdx < partEndCpIdx) {
            boundaries.push({ start: partStartCpIdx, end: partEndCpIdx });
          }
          currentOffset += part.length;
        }
        continue;
      }
      if (!isWordLike && /^[.,;!?，。；！？、]+$/.test(trimmedSegment)) {
        const startCpIdx2 = binarySearchCpIndex(cpToStrIdx, index);
        const endStrPos2 = index + segment.length;
        const endCpIdxRaw2 = binarySearchCpIndex(cpToStrIdx, endStrPos2);
        const endCpIdx2 = endCpIdxRaw2 === -1 ? cps.length : endCpIdxRaw2;
        if (startCpIdx2 >= 0 && startCpIdx2 < endCpIdx2) {
          boundaries.push({ start: startCpIdx2, end: endCpIdx2 });
        }
        continue;
      }
      const startCpIdx = binarySearchCpIndex(cpToStrIdx, index);
      const endStrPos = index + segment.length;
      const endCpIdxRaw = binarySearchCpIndex(cpToStrIdx, endStrPos);
      const endCpIdx = endCpIdxRaw === -1 ? cps.length : endCpIdxRaw;
      if (startCpIdx >= 0 && startCpIdx < endCpIdx) {
        boundaries.push({ start: startCpIdx, end: endCpIdx });
      }
    }
    evictCacheIfNeeded();
    wordBoundariesCache.set(line, boundaries);
    return boundaries;
  } catch (err) {
    debugLogger.warn("getWordBoundaries: error, using char fallback", err);
    const fallback = charByCharFallback(line);
    evictCacheIfNeeded();
    wordBoundariesCache.set(line, fallback);
    return fallback;
  }
}
__name(getWordBoundaries, "getWordBoundaries");
function binarySearchCpIndex(cpToStrIdx, target) {
  let lo = 0;
  let hi = cpToStrIdx.length - 1;
  while (lo <= hi) {
    const mid = lo + hi >>> 1;
    if (cpToStrIdx[mid] >= target) hi = mid - 1;
    else lo = mid + 1;
  }
  return lo < cpToStrIdx.length ? lo : -1;
}
__name(binarySearchCpIndex, "binarySearchCpIndex");
function findPrevWordStart(boundaries, col) {
  for (let i = boundaries.length - 1; i >= 0; i--) {
    const b = boundaries[i];
    if (col > b.start && col <= b.end) {
      return b.start;
    }
    if (col === b.start && i > 0) {
      return boundaries[i - 1].start;
    }
  }
  return null;
}
__name(findPrevWordStart, "findPrevWordStart");
function findNextWordEnd(boundaries, col) {
  for (const b of boundaries) {
    if (col >= b.start && col < b.end) {
      return b.end;
    }
    if (col < b.start) {
      return null;
    }
  }
  return null;
}
__name(findNextWordEnd, "findNextWordEnd");
function findWordEndFallback(arr, startPos) {
  let end = startPos;
  while (end < arr.length) {
    const currChar = arr[end];
    const nextChar = end + 1 < arr.length ? arr[end + 1] : void 0;
    if (!isWordCharStrict(currChar ?? "") || nextChar !== void 0 && isWordCharStrict(currChar ?? "") && isWordCharStrict(nextChar) && isDifferentScript(currChar ?? "", nextChar)) {
      break;
    }
    if (nextChar !== void 0 && isCjkChar(currChar ?? "") && isCjkChar(nextChar)) {
      end++;
      break;
    }
    end++;
  }
  return end;
}
__name(findWordEndFallback, "findWordEndFallback");
var findNextWordStartInLine = /* @__PURE__ */ __name((line, col) => {
  const chars = toCodePoints(line);
  let i = col;
  if (i >= chars.length) return null;
  const currentChar = chars[i];
  if (isWordCharStrict(currentChar)) {
    while (i < chars.length && isWordCharWithCombining(chars[i])) {
      if (i + 1 < chars.length && isWordCharStrict(chars[i + 1]) && isDifferentScript(chars[i], chars[i + 1])) {
        i++;
        break;
      }
      i++;
    }
  } else if (!isWhitespace(currentChar)) {
    while (i < chars.length && !isWordCharStrict(chars[i]) && !isWhitespace(chars[i])) {
      i++;
    }
  }
  while (i < chars.length && isWhitespace(chars[i])) {
    i++;
  }
  return i < chars.length ? i : null;
}, "findNextWordStartInLine");
var findPrevWordStartInLine = /* @__PURE__ */ __name((line, col) => {
  const chars = toCodePoints(line);
  let i = col;
  if (i <= 0) return null;
  i--;
  while (i >= 0 && isWhitespace(chars[i])) {
    i--;
  }
  if (i < 0) return null;
  if (isWordCharStrict(chars[i])) {
    while (i >= 0 && isWordCharStrict(chars[i])) {
      if (i - 1 >= 0 && isWordCharStrict(chars[i - 1]) && isDifferentScript(chars[i], chars[i - 1])) {
        return i;
      }
      i--;
    }
    return i + 1;
  } else {
    while (i >= 0 && !isWordCharStrict(chars[i]) && !isWhitespace(chars[i])) {
      i--;
    }
    return i + 1;
  }
}, "findPrevWordStartInLine");
var findWordEndInLine = /* @__PURE__ */ __name((line, col) => {
  const chars = toCodePoints(line);
  let i = col;
  const atEndOfWordChar = i < chars.length && isWordCharWithCombining(chars[i]) && (i + 1 >= chars.length || !isWordCharWithCombining(chars[i + 1]) || isWordCharStrict(chars[i]) && i + 1 < chars.length && isWordCharStrict(chars[i + 1]) && isDifferentScript(chars[i], chars[i + 1]));
  const atEndOfPunctuation = i < chars.length && !isWordCharWithCombining(chars[i]) && !isWhitespace(chars[i]) && (i + 1 >= chars.length || isWhitespace(chars[i + 1]) || isWordCharWithCombining(chars[i + 1]));
  if (atEndOfWordChar || atEndOfPunctuation) {
    i++;
    while (i < chars.length && isWhitespace(chars[i])) {
      i++;
    }
  }
  if (i < chars.length && !isWordCharWithCombining(chars[i])) {
    while (i < chars.length && isWhitespace(chars[i])) {
      i++;
    }
  }
  let foundWord = false;
  let lastBaseCharPos = -1;
  if (i < chars.length && isWordCharWithCombining(chars[i])) {
    while (i < chars.length && isWordCharWithCombining(chars[i])) {
      foundWord = true;
      if (isWordCharStrict(chars[i])) {
        lastBaseCharPos = i;
      }
      if (i + 1 < chars.length && isWordCharStrict(chars[i + 1]) && isDifferentScript(chars[i], chars[i + 1])) {
        i++;
        if (isWordCharStrict(chars[i - 1])) {
          lastBaseCharPos = i - 1;
        }
        break;
      }
      i++;
    }
  } else if (i < chars.length && !isWhitespace(chars[i])) {
    while (i < chars.length && !isWordCharStrict(chars[i]) && !isWhitespace(chars[i])) {
      foundWord = true;
      lastBaseCharPos = i;
      i++;
    }
  }
  if (foundWord && lastBaseCharPos >= col) {
    return lastBaseCharPos;
  }
  return null;
}, "findWordEndInLine");
var findNextWordAcrossLines = /* @__PURE__ */ __name((lines, cursorRow, cursorCol, searchForWordStart) => {
  const currentLine = lines[cursorRow] || "";
  const colInCurrentLine = searchForWordStart ? findNextWordStartInLine(currentLine, cursorCol) : findWordEndInLine(currentLine, cursorCol);
  if (colInCurrentLine !== null) {
    return { row: cursorRow, col: colInCurrentLine };
  }
  for (let row = cursorRow + 1; row < lines.length; row++) {
    const line = lines[row] || "";
    const chars = toCodePoints(line);
    if (chars.length === 0) {
      let hasWordsInLaterLines = false;
      for (let laterRow = row + 1; laterRow < lines.length; laterRow++) {
        const laterLine = lines[laterRow] || "";
        const laterChars = toCodePoints(laterLine);
        let firstNonWhitespace2 = 0;
        while (firstNonWhitespace2 < laterChars.length && isWhitespace(laterChars[firstNonWhitespace2])) {
          firstNonWhitespace2++;
        }
        if (firstNonWhitespace2 < laterChars.length) {
          hasWordsInLaterLines = true;
          break;
        }
      }
      if (!hasWordsInLaterLines) {
        return { row, col: 0 };
      }
      continue;
    }
    let firstNonWhitespace = 0;
    while (firstNonWhitespace < chars.length && isWhitespace(chars[firstNonWhitespace])) {
      firstNonWhitespace++;
    }
    if (firstNonWhitespace < chars.length) {
      if (searchForWordStart) {
        return { row, col: firstNonWhitespace };
      } else {
        const endCol = findWordEndInLine(line, firstNonWhitespace);
        if (endCol !== null) {
          return { row, col: endCol };
        }
      }
    }
  }
  return null;
}, "findNextWordAcrossLines");
var findPrevWordAcrossLines = /* @__PURE__ */ __name((lines, cursorRow, cursorCol) => {
  const currentLine = lines[cursorRow] || "";
  const colInCurrentLine = findPrevWordStartInLine(currentLine, cursorCol);
  if (colInCurrentLine !== null) {
    return { row: cursorRow, col: colInCurrentLine };
  }
  for (let row = cursorRow - 1; row >= 0; row--) {
    const line = lines[row] || "";
    const chars = toCodePoints(line);
    if (chars.length === 0) continue;
    let lastWordStart = chars.length;
    while (lastWordStart > 0 && isWhitespace(chars[lastWordStart - 1])) {
      lastWordStart--;
    }
    if (lastWordStart > 0) {
      const wordStart = findPrevWordStartInLine(line, lastWordStart);
      if (wordStart !== null) {
        return { row, col: wordStart };
      }
    }
  }
  return null;
}, "findPrevWordAcrossLines");
var offsetToRowCol = /* @__PURE__ */ __name((offset, lines) => {
  let running = 0;
  for (let i = 0; i < lines.length; i++) {
    const lineLength = lines[i].length + 1;
    if (running + lineLength > offset) {
      return { row: i, col: offset - running };
    }
    running += lineLength;
  }
  const last = Math.max(0, lines.length - 1);
  return { row: last, col: lines[last]?.length ?? 0 };
}, "offsetToRowCol");
var getPositionFromOffsets = /* @__PURE__ */ __name((startOffset, endOffset, lines) => {
  const { row: startRow, col: startCol } = offsetToRowCol(startOffset, lines);
  const { row: endRow, col: endCol } = offsetToRowCol(endOffset, lines);
  return { startRow, startCol, endRow, endCol };
}, "getPositionFromOffsets");
var getLineRangeOffsets = /* @__PURE__ */ __name((startRow, lineCount, lines) => {
  let startOffset = 0;
  for (let i = 0; i < startRow; i++) {
    startOffset += lines[i].length + 1;
  }
  let endOffset = startOffset;
  for (let i = 0; i < lineCount; i++) {
    const lineIndex = startRow + i;
    if (lineIndex < lines.length) {
      endOffset += lines[lineIndex].length;
      if (lineIndex < lines.length - 1) {
        endOffset += 1;
      }
    }
  }
  return { startOffset, endOffset };
}, "getLineRangeOffsets");
var replaceRangeInternal = /* @__PURE__ */ __name((state, startRow, startCol, endRow, endCol, text) => {
  const currentLine = /* @__PURE__ */ __name((row) => state.lines[row] || "", "currentLine");
  const currentLineLen = /* @__PURE__ */ __name((row) => cpLen(currentLine(row)), "currentLineLen");
  const clamp2 = /* @__PURE__ */ __name((value, min, max) => Math.min(Math.max(value, min), max), "clamp");
  if (startRow > endRow || startRow === endRow && startCol > endCol || startRow < 0 || startCol < 0 || endRow >= state.lines.length || endRow < state.lines.length && endCol > currentLineLen(endRow)) {
    return state;
  }
  const newLines = [...state.lines];
  const sCol = clamp2(startCol, 0, currentLineLen(startRow));
  const eCol = clamp2(endCol, 0, currentLineLen(endRow));
  const prefix = cpSlice(currentLine(startRow), 0, sCol);
  const suffix = cpSlice(currentLine(endRow), eCol);
  const normalisedReplacement = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const replacementParts = normalisedReplacement.split("\n");
  const firstLine = prefix + replacementParts[0];
  if (replacementParts.length === 1) {
    newLines.splice(startRow, endRow - startRow + 1, firstLine + suffix);
  } else {
    const lastLine = replacementParts[replacementParts.length - 1] + suffix;
    const middleLines = replacementParts.slice(1, -1);
    newLines.splice(
      startRow,
      endRow - startRow + 1,
      firstLine,
      ...middleLines,
      lastLine
    );
  }
  const finalCursorRow = startRow + replacementParts.length - 1;
  const finalCursorCol = (replacementParts.length > 1 ? 0 : sCol) + cpLen(replacementParts[replacementParts.length - 1]);
  return {
    ...state,
    lines: newLines,
    cursorRow: Math.min(Math.max(finalCursorRow, 0), newLines.length - 1),
    cursorCol: Math.max(
      0,
      Math.min(finalCursorCol, cpLen(newLines[finalCursorRow] || ""))
    ),
    preferredCol: null
  };
}, "replaceRangeInternal");
function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}
__name(clamp, "clamp");
function calculateInitialCursorPosition(initialLines, offset) {
  let remainingChars = offset;
  let row = 0;
  while (row < initialLines.length) {
    const lineLength = cpLen(initialLines[row]);
    const totalCharsInLineAndNewline = lineLength + (row < initialLines.length - 1 ? 1 : 0);
    if (remainingChars <= lineLength) {
      return [row, remainingChars];
    }
    remainingChars -= totalCharsInLineAndNewline;
    row++;
  }
  if (initialLines.length > 0) {
    const lastRow = initialLines.length - 1;
    return [lastRow, cpLen(initialLines[lastRow])];
  }
  return [0, 0];
}
__name(calculateInitialCursorPosition, "calculateInitialCursorPosition");
function offsetToLogicalPos(text, offset) {
  let row = 0;
  let col = 0;
  let currentOffset = 0;
  if (offset === 0) return [0, 0];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineLength = cpLen(line);
    const lineLengthWithNewline = lineLength + (i < lines.length - 1 ? 1 : 0);
    if (offset <= currentOffset + lineLength) {
      row = i;
      col = offset - currentOffset;
      return [row, col];
    } else if (offset <= currentOffset + lineLengthWithNewline) {
      row = i;
      col = lineLength;
      if (offset === currentOffset + lineLengthWithNewline && i < lines.length - 1) {
        return [i + 1, 0];
      }
      return [row, col];
    }
    currentOffset += lineLengthWithNewline;
  }
  if (lines.length > 0) {
    row = lines.length - 1;
    col = cpLen(lines[row]);
  } else {
    row = 0;
    col = 0;
  }
  return [row, col];
}
__name(offsetToLogicalPos, "offsetToLogicalPos");
function logicalPosToOffset(lines, row, col) {
  let offset = 0;
  const actualRow = Math.min(row, lines.length - 1);
  for (let i = 0; i < actualRow; i++) {
    offset += cpLen(lines[i]) + 1;
  }
  if (actualRow >= 0 && actualRow < lines.length) {
    offset += Math.min(col, cpLen(lines[actualRow]));
  }
  return offset;
}
__name(logicalPosToOffset, "logicalPosToOffset");
function calculateLayout(logicalLines, viewportWidth) {
  const visualLines = [];
  const logicalToVisualMap = [];
  const visualToLogicalMap = [];
  logicalLines.forEach((logLine, logIndex) => {
    logicalToVisualMap[logIndex] = [];
    if (logLine.length === 0) {
      logicalToVisualMap[logIndex].push([visualLines.length, 0]);
      visualToLogicalMap.push([logIndex, 0]);
      visualLines.push("");
    } else {
      let currentPosInLogLine = 0;
      const codePointsInLogLine = toCodePoints(logLine);
      while (currentPosInLogLine < codePointsInLogLine.length) {
        let currentChunk = "";
        let currentChunkVisualWidth = 0;
        let numCodePointsInChunk = 0;
        let lastWordBreakPoint = -1;
        let numCodePointsAtLastWordBreak = 0;
        for (let i = currentPosInLogLine; i < codePointsInLogLine.length; i++) {
          const char = codePointsInLogLine[i];
          const charVisualWidth = getCachedStringWidth(char);
          if (currentChunkVisualWidth + charVisualWidth > viewportWidth) {
            if (lastWordBreakPoint !== -1 && numCodePointsAtLastWordBreak > 0 && currentPosInLogLine + numCodePointsAtLastWordBreak < i) {
              currentChunk = codePointsInLogLine.slice(
                currentPosInLogLine,
                currentPosInLogLine + numCodePointsAtLastWordBreak
              ).join("");
              numCodePointsInChunk = numCodePointsAtLastWordBreak;
            } else {
              if (numCodePointsInChunk === 0 && charVisualWidth > viewportWidth) {
                currentChunk = char;
                numCodePointsInChunk = 1;
              } else if (numCodePointsInChunk === 0 && charVisualWidth <= viewportWidth) {
              }
            }
            break;
          }
          currentChunk += char;
          currentChunkVisualWidth += charVisualWidth;
          numCodePointsInChunk++;
          if (char === " ") {
            lastWordBreakPoint = i;
            numCodePointsAtLastWordBreak = numCodePointsInChunk - 1;
          }
        }
        if (numCodePointsInChunk === 0 && currentPosInLogLine < codePointsInLogLine.length) {
          const firstChar = codePointsInLogLine[currentPosInLogLine];
          currentChunk = firstChar;
          numCodePointsInChunk = 1;
        }
        if (numCodePointsInChunk === 0 && currentPosInLogLine < codePointsInLogLine.length) {
          currentChunk = codePointsInLogLine[currentPosInLogLine];
          numCodePointsInChunk = 1;
        }
        logicalToVisualMap[logIndex].push([
          visualLines.length,
          currentPosInLogLine
        ]);
        visualToLogicalMap.push([logIndex, currentPosInLogLine]);
        visualLines.push(currentChunk);
        const logicalStartOfThisChunk = currentPosInLogLine;
        currentPosInLogLine += numCodePointsInChunk;
        if (logicalStartOfThisChunk + numCodePointsInChunk < codePointsInLogLine.length && currentPosInLogLine < codePointsInLogLine.length && // Redundant if previous is true, but safe
        codePointsInLogLine[currentPosInLogLine] === " ") {
          currentPosInLogLine++;
        }
      }
    }
  });
  if (logicalLines.length === 0 || logicalLines.length === 1 && logicalLines[0] === "") {
    if (visualLines.length === 0) {
      visualLines.push("");
      if (!logicalToVisualMap[0]) logicalToVisualMap[0] = [];
      logicalToVisualMap[0].push([0, 0]);
      visualToLogicalMap.push([0, 0]);
    }
  }
  return {
    visualLines,
    logicalToVisualMap,
    visualToLogicalMap
  };
}
__name(calculateLayout, "calculateLayout");
function calculateVisualCursorFromLayout(layout, logicalCursor) {
  const { logicalToVisualMap, visualLines } = layout;
  const [logicalRow, logicalCol] = logicalCursor;
  const segmentsForLogicalLine = logicalToVisualMap[logicalRow];
  if (!segmentsForLogicalLine || segmentsForLogicalLine.length === 0) {
    return [0, 0];
  }
  let targetSegmentIndex = segmentsForLogicalLine.findIndex(
    ([, startColInLogical2], index) => {
      const nextStartColInLogical = index + 1 < segmentsForLogicalLine.length ? segmentsForLogicalLine[index + 1][1] : Infinity;
      return logicalCol >= startColInLogical2 && logicalCol < nextStartColInLogical;
    }
  );
  if (targetSegmentIndex === -1) {
    if (logicalCol === 0) {
      targetSegmentIndex = 0;
    } else {
      targetSegmentIndex = segmentsForLogicalLine.length - 1;
    }
  }
  const [visualRow, startColInLogical] = segmentsForLogicalLine[targetSegmentIndex];
  const visualCol = logicalCol - startColInLogical;
  const clampedVisualCol = Math.min(
    visualCol,
    cpLen(visualLines[visualRow] ?? "")
  );
  return [visualRow, clampedVisualCol];
}
__name(calculateVisualCursorFromLayout, "calculateVisualCursorFromLayout");
var historyLimit = 100;
var pushUndo = /* @__PURE__ */ __name((currentState) => {
  const snapshot = {
    lines: [...currentState.lines],
    cursorRow: currentState.cursorRow,
    cursorCol: currentState.cursorCol
  };
  const newStack = [...currentState.undoStack, snapshot];
  if (newStack.length > historyLimit) {
    newStack.shift();
  }
  return { ...currentState, undoStack: newStack, redoStack: [] };
}, "pushUndo");
function textBufferReducerLogic(state, action) {
  const pushUndoLocal = pushUndo;
  const currentLine = /* @__PURE__ */ __name((r) => state.lines[r] ?? "", "currentLine");
  const currentLineLen = /* @__PURE__ */ __name((r) => cpLen(currentLine(r)), "currentLineLen");
  switch (action.type) {
    case "set_text": {
      let nextState = action.clearUndoHistory ? { ...state, undoStack: [], redoStack: [] } : state;
      if (!action.clearUndoHistory && action.pushToUndo !== false) {
        nextState = pushUndoLocal(state);
      }
      const newContentLines = action.payload.replace(/\r\n?/g, "\n").split("\n");
      const lines = newContentLines.length === 0 ? [""] : newContentLines;
      const lastNewLineIndex = lines.length - 1;
      return {
        ...nextState,
        lines,
        cursorRow: lastNewLineIndex,
        cursorCol: cpLen(lines[lastNewLineIndex] ?? ""),
        preferredCol: null
      };
    }
    case "insert": {
      const nextState = pushUndoLocal(state);
      const newLines = [...nextState.lines];
      let newCursorRow = nextState.cursorRow;
      let newCursorCol = nextState.cursorCol;
      const currentLine2 = /* @__PURE__ */ __name((r) => newLines[r] ?? "", "currentLine");
      const str = stripUnsafeCharacters(
        action.payload.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
      );
      const parts = str.split("\n");
      const lineContent = currentLine2(newCursorRow);
      const before = cpSlice(lineContent, 0, newCursorCol);
      const after = cpSlice(lineContent, newCursorCol);
      if (parts.length > 1) {
        newLines[newCursorRow] = before + parts[0];
        const remainingParts = parts.slice(1);
        const lastPartOriginal = remainingParts.pop() ?? "";
        newLines.splice(newCursorRow + 1, 0, ...remainingParts);
        newLines.splice(
          newCursorRow + parts.length - 1,
          0,
          lastPartOriginal + after
        );
        newCursorRow = newCursorRow + parts.length - 1;
        newCursorCol = cpLen(lastPartOriginal);
      } else {
        newLines[newCursorRow] = before + parts[0] + after;
        newCursorCol = cpLen(before) + cpLen(parts[0]);
      }
      return {
        ...nextState,
        lines: newLines,
        cursorRow: newCursorRow,
        cursorCol: newCursorCol,
        preferredCol: null
      };
    }
    case "backspace": {
      const nextState = pushUndoLocal(state);
      const newLines = [...nextState.lines];
      let newCursorRow = nextState.cursorRow;
      let newCursorCol = nextState.cursorCol;
      const currentLine2 = /* @__PURE__ */ __name((r) => newLines[r] ?? "", "currentLine");
      if (newCursorCol === 0 && newCursorRow === 0) return state;
      if (newCursorCol > 0) {
        const lineContent = currentLine2(newCursorRow);
        newLines[newCursorRow] = cpSlice(lineContent, 0, newCursorCol - 1) + cpSlice(lineContent, newCursorCol);
        newCursorCol--;
      } else if (newCursorRow > 0) {
        const prevLineContent = currentLine2(newCursorRow - 1);
        const currentLineContentVal = currentLine2(newCursorRow);
        const newCol = cpLen(prevLineContent);
        newLines[newCursorRow - 1] = prevLineContent + currentLineContentVal;
        newLines.splice(newCursorRow, 1);
        newCursorRow--;
        newCursorCol = newCol;
      }
      return {
        ...nextState,
        lines: newLines,
        cursorRow: newCursorRow,
        cursorCol: newCursorCol,
        preferredCol: null
      };
    }
    case "set_viewport": {
      const { width, height } = action.payload;
      if (width === state.viewportWidth && height === state.viewportHeight) {
        return state;
      }
      return {
        ...state,
        viewportWidth: width,
        viewportHeight: height
      };
    }
    case "move": {
      const { dir } = action.payload;
      const { cursorRow, cursorCol, lines, visualLayout, preferredCol } = state;
      if (dir === "left" || dir === "right" || dir === "up" || dir === "down" || dir === "home" || dir === "end") {
        const visualCursor = calculateVisualCursorFromLayout(visualLayout, [
          cursorRow,
          cursorCol
        ]);
        const { visualLines, visualToLogicalMap } = visualLayout;
        let newVisualRow = visualCursor[0];
        let newVisualCol = visualCursor[1];
        let newPreferredCol = preferredCol;
        const currentVisLineLen = cpLen(visualLines[newVisualRow] ?? "");
        switch (dir) {
          case "left":
            newPreferredCol = null;
            if (newVisualCol > 0) {
              newVisualCol--;
            } else if (newVisualRow > 0) {
              newVisualRow--;
              newVisualCol = cpLen(visualLines[newVisualRow] ?? "");
              const previousMapping = visualToLogicalMap[newVisualRow];
              if (previousMapping) {
                const [previousLogRow, previousLogStartCol] = previousMapping;
                const previousCursorCol = previousLogStartCol + newVisualCol;
                if (previousLogRow === cursorRow && previousCursorCol === cursorCol && newVisualCol > 0) {
                  newVisualCol--;
                }
              }
            }
            break;
          case "right":
            newPreferredCol = null;
            if (newVisualCol < currentVisLineLen) {
              newVisualCol++;
            } else if (newVisualRow < visualLines.length - 1) {
              newVisualRow++;
              newVisualCol = 0;
            }
            break;
          case "up":
            if (newVisualRow > 0) {
              if (newPreferredCol === null) newPreferredCol = newVisualCol;
              newVisualRow--;
              newVisualCol = clamp(
                newPreferredCol,
                0,
                cpLen(visualLines[newVisualRow] ?? "")
              );
            }
            break;
          case "down":
            if (newVisualRow < visualLines.length - 1) {
              if (newPreferredCol === null) newPreferredCol = newVisualCol;
              newVisualRow++;
              newVisualCol = clamp(
                newPreferredCol,
                0,
                cpLen(visualLines[newVisualRow] ?? "")
              );
            }
            break;
          case "home":
            newPreferredCol = null;
            newVisualCol = 0;
            break;
          case "end":
            newPreferredCol = null;
            newVisualCol = currentVisLineLen;
            break;
          default: {
            const exhaustiveCheck = dir;
            debugLogger.error(
              `Unknown visual movement direction: ${exhaustiveCheck}`
            );
            return state;
          }
        }
        if (visualToLogicalMap[newVisualRow]) {
          const [logRow, logStartCol] = visualToLogicalMap[newVisualRow];
          return {
            ...state,
            cursorRow: logRow,
            cursorCol: clamp(
              logStartCol + newVisualCol,
              0,
              cpLen(lines[logRow] ?? "")
            ),
            preferredCol: newPreferredCol
          };
        }
        return state;
      }
      switch (dir) {
        case "wordLeft": {
          if (cursorCol === 0 && cursorRow === 0) return state;
          let newCursorRow = cursorRow;
          let newCursorCol = cursorCol;
          if (cursorCol === 0) {
            newCursorRow--;
            newCursorCol = cpLen(lines[newCursorRow] ?? "");
          } else {
            const lineContent = lines[cursorRow];
            const arr = toCodePoints(lineContent);
            let start = cursorCol;
            const boundaries = getWordBoundaries(lineContent, arr);
            const startBoundary = findPrevWordStart(boundaries, start);
            if (startBoundary !== null) {
              start = startBoundary;
            } else {
              let onlySpaces = true;
              for (let i = 0; i < start; i++) {
                if (isWordCharStrict(arr[i] ?? "")) {
                  onlySpaces = false;
                  break;
                }
              }
              if (onlySpaces) {
                start = 0;
              } else {
                while (start > 0 && !isWordCharStrict(arr[start - 1] ?? ""))
                  start--;
                while (start > 0) {
                  const prevChar = arr[start - 1];
                  const currChar = arr[start];
                  if (!isWordCharStrict(prevChar ?? "") || isWordCharStrict(currChar ?? "") && isDifferentScript(currChar ?? "", prevChar ?? "")) {
                    break;
                  }
                  if (isCjkChar(currChar ?? "") && isCjkChar(prevChar ?? "")) {
                    break;
                  }
                  start--;
                }
              }
            }
            newCursorCol = start;
          }
          return {
            ...state,
            cursorRow: newCursorRow,
            cursorCol: newCursorCol,
            preferredCol: null
          };
        }
        case "wordRight": {
          if (cursorRow === lines.length - 1 && cursorCol === cpLen(lines[cursorRow] ?? "")) {
            return state;
          }
          let newCursorRow = cursorRow;
          let newCursorCol = cursorCol;
          const lineContent = lines[cursorRow] ?? "";
          const arr = toCodePoints(lineContent);
          if (cursorCol >= arr.length) {
            newCursorRow++;
            newCursorCol = 0;
          } else {
            const boundaries = getWordBoundaries(lineContent, arr);
            const endBoundary = findNextWordEnd(boundaries, cursorCol);
            let end;
            if (endBoundary !== null) {
              end = endBoundary;
              while (end < arr.length && isWhitespace(arr[end] ?? "")) {
                end++;
              }
            } else if (cursorCol < arr.length && !isWordCharStrict(arr[cursorCol] ?? "")) {
              end = cursorCol;
              while (end < arr.length && !isWordCharStrict(arr[end] ?? ""))
                end++;
              if (end < arr.length) {
                const nextEnd = findNextWordEnd(boundaries, end);
                if (nextEnd !== null) {
                  end = nextEnd;
                } else {
                  end = findWordEndFallback(arr, end);
                }
              }
            } else {
              end = cursorCol;
              while (end < arr.length && !isWordCharStrict(arr[end] ?? ""))
                end++;
              end = findWordEndFallback(arr, end);
            }
            newCursorCol = end;
          }
          return {
            ...state,
            cursorRow: newCursorRow,
            cursorCol: newCursorCol,
            preferredCol: null
          };
        }
        default:
          return state;
      }
    }
    case "set_cursor": {
      return {
        ...state,
        ...action.payload
      };
    }
    case "delete": {
      const { cursorRow, cursorCol, lines } = state;
      const lineContent = currentLine(cursorRow);
      if (cursorCol < currentLineLen(cursorRow)) {
        const nextState = pushUndoLocal(state);
        const newLines = [...nextState.lines];
        newLines[cursorRow] = cpSlice(lineContent, 0, cursorCol) + cpSlice(lineContent, cursorCol + 1);
        return {
          ...nextState,
          lines: newLines,
          preferredCol: null
        };
      } else if (cursorRow < lines.length - 1) {
        const nextState = pushUndoLocal(state);
        const nextLineContent = currentLine(cursorRow + 1);
        const newLines = [...nextState.lines];
        newLines[cursorRow] = lineContent + nextLineContent;
        newLines.splice(cursorRow + 1, 1);
        return {
          ...nextState,
          lines: newLines,
          preferredCol: null
        };
      }
      return state;
    }
    case "delete_word_left": {
      const { cursorRow, cursorCol } = state;
      if (cursorCol === 0 && cursorRow === 0) return state;
      const nextState = pushUndoLocal(state);
      const newLines = [...nextState.lines];
      let newCursorRow = cursorRow;
      let newCursorCol = cursorCol;
      if (newCursorCol > 0) {
        const lineContent = currentLine(newCursorRow);
        const arr = toCodePoints(lineContent);
        const boundaries = getWordBoundaries(lineContent, arr);
        const startBoundary = findPrevWordStart(boundaries, newCursorCol);
        let start;
        if (startBoundary !== null) {
          start = startBoundary;
        } else {
          const prevWordStart = findPrevWordStartInLine(
            lineContent,
            newCursorCol
          );
          start = prevWordStart === null ? 0 : prevWordStart;
        }
        newLines[newCursorRow] = cpSlice(lineContent, 0, start) + cpSlice(lineContent, newCursorCol);
        newCursorCol = start;
      } else {
        const prevLineContent = currentLine(cursorRow - 1);
        const currentLineContentVal = currentLine(cursorRow);
        const newCol = cpLen(prevLineContent);
        newLines[cursorRow - 1] = prevLineContent + currentLineContentVal;
        newLines.splice(cursorRow, 1);
        newCursorRow--;
        newCursorCol = newCol;
      }
      return {
        ...nextState,
        lines: newLines,
        cursorRow: newCursorRow,
        cursorCol: newCursorCol,
        preferredCol: null
      };
    }
    case "delete_word_right": {
      const { cursorRow, cursorCol, lines } = state;
      const lineContent = currentLine(cursorRow);
      const lineLen = cpLen(lineContent);
      if (cursorCol >= lineLen && cursorRow === lines.length - 1) {
        return state;
      }
      const nextState = pushUndoLocal(state);
      const newLines = [...nextState.lines];
      if (cursorCol >= lineLen) {
        const nextLineContent = currentLine(cursorRow + 1);
        newLines[cursorRow] = lineContent + nextLineContent;
        newLines.splice(cursorRow + 1, 1);
      } else {
        const arr = toCodePoints(lineContent);
        const boundaries = getWordBoundaries(lineContent, arr);
        const endBoundary = findNextWordEnd(boundaries, cursorCol);
        let end;
        if (endBoundary !== null) {
          end = endBoundary;
          while (end < arr.length && isWhitespace(arr[end] ?? "")) {
            end++;
          }
        } else {
          const nextWordStart = findNextWordStartInLine(lineContent, cursorCol);
          end = nextWordStart === null ? lineLen : nextWordStart;
        }
        newLines[cursorRow] = cpSlice(lineContent, 0, cursorCol) + cpSlice(lineContent, end);
      }
      return {
        ...nextState,
        lines: newLines,
        preferredCol: null
      };
    }
    case "kill_line_right": {
      const { cursorRow, cursorCol, lines } = state;
      const lineContent = currentLine(cursorRow);
      if (cursorCol < currentLineLen(cursorRow)) {
        const nextState = pushUndoLocal(state);
        const newLines = [...nextState.lines];
        newLines[cursorRow] = cpSlice(lineContent, 0, cursorCol);
        return {
          ...nextState,
          lines: newLines
        };
      } else if (cursorRow < lines.length - 1) {
        const nextState = pushUndoLocal(state);
        const nextLineContent = currentLine(cursorRow + 1);
        const newLines = [...nextState.lines];
        newLines[cursorRow] = lineContent + nextLineContent;
        newLines.splice(cursorRow + 1, 1);
        return {
          ...nextState,
          lines: newLines,
          preferredCol: null
        };
      }
      return state;
    }
    case "kill_line_left": {
      const { cursorRow, cursorCol } = state;
      if (cursorCol > 0) {
        const nextState = pushUndoLocal(state);
        const lineContent = currentLine(cursorRow);
        const newLines = [...nextState.lines];
        newLines[cursorRow] = cpSlice(lineContent, cursorCol);
        return {
          ...nextState,
          lines: newLines,
          cursorCol: 0,
          preferredCol: null
        };
      } else if (cursorRow > 0) {
        const nextState = pushUndoLocal(state);
        const prevLineContent = currentLine(cursorRow - 1);
        const currentLineContent = currentLine(cursorRow);
        const newCol = cpLen(prevLineContent);
        const newLines = [...nextState.lines];
        newLines[cursorRow - 1] = prevLineContent + currentLineContent;
        newLines.splice(cursorRow, 1);
        return {
          ...nextState,
          lines: newLines,
          cursorRow: cursorRow - 1,
          cursorCol: newCol,
          preferredCol: null
        };
      }
      return state;
    }
    case "undo": {
      const stateToRestore = state.undoStack[state.undoStack.length - 1];
      if (!stateToRestore) return state;
      const currentSnapshot = {
        lines: [...state.lines],
        cursorRow: state.cursorRow,
        cursorCol: state.cursorCol
      };
      return {
        ...state,
        ...stateToRestore,
        undoStack: state.undoStack.slice(0, -1),
        redoStack: [...state.redoStack, currentSnapshot]
      };
    }
    case "redo": {
      const stateToRestore = state.redoStack[state.redoStack.length - 1];
      if (!stateToRestore) return state;
      const currentSnapshot = {
        lines: [...state.lines],
        cursorRow: state.cursorRow,
        cursorCol: state.cursorCol
      };
      return {
        ...state,
        ...stateToRestore,
        redoStack: state.redoStack.slice(0, -1),
        undoStack: [...state.undoStack, currentSnapshot]
      };
    }
    case "replace_range": {
      const { startRow, startCol, endRow, endCol, text } = action.payload;
      const nextState = pushUndoLocal(state);
      return replaceRangeInternal(
        nextState,
        startRow,
        startCol,
        endRow,
        endCol,
        text
      );
    }
    case "move_to_offset": {
      const { offset } = action.payload;
      const [newRow, newCol] = offsetToLogicalPos(
        state.lines.join("\n"),
        offset
      );
      return {
        ...state,
        cursorRow: newRow,
        cursorCol: newCol,
        preferredCol: null
      };
    }
    case "create_undo_snapshot": {
      return pushUndoLocal(state);
    }
    // Vim-specific operations
    case "vim_delete_word_forward":
    case "vim_delete_word_backward":
    case "vim_delete_word_end":
    case "vim_change_word_forward":
    case "vim_change_word_backward":
    case "vim_change_word_end":
    case "vim_delete_line":
    case "vim_change_line":
    case "vim_delete_to_end_of_line":
    case "vim_change_to_end_of_line":
    case "vim_change_movement":
    case "vim_delete_movement":
    case "vim_move_left":
    case "vim_move_right":
    case "vim_move_up":
    case "vim_move_down":
    case "vim_move_word_forward":
    case "vim_move_word_backward":
    case "vim_move_word_end":
    case "vim_delete_char":
    case "vim_insert_at_cursor":
    case "vim_append_at_cursor":
    case "vim_open_line_below":
    case "vim_open_line_above":
    case "vim_append_at_line_end":
    case "vim_insert_at_line_start":
    case "vim_move_to_line_start":
    case "vim_move_to_line_end":
    case "vim_move_to_first_nonwhitespace":
    case "vim_move_to_first_line":
    case "vim_move_to_last_line":
    case "vim_move_to_line":
    case "vim_escape_insert_mode":
      return handleVimAction(state, action);
    default: {
      const exhaustiveCheck = action;
      debugLogger.error(`Unknown action encountered: ${exhaustiveCheck}`);
      return state;
    }
  }
}
__name(textBufferReducerLogic, "textBufferReducerLogic");
function textBufferReducer(state, action) {
  const newState = textBufferReducerLogic(state, action);
  if (newState.lines !== state.lines || newState.viewportWidth !== state.viewportWidth) {
    return {
      ...newState,
      visualLayout: calculateLayout(newState.lines, newState.viewportWidth)
    };
  }
  return newState;
}
__name(textBufferReducer, "textBufferReducer");
function looksLikePath(str) {
  const unquoted = str.replace(/^'(.*)'$/, "$1");
  const inner = unquoted.startsWith("'") ? unquoted.slice(1) : unquoted;
  return inner.startsWith("/") || inner.startsWith("./") || inner.startsWith("../") || inner.startsWith("~/") || inner.startsWith(".") || /^[A-Za-z]:/.test(inner);
}
__name(looksLikePath, "looksLikePath");
function tryExtractFilePaths(content, isValidPath) {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split(/\n/).filter((s) => s.trim().length > 0);
  const validPaths = [];
  const hadNonPathToken = { value: false };
  for (const line of lines) {
    if (hadNonPathToken.value) break;
    const quotedPathRegex = /'((?:[~/.]|[A-Za-z]:)[^']*)'/g;
    let lastIndex = 0;
    let match;
    let hasQuotedPaths = false;
    while ((match = quotedPathRegex.exec(line)) !== null) {
      const gap = line.slice(lastIndex, match.index).trim();
      if (gap) {
        const gapPaths = extractPathsFromSegment(
          gap,
          isValidPath,
          hadNonPathToken
        );
        validPaths.push(...gapPaths);
      }
      const unescaped = unescapePath(match[1]);
      if (isValidPath(unescaped)) {
        validPaths.push(`@${escapePath(unescaped)}`);
      } else {
        hadNonPathToken.value = true;
      }
      lastIndex = quotedPathRegex.lastIndex;
      hasQuotedPaths = true;
    }
    if (hasQuotedPaths) {
      const trailing = line.slice(lastIndex).trim();
      if (trailing) {
        const trailingPaths = extractPathsFromSegment(
          trailing,
          isValidPath,
          hadNonPathToken
        );
        validPaths.push(...trailingPaths);
      }
    } else {
      const linePaths = extractPathsFromSegment(
        line.trim(),
        isValidPath,
        hadNonPathToken
      );
      validPaths.push(...linePaths);
    }
  }
  if (validPaths.length > 0 && !hadNonPathToken.value) {
    return validPaths;
  }
  return null;
}
__name(tryExtractFilePaths, "tryExtractFilePaths");
function extractPathsFromSegment(segment, isValidPath, hadNonPathToken) {
  const tokens = segment.split(/\s+/).filter(Boolean);
  const paths = [];
  let i = 0;
  while (i < tokens.length) {
    if (hadNonPathToken.value) break;
    if (tokens.length > 1 && !looksLikePath(tokens[i])) {
      hadNonPathToken.value = true;
      i++;
      continue;
    }
    let found = false;
    for (let j = tokens.length; j >= i + 1; j--) {
      const candidate = tokens.slice(i, j).join(" ");
      let unquoted = candidate;
      const quoteMatch = unquoted.match(/^'(.*)'$/);
      if (quoteMatch) {
        unquoted = quoteMatch[1];
      }
      const unescaped = unescapePath(unquoted);
      if (isValidPath(unescaped)) {
        paths.push(`@${escapePath(unescaped)}`);
        i = j;
        found = true;
        break;
      }
    }
    if (!found) {
      hadNonPathToken.value = true;
      i++;
    }
  }
  return paths;
}
__name(extractPathsFromSegment, "extractPathsFromSegment");
function useTextBuffer({
  initialText = "",
  initialCursorOffset = 0,
  viewport,
  stdin,
  setRawMode,
  onChange,
  isValidPath,
  shellModeActive = false,
  preferredEditor
}) {
  const initialState = (0, import_react9.useMemo)(() => {
    const lines2 = initialText.split("\n");
    const [initialCursorRow, initialCursorCol] = calculateInitialCursorPosition(
      lines2.length === 0 ? [""] : lines2,
      initialCursorOffset
    );
    const visualLayout2 = calculateLayout(
      lines2.length === 0 ? [""] : lines2,
      viewport.width
    );
    return {
      lines: lines2.length === 0 ? [""] : lines2,
      cursorRow: initialCursorRow,
      cursorCol: initialCursorCol,
      preferredCol: null,
      undoStack: [],
      redoStack: [],
      clipboard: null,
      selectionAnchor: null,
      viewportWidth: viewport.width,
      viewportHeight: viewport.height,
      visualLayout: visualLayout2
    };
  }, [initialText, initialCursorOffset, viewport.width, viewport.height]);
  const stateRef = (0, import_react9.useRef)(initialState);
  const [state, setState] = (0, import_react9.useState)(initialState);
  const dispatch = (0, import_react9.useCallback)((action) => {
    stateRef.current = textBufferReducer(stateRef.current, action);
    setState(stateRef.current);
  }, []);
  const {
    lines,
    cursorRow,
    cursorCol,
    preferredCol,
    selectionAnchor,
    visualLayout
  } = state;
  const text = (0, import_react9.useMemo)(() => lines.join("\n"), [lines]);
  const visualCursor = (0, import_react9.useMemo)(
    () => calculateVisualCursorFromLayout(visualLayout, [cursorRow, cursorCol]),
    [visualLayout, cursorRow, cursorCol]
  );
  const { visualLines, visualToLogicalMap } = visualLayout;
  const [visualScrollRow, setVisualScrollRow] = (0, import_react9.useState)(0);
  (0, import_react9.useEffect)(() => {
    if (onChange) {
      onChange(text);
    }
  }, [text, onChange]);
  (0, import_react9.useEffect)(() => {
    dispatch({
      type: "set_viewport",
      payload: { width: viewport.width, height: viewport.height }
    });
  }, [dispatch, viewport.width, viewport.height]);
  (0, import_react9.useEffect)(() => {
    const { height } = viewport;
    const totalVisualLines = visualLines.length;
    const maxScrollStart = Math.max(0, totalVisualLines - height);
    let newVisualScrollRow = visualScrollRow;
    if (visualCursor[0] < visualScrollRow) {
      newVisualScrollRow = visualCursor[0];
    } else if (visualCursor[0] >= visualScrollRow + height) {
      newVisualScrollRow = visualCursor[0] - height + 1;
    }
    newVisualScrollRow = clamp(newVisualScrollRow, 0, maxScrollStart);
    if (newVisualScrollRow !== visualScrollRow) {
      setVisualScrollRow(newVisualScrollRow);
    }
  }, [visualCursor, visualScrollRow, viewport, visualLines.length]);
  const insert = (0, import_react9.useCallback)(
    (ch, { paste = false } = {}) => {
      if (paste && /[\n\r]/.test(ch) && !shellModeActive) {
        const validPaths = tryExtractFilePaths(ch, isValidPath);
        if (validPaths) {
          ch = `${validPaths.join(" ")} `;
        }
        dispatch({ type: "insert", payload: ch });
        return;
      }
      if (/[\n\r]/.test(ch)) {
        dispatch({ type: "insert", payload: ch });
        return;
      }
      const minLengthToInferAsDragDrop = 3;
      if (paste && ch.length >= minLengthToInferAsDragDrop && !shellModeActive) {
        const validPaths = tryExtractFilePaths(ch.trim(), isValidPath);
        if (validPaths) {
          ch = `${validPaths.join(" ")} `;
        }
      }
      let currentText = "";
      for (const char of toCodePoints(ch)) {
        if (char.codePointAt(0) === 127) {
          if (currentText.length > 0) {
            dispatch({ type: "insert", payload: currentText });
            currentText = "";
          }
          dispatch({ type: "backspace" });
        } else {
          currentText += char;
        }
      }
      if (currentText.length > 0) {
        dispatch({ type: "insert", payload: currentText });
      }
    },
    [dispatch, isValidPath, shellModeActive]
  );
  const newline = (0, import_react9.useCallback)(() => {
    dispatch({ type: "insert", payload: "\n" });
  }, [dispatch]);
  const backspace = (0, import_react9.useCallback)(() => {
    dispatch({ type: "backspace" });
  }, [dispatch]);
  const del = (0, import_react9.useCallback)(() => {
    dispatch({ type: "delete" });
  }, [dispatch]);
  const move = (0, import_react9.useCallback)(
    (dir) => {
      dispatch({ type: "move", payload: { dir } });
    },
    [dispatch]
  );
  const undo = (0, import_react9.useCallback)(() => {
    dispatch({ type: "undo" });
  }, [dispatch]);
  const redo = (0, import_react9.useCallback)(() => {
    dispatch({ type: "redo" });
  }, [dispatch]);
  const setText = (0, import_react9.useCallback)(
    (newText, options) => {
      dispatch({
        type: "set_text",
        payload: newText,
        clearUndoHistory: options?.clearUndoHistory
      });
    },
    [dispatch]
  );
  const deleteWordLeft = (0, import_react9.useCallback)(() => {
    dispatch({ type: "delete_word_left" });
  }, [dispatch]);
  const deleteWordRight = (0, import_react9.useCallback)(() => {
    dispatch({ type: "delete_word_right" });
  }, [dispatch]);
  const killLineRight = (0, import_react9.useCallback)(() => {
    dispatch({ type: "kill_line_right" });
  }, [dispatch]);
  const killLineLeft = (0, import_react9.useCallback)(() => {
    dispatch({ type: "kill_line_left" });
  }, [dispatch]);
  const vimDeleteWordForward = (0, import_react9.useCallback)(
    (count) => {
      dispatch({ type: "vim_delete_word_forward", payload: { count } });
    },
    [dispatch]
  );
  const vimDeleteWordBackward = (0, import_react9.useCallback)(
    (count) => {
      dispatch({ type: "vim_delete_word_backward", payload: { count } });
    },
    [dispatch]
  );
  const vimDeleteWordEnd = (0, import_react9.useCallback)(
    (count) => {
      dispatch({ type: "vim_delete_word_end", payload: { count } });
    },
    [dispatch]
  );
  const vimChangeWordForward = (0, import_react9.useCallback)(
    (count) => {
      dispatch({ type: "vim_change_word_forward", payload: { count } });
    },
    [dispatch]
  );
  const vimChangeWordBackward = (0, import_react9.useCallback)(
    (count) => {
      dispatch({ type: "vim_change_word_backward", payload: { count } });
    },
    [dispatch]
  );
  const vimChangeWordEnd = (0, import_react9.useCallback)(
    (count) => {
      dispatch({ type: "vim_change_word_end", payload: { count } });
    },
    [dispatch]
  );
  const vimDeleteLine = (0, import_react9.useCallback)(
    (count) => {
      dispatch({ type: "vim_delete_line", payload: { count } });
    },
    [dispatch]
  );
  const vimChangeLine = (0, import_react9.useCallback)(
    (count) => {
      dispatch({ type: "vim_change_line", payload: { count } });
    },
    [dispatch]
  );
  const vimDeleteToEndOfLine = (0, import_react9.useCallback)(() => {
    dispatch({ type: "vim_delete_to_end_of_line" });
  }, [dispatch]);
  const vimChangeToEndOfLine = (0, import_react9.useCallback)(() => {
    dispatch({ type: "vim_change_to_end_of_line" });
  }, [dispatch]);
  const vimChangeMovement = (0, import_react9.useCallback)(
    (movement, count) => {
      dispatch({ type: "vim_change_movement", payload: { movement, count } });
    },
    [dispatch]
  );
  const vimDeleteMovement = (0, import_react9.useCallback)(
    (movement, count) => {
      dispatch({ type: "vim_delete_movement", payload: { movement, count } });
    },
    [dispatch]
  );
  const vimMoveLeft = (0, import_react9.useCallback)(
    (count) => {
      dispatch({ type: "vim_move_left", payload: { count } });
    },
    [dispatch]
  );
  const vimMoveRight = (0, import_react9.useCallback)(
    (count) => {
      dispatch({ type: "vim_move_right", payload: { count } });
    },
    [dispatch]
  );
  const vimMoveUp = (0, import_react9.useCallback)(
    (count) => {
      dispatch({ type: "vim_move_up", payload: { count } });
    },
    [dispatch]
  );
  const vimMoveDown = (0, import_react9.useCallback)(
    (count) => {
      dispatch({ type: "vim_move_down", payload: { count } });
    },
    [dispatch]
  );
  const vimMoveWordForward = (0, import_react9.useCallback)(
    (count) => {
      dispatch({ type: "vim_move_word_forward", payload: { count } });
    },
    [dispatch]
  );
  const vimMoveWordBackward = (0, import_react9.useCallback)(
    (count) => {
      dispatch({ type: "vim_move_word_backward", payload: { count } });
    },
    [dispatch]
  );
  const vimMoveWordEnd = (0, import_react9.useCallback)(
    (count) => {
      dispatch({ type: "vim_move_word_end", payload: { count } });
    },
    [dispatch]
  );
  const vimDeleteChar = (0, import_react9.useCallback)(
    (count) => {
      dispatch({ type: "vim_delete_char", payload: { count } });
    },
    [dispatch]
  );
  const vimInsertAtCursor = (0, import_react9.useCallback)(() => {
    dispatch({ type: "vim_insert_at_cursor" });
  }, [dispatch]);
  const vimAppendAtCursor = (0, import_react9.useCallback)(() => {
    dispatch({ type: "vim_append_at_cursor" });
  }, [dispatch]);
  const vimOpenLineBelow = (0, import_react9.useCallback)(() => {
    dispatch({ type: "vim_open_line_below" });
  }, [dispatch]);
  const vimOpenLineAbove = (0, import_react9.useCallback)(() => {
    dispatch({ type: "vim_open_line_above" });
  }, [dispatch]);
  const vimAppendAtLineEnd = (0, import_react9.useCallback)(() => {
    dispatch({ type: "vim_append_at_line_end" });
  }, [dispatch]);
  const vimInsertAtLineStart = (0, import_react9.useCallback)(() => {
    dispatch({ type: "vim_insert_at_line_start" });
  }, [dispatch]);
  const vimMoveToLineStart = (0, import_react9.useCallback)(() => {
    dispatch({ type: "vim_move_to_line_start" });
  }, [dispatch]);
  const vimMoveToLineEnd = (0, import_react9.useCallback)(() => {
    dispatch({ type: "vim_move_to_line_end" });
  }, [dispatch]);
  const vimMoveToFirstNonWhitespace = (0, import_react9.useCallback)(() => {
    dispatch({ type: "vim_move_to_first_nonwhitespace" });
  }, [dispatch]);
  const vimMoveToFirstLine = (0, import_react9.useCallback)(() => {
    dispatch({ type: "vim_move_to_first_line" });
  }, [dispatch]);
  const vimMoveToLastLine = (0, import_react9.useCallback)(() => {
    dispatch({ type: "vim_move_to_last_line" });
  }, [dispatch]);
  const vimMoveToLine = (0, import_react9.useCallback)(
    (lineNumber) => {
      dispatch({ type: "vim_move_to_line", payload: { lineNumber } });
    },
    [dispatch]
  );
  const vimEscapeInsertMode = (0, import_react9.useCallback)(() => {
    dispatch({ type: "vim_escape_insert_mode" });
  }, [dispatch]);
  const openInExternalEditor = (0, import_react9.useCallback)(
    async (opts = {}) => {
      let tmpDir;
      let filePath;
      try {
        tmpDir = fs.mkdtempSync(pathMod.join(os.tmpdir(), "qwen-edit-"));
        filePath = pathMod.join(tmpDir, "buffer.txt");
      } catch (err) {
        debugLogger.error(
          "[useTextBuffer] failed to create temp directory",
          err
        );
        return;
      }
      let editorCmd;
      let editorArgs;
      let useShell = false;
      let editorSource = "env/default";
      if (opts.editor) {
        editorCmd = opts.editor;
        editorArgs = [filePath];
        editorSource = "opts";
        if (process.platform === "win32" && /\.(cmd|bat)$/i.test(editorCmd)) {
          if (/["|%!]/.test(editorCmd)) {
            debugLogger.error(
              `[useTextBuffer] opts.editor command contains unsafe characters: ${editorCmd}`
            );
            try {
              fs.rmSync(tmpDir, { recursive: true, force: true });
            } catch {
            }
            return;
          }
          useShell = true;
        }
      } else {
        const resolved = preferredEditor ? getExternalEditorCommand(preferredEditor, filePath) : null;
        if (resolved) {
          editorCmd = resolved.command;
          editorArgs = resolved.args;
          useShell = resolved.needsShell;
          editorSource = "preferred";
        } else {
          if (preferredEditor) {
            debugLogger.warn(
              `[useTextBuffer] preferred editor "${preferredEditor}" not found, falling back to env/default`
            );
          }
          editorCmd = process.env["VISUAL"] ?? process.env["EDITOR"] ?? (process.platform === "win32" ? "notepad" : "vi");
          editorArgs = [filePath];
          if (process.platform === "win32" && /\.(cmd|bat)$/i.test(editorCmd)) {
            if (/["|%!]/.test(editorCmd)) {
              debugLogger.error(
                `[useTextBuffer] Editor command from environment contains unsafe characters: ${editorCmd}`
              );
              try {
                fs.rmSync(tmpDir, { recursive: true, force: true });
              } catch {
              }
              return;
            }
            useShell = true;
          }
        }
      }
      if (useShell) {
        editorCmd = `"${editorCmd}"`;
        editorArgs = editorArgs.map((a) => `"${a}"`);
      }
      const wasRaw = stdin?.isRaw ?? false;
      try {
        const currentText = stateRef.current.lines.join("\n");
        fs.writeFileSync(filePath, currentText, {
          encoding: "utf8",
          mode: 384
        });
        setRawMode?.(false);
        debugLogger.warn(
          `[useTextBuffer] launching external editor (cmd=${editorCmd}, shell=${useShell}, source=${editorSource}, file=${filePath})`
        );
        const { status, error, signal } = spawnSync(editorCmd, editorArgs, {
          stdio: "inherit",
          shell: useShell,
          timeout: 30 * 60 * 1e3
        });
        if (error) throw error;
        if (signal)
          throw new Error(`External editor was killed by signal ${signal}`);
        if (typeof status === "number" && status !== 0)
          throw new Error(`External editor exited with status ${status}`);
        let newText = fs.readFileSync(filePath, "utf8");
        newText = newText.replace(/\r\n?/g, "\n");
        if (newText !== currentText) {
          dispatch({ type: "create_undo_snapshot" });
          dispatch({ type: "set_text", payload: newText, pushToUndo: false });
        }
      } catch (err) {
        debugLogger.error(
          `[useTextBuffer] external editor error (cmd=${editorCmd}, shell=${useShell}, source=${editorSource}, file=${filePath})`,
          err
        );
      } finally {
        try {
          if (wasRaw) setRawMode?.(true);
        } catch (rawErr) {
          debugLogger.error(
            "[useTextBuffer] failed to restore raw mode after external editor",
            rawErr
          );
        }
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {
        }
      }
    },
    [dispatch, stdin, setRawMode, preferredEditor]
  );
  const handleInput = (0, import_react9.useCallback)(
    (key) => {
      const { sequence: input } = key;
      if (key.paste) {
        insert(input, { paste: key.paste });
        return;
      }
      if (key.name === "return" || input === "\r" || input === "\n" || input === "\\\r")
        newline();
      else if (key.name === "left" && !key.meta && !key.ctrl) move("left");
      else if (key.ctrl && key.name === "b") move("left");
      else if (key.name === "right" && !key.meta && !key.ctrl) move("right");
      else if (key.ctrl && key.name === "f") move("right");
      else if (key.name === "up" && !key.shift) move("up");
      else if (key.name === "down" && !key.shift) move("down");
      else if ((key.ctrl || key.meta) && key.name === "left") move("wordLeft");
      else if (key.meta && key.name === "b") move("wordLeft");
      else if ((key.ctrl || key.meta) && key.name === "right")
        move("wordRight");
      else if (key.meta && key.name === "d") deleteWordRight();
      else if (key.meta && key.name === "f") move("wordRight");
      else if (key.name === "home") move("home");
      else if (key.ctrl && key.name === "a") move("home");
      else if (key.name === "end") move("end");
      else if (key.ctrl && key.name === "e") move("end");
      else if (key.ctrl && key.name === "w") deleteWordLeft();
      else if ((key.meta || key.ctrl) && (key.name === "backspace" || input === "\x7F"))
        deleteWordLeft();
      else if ((key.meta || key.ctrl) && key.name === "delete")
        deleteWordRight();
      else if (key.name === "backspace" || input === "\x7F" || key.ctrl && key.name === "h")
        backspace();
      else if (key.name === "delete" || key.ctrl && key.name === "d") del();
      else if (key.ctrl && !key.shift && key.name === "z") undo();
      else if (key.ctrl && key.shift && key.name === "z") redo();
      else if (input && !key.ctrl && !key.meta && key.name !== "tab" && input !== "	") {
        insert(input, { paste: key.paste });
      }
    },
    [
      newline,
      move,
      deleteWordLeft,
      deleteWordRight,
      backspace,
      del,
      insert,
      undo,
      redo
    ]
  );
  const renderedVisualLines = (0, import_react9.useMemo)(
    () => visualLines.slice(visualScrollRow, visualScrollRow + viewport.height),
    [visualLines, visualScrollRow, viewport.height]
  );
  const replaceRange = (0, import_react9.useCallback)(
    (startRow, startCol, endRow, endCol, text2) => {
      dispatch({
        type: "replace_range",
        payload: { startRow, startCol, endRow, endCol, text: text2 }
      });
    },
    [dispatch]
  );
  const replaceRangeByOffset = (0, import_react9.useCallback)(
    (startOffset, endOffset, replacementText) => {
      const currentText = stateRef.current.lines.join("\n");
      const [startRow, startCol] = offsetToLogicalPos(currentText, startOffset);
      const [endRow, endCol] = offsetToLogicalPos(currentText, endOffset);
      replaceRange(startRow, startCol, endRow, endCol, replacementText);
    },
    [replaceRange]
  );
  const moveToOffset = (0, import_react9.useCallback)(
    (offset) => {
      dispatch({ type: "move_to_offset", payload: { offset } });
    },
    [dispatch]
  );
  const returnValue = (0, import_react9.useMemo)(
    () => ({
      get lines() {
        return stateRef.current.lines;
      },
      get text() {
        return stateRef.current.lines.join("\n");
      },
      get cursor() {
        return [stateRef.current.cursorRow, stateRef.current.cursorCol];
      },
      preferredCol,
      selectionAnchor,
      allVisualLines: visualLines,
      viewportVisualLines: renderedVisualLines,
      visualCursor,
      visualScrollRow,
      visualToLogicalMap,
      setText,
      insert,
      newline,
      backspace,
      del,
      move,
      undo,
      redo,
      replaceRange,
      replaceRangeByOffset,
      moveToOffset,
      deleteWordLeft,
      deleteWordRight,
      killLineRight,
      killLineLeft,
      handleInput,
      openInExternalEditor,
      // Vim-specific operations
      vimDeleteWordForward,
      vimDeleteWordBackward,
      vimDeleteWordEnd,
      vimChangeWordForward,
      vimChangeWordBackward,
      vimChangeWordEnd,
      vimDeleteLine,
      vimChangeLine,
      vimDeleteToEndOfLine,
      vimChangeToEndOfLine,
      vimChangeMovement,
      vimDeleteMovement,
      vimMoveLeft,
      vimMoveRight,
      vimMoveUp,
      vimMoveDown,
      vimMoveWordForward,
      vimMoveWordBackward,
      vimMoveWordEnd,
      vimDeleteChar,
      vimInsertAtCursor,
      vimAppendAtCursor,
      vimOpenLineBelow,
      vimOpenLineAbove,
      vimAppendAtLineEnd,
      vimInsertAtLineStart,
      vimMoveToLineStart,
      vimMoveToLineEnd,
      vimMoveToFirstNonWhitespace,
      vimMoveToFirstLine,
      vimMoveToLastLine,
      vimMoveToLine,
      vimEscapeInsertMode
    }),
    [
      preferredCol,
      selectionAnchor,
      visualLines,
      renderedVisualLines,
      visualCursor,
      visualScrollRow,
      setText,
      insert,
      newline,
      backspace,
      del,
      move,
      undo,
      redo,
      replaceRange,
      replaceRangeByOffset,
      moveToOffset,
      deleteWordLeft,
      deleteWordRight,
      killLineRight,
      killLineLeft,
      handleInput,
      openInExternalEditor,
      vimDeleteWordForward,
      vimDeleteWordBackward,
      vimDeleteWordEnd,
      vimChangeWordForward,
      vimChangeWordBackward,
      vimChangeWordEnd,
      vimDeleteLine,
      vimChangeLine,
      vimDeleteToEndOfLine,
      vimChangeToEndOfLine,
      vimChangeMovement,
      vimDeleteMovement,
      vimMoveLeft,
      vimMoveRight,
      vimMoveUp,
      vimMoveDown,
      vimMoveWordForward,
      vimMoveWordBackward,
      vimMoveWordEnd,
      vimDeleteChar,
      vimInsertAtCursor,
      vimAppendAtCursor,
      vimOpenLineBelow,
      vimOpenLineAbove,
      vimAppendAtLineEnd,
      vimInsertAtLineStart,
      vimMoveToLineStart,
      vimMoveToLineEnd,
      vimMoveToFirstNonWhitespace,
      vimMoveToFirstLine,
      vimMoveToLastLine,
      vimMoveToLine,
      vimEscapeInsertMode,
      visualToLogicalMap
    ]
  );
  return returnValue;
}
__name(useTextBuffer, "useTextBuffer");

// packages/cli/src/ui/hooks/usePreferredEditor.ts
init_esbuild_shims();
var import_react10 = __toESM(require_react(), 1);
var debugLogger2 = createDebugLogger("PREFERRED_EDITOR");
function usePreferredEditor() {
  const settings = useSettings();
  return (0, import_react10.useMemo)(() => {
    const raw = settings.merged.general?.preferredEditor ?? "";
    if (raw && !isValidEditorType(raw)) {
      debugLogger2.warn(
        `[usePreferredEditor] invalid preferredEditor value "${raw}", ignoring`
      );
      return void 0;
    }
    if (isValidEditorType(raw) && !allowEditorTypeInSandbox(raw)) {
      debugLogger2.warn(
        `[usePreferredEditor] editor "${raw}" is not allowed in sandbox mode, ignoring`
      );
      return void 0;
    }
    return isValidEditorType(raw) ? raw : void 0;
  }, [settings.merged.general?.preferredEditor]);
}
__name(usePreferredEditor, "usePreferredEditor");

// packages/cli/src/ui/components/messages/ToolMessage.tsx
init_esbuild_shims();
var import_react26 = __toESM(require_react(), 1);

// packages/cli/src/ui/components/messages/DiffRenderer.tsx
init_esbuild_shims();
import crypto from "node:crypto";

// packages/cli/src/ui/utils/CodeColorizer.tsx
init_esbuild_shims();
var import_react11 = __toESM(require_react(), 1);
var import_jsx_runtime5 = __toESM(require_jsx_runtime(), 1);
var debugLogger3 = createDebugLogger("CODE_COLORIZER");
var STRUCTURAL_BOX_RE = /[│├└┌┐┘┬┴┼]/;
var CJK_RE = /[\u4E00-\u9FFF\u3400-\u4DBF]/g;
function looksLikeDiagramOrArt(line) {
  const trimmed = line.trim();
  if (trimmed.length === 0) return false;
  if (STRUCTURAL_BOX_RE.test(trimmed)) {
    return true;
  }
  const cjkMatches = trimmed.match(CJK_RE) || [];
  const totalChars = trimmed.replace(/\s/g, "").length;
  if (totalChars > 0 && cjkMatches.length / totalChars > 0.3) {
    return true;
  }
  return false;
}
__name(looksLikeDiagramOrArt, "looksLikeDiagramOrArt");
function renderHastNode(node, theme2, inheritedColor) {
  if (node.type === "text") {
    const color = inheritedColor || theme2.defaultColor;
    return /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(Text, { color, children: node.value });
  }
  if (node.type === "element") {
    const nodeClasses = node.properties?.["className"] || [];
    let elementColor = void 0;
    for (let i = nodeClasses.length - 1; i >= 0; i--) {
      const color = theme2.getInkColor(nodeClasses[i]);
      if (color) {
        elementColor = color;
        break;
      }
    }
    const colorToPassDown = elementColor || inheritedColor;
    const children = node.children?.map(
      (child, index) => /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(import_react11.default.Fragment, { children: renderHastNode(child, theme2, colorToPassDown) }, index)
    );
    return /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(import_react11.default.Fragment, { children });
  }
  if (node.type === "root") {
    if (!node.children || node.children.length === 0) {
      return null;
    }
    return node.children?.map((child, index) => /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(import_react11.default.Fragment, { children: renderHastNode(child, theme2, inheritedColor) }, index));
  }
  return null;
}
__name(renderHastNode, "renderHastNode");
function ensureLowlightLoading() {
  const ll = getLowlightInstance();
  if (ll) return ll;
  if (!isLowlightCoolingDown()) {
    void loadLowlight().catch((err) => {
      debugLogger3.error("[CodeColorizer] failed to load lowlight:", err);
    });
  }
  return null;
}
__name(ensureLowlightLoading, "ensureLowlightLoading");
function highlightAndRenderLine(line, language, theme2, lowlight) {
  if (!lowlight) {
    return line;
  }
  if (!language && looksLikeDiagramOrArt(line)) {
    return line;
  }
  try {
    const getHighlightedLine = /* @__PURE__ */ __name(() => !language || !lowlight.registered(language) ? lowlight.highlightAuto(line) : lowlight.highlight(language, line), "getHighlightedLine");
    const renderedNode = renderHastNode(getHighlightedLine(), theme2, void 0);
    return renderedNode !== null ? renderedNode : line;
  } catch (_error) {
    return line;
  }
}
__name(highlightAndRenderLine, "highlightAndRenderLine");
function colorizeLine(line, language, theme2) {
  const activeTheme = theme2 || themeManager.getActiveTheme();
  return highlightAndRenderLine(
    line,
    language,
    activeTheme,
    ensureLowlightLoading()
  );
}
__name(colorizeLine, "colorizeLine");
function colorizeCode(code, language, availableHeight, maxWidth, options = {}) {
  const { theme: theme2, settings, tabWidth = 4, startLineNumber = 1 } = options;
  const firstLineNumber = Math.max(1, Math.trunc(startLineNumber));
  const codeToHighlight = code.replace(/\n$/, "").replace(/\t/g, " ".repeat(tabWidth));
  const activeTheme = theme2 || themeManager.getActiveTheme();
  const showLineNumbers = settings?.merged.ui?.showLineNumbers ?? true;
  const lowlight = ensureLowlightLoading();
  try {
    let lines = codeToHighlight.split("\n");
    const padWidth = String(lines.length + firstLineNumber - 1).length;
    let hiddenLinesCount = 0;
    if (availableHeight !== void 0) {
      availableHeight = Math.max(availableHeight, MINIMUM_MAX_HEIGHT);
      if (lines.length > availableHeight) {
        const sliceIndex = lines.length - availableHeight;
        hiddenLinesCount = sliceIndex;
        lines = lines.slice(sliceIndex);
      }
    }
    return /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(
      MaxSizedBox,
      {
        maxHeight: availableHeight,
        maxWidth,
        additionalHiddenLinesCount: hiddenLinesCount,
        overflowDirection: "top",
        children: lines.map((line, index) => {
          const contentToRender = highlightAndRenderLine(
            line,
            language,
            activeTheme,
            lowlight
          );
          return /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)(Box_default, { children: [
            showLineNumbers && /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(Text, { color: activeTheme.colors.Gray, selectable: false, children: `${String(
              index + firstLineNumber + hiddenLinesCount
            ).padStart(padWidth, " ")} ` }),
            /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(Text, { color: activeTheme.defaultColor, wrap: "wrap", children: contentToRender })
          ] }, index);
        })
      }
    );
  } catch (error) {
    debugLogger3.error(
      `[colorizeCode] Error highlighting code for language "${language}":`,
      error
    );
    const lines = codeToHighlight.split("\n");
    const padWidth = String(lines.length + firstLineNumber - 1).length;
    return /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(
      MaxSizedBox,
      {
        maxHeight: availableHeight,
        maxWidth,
        overflowDirection: "top",
        children: lines.map((line, index) => /* @__PURE__ */ (0, import_jsx_runtime5.jsxs)(Box_default, { children: [
          showLineNumbers && /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(Text, { color: activeTheme.defaultColor, selectable: false, children: `${String(index + firstLineNumber).padStart(padWidth, " ")} ` }),
          /* @__PURE__ */ (0, import_jsx_runtime5.jsx)(Text, { color: activeTheme.colors.Gray, children: line })
        ] }, index))
      }
    );
  }
}
__name(colorizeCode, "colorizeCode");

// packages/cli/src/ui/components/messages/DiffRenderer.tsx
var import_jsx_runtime6 = __toESM(require_jsx_runtime(), 1);
function parseDiffWithLineNumbers(diffContent) {
  const lines = diffContent.split("\n");
  const result = [];
  let currentOldLine = 0;
  let currentNewLine = 0;
  let inHunk = false;
  const hunkHeaderRegex = /^@@ -(\d+),?\d* \+(\d+),?\d* @@/;
  for (const line of lines) {
    const hunkMatch = line.match(hunkHeaderRegex);
    if (hunkMatch) {
      currentOldLine = parseInt(hunkMatch[1], 10);
      currentNewLine = parseInt(hunkMatch[2], 10);
      inHunk = true;
      result.push({ type: "hunk", content: line });
      currentOldLine--;
      currentNewLine--;
      continue;
    }
    if (!inHunk) {
      if (line.startsWith("--- ")) {
        continue;
      }
      continue;
    }
    if (line.startsWith("+")) {
      currentNewLine++;
      result.push({
        type: "add",
        newLine: currentNewLine,
        content: line.substring(1)
      });
    } else if (line.startsWith("-")) {
      currentOldLine++;
      result.push({
        type: "del",
        oldLine: currentOldLine,
        content: line.substring(1)
      });
    } else if (line.startsWith(" ")) {
      currentOldLine++;
      currentNewLine++;
      result.push({
        type: "context",
        oldLine: currentOldLine,
        newLine: currentNewLine,
        content: line.substring(1)
      });
    } else if (line.startsWith("\\")) {
      result.push({ type: "other", content: line });
    }
  }
  return result;
}
__name(parseDiffWithLineNumbers, "parseDiffWithLineNumbers");
var DEFAULT_TAB_WIDTH = 4;
var DiffRenderer = /* @__PURE__ */ __name(({
  diffContent,
  filename,
  tabWidth = DEFAULT_TAB_WIDTH,
  availableTerminalHeight,
  contentWidth,
  theme: theme2,
  settings
}) => {
  const screenReaderEnabled = use_is_screen_reader_enabled_default();
  if (!diffContent || typeof diffContent !== "string") {
    return /* @__PURE__ */ (0, import_jsx_runtime6.jsx)(Text, { color: theme.status.warning, children: "No diff content." });
  }
  const parsedLines = parseDiffWithLineNumbers(diffContent);
  if (parsedLines.length === 0) {
    return /* @__PURE__ */ (0, import_jsx_runtime6.jsx)(
      Box_default,
      {
        borderStyle: "round",
        borderColor: theme.border.default,
        padding: 1,
        children: /* @__PURE__ */ (0, import_jsx_runtime6.jsx)(Text, { dimColor: true, children: "No changes detected." })
      }
    );
  }
  if (screenReaderEnabled) {
    return /* @__PURE__ */ (0, import_jsx_runtime6.jsx)(Box_default, { flexDirection: "column", children: parsedLines.map((line, index) => /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)(Text, { children: [
      line.type,
      ": ",
      line.content
    ] }, index)) });
  }
  const isNewFile = parsedLines.every(
    (line) => line.type === "add" || line.type === "hunk" || line.type === "other" || line.content.startsWith("diff --git") || line.content.startsWith("new file mode")
  );
  let renderedOutput;
  if (isNewFile) {
    const addedContent = parsedLines.filter((line) => line.type === "add").map((line) => line.content).join("\n");
    const fileExtension = filename?.split(".").pop() || null;
    const language = fileExtension ? getLanguageFromExtension(fileExtension) : null;
    renderedOutput = colorizeCode(
      addedContent,
      language,
      availableTerminalHeight,
      contentWidth,
      { theme: theme2, settings, tabWidth }
    );
  } else {
    renderedOutput = renderDiffContent(
      parsedLines,
      filename,
      tabWidth,
      availableTerminalHeight,
      contentWidth,
      settings
    );
  }
  return renderedOutput;
}, "DiffRenderer");
var renderDiffContent = /* @__PURE__ */ __name((parsedLines, filename, tabWidth = DEFAULT_TAB_WIDTH, availableTerminalHeight, contentWidth, settings) => {
  const normalizedLines = parsedLines.map((line) => ({
    ...line,
    content: line.content.replace(/\t/g, " ".repeat(tabWidth))
  }));
  const displayableLines = normalizedLines.filter(
    (l) => l.type !== "hunk" && l.type !== "other"
  );
  if (displayableLines.length === 0) {
    return /* @__PURE__ */ (0, import_jsx_runtime6.jsx)(
      Box_default,
      {
        borderStyle: "round",
        borderColor: theme.border.default,
        padding: 1,
        children: /* @__PURE__ */ (0, import_jsx_runtime6.jsx)(Text, { dimColor: true, children: "No changes detected." })
      }
    );
  }
  const showLineNumbers = settings?.merged.ui?.showLineNumbers ?? true;
  const maxLineNumber = Math.max(
    0,
    ...displayableLines.map((l) => l.oldLine ?? 0),
    ...displayableLines.map((l) => l.newLine ?? 0)
  );
  const gutterWidth = Math.max(1, maxLineNumber.toString().length);
  const fileExtension = filename?.split(".").pop() || null;
  const language = fileExtension ? getLanguageFromExtension(fileExtension) : null;
  let baseIndentation = Infinity;
  for (const line of displayableLines) {
    if (line.content.trim() === "") continue;
    const firstCharIndex = line.content.search(/\S/);
    const currentIndent = firstCharIndex === -1 ? 0 : firstCharIndex;
    baseIndentation = Math.min(baseIndentation, currentIndent);
  }
  if (!isFinite(baseIndentation)) {
    baseIndentation = 0;
  }
  const key = filename ? `diff-box-${filename}` : `diff-box-${crypto.createHash("sha1").update(JSON.stringify(parsedLines)).digest("hex")}`;
  let lastLineNumber = null;
  const MAX_CONTEXT_LINES_WITHOUT_GAP = 5;
  return /* @__PURE__ */ (0, import_jsx_runtime6.jsx)(
    MaxSizedBox,
    {
      maxHeight: availableTerminalHeight,
      maxWidth: contentWidth,
      children: displayableLines.reduce((acc, line, index) => {
        let relevantLineNumberForGapCalc = null;
        if (line.type === "add" || line.type === "context") {
          relevantLineNumberForGapCalc = line.newLine ?? null;
        } else if (line.type === "del") {
          relevantLineNumberForGapCalc = line.oldLine ?? null;
        }
        if (lastLineNumber !== null && relevantLineNumberForGapCalc !== null && relevantLineNumberForGapCalc > lastLineNumber + MAX_CONTEXT_LINES_WITHOUT_GAP + 1) {
          acc.push(
            /* @__PURE__ */ (0, import_jsx_runtime6.jsx)(Box_default, { children: /* @__PURE__ */ (0, import_jsx_runtime6.jsx)(Text, { wrap: "truncate", color: theme.text.secondary, children: "\u2550".repeat(contentWidth) }) }, `gap-${index}`)
          );
        }
        const lineKey = `diff-line-${index}`;
        let gutterNumStr = "";
        let prefixSymbol = " ";
        switch (line.type) {
          case "add":
            gutterNumStr = (line.newLine ?? "").toString();
            prefixSymbol = "+";
            lastLineNumber = line.newLine ?? null;
            break;
          case "del":
            gutterNumStr = (line.oldLine ?? "").toString();
            prefixSymbol = "-";
            if (line.oldLine !== void 0) {
              lastLineNumber = line.oldLine;
            }
            break;
          case "context":
            gutterNumStr = (line.newLine ?? "").toString();
            prefixSymbol = " ";
            lastLineNumber = line.newLine ?? null;
            break;
          default:
            return acc;
        }
        const displayContent = line.content.substring(baseIndentation);
        acc.push(
          /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)(Box_default, { flexDirection: "row", children: [
            showLineNumbers && /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)(
              Text,
              {
                selectable: false,
                color: theme.text.secondary,
                backgroundColor: line.type === "add" ? theme.background.diff.added : line.type === "del" ? theme.background.diff.removed : void 0,
                children: [
                  gutterNumStr.padStart(gutterWidth),
                  " "
                ]
              }
            ),
            line.type === "context" ? /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)(import_jsx_runtime6.Fragment, { children: [
              /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)(Text, { children: [
                prefixSymbol,
                " "
              ] }),
              /* @__PURE__ */ (0, import_jsx_runtime6.jsx)(Text, { wrap: "wrap", children: colorizeLine(displayContent, language) })
            ] }) : /* @__PURE__ */ (0, import_jsx_runtime6.jsxs)(
              Text,
              {
                backgroundColor: line.type === "add" ? theme.background.diff.added : theme.background.diff.removed,
                wrap: "wrap",
                children: [
                  /* @__PURE__ */ (0, import_jsx_runtime6.jsx)(
                    Text,
                    {
                      color: line.type === "add" ? theme.status.success : theme.status.error,
                      children: prefixSymbol
                    }
                  ),
                  " ",
                  colorizeLine(displayContent, language)
                ]
              }
            )
          ] }, lineKey)
        );
        return acc;
      }, [])
    },
    key
  );
}, "renderDiffContent");
var getLanguageFromExtension = /* @__PURE__ */ __name((extension) => {
  const languageMap = {
    js: "javascript",
    ts: "typescript",
    py: "python",
    json: "json",
    css: "css",
    html: "html",
    sh: "bash",
    md: "markdown",
    yaml: "yaml",
    yml: "yaml",
    txt: "plaintext",
    java: "java",
    c: "c",
    cpp: "cpp",
    rb: "ruby"
  };
  return languageMap[extension] || null;
}, "getLanguageFromExtension");

// packages/cli/src/ui/utils/MarkdownDisplay.tsx
init_esbuild_shims();
var import_react14 = __toESM(require_react(), 1);

// packages/cli/src/ui/utils/TableRenderer.tsx
init_esbuild_shims();

// packages/cli/src/ui/utils/pending-rendered-height.ts
init_esbuild_shims();
var TABLE_CHROME_ROWS = 5;
var TABLE_MAX_ROW_LINES = 4;
var TABLE_ROW_RE = /^\s*\|(.+)\|\s*$/;
var TABLE_SEPARATOR_RE = /^(?=.*\|)\s*\|?\s*(:?-+:?)\s*(\|\s*(:?-+:?)\s*)*\|?\s*$/;
var CODE_FENCE_RE = /^ *(`{3,}|~{3,}) *([^`]*)$/;
function readTableInlineMathSpan(row, index) {
  return readInlineMathSpanAt(row, index);
}
__name(readTableInlineMathSpan, "readTableInlineMathSpan");
function splitMarkdownTableRow(row) {
  const cells = [];
  let current = "";
  let activeCodeFenceLength = 0;
  for (let index = 0; index < row.length; index++) {
    const char = row[index];
    if (char === "\\") {
      const next = row[index + 1];
      if (next === "|") {
        current += "|";
        index += 1;
        continue;
      }
      current += char;
      continue;
    }
    if (char === "`") {
      let runLength = 1;
      while (row[index + runLength] === "`") {
        runLength += 1;
      }
      if (activeCodeFenceLength === 0) {
        activeCodeFenceLength = runLength;
      } else if (runLength === activeCodeFenceLength) {
        activeCodeFenceLength = 0;
      }
      current += "`".repeat(runLength);
      index += runLength - 1;
      continue;
    }
    if (char === "$" && activeCodeFenceLength === 0) {
      const mathSpan = readTableInlineMathSpan(row, index);
      if (mathSpan) {
        current += mathSpan;
        index += mathSpan.length - 1;
        continue;
      }
    }
    if (char === "|" && activeCodeFenceLength === 0) {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  cells.push(current.trim());
  return cells;
}
__name(splitMarkdownTableRow, "splitMarkdownTableRow");
function estimateWrappedRows(line, width) {
  if (width <= 0) return 1;
  return Math.max(1, Math.ceil(getCachedStringWidth(line) / width));
}
__name(estimateWrappedRows, "estimateWrappedRows");
function isTableStart(lines, i) {
  const header = lines[i];
  if (header === void 0 || i + 1 >= lines.length) return false;
  const headerMatch = TABLE_ROW_RE.exec(header);
  if (!headerMatch) return false;
  const separator = lines[i + 1];
  if (!TABLE_SEPARATOR_RE.test(separator)) return false;
  const headerCols = splitMarkdownTableRow(headerMatch[1]).length;
  const sepCols = splitMarkdownTableRow(separator).filter(
    (cell) => cell.length > 0
  ).length;
  return headerCols === sepCols;
}
__name(isTableStart, "isTableStart");
function fitPendingSlice(allLines, contentWidth, budget, tableClampRows) {
  let rendered = 0;
  let kept = allLines.length;
  let codeFence = "";
  for (let i = 0; i < allLines.length; ) {
    const line = allLines[i];
    const fenceMatch = CODE_FENCE_RE.exec(line);
    if (codeFence) {
      if (fenceMatch && fenceMatch[1].startsWith(codeFence[0]) && fenceMatch[1].length >= codeFence.length) {
        codeFence = "";
      }
      rendered += estimateWrappedRows(line, contentWidth);
      if (rendered > budget) {
        kept = i;
        break;
      }
      i++;
      continue;
    }
    if (fenceMatch) {
      codeFence = fenceMatch[1];
      rendered += estimateWrappedRows(line, contentWidth);
      if (rendered > budget) {
        kept = i;
        break;
      }
      i++;
      continue;
    }
    if (isTableStart(allLines, i)) {
      let j = i + 2;
      while (j < allLines.length && TABLE_ROW_RE.test(allLines[j])) j++;
      const dataRows = j - (i + 2);
      const headerCells = splitMarkdownTableRow(
        TABLE_ROW_RE.exec(allLines[i])[1]
      );
      const colCount = headerCells.length;
      const minHorizontalWidth = Math.max(24, 6 * colCount + 5);
      const perColWidth = Math.max(
        3,
        Math.floor((contentWidth - (1 + 3 * colCount) - 4) / colCount)
      );
      let contentRows = 0;
      let verticalRows = 0;
      let maxRowLines = 1;
      for (const label of headerCells) {
        maxRowLines = Math.max(
          maxRowLines,
          estimateWrappedRows(label, perColWidth)
        );
      }
      contentRows += maxRowLines;
      for (let r = i + 2; r < j; r++) {
        const cells = splitMarkdownTableRow(
          TABLE_ROW_RE.exec(allLines[r])[1]
        );
        let rowMax = 1;
        for (let colIdx = 0; colIdx < cells.length; colIdx++) {
          const value = cells[colIdx];
          rowMax = Math.max(rowMax, estimateWrappedRows(value, perColWidth));
          const label = headerCells[colIdx] ?? "";
          verticalRows += estimateWrappedRows(
            label ? `${label}: ${value}` : value,
            contentWidth
          );
        }
        contentRows += rowMax;
        if (r === i + 2) {
          maxRowLines = Math.max(maxRowLines, rowMax);
        }
      }
      const usesVertical = dataRows > 0 && (contentWidth < minHorizontalWidth || maxRowLines > TABLE_MAX_ROW_LINES);
      const rows = usesVertical ? verticalRows + Math.max(0, dataRows - 1) + 2 : contentRows + Math.max(0, dataRows - 1) + TABLE_CHROME_ROWS;
      const cost = Math.min(rows, tableClampRows + 2);
      if (rendered + cost > budget && i > 0) {
        kept = i;
        break;
      }
      rendered += cost;
      i = j;
      if (rendered >= budget) {
        kept = j;
        break;
      }
    } else {
      rendered += estimateWrappedRows(line, contentWidth);
      if (rendered > budget) {
        kept = i;
        break;
      }
      i++;
    }
  }
  return { keptLines: kept, clipped: kept < allLines.length };
}
__name(fitPendingSlice, "fitPendingSlice");

// packages/cli/src/ui/utils/latexRenderer.ts
init_esbuild_shims();
var COMMAND_REPLACEMENTS = {
  "\\alpha": "\u03B1",
  "\\beta": "\u03B2",
  "\\gamma": "\u03B3",
  "\\delta": "\u03B4",
  "\\epsilon": "\u03B5",
  "\\varepsilon": "\u03B5",
  "\\theta": "\u03B8",
  "\\lambda": "\u03BB",
  "\\mu": "\u03BC",
  "\\pi": "\u03C0",
  "\\rho": "\u03C1",
  "\\sigma": "\u03C3",
  "\\tau": "\u03C4",
  "\\phi": "\u03C6",
  "\\varphi": "\u03C6",
  "\\omega": "\u03C9",
  "\\Gamma": "\u0393",
  "\\Delta": "\u0394",
  "\\Theta": "\u0398",
  "\\Lambda": "\u039B",
  "\\Pi": "\u03A0",
  "\\Sigma": "\u03A3",
  "\\Phi": "\u03A6",
  "\\Omega": "\u03A9",
  "\\sum": "\u03A3",
  "\\prod": "\u220F",
  "\\int": "\u222B",
  "\\infty": "\u221E",
  "\\partial": "\u2202",
  "\\sqrt": "\u221A",
  "\\times": "\xD7",
  "\\cdot": "\xB7",
  "\\pm": "\xB1",
  "\\leq": "\u2264",
  "\\geq": "\u2265",
  "\\neq": "\u2260",
  "\\approx": "\u2248",
  "\\rightarrow": "\u2192",
  "\\to": "\u2192",
  "\\leftarrow": "\u2190",
  "\\Rightarrow": "\u21D2",
  "\\Leftarrow": "\u21D0"
};
var COMMAND_REPLACEMENT_REGEX = new RegExp(
  Object.keys(COMMAND_REPLACEMENTS).sort((a, b) => b.length - a.length).map((command) => command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
  "g"
);
var MAX_RENDER_DEPTH = 10;
var SUPERSCRIPT = {
  "0": "\u2070",
  "1": "\xB9",
  "2": "\xB2",
  "3": "\xB3",
  "4": "\u2074",
  "5": "\u2075",
  "6": "\u2076",
  "7": "\u2077",
  "8": "\u2078",
  "9": "\u2079",
  "+": "\u207A",
  "-": "\u207B",
  "=": "\u207C",
  "(": "\u207D",
  ")": "\u207E",
  n: "\u207F",
  i: "\u2071"
};
var SUBSCRIPT = {
  "0": "\u2080",
  "1": "\u2081",
  "2": "\u2082",
  "3": "\u2083",
  "4": "\u2084",
  "5": "\u2085",
  "6": "\u2086",
  "7": "\u2087",
  "8": "\u2088",
  "9": "\u2089",
  "+": "\u208A",
  "-": "\u208B",
  "=": "\u208C",
  "(": "\u208D",
  ")": "\u208E",
  a: "\u2090",
  e: "\u2091",
  h: "\u2095",
  i: "\u1D62",
  j: "\u2C7C",
  k: "\u2096",
  l: "\u2097",
  m: "\u2098",
  n: "\u2099",
  o: "\u2092",
  p: "\u209A",
  r: "\u1D63",
  s: "\u209B",
  t: "\u209C",
  u: "\u1D64",
  v: "\u1D65",
  x: "\u2093"
};
function convertScript(value, map) {
  return [...value].map((char) => map[char] ?? char).join("");
}
__name(convertScript, "convertScript");
function findBalancedGroup(input, openBraceIndex) {
  if (input[openBraceIndex] !== "{") {
    return null;
  }
  let depth = 0;
  for (let index = openBraceIndex; index < input.length; index++) {
    const char = input[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char !== "}") {
      continue;
    }
    depth -= 1;
    if (depth === 0) {
      return {
        value: input.slice(openBraceIndex + 1, index),
        end: index + 1
      };
    }
  }
  return null;
}
__name(findBalancedGroup, "findBalancedGroup");
function replaceBraceCommand(input, command, groupCount, render) {
  const marker = `\\${command}`;
  let output = "";
  let index = 0;
  while (index < input.length) {
    if (!input.startsWith(marker, index)) {
      output += input[index];
      index += 1;
      continue;
    }
    const groups = [];
    let cursor = index + marker.length;
    for (let groupIndex = 0; groupIndex < groupCount; groupIndex++) {
      const group = findBalancedGroup(input, cursor);
      if (!group) {
        groups.length = 0;
        break;
      }
      groups.push(group.value);
      cursor = group.end;
    }
    if (groups.length !== groupCount) {
      output += input[index];
      index += 1;
      continue;
    }
    output += render(groups);
    index = cursor;
  }
  return output;
}
__name(replaceBraceCommand, "replaceBraceCommand");
function renderInlineLatex(input, depth = 0) {
  let output = input.trim();
  if (depth > MAX_RENDER_DEPTH) {
    return output;
  }
  output = replaceBraceCommand(
    output,
    "frac",
    2,
    ([numerator, denominator]) => `${renderInlineLatex(numerator ?? "", depth + 1)}/${renderInlineLatex(
      denominator ?? "",
      depth + 1
    )}`
  );
  output = replaceBraceCommand(
    output,
    "sqrt",
    1,
    ([radicand]) => `\u221A(${renderInlineLatex(radicand ?? "", depth + 1)})`
  );
  output = output.replace(
    /\^\{([^{}]+)\}|\^([A-Za-z0-9+\-=()])/g,
    (_match, braced, single) => convertScript(braced ?? single ?? "", SUPERSCRIPT)
  );
  output = output.replace(
    /_\{([^{}]+)\}|_([A-Za-z0-9+\-=()])/g,
    (_match, braced, single) => convertScript(braced ?? single ?? "", SUBSCRIPT)
  );
  output = output.replace(
    COMMAND_REPLACEMENT_REGEX,
    (command) => COMMAND_REPLACEMENTS[command] ?? command
  );
  return output.replace(/\\(?:left|right)\./g, "").replace(/\\left|\\right/g, "").replace(/\\,/g, " ").replace(/\s+/g, " ").trim();
}
__name(renderInlineLatex, "renderInlineLatex");

// packages/cli/src/ui/utils/TableRenderer.tsx
var import_jsx_runtime7 = __toESM(require_jsx_runtime(), 1);
var MIN_COLUMN_WIDTH = 3;
var ABSOLUTE_MIN_HORIZONTAL_TABLE_WIDTH = 24;
var SAFETY_MARGIN = 4;
var INLINE_MARKDOWN_REGEX = new RegExp(
  String.raw`(\*\*.*?\*\*|\*.*?\*|(?<![\w\u3400-\u9fff])_(?!_)[^_]*_(?![\w\u3400-\u9fff])|~~.*?~~|${MD_LINK_PATTERN}|` + String.raw`${INLINE_CODE_SPAN_PATTERN_SOURCE}|<u>.*?<\/u>|${BARE_URL_PATTERN})`,
  "g"
);
var INK_COLOR_TO_ANSI = {
  black: 30,
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  cyan: 36,
  white: 37,
  gray: 90,
  grey: 90,
  blackbright: 90,
  redbright: 91,
  greenbright: 92,
  yellowbright: 93,
  bluebright: 94,
  magentabright: 95,
  cyanbright: 96,
  whitebright: 97
};
var HEX_COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
var ESC = "\x1B";
function getColorCode(color) {
  if (!color) return "";
  if (color.startsWith("#")) {
    if (!HEX_COLOR_RE.test(color)) return "";
    const hex = color.length === 4 ? color[1] + color[1] + color[2] + color[2] + color[3] + color[3] : color.slice(1);
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return `\x1B[38;2;${r};${g};${b}m`;
  }
  const code = INK_COLOR_TO_ANSI[color.toLowerCase()];
  if (code !== void 0) return `\x1B[${code}m`;
  return "";
}
__name(getColorCode, "getColorCode");
function applyColor(text, color) {
  const code = getColorCode(color);
  if (!code) return text;
  return `${code}${text}\x1B[39m`;
}
__name(applyColor, "applyColor");
function recolorAfterResets(text, colorCode) {
  const fgReset = "\x1B[39m";
  const fullReset = "\x1B[0m";
  return text.split(fgReset).join(fgReset + colorCode).split(fullReset).join(fullReset + colorCode);
}
__name(recolorAfterResets, "recolorAfterResets");
function updateActiveForeground(activeForeground, paramsText) {
  const params = paramsText.length > 0 ? paramsText.split(";").map((param) => Number(param)) : [0];
  let foreground = activeForeground;
  for (let index = 0; index < params.length; index++) {
    const code = params[index];
    if (!Number.isFinite(code)) {
      continue;
    }
    if (code === 0 || code === 39) {
      foreground = "";
    } else if (code >= 30 && code <= 37 || code >= 90 && code <= 97) {
      foreground = `\x1B[${code}m`;
    } else if (code === 38) {
      const mode = params[index + 1];
      if (mode === 5 && Number.isFinite(params[index + 2])) {
        foreground = `\x1B[38;5;${params[index + 2]}m`;
        index += 2;
      } else if (mode === 2 && Number.isFinite(params[index + 2]) && Number.isFinite(params[index + 3]) && Number.isFinite(params[index + 4])) {
        foreground = `\x1B[38;2;${params[index + 2]};${params[index + 3]};${params[index + 4]}m`;
        index += 4;
      }
    }
  }
  return foreground;
}
__name(updateActiveForeground, "updateActiveForeground");
function readSgrSequence(text, index) {
  if (text[index] !== ESC || text[index + 1] !== "[") {
    return null;
  }
  const endIndex = text.indexOf("m", index + 2);
  if (endIndex === -1) {
    return null;
  }
  const paramsText = text.slice(index + 2, endIndex);
  if (!/^[0-9;]*$/.test(paramsText)) {
    return null;
  }
  return {
    sequence: text.slice(index, endIndex + 1),
    paramsText,
    endIndex
  };
}
__name(readSgrSequence, "readSgrSequence");
function preserveForegroundAcrossLineBreaks(text) {
  let activeForeground = "";
  let result = "";
  let lastIndex = 0;
  let index = 0;
  while (index < text.length) {
    const sgr = readSgrSequence(text, index);
    if (!sgr) {
      index += 1;
      continue;
    }
    const segment2 = text.slice(lastIndex, index);
    result += activeForeground ? segment2.replace(/\n/g, `\x1B[39m
${activeForeground}`) : segment2;
    result += sgr.sequence;
    activeForeground = updateActiveForeground(activeForeground, sgr.paramsText);
    index = sgr.endIndex + 1;
    lastIndex = index;
  }
  const segment = text.slice(lastIndex);
  result += activeForeground ? segment.replace(/\n/g, `\x1B[39m
${activeForeground}`) : segment;
  return result;
}
__name(preserveForegroundAcrossLineBreaks, "preserveForegroundAcrossLineBreaks");
var ansiFmt = {
  bold: /* @__PURE__ */ __name((t2) => `\x1B[1m${t2}\x1B[22m`, "bold"),
  italic: /* @__PURE__ */ __name((t2) => `\x1B[3m${t2}\x1B[23m`, "italic"),
  underline: /* @__PURE__ */ __name((t2) => `\x1B[4m${t2}\x1B[24m`, "underline"),
  strikethrough: /* @__PURE__ */ __name((t2) => `\x1B[9m${t2}\x1B[29m`, "strikethrough")
};
function renderMarkdownToAnsi(text, enableInlineMath = false) {
  const canHyperlink = supportsHyperlinks();
  let result = "";
  let lastIndex = 0;
  for (const token of mergeInlineMathMatches(
    text,
    INLINE_MARKDOWN_REGEX,
    enableInlineMath
  )) {
    const index = token.kind === "math" ? token.span.index : token.match.index ?? 0;
    const prose = text.slice(lastIndex, index);
    result += token.kind === "math" ? unescapeMarkdownBeforeMath(prose) : unescapeMarkdownDollars(prose);
    if (token.kind === "math") {
      result += applyColor(
        renderInlineLatex(unescapeMarkdownDollars(token.span.content)),
        theme.text.accent
      );
      lastIndex = index + token.span.raw.length;
      continue;
    }
    const match = token.match;
    const fullMatch = match[0];
    let rendered = null;
    if (fullMatch.startsWith("**") && fullMatch.endsWith("**") && fullMatch.length > 4) {
      rendered = ansiFmt.bold(unescapeMarkdownDollars(fullMatch.slice(2, -2)));
    } else if (fullMatch.length > 2 && (fullMatch.startsWith("*") && fullMatch.endsWith("*") || fullMatch.startsWith("_") && fullMatch.endsWith("_")) && !/\w/.test(text.substring(index - 1, index)) && !/\w/.test(
      text.substring(index + fullMatch.length, index + fullMatch.length + 1)
    ) && !/\S[./\\]/.test(text.substring(index - 2, index)) && !/[./\\]\S/.test(
      text.substring(index + fullMatch.length, index + fullMatch.length + 2)
    )) {
      rendered = ansiFmt.italic(
        unescapeMarkdownDollars(fullMatch.slice(1, -1))
      );
    } else if (fullMatch.startsWith("~~") && fullMatch.endsWith("~~") && fullMatch.length > 4) {
      rendered = ansiFmt.strikethrough(
        unescapeMarkdownDollars(fullMatch.slice(2, -2))
      );
    } else if (fullMatch.startsWith("`") && fullMatch.endsWith("`") && fullMatch.length > 1) {
      const codeMatch = fullMatch.match(/^(`+)(.+?)\1$/s);
      if (codeMatch?.[2]) {
        rendered = applyColor(codeMatch[2], theme.text.code);
      }
    } else if (fullMatch.startsWith("[") && fullMatch.includes("](") && fullMatch.endsWith(")")) {
      const linkMatch = fullMatch.match(MD_LINK_CAPTURE);
      if (linkMatch) {
        const labelText = unescapeMarkdownDollars(linkMatch[1] ?? "");
        const url = linkMatch[2] ?? "";
        if (shouldWrapMarkdownLink(url, canHyperlink)) {
          const safeLabel = sanitizeForOsc(labelText);
          const safeUrl = sanitizeForOsc(url);
          const visibleLabel = applyColor(
            safeLabel || safeUrl,
            theme.text.link
          );
          const envelope = `${osc8Open(url)}${visibleLabel}${osc8Close()}`;
          rendered = labelMayDeceive(safeLabel, safeUrl) ? `${envelope} ${applyColor(`(${safeUrl})`, theme.text.link)}` : envelope;
        } else {
          rendered = `${labelText} ${applyColor(`(${url})`, theme.text.link)}`;
        }
      }
    } else if (fullMatch.startsWith("<u>") && fullMatch.endsWith("</u>") && fullMatch.length > 7) {
      rendered = ansiFmt.underline(
        unescapeMarkdownDollars(fullMatch.slice(3, -4))
      );
    } else if (/^https?:\/\//.test(fullMatch)) {
      const visible = applyColor(fullMatch, theme.text.link);
      if (canHyperlink) {
        const trimmedUrl = trimTrailingUrlPunctuation(
          fullMatch,
          text[index + fullMatch.length]
        );
        rendered = isSafeOscScheme(trimmedUrl) ? `${osc8Open(trimmedUrl)}${visible}${osc8Close()}` : visible;
      } else {
        rendered = visible;
      }
    }
    result += rendered ?? unescapeMarkdownDollars(fullMatch);
    lastIndex = index + fullMatch.length;
  }
  result += unescapeMarkdownDollars(text.slice(lastIndex));
  return result;
}
__name(renderMarkdownToAnsi, "renderMarkdownToAnsi");
function padAligned(content, displayWidth, targetWidth, align) {
  const padding = Math.max(0, targetWidth - displayWidth);
  if (align === "center") {
    const leftPad = Math.floor(padding / 2);
    return " ".repeat(leftPad) + content + " ".repeat(padding - leftPad);
  }
  if (align === "right") {
    return " ".repeat(padding) + content;
  }
  return content + " ".repeat(padding);
}
__name(padAligned, "padAligned");
function wrapText(text, width, options) {
  if (width <= 0) return [text];
  const trimmedText = text.trimEnd();
  const wrapped = wrapAnsi(trimmedText, width, {
    hard: options?.hard ?? false,
    trim: false,
    wordWrap: true
  });
  const lines = preserveForegroundAcrossLineBreaks(wrapped).split("\n");
  while (lines.length > 1 && lines[lines.length - 1].length === 0) {
    lines.pop();
  }
  return lines.length > 0 ? lines : [""];
}
__name(wrapText, "wrapText");
var TableRenderer = /* @__PURE__ */ __name(({
  headers,
  rows,
  contentWidth,
  aligns,
  enableInlineMath = false,
  isStreaming = false,
  maxHeight
}) => {
  const colCount = headers.length;
  if (colCount === 0) {
    return /* @__PURE__ */ (0, import_jsx_runtime7.jsx)(Box_default, {});
  }
  const clampToMaxHeight = /* @__PURE__ */ __name((text) => {
    if (maxHeight === void 0) return text;
    const all = text.split("\n");
    if (all.length <= maxHeight) return text;
    const kept = all.slice(0, Math.max(1, maxHeight - 1));
    kept.push(applyColor("\u2026 more rows streaming \u2026", theme.text.secondary));
    return kept.join("\n");
  }, "clampToMaxHeight");
  const computeMetrics = /* @__PURE__ */ __name((text) => {
    const rendered = renderMarkdownToAnsi(text, enableInlineMath);
    const visible = stripAnsi(rendered);
    const words = visible.split(/\s+/).filter((w) => w.length > 0);
    return {
      rendered,
      renderedWidth: getCachedStringWidth(visible),
      minWordWidth: words.length > 0 ? Math.max(
        ...words.map((w) => getCachedStringWidth(w)),
        MIN_COLUMN_WIDTH
      ) : MIN_COLUMN_WIDTH
    };
  }, "computeMetrics");
  const headerMetrics = headers.map((h) => computeMetrics(h));
  const rowMetrics = rows.map(
    (row) => Array.from({ length: colCount }, (_, i) => computeMetrics(row[i] || ""))
  );
  const minColumnWidths = headers.map((_, colIndex) => {
    let maxMin = headerMetrics[colIndex].minWordWidth;
    for (const row of rowMetrics) {
      maxMin = Math.max(maxMin, row[colIndex].minWordWidth);
    }
    return maxMin;
  });
  const idealWidths = headers.map((_, colIndex) => {
    let maxIdeal = Math.max(
      headerMetrics[colIndex].renderedWidth,
      MIN_COLUMN_WIDTH
    );
    for (const row of rowMetrics) {
      maxIdeal = Math.max(maxIdeal, row[colIndex].renderedWidth);
    }
    return maxIdeal;
  });
  const borderOverhead = 1 + colCount * 3;
  const availableWidth = Math.max(
    contentWidth - borderOverhead - SAFETY_MARGIN,
    colCount * MIN_COLUMN_WIDTH
  );
  const totalMin = minColumnWidths.reduce((sum, w) => sum + w, 0);
  const totalIdeal = idealWidths.reduce((sum, w) => sum + w, 0);
  let needsHardWrap = false;
  let columnWidths;
  if (totalIdeal <= availableWidth) {
    columnWidths = idealWidths;
  } else if (totalMin <= availableWidth) {
    const extraSpace = availableWidth - totalMin;
    const overflows = idealWidths.map(
      (ideal, i) => ideal - minColumnWidths[i]
    );
    const totalOverflow = overflows.reduce((sum, o) => sum + o, 0);
    columnWidths = minColumnWidths.map((min, i) => {
      if (totalOverflow === 0) return min;
      const extra = Math.floor(overflows[i] / totalOverflow * extraSpace);
      return min + extra;
    });
  } else {
    needsHardWrap = true;
    const scaleFactor = availableWidth / totalMin;
    columnWidths = minColumnWidths.map(
      (w) => Math.max(Math.floor(w * scaleFactor), MIN_COLUMN_WIDTH)
    );
    let excess = columnWidths.reduce((s, w) => s + w, 0) - availableWidth;
    while (excess > 0) {
      const maxW = Math.max(...columnWidths);
      if (maxW <= MIN_COLUMN_WIDTH) break;
      const idx = columnWidths.indexOf(maxW);
      const reduction = Math.min(excess, maxW - MIN_COLUMN_WIDTH);
      columnWidths[idx] = maxW - reduction;
      excess -= reduction;
    }
  }
  function calculateMaxRowLines() {
    let maxLines = 1;
    const rowsToMeasure = isStreaming ? rowMetrics.slice(0, 1) : rowMetrics;
    for (let i = 0; i < colCount; i++) {
      const headerWrapped = wrapText(
        headerMetrics[i].rendered,
        columnWidths[i],
        {
          hard: needsHardWrap
        }
      );
      maxLines = Math.max(maxLines, headerWrapped.length);
    }
    for (const row of rowsToMeasure) {
      for (let i = 0; i < colCount; i++) {
        const cellWrapped = wrapText(row[i].rendered, columnWidths[i], {
          hard: needsHardWrap
        });
        maxLines = Math.max(maxLines, cellWrapped.length);
      }
    }
    return maxLines;
  }
  __name(calculateMaxRowLines, "calculateMaxRowLines");
  const maxRowLines = calculateMaxRowLines();
  const minHorizontalTableWidth = Math.max(
    ABSOLUTE_MIN_HORIZONTAL_TABLE_WIDTH,
    colCount * MIN_COLUMN_WIDTH + borderOverhead + SAFETY_MARGIN
  );
  const useVerticalFormat = rowMetrics.length > 0 && (contentWidth < minHorizontalTableWidth || maxRowLines > TABLE_MAX_ROW_LINES);
  const getAlign = /* @__PURE__ */ __name((colIndex) => aligns?.[colIndex] ?? "left", "getAlign");
  function renderBorderLine(type) {
    const [left, mid, cross, right] = {
      top: ["\u250C", "\u2500", "\u252C", "\u2510"],
      middle: ["\u251C", "\u2500", "\u253C", "\u2524"],
      bottom: ["\u2514", "\u2500", "\u2534", "\u2518"]
    }[type];
    let line = left;
    columnWidths.forEach((width, colIndex) => {
      line += mid.repeat(width + 2);
      line += colIndex < columnWidths.length - 1 ? cross : right;
    });
    return applyColor(line, theme.border.default);
  }
  __name(renderBorderLine, "renderBorderLine");
  function renderRowLines(renderedCells, isHeader) {
    const cellLines = renderedCells.map(
      (cell, colIndex) => wrapText(cell, columnWidths[colIndex], { hard: needsHardWrap })
    );
    const maxLines = Math.max(...cellLines.map((l) => l.length), 1);
    const offsets = cellLines.map((l) => Math.floor((maxLines - l.length) / 2));
    const borderPipe = applyColor("\u2502", theme.border.default);
    const result = [];
    for (let lineIdx = 0; lineIdx < maxLines; lineIdx++) {
      let line = borderPipe;
      for (let colIndex = 0; colIndex < colCount; colIndex++) {
        const lines = cellLines[colIndex];
        const offset = offsets[colIndex];
        const contentLineIdx = lineIdx - offset;
        const lineText = contentLineIdx >= 0 && contentLineIdx < lines.length ? lines[contentLineIdx] : "";
        const width = columnWidths[colIndex];
        const displayWidth = getCachedStringWidth(stripAnsi(lineText));
        const align = aligns?.[colIndex] != null ? getAlign(colIndex) : isHeader ? "center" : "left";
        const padded = padAligned(lineText, displayWidth, width, align);
        if (isHeader) {
          const linkCode = getColorCode(theme.text.link);
          const recolored = linkCode ? recolorAfterResets(padded, linkCode) : padded;
          const styledPadded = applyColor(
            ansiFmt.bold(recolored),
            theme.text.link
          );
          line += " " + styledPadded + " " + borderPipe;
        } else {
          const primaryCode = getColorCode(theme.text.primary);
          const recolored = primaryCode ? recolorAfterResets(padded, primaryCode) : padded;
          const styledCell = primaryCode ? applyColor(recolored, theme.text.primary) : recolored;
          line += " " + styledCell + " " + borderPipe;
        }
      }
      result.push(line);
    }
    return result;
  }
  __name(renderRowLines, "renderRowLines");
  function renderVerticalFormat() {
    const lines = [];
    const separatorWidth = Math.max(Math.min(contentWidth - 1, 40), 0);
    const separator = separatorWidth > 0 ? "\u2500".repeat(separatorWidth) : "";
    rowMetrics.forEach((row, rowIndex) => {
      if (rowIndex > 0) {
        lines.push(separator);
      }
      for (let colIndex = 0; colIndex < colCount; colIndex++) {
        const rawLabel = headers[colIndex] ?? `Column ${colIndex + 1}`;
        const label = renderMarkdownToAnsi(rawLabel, enableInlineMath);
        const value = row[colIndex].rendered.trim().replace(/\n+/g, " ").replace(/\s+/g, " ").trim();
        const linkCode = getColorCode(theme.text.link);
        const recoloredLabel = linkCode ? recolorAfterResets(`${label}:`, linkCode) : `${label}:`;
        const primaryCode = getColorCode(theme.text.primary);
        const styledValue = primaryCode ? applyColor(
          recolorAfterResets(value, primaryCode),
          theme.text.primary
        ) : value;
        lines.push(
          `${applyColor(ansiFmt.bold(recoloredLabel), theme.text.link)} ${styledValue}`
        );
      }
    });
    return lines.join("\n");
  }
  __name(renderVerticalFormat, "renderVerticalFormat");
  if (useVerticalFormat) {
    return /* @__PURE__ */ (0, import_jsx_runtime7.jsx)(Box_default, { marginY: 1, children: /* @__PURE__ */ (0, import_jsx_runtime7.jsx)(Text, { children: clampToMaxHeight(renderVerticalFormat()) }) });
  }
  const headerRendered = headerMetrics.map((m) => m.rendered);
  const tableLines = [];
  tableLines.push(renderBorderLine("top"));
  tableLines.push(...renderRowLines(headerRendered, true));
  if (rowMetrics.length > 0) {
    tableLines.push(renderBorderLine("middle"));
    rowMetrics.forEach((row, rowIndex) => {
      tableLines.push(
        ...renderRowLines(
          row.map((m) => m.rendered),
          false
        )
      );
      if (rowIndex < rows.length - 1) {
        tableLines.push(renderBorderLine("middle"));
      }
    });
  }
  tableLines.push(renderBorderLine("bottom"));
  const maxLineWidth = Math.max(
    ...tableLines.map((line) => getCachedStringWidth(stripAnsi(line)))
  );
  if (rowMetrics.length > 0 && maxLineWidth > contentWidth - SAFETY_MARGIN) {
    return /* @__PURE__ */ (0, import_jsx_runtime7.jsx)(Box_default, { marginY: 1, children: /* @__PURE__ */ (0, import_jsx_runtime7.jsx)(Text, { children: clampToMaxHeight(renderVerticalFormat()) }) });
  }
  return /* @__PURE__ */ (0, import_jsx_runtime7.jsx)(Box_default, { flexDirection: "column", marginY: 1, children: /* @__PURE__ */ (0, import_jsx_runtime7.jsx)(Text, { children: clampToMaxHeight(tableLines.join("\n")) }) });
}, "TableRenderer");

// packages/cli/src/ui/utils/InlineMarkdownRenderer.tsx
init_esbuild_shims();
var import_react12 = __toESM(require_react(), 1);
var import_jsx_runtime8 = __toESM(require_jsx_runtime(), 1);
var BOLD_MARKER_LENGTH = 2;
var ITALIC_MARKER_LENGTH = 1;
var STRIKETHROUGH_MARKER_LENGTH = 2;
var INLINE_CODE_MARKER_LENGTH = 1;
var UNDERLINE_TAG_START_LENGTH = 3;
var UNDERLINE_TAG_END_LENGTH = 4;
var INLINE_MARKDOWN_REGEX2 = new RegExp(
  String.raw`(\*\*.*?\*\*|\*.*?\*|(?<![\w\u3400-\u9fff])_(?!_)[^_]*_(?![\w\u3400-\u9fff])|~~.*?~~|${MD_LINK_PATTERN}|` + String.raw`${INLINE_CODE_SPAN_PATTERN_SOURCE}|<u>.*?<\/u>|${BARE_URL_PATTERN})`,
  "g"
);
var debugLogger4 = createDebugLogger("INLINE_MARKDOWN");
var RenderInlineInternal = /* @__PURE__ */ __name(({
  text,
  textColor = theme.text.primary,
  enableInlineMath = false
}) => {
  if (!/[*_~`<[]|https?:/.test(text) && !(enableInlineMath && text.includes("$")) && !text.includes("\\$")) {
    return /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Text, { color: textColor, children: text });
  }
  const nodes = [];
  let lastIndex = 0;
  const canHyperlink = supportsHyperlinks();
  for (const token of mergeInlineMathMatches(
    text,
    INLINE_MARKDOWN_REGEX2,
    enableInlineMath
  )) {
    const index = token.kind === "math" ? token.span.index : token.match.index ?? 0;
    if (index > lastIndex) {
      const prose = text.slice(lastIndex, index);
      nodes.push(
        /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Text, { children: token.kind === "math" ? unescapeMarkdownBeforeMath(prose) : unescapeMarkdownDollars(prose) }, `t-${lastIndex}`)
      );
    }
    if (token.kind === "math") {
      nodes.push(
        /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Text, { color: theme.text.accent, children: renderInlineLatex(unescapeMarkdownDollars(token.span.content)) }, `m-${index}`)
      );
      lastIndex = index + token.span.raw.length;
      continue;
    }
    const match = token.match;
    const fullMatch = match[0];
    let renderedNode = null;
    const key = `m-${index}`;
    try {
      if (fullMatch.startsWith("**") && fullMatch.endsWith("**") && fullMatch.length > BOLD_MARKER_LENGTH * 2) {
        renderedNode = /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Text, { bold: true, children: unescapeMarkdownDollars(
          fullMatch.slice(BOLD_MARKER_LENGTH, -BOLD_MARKER_LENGTH)
        ) }, key);
      } else if (fullMatch.length > ITALIC_MARKER_LENGTH * 2 && (fullMatch.startsWith("*") && fullMatch.endsWith("*") || fullMatch.startsWith("_") && fullMatch.endsWith("_")) && !/\w/.test(text.substring(index - 1, index)) && !/\w/.test(
        text.substring(
          index + fullMatch.length,
          index + fullMatch.length + 1
        )
      ) && !/\S[./\\]/.test(text.substring(index - 2, index)) && !/[./\\]\S/.test(
        text.substring(
          index + fullMatch.length,
          index + fullMatch.length + 2
        )
      )) {
        renderedNode = /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Text, { italic: true, children: unescapeMarkdownDollars(
          fullMatch.slice(ITALIC_MARKER_LENGTH, -ITALIC_MARKER_LENGTH)
        ) }, key);
      } else if (fullMatch.startsWith("~~") && fullMatch.endsWith("~~") && fullMatch.length > STRIKETHROUGH_MARKER_LENGTH * 2) {
        renderedNode = /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Text, { strikethrough: true, children: unescapeMarkdownDollars(
          fullMatch.slice(
            STRIKETHROUGH_MARKER_LENGTH,
            -STRIKETHROUGH_MARKER_LENGTH
          )
        ) }, key);
      } else if (fullMatch.startsWith("`") && fullMatch.endsWith("`") && fullMatch.length > INLINE_CODE_MARKER_LENGTH) {
        const codeMatch = fullMatch.match(/^(`+)(.+?)\1$/s);
        if (codeMatch && codeMatch[2]) {
          renderedNode = /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Text, { color: theme.text.code, children: codeMatch[2] }, key);
        }
      } else if (fullMatch.startsWith("[") && fullMatch.includes("](") && fullMatch.endsWith(")")) {
        const linkMatch = fullMatch.match(MD_LINK_CAPTURE);
        if (linkMatch) {
          const linkText = linkMatch[1] ?? "";
          const url = linkMatch[2] ?? "";
          const wrapOsc8 = shouldWrapMarkdownLink(url, canHyperlink);
          const renderedLinkText = unescapeMarkdownDollars(linkText);
          const safeLabel = wrapOsc8 ? sanitizeForOsc(renderedLinkText) : renderedLinkText;
          const safeUrl = wrapOsc8 ? sanitizeForOsc(url) : url;
          const showUrlSuffix = wrapOsc8 && labelMayDeceive(safeLabel, safeUrl);
          renderedNode = wrapOsc8 ? /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)(Text, { children: [
            /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)(Text, { color: theme.text.link, children: [
              osc8Open(url),
              safeLabel || safeUrl,
              osc8Close()
            ] }),
            showUrlSuffix ? /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)(Text, { color: theme.text.link, children: [
              " (",
              safeUrl,
              ")"
            ] }) : null
          ] }, key) : /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)(Text, { children: [
            renderedLinkText,
            /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)(Text, { color: theme.text.link, children: [
              " (",
              url,
              ")"
            ] })
          ] }, key);
        }
      } else if (fullMatch.startsWith("<u>") && fullMatch.endsWith("</u>") && fullMatch.length > UNDERLINE_TAG_START_LENGTH + UNDERLINE_TAG_END_LENGTH - 1) {
        renderedNode = /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Text, { underline: true, children: unescapeMarkdownDollars(
          fullMatch.slice(
            UNDERLINE_TAG_START_LENGTH,
            -UNDERLINE_TAG_END_LENGTH
          )
        ) }, key);
      } else if (fullMatch.match(/^https?:\/\//)) {
        const trimmedUrl = canHyperlink ? trimTrailingUrlPunctuation(
          fullMatch,
          text[index + fullMatch.length]
        ) : fullMatch;
        const wrapOsc8 = canHyperlink && isSafeOscScheme(trimmedUrl);
        renderedNode = /* @__PURE__ */ (0, import_jsx_runtime8.jsxs)(Text, { color: theme.text.link, children: [
          wrapOsc8 ? osc8Open(trimmedUrl) : null,
          fullMatch,
          wrapOsc8 ? osc8Close() : null
        ] }, key);
      }
    } catch (e) {
      debugLogger4.error("Error parsing inline markdown part:", fullMatch, e);
      renderedNode = null;
    }
    nodes.push(
      renderedNode ?? /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Text, { children: unescapeMarkdownDollars(fullMatch) }, key)
    );
    lastIndex = index + fullMatch.length;
  }
  if (lastIndex < text.length) {
    nodes.push(
      /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(Text, { children: unescapeMarkdownDollars(text.slice(lastIndex)) }, `t-${lastIndex}`)
    );
  }
  return /* @__PURE__ */ (0, import_jsx_runtime8.jsx)(import_jsx_runtime8.Fragment, { children: nodes.filter((node) => node !== null) });
}, "RenderInlineInternal");
var RenderInline = import_react12.default.memo(RenderInlineInternal);

// packages/cli/src/ui/utils/MermaidDiagram.tsx
init_esbuild_shims();
var import_react13 = __toESM(require_react(), 1);

// packages/cli/src/ui/utils/mermaidVisualRenderer.ts
init_esbuild_shims();
var FLOW_START_RE = /^(?:flowchart|graph)\s+([A-Za-z]{2})/i;
var SEQUENCE_START_RE = /^sequenceDiagram\b/i;
var CLASS_START_RE = /^classDiagram(?:-v2)?\b/i;
var STATE_START_RE = /^stateDiagram(?:-v2)?\b/i;
var ER_START_RE = /^erDiagram\b/i;
var GANTT_START_RE = /^gantt\b/i;
var PIE_START_RE = /^pie\b/i;
var JOURNEY_START_RE = /^journey\b/i;
var GIT_GRAPH_START_RE = /^gitGraph\b/i;
var MINDMAP_START_RE = /^mindmap\b/i;
var REQUIREMENT_START_RE = /^requirementDiagram\b/i;
var LINE_COMMENT_RE = /^%%/;
var FLOW_ARROW_OPERATOR = String.fromCharCode(45, 45, 62);
var MAX_RENDERED_LINES = 80;
var MAX_FLOWCHART_PREVIEW_LINES = 120;
var MAX_FLOWCHART_PREVIEW_EDGES = 80;
var MAX_SEQUENCE_PREVIEW_LINES = 160;
var MAX_SEQUENCE_PREVIEW_MESSAGES = 80;
var MAX_GENERIC_PREVIEW_LINES = 80;
var MAX_SOURCE_FALLBACK_LINES = 80;
var MAX_PREVIEW_SOURCE_LINE_LENGTH = 1e3;
var MIN_CANVAS_WIDTH = 24;
var NODE_GAP_X = 4;
var NODE_GAP_Y = 4;
var FLOW_EDGE_OPERATOR_RE = new RegExp(
  String.raw`\s*(?:` + `${escapeRegExp(FLOW_ARROW_OPERATOR)}\\|([^|]+)\\|` + String.raw`|--\s+(.+?)\s+` + escapeRegExp(FLOW_ARROW_OPERATOR) + `|(?:${[FLOW_ARROW_OPERATOR, "---", "==>", "-.->", "--x", "--o"].map(escapeRegExp).join("|")}))` + String.raw`\s*`,
  "g"
);
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
__name(escapeRegExp, "escapeRegExp");
function truncateToWidth2(text, width) {
  if (width <= 0 || stringWidth(text) <= width) return text;
  let result = "";
  for (const char of text) {
    if (stringWidth(result + char + "\u2026") > width) break;
    result += char;
  }
  return result + "\u2026";
}
__name(truncateToWidth2, "truncateToWidth");
function center(text, width) {
  const padding = Math.max(0, width - stringWidth(text));
  const left = Math.floor(padding / 2);
  return " ".repeat(left) + text + " ".repeat(padding - left);
}
__name(center, "center");
function sanitizeTerminalText2(text) {
  let result = "";
  for (const char of stripAnsi(text)) {
    const code = char.charCodeAt(0);
    if (code <= 31 && code !== 10 || code === 127 || code >= 128 && code <= 159) {
      continue;
    }
    result += char;
  }
  return result;
}
__name(sanitizeTerminalText2, "sanitizeTerminalText");
function stripMermaidPunctuation(text) {
  return sanitizeTerminalText2(text).trim().replace(/[;,]+$/g, "").trim();
}
__name(stripMermaidPunctuation, "stripMermaidPunctuation");
function normalizePreviewLine(line) {
  const trimmed = sanitizeTerminalText2(line).trim();
  return trimmed.length > MAX_PREVIEW_SOURCE_LINE_LENGTH ? trimmed.slice(0, MAX_PREVIEW_SOURCE_LINE_LENGTH) : trimmed;
}
__name(normalizePreviewLine, "normalizePreviewLine");
function sanitizePreviewSourceLine(line) {
  const sanitized = sanitizeTerminalText2(line);
  return sanitized.length > MAX_PREVIEW_SOURCE_LINE_LENGTH ? sanitized.slice(0, MAX_PREVIEW_SOURCE_LINE_LENGTH) : sanitized;
}
__name(sanitizePreviewSourceLine, "sanitizePreviewSourceLine");
function normalizeNodeLabel(label) {
  return sanitizeTerminalText2(label).replace(/^["']|["']$/g, "").replace(/<br\s*\/?>/gi, "\n").replace(/\\n/g, "\n");
}
__name(normalizeNodeLabel, "normalizeNodeLabel");
function nodeLabelLines(label) {
  return label.split(/\n/).map((line) => line.trim()).filter((line) => line.length > 0);
}
__name(nodeLabelLines, "nodeLabelLines");
function singleLineLabel(label) {
  return nodeLabelLines(label).join(" ");
}
__name(singleLineLabel, "singleLineLabel");
function previewSourceFallback(source, contentWidth, type, warning) {
  const allSourceLines = sanitizeTerminalText2(source).trim().split(/\r?\n/).map(sanitizePreviewSourceLine);
  const sourceLines = allSourceLines.slice(0, MAX_SOURCE_FALLBACK_LINES);
  const truncated = allSourceLines.length > sourceLines.length;
  const lines = ["```mermaid", ...sourceLines, "```"].map(
    (line) => truncateToWidth2(line, contentWidth)
  );
  return {
    title: `Mermaid source (${type})`,
    lines,
    warning: [
      warning ?? "Visual preview is not available; showing source so it remains readable and copyable.",
      truncated ? `Source truncated to ${MAX_SOURCE_FALLBACK_LINES} lines.` : void 0
    ].filter(Boolean).join(" ") || void 0
  };
}
__name(previewSourceFallback, "previewSourceFallback");
function diagramLines(source, startRe, maxLines = MAX_GENERIC_PREVIEW_LINES) {
  const allLines = source.split(/\r?\n/).map(normalizePreviewLine).filter(
    (line) => line.length > 0 && !LINE_COMMENT_RE.test(line) && !startRe.test(line)
  );
  return {
    lines: allLines.slice(0, maxLines),
    truncated: allLines.length > maxLines
  };
}
__name(diagramLines, "diagramLines");
function budgetWarning(truncated, maxLines = MAX_GENERIC_PREVIEW_LINES) {
  return truncated ? `Preview limited to ${maxLines} source lines.` : void 0;
}
__name(budgetWarning, "budgetWarning");
function parseNodeToken(rawToken) {
  const token = stripMermaidPunctuation(rawToken).replace(/^\|.*?\|/, "").trim();
  if (!token || /^subgraph\b|^end$/i.test(token)) return null;
  const idMatch = /^([A-Za-z0-9_.$:-]+)\s*(.*)$/.exec(token);
  if (!idMatch) {
    return {
      id: token,
      label: normalizeNodeLabel(token),
      shape: "rect"
    };
  }
  const id = idMatch[1];
  const rest = idMatch[2].trim();
  const labelMatch = /^\[\[(.+)\]\]$/.exec(rest) ?? /^\[(.+)\]$/.exec(rest) ?? /^\(\((.+)\)\)$/.exec(rest) ?? /^\((.+)\)$/.exec(rest) ?? /^\{(.+)\}$/.exec(rest) ?? /^>\s*(.+)\]$/.exec(rest);
  const shape = /^\{(.+)\}$/.test(rest) ? "diamond" : /^\(\((.+)\)\)$/.test(rest) || /^\((.+)\)$/.test(rest) ? "round" : "rect";
  return {
    id,
    label: normalizeNodeLabel(labelMatch?.[1] ?? id),
    shape
  };
}
__name(parseNodeToken, "parseNodeToken");
function parseFlowEdge(line) {
  const patterns = [
    {
      re: /^(.+?)\s*--\s*(.+?)\s*-->\s*(.+)$/i,
      fromIndex: 1,
      labelIndex: 2,
      toIndex: 3
    },
    {
      re: /^(.+?)\s*-->\|(.+?)\|\s*(.+)$/i,
      fromIndex: 1,
      labelIndex: 2,
      toIndex: 3
    },
    {
      re: /^(.+?)\s*(?:-->|---|==>|-\.->|--x|--o)\s*(.+)$/i,
      fromIndex: 1,
      toIndex: 2
    }
  ];
  for (const pattern of patterns) {
    const match = pattern.re.exec(line);
    if (!match) continue;
    const from = parseNodeToken(match[pattern.fromIndex]);
    const to = parseNodeToken(match[pattern.toIndex]);
    if (!from || !to) return null;
    const label = pattern.labelIndex !== void 0 ? stripMermaidPunctuation(match[pattern.labelIndex]) : void 0;
    return { from, to, label: label || void 0 };
  }
  return null;
}
__name(parseFlowEdge, "parseFlowEdge");
function parseFlowEdges(line) {
  const singleEdge = parseFlowEdge(line);
  const operators = [...line.matchAll(FLOW_EDGE_OPERATOR_RE)];
  if (operators.length <= 1) return singleEdge ? [singleEdge] : [];
  const tokens = [];
  const labels = [];
  let cursor = 0;
  for (const operator of operators) {
    tokens.push(line.slice(cursor, operator.index).trim());
    labels.push(
      stripMermaidPunctuation(operator[1] ?? operator[2] ?? "") || void 0
    );
    cursor = operator.index + operator[0].length;
  }
  tokens.push(line.slice(cursor).trim());
  if (tokens.length !== operators.length + 1) {
    return [];
  }
  const nodes = tokens.map(parseNodeToken);
  if (nodes.some((node) => node === null)) {
    return [];
  }
  const edges = [];
  for (let index = 0; index < nodes.length - 1; index++) {
    edges.push({
      from: nodes[index],
      to: nodes[index + 1],
      label: labels[index]
    });
  }
  return edges;
}
__name(parseFlowEdges, "parseFlowEdges");
function normalizeFlowNodeLabels(edges) {
  const labelById = /* @__PURE__ */ new Map();
  const shapeById = /* @__PURE__ */ new Map();
  for (const edge of edges) {
    for (const node of [edge.from, edge.to]) {
      if (node.label !== node.id && !labelById.has(node.id)) {
        labelById.set(node.id, node.label);
      }
      if (node.shape !== "rect" && !shapeById.has(node.id)) {
        shapeById.set(node.id, node.shape);
      }
    }
  }
  return edges.map((edge) => ({
    ...edge,
    from: {
      ...edge.from,
      label: labelById.get(edge.from.id) ?? edge.from.label,
      shape: shapeById.get(edge.from.id) ?? edge.from.shape
    },
    to: {
      ...edge.to,
      label: labelById.get(edge.to.id) ?? edge.to.label,
      shape: shapeById.get(edge.to.id) ?? edge.to.shape
    }
  }));
}
__name(normalizeFlowNodeLabels, "normalizeFlowNodeLabels");
function boxNode(node, width) {
  const labels = nodeLabelLines(node.label).map(
    (line) => truncateToWidth2(line, Math.max(3, width - 4))
  );
  const innerWidth = Math.max(4, ...labels.map((label) => stringWidth(label)));
  if (node.shape === "diamond") {
    return [
      ` \u2571${"\u2500".repeat(innerWidth + 2)}\u2572 `,
      ...labels.map((label) => ` \u25C7 ${center(label, innerWidth)} \u25C7 `),
      ` \u2572${"\u2500".repeat(innerWidth + 2)}\u2571 `
    ];
  }
  if (node.shape === "round") {
    return [
      `\u256D${"\u2500".repeat(innerWidth + 2)}\u256E`,
      ...labels.map((label) => `\u2502 ${center(label, innerWidth)} \u2502`),
      `\u2570${"\u2500".repeat(innerWidth + 2)}\u256F`
    ];
  }
  return [
    `\u250C${"\u2500".repeat(innerWidth + 2)}\u2510`,
    ...labels.map((label) => `\u2502 ${center(label, innerWidth)} \u2502`),
    `\u2514${"\u2500".repeat(innerWidth + 2)}\u2518`
  ];
}
__name(boxNode, "boxNode");
function buildFlowGraph(edges) {
  const nodes = /* @__PURE__ */ new Map();
  const outgoing = /* @__PURE__ */ new Map();
  const incomingCount = /* @__PURE__ */ new Map();
  for (const edge of edges) {
    nodes.set(edge.from.id, edge.from);
    nodes.set(edge.to.id, edge.to);
    const outgoingEdges = outgoing.get(edge.from.id) ?? [];
    outgoingEdges.push(edge);
    outgoing.set(edge.from.id, outgoingEdges);
    incomingCount.set(edge.to.id, (incomingCount.get(edge.to.id) ?? 0) + 1);
    if (!incomingCount.has(edge.from.id)) incomingCount.set(edge.from.id, 0);
  }
  const roots = Array.from(nodes.values()).filter(
    (node) => (incomingCount.get(node.id) ?? 0) === 0
  );
  return {
    nodes,
    outgoing,
    incomingCount,
    roots: roots.length > 0 ? roots : [edges[0].from]
  };
}
__name(buildFlowGraph, "buildFlowGraph");
function renderNodeLines(node, maxWidth) {
  return boxNode(node, Math.max(8, maxWidth));
}
__name(renderNodeLines, "renderNodeLines");
function lineWidth(line) {
  return stringWidth(line);
}
__name(lineWidth, "lineWidth");
function computeRanks(graph) {
  const ranks = /* @__PURE__ */ new Map();
  const queue = [...graph.roots];
  for (const root of graph.roots) {
    ranks.set(root.id, 0);
  }
  while (queue.length > 0) {
    const node = queue.shift();
    const rank = ranks.get(node.id) ?? 0;
    for (const edge of graph.outgoing.get(node.id) ?? []) {
      if (ranks.has(edge.to.id)) continue;
      ranks.set(edge.to.id, rank + 1);
      queue.push(edge.to);
    }
  }
  for (const node of graph.nodes.values()) {
    if (!ranks.has(node.id)) ranks.set(node.id, 0);
  }
  return ranks;
}
__name(computeRanks, "computeRanks");
function branchPreference(label) {
  if (!label) return 0;
  const normalized = label.trim().toLowerCase();
  if (/^(no|false|fail|failed|否|不|失败)$/.test(normalized)) return -1;
  if (/^(yes|true|pass|passed|是|成功)$/.test(normalized)) return 1;
  return 0;
}
__name(branchPreference, "branchPreference");
function groupNodesByRank(graph, ranks) {
  const layers = [];
  const preferenceById = /* @__PURE__ */ new Map();
  const parentEdgesById = /* @__PURE__ */ new Map();
  const originalIndexById = /* @__PURE__ */ new Map();
  Array.from(graph.nodes.values()).forEach((node, index) => {
    originalIndexById.set(node.id, index);
  });
  for (const edgeList of graph.outgoing.values()) {
    for (const edge of edgeList) {
      const parentEdges = parentEdgesById.get(edge.to.id) ?? [];
      parentEdges.push(edge);
      parentEdgesById.set(edge.to.id, parentEdges);
      const preference = branchPreference(edge.label);
      if (preference !== 0 && !preferenceById.has(edge.to.id)) {
        preferenceById.set(edge.to.id, preference);
      }
    }
  }
  for (const node of graph.nodes.values()) {
    const rank = ranks.get(node.id) ?? 0;
    layers[rank] ??= [];
    layers[rank].push(node);
  }
  const orderById = /* @__PURE__ */ new Map();
  for (const [rank, layer] of layers.entries()) {
    layer?.sort((a, b) => {
      const parentOrderDelta = parentOrder(a, rank, ranks, parentEdgesById, orderById) - parentOrder(b, rank, ranks, parentEdgesById, orderById);
      if (parentOrderDelta !== 0) return parentOrderDelta;
      const preferenceDelta = (preferenceById.get(a.id) ?? 0) - (preferenceById.get(b.id) ?? 0);
      if (preferenceDelta !== 0) return preferenceDelta;
      return (originalIndexById.get(a.id) ?? 0) - (originalIndexById.get(b.id) ?? 0);
    });
    layer?.forEach((node, index) => {
      orderById.set(node.id, index);
    });
  }
  return layers.filter((layer) => layer.length > 0);
}
__name(groupNodesByRank, "groupNodesByRank");
function parentOrder(node, rank, ranks, parentEdgesById, orderById) {
  const parentEdges = parentEdgesById.get(node.id) ?? [];
  const orders = parentEdges.filter((edge) => (ranks.get(edge.from.id) ?? 0) < rank).map((edge) => orderById.get(edge.from.id)).filter((order) => order !== void 0);
  if (orders.length === 0) return Number.POSITIVE_INFINITY;
  return orders.reduce((sum, order) => sum + order, 0) / orders.length;
}
__name(parentOrder, "parentOrder");
function createCanvas(width, height) {
  return Array.from({ length: height }, () => Array(width).fill(" "));
}
__name(createCanvas, "createCanvas");
function mergeCanvasChar(existing, next) {
  if (existing === "") return existing;
  if (next === "") return existing;
  if (existing === " " || existing === next) return next;
  if ("\u25BC\u25B2\u25C0\u25B6\u2192\u2190\u21A9".includes(existing)) return existing;
  if ("\u25BC\u25B2\u25C0\u25B6\u2192\u2190\u21A9".includes(next)) return next;
  if (existing === "\u2502" && next === "\u2500" || existing === "\u2500" && next === "\u2502" || existing === "\u253C" || next === "\u253C") {
    return "\u253C";
  }
  if ("\u250C\u2510\u2514\u2518\u256D\u256E\u2570\u256F\u2571\u2572\u25C7".includes(existing)) return existing;
  return next;
}
__name(mergeCanvasChar, "mergeCanvasChar");
function putChar(canvas, x, y, char, overwrite = false) {
  if (y < 0 || y >= canvas.length || x < 0 || x >= canvas[y].length) return;
  canvas[y][x] = overwrite ? char : mergeCanvasChar(canvas[y][x], char);
}
__name(putChar, "putChar");
function putText(canvas, x, y, text, overwrite = false) {
  let cursor = x;
  for (const char of text) {
    const width = Math.max(1, stringWidth(char));
    putChar(canvas, cursor, y, char, overwrite);
    for (let offset = 1; offset < width; offset++) {
      if (y >= 0 && y < canvas.length && cursor + offset >= 0 && cursor + offset < canvas[y].length) {
        canvas[y][cursor + offset] = "";
      }
    }
    cursor += width;
  }
}
__name(putText, "putText");
function drawHorizontal(canvas, y, x1, x2) {
  const start = Math.min(x1, x2);
  const end = Math.max(x1, x2);
  for (let x = start; x <= end; x++) putChar(canvas, x, y, "\u2500");
}
__name(drawHorizontal, "drawHorizontal");
function drawVertical(canvas, x, y1, y2) {
  const start = Math.min(y1, y2);
  const end = Math.max(y1, y2);
  for (let y = start; y <= end; y++) putChar(canvas, x, y, "\u2502");
}
__name(drawVertical, "drawVertical");
function drawNode(canvas, positioned) {
  positioned.lines.forEach((line, offset) => {
    putText(canvas, positioned.x, positioned.y + offset, line, true);
  });
}
__name(drawNode, "drawNode");
function layoutVertical(graph, contentWidth) {
  const ranks = computeRanks(graph);
  const layers = groupNodesByRank(graph, ranks);
  const positioned = [];
  let y = 0;
  for (const layer of layers) {
    const gapCount = Math.max(0, layer.length - 1);
    const maxNodeWidth = Math.max(
      8,
      Math.floor((contentWidth - gapCount * NODE_GAP_X) / layer.length)
    );
    const rendered = layer.map((node) => ({
      node,
      lines: renderNodeLines(node, Math.min(28, maxNodeWidth))
    }));
    const totalWidth = rendered.reduce((sum, item) => sum + lineWidth(item.lines[0]), 0) + gapCount * NODE_GAP_X;
    let x = Math.max(0, Math.floor((contentWidth - totalWidth) / 2));
    const layerHeight = Math.max(...rendered.map((item) => item.lines.length));
    for (const item of rendered) {
      const width = lineWidth(item.lines[0]);
      const height = item.lines.length;
      positioned.push({
        node: item.node,
        lines: item.lines,
        x,
        y,
        width,
        height,
        centerX: x + Math.floor(width / 2),
        centerY: y + Math.floor(height / 2),
        rank: ranks.get(item.node.id) ?? 0
      });
      x += width + NODE_GAP_X;
    }
    y += layerHeight + NODE_GAP_Y;
  }
  return positioned;
}
__name(layoutVertical, "layoutVertical");
function layoutHorizontal(graph, contentWidth) {
  const ranks = computeRanks(graph);
  const layers = groupNodesByRank(graph, ranks);
  const columnWidth = Math.max(
    10,
    Math.min(
      24,
      Math.floor(
        (contentWidth - (layers.length - 1) * NODE_GAP_X) / layers.length
      )
    )
  );
  const totalWidth = layers.length * columnWidth + (layers.length - 1) * NODE_GAP_X;
  if (totalWidth > contentWidth || layers.length === 0) return null;
  const positioned = [];
  let x = Math.max(0, Math.floor((contentWidth - totalWidth) / 2));
  for (const layer of layers) {
    let y = 0;
    for (const node of layer) {
      const lines = renderNodeLines(node, columnWidth);
      const width = lineWidth(lines[0]);
      positioned.push({
        node,
        lines,
        x: x + Math.floor((columnWidth - width) / 2),
        y,
        width,
        height: lines.length,
        centerX: x + Math.floor(columnWidth / 2),
        centerY: y + Math.floor(lines.length / 2),
        rank: ranks.get(node.id) ?? 0
      });
      y += lines.length + NODE_GAP_Y;
    }
    x += columnWidth + NODE_GAP_X;
  }
  return positioned;
}
__name(layoutHorizontal, "layoutHorizontal");
function drawForwardVerticalEdge(canvas, from, to, label) {
  const startY = from.y + from.height;
  const endY = to.y - 1;
  const midY = Math.max(startY, Math.floor((startY + endY) / 2));
  if (Math.abs(from.centerX - to.centerX) <= 1) {
    drawVertical(canvas, from.centerX, startY, endY);
    putChar(canvas, from.centerX, endY, "\u25BC");
    if (label) {
      putText(
        canvas,
        Math.min(canvas[midY].length - 1, from.centerX + 2),
        midY,
        truncateToWidth2(label, 14)
      );
    }
    return;
  }
  const bendY = Math.max(startY, Math.min(midY, endY - 1));
  const targetIsRight = to.centerX > from.centerX;
  drawVertical(canvas, from.centerX, startY, bendY);
  drawHorizontal(canvas, bendY, from.centerX, to.centerX);
  if (bendY + 1 <= endY) {
    drawVertical(canvas, to.centerX, bendY + 1, endY);
  }
  putChar(canvas, from.centerX, bendY, targetIsRight ? "\u2514" : "\u2518", true);
  putChar(canvas, to.centerX, bendY, targetIsRight ? "\u2510" : "\u250C", true);
  putChar(canvas, to.centerX, endY, "\u25BC");
  if (label) {
    const text = truncateToWidth2(label, 14);
    const labelX = Math.abs(to.centerX - from.centerX) > stringWidth(text) + 2 ? Math.min(from.centerX, to.centerX) + Math.floor(
      (Math.abs(to.centerX - from.centerX) - stringWidth(text)) / 2
    ) : Math.min(canvas[bendY].length - stringWidth(text), from.centerX + 2);
    putText(canvas, Math.max(0, labelX), bendY, text, true);
  }
}
__name(drawForwardVerticalEdge, "drawForwardVerticalEdge");
function drawVerticalFork(canvas, from, targets) {
  if (targets.length === 0) return;
  if (targets.length === 1) {
    drawForwardVerticalEdge(
      canvas,
      from,
      targets[0].to,
      targets[0].edge.label
    );
    return;
  }
  const sortedTargets = [...targets].sort(
    (a, b) => a.to.centerX - b.to.centerX
  );
  const startY = from.y + from.height;
  const firstTargetTop = Math.min(
    ...sortedTargets.map((target) => target.to.y)
  );
  const forkY = Math.max(startY, firstTargetTop - 3);
  const labelY = Math.min(forkY + 1, firstTargetTop - 2);
  const minX = Math.min(...sortedTargets.map((target) => target.to.centerX));
  const maxX = Math.max(...sortedTargets.map((target) => target.to.centerX));
  drawVertical(canvas, from.centerX, startY, forkY);
  drawHorizontal(canvas, forkY, minX, maxX);
  putChar(canvas, from.centerX, forkY, "\u2534", true);
  for (const [index, target] of sortedTargets.entries()) {
    const endY = target.to.y - 1;
    const targetJunction = sortedTargets.length === 1 ? "\u2534" : index === 0 ? "\u250C" : index === sortedTargets.length - 1 ? "\u2510" : "\u252C";
    putChar(canvas, target.to.centerX, forkY, targetJunction, true);
    putChar(canvas, target.to.centerX, endY, "\u25BC");
    if (target.edge.label) {
      const label = `[${truncateToWidth2(target.edge.label, 10)}]`;
      const x = Math.max(
        0,
        Math.min(
          canvas[labelY].length - stringWidth(label),
          target.to.centerX - Math.floor(stringWidth(label) / 2)
        )
      );
      putText(canvas, x, labelY, label, true);
    }
    if (forkY + 1 <= labelY - 1) {
      drawVertical(canvas, target.to.centerX, forkY + 1, labelY - 1);
    }
    if (labelY + 1 <= endY) {
      drawVertical(canvas, target.to.centerX, labelY + 1, endY);
    }
  }
}
__name(drawVerticalFork, "drawVerticalFork");
function formatLoopNote(from, to, label) {
  const edgeLabel = label ? ` [${label}]` : "";
  return `${singleLineLabel(from.node.label)}${edgeLabel} \u21A9 to ${singleLineLabel(
    to.node.label
  )}`;
}
__name(formatLoopNote, "formatLoopNote");
function drawHorizontalEdge(canvas, from, to, label) {
  const forward = to.rank > from.rank;
  const fromX = forward ? from.x + from.width : from.x - 1;
  const toX = forward ? to.x - 1 : to.x + to.width;
  const midX = Math.floor((fromX + toX) / 2);
  if (from.centerY === to.centerY) {
    drawHorizontal(canvas, from.centerY, fromX, toX);
    putChar(canvas, toX, to.centerY, forward ? "\u25B6" : "\u25C0");
    if (label) {
      const text = truncateToWidth2(label, 12);
      putText(
        canvas,
        Math.max(0, midX - Math.floor(stringWidth(text) / 2)),
        from.centerY,
        text
      );
    }
    return;
  }
  drawHorizontal(canvas, from.centerY, fromX, midX);
  drawVertical(canvas, midX, from.centerY, to.centerY);
  drawHorizontal(canvas, to.centerY, midX, toX);
  putChar(canvas, toX, to.centerY, forward ? "\u25B6" : "\u25C0");
  if (label) {
    const text = truncateToWidth2(label, 12);
    putText(
      canvas,
      Math.max(0, midX - Math.floor(stringWidth(text) / 2)),
      Math.min(from.centerY, to.centerY),
      text
    );
  }
}
__name(drawHorizontalEdge, "drawHorizontalEdge");
function canvasToLines(canvas, contentWidth) {
  return canvas.map((row) => truncateToWidth2(row.join("").trimEnd(), contentWidth)).filter(
    (line, index, lines) => line.length > 0 || index < lines.length - 1
  );
}
__name(canvasToLines, "canvasToLines");
function renderLayeredFlowchart(edges, contentWidth, horizontal) {
  const width = Math.max(MIN_CANVAS_WIDTH, contentWidth);
  const graph = buildFlowGraph(edges);
  const positioned = horizontal && graph.nodes.size <= 8 ? layoutHorizontal(graph, width) ?? layoutVertical(graph, width) : layoutVertical(graph, width);
  const byId = new Map(positioned.map((node) => [node.node.id, node]));
  const canvasHeight = Math.max(...positioned.map((node) => node.y + node.height), 1) + 2;
  const canvas = createCanvas(width, canvasHeight);
  const loopNotes = [];
  for (const edge of edges) {
    if (!horizontal && (graph.outgoing.get(edge.from.id)?.length ?? 0) > 1) {
      continue;
    }
    const from = byId.get(edge.from.id);
    const to = byId.get(edge.to.id);
    if (!from || !to) continue;
    if (horizontal && to.rank !== from.rank) {
      drawHorizontalEdge(canvas, from, to, edge.label);
    } else if (to.rank > from.rank) {
      drawForwardVerticalEdge(canvas, from, to, edge.label);
    } else {
      loopNotes.push(formatLoopNote(from, to, edge.label));
    }
  }
  if (!horizontal) {
    for (const edgeList of graph.outgoing.values()) {
      if (edgeList.length <= 1) continue;
      const source = byId.get(edgeList[0].from.id);
      if (!source) continue;
      const forwardTargets = [];
      for (const edge of edgeList) {
        const target = byId.get(edge.to.id);
        if (!target) continue;
        if (target.rank > source.rank) {
          forwardTargets.push({ edge, to: target });
        } else {
          loopNotes.push(formatLoopNote(source, target, edge.label));
        }
      }
      drawVerticalFork(canvas, source, forwardTargets);
    }
  }
  for (const node of positioned) {
    drawNode(canvas, node);
  }
  const lines = canvasToLines(canvas, contentWidth);
  if (loopNotes.length > 0) {
    lines.push("");
    lines.push("Cycles:");
    for (const note of loopNotes) {
      lines.push(truncateToWidth2(`  ${note}`, contentWidth));
    }
  }
  return lines;
}
__name(renderLayeredFlowchart, "renderLayeredFlowchart");
function renderFlowchart(source, contentWidth) {
  const allRawLines = source.split(/\r?\n/).map(normalizePreviewLine).filter((line) => line.length > 0 && !LINE_COMMENT_RE.test(line));
  const rawLines = allRawLines.slice(0, MAX_FLOWCHART_PREVIEW_LINES);
  const lineBudgetExceeded = allRawLines.length > rawLines.length;
  const first = rawLines[0] ?? "";
  const direction = FLOW_START_RE.exec(first)?.[1]?.toUpperCase() ?? "TD";
  const lines = rawLines.slice(FLOW_START_RE.test(first) ? 1 : 0);
  const edgeLines = [];
  let edgeBudgetExceeded = false;
  for (const line of lines) {
    for (const part of line.split(";")) {
      const statement = part.trim();
      if (!statement) continue;
      if (edgeLines.length >= MAX_FLOWCHART_PREVIEW_EDGES) {
        edgeBudgetExceeded = true;
        break;
      }
      edgeLines.push(statement);
    }
    if (edgeBudgetExceeded) break;
  }
  const edges = edgeLines.flatMap(parseFlowEdges);
  const normalizedEdges = normalizeFlowNodeLabels(edges);
  if (normalizedEdges.length === 0) {
    return previewSourceFallback(
      source,
      contentWidth,
      "flowchart",
      "Flowchart preview supports simple A --> B style edges; showing source instead."
    );
  }
  const horizontal = direction.includes("LR") || direction.includes("RL");
  const rendered = renderLayeredFlowchart(
    normalizedEdges,
    contentWidth,
    horizontal
  );
  return {
    title: `Mermaid flowchart (${direction})`,
    lines: rendered.slice(0, MAX_RENDERED_LINES),
    warning: [
      lineBudgetExceeded ? `Preview limited to ${MAX_FLOWCHART_PREVIEW_LINES} source lines.` : void 0,
      edgeBudgetExceeded ? `Preview limited to ${MAX_FLOWCHART_PREVIEW_EDGES} edges.` : void 0,
      rendered.length > MAX_RENDERED_LINES ? `Preview truncated to ${MAX_RENDERED_LINES} rendered lines.` : void 0
    ].filter(Boolean).join(" ") || void 0
  };
}
__name(renderFlowchart, "renderFlowchart");
function parseParticipant(line) {
  const match = /^(?:participant|actor)\s+(.+?)(?:\s+as\s+(.+))?$/i.exec(line);
  if (!match) return null;
  const id = stripMermaidPunctuation(match[1]);
  return {
    id,
    label: stripMermaidPunctuation(match[2] ?? id)
  };
}
__name(parseParticipant, "parseParticipant");
function renderSequence(source, contentWidth) {
  const allRawLines = source.split(/\r?\n/).map(normalizePreviewLine).filter(
    (line) => line.length > 0 && !LINE_COMMENT_RE.test(line) && !SEQUENCE_START_RE.test(line)
  );
  const rawLines = allRawLines.slice(0, MAX_SEQUENCE_PREVIEW_LINES);
  const lineBudgetExceeded = allRawLines.length > rawLines.length;
  const participants = /* @__PURE__ */ new Map();
  const messages = [];
  let messageBudgetExceeded = false;
  for (const line of rawLines) {
    const participant = parseParticipant(line);
    if (participant) {
      participants.set(participant.id, participant.label);
      continue;
    }
    const messageMatch = /^(.+?)(-->>|->>|-->|->|--x|-x)\s*(.+?)\s*:\s*(.+)$/.exec(line);
    if (!messageMatch) continue;
    const from = stripMermaidPunctuation(messageMatch[1]);
    const arrow = messageMatch[2].includes("--") ? "\u21E2" : "\u2192";
    const to = stripMermaidPunctuation(messageMatch[3]);
    const message = stripMermaidPunctuation(messageMatch[4]);
    if (!participants.has(from)) participants.set(from, from);
    if (!participants.has(to)) participants.set(to, to);
    if (messages.length >= MAX_SEQUENCE_PREVIEW_MESSAGES) {
      messageBudgetExceeded = true;
      continue;
    }
    messages.push(
      truncateToWidth2(
        `${participants.get(from) ?? from} ${arrow} ${participants.get(to) ?? to}: ${message}`,
        contentWidth
      )
    );
  }
  const header = participants.size > 0 ? `Participants: ${Array.from(participants.values()).join(" | ")}` : "Participants: not declared";
  if (messages.length === 0) {
    return previewSourceFallback(
      source,
      contentWidth,
      "sequenceDiagram",
      "Sequence preview supports A->>B: message style arrows; showing source instead."
    );
  }
  const lines = [truncateToWidth2(header, contentWidth), ""];
  lines.push(...messages);
  return {
    title: "Mermaid sequence diagram",
    lines: lines.slice(0, MAX_RENDERED_LINES),
    warning: [
      lineBudgetExceeded ? `Preview limited to ${MAX_SEQUENCE_PREVIEW_LINES} source lines.` : void 0,
      messageBudgetExceeded ? `Preview limited to ${MAX_SEQUENCE_PREVIEW_MESSAGES} messages.` : void 0
    ].filter(Boolean).join(" ") || void 0
  };
}
__name(renderSequence, "renderSequence");
function renderClassDiagram(source, contentWidth) {
  const { lines: rawLines, truncated } = diagramLines(source, CLASS_START_RE);
  const classes = /* @__PURE__ */ new Set();
  const relationships = [];
  const members = [];
  let currentClass = null;
  for (const line of rawLines) {
    const classBlockMatch = /^class\s+([A-Za-z0-9_.$:-]+)\s*\{?$/i.exec(line);
    if (classBlockMatch) {
      currentClass = classBlockMatch[1];
      classes.add(currentClass);
      continue;
    }
    if (line === "}") {
      currentClass = null;
      continue;
    }
    const relationMatch = /^([A-Za-z0-9_.$:-]+)\s+([<|*o.]*--[|>*o.]*|<\|--|--\|>|\*--|o--|-->|<--|\.\.>)\s+([A-Za-z0-9_.$:-]+)(?:\s*:\s*(.+))?$/i.exec(
      line
    );
    if (relationMatch) {
      const from = relationMatch[1];
      const relation = relationMatch[2];
      const to = relationMatch[3];
      const label = stripMermaidPunctuation(relationMatch[4] ?? "");
      classes.add(from);
      classes.add(to);
      relationships.push(
        truncateToWidth2(
          `${from} ${relation} ${to}${label ? `: ${label}` : ""}`,
          contentWidth
        )
      );
      continue;
    }
    const inlineMemberMatch = /^([A-Za-z0-9_.$:-]+)\s*:\s*(.+)$/i.exec(line);
    if (inlineMemberMatch) {
      classes.add(inlineMemberMatch[1]);
      members.push(
        truncateToWidth2(
          `${inlineMemberMatch[1]}: ${stripMermaidPunctuation(inlineMemberMatch[2])}`,
          contentWidth
        )
      );
      continue;
    }
    if (currentClass) {
      members.push(
        truncateToWidth2(
          `${currentClass}: ${stripMermaidPunctuation(line)}`,
          contentWidth
        )
      );
    }
  }
  if (classes.size === 0 && relationships.length === 0 && members.length === 0) {
    return previewSourceFallback(
      source,
      contentWidth,
      "classDiagram",
      "Class preview found no previewable classes or relationships; showing source instead."
    );
  }
  const output = [
    truncateToWidth2(
      `Classes: ${Array.from(classes).join(" | ") || "not declared"}`,
      contentWidth
    ),
    "",
    ...relationships.length > 0 ? ["Relationships:", ...relationships] : ["Relationships: none previewed"],
    ...members.length > 0 ? ["", "Members:", ...members.slice(0, 24)] : []
  ];
  return {
    title: "Mermaid class diagram",
    lines: output.slice(0, MAX_RENDERED_LINES),
    warning: budgetWarning(truncated)
  };
}
__name(renderClassDiagram, "renderClassDiagram");
function renderStateDiagram(source, contentWidth) {
  const { lines: rawLines, truncated } = diagramLines(source, STATE_START_RE);
  const transitions = [];
  const declarations = [];
  for (const line of rawLines) {
    const transitionMatch = /^(.+?)\s*-->\s*(.+?)(?:\s*:\s*(.+))?$/.exec(line);
    if (transitionMatch) {
      const from = stripMermaidPunctuation(transitionMatch[1]);
      const to = stripMermaidPunctuation(transitionMatch[2]);
      const label = stripMermaidPunctuation(transitionMatch[3] ?? "");
      transitions.push(
        truncateToWidth2(
          `${from} \u2192 ${to}${label ? `: ${label}` : ""}`,
          contentWidth
        )
      );
      continue;
    }
    const stateMatch = /^state\s+(.+?)(?:\s+as\s+(.+))?$/i.exec(line);
    if (stateMatch) {
      declarations.push(
        truncateToWidth2(
          stripMermaidPunctuation(stateMatch[2] ?? stateMatch[1]),
          contentWidth
        )
      );
    }
  }
  if (declarations.length === 0 && transitions.length === 0) {
    return previewSourceFallback(
      source,
      contentWidth,
      "stateDiagram",
      "State preview found no previewable states or transitions; showing source instead."
    );
  }
  const output = [
    ...declarations.length > 0 ? ["States:", ...declarations.slice(0, 20), ""] : [],
    ...transitions.length > 0 ? ["Transitions:", ...transitions] : ["Transitions: none previewed"]
  ];
  return {
    title: "Mermaid state diagram",
    lines: output.slice(0, MAX_RENDERED_LINES),
    warning: budgetWarning(truncated)
  };
}
__name(renderStateDiagram, "renderStateDiagram");
function renderErDiagram(source, contentWidth) {
  const { lines: rawLines, truncated } = diagramLines(source, ER_START_RE);
  const entities = /* @__PURE__ */ new Set();
  const relationships = [];
  const attributes = [];
  let currentEntity = null;
  for (const line of rawLines) {
    const entityBlock = /^([A-Za-z0-9_.$:-]+)\s*\{$/.exec(line);
    if (entityBlock) {
      currentEntity = entityBlock[1];
      entities.add(currentEntity);
      continue;
    }
    if (line === "}") {
      currentEntity = null;
      continue;
    }
    const relationMatch = /^([A-Za-z0-9_.$:-]+)\s+([|o}{]{1,2}--[|o}{]{1,2})\s+([A-Za-z0-9_.$:-]+)(?:\s*:\s*(.+))?$/i.exec(
      line
    );
    if (relationMatch) {
      entities.add(relationMatch[1]);
      entities.add(relationMatch[3]);
      relationships.push(
        truncateToWidth2(
          `${relationMatch[1]} ${relationMatch[2]} ${relationMatch[3]}${relationMatch[4] ? `: ${stripMermaidPunctuation(relationMatch[4])}` : ""}`,
          contentWidth
        )
      );
      continue;
    }
    if (currentEntity) {
      attributes.push(
        truncateToWidth2(
          `${currentEntity}: ${stripMermaidPunctuation(line)}`,
          contentWidth
        )
      );
    }
  }
  if (entities.size === 0 && relationships.length === 0 && attributes.length === 0) {
    return previewSourceFallback(
      source,
      contentWidth,
      "erDiagram",
      "ER preview found no previewable entities or relationships; showing source instead."
    );
  }
  return {
    title: "Mermaid ER diagram",
    lines: [
      truncateToWidth2(
        `Entities: ${Array.from(entities).join(" | ") || "not declared"}`,
        contentWidth
      ),
      "",
      ...relationships.length > 0 ? ["Relationships:", ...relationships] : ["Relationships: none previewed"],
      ...attributes.length > 0 ? ["", "Attributes:", ...attributes.slice(0, 24)] : []
    ].slice(0, MAX_RENDERED_LINES),
    warning: budgetWarning(truncated)
  };
}
__name(renderErDiagram, "renderErDiagram");
function renderPieDiagram(source, contentWidth) {
  const { lines: rawLines, truncated } = diagramLines(source, PIE_START_RE);
  const titleLine = rawLines.find((line) => /^title\b/i.test(line));
  const slices = rawLines.map((line) => /^["']?(.+?)["']?\s*:\s*([0-9.]+)\s*$/.exec(line)).filter((match) => match !== null).map(
    (match) => truncateToWidth2(
      `${stripMermaidPunctuation(match[1])}: ${match[2]}`,
      contentWidth
    )
  );
  if (slices.length === 0) {
    return previewSourceFallback(
      source,
      contentWidth,
      "pie",
      "Pie preview found no previewable slices; showing source instead."
    );
  }
  return {
    title: "Mermaid pie chart",
    lines: [
      ...titleLine ? [
        truncateToWidth2(stripMermaidPunctuation(titleLine), contentWidth),
        ""
      ] : [],
      ...slices
    ],
    warning: budgetWarning(truncated)
  };
}
__name(renderPieDiagram, "renderPieDiagram");
function renderGanttDiagram(source, contentWidth) {
  const { lines: rawLines, truncated } = diagramLines(source, GANTT_START_RE);
  const output = [];
  for (const line of rawLines) {
    if (/^(dateFormat|axisFormat|tickInterval|weekday|excludes|todayMarker)\b/i.test(
      line
    )) {
      continue;
    }
    const section = /^section\s+(.+)$/i.exec(line);
    if (section) {
      output.push("");
      output.push(
        truncateToWidth2(
          `Section: ${stripMermaidPunctuation(section[1])}`,
          contentWidth
        )
      );
      continue;
    }
    const title = /^title\s+(.+)$/i.exec(line);
    if (title) {
      output.push(
        truncateToWidth2(
          `Title: ${stripMermaidPunctuation(title[1])}`,
          contentWidth
        )
      );
      continue;
    }
    output.push(
      truncateToWidth2(`\u2022 ${stripMermaidPunctuation(line)}`, contentWidth)
    );
  }
  if (output.length === 0) {
    return previewSourceFallback(
      source,
      contentWidth,
      "gantt",
      "Gantt preview found no previewable tasks; showing source instead."
    );
  }
  return {
    title: "Mermaid gantt chart",
    lines: output.slice(0, MAX_RENDERED_LINES),
    warning: budgetWarning(truncated)
  };
}
__name(renderGanttDiagram, "renderGanttDiagram");
function renderJourneyDiagram(source, contentWidth) {
  const { lines: rawLines, truncated } = diagramLines(source, JOURNEY_START_RE);
  const output = [];
  for (const line of rawLines) {
    const title = /^title\s+(.+)$/i.exec(line);
    if (title) {
      output.push(
        truncateToWidth2(
          `Title: ${stripMermaidPunctuation(title[1])}`,
          contentWidth
        )
      );
      continue;
    }
    const section = /^section\s+(.+)$/i.exec(line);
    if (section) {
      output.push("");
      output.push(
        truncateToWidth2(
          `Section: ${stripMermaidPunctuation(section[1])}`,
          contentWidth
        )
      );
      continue;
    }
    output.push(
      truncateToWidth2(`\u2022 ${stripMermaidPunctuation(line)}`, contentWidth)
    );
  }
  if (output.length === 0) {
    return previewSourceFallback(
      source,
      contentWidth,
      "journey",
      "Journey preview found no previewable steps; showing source instead."
    );
  }
  return {
    title: "Mermaid journey diagram",
    lines: output.slice(0, MAX_RENDERED_LINES),
    warning: budgetWarning(truncated)
  };
}
__name(renderJourneyDiagram, "renderJourneyDiagram");
function renderIndentedTreeDiagram(source, contentWidth, startRe, title, sourceType) {
  const allLines = source.split(/\r?\n/).filter(
    (line) => normalizePreviewLine(line).length > 0 && !LINE_COMMENT_RE.test(normalizePreviewLine(line)) && !startRe.test(normalizePreviewLine(line))
  );
  const rawLines = allLines.slice(0, MAX_GENERIC_PREVIEW_LINES);
  const truncated = allLines.length > rawLines.length;
  const lines = rawLines.map((line) => {
    const safeLine = sanitizeTerminalText2(line);
    const indentation = /^\s*/.exec(safeLine)?.[0].length ?? 0;
    const depth = Math.floor(indentation / 2);
    return truncateToWidth2(
      `${"  ".repeat(depth)}\u2022 ${safeLine.trim()}`,
      contentWidth
    );
  });
  if (lines.length === 0) {
    return previewSourceFallback(
      source,
      contentWidth,
      sourceType,
      `${title} preview found no previewable nodes; showing source instead.`
    );
  }
  return {
    title,
    lines: lines.slice(0, MAX_RENDERED_LINES),
    warning: budgetWarning(truncated)
  };
}
__name(renderIndentedTreeDiagram, "renderIndentedTreeDiagram");
function renderMermaidVisual(source, contentWidth) {
  const trimmed = sanitizeTerminalText2(source).trim();
  const firstLine = trimmed.split(/\r?\n/).find((line) => line.trim()) ?? "";
  if (FLOW_START_RE.test(firstLine)) {
    return renderFlowchart(trimmed, contentWidth);
  }
  if (SEQUENCE_START_RE.test(firstLine)) {
    return renderSequence(trimmed, contentWidth);
  }
  if (CLASS_START_RE.test(firstLine)) {
    return renderClassDiagram(trimmed, contentWidth);
  }
  if (STATE_START_RE.test(firstLine)) {
    return renderStateDiagram(trimmed, contentWidth);
  }
  if (ER_START_RE.test(firstLine)) {
    return renderErDiagram(trimmed, contentWidth);
  }
  if (GANTT_START_RE.test(firstLine)) {
    return renderGanttDiagram(trimmed, contentWidth);
  }
  if (PIE_START_RE.test(firstLine)) {
    return renderPieDiagram(trimmed, contentWidth);
  }
  if (JOURNEY_START_RE.test(firstLine)) {
    return renderJourneyDiagram(trimmed, contentWidth);
  }
  if (MINDMAP_START_RE.test(firstLine)) {
    return renderIndentedTreeDiagram(
      trimmed,
      contentWidth,
      MINDMAP_START_RE,
      "Mermaid mindmap",
      "mindmap"
    );
  }
  if (GIT_GRAPH_START_RE.test(firstLine)) {
    return renderIndentedTreeDiagram(
      trimmed,
      contentWidth,
      GIT_GRAPH_START_RE,
      "Mermaid git graph",
      "gitGraph"
    );
  }
  if (REQUIREMENT_START_RE.test(firstLine)) {
    return renderIndentedTreeDiagram(
      trimmed,
      contentWidth,
      REQUIREMENT_START_RE,
      "Mermaid requirement diagram",
      "requirementDiagram"
    );
  }
  const type = firstLine.split(/\s+/)[0] || "unknown";
  return previewSourceFallback(trimmed, contentWidth, type);
}
__name(renderMermaidVisual, "renderMermaidVisual");

// packages/cli/src/ui/utils/MermaidDiagram.tsx
var import_jsx_runtime9 = __toESM(require_jsx_runtime(), 1);
var MERMAID_PADDING = 1;
function getRenderErrorReason(error) {
  return error instanceof Error ? error.message : String(error);
}
__name(getRenderErrorReason, "getRenderErrorReason");
var MermaidDiagramInternal = /* @__PURE__ */ __name(({
  source,
  sourceCopyCommand,
  contentWidth,
  isPending,
  availableTerminalHeight
}) => {
  const writeRaw = useTerminalOutput();
  const preparedTerminalImageSequence = import_react13.default.useRef(null);
  const [imageState, setImageState] = import_react13.default.useState(
    null
  );
  const innerWidth = Math.max(8, contentWidth - MERMAID_PADDING);
  const imageKey = `${source}\0${innerWidth}\0${availableTerminalHeight ?? "auto"}`;
  const image = imageState?.key === imageKey && !isPending ? imageState.result : null;
  const visual = import_react13.default.useMemo(
    () => renderMermaidVisual(source, innerWidth),
    [source, innerWidth]
  );
  import_react13.default.useEffect(() => {
    if (isPending) {
      setImageState(null);
      return;
    }
    let cancelled = false;
    const abortController = new AbortController();
    void renderMermaidImageAsync({
      source,
      contentWidth: innerWidth,
      availableTerminalHeight,
      signal: abortController.signal
    }).then(
      (result) => {
        if (!cancelled) {
          setImageState({ key: imageKey, result });
        }
      },
      (error) => {
        if (!cancelled) {
          setImageState({
            key: imageKey,
            result: {
              kind: "unavailable",
              reason: getRenderErrorReason(error)
            }
          });
        }
      }
    );
    return () => {
      cancelled = true;
      abortController.abort();
    };
  }, [availableTerminalHeight, imageKey, innerWidth, isPending, source]);
  const kittySequence = image?.kind === "terminal-image" && image.protocol === "kitty" && image.placeholder ? image.sequence : null;
  import_react13.default.useEffect(() => {
    preparedTerminalImageSequence.current = null;
  }, [imageKey]);
  import_react13.default.useEffect(() => {
    if (!kittySequence || preparedTerminalImageSequence.current === kittySequence) {
      return;
    }
    preparedTerminalImageSequence.current = kittySequence;
    process.nextTick(() => writeRaw(kittySequence));
  }, [kittySequence, writeRaw]);
  const titleWithSourceHint = /* @__PURE__ */ __name((title) => `${title} \xB7 source: ${sourceCopyCommand}`, "titleWithSourceHint");
  if (image?.kind === "terminal-image" && image.protocol === "kitty" && image.placeholder) {
    return /* @__PURE__ */ (0, import_jsx_runtime9.jsxs)(
      Box_default,
      {
        paddingLeft: MERMAID_PADDING,
        flexDirection: "column",
        width: contentWidth,
        flexShrink: 0,
        children: [
          /* @__PURE__ */ (0, import_jsx_runtime9.jsx)(Text, { bold: true, color: theme.text.accent, children: titleWithSourceHint(visual.title) }),
          /* @__PURE__ */ (0, import_jsx_runtime9.jsx)(
            MaxSizedBox,
            {
              maxHeight: availableTerminalHeight,
              maxWidth: innerWidth,
              overflowDirection: "bottom",
              children: image.placeholder.lines.map((line, index) => /* @__PURE__ */ (0, import_jsx_runtime9.jsx)(Box_default, { children: /* @__PURE__ */ (0, import_jsx_runtime9.jsx)(Text, { color: image.placeholder.color, wrap: "truncate-end", children: line }) }, index))
            }
          )
        ]
      }
    );
  }
  if (image?.kind === "ansi") {
    return /* @__PURE__ */ (0, import_jsx_runtime9.jsxs)(
      Box_default,
      {
        paddingLeft: MERMAID_PADDING,
        flexDirection: "column",
        width: contentWidth,
        flexShrink: 0,
        children: [
          /* @__PURE__ */ (0, import_jsx_runtime9.jsx)(Text, { bold: true, color: theme.text.accent, children: titleWithSourceHint(visual.title) }),
          /* @__PURE__ */ (0, import_jsx_runtime9.jsx)(
            MaxSizedBox,
            {
              maxHeight: availableTerminalHeight,
              maxWidth: innerWidth,
              overflowDirection: "bottom",
              children: image.lines.map((line, index) => /* @__PURE__ */ (0, import_jsx_runtime9.jsx)(Box_default, { children: /* @__PURE__ */ (0, import_jsx_runtime9.jsx)(Text, { children: line || " " }) }, index))
            }
          )
        ]
      }
    );
  }
  return /* @__PURE__ */ (0, import_jsx_runtime9.jsxs)(
    Box_default,
    {
      paddingLeft: MERMAID_PADDING,
      flexDirection: "column",
      width: contentWidth,
      flexShrink: 0,
      children: [
        /* @__PURE__ */ (0, import_jsx_runtime9.jsx)(Text, { bold: true, color: theme.text.accent, children: titleWithSourceHint(visual.title) }),
        /* @__PURE__ */ (0, import_jsx_runtime9.jsx)(
          MaxSizedBox,
          {
            maxHeight: availableTerminalHeight,
            maxWidth: innerWidth,
            overflowDirection: "bottom",
            children: visual.lines.map((line, index) => /* @__PURE__ */ (0, import_jsx_runtime9.jsx)(Box_default, { children: /* @__PURE__ */ (0, import_jsx_runtime9.jsx)(Text, { color: theme.text.primary, children: line || " " }) }, index))
          }
        ),
        visual.warning && /* @__PURE__ */ (0, import_jsx_runtime9.jsx)(Text, { color: theme.text.secondary, wrap: "wrap", children: visual.warning }),
        !isPending && image?.kind === "unavailable" && image.showReason !== false && /* @__PURE__ */ (0, import_jsx_runtime9.jsxs)(Text, { color: theme.text.secondary, wrap: "wrap", children: [
          "Image rendering unavailable: ",
          image.reason
        ] })
      ]
    }
  );
}, "MermaidDiagramInternal");
var MermaidDiagram = import_react13.default.memo(MermaidDiagramInternal);

// packages/cli/src/ui/utils/markdownUtilities.ts
init_esbuild_shims();
var findNextFence = /* @__PURE__ */ __name((content, from) => {
  const backtick = content.indexOf("```", from);
  const tilde = content.indexOf("~~~", from);
  if (backtick === -1 && tilde === -1) return null;
  let index;
  let char;
  if (tilde === -1 || backtick !== -1 && backtick < tilde) {
    index = backtick;
    char = "`";
  } else {
    index = tilde;
    char = "~";
  }
  let length = 0;
  while (content[index + length] === char) length++;
  return { index, char, length };
}, "findNextFence");
var getEnclosingFence = /* @__PURE__ */ __name((content, indexToTest) => {
  let open = null;
  let searchPos = 0;
  while (searchPos < content.length) {
    const fence = findNextFence(content, searchPos);
    if (!fence || fence.index >= indexToTest) break;
    if (!open) {
      open = { char: fence.char, len: fence.length, index: fence.index };
    } else if (fence.char === open.char && fence.length >= open.len) {
      open = null;
    }
    searchPos = fence.index + fence.length;
  }
  if (!open) return null;
  const newlineIndex = content.indexOf("\n", open.index);
  const fenceLineEnd = newlineIndex === -1 ? content.length : newlineIndex;
  return {
    startIndex: open.index,
    delimiter: content.slice(open.index, open.index + open.len),
    infoString: content.slice(open.index + open.len, fenceLineEnd)
  };
}, "getEnclosingFence");
var isIndexInsideCodeBlock = /* @__PURE__ */ __name((content, index) => getEnclosingFence(content, index) !== null, "isIndexInsideCodeBlock");
var findEnclosingCodeBlockStart = /* @__PURE__ */ __name((content, index) => getEnclosingFence(content, index)?.startIndex ?? -1, "findEnclosingCodeBlockStart");
var getEnclosingFenceInfo = /* @__PURE__ */ __name((content, index) => {
  const fence = getEnclosingFence(content, index);
  return fence ? parseCodeFenceInfo(fence.infoString) : null;
}, "getEnclosingFenceInfo");
var findLastSafeSplitPoint = /* @__PURE__ */ __name((content, idealMaxLength) => {
  const hasLengthCap = idealMaxLength !== void 0;
  const searchEnd = hasLengthCap ? Math.min(Math.max(idealMaxLength, 0), content.length) : content.length;
  if (hasLengthCap && content.length <= searchEnd) {
    return content.length;
  }
  const enclosingBlockStart = findEnclosingCodeBlockStart(content, searchEnd);
  if (enclosingBlockStart !== -1) {
    return hasLengthCap && enclosingBlockStart === 0 ? searchEnd : enclosingBlockStart;
  }
  let searchStartIndex = searchEnd;
  while (searchStartIndex >= 0) {
    const dnlIndex = content.lastIndexOf("\n\n", searchStartIndex);
    if (dnlIndex === -1) {
      break;
    }
    const potentialSplitPoint = dnlIndex + 2;
    if (potentialSplitPoint <= searchEnd && !isIndexInsideCodeBlock(content, potentialSplitPoint)) {
      return potentialSplitPoint;
    }
    searchStartIndex = dnlIndex - 1;
  }
  if (hasLengthCap) {
    searchStartIndex = searchEnd;
    while (searchStartIndex >= 0) {
      const nlIndex = content.lastIndexOf("\n", searchStartIndex);
      if (nlIndex === -1) {
        break;
      }
      const potentialSplitPoint = nlIndex + 1;
      if (potentialSplitPoint <= searchEnd && !isIndexInsideCodeBlock(content, potentialSplitPoint)) {
        return potentialSplitPoint;
      }
      searchStartIndex = nlIndex - 1;
    }
  }
  return hasLengthCap ? searchEnd : content.length;
}, "findLastSafeSplitPoint");
var START_LINE_DIRECTIVE_RE = /\s*\bqwen-code:start-line=(\d+)\b/;
var parseCodeFenceInfo = /* @__PURE__ */ __name((info) => {
  const raw = info ?? "";
  const directive = raw.match(START_LINE_DIRECTIVE_RE);
  const startLine = directive ? Math.max(1, Number(directive[1])) : 1;
  const lang = raw.replace(START_LINE_DIRECTIVE_RE, "").trim().split(/\s+/)[0];
  return { lang: lang || null, startLine };
}, "parseCodeFenceInfo");
var countHeadContentLines = /* @__PURE__ */ __name((content, fenceStartIndex, splitPoint) => {
  const headFromFence = content.slice(fenceStartIndex, splitPoint);
  const newlineCount = (headFromFence.match(/\n/g) || []).length;
  return Math.max(newlineCount - 1, 0);
}, "countHeadContentLines");
var splitFencedMarkdown = /* @__PURE__ */ __name((content, splitPoint) => {
  const before = content.slice(0, splitPoint);
  const after = content.slice(splitPoint);
  if (splitPoint <= 0 || splitPoint >= content.length) {
    return { before, after };
  }
  const fence = getEnclosingFence(content, splitPoint);
  if (!fence) {
    return { before, after };
  }
  const closingFence = fence.delimiter;
  const { startLine: headStart } = parseCodeFenceInfo(fence.infoString);
  const tailStart = headStart + countHeadContentLines(content, fence.startIndex, splitPoint);
  const baseInfo = fence.infoString.replace(START_LINE_DIRECTIVE_RE, "").replace(/\s+$/, "");
  const directive = `qwen-code:start-line=${tailStart}`;
  const reopeningFence = `${fence.delimiter}${baseInfo ? `${baseInfo} ${directive}` : directive}`;
  const beforeWithClose = before.endsWith("\n") ? `${before}${closingFence}
` : `${before}
${closingFence}
`;
  const afterWithReopen = `${reopeningFence}
${after}`;
  return { before: beforeWithClose, after: afterWithReopen };
}, "splitFencedMarkdown");

// packages/cli/src/ui/utils/MarkdownDisplay.tsx
var import_jsx_runtime10 = __toESM(require_jsx_runtime(), 1);
var MIN_PENDING_CONTENT_LINES = 1;
var TABLE_PENDING_RESERVED_ROWS = 3;
function countMarkdownSourceBlocks(text) {
  const codeBlockLanguageCounts = /* @__PURE__ */ new Map();
  const lines = text.split(/\r?\n/);
  const codeFenceRegex = CODE_FENCE_RE;
  const mathFenceRegex = /^ *\$\$ *$/;
  let activeCodeFence = null;
  let inMathBlock = false;
  let mathBlockCount = 0;
  for (const line of lines) {
    const codeFenceMatch = line.match(codeFenceRegex);
    if (activeCodeFence) {
      if (codeFenceMatch && codeFenceMatch[1].startsWith(activeCodeFence[0]) && codeFenceMatch[1].length >= activeCodeFence.length) {
        activeCodeFence = null;
      }
      continue;
    }
    if (inMathBlock) {
      if (mathFenceRegex.test(line)) {
        inMathBlock = false;
      }
      continue;
    }
    if (codeFenceMatch) {
      activeCodeFence = codeFenceMatch[1];
      const lang = parseCodeFenceInfo(codeFenceMatch[2]).lang?.toLowerCase();
      if (lang) {
        codeBlockLanguageCounts.set(
          lang,
          (codeBlockLanguageCounts.get(lang) ?? 0) + 1
        );
      }
      continue;
    }
    if (mathFenceRegex.test(line)) {
      inMathBlock = true;
      mathBlockCount += 1;
    }
  }
  return { codeBlockLanguageCounts, mathBlockCount };
}
__name(countMarkdownSourceBlocks, "countMarkdownSourceBlocks");
var EMPTY_LINE_HEIGHT = 1;
var CODE_BLOCK_PREFIX_PADDING = 1;
var LIST_ITEM_PREFIX_PADDING = 1;
var LIST_ITEM_TEXT_FLEX_GROW = 1;
var BLOCKQUOTE_PREFIX_PADDING = 1;
var MATH_BLOCK_PREFIX_PADDING = 1;
var MarkdownDisplayInternal = /* @__PURE__ */ __name(({
  text,
  isPending,
  availableTerminalHeight,
  contentWidth,
  textColor = theme.text.primary,
  sourceCopyIndexOffsets,
  enforceHeightBudget = false
}) => {
  const { renderMode } = useRenderMode();
  if (!text) return /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(import_jsx_runtime10.Fragment, {});
  const renderVisualBlocks = renderMode === "render";
  const displayText = isPending ? text.trimEnd() : text;
  const allLines = displayText.split(/\r?\n/);
  const pendingRenderedBudget = (isPending || enforceHeightBudget) && availableTerminalHeight !== void 0 ? Math.max(MIN_PENDING_CONTENT_LINES, availableTerminalHeight - 2) : void 0;
  const headerRegex = /^ *(#{1,4}) +(.*)/;
  const codeFenceRegex = CODE_FENCE_RE;
  const ulItemRegex = /^([ \t]*)([-*+]) +(.*)/;
  const olItemRegex = /^([ \t]*)(\d+)\. +(.*)/;
  const hrRegex = /^ *([-*_] *){3,} *$/;
  const blockquoteRegex = /^ *> ?(.*)$/;
  const mathFenceRegex = /^ *\$\$ *$/;
  const tableRowRegex = TABLE_ROW_RE;
  const tableSeparatorRegex = TABLE_SEPARATOR_RE;
  let lines = allLines;
  let droppedSourceLines = 0;
  if (pendingRenderedBudget !== void 0) {
    const tableClampRows = availableTerminalHeight !== void 0 ? Math.max(2, availableTerminalHeight - TABLE_PENDING_RESERVED_ROWS) : Number.MAX_SAFE_INTEGER;
    const { keptLines } = fitPendingSlice(
      allLines,
      contentWidth,
      pendingRenderedBudget,
      tableClampRows
    );
    if (keptLines < allLines.length) {
      lines = allLines.slice(0, keptLines);
      droppedSourceLines = allLines.length - keptLines;
    }
  }
  const showTruncationCue = enforceHeightBudget && !isPending && droppedSourceLines > 0;
  if (isPending && renderVisualBlocks && lines.length > 0) {
    let start = lines.length;
    while (start > 0 && /^\s*\|/.test(lines[start - 1])) start--;
    if (start < lines.length) {
      let activeCodeFence = "";
      let insideMathBlock = false;
      for (let i = 0; i < start; i++) {
        const line = lines[i];
        if (activeCodeFence) {
          const fenceMatch2 = line.match(codeFenceRegex);
          if (fenceMatch2 && fenceMatch2[1].startsWith(activeCodeFence[0]) && fenceMatch2[1].length >= activeCodeFence.length) {
            activeCodeFence = "";
          }
          continue;
        }
        if (insideMathBlock) {
          if (mathFenceRegex.test(line)) insideMathBlock = false;
          continue;
        }
        const fenceMatch = line.match(codeFenceRegex);
        if (fenceMatch) {
          activeCodeFence = fenceMatch[1];
        } else if (mathFenceRegex.test(line)) {
          insideMathBlock = true;
        }
      }
      const insideCodeFence = activeCodeFence !== "";
      let headerCells = 0;
      if (!insideCodeFence && !insideMathBlock) {
        let hdr = lines[start].replace(/^\s*\|/, "");
        if (/\|\s*$/.test(hdr)) hdr = hdr.replace(/\|\s*$/, "");
        headerCells = splitMarkdownTableRow(hdr).length;
      }
      if (headerCells >= 2) {
        const rest = lines.slice(start + 1);
        const hasMatchingSeparator = rest.some((l) => {
          if (!tableSeparatorRegex.test(l)) return false;
          const cols = splitMarkdownTableRow(l).filter(
            (c) => c.length > 0
          ).length;
          return cols === headerCells;
        });
        const lineAfterHeader = rest[0];
        const separatorIsTrailing = rest.length === 1;
        const looksLikeSeparatorPrefix = lineAfterHeader !== void 0 && lineAfterHeader.includes("|") && /^[\s|:-]*$/.test(lineAfterHeader);
        let couldStillBeTable = lineAfterHeader === void 0 || tableSeparatorRegex.test(lineAfterHeader) || separatorIsTrailing && looksLikeSeparatorPrefix;
        if (couldStillBeTable && lineAfterHeader !== void 0 && /\|\s*$/.test(lineAfterHeader)) {
          const sepCols = splitMarkdownTableRow(lineAfterHeader).filter(
            (c) => c.length > 0
          ).length;
          if (sepCols !== headerCells && (sepCols > headerCells || !separatorIsTrailing)) {
            couldStillBeTable = false;
          }
        }
        if (!hasMatchingSeparator && couldStillBeTable) {
          lines = lines.slice(0, start);
        }
      }
    }
  }
  const parseTableAligns = /* @__PURE__ */ __name((line) => splitMarkdownTableRow(line).filter((cell) => cell.length > 0).map((cell) => {
    const startsWithColon = cell.startsWith(":");
    const endsWithColon = cell.endsWith(":");
    if (startsWithColon && endsWithColon) return "center";
    if (endsWithColon) return "right";
    return "left";
  }), "parseTableAligns");
  const contentBlocks = [];
  let inCodeBlock = false;
  let codeBlockIndex = 0;
  let currentCodeBlockIndex = 0;
  let currentCodeBlockLangIndex = 0;
  let currentCodeBlockStartLine = 1;
  const codeBlockLanguageCounts = new Map(
    sourceCopyIndexOffsets?.codeBlockLanguageCounts
  );
  let lastLineEmpty = true;
  let codeBlockContent = [];
  let codeBlockLang = null;
  let codeBlockFence = "";
  let inMathBlock = false;
  let mathBlockIndex = sourceCopyIndexOffsets?.mathBlockCount ?? 0;
  let currentMathBlockIndex = 0;
  let mathBlockContent = [];
  let inTable = false;
  let tableRows = [];
  let tableHeaders = [];
  let tableAligns = [];
  function addContentBlock(block) {
    if (block) {
      contentBlocks.push(block);
      lastLineEmpty = false;
    }
  }
  __name(addContentBlock, "addContentBlock");
  lines.forEach((line, index) => {
    const key = `line-${index}`;
    if (inCodeBlock) {
      const fenceMatch = line.match(codeFenceRegex);
      if (fenceMatch && fenceMatch[1].startsWith(codeBlockFence[0]) && fenceMatch[1].length >= codeBlockFence.length) {
        addContentBlock(
          /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(
            RenderCodeBlock,
            {
              content: codeBlockContent,
              lang: codeBlockLang,
              codeBlockIndex: currentCodeBlockIndex,
              codeBlockLangIndex: currentCodeBlockLangIndex,
              isPending,
              availableTerminalHeight,
              contentWidth,
              startLineNumber: currentCodeBlockStartLine
            },
            key
          )
        );
        inCodeBlock = false;
        currentCodeBlockIndex = 0;
        currentCodeBlockLangIndex = 0;
        codeBlockContent = [];
        codeBlockLang = null;
        codeBlockFence = "";
      } else {
        codeBlockContent.push(line);
      }
      return;
    }
    if (inMathBlock) {
      if (mathFenceRegex.test(line)) {
        addContentBlock(
          /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(
            RenderMathBlock,
            {
              content: mathBlockContent,
              sourceCopyCommand: `/copy latex ${currentMathBlockIndex}`,
              contentWidth,
              isPending,
              availableTerminalHeight
            },
            key
          )
        );
        inMathBlock = false;
        currentMathBlockIndex = 0;
        mathBlockContent = [];
      } else {
        mathBlockContent.push(line);
      }
      return;
    }
    const codeFenceMatch = line.match(codeFenceRegex);
    const mathFenceMatch = line.match(mathFenceRegex);
    const headerMatch = line.match(headerRegex);
    const ulMatch = line.match(ulItemRegex);
    const olMatch = line.match(olItemRegex);
    const hrMatch = line.match(hrRegex);
    const blockquoteMatch = line.match(blockquoteRegex);
    const tableRowMatch = line.match(tableRowRegex);
    const tableSeparatorMatch = line.match(tableSeparatorRegex);
    if (codeFenceMatch) {
      inCodeBlock = true;
      codeBlockIndex += 1;
      currentCodeBlockIndex = codeBlockIndex;
      codeBlockFence = codeFenceMatch[1];
      const fenceInfo = parseCodeFenceInfo(codeFenceMatch[2]);
      codeBlockLang = fenceInfo.lang;
      currentCodeBlockStartLine = fenceInfo.startLine;
      if (codeBlockLang) {
        const normalizedLang = codeBlockLang.toLowerCase();
        const nextLangIndex = (codeBlockLanguageCounts.get(normalizedLang) ?? 0) + 1;
        codeBlockLanguageCounts.set(normalizedLang, nextLangIndex);
        currentCodeBlockLangIndex = nextLangIndex;
      } else {
        currentCodeBlockLangIndex = 0;
      }
    } else if (mathFenceMatch && renderVisualBlocks) {
      inMathBlock = true;
      mathBlockIndex += 1;
      currentMathBlockIndex = mathBlockIndex;
      mathBlockContent = [];
    } else if (tableRowMatch && !inTable && renderVisualBlocks) {
      const potentialHeaders = splitMarkdownTableRow(tableRowMatch[1]);
      const nextLine = index + 1 < lines.length ? lines[index + 1] : "";
      const sepMatch = nextLine.match(tableSeparatorRegex);
      const sepColCount = sepMatch ? splitMarkdownTableRow(nextLine).filter((c) => c.length > 0).length : 0;
      if (sepMatch && sepColCount === potentialHeaders.length) {
        inTable = true;
        tableHeaders = potentialHeaders;
        tableRows = [];
      } else {
        addContentBlock(
          /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(Box_default, { children: /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(Text, { wrap: "wrap", children: /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(
            RenderInline,
            {
              text: line,
              textColor,
              enableInlineMath: renderVisualBlocks
            }
          ) }) }, key)
        );
      }
    } else if (inTable && tableSeparatorMatch) {
      tableAligns = parseTableAligns(line);
    } else if (isPending && inTable && index === lines.length - 1 && tableHeaders.length > 0 && /^\s*\|/.test(line) && (!tableRowMatch || splitMarkdownTableRow(tableRowMatch[1]).length < tableHeaders.length)) {
    } else if (inTable && tableRowMatch) {
      const cells = splitMarkdownTableRow(tableRowMatch[1]);
      while (cells.length < tableHeaders.length) {
        cells.push("");
      }
      if (cells.length > tableHeaders.length) {
        cells.length = tableHeaders.length;
      }
      tableRows.push(cells);
    } else if (inTable && !tableRowMatch) {
      if (tableHeaders.length > 0 && tableRows.length > 0) {
        addContentBlock(
          /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(
            RenderTable,
            {
              headers: tableHeaders,
              rows: tableRows,
              contentWidth,
              aligns: tableAligns,
              enableInlineMath: renderVisualBlocks,
              isPending,
              isFrontier: false,
              availableTerminalHeight
            },
            `table-${contentBlocks.length}`
          )
        );
      }
      inTable = false;
      tableRows = [];
      tableHeaders = [];
      tableAligns = [];
      if (line.trim().length > 0) {
        addContentBlock(
          /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(Box_default, { children: /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(Text, { wrap: "wrap", children: /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(
            RenderInline,
            {
              text: line,
              textColor,
              enableInlineMath: renderVisualBlocks
            }
          ) }) }, key)
        );
      }
    } else if (hrMatch) {
      addContentBlock(
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(Box_default, { children: /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(Text, { dimColor: true, children: "---" }) }, key)
      );
    } else if (blockquoteMatch && renderVisualBlocks) {
      addContentBlock(
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(
          RenderBlockquote,
          {
            quoteText: blockquoteMatch[1],
            textColor,
            enableInlineMath: renderVisualBlocks
          },
          key
        )
      );
    } else if (headerMatch) {
      const level = headerMatch[1].length;
      const headerText = headerMatch[2];
      let headerNode = null;
      switch (level) {
        case 1:
          headerNode = /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(Text, { bold: true, color: textColor, children: /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(
            RenderInline,
            {
              text: headerText,
              textColor,
              enableInlineMath: renderVisualBlocks
            }
          ) });
          break;
        case 2:
          headerNode = /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(Text, { bold: true, color: textColor, children: /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(
            RenderInline,
            {
              text: headerText,
              textColor,
              enableInlineMath: renderVisualBlocks
            }
          ) });
          break;
        case 3:
          headerNode = /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(Text, { bold: true, color: textColor, children: /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(
            RenderInline,
            {
              text: headerText,
              textColor,
              enableInlineMath: renderVisualBlocks
            }
          ) });
          break;
        case 4:
          headerNode = /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(Text, { italic: true, color: textColor, children: /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(
            RenderInline,
            {
              text: headerText,
              textColor,
              enableInlineMath: renderVisualBlocks
            }
          ) });
          break;
        default:
          headerNode = /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(Text, { color: textColor, children: /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(
            RenderInline,
            {
              text: headerText,
              textColor,
              enableInlineMath: renderVisualBlocks
            }
          ) });
          break;
      }
      if (headerNode) addContentBlock(/* @__PURE__ */ (0, import_jsx_runtime10.jsx)(Box_default, { children: headerNode }, key));
    } else if (ulMatch) {
      const leadingWhitespace = ulMatch[1];
      const marker = ulMatch[2];
      const itemText = ulMatch[3];
      addContentBlock(
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(
          RenderListItem,
          {
            itemText,
            type: "ul",
            marker,
            leadingWhitespace,
            textColor,
            renderVisualBlocks
          },
          key
        )
      );
    } else if (olMatch) {
      const leadingWhitespace = olMatch[1];
      const marker = olMatch[2];
      const itemText = olMatch[3];
      addContentBlock(
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(
          RenderListItem,
          {
            itemText,
            type: "ol",
            marker,
            leadingWhitespace,
            textColor,
            renderVisualBlocks
          },
          key
        )
      );
    } else {
      if (line.trim().length === 0 && !inCodeBlock) {
        if (!lastLineEmpty) {
          contentBlocks.push(
            /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(Box_default, { height: EMPTY_LINE_HEIGHT }, `spacer-${index}`)
          );
          lastLineEmpty = true;
        }
      } else {
        addContentBlock(
          /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(Box_default, { children: /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(Text, { wrap: "wrap", color: textColor, children: /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(
            RenderInline,
            {
              text: line,
              textColor,
              enableInlineMath: renderVisualBlocks
            }
          ) }) }, key)
        );
      }
    }
  });
  if (inCodeBlock) {
    addContentBlock(
      /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(
        RenderCodeBlock,
        {
          content: codeBlockContent,
          lang: codeBlockLang,
          codeBlockIndex: currentCodeBlockIndex,
          codeBlockLangIndex: currentCodeBlockLangIndex,
          isPending,
          availableTerminalHeight,
          contentWidth,
          startLineNumber: currentCodeBlockStartLine
        },
        "line-eof"
      )
    );
  }
  if (inMathBlock) {
    addContentBlock(
      /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(
        RenderMathBlock,
        {
          content: mathBlockContent,
          sourceCopyCommand: `/copy latex ${currentMathBlockIndex}`,
          contentWidth,
          isPending,
          availableTerminalHeight
        },
        "math-eof"
      )
    );
  }
  if (inTable && tableHeaders.length > 0 && tableRows.length > 0) {
    addContentBlock(
      /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(
        RenderTable,
        {
          headers: tableHeaders,
          rows: tableRows,
          contentWidth,
          aligns: tableAligns,
          enableInlineMath: renderVisualBlocks,
          isPending,
          isFrontier: true,
          availableTerminalHeight
        },
        `table-${contentBlocks.length}`
      )
    );
  }
  if (showTruncationCue) {
    contentBlocks.push(
      /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(
        Text,
        {
          color: theme.text.secondary,
          wrap: "truncate-end",
          children: `... ${droppedSourceLines} more line${droppedSourceLines === 1 ? "" : "s"} not shown (viewport too small) ...`
        },
        `truncation-cue-${contentBlocks.length}`
      )
    );
  }
  return /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(import_jsx_runtime10.Fragment, { children: contentBlocks });
}, "MarkdownDisplayInternal");
var RenderCodeBlockInternal = /* @__PURE__ */ __name(({
  content,
  lang,
  codeBlockIndex,
  codeBlockLangIndex,
  isPending,
  availableTerminalHeight,
  contentWidth,
  startLineNumber = 1
}) => {
  const settings = useSettings();
  const { renderMode } = useRenderMode();
  const MIN_PREVIEW_LINES = 1;
  const RESERVED_LINES = 1;
  if (lang?.toLowerCase() === "mermaid" && renderMode === "render") {
    if (isPending) {
      return /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(
        RenderPendingMermaidBlock,
        {
          content,
          availableTerminalHeight,
          contentWidth
        }
      );
    }
    return /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(
      MermaidDiagram,
      {
        source: content.join("\n"),
        sourceCopyCommand: `/copy mermaid ${codeBlockLangIndex || codeBlockIndex}`,
        isPending,
        availableTerminalHeight,
        contentWidth
      }
    );
  }
  const fullContent = content.join("\n");
  if (isPending && availableTerminalHeight !== void 0) {
    const MAX_CODE_LINES_WHEN_PENDING = Math.max(
      0,
      availableTerminalHeight - RESERVED_LINES
    );
    if (content.length > MAX_CODE_LINES_WHEN_PENDING) {
      if (MAX_CODE_LINES_WHEN_PENDING < MIN_PREVIEW_LINES) {
        return /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(Box_default, { paddingLeft: CODE_BLOCK_PREFIX_PADDING, children: /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(Text, { color: theme.text.secondary, children: "... code is being written ..." }) });
      }
      const truncatedContent = content.slice(0, MAX_CODE_LINES_WHEN_PENDING);
      const colorizedTruncatedCode = colorizeCode(
        truncatedContent.join("\n"),
        lang,
        availableTerminalHeight,
        contentWidth - CODE_BLOCK_PREFIX_PADDING,
        { settings, startLineNumber }
      );
      return /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(Box_default, { paddingLeft: CODE_BLOCK_PREFIX_PADDING, flexDirection: "column", children: colorizedTruncatedCode });
    }
  }
  const colorizedCode = colorizeCode(
    fullContent,
    lang,
    availableTerminalHeight,
    contentWidth - CODE_BLOCK_PREFIX_PADDING,
    { settings, startLineNumber }
  );
  return /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(
    Box_default,
    {
      paddingLeft: CODE_BLOCK_PREFIX_PADDING,
      flexDirection: "column",
      width: contentWidth,
      flexShrink: 0,
      children: colorizedCode
    }
  );
}, "RenderCodeBlockInternal");
var RenderCodeBlock = import_react14.default.memo(RenderCodeBlockInternal);
var RenderPendingMermaidBlockInternal = /* @__PURE__ */ __name(({ content, availableTerminalHeight, contentWidth }) => {
  const maxPreviewLines = availableTerminalHeight === void 0 ? 6 : Math.max(0, availableTerminalHeight - 1);
  const previewLines = content.slice(0, maxPreviewLines);
  return /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)(
    Box_default,
    {
      paddingLeft: CODE_BLOCK_PREFIX_PADDING,
      flexDirection: "column",
      width: contentWidth,
      flexShrink: 0,
      children: [
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(Text, { color: theme.text.accent, children: "Mermaid diagram is being written..." }),
        previewLines.map((line, index) => /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(Text, { color: theme.text.secondary, wrap: "truncate-end", children: line || " " }, index))
      ]
    }
  );
}, "RenderPendingMermaidBlockInternal");
var RenderPendingMermaidBlock = import_react14.default.memo(RenderPendingMermaidBlockInternal);
var RenderMathBlockInternal = /* @__PURE__ */ __name(({
  content,
  sourceCopyCommand,
  contentWidth,
  isPending,
  availableTerminalHeight
}) => {
  const RESERVED_LINES = 2;
  if (isPending && availableTerminalHeight !== void 0) {
    const maxPreviewLines = Math.max(
      0,
      availableTerminalHeight - RESERVED_LINES
    );
    if (content.length > maxPreviewLines) {
      const previewLines = content.slice(0, maxPreviewLines);
      return /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)(
        Box_default,
        {
          paddingLeft: MATH_BLOCK_PREFIX_PADDING,
          flexDirection: "column",
          width: contentWidth,
          flexShrink: 0,
          children: [
            /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)(Text, { bold: true, color: theme.text.accent, children: [
              "LaTeX block \xB7 source: ",
              sourceCopyCommand
            ] }),
            previewLines.map((line, index) => /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(Text, { color: theme.text.secondary, wrap: "truncate-end", children: line || " " }, index))
          ]
        }
      );
    }
  }
  const rendered = renderInlineLatex(content.join(" "));
  return /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)(
    Box_default,
    {
      paddingLeft: MATH_BLOCK_PREFIX_PADDING,
      flexDirection: "column",
      width: contentWidth,
      flexShrink: 0,
      children: [
        /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)(Text, { bold: true, color: theme.text.accent, children: [
          "LaTeX block \xB7 source: ",
          sourceCopyCommand
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(Text, { color: theme.text.accent, wrap: "wrap", children: rendered })
      ]
    }
  );
}, "RenderMathBlockInternal");
var RenderMathBlock = import_react14.default.memo(RenderMathBlockInternal);
var RenderBlockquoteInternal = /* @__PURE__ */ __name(({
  quoteText,
  textColor = theme.text.primary,
  enableInlineMath = true
}) => /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)(Box_default, { paddingLeft: BLOCKQUOTE_PREFIX_PADDING, flexDirection: "row", children: [
  /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(Text, { color: theme.text.secondary, children: "\u2502 " }),
  /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(Box_default, { flexGrow: LIST_ITEM_TEXT_FLEX_GROW, children: /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(Text, { wrap: "wrap", color: textColor, italic: true, children: /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(
    RenderInline,
    {
      text: quoteText,
      textColor,
      enableInlineMath
    }
  ) }) })
] }), "RenderBlockquoteInternal");
var RenderBlockquote = import_react14.default.memo(RenderBlockquoteInternal);
var RenderListItemInternal = /* @__PURE__ */ __name(({
  itemText,
  type,
  marker,
  leadingWhitespace = "",
  textColor = theme.text.primary,
  renderVisualBlocks = true
}) => {
  const taskMatch = itemText.match(/^\[([ xX])\]\s+(.*)$/);
  const isTaskItem = taskMatch !== null && renderVisualBlocks;
  const isTaskChecked = taskMatch?.[1]?.toLowerCase() === "x";
  const effectiveItemText = isTaskItem ? taskMatch[2] : itemText;
  const prefix = isTaskItem ? `${isTaskChecked ? "\u2713" : ICON.CIRCLE_EMPTY} ` : type === "ol" ? `${marker}. ` : `${marker} `;
  const prefixWidth = stringWidth(prefix);
  const indentation = leadingWhitespace.length;
  return /* @__PURE__ */ (0, import_jsx_runtime10.jsxs)(
    Box_default,
    {
      paddingLeft: indentation + LIST_ITEM_PREFIX_PADDING,
      flexDirection: "row",
      children: [
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(Box_default, { width: prefixWidth, children: /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(Text, { color: textColor, children: prefix }) }),
        /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(Box_default, { flexGrow: LIST_ITEM_TEXT_FLEX_GROW, children: /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(Text, { wrap: "wrap", color: textColor, children: /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(
          RenderInline,
          {
            text: effectiveItemText,
            textColor,
            enableInlineMath: renderVisualBlocks
          }
        ) }) })
      ]
    }
  );
}, "RenderListItemInternal");
var RenderListItem = import_react14.default.memo(RenderListItemInternal);
var RenderTableInternal = /* @__PURE__ */ __name(({
  headers,
  rows,
  contentWidth,
  aligns,
  enableInlineMath = false,
  isPending = false,
  isFrontier = true,
  availableTerminalHeight
}) => {
  const maxHeight = isPending && availableTerminalHeight !== void 0 ? Math.max(2, availableTerminalHeight - TABLE_PENDING_RESERVED_ROWS) : void 0;
  return /* @__PURE__ */ (0, import_jsx_runtime10.jsx)(
    TableRenderer,
    {
      headers,
      rows,
      contentWidth,
      aligns,
      enableInlineMath,
      isStreaming: isPending && isFrontier,
      maxHeight
    }
  );
}, "RenderTableInternal");
var RenderTable = import_react14.default.memo(RenderTableInternal);
var MarkdownDisplay = import_react14.default.memo(MarkdownDisplayInternal);

// packages/cli/src/ui/components/AnsiOutput.tsx
init_esbuild_shims();
var import_jsx_runtime11 = __toESM(require_jsx_runtime(), 1);
var DEFAULT_HEIGHT = 24;
var AnsiOutputText = /* @__PURE__ */ __name(({
  data,
  availableTerminalHeight,
  maxWidth
}) => {
  const lastLines = data.slice(
    -(availableTerminalHeight && availableTerminalHeight > 0 ? availableTerminalHeight : DEFAULT_HEIGHT)
  );
  return /* @__PURE__ */ (0, import_jsx_runtime11.jsx)(MaxSizedBox, { maxHeight: availableTerminalHeight, maxWidth, children: lastLines.map((line, lineIndex) => /* @__PURE__ */ (0, import_jsx_runtime11.jsx)(Box_default, { children: line.length > 0 ? line.map((token, tokenIndex) => /* @__PURE__ */ (0, import_jsx_runtime11.jsx)(
    Text,
    {
      color: token.inverse ? token.bg : token.fg,
      backgroundColor: token.inverse ? token.fg : token.bg,
      dimColor: token.dim,
      bold: token.bold,
      italic: token.italic,
      underline: token.underline,
      wrap: "truncate",
      children: token.text
    },
    tokenIndex
  )) : null }, lineIndex)) });
}, "AnsiOutputText");
var ShellStatsBar = /* @__PURE__ */ __name(({
  totalLines,
  totalBytes,
  displayHeight = DEFAULT_HEIGHT
}) => {
  const parts = [];
  if (totalLines && totalLines > displayHeight) {
    parts.push(`+${totalLines - displayHeight} lines`);
  }
  if (totalBytes && totalBytes > 0) {
    parts.push(formatMemoryUsage(totalBytes));
  }
  if (parts.length === 0) return null;
  return /* @__PURE__ */ (0, import_jsx_runtime11.jsx)(Box_default, { flexDirection: "row", gap: 1, children: parts.map((part, i) => /* @__PURE__ */ (0, import_jsx_runtime11.jsx)(Text, { color: theme.text.secondary, children: part }, i)) });
}, "ShellStatsBar");

// packages/cli/src/ui/components/TodoDisplay.tsx
init_esbuild_shims();

// packages/cli/src/ui/colors.ts
init_esbuild_shims();
var Colors = {
  get type() {
    return themeManager.getActiveTheme().colors.type;
  },
  get Foreground() {
    return themeManager.getActiveTheme().colors.Foreground;
  },
  get Background() {
    return themeManager.getActiveTheme().colors.Background;
  },
  get LightBlue() {
    return themeManager.getActiveTheme().colors.LightBlue;
  },
  get AccentBlue() {
    return themeManager.getActiveTheme().colors.AccentBlue;
  },
  get AccentPurple() {
    return themeManager.getActiveTheme().colors.AccentPurple;
  },
  get AccentCyan() {
    return themeManager.getActiveTheme().colors.AccentCyan;
  },
  get AccentGreen() {
    return themeManager.getActiveTheme().colors.AccentGreen;
  },
  get AccentYellow() {
    return themeManager.getActiveTheme().colors.AccentYellow;
  },
  get AccentRed() {
    return themeManager.getActiveTheme().colors.AccentRed;
  },
  get AccentYellowDim() {
    return themeManager.getActiveTheme().colors.AccentYellowDim;
  },
  get AccentRedDim() {
    return themeManager.getActiveTheme().colors.AccentRedDim;
  },
  get DiffAdded() {
    return themeManager.getActiveTheme().colors.DiffAdded;
  },
  get DiffRemoved() {
    return themeManager.getActiveTheme().colors.DiffRemoved;
  },
  get Comment() {
    return themeManager.getActiveTheme().colors.Comment;
  },
  get Gray() {
    return themeManager.getActiveTheme().colors.Gray;
  },
  get GradientColors() {
    return themeManager.getActiveTheme().colors.GradientColors;
  }
};

// packages/cli/src/ui/components/TodoDisplay.tsx
var import_jsx_runtime12 = __toESM(require_jsx_runtime(), 1);
var STATUS_ICONS = {
  pending: ICON.CIRCLE_EMPTY,
  in_progress: ICON.CIRCLE_LEFT_HALF,
  completed: ICON.CIRCLE_FILLED
};
var TodoDisplay = /* @__PURE__ */ __name(({ todos }) => {
  if (!todos || todos.length === 0) {
    return null;
  }
  return /* @__PURE__ */ (0, import_jsx_runtime12.jsx)(Box_default, { flexDirection: "column", children: todos.map((todo) => /* @__PURE__ */ (0, import_jsx_runtime12.jsx)(TodoItemRow, { todo }, todo.id)) });
}, "TodoDisplay");
var TodoItemRow = /* @__PURE__ */ __name(({ todo }) => {
  const statusIcon = STATUS_ICONS[todo.status];
  const isCompleted = todo.status === "completed";
  const isInProgress = todo.status === "in_progress";
  const itemColor = isCompleted ? Colors.Foreground : isInProgress ? Colors.AccentGreen : Colors.Foreground;
  return /* @__PURE__ */ (0, import_jsx_runtime12.jsxs)(Box_default, { flexDirection: "row", minHeight: 1, children: [
    /* @__PURE__ */ (0, import_jsx_runtime12.jsx)(Box_default, { width: 3, children: /* @__PURE__ */ (0, import_jsx_runtime12.jsx)(Text, { color: itemColor, children: statusIcon }) }),
    /* @__PURE__ */ (0, import_jsx_runtime12.jsx)(Box_default, { flexGrow: 1, children: /* @__PURE__ */ (0, import_jsx_runtime12.jsx)(Text, { color: itemColor, strikethrough: isCompleted, wrap: "wrap", children: todo.content }) })
  ] });
}, "TodoItemRow");

// packages/cli/src/ui/components/FindingsDisplay.tsx
init_esbuild_shims();
var import_jsx_runtime13 = (
  // The unverified banner precedes the empty-state branch: an empty list is
  // still the product of the pass that reported it, and a low-effort "no
  // findings" that renders without the marker reads as a verified clean bill.
  __toESM(require_jsx_runtime(), 1)
);
var SEVERITY_COLORS = {
  Critical: /* @__PURE__ */ __name(() => Colors.AccentRed, "Critical"),
  Suggestion: /* @__PURE__ */ __name(() => Colors.AccentYellow, "Suggestion"),
  "Nice to have": /* @__PURE__ */ __name(() => Colors.Gray, "Nice to have")
};
function terminalSafe(text) {
  const withoutControls = text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
  return withoutControls.replace(/\s+/g, " ").trim();
}
__name(terminalSafe, "terminalSafe");
var OUTCOME_LABELS = {
  fixed: "fixed",
  skipped: "skipped",
  no_change_needed: "no change needed"
};
var FindingsDisplay = /* @__PURE__ */ __name(({ data }) => /* @__PURE__ */ (0, import_jsx_runtime13.jsxs)(Box_default, { flexDirection: "column", children: [
  data.level === "low" && /* @__PURE__ */ (0, import_jsx_runtime13.jsx)(Box_default, { minHeight: 1, children: /* @__PURE__ */ (0, import_jsx_runtime13.jsx)(Text, { color: Colors.Gray, children: "(low-effort pass \u2014 findings are unverified)" }) }),
  data.findings.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime13.jsx)(Text, { color: Colors.Gray, children: "No findings." }) : data.findings.map((finding, index) => /* @__PURE__ */ (0, import_jsx_runtime13.jsx)(
    FindingRow,
    {
      finding
    },
    finding.id ?? `${finding.file}:${finding.line ?? ""}:${index}`
  )),
  data.omittedFindings !== void 0 && data.omittedFindings > 0 && /* @__PURE__ */ (0, import_jsx_runtime13.jsx)(Text, { color: Colors.Gray, children: `(+${data.omittedFindings} more finding${data.omittedFindings === 1 ? "" : "s"} removed by history compaction)` })
] }), "FindingsDisplay");
var FindingRow = /* @__PURE__ */ __name(({ finding }) => {
  const severityColor = SEVERITY_COLORS[finding.severity]();
  const resolved = finding.outcome === "fixed" || finding.outcome === "no_change_needed";
  const icon = finding.outcome === void 0 ? ICON.CIRCLE_FILLED : resolved ? ICON.CHECK : ICON.CIRCLE_EMPTY;
  const where = terminalSafe(
    `${finding.file}${finding.line !== void 0 ? `:${finding.line}` : ""}`
  );
  return /* @__PURE__ */ (0, import_jsx_runtime13.jsxs)(Box_default, { flexDirection: "row", minHeight: 1, children: [
    /* @__PURE__ */ (0, import_jsx_runtime13.jsx)(Box_default, { width: 3, flexShrink: 0, children: /* @__PURE__ */ (0, import_jsx_runtime13.jsx)(Text, { color: resolved ? Colors.AccentGreen : severityColor, children: icon }) }),
    /* @__PURE__ */ (0, import_jsx_runtime13.jsx)(Box_default, { flexGrow: 1, children: /* @__PURE__ */ (0, import_jsx_runtime13.jsxs)(Text, { wrap: "wrap", children: [
      /* @__PURE__ */ (0, import_jsx_runtime13.jsx)(Text, { color: severityColor, bold: finding.severity === "Critical", children: finding.severity }),
      /* @__PURE__ */ (0, import_jsx_runtime13.jsxs)(Text, { color: Colors.Gray, children: [
        finding.id ? ` ${terminalSafe(finding.id)}` : "",
        " "
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime13.jsx)(Text, { color: Colors.AccentCyan, children: where }),
      /* @__PURE__ */ (0, import_jsx_runtime13.jsxs)(Text, { color: Colors.Foreground, strikethrough: resolved, children: [
        " ",
        terminalSafe(finding.shortSummary)
      ] }),
      finding.confidence === "low" && /* @__PURE__ */ (0, import_jsx_runtime13.jsx)(Text, { color: Colors.Gray, children: " (low confidence)" }),
      finding.outcome && /* @__PURE__ */ (0, import_jsx_runtime13.jsxs)(Text, { color: resolved ? Colors.AccentGreen : Colors.AccentYellow, children: [
        " ",
        "(",
        OUTCOME_LABELS[finding.outcome],
        finding.outcome === "skipped" && finding.outcomeNote ? `: ${terminalSafe(finding.outcomeNote)}` : "",
        ")"
      ] })
    ] }) })
  ] });
}, "FindingRow");

// packages/cli/src/ui/components/messages/ToolConfirmationMessage.tsx
init_esbuild_shims();
var import_react23 = __toESM(require_react(), 1);
import { promises as fs2 } from "node:fs";
import * as os2 from "node:os";
import * as path from "node:path";

// packages/cli/src/ui/components/shared/RadioButtonSelect.tsx
init_esbuild_shims();

// packages/cli/src/ui/components/shared/BaseSelectionList.tsx
init_esbuild_shims();
var import_react19 = __toESM(require_react(), 1);

// packages/cli/src/ui/hooks/useSelectionList.ts
init_esbuild_shims();
var import_react15 = __toESM(require_react(), 1);
var debugLogger5 = createDebugLogger("SELECTION_LIST");
var NUMBER_INPUT_TIMEOUT_MS = 1e3;
var findNextValidIndex = /* @__PURE__ */ __name((currentIndex, direction, items) => {
  const len = items.length;
  if (len === 0) return currentIndex;
  let nextIndex = currentIndex;
  const step = direction === "down" ? 1 : -1;
  for (let i = 0; i < len; i++) {
    nextIndex = (nextIndex + step + len) % len;
    if (!items[nextIndex]?.disabled) {
      return nextIndex;
    }
  }
  return currentIndex;
}, "findNextValidIndex");
var computeInitialIndex = /* @__PURE__ */ __name((initialIndex, items, initialKey) => {
  if (items.length === 0) {
    return 0;
  }
  if (initialKey !== void 0) {
    for (let i = 0; i < items.length; i++) {
      if (items[i].key === initialKey && !items[i].disabled) {
        return i;
      }
    }
  }
  let targetIndex = initialIndex;
  if (targetIndex < 0 || targetIndex >= items.length) {
    targetIndex = 0;
  }
  if (items[targetIndex]?.disabled) {
    const nextValid = findNextValidIndex(targetIndex, "down", items);
    targetIndex = nextValid;
  }
  return targetIndex;
}, "computeInitialIndex");
var areItemsStructurallyEqual = /* @__PURE__ */ __name((a, b) => {
  if (a === b) {
    return true;
  }
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i]?.key !== b[i]?.key || a[i]?.disabled !== b[i]?.disabled) {
      return false;
    }
  }
  return true;
}, "areItemsStructurallyEqual");
function selectionListReducer(state, action) {
  switch (action.type) {
    case "SET_ACTIVE_INDEX": {
      const { index, items } = action.payload;
      if (index === state.activeIndex) {
        return state;
      }
      if (index >= 0 && index < items.length) {
        return { ...state, activeIndex: index, pendingHighlight: true };
      }
      return state;
    }
    case "MOVE_UP": {
      const { items } = action.payload;
      const newIndex = findNextValidIndex(state.activeIndex, "up", items);
      if (newIndex !== state.activeIndex) {
        return { ...state, activeIndex: newIndex, pendingHighlight: true };
      }
      return state;
    }
    case "MOVE_DOWN": {
      const { items } = action.payload;
      const newIndex = findNextValidIndex(state.activeIndex, "down", items);
      if (newIndex !== state.activeIndex) {
        return { ...state, activeIndex: newIndex, pendingHighlight: true };
      }
      return state;
    }
    case "SELECT_CURRENT": {
      return { ...state, pendingSelect: true };
    }
    case "INITIALIZE": {
      const { initialIndex, items } = action.payload;
      const initialIndexChanged = initialIndex !== state.initialIndex;
      const activeKey = !initialIndexChanged && state.activeIndex !== state.initialIndex ? state.items[state.activeIndex]?.key : void 0;
      const targetIndex = computeInitialIndex(initialIndex, items, activeKey);
      const itemsStructurallyEqual = areItemsStructurallyEqual(
        items,
        state.items
      );
      if (!initialIndexChanged && targetIndex === state.activeIndex && itemsStructurallyEqual) {
        return state;
      }
      return {
        ...state,
        items: itemsStructurallyEqual ? state.items : items,
        activeIndex: targetIndex,
        initialIndex,
        pendingHighlight: false
      };
    }
    case "CLEAR_PENDING_FLAGS": {
      return {
        ...state,
        pendingHighlight: false,
        pendingSelect: false
      };
    }
    default: {
      const exhaustiveCheck = action;
      debugLogger5.error(`Unknown selection list action: ${exhaustiveCheck}`);
      return state;
    }
  }
}
__name(selectionListReducer, "selectionListReducer");
function useSelectionList({
  items,
  initialIndex = 0,
  onSelect,
  onHighlight,
  isFocused = true,
  showNumbers = false,
  disableVimNav = false
}) {
  const [state, dispatch] = (0, import_react15.useReducer)(selectionListReducer, {
    activeIndex: computeInitialIndex(initialIndex, items),
    initialIndex,
    pendingHighlight: false,
    pendingSelect: false,
    items
  });
  const numberInputRef = (0, import_react15.useRef)("");
  const numberInputTimer = (0, import_react15.useRef)(null);
  (0, import_react15.useEffect)(() => {
    dispatch({ type: "INITIALIZE", payload: { initialIndex, items } });
  }, [initialIndex, items]);
  (0, import_react15.useEffect)(() => {
    let needsClear = false;
    if (state.pendingHighlight && items[state.activeIndex]) {
      onHighlight?.(items[state.activeIndex].value);
      needsClear = true;
    }
    if (state.pendingSelect && items[state.activeIndex]) {
      const currentItem = items[state.activeIndex];
      if (currentItem && !currentItem.disabled) {
        onSelect(currentItem.value);
      }
      needsClear = true;
    }
    if (needsClear) {
      dispatch({ type: "CLEAR_PENDING_FLAGS" });
    }
  }, [
    state.pendingHighlight,
    state.pendingSelect,
    state.activeIndex,
    items,
    onHighlight,
    onSelect
  ]);
  (0, import_react15.useEffect)(
    () => () => {
      if (numberInputTimer.current) {
        clearTimeout(numberInputTimer.current);
      }
    },
    []
  );
  useKeypress(
    (key) => {
      const { sequence, name } = key;
      const isNumeric = showNumbers && /^[0-9]$/.test(sequence);
      if (!isNumeric && numberInputTimer.current) {
        clearTimeout(numberInputTimer.current);
        numberInputRef.current = "";
      }
      if (keyMatchers["selectionUp" /* SELECTION_UP */](key)) {
        if (disableVimNav && key.name === "k" && !key.ctrl) {
        } else {
          dispatch({ type: "MOVE_UP", payload: { items } });
          return;
        }
      }
      if (keyMatchers["selectionDown" /* SELECTION_DOWN */](key)) {
        if (disableVimNav && key.name === "j" && !key.ctrl) {
        } else {
          dispatch({ type: "MOVE_DOWN", payload: { items } });
          return;
        }
      }
      if (name === "return") {
        dispatch({ type: "SELECT_CURRENT", payload: { items } });
        return;
      }
      if (isNumeric) {
        if (numberInputTimer.current) {
          clearTimeout(numberInputTimer.current);
        }
        const newNumberInput = numberInputRef.current + sequence;
        numberInputRef.current = newNumberInput;
        const targetIndex = Number.parseInt(newNumberInput, 10) - 1;
        if (newNumberInput === "0") {
          numberInputTimer.current = setTimeout(() => {
            numberInputRef.current = "";
          }, NUMBER_INPUT_TIMEOUT_MS);
          return;
        }
        if (targetIndex >= 0 && targetIndex < items.length) {
          dispatch({
            type: "SET_ACTIVE_INDEX",
            payload: { index: targetIndex, items }
          });
          const potentialNextNumber = Number.parseInt(newNumberInput + "0", 10);
          if (potentialNextNumber > items.length) {
            dispatch({
              type: "SELECT_CURRENT",
              payload: { items }
            });
            numberInputRef.current = "";
          } else {
            numberInputTimer.current = setTimeout(() => {
              dispatch({
                type: "SELECT_CURRENT",
                payload: { items }
              });
              numberInputRef.current = "";
            }, NUMBER_INPUT_TIMEOUT_MS);
          }
        } else {
          numberInputRef.current = "";
        }
      }
    },
    { isActive: !!(isFocused && items.length > 0) }
  );
  const setActiveIndex = /* @__PURE__ */ __name((index) => {
    dispatch({
      type: "SET_ACTIVE_INDEX",
      payload: { index, items }
    });
  }, "setActiveIndex");
  const selectIndex = /* @__PURE__ */ __name((index) => {
    if (items[index]?.disabled) return;
    dispatch({ type: "SET_ACTIVE_INDEX", payload: { index, items } });
    dispatch({ type: "SELECT_CURRENT", payload: { items } });
  }, "selectIndex");
  return {
    activeIndex: state.activeIndex,
    setActiveIndex,
    selectIndex
  };
}
__name(useSelectionList, "useSelectionList");

// packages/cli/src/ui/hooks/use-mouse-tracking-enabled.ts
init_esbuild_shims();
var import_react16 = __toESM(require_react(), 1);
function useMouseTrackingEnabled() {
  return (0, import_react16.useContext)(SettingsContext)?.merged.ui?.mouseTracking !== false;
}
__name(useMouseTrackingEnabled, "useMouseTrackingEnabled");

// packages/cli/src/ui/components/shared/RowMouseController.tsx
init_esbuild_shims();
var import_react18 = __toESM(require_react(), 1);

// packages/cli/src/ui/hooks/useMouseEvents.ts
init_esbuild_shims();
var import_react17 = __toESM(require_react(), 1);
var mouseModeRefs = /* @__PURE__ */ new Map();
function effectiveTracking(entry) {
  if (entry.any > 0) return "any";
  if (entry.button > 0) return "button";
  return null;
}
__name(effectiveTracking, "effectiveTracking");
function reconcileMouseMode(stdout, entry) {
  const desired = effectiveTracking(entry);
  if (desired === entry.active) return;
  if (entry.active) disableMouseEvents(stdout, entry.active);
  if (desired) enableMouseEvents(stdout, desired);
  entry.active = desired;
}
__name(reconcileMouseMode, "reconcileMouseMode");
var disableAllMouseModes = /* @__PURE__ */ __name(() => {
  for (const [stdout, entry] of mouseModeRefs) {
    if (entry.active) disableMouseEvents(stdout, entry.active);
  }
  mouseModeRefs.clear();
}, "disableAllMouseModes");
function acquireMouseMode(stdout, tracking) {
  let entry = mouseModeRefs.get(stdout);
  if (!entry) {
    if (mouseModeRefs.size === 0) {
      process.on("exit", disableAllMouseModes);
    }
    entry = { button: 0, any: 0, active: null };
    mouseModeRefs.set(stdout, entry);
  }
  entry[tracking] += 1;
  reconcileMouseMode(stdout, entry);
}
__name(acquireMouseMode, "acquireMouseMode");
function releaseMouseMode(stdout, tracking) {
  const entry = mouseModeRefs.get(stdout);
  if (!entry) return;
  entry[tracking] = Math.max(0, entry[tracking] - 1);
  reconcileMouseMode(stdout, entry);
  if (entry.button === 0 && entry.any === 0) {
    mouseModeRefs.delete(stdout);
    if (mouseModeRefs.size === 0) {
      process.removeListener("exit", disableAllMouseModes);
    }
  }
}
__name(releaseMouseMode, "releaseMouseMode");
function useMouseEvents(handler, { isActive, tracking = "button", bypassVpGate = false }) {
  const { isRawModeSupported } = use_stdin_default();
  const { stdout } = use_stdout_default();
  const { subscribeMouse, unsubscribeMouse } = useKeypressContext();
  const settings = (0, import_react17.useContext)(SettingsContext);
  const isVpMode = useVirtualViewport(settings?.merged.ui?.useTerminalBuffer);
  const vpGateOpen = isVpMode || bypassVpGate;
  const handlerRef = (0, import_react17.useRef)(handler);
  handlerRef.current = handler;
  const mouseTrackingEnabled = useMouseTrackingEnabled();
  const enabled = isActive && isRawModeSupported && vpGateOpen && mouseTrackingEnabled && Boolean(stdout.isTTY);
  const enabledRef = (0, import_react17.useRef)(enabled);
  enabledRef.current = enabled;
  (0, import_react17.useEffect)(() => {
    if (!enabled) return;
    acquireMouseMode(stdout, tracking);
    return () => {
      releaseMouseMode(stdout, tracking);
    };
  }, [enabled, stdout, tracking]);
  const mouseCallback = (0, import_react17.useCallback)((event) => {
    if (!enabledRef.current) return;
    handlerRef.current(event);
  }, []);
  (0, import_react17.useEffect)(() => {
    if (!enabled) return;
    subscribeMouse(mouseCallback);
    return () => unsubscribeMouse(mouseCallback);
  }, [enabled, subscribeMouse, unsubscribeMouse, mouseCallback]);
}
__name(useMouseEvents, "useMouseEvents");

// packages/cli/src/ui/utils/mouse-hit.ts
init_esbuild_shims();

// packages/cli/src/ui/utils/measure-element-position.ts
init_esbuild_shims();

// packages/cli/src/ui/utils/list-mouse.ts
init_esbuild_shims();
function frameAnchor(terminalHeight, frameHeight) {
  return Math.min(0, terminalHeight - frameHeight);
}
__name(frameAnchor, "frameAnchor");
function terminalRowToLayoutRow(terminalRow1Based, anchor) {
  return terminalRow1Based - 1 - anchor;
}
__name(terminalRowToLayoutRow, "terminalRowToLayoutRow");
function findItemAtLayoutRow(rects, layoutRow) {
  for (const rect of rects) {
    if (layoutRow >= rect.top && layoutRow < rect.top + rect.height) {
      return rect.index;
    }
  }
  return null;
}
__name(findItemAtLayoutRow, "findItemAtLayoutRow");

// packages/cli/src/ui/utils/measure-element-position.ts
function measureElementPosition(node) {
  const { yogaNode } = node;
  if (!yogaNode) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  let x = yogaNode.getComputedLeft();
  let y = yogaNode.getComputedTop();
  let current = node.parentNode;
  while (current) {
    if (current.yogaNode) {
      x += current.yogaNode.getComputedLeft();
      y += current.yogaNode.getComputedTop();
    }
    current = current.parentNode;
  }
  return {
    x,
    y,
    width: yogaNode.getComputedWidth(),
    height: yogaNode.getComputedHeight()
  };
}
__name(measureElementPosition, "measureElementPosition");
function measureFrameHeight(node) {
  let root = node;
  let current = node;
  while (current) {
    root = current;
    current = current.parentNode;
  }
  return root.yogaNode?.getComputedHeight() ?? 0;
}
__name(measureFrameHeight, "measureFrameHeight");
function layoutRowForEvent(node, terminalRow1Based, terminalHeight) {
  const anchor = frameAnchor(terminalHeight, measureFrameHeight(node));
  return terminalRowToLayoutRow(terminalRow1Based, anchor);
}
__name(layoutRowForEvent, "layoutRowForEvent");

// packages/cli/src/ui/utils/mouse-hit.ts
function containsPoint(rect, point) {
  const containsRow = point.y >= rect.y && point.y < rect.y + rect.height;
  return containsRow && point.x >= rect.x && point.x < rect.x + rect.width;
}
__name(containsPoint, "containsPoint");
function findElementAtMouseEvent(container, elements, event, terminalHeight, mode, indexOffset = 0) {
  if (!container) return null;
  const point = {
    x: event.col - 1,
    y: layoutRowForEvent(container, event.row, terminalHeight)
  };
  const containerRect = measureElementPosition(container);
  if (containerRect.width > 0 && (point.x < containerRect.x || point.x >= containerRect.x + containerRect.width)) {
    return null;
  }
  if (mode === "row") {
    const rects = [];
    for (let index = 0; index < elements.length; index++) {
      const element = elements[index];
      if (!element) continue;
      const rect = measureElementPosition(element);
      if (rect.height <= 0) continue;
      rects.push({
        index: indexOffset + index,
        top: rect.y,
        height: rect.height
      });
    }
    return findItemAtLayoutRow(rects, point.y);
  }
  for (let index = 0; index < elements.length; index++) {
    const element = elements[index];
    if (!element) continue;
    const rect = measureElementPosition(element);
    if (rect.height <= 0 || rect.width <= 0) continue;
    if (containsPoint(rect, point)) return index;
  }
  return null;
}
__name(findElementAtMouseEvent, "findElementAtMouseEvent");

// packages/cli/src/ui/components/shared/RowMouseController.tsx
function RowMouseController({
  containerRef,
  itemRefs,
  scrollOffset,
  isDisabled,
  onHoverIndex,
  onSelectIndex
}) {
  const { rows: terminalHeight } = useTerminalSize();
  const { menu: contextMenu } = useContextMenu();
  const resolveIndex = (0, import_react18.useCallback)(
    (event) => findElementAtMouseEvent(
      containerRef.current,
      itemRefs.current,
      event,
      terminalHeight,
      "row",
      scrollOffset
    ),
    [containerRef, itemRefs, scrollOffset, terminalHeight]
  );
  const handleMouse = (0, import_react18.useCallback)(
    (event) => {
      if (event.name !== "move" && event.name !== "left-press") return;
      const index = resolveIndex(event);
      if (index === null || isDisabled?.(index)) return;
      if (event.name === "move") {
        onHoverIndex(index);
      } else {
        onSelectIndex(index);
      }
    },
    [resolveIndex, isDisabled, onHoverIndex, onSelectIndex]
  );
  useMouseEvents(handleMouse, {
    isActive: contextMenu === null,
    tracking: "any"
  });
  return null;
}
__name(RowMouseController, "RowMouseController");

// packages/cli/src/ui/components/shared/BaseSelectionList.tsx
var import_jsx_runtime14 = __toESM(require_jsx_runtime(), 1);
function getScrollOffsetForIndex(activeIndex, itemCount, maxItemsToShow) {
  return Math.max(
    0,
    Math.min(activeIndex - maxItemsToShow + 1, itemCount - maxItemsToShow)
  );
}
__name(getScrollOffsetForIndex, "getScrollOffsetForIndex");
function BaseSelectionList({
  items,
  initialIndex = 0,
  onSelect,
  onHighlight,
  isFocused = true,
  showNumbers = true,
  showScrollArrows = false,
  maxItemsToShow = 10,
  itemGap = 0,
  renderItem
}) {
  const { activeIndex, setActiveIndex, selectIndex } = useSelectionList({
    items,
    initialIndex,
    onSelect,
    onHighlight,
    isFocused,
    showNumbers
  });
  const [scrollOffset, setScrollOffset] = (0, import_react19.useState)(
    () => getScrollOffsetForIndex(activeIndex, items.length, maxItemsToShow)
  );
  (0, import_react19.useEffect)(() => {
    const newScrollOffset = getScrollOffsetForIndex(
      activeIndex,
      items.length,
      maxItemsToShow
    );
    if (activeIndex < scrollOffset) {
      setScrollOffset(activeIndex);
    } else if (activeIndex >= scrollOffset + maxItemsToShow) {
      setScrollOffset(newScrollOffset);
    }
  }, [activeIndex, items.length, scrollOffset, maxItemsToShow]);
  const settings = (0, import_react19.useContext)(SettingsContext);
  const mouseTrackingEnabled = useMouseTrackingEnabled();
  const mouseEnabled = useVirtualViewport(settings?.merged.ui?.useTerminalBuffer) && mouseTrackingEnabled;
  const containerRef = (0, import_react19.useRef)(null);
  const itemRefs = (0, import_react19.useRef)([]);
  const visibleItems = items.slice(scrollOffset, scrollOffset + maxItemsToShow);
  const numberColumnWidth = String(items.length).length;
  return /* @__PURE__ */ (0, import_jsx_runtime14.jsxs)(Box_default, { ref: containerRef, flexDirection: "column", gap: itemGap, children: [
    mouseEnabled && isFocused && items.length > 0 && /* @__PURE__ */ (0, import_jsx_runtime14.jsx)(
      RowMouseController,
      {
        containerRef,
        itemRefs,
        scrollOffset,
        isDisabled: (index) => !!items[index]?.disabled,
        onHoverIndex: setActiveIndex,
        onSelectIndex: selectIndex
      }
    ),
    showScrollArrows && /* @__PURE__ */ (0, import_jsx_runtime14.jsx)(
      Text,
      {
        color: scrollOffset > 0 ? theme.text.primary : theme.text.secondary,
        children: "\u25B2"
      }
    ),
    visibleItems.map((item, index) => {
      const itemIndex = scrollOffset + index;
      const isSelected = activeIndex === itemIndex;
      let titleColor = theme.text.primary;
      let numberColor = theme.text.primary;
      if (isSelected) {
        titleColor = theme.status.success;
        numberColor = theme.status.success;
      } else if (item.disabled) {
        titleColor = theme.text.secondary;
        numberColor = theme.text.secondary;
      }
      if (!isFocused && !item.disabled) {
        numberColor = theme.text.secondary;
      }
      if (!showNumbers) {
        numberColor = theme.text.secondary;
      }
      const itemNumberText = `${String(itemIndex + 1).padStart(
        numberColumnWidth
      )}.`;
      return /* @__PURE__ */ (0, import_jsx_runtime14.jsxs)(
        Box_default,
        {
          alignItems: "flex-start",
          ref: (node) => {
            itemRefs.current[index] = node;
          },
          children: [
            /* @__PURE__ */ (0, import_jsx_runtime14.jsx)(Box_default, { minWidth: 2, flexShrink: 0, children: /* @__PURE__ */ (0, import_jsx_runtime14.jsx)(
              Text,
              {
                color: isSelected ? theme.status.success : theme.text.primary,
                "aria-hidden": true,
                children: isSelected ? "\u203A" : " "
              }
            ) }),
            showNumbers && /* @__PURE__ */ (0, import_jsx_runtime14.jsx)(
              Box_default,
              {
                marginRight: 1,
                flexShrink: 0,
                minWidth: itemNumberText.length,
                "aria-state": { checked: isSelected },
                children: /* @__PURE__ */ (0, import_jsx_runtime14.jsx)(Text, { color: numberColor, children: itemNumberText })
              }
            ),
            /* @__PURE__ */ (0, import_jsx_runtime14.jsx)(Box_default, { flexGrow: 1, children: renderItem(item, {
              isSelected,
              titleColor,
              numberColor
            }) })
          ]
        },
        item.key
      );
    }),
    showScrollArrows && /* @__PURE__ */ (0, import_jsx_runtime14.jsx)(
      Text,
      {
        color: scrollOffset + maxItemsToShow < items.length ? theme.text.primary : theme.text.secondary,
        children: "\u25BC"
      }
    )
  ] });
}
__name(BaseSelectionList, "BaseSelectionList");

// packages/cli/src/ui/components/shared/RadioButtonSelect.tsx
var import_jsx_runtime15 = __toESM(require_jsx_runtime(), 1);
function RadioButtonSelect({
  items,
  initialIndex = 0,
  onSelect,
  onHighlight,
  isFocused = true,
  showScrollArrows = false,
  maxItemsToShow = 10,
  showNumbers = true
}) {
  return /* @__PURE__ */ (0, import_jsx_runtime15.jsx)(
    BaseSelectionList,
    {
      items,
      initialIndex,
      onSelect,
      onHighlight,
      isFocused,
      showNumbers,
      showScrollArrows,
      maxItemsToShow,
      renderItem: (item, { titleColor }) => {
        if (item.themeNameDisplay && item.themeTypeDisplay) {
          return /* @__PURE__ */ (0, import_jsx_runtime15.jsxs)(Text, { color: titleColor, wrap: "truncate", children: [
            item.themeNameDisplay,
            " ",
            /* @__PURE__ */ (0, import_jsx_runtime15.jsx)(Text, { color: theme.text.secondary, children: item.themeTypeDisplay })
          ] }, item.key);
        }
        return /* @__PURE__ */ (0, import_jsx_runtime15.jsx)(Text, { color: titleColor, wrap: "truncate", children: item.label });
      }
    }
  );
}
__name(RadioButtonSelect, "RadioButtonSelect");

// packages/cli/src/ui/hooks/useLaunchEditor.ts
init_esbuild_shims();
var import_react20 = __toESM(require_react(), 1);
import { spawnSync as spawnSync2 } from "child_process";
function getEditorCommand(preferredEditor) {
  if (preferredEditor) {
    const execCmd = getEditorExecutable(preferredEditor);
    if (!execCmd) {
      throw new Error(
        `No available editor found for ${preferredEditor}. Please install a supported editor or set a different preferredEditor in settings.`
      );
    }
    return execCmd;
  }
  switch (process.platform) {
    case "darwin":
      return "open -t";
    // TextEdit in plain text mode
    case "win32":
      return "notepad";
    default:
      return process.env["VISUAL"] || process.env["EDITOR"] || "vi";
  }
}
__name(getEditorCommand, "getEditorCommand");
function useLaunchEditor() {
  const settings = useSettings();
  const { stdin, setRawMode } = use_stdin_default();
  const launchEditor = (0, import_react20.useCallback)(
    async (filePath) => {
      const preferredEditor = settings.merged.general?.preferredEditor;
      const editor = getEditorCommand(preferredEditor);
      let editorCommand;
      let editorArgs;
      if (editor === "open -t") {
        editorCommand = "open";
        editorArgs = ["-t", filePath];
      } else {
        editorCommand = editor;
        editorArgs = [filePath];
      }
      const wasRaw = stdin?.isRaw ?? false;
      try {
        setRawMode?.(false);
        const needsShell = process.platform === "win32" && (editorCommand.endsWith(".cmd") || editorCommand.endsWith(".bat"));
        const { status, error } = spawnSync2(editorCommand, editorArgs, {
          stdio: "inherit",
          shell: needsShell
        });
        if (error) throw error;
        if (typeof status === "number" && status !== 0) {
          throw new Error(`Editor exited with status ${status}`);
        }
      } finally {
        if (wasRaw) setRawMode?.(true);
      }
    },
    [settings.merged.general?.preferredEditor, setRawMode, stdin]
  );
  return launchEditor;
}
__name(useLaunchEditor, "useLaunchEditor");

// packages/cli/src/ui/components/messages/AskUserQuestionDialog.tsx
init_esbuild_shims();
var import_react22 = __toESM(require_react(), 1);

// packages/cli/src/ui/components/shared/TextInput.tsx
init_esbuild_shims();
var import_react21 = __toESM(require_react(), 1);

// packages/cli/src/ui/utils/software-cursor.ts
init_esbuild_shims();
var import_chalk = __toESM(require_source(), 1);

// packages/cli/src/ui/utils/theme-background.ts
init_esbuild_shims();
var DARK_TERMINAL_BACKGROUND = "#000000";
var LIGHT_TERMINAL_BACKGROUND = "#ffffff";
function getEffectiveTerminalBackground() {
  return themeManager.getTerminalBackgroundType() === "light" ? LIGHT_TERMINAL_BACKGROUND : DARK_TERMINAL_BACKGROUND;
}
__name(getEffectiveTerminalBackground, "getEffectiveTerminalBackground");

// packages/cli/src/ui/utils/software-cursor.ts
var LIGHT_CURSOR_BACKGROUND = "#D4D4D4";
var DARK_CURSOR_BACKGROUND = "#3A3A3A";
var INK_NAME_TO_HEX = {
  black: "#000000",
  red: "#ff0000",
  green: "#00ff00",
  yellow: "#ffff00",
  blue: "#0000ff",
  cyan: "#00ffff",
  magenta: "#ff00ff",
  white: "#ffffff",
  gray: "#808080",
  grey: "#808080",
  blackbright: "#808080",
  redbright: "#ff8080",
  greenbright: "#80ff80",
  yellowbright: "#ffff80",
  bluebright: "#8080ff",
  cyanbright: "#80ffff",
  magentabright: "#ff80ff",
  whitebright: "#ffffff"
};
function toHex(color) {
  const resolved = resolveColor(color) ?? color;
  const lower = resolved.toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(lower)) {
    return `#${lower.slice(1).split("").map((c) => c + c).join("")}`;
  }
  if (/^#[0-9a-f]{6}$/.test(lower)) {
    return lower;
  }
  return INK_NAME_TO_HEX[lower];
}
__name(toHex, "toHex");
function getSoftwareCursorBackground(backgroundColor = getEffectiveTerminalBackground()) {
  const hex = backgroundColor ? toHex(backgroundColor) : void 0;
  if (!hex) {
    return LIGHT_CURSOR_BACKGROUND;
  }
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const luminance = (r * 299 + g * 587 + b * 114) / 1e3;
  return luminance >= 128 ? DARK_CURSOR_BACKGROUND : LIGHT_CURSOR_BACKGROUND;
}
__name(getSoftwareCursorBackground, "getSoftwareCursorBackground");
function compositionOverlaysSoftwareCursor(env = process.env, platform = process.platform) {
  if (platform === "win32") {
    return true;
  }
  if (!env["TMUX"]) {
    return false;
  }
  return !(env["QWEN_CODE_SYNCHRONIZED_OUTPUT"] === "1" || env["QWEN_CODE_FORCE_SYNCHRONIZED_OUTPUT"] === "1");
}
__name(compositionOverlaysSoftwareCursor, "compositionOverlaysSoftwareCursor");
function renderSoftwareCursor(text) {
  const cursorText = text || " ";
  return compositionOverlaysSoftwareCursor() ? import_chalk.default.underline(cursorText) : import_chalk.default.bgHex(getSoftwareCursorBackground())(cursorText);
}
__name(renderSoftwareCursor, "renderSoftwareCursor");

// packages/cli/src/ui/components/shared/TextInput.tsx
var import_jsx_runtime16 = __toESM(require_jsx_runtime(), 1);
function ellipsizeMiddle(text, width) {
  if (width <= 0) return "";
  if (stringWidth(text) <= width) return text;
  if (width <= 3) return cpSlice(text, 0, width);
  const available = width - 3;
  const headLength = Math.ceil(available / 2);
  const tailLength = Math.floor(available / 2);
  return `${cpSlice(text, 0, headLength)}...${cpSlice(
    text,
    cpLen(text) - tailLength
  )}`;
}
__name(ellipsizeMiddle, "ellipsizeMiddle");
function TextInput({
  value,
  onChange,
  onSubmit,
  onTab,
  onUp,
  onDown,
  placeholder,
  height = 1,
  isActive = true,
  validationErrors = [],
  inputWidth = 80,
  initialCursorOffset,
  ellipsizeOverflow = false
}) {
  const allowMultiline = height > 1;
  const [cursorVisible, setCursorVisible] = (0, import_react21.useState)(isActive);
  const onChangeRef = (0, import_react21.useRef)(onChange);
  (0, import_react21.useEffect)(() => {
    onChangeRef.current = onChange;
  }, [onChange]);
  const stableOnChange = (0, import_react21.useCallback)((text) => {
    onChangeRef.current?.(text);
  }, []);
  const preferredEditor = usePreferredEditor();
  const { stdin, setRawMode } = use_stdin_default();
  const buffer = useTextBuffer({
    initialText: value || "",
    initialCursorOffset,
    viewport: { height, width: inputWidth },
    stdin,
    setRawMode,
    isValidPath: /* @__PURE__ */ __name(() => false, "isValidPath"),
    onChange: stableOnChange,
    preferredEditor
  });
  (0, import_react21.useEffect)(() => {
    if (!isActive) {
      setCursorVisible(false);
      return;
    }
    setCursorVisible(true);
    const interval = setInterval(() => {
      setCursorVisible((visible) => !visible);
    }, 530);
    return () => clearInterval(interval);
  }, [isActive]);
  const handleSubmit = /* @__PURE__ */ __name(() => {
    if (!onSubmit) return;
    onSubmit(buffer.text);
  }, "handleSubmit");
  useKeypress(
    (key) => {
      if (!buffer || !isActive) return;
      if (key.name === "tab" && !key.paste) {
        onTab?.(key);
        return;
      }
      if (key.name === "up" && onUp) {
        onUp();
        return;
      }
      if (key.name === "down" && onDown) {
        onDown();
        return;
      }
      if (allowMultiline && keyMatchers["newline" /* NEWLINE */](key)) {
        buffer.newline();
        return;
      }
      if (keyMatchers["submit" /* SUBMIT */](key) || !allowMultiline && key.name === "return") {
        handleSubmit();
        return;
      }
      if (keyMatchers["home" /* HOME */](key)) {
        buffer.move("home");
        return;
      }
      if (keyMatchers["end" /* END */](key)) {
        buffer.move("end");
        buffer.moveToOffset(cpLen(buffer.text));
        return;
      }
      if (keyMatchers["clearInput" /* CLEAR_INPUT */](key)) {
        if (buffer.text.length > 0) buffer.setText("");
        return;
      }
      if (keyMatchers["killLineRight" /* KILL_LINE_RIGHT */](key)) {
        buffer.killLineRight();
        return;
      }
      if (keyMatchers["killLineLeft" /* KILL_LINE_LEFT */](key)) {
        buffer.killLineLeft();
        return;
      }
      if (keyMatchers["openExternalEditor" /* OPEN_EXTERNAL_EDITOR */](key)) {
        buffer.openInExternalEditor();
        return;
      }
      buffer.handleInput(key);
    },
    { isActive }
  );
  if (!buffer) return null;
  const linesToRender = buffer.viewportVisualLines;
  const [cursorVisualRowAbsolute, cursorVisualColAbsolute] = buffer.visualCursor;
  const scrollVisualRow = buffer.visualScrollRow;
  const shouldRenderCursor = isActive && cursorVisible;
  return /* @__PURE__ */ (0, import_jsx_runtime16.jsxs)(Box_default, { flexDirection: "column", gap: 1, children: [
    /* @__PURE__ */ (0, import_jsx_runtime16.jsxs)(Box_default, { children: [
      /* @__PURE__ */ (0, import_jsx_runtime16.jsx)(Text, { color: theme.text.accent, children: "> " }),
      /* @__PURE__ */ (0, import_jsx_runtime16.jsx)(Box_default, { flexGrow: 1, flexDirection: "column", children: buffer.text.length === 0 && placeholder ? shouldRenderCursor ? /* @__PURE__ */ (0, import_jsx_runtime16.jsxs)(Text, { children: [
        renderSoftwareCursor(placeholder.slice(0, 1)),
        /* @__PURE__ */ (0, import_jsx_runtime16.jsx)(Text, { color: Colors.Gray, children: placeholder.slice(1) })
      ] }) : /* @__PURE__ */ (0, import_jsx_runtime16.jsx)(Text, { color: Colors.Gray, children: placeholder }) : ellipsizeOverflow && stringWidth(buffer.text) > inputWidth ? /* @__PURE__ */ (0, import_jsx_runtime16.jsx)(Text, { children: ellipsizeMiddle(buffer.text, inputWidth) }) : linesToRender.map((lineText, visualIdxInRenderedSet) => {
        const cursorVisualRow = cursorVisualRowAbsolute - scrollVisualRow;
        let display = cpSlice(lineText, 0, inputWidth);
        const currentVisualWidth = stringWidth(display);
        if (currentVisualWidth < inputWidth) {
          display = display + " ".repeat(inputWidth - currentVisualWidth);
        }
        if (shouldRenderCursor && visualIdxInRenderedSet === cursorVisualRow) {
          const relativeVisualColForHighlight = cursorVisualColAbsolute;
          if (relativeVisualColForHighlight >= 0) {
            if (relativeVisualColForHighlight < cpLen(display)) {
              const charToHighlight = cpSlice(
                display,
                relativeVisualColForHighlight,
                relativeVisualColForHighlight + 1
              ) || " ";
              const highlighted = renderSoftwareCursor(charToHighlight);
              display = cpSlice(display, 0, relativeVisualColForHighlight) + highlighted + cpSlice(display, relativeVisualColForHighlight + 1);
            } else if (relativeVisualColForHighlight === cpLen(display) && cpLen(display) === inputWidth) {
              display = display + renderSoftwareCursor(" ");
            }
          }
        }
        return /* @__PURE__ */ (0, import_jsx_runtime16.jsx)(Text, { children: display }, `line-${visualIdxInRenderedSet}`);
      }) })
    ] }),
    validationErrors.length > 0 && /* @__PURE__ */ (0, import_jsx_runtime16.jsx)(Box_default, { flexDirection: "column", children: validationErrors.map((error, index) => /* @__PURE__ */ (0, import_jsx_runtime16.jsxs)(Text, { color: theme.status.error, children: [
      "\u26A0 ",
      error
    ] }, index)) })
  ] });
}
__name(TextInput, "TextInput");

// packages/cli/src/ui/components/messages/AskUserQuestionDialog.tsx
var import_jsx_runtime17 = __toESM(require_jsx_runtime(), 1);
function computeHeaderCap(headerWidths, available) {
  const ascending = [...headerWidths].sort((a, b) => a - b);
  let remaining = available;
  for (let i = 0; i < ascending.length; i++) {
    const cap = Math.floor(remaining / (ascending.length - i));
    if (ascending[i] > cap) {
      return Math.max(0, cap);
    }
    remaining -= ascending[i];
  }
  return Number.MAX_SAFE_INTEGER;
}
__name(computeHeaderCap, "computeHeaderCap");
var AskUserQuestionDialog = /* @__PURE__ */ __name(({
  confirmationDetails,
  isFocused = true,
  availableWidth,
  onConfirm
}) => {
  const [currentQuestionIndex, setCurrentQuestionIndex] = (0, import_react22.useState)(0);
  const [selectedOptions, setSelectedOptions] = (0, import_react22.useState)({});
  const [customInputValues, setCustomInputValues] = (0, import_react22.useState)({});
  const customInputValuesRef = (0, import_react22.useRef)({});
  const [selectedIndex, setSelectedIndex] = (0, import_react22.useState)(0);
  const [multiSelectedOptions, setMultiSelectedOptions] = (0, import_react22.useState)({});
  const [customInputChecked, setCustomInputChecked] = (0, import_react22.useState)({});
  const hasMultipleQuestions = confirmationDetails.questions.length > 1;
  const totalTabs = hasMultipleQuestions ? confirmationDetails.questions.length + 1 : confirmationDetails.questions.length;
  const isSubmitTab = hasMultipleQuestions && currentQuestionIndex === totalTabs - 1;
  const currentQuestion = isSubmitTab ? null : confirmationDetails.questions[currentQuestionIndex];
  const isMultiSelect = currentQuestion?.multiSelect ?? false;
  const totalOptions = currentQuestion ? currentQuestion.options.length + 1 : 2;
  const isCustomInputSelected = !isSubmitTab && currentQuestion && selectedIndex === currentQuestion.options.length;
  const getCustomInputValue = /* @__PURE__ */ __name((idx) => customInputValuesRef.current[idx] ?? customInputValues[idx] ?? "", "getCustomInputValue");
  const currentCustomInputValue = getCustomInputValue(currentQuestionIndex);
  const isCustomInputAnswer = !isSubmitTab && currentQuestion && !isMultiSelect && selectedOptions[currentQuestionIndex] !== void 0 && !currentQuestion.options.some(
    (opt) => opt.label === selectedOptions[currentQuestionIndex]
  );
  const getAnswerForQuestion = /* @__PURE__ */ __name((idx) => {
    const q = confirmationDetails.questions[idx];
    if (q?.multiSelect) {
      const selections = [...multiSelectedOptions[idx] ?? []];
      const customValue = getCustomInputValue(idx).trim();
      if (customInputChecked[idx] && customValue) {
        selections.push(customValue);
      }
      return selections.length > 0 ? selections.join(", ") : void 0;
    }
    return selectedOptions[idx];
  }, "getAnswerForQuestion");
  const numHeaders = confirmationDetails.questions.length;
  const answeredHeaders = confirmationDetails.questions.filter(
    (_, idx) => getAnswerForQuestion(idx) !== void 0
  ).length;
  const dialogPadding = 2;
  const submitChipWidth = (isSubmitTab ? 2 : 1) + getCachedStringWidth(t("Submit"));
  const chipGaps = numHeaders;
  const headerPrefixes = 2 * numHeaders;
  const answeredMarks = 2 * answeredHeaders;
  const rowOverhead = dialogPadding + submitChipWidth + chipGaps + headerPrefixes + answeredMarks;
  const headerCap = computeHeaderCap(
    confirmationDetails.questions.map((q) => getCachedStringWidth(q.header)),
    availableWidth - rowOverhead
  );
  const handleSubmit = /* @__PURE__ */ __name(async () => {
    const answers = {};
    confirmationDetails.questions.forEach((_, idx) => {
      const answer = getAnswerForQuestion(idx);
      if (answer !== void 0) {
        answers[idx] = answer;
      }
    });
    await onConfirm("proceed_once" /* ProceedOnce */, { answers });
  }, "handleSubmit");
  const selectAndAdvance = /* @__PURE__ */ __name((value) => {
    setSelectedOptions((prev) => ({ ...prev, [currentQuestionIndex]: value }));
    if (!hasMultipleQuestions) {
      void onConfirm("proceed_once" /* ProceedOnce */, {
        answers: { [currentQuestionIndex]: value }
      });
    } else if (currentQuestionIndex < totalTabs - 1) {
      setTimeout(() => {
        setCurrentQuestionIndex((prev) => Math.min(prev + 1, totalTabs - 1));
        setSelectedIndex(0);
      }, 150);
    }
  }, "selectAndAdvance");
  const getCurrentMultiSelectAnswer = /* @__PURE__ */ __name((includeCustomInput = customInputChecked[currentQuestionIndex], inputValue = currentCustomInputValue) => {
    if (!currentQuestion) return;
    const selections = [...multiSelectedOptions[currentQuestionIndex] ?? []];
    const customValue = inputValue.trim();
    if (includeCustomInput && customValue) {
      selections.push(customValue);
    }
    return selections.length > 0 ? selections.join(", ") : void 0;
  }, "getCurrentMultiSelectAnswer");
  const handleMultiSelectSubmit = /* @__PURE__ */ __name(() => {
    const answer = getCurrentMultiSelectAnswer();
    if (!answer) return;
    selectAndAdvance(answer);
  }, "handleMultiSelectSubmit");
  const handleCustomInputSubmit = /* @__PURE__ */ __name((inputValue = currentCustomInputValue) => {
    const trimmedValue = inputValue.trim();
    if (isMultiSelect) {
      setCustomInputChecked((prev) => ({
        ...prev,
        [currentQuestionIndex]: trimmedValue.length > 0
      }));
      if (trimmedValue) {
        selectAndAdvance(getCurrentMultiSelectAnswer(true, inputValue));
      }
      return;
    }
    if (!trimmedValue) return;
    selectAndAdvance(trimmedValue);
  }, "handleCustomInputSubmit");
  useKeypress(
    (key) => {
      if (isCustomInputSelected) {
        const isOptionUp = key.name === "up" || key.ctrl && key.name === "p";
        const isOptionDown = key.name === "down" || key.ctrl && key.name === "n";
        if (isOptionUp) {
          setSelectedIndex(Math.max(0, selectedIndex - 1));
          return;
        }
        if (isOptionDown) {
          setSelectedIndex(Math.min(totalOptions - 1, selectedIndex + 1));
          return;
        }
        if (key.name === "escape" || key.ctrl && key.name === "c") {
          void onConfirm("cancel" /* Cancel */);
          return;
        }
        if (key.name === "return") {
          handleCustomInputSubmit();
          return;
        }
        return;
      }
      const input = key.sequence;
      if (key.name === "left" && hasMultipleQuestions) {
        if (currentQuestionIndex > 0) {
          setCurrentQuestionIndex(currentQuestionIndex - 1);
          setSelectedIndex(0);
        }
        return;
      }
      if (key.name === "right" && hasMultipleQuestions) {
        if (currentQuestionIndex < totalTabs - 1) {
          setCurrentQuestionIndex(currentQuestionIndex + 1);
          setSelectedIndex(0);
        }
        return;
      }
      if (keyMatchers["selectionUp" /* SELECTION_UP */](key)) {
        setSelectedIndex(Math.max(0, selectedIndex - 1));
        return;
      }
      if (keyMatchers["selectionDown" /* SELECTION_DOWN */](key)) {
        setSelectedIndex(Math.min(totalOptions - 1, selectedIndex + 1));
        return;
      }
      const numKey = input && /^[1-9]\d*$/.test(input) ? Number(input) : NaN;
      if (Number.isSafeInteger(numKey) && numKey <= totalOptions) {
        const targetIndex = numKey - 1;
        setSelectedIndex(targetIndex);
        if (!isMultiSelect && !isSubmitTab && currentQuestion && targetIndex < currentQuestion.options.length) {
          const option = currentQuestion.options[targetIndex];
          if (option) {
            selectAndAdvance(option.label);
          }
        }
        return;
      }
      if (key.name === "space" && isMultiSelect && currentQuestion) {
        if (selectedIndex < currentQuestion.options.length) {
          const option = currentQuestion.options[selectedIndex];
          if (option) {
            const current = multiSelectedOptions[currentQuestionIndex] ?? [];
            const isChecked = current.includes(option.label);
            const updated = isChecked ? current.filter((l) => l !== option.label) : [...current, option.label];
            setMultiSelectedOptions((prev) => ({
              ...prev,
              [currentQuestionIndex]: updated
            }));
          }
        }
        return;
      }
      if (key.name === "return") {
        if (isSubmitTab) {
          if (selectedIndex === 0) {
            void handleSubmit();
          } else {
            void onConfirm("cancel" /* Cancel */);
          }
          return;
        }
        if (isMultiSelect && currentQuestion) {
          if (selectedIndex === currentQuestion.options.length) {
            return;
          }
          handleMultiSelectSubmit();
          return;
        }
        if (currentQuestion && selectedIndex < currentQuestion.options.length) {
          const option = currentQuestion.options[selectedIndex];
          if (option) {
            selectAndAdvance(option.label);
          }
        }
        return;
      }
      if (key.name === "escape" || key.ctrl && key.name === "c") {
        void onConfirm("cancel" /* Cancel */);
        return;
      }
    },
    { isActive: isFocused }
  );
  if (isSubmitTab) {
    return /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)(Box_default, { flexDirection: "column", padding: 1, children: [
      /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)(Box_default, { marginBottom: 1, flexDirection: "row", gap: 1, children: [
        confirmationDetails.questions.map((q, idx) => {
          const isAnswered = getAnswerForQuestion(idx) !== void 0;
          return /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(Box_default, { children: /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)(Text, { dimColor: true, children: [
            "  ",
            truncateToWidth(q.header, headerCap),
            isAnswered ? " \u2713" : ""
          ] }) }, idx);
        }),
        /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(Box_default, { children: /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)(Text, { color: theme.text.accent, bold: true, children: [
          "\u25B8 ",
          t("Submit")
        ] }) })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)(Box_default, { flexDirection: "column", marginBottom: 1, children: [
        /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(Text, { bold: true, children: t("Your answers:") }),
        confirmationDetails.questions.map((q, idx) => {
          const answer = getAnswerForQuestion(idx);
          return /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(Box_default, { marginLeft: 2, children: /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)(Text, { children: [
            q.header,
            ":",
            " ",
            answer ? /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(Text, { color: theme.text.accent, children: answer }) : /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(Text, { dimColor: true, children: t("(not answered)") })
          ] }) }, idx);
        })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(Box_default, { marginTop: 1, marginBottom: 1, children: /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(Text, { children: t("Ready to submit your answers?") }) }),
      /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)(Box_default, { flexDirection: "column", children: [
        /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(Box_default, { children: /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)(
          Text,
          {
            color: selectedIndex === 0 ? theme.text.accent : theme.text.primary,
            bold: selectedIndex === 0,
            children: [
              selectedIndex === 0 ? "\u276F " : "  ",
              "1. ",
              t("Submit answers")
            ]
          }
        ) }),
        /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(Box_default, { children: /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)(
          Text,
          {
            color: selectedIndex === 1 ? theme.text.accent : theme.text.primary,
            bold: selectedIndex === 1,
            children: [
              selectedIndex === 1 ? "\u276F " : "  ",
              "2. ",
              t("Cancel")
            ]
          }
        ) })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(Box_default, { marginTop: 1, children: /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(Text, { dimColor: true, children: t("\u2191/\u2193: Navigate | \u2190/\u2192: Switch tabs | Enter: Select") }) })
    ] });
  }
  return /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)(Box_default, { flexDirection: "column", padding: 1, children: [
    hasMultipleQuestions && /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)(Box_default, { marginBottom: 1, flexDirection: "row", gap: 1, children: [
      confirmationDetails.questions.map((q, idx) => {
        const isAnswered = getAnswerForQuestion(idx) !== void 0;
        return /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(Box_default, { children: /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)(
          Text,
          {
            color: idx === currentQuestionIndex ? theme.text.accent : theme.text.primary,
            bold: idx === currentQuestionIndex,
            dimColor: idx !== currentQuestionIndex,
            children: [
              idx === currentQuestionIndex ? "\u25B8 " : "  ",
              truncateToWidth(q.header, headerCap),
              isAnswered ? " \u2713" : ""
            ]
          }
        ) }, idx);
      }),
      /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(Box_default, { children: /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)(Text, { dimColor: true, children: [
        " ",
        t("Submit")
      ] }) })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)(Box_default, { flexDirection: "column", marginBottom: 1, children: [
      !hasMultipleQuestions && /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(Box_default, { marginBottom: 1, children: /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(Text, { color: theme.text.accent, bold: true, children: currentQuestion.header }) }),
      /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(Text, { children: currentQuestion.question })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)(Box_default, { flexDirection: "column", marginBottom: 1, children: [
      currentQuestion.options.map((opt, index) => {
        const isSelected = selectedIndex === index;
        const isMultiChecked = isMultiSelect && (multiSelectedOptions[currentQuestionIndex] ?? []).includes(
          opt.label
        );
        const isAnswered = !isMultiSelect && selectedOptions[currentQuestionIndex] === opt.label;
        const isHighlighted = isSelected || isAnswered || isMultiChecked;
        const prefixWidth = 2 + (isMultiSelect ? 4 : 0) + String(index + 1).length + 2;
        return /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)(Box_default, { flexDirection: "column", children: [
          /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(Box_default, { children: /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)(
            Text,
            {
              color: isHighlighted ? theme.text.accent : theme.text.primary,
              bold: isHighlighted,
              children: [
                isSelected ? "\u276F " : "  ",
                isMultiSelect ? isMultiChecked ? "[\u2713] " : "[ ] " : "",
                index + 1,
                ". ",
                opt.label,
                isAnswered ? " \u2713" : ""
              ]
            }
          ) }),
          opt.description && /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(Box_default, { marginLeft: prefixWidth, children: /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(Text, { dimColor: true, children: opt.description }) })
        ] }, index);
      }),
      /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(Box_default, { flexDirection: "column", children: isCustomInputSelected ? (
        // Inline TextInput replaces the option text
        /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)(Box_default, { children: [
          /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)(Text, { color: theme.text.accent, bold: true, children: [
            "\u276F",
            " ",
            isMultiSelect ? customInputChecked[currentQuestionIndex] ? "[\u2713] " : "[ ] " : "",
            currentQuestion.options.length + 1,
            ".",
            " "
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(
            TextInput,
            {
              value: currentCustomInputValue,
              initialCursorOffset: currentCustomInputValue.length,
              onChange: (value) => {
                const oldValue = customInputValuesRef.current[currentQuestionIndex] ?? customInputValues[currentQuestionIndex] ?? "";
                customInputValuesRef.current = {
                  ...customInputValuesRef.current,
                  [currentQuestionIndex]: value
                };
                if (isMultiSelect && value !== oldValue) {
                  setCustomInputChecked((prevChecked) => ({
                    ...prevChecked,
                    [currentQuestionIndex]: value.trim().length > 0
                  }));
                }
                setCustomInputValues((prev) => ({
                  ...prev,
                  [currentQuestionIndex]: value
                }));
              },
              onSubmit: handleCustomInputSubmit,
              placeholder: t("Type something..."),
              isActive: true,
              inputWidth: 50
            }
          )
        ] })
      ) : (
        // Show typed value or placeholder when not selected
        /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(Box_default, { children: /* @__PURE__ */ (0, import_jsx_runtime17.jsxs)(
          Text,
          {
            color: isCustomInputAnswer || customInputChecked[currentQuestionIndex] ? theme.text.accent : theme.text.primary,
            bold: !!(isCustomInputAnswer || customInputChecked[currentQuestionIndex]),
            dimColor: !currentCustomInputValue && !isCustomInputAnswer && !customInputChecked[currentQuestionIndex],
            children: [
              "  ",
              isMultiSelect ? customInputChecked[currentQuestionIndex] ? "[\u2713] " : "[ ] " : "",
              currentQuestion.options.length + 1,
              ".",
              " ",
              currentCustomInputValue || t("Type something..."),
              isCustomInputAnswer ? " \u2713" : ""
            ]
          }
        ) })
      ) })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(Box_default, { flexDirection: "column", marginTop: 1, children: /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(Box_default, { children: /* @__PURE__ */ (0, import_jsx_runtime17.jsx)(Text, { dimColor: true, children: hasMultipleQuestions ? isMultiSelect ? t(
      "\u2191/\u2193: Navigate | \u2190/\u2192: Switch tabs | Space: Toggle | Enter: Confirm | Esc: Cancel"
    ) : t(
      "\u2191/\u2193: Navigate | \u2190/\u2192: Switch tabs | Enter: Select | Esc: Cancel"
    ) : isMultiSelect ? t(
      "\u2191/\u2193: Navigate | Space: Toggle | Enter: Confirm | Esc: Cancel"
    ) : t("\u2191/\u2193: Navigate | Enter: Select | Esc: Cancel") }) }) })
  ] });
}, "AskUserQuestionDialog");

// packages/cli/src/ui/components/messages/ToolConfirmationMessage.tsx
var import_jsx_runtime18 = __toESM(require_jsx_runtime(), 1);
var COMPACT_BODY_MAX_LINES = 5;
var ToolConfirmationMessage = /* @__PURE__ */ __name(({
  confirmationDetails,
  config,
  isFocused = true,
  availableTerminalHeight,
  contentWidth,
  compactMode = false
}) => {
  const { onConfirm } = confirmationDetails;
  const autoModeFallback = confirmationDetails.autoModeFallback;
  const offersSwitchToDefault = autoModeFallback?.reason === "classifier_unavailable" || autoModeFallback?.reason === "consecutive_unavailable";
  const hidesAlwaysAllow = "hideAlwaysAllow" in confirmationDetails && confirmationDetails.hideAlwaysAllow === true;
  const settings = useSettings();
  const preferredEditor = settings.merged.general?.preferredEditor;
  const [ideClient, setIdeClient] = (0, import_react23.useState)(null);
  const [isDiffingEnabled, setIsDiffingEnabled] = (0, import_react23.useState)(false);
  (0, import_react23.useEffect)(() => {
    let isMounted = true;
    if (config.getIdeMode()) {
      const getIdeClient = /* @__PURE__ */ __name(async () => {
        const client = await IdeClient.getInstance();
        if (isMounted) {
          setIdeClient(client);
          setIsDiffingEnabled(client?.isDiffingEnabled() ?? false);
        }
      }, "getIdeClient");
      getIdeClient();
    }
    return () => {
      isMounted = false;
    };
  }, [config]);
  const handleConfirm = /* @__PURE__ */ __name(async (outcome) => {
    onConfirm(outcome);
    if (confirmationDetails.type === "edit" && !confirmationDetails.skipIdeDiff) {
      if (config.getIdeMode() && isDiffingEnabled) {
        const cliOutcome = outcome === "cancel" /* Cancel */ ? "rejected" : "accepted";
        await ideClient?.resolveDiffFromCli(
          confirmationDetails.filePath,
          cliOutcome
        );
      }
    }
  }, "handleConfirm");
  const isTrustedFolder = config.isTrustedFolder();
  const launchEditor = useLaunchEditor();
  const [planViewError, setPlanViewError] = (0, import_react23.useState)(null);
  const openFullPlanInEditor = /* @__PURE__ */ __name(() => {
    if (confirmationDetails.type !== "plan") return;
    setPlanViewError(null);
    const openPlan = /* @__PURE__ */ __name(async () => {
      const dir = await fs2.mkdtemp(path.join(os2.tmpdir(), "qwen-plan-"));
      const planPath = path.join(dir, "plan.md");
      await fs2.writeFile(planPath, confirmationDetails.plan);
      await launchEditor(planPath);
    }, "openPlan");
    void openPlan().catch((err) => {
      setPlanViewError(err instanceof Error ? err.message : String(err));
    });
  }, "openFullPlanInEditor");
  useKeypress(
    (key) => {
      if (!isFocused) return;
      if (key.name === "escape" || key.ctrl && key.name === "c") {
        handleConfirm("cancel" /* Cancel */);
        return;
      }
      if (key.name === "o" && !key.ctrl && !key.meta && confirmationDetails.type === "plan") {
        openFullPlanInEditor();
      }
    },
    { isActive: isFocused }
  );
  const handleSelect = /* @__PURE__ */ __name((item) => handleConfirm(item), "handleSelect");
  let bodyContent = null;
  let question;
  const options = new Array();
  function availableBodyContentHeight() {
    if (options.length === 0) {
      throw new Error("Options not provided for confirmation message");
    }
    if (availableTerminalHeight === void 0) {
      return void 0;
    }
    const PADDING_OUTER_Y = compactMode ? 0 : 2;
    const MARGIN_BODY_BOTTOM = compactMode ? 0 : 1;
    const HEIGHT_QUESTION = 1;
    const MARGIN_QUESTION_BOTTOM = compactMode ? 0 : 1;
    const HEIGHT_OPTIONS = compactMode ? 2 + (offersSwitchToDefault ? 1 : 0) + (hidesAlwaysAllow ? 0 : 1) : options.length + (offersSwitchToDefault ? 1 : 0);
    const AUTO_MODE_FALLBACK_HEIGHT = autoModeFallback ? wrapAnsi(`\u26A0 ${autoModeFallback.message}`, warningContentWidth, {
      trim: false,
      hard: true
    }).split("\n").length + 1 : 0;
    const surroundingElementsHeight = PADDING_OUTER_Y + MARGIN_BODY_BOTTOM + HEIGHT_QUESTION + MARGIN_QUESTION_BOTTOM + HEIGHT_OPTIONS + AUTO_MODE_FALLBACK_HEIGHT;
    return Math.max(availableTerminalHeight - surroundingElementsHeight, 1);
  }
  __name(availableBodyContentHeight, "availableBodyContentHeight");
  const warningContentWidth = Math.max(
    contentWidth - 3 - (compactMode ? 0 : 2),
    1
  );
  function warningsHeight(warnings) {
    if (warnings.length === 0) return 0;
    const wrappedRows = warnings.reduce(
      (sum, warning) => sum + wrapAnsi(`\u26A0 ${warning}`, warningContentWidth, {
        trim: false,
        hard: true
      }).split("\n").length,
      0
    );
    return wrappedRows + 1;
  }
  __name(warningsHeight, "warningsHeight");
  if (confirmationDetails.type === "edit") {
    if (confirmationDetails.isModifying) {
      return /* @__PURE__ */ (0, import_jsx_runtime18.jsxs)(
        Box_default,
        {
          minWidth: "90%",
          borderStyle: "round",
          borderColor: theme.border.default,
          justifyContent: "space-around",
          padding: 1,
          overflow: "hidden",
          children: [
            /* @__PURE__ */ (0, import_jsx_runtime18.jsxs)(Text, { color: theme.text.primary, children: [
              t("Modify in progress:"),
              " "
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime18.jsx)(Text, { color: theme.status.success, children: t("Save and close external editor to continue") })
          ]
        }
      );
    }
    question = t("Apply this change?");
    options.push({
      label: t("Yes, allow once"),
      value: "proceed_once" /* ProceedOnce */,
      key: "Yes, allow once"
    });
    if (isTrustedFolder && !confirmationDetails.hideAlwaysAllow) {
      options.push({
        label: t("Yes, allow always"),
        value: "proceed_always" /* ProceedAlways */,
        key: "Yes, allow always"
      });
    }
    if (!confirmationDetails.hideModify && (!config.getIdeMode() || !isDiffingEnabled) && preferredEditor) {
      options.push({
        label: t("Modify with external editor"),
        value: "modify_with_editor" /* ModifyWithEditor */,
        key: "Modify with external editor"
      });
    }
    options.push({
      label: t("No, suggest changes (esc)"),
      value: "cancel" /* Cancel */,
      key: "No, suggest changes (esc)"
    });
    const warnings = confirmationDetails.warnings ?? [];
    let bodyHeight = availableBodyContentHeight();
    if (compactMode) {
      bodyHeight = Math.min(
        bodyHeight ?? COMPACT_BODY_MAX_LINES,
        COMPACT_BODY_MAX_LINES
      );
    }
    const constrainWarnings = warnings.length > 0 && bodyHeight !== void 0 && warningsHeight(warnings) + MINIMUM_MAX_HEIGHT > bodyHeight;
    let warningMaxHeight;
    let warningMarginBottom = warnings.length > 0 ? 1 : 0;
    let diffHeight = bodyHeight;
    if (constrainWarnings && bodyHeight !== void 0) {
      const desiredWarningHeight = Math.max(
        warnings.length,
        MINIMUM_MAX_HEIGHT
      );
      warningMarginBottom = bodyHeight >= desiredWarningHeight + MINIMUM_MAX_HEIGHT + 1 ? 1 : 0;
      warningMaxHeight = Math.min(
        desiredWarningHeight,
        Math.max(
          bodyHeight - MINIMUM_MAX_HEIGHT - warningMarginBottom,
          MINIMUM_MAX_HEIGHT
        ),
        bodyHeight
      );
      diffHeight = bodyHeight - warningMaxHeight - warningMarginBottom;
    } else if (diffHeight !== void 0) {
      diffHeight = Math.max(diffHeight - warningsHeight(warnings), 1);
    }
    const renderedDiff = diffHeight === void 0 || diffHeight >= MINIMUM_MAX_HEIGHT ? /* @__PURE__ */ (0, import_jsx_runtime18.jsx)(
      DiffRenderer,
      {
        diffContent: confirmationDetails.fileDiff,
        filename: confirmationDetails.fileName,
        availableTerminalHeight: diffHeight,
        contentWidth,
        settings
      }
    ) : diffHeight === 1 ? /* @__PURE__ */ (0, import_jsx_runtime18.jsx)(Text, { color: theme.text.secondary, wrap: "truncate", children: "... diff hidden ..." }) : null;
    bodyContent = /* @__PURE__ */ (0, import_jsx_runtime18.jsxs)(Box_default, { flexDirection: "column", children: [
      warnings.length > 0 ? /* @__PURE__ */ (0, import_jsx_runtime18.jsx)(
        Box_default,
        {
          flexDirection: "column",
          paddingX: 1,
          marginLeft: 1,
          marginBottom: warningMarginBottom,
          children: constrainWarnings && warningMaxHeight === 1 ? /* @__PURE__ */ (0, import_jsx_runtime18.jsxs)(Text, { color: theme.status.warning, wrap: "truncate", children: [
            "\u26A0 ",
            warnings.at(-1)?.replace(/\r\n?|\n/g, " \u21B5 ")
          ] }) : constrainWarnings ? /* @__PURE__ */ (0, import_jsx_runtime18.jsx)(
            MaxSizedBox,
            {
              maxHeight: warningMaxHeight,
              maxWidth: warningContentWidth,
              overflowDirection: "bottom",
              children: warnings.map((warning, idx) => /* @__PURE__ */ (0, import_jsx_runtime18.jsx)(Box_default, { children: /* @__PURE__ */ (0, import_jsx_runtime18.jsxs)(Text, { color: theme.status.warning, wrap: "truncate", children: [
                "\u26A0 ",
                warning.replace(/\r\n?|\n/g, " \u21B5 ")
              ] }) }, idx))
            }
          ) : warnings.map((warning, idx) => /* @__PURE__ */ (0, import_jsx_runtime18.jsxs)(Text, { color: theme.status.warning, children: [
            "\u26A0 ",
            warning
          ] }, idx))
        }
      ) : null,
      renderedDiff
    ] });
  } else if (confirmationDetails.type === "exec") {
    const executionProps = confirmationDetails;
    question = t("Allow execution of: '{{command}}'?", {
      command: executionProps.rootCommand
    });
    options.push({
      label: t("Yes, allow once"),
      value: "proceed_once" /* ProceedOnce */,
      key: "Yes, allow once"
    });
    if (isTrustedFolder && !confirmationDetails.hideAlwaysAllow) {
      const friendlyLabel = executionProps.permissionRules?.length ? ` ${buildHumanReadableRuleLabel(executionProps.permissionRules)}` : "";
      options.push({
        label: friendlyLabel ? t("Always allow {{action}} in this project", {
          action: friendlyLabel.trim()
        }) : t("Always allow in this project"),
        value: "proceed_always_project" /* ProceedAlwaysProject */,
        key: "Always allow in this project"
      });
      options.push({
        label: friendlyLabel ? t("Always allow {{action}} for this user", {
          action: friendlyLabel.trim()
        }) : t("Always allow for this user"),
        value: "proceed_always_user" /* ProceedAlwaysUser */,
        key: "Always allow for this user"
      });
    }
    options.push({
      label: t("No, suggest changes (esc)"),
      value: "cancel" /* Cancel */,
      key: "No, suggest changes (esc)"
    });
    const warnings = executionProps.warnings ?? [];
    const warningsCount = warnings.length;
    const reservedWarningsHeight = warningsHeight(warnings);
    let bodyContentHeight = availableBodyContentHeight();
    if (bodyContentHeight !== void 0) {
      bodyContentHeight -= 2;
    }
    if (compactMode) {
      bodyContentHeight = Math.min(
        bodyContentHeight ?? COMPACT_BODY_MAX_LINES,
        COMPACT_BODY_MAX_LINES
      );
    }
    if (bodyContentHeight !== void 0 && reservedWarningsHeight > 0) {
      bodyContentHeight = Math.max(
        bodyContentHeight - reservedWarningsHeight,
        1
      );
    }
    bodyContent = /* @__PURE__ */ (0, import_jsx_runtime18.jsxs)(Box_default, { flexDirection: "column", children: [
      /* @__PURE__ */ (0, import_jsx_runtime18.jsx)(Box_default, { paddingX: 1, marginLeft: 1, children: /* @__PURE__ */ (0, import_jsx_runtime18.jsx)(
        MaxSizedBox,
        {
          maxHeight: bodyContentHeight,
          maxWidth: Math.max(contentWidth, 1),
          overflowDirection: "bottom",
          children: /* @__PURE__ */ (0, import_jsx_runtime18.jsx)(Box_default, { children: /* @__PURE__ */ (0, import_jsx_runtime18.jsx)(Text, { color: theme.text.link, children: executionProps.command }) })
        }
      ) }),
      warningsCount > 0 ? /* @__PURE__ */ (0, import_jsx_runtime18.jsx)(Box_default, { flexDirection: "column", paddingX: 1, marginLeft: 1, marginTop: 1, children: warnings.map((warning, idx) => /* @__PURE__ */ (0, import_jsx_runtime18.jsxs)(Text, { color: theme.status.warning, children: [
        "\u26A0 ",
        warning
      ] }, idx)) }) : null
    ] });
  } else if (confirmationDetails.type === "plan") {
    const planProps = confirmationDetails;
    question = planProps.title;
    options.push({
      key: "restore-previous",
      label: t("Yes, restore previous mode ({{mode}})", {
        mode: planProps.prePlanMode ?? "default"
      }),
      value: "restore_previous" /* RestorePrevious */
    });
    options.push({
      key: "proceed-always",
      label: t("Yes, and auto-accept edits"),
      value: "proceed_always" /* ProceedAlways */
    });
    options.push({
      key: "proceed-once",
      label: t("Yes, and manually approve edits"),
      value: "proceed_once" /* ProceedOnce */
    });
    options.push({
      key: "cancel",
      label: t("No, keep planning (esc)"),
      value: "cancel" /* Cancel */
    });
    const rawPlanHeight = compactMode ? Math.min(
      availableBodyContentHeight() ?? COMPACT_BODY_MAX_LINES,
      COMPACT_BODY_MAX_LINES
    ) : availableBodyContentHeight();
    const planHeight = rawPlanHeight === void 0 ? void 0 : Math.max(rawPlanHeight - 1, 1);
    bodyContent = /* @__PURE__ */ (0, import_jsx_runtime18.jsxs)(Box_default, { flexDirection: "column", paddingX: 1, marginLeft: 1, children: [
      /* @__PURE__ */ (0, import_jsx_runtime18.jsx)(
        MarkdownDisplay,
        {
          text: planProps.plan,
          isPending: false,
          availableTerminalHeight: planHeight,
          contentWidth,
          enforceHeightBudget: true
        }
      ),
      planViewError ? /* @__PURE__ */ (0, import_jsx_runtime18.jsx)(Text, { color: theme.status.error, wrap: "truncate", children: planViewError }) : /* @__PURE__ */ (0, import_jsx_runtime18.jsx)(Text, { color: theme.text.secondary, wrap: "truncate", children: t("o open full plan in editor") })
    ] });
  } else if (confirmationDetails.type === "info") {
    const infoProps = confirmationDetails;
    const displayUrls = infoProps.urls && !(infoProps.urls.length === 1 && infoProps.urls[0] === infoProps.prompt);
    question = t("Do you want to proceed?");
    options.push({
      label: t("Yes, allow once"),
      value: "proceed_once" /* ProceedOnce */,
      key: "Yes, allow once"
    });
    if (isTrustedFolder && !confirmationDetails.hideAlwaysAllow) {
      const friendlyLabel = "permissionRules" in infoProps && infoProps.permissionRules?.length ? ` ${buildHumanReadableRuleLabel(infoProps.permissionRules)}` : "";
      options.push({
        label: friendlyLabel ? t("Always allow {{action}} in this project", {
          action: friendlyLabel.trim()
        }) : t("Always allow in this project"),
        value: "proceed_always_project" /* ProceedAlwaysProject */,
        key: "Always allow in this project"
      });
      options.push({
        label: friendlyLabel ? t("Always allow {{action}} for this user", {
          action: friendlyLabel.trim()
        }) : t("Always allow for this user"),
        value: "proceed_always_user" /* ProceedAlwaysUser */,
        key: "Always allow for this user"
      });
    }
    options.push({
      label: t("No, suggest changes (esc)"),
      value: "cancel" /* Cancel */,
      key: "No, suggest changes (esc)"
    });
    bodyContent = /* @__PURE__ */ (0, import_jsx_runtime18.jsxs)(Box_default, { flexDirection: "column", paddingX: 1, marginLeft: 1, children: [
      infoProps.renderPromptAsPlainText ? /* @__PURE__ */ (0, import_jsx_runtime18.jsx)(
        MaxSizedBox,
        {
          maxHeight: availableBodyContentHeight(),
          maxWidth: warningContentWidth,
          overflowDirection: "bottom",
          children: infoProps.prompt.split("\n").map((line, index) => /* @__PURE__ */ (0, import_jsx_runtime18.jsx)(Box_default, { children: /* @__PURE__ */ (0, import_jsx_runtime18.jsx)(Text, { color: theme.text.link, wrap: "wrap", children: line }) }, index))
        }
      ) : /* @__PURE__ */ (0, import_jsx_runtime18.jsx)(Text, { color: theme.text.link, children: /* @__PURE__ */ (0, import_jsx_runtime18.jsx)(RenderInline, { text: infoProps.prompt, textColor: theme.text.link }) }),
      displayUrls && infoProps.urls && infoProps.urls.length > 0 && /* @__PURE__ */ (0, import_jsx_runtime18.jsxs)(Box_default, { flexDirection: "column", marginTop: 1, children: [
        /* @__PURE__ */ (0, import_jsx_runtime18.jsx)(Text, { color: theme.text.primary, children: t("URLs to fetch:") }),
        infoProps.urls.map((url) => /* @__PURE__ */ (0, import_jsx_runtime18.jsxs)(Text, { children: [
          " ",
          "- ",
          /* @__PURE__ */ (0, import_jsx_runtime18.jsx)(RenderInline, { text: url })
        ] }, url))
      ] })
    ] });
  } else if (confirmationDetails.type === "ask_user_question") {
    return /* @__PURE__ */ (0, import_jsx_runtime18.jsx)(
      AskUserQuestionDialog,
      {
        confirmationDetails,
        isFocused,
        availableWidth: contentWidth,
        onConfirm
      }
    );
  } else {
    const mcpProps = confirmationDetails;
    bodyContent = /* @__PURE__ */ (0, import_jsx_runtime18.jsxs)(Box_default, { flexDirection: "column", paddingX: 1, marginLeft: 1, children: [
      /* @__PURE__ */ (0, import_jsx_runtime18.jsx)(Text, { color: theme.text.link, children: t("MCP Server: {{server}}", { server: mcpProps.serverName }) }),
      /* @__PURE__ */ (0, import_jsx_runtime18.jsx)(Text, { color: theme.text.link, children: t("Tool: {{tool}}", { tool: mcpProps.toolName }) })
    ] });
    question = t(
      'Allow execution of MCP tool "{{tool}}" from server "{{server}}"?',
      {
        tool: mcpProps.toolName,
        server: mcpProps.serverName
      }
    );
    options.push({
      label: t("Yes, allow once"),
      value: "proceed_once" /* ProceedOnce */,
      key: "Yes, allow once"
    });
    if (isTrustedFolder && !confirmationDetails.hideAlwaysAllow) {
      const friendlyLabel = mcpProps.permissionRules?.length ? ` ${buildHumanReadableRuleLabel(mcpProps.permissionRules)}` : "";
      options.push({
        label: friendlyLabel ? t("Always allow {{action}} in this project", {
          action: friendlyLabel.trim()
        }) : t("Always allow in this project"),
        value: "proceed_always_project" /* ProceedAlwaysProject */,
        key: "Always allow in this project"
      });
      options.push({
        label: friendlyLabel ? t("Always allow {{action}} for this user", {
          action: friendlyLabel.trim()
        }) : t("Always allow for this user"),
        value: "proceed_always_user" /* ProceedAlwaysUser */,
        key: "Always allow for this user"
      });
    }
    options.push({
      label: t("No, suggest changes (esc)"),
      value: "cancel" /* Cancel */,
      key: "No, suggest changes (esc)"
    });
  }
  if (offersSwitchToDefault) {
    const cancelIndex = options.findIndex(
      (option) => option.value === "cancel" /* Cancel */
    );
    const switchOption = {
      key: "switch-default-and-proceed-once",
      label: t("Switch to Default Mode and allow once (recommended)"),
      value: "proceed_once_and_switch_to_default" /* ProceedOnceAndSwitchToDefault */
    };
    options.splice(
      cancelIndex === -1 ? options.length : cancelIndex,
      0,
      switchOption
    );
  }
  if (autoModeFallback) {
    bodyContent = /* @__PURE__ */ (0, import_jsx_runtime18.jsxs)(Box_default, { flexDirection: "column", children: [
      /* @__PURE__ */ (0, import_jsx_runtime18.jsx)(Box_default, { paddingX: 1, marginLeft: 1, marginBottom: 1, children: /* @__PURE__ */ (0, import_jsx_runtime18.jsxs)(Text, { color: theme.status.warning, children: [
        "\u26A0 ",
        autoModeFallback.message
      ] }) }),
      bodyContent
    ] });
  }
  const renderedQuestion = compactMode && (confirmationDetails.type === "exec" || confirmationDetails.type === "mcp") ? t("Do you want to proceed?") : question;
  const renderedOptions = compactMode ? [
    {
      key: "proceed-once",
      label: t("Yes, allow once"),
      value: "proceed_once" /* ProceedOnce */
    },
    ...offersSwitchToDefault ? [
      {
        key: "switch-default-and-proceed-once",
        label: t(
          "Switch to Default Mode and allow once (recommended)"
        ),
        value: "proceed_once_and_switch_to_default" /* ProceedOnceAndSwitchToDefault */
      }
    ] : [],
    ...!confirmationDetails.hideAlwaysAllow ? [
      {
        key: "proceed-always",
        label: t("Allow always"),
        value: "proceed_always" /* ProceedAlways */
      }
    ] : [],
    {
      key: "cancel",
      label: t("No"),
      value: "cancel" /* Cancel */
    }
  ] : options;
  const outerPadding = compactMode ? 0 : 1;
  const sectionMargin = compactMode ? 0 : 1;
  const outerWidth = compactMode ? void 0 : contentWidth;
  return /* @__PURE__ */ (0, import_jsx_runtime18.jsxs)(Box_default, { flexDirection: "column", padding: outerPadding, width: outerWidth, children: [
    /* @__PURE__ */ (0, import_jsx_runtime18.jsx)(
      Box_default,
      {
        flexGrow: 1,
        flexShrink: 1,
        overflow: "hidden",
        marginBottom: sectionMargin,
        children: bodyContent
      }
    ),
    /* @__PURE__ */ (0, import_jsx_runtime18.jsx)(Box_default, { marginBottom: sectionMargin, flexShrink: 0, children: /* @__PURE__ */ (0, import_jsx_runtime18.jsx)(Text, { color: theme.text.primary, wrap: "truncate", children: renderedQuestion }) }),
    /* @__PURE__ */ (0, import_jsx_runtime18.jsx)(Box_default, { flexShrink: 0, children: /* @__PURE__ */ (0, import_jsx_runtime18.jsx)(
      RadioButtonSelect,
      {
        items: renderedOptions,
        onSelect: handleSelect,
        isFocused
      }
    ) })
  ] });
}, "ToolConfirmationMessage");

// packages/cli/src/ui/components/PlanSummaryDisplay.tsx
init_esbuild_shims();
var import_jsx_runtime19 = __toESM(require_jsx_runtime(), 1);
var PlanSummaryDisplay = /* @__PURE__ */ __name(({
  data,
  availableHeight,
  childWidth
}) => {
  const { message, plan, rejected } = data;
  const messageColor = rejected ? Colors.AccentYellow : Colors.AccentGreen;
  return /* @__PURE__ */ (0, import_jsx_runtime19.jsxs)(Box_default, { flexDirection: "column", children: [
    /* @__PURE__ */ (0, import_jsx_runtime19.jsx)(Box_default, { marginBottom: 1, children: /* @__PURE__ */ (0, import_jsx_runtime19.jsx)(Text, { color: messageColor, wrap: "wrap", children: message }) }),
    /* @__PURE__ */ (0, import_jsx_runtime19.jsx)(
      MarkdownDisplay,
      {
        text: plan,
        isPending: false,
        availableTerminalHeight: availableHeight,
        contentWidth: childWidth
      }
    )
  ] });
}, "PlanSummaryDisplay");

// packages/cli/src/ui/components/ShellInputPrompt.tsx
init_esbuild_shims();
var import_react24 = __toESM(require_react(), 1);

// packages/cli/src/ui/hooks/keyToAnsi.ts
init_esbuild_shims();
function keyToAnsi(key) {
  if (key.ctrl) {
    if (key.name >= "a" && key.name <= "z") {
      return String.fromCharCode(
        key.name.charCodeAt(0) - "a".charCodeAt(0) + 1
      );
    }
    switch (key.name) {
      case "c":
        return "";
      // ETX (End of Text), commonly used for interrupt
      // Add other special ctrl cases if needed
      default:
        break;
    }
  }
  switch (key.name) {
    case "up":
      return "\x1B[A";
    case "down":
      return "\x1B[B";
    case "right":
      return "\x1B[C";
    case "left":
      return "\x1B[D";
    case "escape":
      return "\x1B";
    case "tab":
      return "	";
    case "backspace":
      return "\x7F";
    case "delete":
      return "\x1B[3~";
    case "home":
      return "\x1B[H";
    case "end":
      return "\x1B[F";
    case "pageup":
      return "\x1B[5~";
    case "pagedown":
      return "\x1B[6~";
    default:
      break;
  }
  if (key.name === "return") {
    return "\r";
  }
  if (!key.ctrl && !key.meta && key.sequence) {
    return key.sequence;
  }
  return null;
}
__name(keyToAnsi, "keyToAnsi");

// packages/cli/src/ui/components/ShellInputPrompt.tsx
var ShellInputPrompt = /* @__PURE__ */ __name(({
  activeShellPtyId,
  focus = true
}) => {
  const handleShellInputSubmit = (0, import_react24.useCallback)(
    (input) => {
      if (activeShellPtyId) {
        ShellExecutionService.writeToPty(activeShellPtyId, input);
      }
    },
    [activeShellPtyId]
  );
  const handleInput = (0, import_react24.useCallback)(
    (key) => {
      if (!focus || !activeShellPtyId) {
        return;
      }
      if (keyMatchers["toggleShellInputFocus" /* TOGGLE_SHELL_INPUT_FOCUS */](key)) {
        return;
      }
      if (key.ctrl && key.shift && key.name === "up") {
        ShellExecutionService.scrollPty(activeShellPtyId, -1);
        return;
      }
      if (key.ctrl && key.shift && key.name === "down") {
        ShellExecutionService.scrollPty(activeShellPtyId, 1);
        return;
      }
      const ansiSequence = keyToAnsi(key);
      if (ansiSequence) {
        handleShellInputSubmit(ansiSequence);
      }
    },
    [focus, handleShellInputSubmit, activeShellPtyId]
  );
  useKeypress(handleInput, { isActive: focus });
  return null;
}, "ShellInputPrompt");

// packages/cli/src/ui/utils/tool-display-map.ts
init_esbuild_shims();
var TOOL_DISPLAY_BY_NAME = Object.fromEntries(
  Object.keys(ToolNames).map((key) => [
    ToolNames[key],
    ToolDisplayNames[key]
  ])
);

// packages/cli/src/ui/components/messages/ConversationMessages.tsx
init_esbuild_shims();

// packages/cli/src/ui/components/TerminalImage.tsx
init_esbuild_shims();
var import_react25 = __toESM(require_react(), 1);
import path2 from "node:path";
var import_jsx_runtime20 = __toESM(require_jsx_runtime(), 1);
var RenderedTerminalImage = /* @__PURE__ */ __name(({ result, unavailableText, contentWidth, availableTerminalHeight }) => {
  const writeRaw = useTerminalOutput();
  import_react25.default.useEffect(() => {
    if (result.kind !== "kitty") return;
    if (wasKittyImageWritten(result.key)) return;
    markKittyImageWritten(result.key);
    const sequence = result.sequence;
    process.nextTick(() => writeRaw(sequence));
  }, [result, writeRaw]);
  if (result.kind === "unavailable") {
    return /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(Text, { color: theme.text.secondary, wrap: "wrap", children: unavailableText });
  }
  if (result.kind === "ansi") {
    return /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(
      MaxSizedBox,
      {
        maxHeight: availableTerminalHeight,
        maxWidth: contentWidth,
        overflowDirection: "bottom",
        children: result.lines.map((line, index) => /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(Box_default, { children: /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(Text, { children: line || " " }) }, index))
      }
    );
  }
  return /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(
    MaxSizedBox,
    {
      maxHeight: availableTerminalHeight,
      maxWidth: contentWidth,
      overflowDirection: "bottom",
      children: result.placeholder.lines.map((line, index) => /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(Box_default, { children: /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(Text, { color: result.placeholder.color, wrap: "truncate-end", children: line }) }, index))
    }
  );
}, "RenderedTerminalImage");
var FileTerminalImage = /* @__PURE__ */ __name(({
  data,
  config,
  contentWidth,
  availableTerminalHeight
}) => {
  const filePath = path2.resolve(data.filePath);
  const safePath = config.getWorkspaceContext().isPathWithinWorkspace(filePath);
  const result = import_react25.default.useMemo(
    () => safePath ? renderTerminalImage({
      display: {
        type: "terminal_image",
        filePath,
        mimeType: data.mimeType
      },
      contentWidth,
      availableTerminalHeight
    }) : null,
    [availableTerminalHeight, contentWidth, data.mimeType, filePath, safePath]
  );
  if (!safePath) {
    return /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(Text, { color: theme.status.error, children: "Refusing to display an image outside the current workspace." });
  }
  if (!result) return null;
  const unavailableText = result.kind === "unavailable" ? `${sanitizeMultilineForDisplay(path2.basename(filePath))}: ${sanitizeTerminalText(result.reason)}` : "";
  return /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(
    RenderedTerminalImage,
    {
      result,
      unavailableText,
      contentWidth,
      availableTerminalHeight
    }
  );
}, "FileTerminalImage");
var InlineTerminalImage = /* @__PURE__ */ __name(({
  image,
  contentWidth,
  availableTerminalHeight
}) => {
  const isScreenReaderEnabled = use_is_screen_reader_enabled_default();
  const prepared = import_react25.default.useMemo(
    () => prepareInlineTerminalImage({
      data: image.data,
      mimeType: image.mimeType,
      contentWidth,
      availableTerminalHeight,
      disabled: isScreenReaderEnabled
    }),
    [
      availableTerminalHeight,
      contentWidth,
      image.data,
      image.mimeType,
      isScreenReaderEnabled
    ]
  );
  if (!prepared.result) {
    return /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(Text, { color: theme.text.secondary, children: prepared.fallbackText });
  }
  return /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(
    RenderedTerminalImage,
    {
      result: prepared.result,
      unavailableText: prepared.result.kind === "unavailable" ? `${prepared.fallbackText}: ${sanitizeTerminalText(prepared.result.reason)}` : prepared.fallbackText,
      contentWidth,
      availableTerminalHeight
    }
  );
}, "InlineTerminalImage");
var TerminalImage = /* @__PURE__ */ __name((props) => "image" in props ? /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(InlineTerminalImage, { ...props }) : /* @__PURE__ */ (0, import_jsx_runtime20.jsx)(FileTerminalImage, { ...props }), "TerminalImage");

// packages/cli/src/ui/components/messages/ConversationMessages.tsx
var import_jsx_runtime21 = __toESM(require_jsx_runtime(), 1);
var debugLogger6 = createDebugLogger("THINK_RENDER");
var THINKING_ICON = `${ICON.THEREFORE} `;
var THINKING_ICON_PENDING = `${ICON.BECAUSE} `;
var toggleKeyHint = "ctrl+o";
function getPrefixWidth(prefix) {
  return stringWidth(prefix) + 1;
}
__name(getPrefixWidth, "getPrefixWidth");
var PrefixedTextMessage = /* @__PURE__ */ __name(({
  text,
  prefix,
  prefixColor,
  textColor,
  ariaLabel,
  marginTop = 0,
  alignSelf
}) => {
  const prefixWidth = getPrefixWidth(prefix);
  return /* @__PURE__ */ (0, import_jsx_runtime21.jsxs)(
    Box_default,
    {
      flexDirection: "row",
      paddingY: 0,
      marginTop,
      alignSelf,
      children: [
        /* @__PURE__ */ (0, import_jsx_runtime21.jsx)(Box_default, { width: prefixWidth, flexShrink: 0, children: /* @__PURE__ */ (0, import_jsx_runtime21.jsx)(Text, { color: prefixColor, "aria-label": ariaLabel, children: prefix }) }),
        /* @__PURE__ */ (0, import_jsx_runtime21.jsx)(Box_default, { flexGrow: 1, children: /* @__PURE__ */ (0, import_jsx_runtime21.jsx)(Text, { wrap: "wrap", color: textColor, children: text }) })
      ]
    }
  );
}, "PrefixedTextMessage");
var PrefixedMarkdownMessage = /* @__PURE__ */ __name(({
  text,
  images,
  omittedImageCount,
  prefix,
  prefixColor,
  isPending,
  availableTerminalHeight,
  contentWidth,
  ariaLabel,
  textColor,
  sourceCopyIndexOffsets
}) => {
  const prefixWidth = getPrefixWidth(prefix);
  const imageHeightBudget = availableTerminalHeight !== void 0 && images?.length ? Math.max(
    1,
    Math.floor(
      availableTerminalHeight / (images.length + (text.length > 0 ? 1 : 0))
    )
  ) : availableTerminalHeight;
  return /* @__PURE__ */ (0, import_jsx_runtime21.jsxs)(Box_default, { flexDirection: "row", children: [
    /* @__PURE__ */ (0, import_jsx_runtime21.jsx)(Box_default, { width: prefixWidth, flexShrink: 0, children: /* @__PURE__ */ (0, import_jsx_runtime21.jsx)(Text, { color: prefixColor, "aria-label": ariaLabel, children: prefix }) }),
    /* @__PURE__ */ (0, import_jsx_runtime21.jsxs)(Box_default, { flexGrow: 1, flexDirection: "column", children: [
      text.length > 0 && /* @__PURE__ */ (0, import_jsx_runtime21.jsx)(
        MarkdownDisplay,
        {
          text,
          isPending,
          availableTerminalHeight,
          contentWidth: contentWidth - prefixWidth,
          textColor,
          sourceCopyIndexOffsets
        }
      ),
      images?.map((image, index) => /* @__PURE__ */ (0, import_jsx_runtime21.jsx)(
        TerminalImage,
        {
          image,
          contentWidth: contentWidth - prefixWidth,
          availableTerminalHeight: imageHeightBudget
        },
        index
      )),
      omittedImageCount !== void 0 && omittedImageCount > 0 && /* @__PURE__ */ (0, import_jsx_runtime21.jsx)(Text, { dimColor: true, children: formatInlineImageOverflow(omittedImageCount) })
    ] })
  ] });
}, "PrefixedMarkdownMessage");
var ContinuationMarkdownMessage = /* @__PURE__ */ __name(({
  text,
  images,
  omittedImageCount,
  isPending,
  availableTerminalHeight,
  contentWidth,
  basePrefix,
  textColor,
  sourceCopyIndexOffsets
}) => {
  const prefixWidth = getPrefixWidth(basePrefix);
  const imageHeightBudget = availableTerminalHeight !== void 0 && images?.length ? Math.max(
    1,
    Math.floor(
      availableTerminalHeight / (images.length + (text.length > 0 ? 1 : 0))
    )
  ) : availableTerminalHeight;
  return /* @__PURE__ */ (0, import_jsx_runtime21.jsxs)(Box_default, { flexDirection: "column", paddingLeft: prefixWidth, children: [
    text.length > 0 && /* @__PURE__ */ (0, import_jsx_runtime21.jsx)(
      MarkdownDisplay,
      {
        text,
        isPending,
        availableTerminalHeight,
        contentWidth: contentWidth - prefixWidth,
        textColor,
        sourceCopyIndexOffsets
      }
    ),
    images?.map((image, index) => /* @__PURE__ */ (0, import_jsx_runtime21.jsx)(
      TerminalImage,
      {
        image,
        contentWidth: contentWidth - prefixWidth,
        availableTerminalHeight: imageHeightBudget
      },
      index
    )),
    omittedImageCount !== void 0 && omittedImageCount > 0 && /* @__PURE__ */ (0, import_jsx_runtime21.jsx)(Text, { dimColor: true, children: formatInlineImageOverflow(omittedImageCount) })
  ] });
}, "ContinuationMarkdownMessage");
var UserMessage = /* @__PURE__ */ __name(({ text }) => (
  // The TUI paints no background of its own; user messages render directly on
  // the terminal background so they blend in across terminals and themes.
  /* @__PURE__ */ (0, import_jsx_runtime21.jsx)(
    PrefixedTextMessage,
    {
      text,
      prefix: ">",
      prefixColor: theme.text.accent,
      textColor: theme.text.accent,
      ariaLabel: SCREEN_READER_USER_PREFIX,
      alignSelf: "flex-start",
      marginTop: 1
    }
  )
), "UserMessage");
var UserShellMessage = /* @__PURE__ */ __name(({ text }) => {
  const commandToDisplay = text.startsWith("!") ? text.substring(1) : text;
  return /* @__PURE__ */ (0, import_jsx_runtime21.jsx)(
    PrefixedTextMessage,
    {
      text: commandToDisplay,
      prefix: "$",
      prefixColor: theme.text.link,
      textColor: theme.text.primary
    }
  );
}, "UserShellMessage");
var AssistantMessage = /* @__PURE__ */ __name(({
  text,
  images,
  omittedImageCount,
  isPending,
  availableTerminalHeight,
  contentWidth,
  sourceCopyIndexOffsets
}) => /* @__PURE__ */ (0, import_jsx_runtime21.jsx)(
  PrefixedMarkdownMessage,
  {
    text,
    images,
    omittedImageCount,
    prefix: ICON.DIAMOND,
    prefixColor: theme.text.accent,
    ariaLabel: SCREEN_READER_MODEL_PREFIX,
    isPending,
    availableTerminalHeight,
    contentWidth,
    sourceCopyIndexOffsets
  }
), "AssistantMessage");
var AssistantMessageContent = /* @__PURE__ */ __name(({
  text,
  images,
  omittedImageCount,
  isPending,
  availableTerminalHeight,
  contentWidth,
  sourceCopyIndexOffsets
}) => /* @__PURE__ */ (0, import_jsx_runtime21.jsx)(
  ContinuationMarkdownMessage,
  {
    text,
    images,
    omittedImageCount,
    isPending,
    availableTerminalHeight,
    contentWidth,
    basePrefix: ICON.DIAMOND,
    sourceCopyIndexOffsets
  }
), "AssistantMessageContent");
var BRIEF_THOUGHT_THRESHOLD_MS = 1e3;
var ThinkBody = /* @__PURE__ */ __name(({ text, isPending, expanded, availableTerminalHeight, contentWidth }) => {
  if (!expanded) return null;
  return /* @__PURE__ */ (0, import_jsx_runtime21.jsx)(Box_default, { paddingLeft: 2, flexDirection: "column", children: /* @__PURE__ */ (0, import_jsx_runtime21.jsx)(
    ErrorBoundary,
    {
      fallback: (err) => /* @__PURE__ */ (0, import_jsx_runtime21.jsx)(Text, { color: theme.text.secondary, dimColor: true, children: sanitizeTerminalText(err.message) }),
      onError: (error, info) => {
        debugLogger6.error(
          `[THINK_RENDER_ERROR] ${error.message}
${info.componentStack ?? ""}
${error.stack ?? ""}`
        );
      },
      children: /* @__PURE__ */ (0, import_jsx_runtime21.jsx)(
        MarkdownDisplay,
        {
          text,
          isPending,
          availableTerminalHeight,
          contentWidth: contentWidth - 2,
          textColor: theme.text.secondary
        }
      )
    }
  ) });
}, "ThinkBody");
var ThinkMessage = /* @__PURE__ */ __name(({
  text,
  isPending,
  expanded = false,
  availableTerminalHeight,
  contentWidth,
  durationMs,
  clickable = false
}) => {
  const durationSuffix = durationMs != null ? ` ${formatDuration2(durationMs)}` : "";
  const completedLabel = durationMs == null ? null : durationMs < BRIEF_THOUGHT_THRESHOLD_MS ? t("Thought briefly") : `${t("Thought for")} ${formatDuration2(durationMs)}`;
  if (!isPending && !expanded) {
    const label2 = completedLabel ?? t("Thinking");
    const hint = clickable ? t("(click or {{keyHint}} to expand)", { keyHint: toggleKeyHint }) : t("({{keyHint}} to expand)", { keyHint: toggleKeyHint });
    return /* @__PURE__ */ (0, import_jsx_runtime21.jsxs)(Text, { dimColor: true, italic: true, children: [
      THINKING_ICON,
      label2,
      " ",
      hint
    ] });
  }
  const label = isPending ? `${t("Thinking")}\u2026${durationSuffix}` : completedLabel ?? `${t("Thinking")}\u2026`;
  const collapseHint = !isPending && expanded ? ` ${t("({{keyHint}} to collapse)", { keyHint: toggleKeyHint })}` : "";
  return /* @__PURE__ */ (0, import_jsx_runtime21.jsxs)(Box_default, { flexDirection: "column", children: [
    /* @__PURE__ */ (0, import_jsx_runtime21.jsxs)(Text, { dimColor: true, italic: true, children: [
      isPending ? THINKING_ICON_PENDING : THINKING_ICON,
      label,
      collapseHint
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime21.jsx)(
      ThinkBody,
      {
        text,
        isPending,
        expanded,
        availableTerminalHeight,
        contentWidth
      }
    )
  ] });
}, "ThinkMessage");
var ThinkMessageContent = /* @__PURE__ */ __name(({
  text,
  isPending,
  expanded = false,
  availableTerminalHeight,
  contentWidth
}) => /* @__PURE__ */ (0, import_jsx_runtime21.jsx)(
  ThinkBody,
  {
    text,
    isPending,
    expanded,
    availableTerminalHeight,
    contentWidth
  }
), "ThinkMessageContent");

// packages/cli/src/ui/components/messages/ToolMessage.tsx
var import_jsx_runtime22 = __toESM(require_jsx_runtime(), 1);
var AGENT_TOOL_NAMES = /* @__PURE__ */ new Set([
  ToolNames.AGENT,
  ...Object.entries(ToolNamesMigration).filter(([, canonical]) => canonical === ToolNames.AGENT).map(([legacy]) => legacy)
]);
var APPROVAL_CONTEXT_CALLS = 3;
var STATIC_HEIGHT = 1;
var RESERVED_LINE_COUNT = 5;
var MIN_LINES_SHOWN = 2;
var DEFAULT_SHELL_OUTPUT_MAX_LINES = 5;
var MAXIMUM_RESULT_DISPLAY_CHARACTERS = 1e6;
function sliceTextForMaxHeight(text, maxHeight, maxWidth) {
  if (maxHeight === void 0) {
    return { text, hiddenLinesCount: 0 };
  }
  const targetMaxHeight = Math.max(Math.round(maxHeight), MINIMUM_MAX_HEIGHT);
  const visibleContentHeight = targetMaxHeight - 1;
  const visualWidth = Math.max(1, Math.floor(maxWidth));
  const visibleLines = [];
  let visualLineCount = 0;
  let currentLine = "";
  let currentLineWidth = 0;
  const appendVisibleLine = /* @__PURE__ */ __name((line, breakAfter) => {
    visualLineCount += 1;
    visibleLines.push({ text: line, breakAfter });
    if (visibleLines.length > visibleContentHeight) {
      visibleLines.shift();
    }
  }, "appendVisibleLine");
  const flushCurrentLine = /* @__PURE__ */ __name((breakAfter) => {
    appendVisibleLine(currentLine, breakAfter);
    currentLine = "";
    currentLineWidth = 0;
  }, "flushCurrentLine");
  for (const char of toCodePoints(text)) {
    if (char === "\n") {
      flushCurrentLine({ kind: "hard", joiner: "\n" });
      continue;
    }
    const charWidth = Math.max(getCachedStringWidth(char), 1);
    if (currentLineWidth > 0 && currentLineWidth + charWidth > visualWidth) {
      flushCurrentLine({ kind: "soft", joiner: "" });
    }
    currentLine += char;
    currentLineWidth += charWidth;
  }
  flushCurrentLine(null);
  if (visualLineCount <= targetMaxHeight) {
    return { text, hiddenLinesCount: 0 };
  }
  const hiddenLinesCount = visualLineCount - visibleContentHeight;
  return {
    text: visibleLines.map((line) => line.text).join("\n"),
    hiddenLinesCount,
    sourceBoundaries: visibleLines.slice(0, -1).map((line) => line.breakAfter ?? { kind: "hard", joiner: "\n" })
  };
}
__name(sliceTextForMaxHeight, "sliceTextForMaxHeight");
var useResultDisplayRenderer = /* @__PURE__ */ __name((resultDisplay) => import_react26.default.useMemo(() => {
  if (!resultDisplay) {
    return { type: "none" };
  }
  if (isTerminalImageDisplay(resultDisplay)) {
    return { type: "image", data: resultDisplay };
  }
  if (typeof resultDisplay === "object" && resultDisplay !== null && "type" in resultDisplay && resultDisplay.type === "todo_list") {
    return {
      type: "todo",
      data: resultDisplay
    };
  }
  if (typeof resultDisplay === "object" && resultDisplay !== null && "type" in resultDisplay && resultDisplay.type === "findings_list") {
    return {
      type: "findings",
      data: resultDisplay
    };
  }
  if (typeof resultDisplay === "object" && resultDisplay !== null && "type" in resultDisplay && resultDisplay.type === "plan_summary") {
    return {
      type: "plan",
      data: resultDisplay
    };
  }
  if (typeof resultDisplay === "object" && resultDisplay !== null && "type" in resultDisplay && resultDisplay.type === "task_execution") {
    return {
      type: "task",
      data: resultDisplay
    };
  }
  if (typeof resultDisplay === "object" && resultDisplay !== null && "fileDiff" in resultDisplay) {
    return {
      type: "diff",
      data: resultDisplay
    };
  }
  if (typeof resultDisplay === "object" && resultDisplay !== null && "type" in resultDisplay && resultDisplay.type === "mcp_tool_progress") {
    const progress = resultDisplay;
    const msg = progress.message ?? `Progress: ${progress.progress}`;
    const totalStr = progress.total != null ? `/${progress.total}` : "";
    return {
      type: "string",
      data: `\u25CC [${progress.progress}${totalStr}] ${msg}`
    };
  }
  if (typeof resultDisplay === "object" && resultDisplay !== null && "ansiOutput" in resultDisplay) {
    const display = resultDisplay;
    return {
      type: "ansi",
      data: display.ansiOutput,
      stats: {
        totalLines: display.totalLines,
        totalBytes: display.totalBytes
      }
    };
  }
  if (typeof resultDisplay === "object" && resultDisplay !== null && "type" in resultDisplay && (resultDisplay.type === "team_result" || resultDisplay.type === "task_list")) {
    return { type: "none" };
  }
  if (typeof resultDisplay === "object" && resultDisplay !== null && "type" in resultDisplay && resultDisplay.type === "mcp_app" && "fallbackText" in resultDisplay && typeof resultDisplay.fallbackText === "string") {
    return {
      type: "string",
      data: resultDisplay.fallbackText
    };
  }
  if (typeof resultDisplay === "object" && resultDisplay !== null && "type" in resultDisplay && resultDisplay.type === "ask_user_question_answers" && "text" in resultDisplay && typeof resultDisplay.text === "string") {
    return { type: "string", data: resultDisplay.text };
  }
  return {
    type: "string",
    data: typeof resultDisplay === "string" ? resultDisplay : JSON.stringify(resultDisplay)
  };
}, [resultDisplay]), "useResultDisplayRenderer");
var TodoResultRenderer = /* @__PURE__ */ __name(({
  data
}) => {
  if (data.unchanged) {
    return null;
  }
  return /* @__PURE__ */ (0, import_jsx_runtime22.jsx)(TodoDisplay, { todos: data.todos });
}, "TodoResultRenderer");
var PlanResultRenderer = /* @__PURE__ */ __name(({ data, availableHeight, childWidth }) => /* @__PURE__ */ (0, import_jsx_runtime22.jsx)(
  PlanSummaryDisplay,
  {
    data,
    availableHeight,
    childWidth
  }
), "PlanResultRenderer");
var priorApprovalCalls = /* @__PURE__ */ __name((data) => (data.toolCalls ?? []).filter((call) => call.status !== "awaiting_approval").slice(-APPROVAL_CONTEXT_CALLS), "priorApprovalCalls");
var SubagentApprovalContext = /* @__PURE__ */ __name(({ data }) => {
  const priorCalls = priorApprovalCalls(data);
  if (priorCalls.length === 0) return null;
  return /* @__PURE__ */ (0, import_jsx_runtime22.jsx)(Box_default, { flexDirection: "column", children: priorCalls.map((call) => {
    const glyph = call.status === "failed" ? "\u2716" : call.status === "success" ? "\u2714" : ICON.CIRCLE_EMPTY;
    const displayName = localizeToolDisplayName(
      TOOL_DISPLAY_BY_NAME[call.name] ?? call.name
    );
    const desc = (call.description ?? "").replace(/\s*\n\s*/g, " ").trim();
    const label = desc ? `${displayName} ${desc}` : displayName;
    return /* @__PURE__ */ (0, import_jsx_runtime22.jsx)(Box_default, { children: /* @__PURE__ */ (0, import_jsx_runtime22.jsx)(Text, { color: theme.text.secondary, wrap: "truncate-end", children: `  ${glyph} ${sanitizeMultilineForDisplay(label)}` }) }, call.callId);
  }) });
}, "SubagentApprovalContext");
var SubagentExecutionRenderer = /* @__PURE__ */ __name(({ data, availableHeight, childWidth, config, isFocused }) => {
  if (data.pendingConfirmation && isFocused) {
    const agentLabel = escapeAnsiCtrlCodes(data.subagentName || "agent");
    const HEADER_LINES = 1;
    const contextLines = priorApprovalCalls(data).length;
    const confirmationHeight = availableHeight !== void 0 ? Math.max(
      MINIMUM_MAX_HEIGHT,
      availableHeight - contextLines - HEADER_LINES
    ) : availableHeight;
    return /* @__PURE__ */ (0, import_jsx_runtime22.jsxs)(Box_default, { flexDirection: "column", paddingLeft: 1, children: [
      /* @__PURE__ */ (0, import_jsx_runtime22.jsxs)(Box_default, { children: [
        /* @__PURE__ */ (0, import_jsx_runtime22.jsx)(Text, { color: theme.text.secondary, children: "Approval requested by " }),
        /* @__PURE__ */ (0, import_jsx_runtime22.jsx)(Text, { bold: true, color: theme.text.accent, children: agentLabel }),
        /* @__PURE__ */ (0, import_jsx_runtime22.jsx)(Text, { color: theme.text.secondary, children: ":" })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime22.jsx)(SubagentApprovalContext, { data }),
      /* @__PURE__ */ (0, import_jsx_runtime22.jsx)(
        ToolConfirmationMessage,
        {
          confirmationDetails: data.pendingConfirmation,
          isFocused,
          availableTerminalHeight: confirmationHeight,
          contentWidth: childWidth - 2,
          compactMode: true,
          config
        }
      )
    ] });
  }
  if (data.pendingConfirmation) {
    const agentLabel = escapeAnsiCtrlCodes(data.subagentName || "agent");
    return /* @__PURE__ */ (0, import_jsx_runtime22.jsxs)(Box_default, { paddingLeft: 1, children: [
      /* @__PURE__ */ (0, import_jsx_runtime22.jsxs)(Text, { color: theme.text.secondary, dimColor: true, children: [
        "\u25CC Queued approval:",
        " "
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime22.jsx)(Text, { dimColor: true, children: agentLabel })
    ] });
  }
  if (data.status === "completed" || data.status === "failed" || data.status === "cancelled") {
    return /* @__PURE__ */ (0, import_jsx_runtime22.jsx)(SubagentScrollbackSummary, { data });
  }
  return null;
}, "SubagentExecutionRenderer");
var SubagentScrollbackSummary = /* @__PURE__ */ __name(({ data }) => {
  const { glyph, color } = (() => {
    switch (data.status) {
      case "completed":
        return { glyph: "\u2714", color: theme.status.success };
      case "failed":
        return { glyph: "\u2716", color: theme.status.error };
      case "cancelled":
        return { glyph: "\u2716", color: theme.status.warning };
      default:
        return { glyph: "\xB7", color: theme.text.secondary };
    }
  })();
  const stats = data.executionSummary;
  const parts = [];
  if (stats?.totalToolCalls !== void 0) {
    parts.push(
      `${stats.totalToolCalls} tool${stats.totalToolCalls === 1 ? "" : "s"}`
    );
  }
  const subagentSpawns = (stats?.toolUsage ?? []).filter((tu) => AGENT_TOOL_NAMES.has(tu.name)).reduce((sum, tu) => sum + tu.success, 0);
  if (subagentSpawns > 0) {
    parts.push(`${subagentSpawns} sub-agent${subagentSpawns === 1 ? "" : "s"}`);
  }
  if (stats?.totalDurationMs !== void 0) {
    parts.push(
      formatDuration(stats.totalDurationMs, { hideTrailingZeros: true })
    );
  }
  if (stats?.outputTokens && stats.outputTokens > 0) {
    parts.push(`${formatTokenCount(stats.outputTokens)} tokens`);
  }
  const tail = parts.length > 0 ? ` \xB7 ${parts.join(" \xB7 ")}` : "";
  const typePrefix = data.subagentName ? `${escapeAnsiCtrlCodes(data.subagentName)}: ` : "";
  const safeDescription = escapeAnsiCtrlCodes(data.taskDescription ?? "");
  const reason = data.status !== "completed" && data.terminateReason ? ` \xB7 ${escapeAnsiCtrlCodes(data.terminateReason)}` : "";
  return /* @__PURE__ */ (0, import_jsx_runtime22.jsx)(Box_default, { paddingLeft: 1, children: /* @__PURE__ */ (0, import_jsx_runtime22.jsxs)(Text, { wrap: "truncate-end", children: [
    /* @__PURE__ */ (0, import_jsx_runtime22.jsx)(Text, { color, children: `${glyph} ` }),
    /* @__PURE__ */ (0, import_jsx_runtime22.jsx)(Text, { bold: true, children: typePrefix }),
    /* @__PURE__ */ (0, import_jsx_runtime22.jsx)(Text, { color: theme.text.secondary, children: safeDescription }),
    /* @__PURE__ */ (0, import_jsx_runtime22.jsx)(Text, { color: theme.text.secondary, children: tail }),
    /* @__PURE__ */ (0, import_jsx_runtime22.jsx)(Text, { color: theme.text.secondary, children: reason })
  ] }) });
}, "SubagentScrollbackSummary");
var StringResultRenderer = /* @__PURE__ */ __name(({
  data,
  renderAsMarkdown,
  availableHeight,
  childWidth,
  registerOverflow
}) => {
  let displayData = data;
  if (displayData.length > MAXIMUM_RESULT_DISPLAY_CHARACTERS) {
    displayData = "..." + displayData.slice(-MAXIMUM_RESULT_DISPLAY_CHARACTERS);
  }
  if (renderAsMarkdown) {
    return /* @__PURE__ */ (0, import_jsx_runtime22.jsx)(Box_default, { flexDirection: "column", children: /* @__PURE__ */ (0, import_jsx_runtime22.jsx)(
      MarkdownDisplay,
      {
        text: displayData,
        isPending: false,
        availableTerminalHeight: availableHeight,
        contentWidth: childWidth
      }
    ) });
  }
  const sliced = sliceTextForMaxHeight(
    displayData,
    availableHeight,
    childWidth
  );
  return /* @__PURE__ */ (0, import_jsx_runtime22.jsx)(
    MaxSizedBox,
    {
      maxHeight: availableHeight,
      maxWidth: childWidth,
      additionalHiddenLinesCount: sliced.hiddenLinesCount,
      sourceBoundaries: sliced.sourceBoundaries,
      registerOverflow,
      children: /* @__PURE__ */ (0, import_jsx_runtime22.jsx)(Box_default, { children: /* @__PURE__ */ (0, import_jsx_runtime22.jsx)(Text, { wrap: "wrap", color: theme.text.primary, children: sliced.text }) })
    }
  );
}, "StringResultRenderer");
var DiffResultRenderer = /* @__PURE__ */ __name(({ data, availableHeight, childWidth, settings }) => {
  const diffHeight = data.truncatedForSession && availableHeight !== void 0 ? Math.max(1, availableHeight - 1) : availableHeight;
  return /* @__PURE__ */ (0, import_jsx_runtime22.jsxs)(Box_default, { flexDirection: "column", children: [
    data.truncatedForSession && /* @__PURE__ */ (0, import_jsx_runtime22.jsxs)(Text, { color: theme.status.warning, wrap: "wrap", children: [
      data.fileDiffTruncated ? "Saved session preview only; full diff omitted from JSONL" : "Saved session preview only; full file contents truncated in JSONL",
      data.fileDiffTruncated && typeof data.fileDiffLength === "number" ? ` (${data.fileDiffLength} chars).` : "."
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime22.jsx)(
      DiffRenderer,
      {
        diffContent: data.fileDiff,
        filename: data.fileName,
        availableTerminalHeight: diffHeight,
        contentWidth: childWidth,
        settings
      }
    )
  ] });
}, "DiffResultRenderer");
var ToolMessage = /* @__PURE__ */ __name(({
  name,
  description,
  resultDisplay,
  confirmationDetails,
  images,
  omittedImageCount,
  visionBridgeNotice,
  detailedDisplay,
  status,
  availableTerminalHeight,
  contentWidth,
  emphasis = "medium",
  renderOutputAsMarkdown = true,
  activeShellPtyId,
  embeddedShellFocused,
  ptyId,
  config,
  forceShowResult,
  fullDetail,
  showToolCallArgs,
  args,
  isFocused,
  isPending,
  executionStartTime
}) => {
  const settings = useSettings();
  const isThisShellFocused = (name === SHELL_COMMAND_NAME || name === SHELL_NAME) && status === "Executing" /* Executing */ && ptyId === activeShellPtyId && embeddedShellFocused;
  const [lastUpdateTime, setLastUpdateTime] = import_react26.default.useState(null);
  const [userHasFocused, setUserHasFocused] = import_react26.default.useState(false);
  const [showFocusHint, setShowFocusHint] = import_react26.default.useState(false);
  import_react26.default.useEffect(() => {
    if (resultDisplay) {
      setLastUpdateTime(/* @__PURE__ */ new Date());
    }
  }, [resultDisplay]);
  const shellTimeoutMs = import_react26.default.useMemo(() => {
    if (typeof resultDisplay === "object" && resultDisplay !== null && "ansiOutput" in resultDisplay) {
      return resultDisplay.timeoutMs;
    }
    return void 0;
  }, [resultDisplay]);
  import_react26.default.useEffect(() => {
    if (!lastUpdateTime) {
      return;
    }
    const timer = setTimeout(() => {
      setShowFocusHint(true);
    }, 5e3);
    return () => clearTimeout(timer);
  }, [lastUpdateTime]);
  import_react26.default.useEffect(() => {
    if (isThisShellFocused) {
      setUserHasFocused(true);
    }
  }, [isThisShellFocused]);
  const isThisShellFocusable = (name === SHELL_COMMAND_NAME || name === SHELL_NAME) && status === "Executing" /* Executing */ && config?.getShouldUseNodePtyShell();
  const shouldShowFocusHint = isThisShellFocusable && (showFocusHint || userHasFocused);
  const availableHeight = availableTerminalHeight ? Math.max(
    availableTerminalHeight - STATIC_HEIGHT - RESERVED_LINE_COUNT,
    MIN_LINES_SHOWN + 1
    // enforce minimum lines shown
  ) : void 0;
  const inlineImageHeight = availableHeight !== void 0 && images?.length ? Math.max(1, Math.floor(availableHeight / (images.length + 1))) : availableHeight;
  const isShellTool = name === SHELL_COMMAND_NAME || name === SHELL_NAME;
  const rawShellCap = settings.merged.ui?.shellOutputMaxLines ?? DEFAULT_SHELL_OUTPUT_MAX_LINES;
  const shellOutputMaxLines = Math.max(0, Math.floor(rawShellCap || 0));
  const isCappingShell = isShellTool && shellOutputMaxLines > 0 && !forceShowResult && !isThisShellFocused;
  const shellCapHeight = isCappingShell ? Math.min(availableHeight ?? shellOutputMaxLines, shellOutputMaxLines) : availableHeight;
  const shellStringCapHeight = isCappingShell && shellCapHeight !== void 0 ? shellCapHeight + 1 : availableHeight;
  const shellCapIgnoresShowMore = isCappingShell && shellCapHeight === shellOutputMaxLines;
  const innerWidth = contentWidth - STATUS_INDICATOR_WIDTH;
  if (availableHeight || isCappingShell) {
    renderOutputAsMarkdown = false;
  }
  const usingDetailedDisplay = fullDetail && isCollapsibleTool(name) && typeof detailedDisplay === "string" && detailedDisplay.length > 0;
  const sanitizedDetailedDisplay = import_react26.default.useMemo(
    () => usingDetailedDisplay && typeof detailedDisplay === "string" ? sanitizeTerminalText(detailedDisplay) : detailedDisplay,
    [detailedDisplay, usingDetailedDisplay]
  );
  const visionBridgeNoticeDisplay = isVisionBridgeNoticeDisplay(resultDisplay) ? resultDisplay : void 0;
  const visionBridgeNoticeText = [
    visionBridgeNoticeDisplay ? formatVisionBridgeNoticeDisplay(visionBridgeNoticeDisplay) : void 0,
    visionBridgeNotice
  ].filter((notice) => notice !== void 0).map((notice) => sanitizeTerminalText(notice)).join("\n");
  const effectiveResultDisplay = usingDetailedDisplay ? sanitizedDetailedDisplay : visionBridgeNoticeDisplay ? void 0 : resultDisplay;
  if (usingDetailedDisplay) {
    renderOutputAsMarkdown = false;
  }
  const effectiveDisplayRenderer = useResultDisplayRenderer(
    effectiveResultDisplay
  );
  const shouldCollapseResult = !forceShowResult && status === "Success" /* Success */ && isCollapsibleTool(name) && (effectiveDisplayRenderer.type === "string" || effectiveDisplayRenderer.type === "ansi");
  const inlineToolArgs = import_react26.default.useMemo(
    () => showToolCallArgs ? formatInlineToolArgs(
      args,
      description,
      fullDetail === true,
      // The row renders at `innerWidth` (the header's status-indicator
      // gutter is padding, not content), so that is the width the
      // line cap has to reason about.
      innerWidth > 0 ? innerWidth : void 0
    ) : void 0,
    [showToolCallArgs, args, description, fullDetail, innerWidth]
  );
  return /* @__PURE__ */ (0, import_jsx_runtime22.jsxs)(Box_default, { paddingY: 0, flexDirection: "column", children: [
    /* @__PURE__ */ (0, import_jsx_runtime22.jsxs)(Box_default, { minHeight: 1, children: [
      /* @__PURE__ */ (0, import_jsx_runtime22.jsx)(ToolStatusIndicator, { status, name }),
      /* @__PURE__ */ (0, import_jsx_runtime22.jsx)(
        ToolInfo,
        {
          name,
          status,
          description,
          emphasis,
          hideDescription: status === "Confirming" /* Confirming */ && confirmationDetails?.type === "info" && confirmationDetails.renderPromptAsPlainText === true && isDescriptionRepeatedInPrompt(
            description,
            confirmationDetails.prompt
          )
        }
      ),
      shouldShowFocusHint && /* @__PURE__ */ (0, import_jsx_runtime22.jsx)(Box_default, { marginLeft: 1, flexShrink: 0, children: /* @__PURE__ */ (0, import_jsx_runtime22.jsx)(Text, { color: theme.text.accent, children: isThisShellFocused ? "(Focused)" : "(ctrl+f to focus)" }) }),
      /* @__PURE__ */ (0, import_jsx_runtime22.jsx)(
        ToolElapsedTime,
        {
          status,
          executionStartTime,
          timeoutMs: shellTimeoutMs
        }
      ),
      emphasis === "high" && /* @__PURE__ */ (0, import_jsx_runtime22.jsx)(TrailingIndicator, {})
    ] }),
    inlineToolArgs !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime22.jsx)(Box_default, { paddingLeft: STATUS_INDICATOR_WIDTH, width: "100%", children: /* @__PURE__ */ (0, import_jsx_runtime22.jsx)(Text, { color: theme.text.secondary, wrap: "wrap", children: inlineToolArgs }) }),
    visionBridgeNoticeText && /* @__PURE__ */ (0, import_jsx_runtime22.jsx)(Box_default, { paddingLeft: STATUS_INDICATOR_WIDTH, width: "100%", children: /* @__PURE__ */ (0, import_jsx_runtime22.jsx)(
      StringResultRenderer,
      {
        data: visionBridgeNoticeText,
        renderAsMarkdown: false,
        childWidth: innerWidth
      }
    ) }),
    effectiveDisplayRenderer.type !== "none" && !shouldCollapseResult && /* @__PURE__ */ (0, import_jsx_runtime22.jsx)(Box_default, { paddingLeft: STATUS_INDICATOR_WIDTH, width: "100%", children: /* @__PURE__ */ (0, import_jsx_runtime22.jsxs)(Box_default, { flexDirection: "column", children: [
      effectiveDisplayRenderer.type === "todo" && /* @__PURE__ */ (0, import_jsx_runtime22.jsx)(TodoResultRenderer, { data: effectiveDisplayRenderer.data }),
      effectiveDisplayRenderer.type === "findings" && /* @__PURE__ */ (0, import_jsx_runtime22.jsx)(FindingsDisplay, { data: effectiveDisplayRenderer.data }),
      effectiveDisplayRenderer.type === "plan" && /* @__PURE__ */ (0, import_jsx_runtime22.jsx)(
        PlanResultRenderer,
        {
          data: effectiveDisplayRenderer.data,
          availableHeight,
          childWidth: innerWidth
        }
      ),
      effectiveDisplayRenderer.type === "task" && config && /* @__PURE__ */ (0, import_jsx_runtime22.jsx)(
        SubagentExecutionRenderer,
        {
          data: effectiveDisplayRenderer.data,
          availableHeight,
          childWidth: innerWidth,
          config,
          isFocused,
          isPending
        }
      ),
      effectiveDisplayRenderer.type === "diff" && /* @__PURE__ */ (0, import_jsx_runtime22.jsx)(
        DiffResultRenderer,
        {
          data: effectiveDisplayRenderer.data,
          availableHeight,
          childWidth: innerWidth,
          settings
        }
      ),
      effectiveDisplayRenderer.type === "ansi" && /* @__PURE__ */ (0, import_jsx_runtime22.jsxs)(import_jsx_runtime22.Fragment, { children: [
        /* @__PURE__ */ (0, import_jsx_runtime22.jsx)(
          AnsiOutputText,
          {
            data: effectiveDisplayRenderer.data,
            availableTerminalHeight: shellCapHeight,
            maxWidth: innerWidth
          }
        ),
        effectiveDisplayRenderer.stats && /* @__PURE__ */ (0, import_jsx_runtime22.jsx)(
          ShellStatsBar,
          {
            ...effectiveDisplayRenderer.stats,
            displayHeight: shellCapHeight
          }
        )
      ] }),
      effectiveDisplayRenderer.type === "image" && config && /* @__PURE__ */ (0, import_jsx_runtime22.jsx)(
        TerminalImage,
        {
          data: effectiveDisplayRenderer.data,
          config,
          contentWidth: innerWidth,
          availableTerminalHeight: availableHeight
        }
      ),
      effectiveDisplayRenderer.type === "string" && /* @__PURE__ */ (0, import_jsx_runtime22.jsx)(
        StringResultRenderer,
        {
          data: effectiveDisplayRenderer.data,
          renderAsMarkdown: renderOutputAsMarkdown,
          availableHeight: shellStringCapHeight,
          childWidth: innerWidth,
          registerOverflow: !shellCapIgnoresShowMore
        }
      )
    ] }) }),
    ((images?.length ?? 0) > 0 || omittedImageCount !== void 0 && omittedImageCount > 0) && /* @__PURE__ */ (0, import_jsx_runtime22.jsxs)(
      Box_default,
      {
        paddingLeft: STATUS_INDICATOR_WIDTH,
        width: "100%",
        flexDirection: "column",
        children: [
          images?.map((image, index) => /* @__PURE__ */ (0, import_jsx_runtime22.jsx)(
            TerminalImage,
            {
              image,
              contentWidth: innerWidth,
              availableTerminalHeight: inlineImageHeight
            },
            index
          )),
          omittedImageCount !== void 0 && omittedImageCount > 0 && /* @__PURE__ */ (0, import_jsx_runtime22.jsx)(Text, { dimColor: true, children: formatInlineImageOverflow(omittedImageCount) })
        ]
      }
    ),
    isThisShellFocused && config && /* @__PURE__ */ (0, import_jsx_runtime22.jsx)(Box_default, { paddingLeft: STATUS_INDICATOR_WIDTH, marginTop: 1, children: /* @__PURE__ */ (0, import_jsx_runtime22.jsx)(
      ShellInputPrompt,
      {
        activeShellPtyId: activeShellPtyId ?? null,
        focus: embeddedShellFocused
      }
    ) })
  ] });
}, "ToolMessage");
var TOOL_ARGS_INLINE_MAX_CHARS = 1e3;
var TOOL_ARGS_INLINE_MAX_LINES = 2;
function formatInlineToolArgs(args, description, uncapped, rowWidth) {
  if (!args || Object.keys(args).length === 0) {
    return void 0;
  }
  let json;
  try {
    json = JSON.stringify(args);
  } catch {
    return void 0;
  }
  return formatInlineToolArgsJson(json, description, uncapped, rowWidth);
}
__name(formatInlineToolArgs, "formatInlineToolArgs");
function formatInlineToolArgsJson(json, description, uncapped, rowWidth) {
  const trimmedDescription = description.trim();
  if (trimmedDescription.startsWith("{")) {
    try {
      if (JSON.stringify(JSON.parse(trimmedDescription)) === json || trimmedDescription === json) {
        return void 0;
      }
    } catch {
    }
  }
  if (uncapped) {
    return sanitizeTerminalText(json);
  }
  const budget = rowWidth !== void 0 && rowWidth > 0 ? Math.min(
    TOOL_ARGS_INLINE_MAX_CHARS,
    Math.floor(rowWidth) * TOOL_ARGS_INLINE_MAX_LINES
  ) : TOOL_ARGS_INLINE_MAX_CHARS;
  const markerWidth = `\u2026 +${json.length} chars (${toggleKeyHint})`.length;
  const headBudget = Math.max(1, budget - markerWidth);
  let columns = 0;
  let cut = -1;
  for (let i = 0; i < json.length; ) {
    const unit = json.charCodeAt(i);
    const size = unit >= 55296 && unit <= 56319 && i + 1 < json.length ? 2 : 1;
    const width = Math.max(getCachedStringWidth(json.slice(i, i + size)), 1);
    if (columns + width > headBudget) {
      cut = i;
      break;
    }
    columns += width;
    i += size;
  }
  if (cut < 0) {
    return sanitizeTerminalText(json);
  }
  let hidden = 0;
  for (let i = cut; i < json.length; ) {
    const unit = json.charCodeAt(i);
    i += unit >= 55296 && unit <= 56319 && i + 1 < json.length ? 2 : 1;
    hidden++;
  }
  return sanitizeTerminalText(
    `${json.slice(0, cut)}\u2026 +${hidden} chars (${toggleKeyHint})`
  );
}
__name(formatInlineToolArgsJson, "formatInlineToolArgsJson");
function isDescriptionRepeatedInPrompt(description, prompt) {
  try {
    const parsed = JSON.parse(description);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return false;
    }
    const values = Object.values(parsed);
    if (values.length === 0 || !values.every((value) => typeof value === "string")) {
      return false;
    }
    const promptValues = prompt.split("\n").flatMap((line) => {
      try {
        const value = JSON.parse(line);
        return typeof value === "string" ? [value] : [];
      } catch {
        return [];
      }
    });
    return values.every((value) => promptValues.includes(value));
  } catch {
    return false;
  }
}
__name(isDescriptionRepeatedInPrompt, "isDescriptionRepeatedInPrompt");
var ToolInfo = /* @__PURE__ */ __name(({
  name,
  description,
  status,
  emphasis,
  hideDescription
}) => {
  const nameColor = import_react26.default.useMemo(() => {
    switch (emphasis) {
      case "high":
        return theme.text.primary;
      case "medium":
        return theme.text.primary;
      case "low":
        return theme.text.secondary;
      default: {
        const exhaustiveCheck = emphasis;
        return exhaustiveCheck;
      }
    }
  }, [emphasis]);
  return /* @__PURE__ */ (0, import_jsx_runtime22.jsx)(Box_default, { flexGrow: 1, children: /* @__PURE__ */ (0, import_jsx_runtime22.jsxs)(Text, { wrap: "wrap", strikethrough: status === "Canceled" /* Canceled */, children: [
    /* @__PURE__ */ (0, import_jsx_runtime22.jsx)(Text, { color: nameColor, bold: true, children: localizeToolDisplayName(name) }),
    !hideDescription && /* @__PURE__ */ (0, import_jsx_runtime22.jsxs)(import_jsx_runtime22.Fragment, { children: [
      " ",
      /* @__PURE__ */ (0, import_jsx_runtime22.jsx)(Text, { color: theme.text.secondary, children: description })
    ] })
  ] }) });
}, "ToolInfo");
var TrailingIndicator = /* @__PURE__ */ __name(() => /* @__PURE__ */ (0, import_jsx_runtime22.jsxs)(Text, { color: theme.text.primary, wrap: "truncate", children: [
  " ",
  "\u2190"
] }), "TrailingIndicator");

// packages/cli/src/ui/components/mcp/MCPServerApprovalDialog.tsx
init_esbuild_shims();
var import_jsx_runtime23 = __toESM(require_jsx_runtime(), 1);
var MCPServerApprovalDialog = /* @__PURE__ */ __name(({ serverName, summary, source, pendingServers, remaining, onSelect }) => {
  useKeypress(
    (key) => {
      if (key.name === "escape") {
        onSelect("reject" /* REJECT */);
      }
    },
    { isActive: true }
  );
  const options = [
    {
      label: "Approve this server",
      value: "approve" /* APPROVE */,
      key: "approve"
    },
    {
      label: "Approve all pending servers in this workspace",
      value: "approve_all" /* APPROVE_ALL */,
      key: "approve_all"
    },
    {
      label: "Reject (esc)",
      value: "reject" /* REJECT */,
      key: "reject"
    }
  ];
  return /* @__PURE__ */ (0, import_jsx_runtime23.jsx)(Box_default, { flexDirection: "column", children: /* @__PURE__ */ (0, import_jsx_runtime23.jsxs)(
    Box_default,
    {
      flexDirection: "column",
      borderStyle: "round",
      borderColor: theme.status.warning,
      padding: 1,
      width: "100%",
      marginLeft: 1,
      children: [
        /* @__PURE__ */ (0, import_jsx_runtime23.jsxs)(Box_default, { flexDirection: "column", marginBottom: 1, children: [
          /* @__PURE__ */ (0, import_jsx_runtime23.jsx)(Text, { bold: true, color: theme.text.primary, children: `Untrusted MCP server in ${source}` }),
          /* @__PURE__ */ (0, import_jsx_runtime23.jsx)(Text, { color: theme.text.primary, children: `This workspace declares an MCP server. Approving lets Qwen Code start it and run its tools. Approval is bound to this exact configuration \u2014 if ${source} changes, you will be asked again.` })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime23.jsxs)(Box_default, { flexDirection: "column", marginBottom: 1, children: [
          /* @__PURE__ */ (0, import_jsx_runtime23.jsxs)(Text, { color: theme.text.primary, children: [
            /* @__PURE__ */ (0, import_jsx_runtime23.jsx)(Text, { bold: true, children: serverName }),
            `  ${summary}`
          ] }),
          remaining > 0 && /* @__PURE__ */ (0, import_jsx_runtime23.jsxs)(Box_default, { flexDirection: "column", marginTop: 1, children: [
            /* @__PURE__ */ (0, import_jsx_runtime23.jsx)(Text, { color: theme.text.secondary, children: "Approve all will trust these servers:" }),
            pendingServers.map((server) => /* @__PURE__ */ (0, import_jsx_runtime23.jsx)(Text, { color: theme.text.secondary, children: `  ${server.name}  ${server.summary}` }, server.name))
          ] })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime23.jsx)(RadioButtonSelect, { items: options, onSelect, isFocused: true })
      ]
    }
  ) });
}, "MCPServerApprovalDialog");

// packages/cli/src/ui/statusLinePresets.ts
init_esbuild_shims();
import nodePath from "node:path";
var STATUS_LINE_PRESET_ITEM_IDS = [
  "project-name",
  "git-branch",
  "model-with-reasoning",
  "model",
  "context-remaining",
  "total-input-tokens",
  "total-output-tokens",
  "current-dir",
  "pull-request-number",
  "branch-changes",
  "context-used",
  "run-state",
  "qwen-version",
  "context-window-size",
  "used-tokens",
  "session-id"
];
function aggregateModelTokens(metrics) {
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  for (const modelMetrics of Object.values(metrics.models)) {
    totalInputTokens += modelMetrics.tokens.prompt;
    totalOutputTokens += modelMetrics.tokens.candidates;
  }
  return { totalInputTokens, totalOutputTokens };
}
__name(aggregateModelTokens, "aggregateModelTokens");
var STATUS_LINE_PRESET_ITEMS = [
  {
    id: "project-name",
    label: "project-name",
    description: "Project name when available",
    defaultSelected: true
  },
  {
    id: "git-branch",
    label: "git-branch",
    description: "Current Git branch when available",
    defaultSelected: true
  },
  {
    id: "model-with-reasoning",
    label: "model-with-reasoning",
    description: "Current model name with reasoning level when available",
    defaultSelected: true
  },
  {
    id: "model",
    label: "model-only",
    description: "Current model name without reasoning level"
  },
  {
    id: "context-remaining",
    label: "context-remaining",
    description: "Percentage of context window remaining"
  },
  {
    id: "total-input-tokens",
    label: "total-input-tokens",
    description: "Total input tokens used in session"
  },
  {
    id: "total-output-tokens",
    label: "total-output-tokens",
    description: "Total output tokens used in session"
  },
  {
    id: "current-dir",
    label: "current-dir",
    description: "Current working directory"
  },
  {
    id: "pull-request-number",
    label: "pull-request-number",
    description: "Open pull request number for the current branch"
  },
  {
    id: "branch-changes",
    label: "branch-changes",
    description: "Session file changes added and removed"
  },
  {
    id: "context-used",
    label: "context-used",
    description: "Percentage of context window used",
    defaultSelected: true
  },
  {
    id: "run-state",
    label: "run-state",
    description: "Compact session run-state text"
  },
  {
    id: "qwen-version",
    label: "qwen-version",
    description: "Qwen Code application version"
  },
  {
    id: "context-window-size",
    label: "context-window-size",
    description: "Total context window size in tokens"
  },
  {
    id: "used-tokens",
    label: "used-tokens",
    description: "Current prompt tokens used"
  },
  {
    id: "session-id",
    label: "session-id",
    description: "Current session identifier"
  }
];
var STATUS_LINE_PRESET_ITEM_ID_SET = new Set(
  STATUS_LINE_PRESET_ITEM_IDS
);
function orderStatusLinePresetItems(items) {
  const selectedItems = new Set(
    items.filter(
      (item) => typeof item === "string" && STATUS_LINE_PRESET_ITEM_ID_SET.has(item)
    )
  );
  return STATUS_LINE_PRESET_ITEM_IDS.filter((item) => selectedItems.has(item));
}
__name(orderStatusLinePresetItems, "orderStatusLinePresetItems");
var DEFAULT_STATUS_LINE_PRESET_CONFIG = {
  type: "preset",
  useThemeColors: true,
  items: orderStatusLinePresetItems(
    STATUS_LINE_PRESET_ITEMS.filter((item) => item.defaultSelected).map(
      (item) => item.id
    )
  )
};
function normalizeStatusLinePresetConfig(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return void 0;
  }
  const candidate = raw;
  if (candidate["type"] !== "preset") {
    return void 0;
  }
  const hasItemsArray = Array.isArray(candidate["items"]);
  const items = hasItemsArray ? orderStatusLinePresetItems(candidate["items"]) : [];
  return {
    type: "preset",
    useThemeColors: typeof candidate["useThemeColors"] === "boolean" ? candidate["useThemeColors"] : true,
    items: hasItemsArray ? items : [...DEFAULT_STATUS_LINE_PRESET_CONFIG.items],
    hideContextIndicator: typeof candidate["hideContextIndicator"] === "boolean" ? candidate["hideContextIndicator"] : void 0
  };
}
__name(normalizeStatusLinePresetConfig, "normalizeStatusLinePresetConfig");
function formatPercent(value) {
  if (!Number.isFinite(value)) {
    return "0%";
  }
  const rounded = Math.round(value * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded}%`;
}
__name(formatPercent, "formatPercent");
function formatTokenCount2(value) {
  if (!Number.isFinite(value) || value <= 0) {
    return "0";
  }
  if (value >= 1e6) {
    return `${(value / 1e6).toFixed(1)}m`;
  }
  if (value >= 1e3) {
    return `${(value / 1e3).toFixed(1)}k`;
  }
  return String(Math.round(value));
}
__name(formatTokenCount2, "formatTokenCount");
function getRunStateLabel(state) {
  switch (state) {
    case "idle" /* Idle */:
      return "Ready";
    case "responding" /* Responding */:
      return "Working";
    case "waiting_for_confirmation" /* WaitingForConfirmation */:
      return "Confirm";
    default:
      return "Working";
  }
}
__name(getRunStateLabel, "getRunStateLabel");
function stripProviderPrefix(name) {
  return name.replace(/^\[[^\]]*\]\s*/, "");
}
__name(stripProviderPrefix, "stripProviderPrefix");
function formatModelWithReasoning(modelDisplayName, reasoning) {
  const cleanName = stripProviderPrefix(modelDisplayName);
  if (reasoning === false) {
    return `${cleanName} reasoning off`;
  }
  if (reasoning?.effort) {
    return `${cleanName} ${reasoning.effort}`;
  }
  return cleanName;
}
__name(formatModelWithReasoning, "formatModelWithReasoning");
function inferPullRequestNumber(branch) {
  if (!branch) {
    return void 0;
  }
  const match = branch.match(
    /(?:^|[/_-])(?:pr|pull|pull-request)[/_-]?#?(\d+)(?:$|[/_-])/i
  );
  return match?.[1];
}
__name(inferPullRequestNumber, "inferPullRequestNumber");
function buildStatusLinePresetData(params) {
  const usedPercentage = params.contextWindowSize > 0 ? Math.min(
    100,
    Math.max(
      0,
      Math.round(
        params.currentUsage / params.contextWindowSize * 1e3
      ) / 10
    )
  ) : 0;
  return {
    sessionId: params.sessionId,
    version: params.version || "unknown",
    modelDisplayName: params.modelDisplayName || "unknown",
    reasoning: params.reasoning,
    currentDir: params.currentDir,
    projectName: nodePath.basename(params.currentDir) || void 0,
    branch: params.branch,
    pullRequestNumber: params.pullRequestNumber,
    contextWindowSize: params.contextWindowSize,
    usedPercentage,
    remainingPercentage: Math.round((100 - usedPercentage) * 10) / 10,
    currentUsage: params.currentUsage,
    totalInputTokens: params.totalInputTokens,
    totalOutputTokens: params.totalOutputTokens,
    totalLinesAdded: params.totalLinesAdded,
    totalLinesRemoved: params.totalLinesRemoved,
    streamingState: params.streamingState
  };
}
__name(buildStatusLinePresetData, "buildStatusLinePresetData");
function formatPresetItem(item, data) {
  switch (item) {
    case "model-with-reasoning":
      return formatModelWithReasoning(data.modelDisplayName, data.reasoning);
    case "model":
      return stripProviderPrefix(data.modelDisplayName);
    case "context-remaining":
      if (data.contextWindowSize > 0) {
        return `Context ${formatPercent(data.remainingPercentage)} left`;
      }
      return void 0;
    case "current-dir":
      return data.currentDir;
    case "context-used":
      if (data.contextWindowSize > 0 && data.usedPercentage > 0) {
        return `${formatTokenCount2(data.contextWindowSize)} Context ${formatPercent(data.usedPercentage)} used`;
      }
      return void 0;
    case "git-branch":
      if (data.branch) {
        return `git:(${data.branch})`;
      }
      return void 0;
    case "project-name":
      if (data.projectName) {
        return `\u279C ${data.projectName}`;
      }
      return void 0;
    case "pull-request-number": {
      const prNumber = data.pullRequestNumber ?? inferPullRequestNumber(data.branch);
      if (prNumber) {
        return `#${prNumber}`;
      }
      return void 0;
    }
    case "branch-changes":
      if (data.totalLinesAdded > 0 || data.totalLinesRemoved > 0) {
        return `+${data.totalLinesAdded} -${data.totalLinesRemoved}`;
      }
      return void 0;
    case "run-state":
      return getRunStateLabel(data.streamingState);
    case "qwen-version":
      return `v${data.version}`;
    case "context-window-size":
      if (data.contextWindowSize > 0) {
        return `${formatTokenCount2(data.contextWindowSize)} window`;
      }
      return void 0;
    case "used-tokens":
      if (data.currentUsage > 0) {
        return `${formatTokenCount2(data.currentUsage)} used`;
      }
      return void 0;
    case "total-input-tokens":
      return `${formatTokenCount2(data.totalInputTokens)} total in`;
    case "total-output-tokens":
      return `${formatTokenCount2(data.totalOutputTokens)} total out`;
    case "session-id":
      return data.sessionId || void 0;
    default: {
      item;
      return void 0;
    }
  }
}
__name(formatPresetItem, "formatPresetItem");
function buildStatusLinePresetParts(config, data) {
  const parts = [];
  for (const item of orderStatusLinePresetItems(config.items)) {
    const text = formatPresetItem(item, data);
    if (text) {
      parts.push(text);
    }
  }
  return parts;
}
__name(buildStatusLinePresetParts, "buildStatusLinePresetParts");
function buildStatusLinePresetLines(config, data) {
  const line = buildStatusLinePresetParts(config, data).join(" \xB7 ").replace(/[\n\r\v\f\u0085\u2028\u2029]+/g, " ");
  return line ? [line] : [];
}
__name(buildStatusLinePresetLines, "buildStatusLinePresetLines");

// packages/cli/src/ui/utils/modelsBySource.ts
init_esbuild_shims();
function flattenModelsBySource(models) {
  const sessionHasNonMainSource = Object.values(models).some(
    (modelMetrics) => Object.keys(modelMetrics.bySource).some((source) => source !== MAIN_SOURCE)
  );
  const result = [];
  for (const [modelName, modelMetrics] of Object.entries(models)) {
    if (modelMetrics.api.totalRequests <= 0) continue;
    const displayName = normalizeModelName(modelName);
    const sourceNames = Object.keys(modelMetrics.bySource);
    if (sourceNames.length === 0) {
      result.push({
        key: modelName,
        label: displayName,
        metrics: modelMetrics
      });
      continue;
    }
    if (!sessionHasNonMainSource) {
      result.push({
        key: modelName,
        label: displayName,
        metrics: modelMetrics.bySource[MAIN_SOURCE] ?? modelMetrics
      });
      continue;
    }
    const sortedSources = sortSources(sourceNames);
    for (const source of sortedSources) {
      result.push({
        key: `${modelName}::${source}`,
        label: `${displayName} (${source})`,
        metrics: modelMetrics.bySource[source]
      });
    }
  }
  return result;
}
__name(flattenModelsBySource, "flattenModelsBySource");
function normalizeModelName(modelName) {
  return modelName.replace("-001", "");
}
__name(normalizeModelName, "normalizeModelName");
function sortSources(sources) {
  const main = [];
  const rest = [];
  for (const source of sources) {
    if (source === MAIN_SOURCE) {
      main.push(source);
    } else {
      rest.push(source);
    }
  }
  rest.sort((a, b) => a.localeCompare(b));
  return [...main, ...rest];
}
__name(sortSources, "sortSources");

export {
  SettingsContext,
  useSettings,
  useTerminalSize,
  loadLowlight,
  colorizeCode,
  fitPendingSlice,
  RenderInline,
  TerminalOutputProvider,
  RenderModeProvider,
  getEnclosingFenceInfo,
  findLastSafeSplitPoint,
  splitFencedMarkdown,
  countMarkdownSourceBlocks,
  MarkdownDisplay,
  consumeLastRenderError,
  ErrorBoundary,
  getArenaStatusLabel,
  TOOL_SUCCESS_RATE_HIGH,
  TOOL_SUCCESS_RATE_MEDIUM,
  USER_AGREEMENT_RATE_HIGH,
  USER_AGREEMENT_RATE_MEDIUM,
  getStatusColor,
  formatDuration2 as formatDuration,
  UserMessage,
  UserShellMessage,
  AssistantMessage,
  AssistantMessageContent,
  ThinkMessage,
  ThinkMessageContent,
  DiffRenderer,
  Colors,
  keyMatchers,
  useSelectionList,
  VirtualViewportContext,
  useVirtualViewport,
  useMouseTrackingEnabled,
  useMouseEvents,
  ContextMenuProvider,
  useContextMenu,
  contextMenuSize,
  clampMenuPosition,
  frameAnchor,
  measureElementPosition,
  layoutRowForEvent,
  findElementAtMouseEvent,
  RowMouseController,
  BaseSelectionList,
  RadioButtonSelect,
  useLaunchEditor,
  checkExhaustive,
  getWordBoundaries,
  findPrevWordStart,
  findPrevWordStartInLine,
  logicalPosToOffset,
  useTextBuffer,
  usePreferredEditor,
  renderSoftwareCursor,
  TextInput,
  computeHeaderCap,
  ToolConfirmationMessage,
  TOOL_DISPLAY_BY_NAME,
  ToolMessage,
  TOOL_ARGS_INLINE_MAX_LINES,
  formatInlineToolArgsJson,
  SessionStatsProvider,
  useSessionStats,
  flattenModelsBySource,
  MCPServerApprovalDialog,
  aggregateModelTokens,
  STATUS_LINE_PRESET_ITEMS,
  orderStatusLinePresetItems,
  DEFAULT_STATUS_LINE_PRESET_CONFIG,
  normalizeStatusLinePresetConfig,
  formatTokenCount2 as formatTokenCount,
  buildStatusLinePresetData,
  buildStatusLinePresetLines
};
/**
 * @license
 * Copyright 2025 Google LLC
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
/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 *
 * Inspired by gemini-cli's MouseContext (Google LLC, Apache-2.0): enable SGR
 * mouse mode while at least one subscriber is active, parse mouse sequences
 * out of the KeypressContext pipeline, call each handler, restore on cleanup.
 */
/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 *
 * Pure geometry helper for mapping a terminal mouse row onto a vertical list of
 * items. The DOM measurement (reading yoga layout via measureElementPosition)
 * lives in the component that owns the refs; this is pure arithmetic so it can
 * be unit-tested without a renderer.
 */
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Shim for ink PR #968 (vadimdemedes/ink#968): extends measureElement()
 * to return {x, y, width, height}. Once the upstream PR is merged and
 * ink is upgraded, replace usages with `measureElement` from 'ink'
 * and delete this file.
 */
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
