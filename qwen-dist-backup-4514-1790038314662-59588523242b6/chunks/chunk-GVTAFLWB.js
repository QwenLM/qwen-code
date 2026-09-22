// Force strict mode and setup for ESM
"use strict";
import {
  SERVICE_NAME,
  isTelemetrySdkInitialized,
  shouldForceSampled,
  truncateSpanError
} from "./chunk-B3XJFEEH.js";
import {
  require_src
} from "./chunk-74TONY4F.js";
import {
  formatTraceparent,
  getActiveSpanTraceContext,
  setSessionIdOnContext
} from "./chunk-ZYDMQCQP.js";
import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  TraceFlags,
  context,
  defaultTextMapGetter,
  init_esm,
  propagation,
  trace
} from "./chunk-TBWQLLFO.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name,
  __toESM
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/telemetry/daemon-tracing.ts
init_esbuild_shims();
init_esm();
var import_api_logs = __toESM(require_src(), 1);
import { createHash } from "node:crypto";
var DAEMON_TRACEPARENT_META_KEY = "qwen.telemetry.traceparent";
var DAEMON_TRACESTATE_META_KEY = "qwen.telemetry.tracestate";
var SPAN_DAEMON_REQUEST = "qwen-code.daemon.request";
var SPAN_DAEMON_BRIDGE = "qwen-code.daemon.bridge";
var EVENT_DAEMON_ERROR = "qwen-code.daemon.error";
function errorMessage(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}
__name(errorMessage, "errorMessage");
function errorType(error) {
  if (error instanceof Error) return error.name || "Error";
  return typeof error;
}
__name(errorType, "errorType");
function stripReservedTraceMeta(meta) {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return {};
  const record = meta;
  if (!(DAEMON_TRACEPARENT_META_KEY in record) && !(DAEMON_TRACESTATE_META_KEY in record)) {
    return { ...record };
  }
  const out = { ...record };
  delete out[DAEMON_TRACEPARENT_META_KEY];
  delete out[DAEMON_TRACESTATE_META_KEY];
  return out;
}
__name(stripReservedTraceMeta, "stripReservedTraceMeta");
function hashDaemonWorkspace(workspace) {
  return createHash("sha256").update(workspace).digest("hex").slice(0, 16);
}
__name(hashDaemonWorkspace, "hashDaemonWorkspace");
async function withDaemonSpan(name, attributes, fn, options = {}) {
  if (!isTelemetrySdkInitialized()) {
    return await fn(void 0);
  }
  const autoOkOnSuccess = options.autoOkOnSuccess ?? true;
  const tracer = trace.getTracer(SERVICE_NAME);
  const spanOptions = {
    kind: SpanKind.INTERNAL,
    attributes,
    ...options.startTime ? { startTime: options.startTime } : {}
  };
  const run = /* @__PURE__ */ __name(async (span) => {
    const sessionId = attributes["session.id"];
    const scopedContext = setSessionIdOnContext(
      context.active(),
      typeof sessionId === "string" ? sessionId : void 0
    );
    return await context.with(scopedContext, async () => {
      try {
        const result = await fn(span);
        if (autoOkOnSuccess) {
          span.setStatus({ code: SpanStatusCode.OK });
        }
        return result;
      } catch (error) {
        recordDaemonError(span, error);
        throw error;
      } finally {
        span.end();
      }
    });
  }, "run");
  return options.parentContext ? await tracer.startActiveSpan(
    name,
    spanOptions,
    options.parentContext,
    run
  ) : await tracer.startActiveSpan(name, spanOptions, run);
}
__name(withDaemonSpan, "withDaemonSpan");
async function withDaemonRequestSpan(options, fn) {
  return await withDaemonSpan(
    SPAN_DAEMON_REQUEST,
    {
      "http.request.method": options.method,
      "http.route": options.route,
      "qwen-code.daemon.operation": "http_request",
      ...options.workspaceHash ? { "qwen-code.workspace.hash": options.workspaceHash } : {},
      ...options.sessionId ? { "session.id": options.sessionId } : {},
      ...options.clientId ? { "qwen-code.client_id": options.clientId } : {},
      ...options.permissionRequestId ? {
        "qwen-code.daemon.permission.request_id": options.permissionRequestId
      } : {},
      ...options.deferredRuntimeWaitMs !== void 0 ? {
        "qwen-code.daemon.runtime.wait_ms": options.deferredRuntimeWaitMs
      } : {},
      ...options.deferredRuntimePath ? { "qwen-code.daemon.runtime.path": options.deferredRuntimePath } : {}
    },
    fn,
    {
      autoOkOnSuccess: false,
      startTime: options.startTime,
      parentContext: options.parentContext
    }
  );
}
__name(withDaemonRequestSpan, "withDaemonRequestSpan");
async function withDaemonBridgeSpan(operation, attributes, fn) {
  return await withDaemonSpan(
    SPAN_DAEMON_BRIDGE,
    {
      "qwen-code.daemon.operation": operation,
      ...attributes
    },
    async () => await fn()
  );
}
__name(withDaemonBridgeSpan, "withDaemonBridgeSpan");
function recordDaemonHttpResponse(span, statusCode) {
  try {
    span?.setAttribute("http.response.status_code", statusCode);
  } catch {
  }
}
__name(recordDaemonHttpResponse, "recordDaemonHttpResponse");
function addDaemonRequestAttribute(key, value) {
  try {
    trace.getSpan(context.active())?.setAttribute(key, value);
  } catch {
  }
}
__name(addDaemonRequestAttribute, "addDaemonRequestAttribute");
function recordDaemonError(span, error, attributes = {}) {
  const target = span ?? trace.getSpan(context.active());
  if (!target) return;
  try {
    const message = truncateSpanError(errorMessage(error));
    target.recordException(error instanceof Error ? error : new Error(message));
    target.setAttributes({
      "error.type": errorType(error),
      "error.message": message,
      ...attributes
    });
    target.setStatus({ code: SpanStatusCode.ERROR, message });
  } catch {
  }
}
__name(recordDaemonError, "recordDaemonError");
function emitDaemonLog(body, attributes = {}, options) {
  if (!isTelemetrySdkInitialized()) return;
  try {
    import_api_logs.logs.getLogger(SERVICE_NAME).emit({
      body,
      timestamp: /* @__PURE__ */ new Date(),
      attributes: {
        "event.name": options?.eventName ?? EVENT_DAEMON_ERROR,
        ...attributes
      },
      ...options?.severityNumber != null ? { severityNumber: options.severityNumber } : {}
    });
  } catch {
  }
}
__name(emitDaemonLog, "emitDaemonLog");
function captureDaemonTelemetryContext() {
  return { context: context.active() };
}
__name(captureDaemonTelemetryContext, "captureDaemonTelemetryContext");
async function runWithDaemonTelemetryContext(captured, fn) {
  const ctx = captured && typeof captured === "object" && "context" in captured && captured.context ? captured.context : void 0;
  if (!ctx) return await fn();
  return await context.with(ctx, fn);
}
__name(runWithDaemonTelemetryContext, "runWithDaemonTelemetryContext");
function injectDaemonTraceContext(request) {
  const currentMeta = request._meta;
  const nextMeta = stripReservedTraceMeta(currentMeta);
  try {
    const ctx = getActiveSpanTraceContext();
    if (ctx) {
      nextMeta[DAEMON_TRACEPARENT_META_KEY] = formatTraceparent(ctx);
    }
  } catch {
  }
  if (!currentMeta && !nextMeta[DAEMON_TRACEPARENT_META_KEY]) {
    return request;
  }
  return {
    ...request,
    _meta: nextMeta
  };
}
__name(injectDaemonTraceContext, "injectDaemonTraceContext");
var daemonFallbackPropagator;
function setDaemonFallbackPropagator(propagator) {
  daemonFallbackPropagator = propagator;
}
__name(setDaemonFallbackPropagator, "setDaemonFallbackPropagator");
function contextFromTraceparentValues(traceparent, tracestate) {
  const carrier = { traceparent };
  if (typeof tracestate === "string" && tracestate.length > 0) {
    carrier["tracestate"] = tracestate;
  }
  const extracted = propagation.extract(ROOT_CONTEXT, carrier);
  if (trace.getSpanContext(extracted)) return extracted;
  if (!daemonFallbackPropagator) return void 0;
  const fallback = daemonFallbackPropagator.extract(
    ROOT_CONTEXT,
    carrier,
    defaultTextMapGetter
  );
  return trace.getSpanContext(fallback) ? fallback : void 0;
}
__name(contextFromTraceparentValues, "contextFromTraceparentValues");
function forceSampledUnderSampler(extracted) {
  if (!extracted || !shouldForceSampled()) return extracted;
  const spanContext = trace.getSpanContext(extracted);
  if (!spanContext) return extracted;
  return trace.setSpan(
    extracted,
    trace.wrapSpanContext({
      ...spanContext,
      traceFlags: spanContext.traceFlags | TraceFlags.SAMPLED
    })
  );
}
__name(forceSampledUnderSampler, "forceSampledUnderSampler");
function extractDaemonTraceContext(source) {
  const meta = source?._meta;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    return void 0;
  }
  const record = meta;
  const traceparent = record[DAEMON_TRACEPARENT_META_KEY];
  if (typeof traceparent !== "string" || traceparent.length === 0) {
    return void 0;
  }
  return forceSampledUnderSampler(
    contextFromTraceparentValues(
      traceparent,
      record[DAEMON_TRACESTATE_META_KEY]
    )
  );
}
__name(extractDaemonTraceContext, "extractDaemonTraceContext");
function extractDaemonHttpTraceContext(headers) {
  const traceparent = headers?.["traceparent"];
  if (typeof traceparent !== "string" || traceparent.length === 0) {
    return void 0;
  }
  const extracted = contextFromTraceparentValues(
    traceparent,
    headers?.["tracestate"]
  );
  return forceSampledUnderSampler(extracted);
}
__name(extractDaemonHttpTraceContext, "extractDaemonHttpTraceContext");
var TRACEPARENT_RE = /^\s?([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(-.*)?\s?$/;
var ALL_ZERO_TRACE_ID = "0".repeat(32);
var ALL_ZERO_SPAN_ID = "0".repeat(16);
function extractInboundTraceId(headers) {
  const traceparent = headers?.["traceparent"];
  if (typeof traceparent !== "string" || traceparent.length === 0) {
    return void 0;
  }
  const match = TRACEPARENT_RE.exec(traceparent);
  if (!match) return void 0;
  const [, version, traceId, spanId, , trailing] = match;
  if (version === "00" && trailing !== void 0) return void 0;
  if (version === "ff") return void 0;
  if (traceId === ALL_ZERO_TRACE_ID || spanId === ALL_ZERO_SPAN_ID) {
    return void 0;
  }
  return traceId;
}
__name(extractInboundTraceId, "extractInboundTraceId");
function createDaemonBridgeTelemetry() {
  return {
    captureContext: captureDaemonTelemetryContext,
    runWithContext: runWithDaemonTelemetryContext,
    withSpan: withDaemonBridgeSpan,
    setActiveSpanAttributes(attributes) {
      if (!isTelemetrySdkInitialized()) return;
      try {
        trace.getSpan(context.active())?.setAttributes(attributes);
      } catch {
      }
    },
    event(name, attributes) {
      if (!isTelemetrySdkInitialized()) return;
      try {
        const activeSpan = trace.getSpan(context.active());
        if (activeSpan) {
          activeSpan.addEvent(name, attributes);
          return;
        }
        const span = trace.getTracer(SERVICE_NAME).startSpan(SPAN_DAEMON_BRIDGE, {
          kind: SpanKind.INTERNAL,
          attributes: {
            "event.name": name,
            "qwen-code.daemon.operation": `event.${name}`,
            ...attributes
          }
        });
        span.addEvent(name, attributes);
        span.setStatus({ code: SpanStatusCode.OK });
        span.end();
      } catch {
      }
    },
    injectPromptContext: injectDaemonTraceContext
  };
}
__name(createDaemonBridgeTelemetry, "createDaemonBridgeTelemetry");

export {
  DAEMON_TRACEPARENT_META_KEY,
  DAEMON_TRACESTATE_META_KEY,
  hashDaemonWorkspace,
  withDaemonSpan,
  withDaemonRequestSpan,
  recordDaemonHttpResponse,
  addDaemonRequestAttribute,
  recordDaemonError,
  emitDaemonLog,
  captureDaemonTelemetryContext,
  runWithDaemonTelemetryContext,
  setDaemonFallbackPropagator,
  extractDaemonTraceContext,
  extractDaemonHttpTraceContext,
  extractInboundTraceId,
  createDaemonBridgeTelemetry
};
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
