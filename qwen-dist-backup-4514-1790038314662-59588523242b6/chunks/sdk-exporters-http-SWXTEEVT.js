// Force strict mode and setup for ESM
"use strict";
import {
  esm_exports,
  index_node_http_exports,
  init_esm as init_esm2,
  init_index_node_http,
  require_src as require_src3,
  require_src2 as require_src4
} from "./chunk-IK2MWJP5.js";
import {
  require_src2 as require_src,
  require_src3 as require_src2
} from "./chunk-7NXSVSFB.js";
import {
  EVENT_SUBAGENT_EXECUTION,
  EVENT_TOOL_CALL,
  SERVICE_NAME,
  deriveTraceId,
  isInNativeSubagentSpan,
  randomHexString,
  randomSpanId
} from "./chunk-B3XJFEEH.js";
import "./chunk-74TONY4F.js";
import {
  getCurrentSessionId,
  getSessionIdFromContext,
  sessionIdContext
} from "./chunk-ZYDMQCQP.js";
import "./chunk-S34QJ6IR.js";
import {
  SpanKind,
  SpanStatusCode,
  TraceFlags,
  init_esm,
  isSpanContextValid
} from "./chunk-TBWQLLFO.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __commonJS,
  __name,
  __toCommonJS,
  __toESM
} from "./chunk-J2S4EL5Y.js";

// packages/core/node_modules/@opentelemetry/exporter-trace-otlp-http/build/src/semconv.js
var require_semconv = __commonJS({
  "packages/core/node_modules/@opentelemetry/exporter-trace-otlp-http/build/src/semconv.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.OTEL_COMPONENT_TYPE_VALUE_OTLP_HTTP_SPAN_EXPORTER = void 0;
    exports.OTEL_COMPONENT_TYPE_VALUE_OTLP_HTTP_SPAN_EXPORTER = "otlp_http_span_exporter";
  }
});

// packages/core/node_modules/@opentelemetry/exporter-trace-otlp-http/build/src/platform/node/OTLPTraceExporter.js
var require_OTLPTraceExporter = __commonJS({
  "packages/core/node_modules/@opentelemetry/exporter-trace-otlp-http/build/src/platform/node/OTLPTraceExporter.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.OTLPTraceExporter = void 0;
    var otlp_exporter_base_1 = (init_esm2(), __toCommonJS(esm_exports));
    var otlp_transformer_1 = require_src3();
    var node_http_1 = (init_index_node_http(), __toCommonJS(index_node_http_exports));
    var semconv_1 = require_semconv();
    var OTLPTraceExporter = class extends otlp_exporter_base_1.OTLPExporterBase {
      static {
        __name(this, "OTLPTraceExporter");
      }
      constructor(config = {}) {
        super((0, node_http_1.createOtlpHttpExportDelegate)((0, node_http_1.convertLegacyHttpOptions)(config, "TRACES", "v1/traces", {
          "Content-Type": "application/json"
        }), otlp_transformer_1.JsonTraceSerializer, semconv_1.OTEL_COMPONENT_TYPE_VALUE_OTLP_HTTP_SPAN_EXPORTER, otlp_transformer_1.TraceExporterMetricsHelper, config.selfObsMeterProvider));
      }
    };
    exports.OTLPTraceExporter = OTLPTraceExporter;
  }
});

// packages/core/node_modules/@opentelemetry/exporter-trace-otlp-http/build/src/platform/node/index.js
var require_node = __commonJS({
  "packages/core/node_modules/@opentelemetry/exporter-trace-otlp-http/build/src/platform/node/index.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.OTLPTraceExporter = void 0;
    var OTLPTraceExporter_1 = require_OTLPTraceExporter();
    Object.defineProperty(exports, "OTLPTraceExporter", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return OTLPTraceExporter_1.OTLPTraceExporter;
    }, "get") });
  }
});

// packages/core/node_modules/@opentelemetry/exporter-trace-otlp-http/build/src/platform/index.js
var require_platform = __commonJS({
  "packages/core/node_modules/@opentelemetry/exporter-trace-otlp-http/build/src/platform/index.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.OTLPTraceExporter = void 0;
    var node_1 = require_node();
    Object.defineProperty(exports, "OTLPTraceExporter", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return node_1.OTLPTraceExporter;
    }, "get") });
  }
});

// packages/core/node_modules/@opentelemetry/exporter-trace-otlp-http/build/src/index.js
var require_src5 = __commonJS({
  "packages/core/node_modules/@opentelemetry/exporter-trace-otlp-http/build/src/index.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.OTLPTraceExporter = void 0;
    var platform_1 = require_platform();
    Object.defineProperty(exports, "OTLPTraceExporter", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return platform_1.OTLPTraceExporter;
    }, "get") });
  }
});

// packages/core/node_modules/@opentelemetry/exporter-logs-otlp-http/build/src/semconv.js
var require_semconv2 = __commonJS({
  "packages/core/node_modules/@opentelemetry/exporter-logs-otlp-http/build/src/semconv.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.OTEL_COMPONENT_TYPE_VALUE_OTLP_HTTP_LOG_EXPORTER = void 0;
    exports.OTEL_COMPONENT_TYPE_VALUE_OTLP_HTTP_LOG_EXPORTER = "otlp_http_log_exporter";
  }
});

// packages/core/node_modules/@opentelemetry/exporter-logs-otlp-http/build/src/platform/node/OTLPLogExporter.js
var require_OTLPLogExporter = __commonJS({
  "packages/core/node_modules/@opentelemetry/exporter-logs-otlp-http/build/src/platform/node/OTLPLogExporter.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.OTLPLogExporter = void 0;
    var otlp_exporter_base_1 = (init_esm2(), __toCommonJS(esm_exports));
    var otlp_transformer_1 = require_src3();
    var node_http_1 = (init_index_node_http(), __toCommonJS(index_node_http_exports));
    var semconv_1 = require_semconv2();
    var OTLPLogExporter = class extends otlp_exporter_base_1.OTLPExporterBase {
      static {
        __name(this, "OTLPLogExporter");
      }
      constructor(config = {}) {
        super((0, node_http_1.createOtlpHttpExportDelegate)((0, node_http_1.convertLegacyHttpOptions)(config, "LOGS", "v1/logs", {
          "Content-Type": "application/json"
        }), otlp_transformer_1.JsonLogsSerializer, semconv_1.OTEL_COMPONENT_TYPE_VALUE_OTLP_HTTP_LOG_EXPORTER, otlp_transformer_1.LogsExporterMetricsHelper, config.selfObsMeterProvider));
      }
    };
    exports.OTLPLogExporter = OTLPLogExporter;
  }
});

// packages/core/node_modules/@opentelemetry/exporter-logs-otlp-http/build/src/platform/node/index.js
var require_node2 = __commonJS({
  "packages/core/node_modules/@opentelemetry/exporter-logs-otlp-http/build/src/platform/node/index.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.OTLPLogExporter = void 0;
    var OTLPLogExporter_1 = require_OTLPLogExporter();
    Object.defineProperty(exports, "OTLPLogExporter", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return OTLPLogExporter_1.OTLPLogExporter;
    }, "get") });
  }
});

// packages/core/node_modules/@opentelemetry/exporter-logs-otlp-http/build/src/platform/index.js
var require_platform2 = __commonJS({
  "packages/core/node_modules/@opentelemetry/exporter-logs-otlp-http/build/src/platform/index.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.OTLPLogExporter = void 0;
    var node_1 = require_node2();
    Object.defineProperty(exports, "OTLPLogExporter", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return node_1.OTLPLogExporter;
    }, "get") });
  }
});

// packages/core/node_modules/@opentelemetry/exporter-logs-otlp-http/build/src/index.js
var require_src6 = __commonJS({
  "packages/core/node_modules/@opentelemetry/exporter-logs-otlp-http/build/src/index.js"(exports) {
    "use strict";
    init_esbuild_shims();
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.OTLPLogExporter = void 0;
    var platform_1 = require_platform2();
    Object.defineProperty(exports, "OTLPLogExporter", { enumerable: true, get: /* @__PURE__ */ __name(function() {
      return platform_1.OTLPLogExporter;
    }, "get") });
  }
});

// packages/core/src/telemetry/sdk-exporters-http.ts
init_esbuild_shims();
var import_exporter_trace_otlp_http = __toESM(require_src5(), 1);
var import_exporter_logs_otlp_http = __toESM(require_src6(), 1);
var import_exporter_metrics_otlp_http = __toESM(require_src4(), 1);
var import_sdk_metrics = __toESM(require_src2(), 1);

// packages/core/src/telemetry/log-to-span-processor.ts
init_esbuild_shims();
init_esm();
var import_resources = __toESM(require_src(), 1);
var BRIDGE_SKIP_EVENT_NAMES = /* @__PURE__ */ new Set([EVENT_SUBAGENT_EXECUTION]);
var EXPORT_TIMEOUT_MS = 3e4;
var DEFAULT_MAX_BUFFER_SIZE = 1e4;
var BUFFER_OVERFLOW_WARNING_INTERVAL_MS = 3e4;
var LOG_EVENT_ERROR_STATUS_MESSAGE = "Log event recorded error";
var DEFAULT_LOG_SPAN_NAME = "log.event";
var MAX_SPAN_NAME_LENGTH = 128;
var SENSITIVE_ATTRIBUTE_KEYS = /* @__PURE__ */ new Set([
  "error",
  "error.message",
  "error_message",
  "prompt",
  "function_args",
  "request_text",
  "response_text"
]);
var defaultDiagnosticsSink = /* @__PURE__ */ __name((message) => {
  process.stderr.write(`${message}
`);
}, "defaultDiagnosticsSink");
var LogToSpanProcessor = class {
  constructor(spanExporter, flushIntervalMsOrOptions = 5e3, maxBufferSize = DEFAULT_MAX_BUFFER_SIZE) {
    this.spanExporter = spanExporter;
    if (typeof flushIntervalMsOrOptions === "number") {
      this.flushIntervalMs = flushIntervalMsOrOptions;
      this.includeSensitiveSpanAttributes = false;
      this.maxBufferSize = normalizeMaxBufferSize(maxBufferSize);
      this.diagnosticsSink = defaultDiagnosticsSink;
    } else {
      this.flushIntervalMs = flushIntervalMsOrOptions.flushIntervalMs ?? 5e3;
      this.includeSensitiveSpanAttributes = flushIntervalMsOrOptions.includeSensitiveSpanAttributes ?? false;
      this.maxBufferSize = normalizeMaxBufferSize(
        flushIntervalMsOrOptions.maxBufferSize
      );
      this.diagnosticsSink = flushIntervalMsOrOptions.diagnosticsSink ?? defaultDiagnosticsSink;
    }
    this.flushTimer = setInterval(() => {
      void this.flush();
    }, this.flushIntervalMs);
    this.flushTimer.unref();
  }
  static {
    __name(this, "LogToSpanProcessor");
  }
  buffer = [];
  flushTimer;
  inFlightExport;
  flushIntervalMs;
  cachedSessionId;
  cachedTraceId;
  includeSensitiveSpanAttributes;
  maxBufferSize;
  diagnosticsSink;
  lastBufferOverflowWarningMs;
  droppedSpansSinceLastBufferWarning = 0;
  totalDroppedSpans = 0;
  isShutdown = false;
  onEmit(logRecord, emitContext) {
    if (this.isShutdown) {
      return;
    }
    const eventName = logRecord.attributes?.["event.name"];
    if (typeof eventName === "string" && BRIDGE_SKIP_EVENT_NAMES.has(eventName) && isInNativeSubagentSpan()) {
      return;
    }
    const name = deriveSpanName(logRecord);
    const startTime = logRecord.hrTime;
    const attributes = {};
    if (logRecord.attributes) {
      for (const [key, value] of Object.entries(logRecord.attributes)) {
        if (value !== void 0 && value !== null && (this.includeSensitiveSpanAttributes || !SENSITIVE_ATTRIBUTE_KEYS.has(key))) {
          attributes[key] = typeof value === "object" ? safeStringify(value) : value;
        }
      }
    }
    attributes["log.bridge"] = true;
    if (logRecord.severityNumber !== void 0) {
      attributes["log.severity_number"] = logRecord.severityNumber;
    }
    if (logRecord.severityText) {
      attributes["log.severity_text"] = logRecord.severityText;
    }
    let endTime = startTime;
    const durationMs = logRecord.attributes?.["duration_ms"];
    if (typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs > 0) {
      const [secs, nanos] = startTime;
      const durationNanos = durationMs * 1e6;
      const endNanos = nanos + durationNanos;
      endTime = [secs + Math.floor(endNanos / 1e9), endNanos % 1e9];
    }
    const parentSpanContext = getValidParentSpanContext(logRecord.spanContext);
    const explicitSessionId = logRecord.attributes?.["session.id"];
    const sessionId = (typeof explicitSessionId === "string" && explicitSessionId ? explicitSessionId : void 0) ?? (emitContext ? getSessionIdFromContext(emitContext) : void 0) ?? (sessionIdContext.getStore() || getCurrentSessionId());
    if (sessionId) attributes["session.id"] = sessionId;
    let traceId;
    if (parentSpanContext) {
      traceId = parentSpanContext.traceId;
    } else if (sessionId) {
      const sid = String(sessionId);
      if (sid !== this.cachedSessionId) {
        this.cachedSessionId = sid;
        this.cachedTraceId = deriveTraceId(sid);
      }
      traceId = this.cachedTraceId;
    } else {
      traceId = randomHexString(32);
    }
    const spanId = randomSpanId();
    this.buffer.push({
      name,
      kind: SpanKind.INTERNAL,
      spanContext: /* @__PURE__ */ __name(() => ({
        traceId,
        spanId,
        traceFlags: parentSpanContext?.traceFlags ?? TraceFlags.SAMPLED
      }), "spanContext"),
      startTime,
      endTime,
      duration: hrTimeDiff(startTime, endTime),
      attributes,
      status: deriveSpanStatus(logRecord.attributes),
      events: [],
      links: [],
      resource: logRecord.resource ?? (0, import_resources.resourceFromAttributes)({}),
      instrumentationScope: logRecord.instrumentationScope ?? {
        name: SERVICE_NAME,
        version: ""
      },
      ended: true,
      parentSpanContext,
      droppedAttributesCount: 0,
      droppedEventsCount: 0,
      droppedLinksCount: 0,
      recordException: /* @__PURE__ */ __name(() => {
      }, "recordException")
    });
    if (this.buffer.length > this.maxBufferSize) {
      const droppedSpanCount = this.buffer.length - this.maxBufferSize;
      this.buffer.splice(0, droppedSpanCount);
      this.warnBufferOverflow(droppedSpanCount);
    }
  }
  warnBufferOverflow(droppedSpanCount) {
    this.droppedSpansSinceLastBufferWarning += droppedSpanCount;
    this.totalDroppedSpans += droppedSpanCount;
    const now = Date.now();
    if (this.lastBufferOverflowWarningMs !== void 0 && now - this.lastBufferOverflowWarningMs < BUFFER_OVERFLOW_WARNING_INTERVAL_MS) {
      return;
    }
    this.emitBufferOverflowWarning(now);
  }
  emitBufferOverflowWarning(now = Date.now()) {
    if (this.droppedSpansSinceLastBufferWarning === 0) {
      return;
    }
    const droppedSinceLastWarning = this.droppedSpansSinceLastBufferWarning;
    this.droppedSpansSinceLastBufferWarning = 0;
    this.lastBufferOverflowWarningMs = now;
    this.emitDiagnostic(
      `[LogToSpan] buffer exceeded max size (${this.maxBufferSize}); dropped ${droppedSinceLastWarning} oldest span(s) since last warning, ${this.totalDroppedSpans} total`
    );
  }
  /**
   * Route a diagnostic message to the configured sink, swallowing any sink
   * error so a misbehaving sink can never interrupt telemetry ingestion.
   *
   * Tradeoff: when the sink itself is broken (e.g. file-logger failing on
   * EACCES), bridge-specific diagnostics go dark. We accept that — the host
   * surfaces overall logging health via `isDebugLoggingDegraded()`, and
   * falling back to stderr here would re-introduce the TUI-pollution this
   * sink injection was added to prevent.
   */
  emitDiagnostic(message) {
    try {
      this.diagnosticsSink(message);
    } catch {
    }
  }
  flush() {
    if (this.inFlightExport) return this.inFlightExport;
    if (this.buffer.length === 0) return Promise.resolve();
    const spans = this.buffer.splice(0);
    const exportPromise = new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.emitDiagnostic(
          `[LogToSpan] export timeout after ${EXPORT_TIMEOUT_MS}ms (${spans.length} span(s))`
        );
        resolve();
      }, EXPORT_TIMEOUT_MS);
      timeout.unref();
      try {
        this.spanExporter.export(
          spans,
          (result) => {
            clearTimeout(timeout);
            if (result.code !== 0) {
              this.emitDiagnostic(
                `[LogToSpan] export failed: code=${result.code} ${formatExportError(result.error)}`
              );
            }
            resolve();
          }
        );
      } catch (err) {
        clearTimeout(timeout);
        const detail = err instanceof Error ? formatExportError(err) : `error=${JSON.stringify(String(err))}`;
        this.emitDiagnostic(`[LogToSpan] export threw: ${detail}`);
        resolve();
      }
    });
    this.inFlightExport = exportPromise.finally(() => {
      this.inFlightExport = void 0;
    });
    return this.inFlightExport;
  }
  async shutdown() {
    if (this.isShutdown) {
      return;
    }
    this.isShutdown = true;
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = void 0;
    }
    if (this.inFlightExport) {
      await this.inFlightExport;
    }
    await this.flush();
    this.emitBufferOverflowWarning();
    await this.spanExporter.shutdown();
  }
  async forceFlush() {
    if (this.isShutdown) {
      return;
    }
    if (this.inFlightExport) {
      await this.inFlightExport;
    }
    await this.flush();
    await this.spanExporter.forceFlush?.();
  }
};
function normalizeMaxBufferSize(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    return DEFAULT_MAX_BUFFER_SIZE;
  }
  return Math.floor(value);
}
__name(normalizeMaxBufferSize, "normalizeMaxBufferSize");
function deriveSpanName(logRecord) {
  const eventName = logRecord.attributes?.["event.name"] ?? logRecord.eventName;
  if (typeof eventName === "string" && eventName.trim().length > 0) {
    return sanitizeSpanName(eventName);
  }
  return DEFAULT_LOG_SPAN_NAME;
}
__name(deriveSpanName, "deriveSpanName");
function sanitizeSpanName(body) {
  const rawName = String(body ?? "unknown");
  return rawName.length > MAX_SPAN_NAME_LENGTH ? `${rawName.slice(0, MAX_SPAN_NAME_LENGTH)}...` : rawName;
}
__name(sanitizeSpanName, "sanitizeSpanName");
function getValidParentSpanContext(spanContext) {
  if (!spanContext || !isSpanContextValid(spanContext)) {
    return void 0;
  }
  return spanContext;
}
__name(getValidParentSpanContext, "getValidParentSpanContext");
function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
}
__name(safeStringify, "safeStringify");
function deriveSpanStatus(attrs) {
  if (!attrs) return { code: SpanStatusCode.OK };
  if (attrs["event.name"] === EVENT_TOOL_CALL && attrs["status"] === "cancelled") {
    return { code: SpanStatusCode.UNSET };
  }
  if (!!attrs["error"] || !!attrs["error.message"] || !!attrs["error_message"] || !!attrs["error_type"]) {
    return {
      code: SpanStatusCode.ERROR,
      message: LOG_EVENT_ERROR_STATUS_MESSAGE
    };
  }
  return { code: SpanStatusCode.OK };
}
__name(deriveSpanStatus, "deriveSpanStatus");
function formatExportError(err) {
  if (!err) return 'error="unknown"';
  const extra = err;
  const msg = err.message || err.name || "unknown";
  const parts = [`error=${JSON.stringify(msg)}`];
  if (typeof extra.code === "number") parts.push(`httpCode=${extra.code}`);
  if (typeof extra.data === "string" && extra.data.length > 0) {
    parts.push(`data=${JSON.stringify(extra.data.slice(0, 200))}`);
  }
  return parts.join(" ");
}
__name(formatExportError, "formatExportError");
function hrTimeDiff(start, end) {
  let secs = end[0] - start[0];
  let nanos = end[1] - start[1];
  if (nanos < 0) {
    secs -= 1;
    nanos += 1e9;
  }
  return [secs, nanos];
}
__name(hrTimeDiff, "hrTimeDiff");

// packages/core/src/telemetry/sdk-exporters-http.ts
function createHttpExporters(options) {
  const { tracesUrl, logsUrl, metricsUrl } = options;
  let spanExporter;
  let logExporter;
  let metricReader;
  let logToSpanProcessor;
  if (tracesUrl) {
    spanExporter = new import_exporter_trace_otlp_http.OTLPTraceExporter({ url: tracesUrl });
  }
  if (logsUrl) {
    logExporter = new import_exporter_logs_otlp_http.OTLPLogExporter({ url: logsUrl });
  } else if (tracesUrl) {
    logToSpanProcessor = new LogToSpanProcessor(
      new import_exporter_trace_otlp_http.OTLPTraceExporter({ url: tracesUrl }),
      {
        includeSensitiveSpanAttributes: options.logToSpan.includeSensitiveSpanAttributes,
        ...options.logToSpan.diagnosticsSink && {
          diagnosticsSink: options.logToSpan.diagnosticsSink
        }
      }
    );
  }
  if (metricsUrl) {
    metricReader = new import_sdk_metrics.PeriodicExportingMetricReader({
      exporter: new import_exporter_metrics_otlp_http.OTLPMetricExporter({ url: metricsUrl }),
      exportIntervalMillis: 1e4
    });
  }
  return { spanExporter, logExporter, metricReader, logToSpanProcessor };
}
__name(createHttpExporters, "createHttpExporters");
export {
  createHttpExporters
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
