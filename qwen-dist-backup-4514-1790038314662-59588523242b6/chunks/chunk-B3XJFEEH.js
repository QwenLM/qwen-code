// Force strict mode and setup for ESM
"use strict";
import {
  require_src
} from "./chunk-74TONY4F.js";
import {
  createDebugLogger,
  getCurrentSessionId,
  getSessionIdFromContext,
  sessionIdContext,
  setSessionContext,
  setSessionIdOnContext,
  setShellTracePropagation
} from "./chunk-ZYDMQCQP.js";
import {
  getErrorType
} from "./chunk-S34QJ6IR.js";
import {
  DiagLogLevel,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  TraceFlags,
  ValueType,
  context,
  diag,
  init_esm,
  metrics,
  trace
} from "./chunk-TBWQLLFO.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name,
  __toESM
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/telemetry/constants.ts
init_esbuild_shims();
var SERVICE_NAME = "qwen-code";
var EVENT_USER_PROMPT = "qwen-code.user_prompt";
var EVENT_USER_RETRY = "qwen-code.user_retry";
var EVENT_TOOL_CALL = "qwen-code.tool_call";
var EVENT_REPEATED_TOOL_FAILURE_GUARD = "qwen-code.repeated_tool_failure_guard";
var EVENT_API_REQUEST = "qwen-code.api_request";
var EVENT_API_ERROR = "qwen-code.api_error";
var EVENT_API_CANCEL = "qwen-code.api_cancel";
var EVENT_API_RESPONSE = "qwen-code.api_response";
var EVENT_CLI_CONFIG = "qwen-code.config";
var EVENT_SESSION_START = "session.start";
var EVENT_SESSION_END = "session.end";
var EVENT_EXTENSION_DISABLE = "qwen-code.extension_disable";
var EVENT_EXTENSION_ENABLE = "qwen-code.extension_enable";
var EVENT_EXTENSION_INSTALL = "qwen-code.extension_install";
var EVENT_EXTENSION_UNINSTALL = "qwen-code.extension_uninstall";
var EVENT_EXTENSION_UPDATE = "qwen-code.extension_update";
var EVENT_RIPGREP_FALLBACK = "qwen-code.ripgrep_fallback";
var EVENT_RIPGREP_RUNTIME_RECOVERY = "qwen-code.ripgrep_runtime_recovery";
var EVENT_NEXT_SPEAKER_CHECK = "qwen-code.next_speaker_check";
var EVENT_SLASH_COMMAND = "qwen-code.slash_command";
var EVENT_IDE_CONNECTION = "qwen-code.ide_connection";
var EVENT_CHAT_COMPRESSION = "qwen-code.chat_compression";
var EVENT_CONTENT_RETRY = "qwen-code.chat.content_retry";
var EVENT_CONTENT_RETRY_FAILURE = "qwen-code.chat.content_retry_failure";
var EVENT_PROTOCOL_TAG_SANITIZED = "qwen-code.chat.protocol_tag_sanitized";
var EVENT_API_RETRY = "qwen-code.api_retry";
var EVENT_CONVERSATION_FINISHED = "qwen-code.conversation_finished";
var EVENT_FILE_OPERATION = "qwen-code.file_operation";
var EVENT_MODEL_SLASH_COMMAND = "qwen-code.slash_command.model";
var EVENT_SUBAGENT_EXECUTION = "qwen-code.subagent_execution";
var EVENT_GOAL_STATE = "qwen-code.goal_state";
var EVENT_SKILL_LAUNCH = "qwen-code.skill_launch";
var EVENT_AUTH = "qwen-code.auth";
var EVENT_USER_FEEDBACK = "qwen-code.user_feedback";
var EVENT_TOOL_OUTPUT_TRUNCATED = "qwen-code.tool_output_truncated";
var DEFAULT_SENSITIVE_SPAN_ATTRIBUTE_MAX_LENGTH = 1024 * 1024;
var SENSITIVE_SPAN_ATTRIBUTE_MAX_LENGTH_LIMIT = 100 * 1024 * 1024;
function isValidSensitiveSpanAttributeMaxLength(value) {
  return Number.isSafeInteger(value) && value >= 1 && value <= SENSITIVE_SPAN_ATTRIBUTE_MAX_LENGTH_LIMIT;
}
__name(isValidSensitiveSpanAttributeMaxLength, "isValidSensitiveSpanAttributeMaxLength");
var EVENT_PROMPT_SUGGESTION = "qwen-code.prompt_suggestion";
var EVENT_SPECULATION = "qwen-code.speculation";
var EVENT_WORKFLOW_KEYWORD = "qwen-code.workflow_keyword";
var EVENT_WORKFLOW_RUN = "qwen-code.workflow_run";
var EVENT_WORKFLOW_SIZE_WARNING = "qwen-code.workflow_size_warning";
var EVENT_ARENA_SESSION_STARTED = "qwen-code.arena_session_started";
var EVENT_ARENA_AGENT_COMPLETED = "qwen-code.arena_agent_completed";
var EVENT_ARENA_SESSION_ENDED = "qwen-code.arena_session_ended";
var EVENT_MEMORY_EXTRACT = "qwen-code.memory.extract";
var EVENT_MEMORY_DREAM = "qwen-code.memory.dream";
var EVENT_MEMORY_RECALL = "qwen-code.memory.recall";
var EVENT_MEMORY_RECALL_DELIVERY = "qwen-code.memory.recall.delivery";
var SPAN_INTERACTION = "qwen-code.interaction";
var SPAN_LLM_REQUEST = "qwen-code.llm_request";
var SPAN_TOOL = "qwen-code.tool";
var SPAN_TOOL_EXECUTION = "qwen-code.tool.execution";
var SPAN_TOOL_BLOCKED_ON_USER = "qwen-code.tool.blocked_on_user";
var SPAN_HOOK = "qwen-code.hook";
var SPAN_SUBAGENT = "qwen-code.subagent";
var TOOL_FAILURE_KIND_ATTRIBUTE = "tool.failure_kind";
var TOOL_FAILURE_KIND_CANCELLED = "cancelled";
var TOOL_FAILURE_KIND_PRE_HOOK_BLOCKED = "pre_hook_blocked";
var TOOL_FAILURE_KIND_INVOCATION_GUARD_DENIED = "invocation_guard_denied";
var TOOL_FAILURE_KIND_POST_HOOK_STOPPED = "post_hook_stopped";
var TOOL_FAILURE_KIND_TOOL_ERROR = "tool_error";
var TOOL_FAILURE_KIND_TOOL_EXCEPTION = "tool_exception";
var TOOL_FAILURE_KIND_PERMISSION_DENIED = "permission_denied";
var TOOL_FAILURE_KIND_PERMISSION_HOOK_DENIED = "permission_hook_denied";
var TOOL_FAILURE_KIND_PLAN_MODE_BLOCKED = "plan_mode_blocked";
var TOOL_FAILURE_KIND_NON_INTERACTIVE_DENIED = "non_interactive_denied";
var TOOL_FAILURE_KIND_BACKGROUND_AGENT_DENIED = "background_agent_denied";
var TOOL_FAILURE_KIND_TIMEOUT = "timeout";

// packages/core/src/telemetry/metrics.ts
init_esbuild_shims();
init_esm();
var TOOL_CALL_COUNT = `${SERVICE_NAME}.tool.call.count`;
var TOOL_EXECUTION_COUNT = `${SERVICE_NAME}.tool.execution.count`;
var REPEATED_TOOL_FAILURE_GUARD_COUNT = `${SERVICE_NAME}.repeated_tool_failure_guard.count`;
var TOOL_CALL_LATENCY = `${SERVICE_NAME}.tool.call.latency`;
var API_REQUEST_COUNT = `${SERVICE_NAME}.api.request.count`;
var API_REQUEST_LATENCY = `${SERVICE_NAME}.api.request.latency`;
var TOKEN_USAGE = `${SERVICE_NAME}.token.usage`;
var SESSION_COUNT = `${SERVICE_NAME}.session.count`;
var FILE_OPERATION_COUNT = `${SERVICE_NAME}.file.operation.count`;
var INVALID_CHUNK_COUNT = `${SERVICE_NAME}.chat.invalid_chunk.count`;
var CONTENT_RETRY_COUNT = `${SERVICE_NAME}.chat.content_retry.count`;
var CONTENT_RETRY_FAILURE_COUNT = `${SERVICE_NAME}.chat.content_retry_failure.count`;
var API_RETRY_COUNT = `${SERVICE_NAME}.api.retry.count`;
var MODEL_SLASH_COMMAND_CALL_COUNT = `${SERVICE_NAME}.slash_command.model.call_count`;
var SUBAGENT_EXECUTION_COUNT = `${SERVICE_NAME}.subagent.execution.count`;
var GOAL_TRANSITION_COUNT = `${SERVICE_NAME}.goal.transition.count`;
var GOAL_TOKENS_USED = `${SERVICE_NAME}.goal.tokens_used`;
var GOAL_TURN_COUNT = `${SERVICE_NAME}.goal.turn_count`;
function isGoalOutcomeCause(cause) {
  return cause === "complete" || cause === "blocked" || cause === "usage_limited";
}
__name(isGoalOutcomeCause, "isGoalOutcomeCause");
var ARENA_SESSION_COUNT = `${SERVICE_NAME}.arena.session.count`;
var ARENA_SESSION_DURATION = `${SERVICE_NAME}.arena.session.duration`;
var ARENA_AGENT_COUNT = `${SERVICE_NAME}.arena.agent.count`;
var ARENA_AGENT_DURATION = `${SERVICE_NAME}.arena.agent.duration`;
var ARENA_AGENT_TOKENS = `${SERVICE_NAME}.arena.agent.tokens`;
var ARENA_RESULT_SELECTED = `${SERVICE_NAME}.arena.result.selected`;
var STARTUP_TIME = `${SERVICE_NAME}.startup.duration`;
var MEMORY_USAGE = `${SERVICE_NAME}.memory.usage`;
var CPU_USAGE = `${SERVICE_NAME}.cpu.usage`;
var TOOL_QUEUE_DEPTH = `${SERVICE_NAME}.tool.queue.depth`;
var TOOL_EXECUTION_BREAKDOWN = `${SERVICE_NAME}.tool.execution.breakdown`;
var TOKEN_EFFICIENCY = `${SERVICE_NAME}.token.efficiency`;
var API_REQUEST_BREAKDOWN = `${SERVICE_NAME}.api.request.breakdown`;
var PERFORMANCE_SCORE = `${SERVICE_NAME}.performance.score`;
var REGRESSION_DETECTION = `${SERVICE_NAME}.performance.regression`;
var REGRESSION_PERCENTAGE_CHANGE = `${SERVICE_NAME}.performance.regression.percentage_change`;
var BASELINE_COMPARISON = `${SERVICE_NAME}.performance.baseline.comparison`;
var MEMORY_EXTRACT_COUNT = `${SERVICE_NAME}.memory.extract.count`;
var MEMORY_EXTRACT_DURATION = `${SERVICE_NAME}.memory.extract.duration`;
var MEMORY_DREAM_COUNT = `${SERVICE_NAME}.memory.dream.count`;
var MEMORY_DREAM_DURATION = `${SERVICE_NAME}.memory.dream.duration`;
var MEMORY_RECALL_COUNT = `${SERVICE_NAME}.memory.recall.count`;
var MEMORY_RECALL_DURATION = `${SERVICE_NAME}.memory.recall.duration`;
var CHANNEL_MEMORY_RECALL_COUNT = `${SERVICE_NAME}.channel.memory.recall.count`;
var CHANNEL_MEMORY_RECALL_DURATION = `${SERVICE_NAME}.channel.memory.recall.duration`;
var CHANNEL_MEMORY_RECALL_SELECTED_COUNT = `${SERVICE_NAME}.channel.memory.recall.selected_count`;
var MEMORY_RECALL_DELIVERY_COUNT = `${SERVICE_NAME}.memory.recall.delivery.count`;
var MEMORY_RECALL_DELIVERY_LATENCY = `${SERVICE_NAME}.memory.recall.delivery.latency`;
var baseMetricDefinition = {
  // session.id on metrics is opt-in: each session is a new value, so
  // attaching it by default would create unbounded time-series fan-out on
  // every metric backend. Operators who need session-level metric slicing
  // can enable QWEN_TELEMETRY_METRICS_INCLUDE_SESSION_ID or
  // telemetry.metrics.includeSessionId. Spans and logs always carry
  // session.id for trace/log correlation.
  getCommonAttributes: /* @__PURE__ */ __name((config) => {
    const out = {};
    if (config.getTelemetryMetricsIncludeSessionId()) {
      out["session.id"] = config.getSessionId();
    }
    return out;
  }, "getCommonAttributes")
};
var COUNTER_DEFINITIONS = {
  [TOOL_CALL_COUNT]: {
    description: "Counts tool calls, tagged by function name and terminal status.",
    valueType: ValueType.INT,
    assign: /* @__PURE__ */ __name((c) => toolCallCounter = c, "assign"),
    attributes: {}
  },
  [TOOL_EXECUTION_COUNT]: {
    description: "Counts tool execution outcomes.",
    valueType: ValueType.INT,
    assign: /* @__PURE__ */ __name((c) => toolExecutionCounter = c, "assign"),
    attributes: {}
  },
  [REPEATED_TOOL_FAILURE_GUARD_COUNT]: {
    description: "Counts privacy-safe repeated tool execution failure guard transitions.",
    valueType: ValueType.INT,
    assign: /* @__PURE__ */ __name((c) => repeatedToolFailureGuardCounter = c, "assign"),
    attributes: {}
  },
  [API_REQUEST_COUNT]: {
    description: "Counts API requests, tagged by model and status.",
    valueType: ValueType.INT,
    assign: /* @__PURE__ */ __name((c) => apiRequestCounter = c, "assign"),
    attributes: {}
  },
  [TOKEN_USAGE]: {
    description: "Counts the total number of tokens used.",
    valueType: ValueType.INT,
    assign: /* @__PURE__ */ __name((c) => tokenUsageCounter = c, "assign"),
    attributes: {}
  },
  [SESSION_COUNT]: {
    description: "Count of CLI sessions started.",
    valueType: ValueType.INT,
    assign: /* @__PURE__ */ __name((c) => sessionCounter = c, "assign"),
    attributes: {}
  },
  [FILE_OPERATION_COUNT]: {
    description: "Counts file operations (create, read, update).",
    valueType: ValueType.INT,
    assign: /* @__PURE__ */ __name((c) => fileOperationCounter = c, "assign"),
    attributes: {}
  },
  [INVALID_CHUNK_COUNT]: {
    description: "Counts invalid chunks received from a stream.",
    valueType: ValueType.INT,
    assign: /* @__PURE__ */ __name((c) => invalidChunkCounter = c, "assign"),
    attributes: {}
  },
  [CONTENT_RETRY_COUNT]: {
    description: "Counts retries due to content errors (e.g., empty stream).",
    valueType: ValueType.INT,
    assign: /* @__PURE__ */ __name((c) => contentRetryCounter = c, "assign"),
    attributes: {}
  },
  [CONTENT_RETRY_FAILURE_COUNT]: {
    description: "Counts occurrences of all content retries failing.",
    valueType: ValueType.INT,
    assign: /* @__PURE__ */ __name((c) => contentRetryFailureCounter = c, "assign"),
    attributes: {}
  },
  [API_RETRY_COUNT]: {
    description: "Counts HTTP-status retries (429/5xx) at LLM call sites, emitted by retryWithBackoff onRetry callback.",
    valueType: ValueType.INT,
    assign: /* @__PURE__ */ __name((c) => apiRetryCounter = c, "assign"),
    attributes: {}
  },
  [MODEL_SLASH_COMMAND_CALL_COUNT]: {
    description: "Counts model slash command calls.",
    valueType: ValueType.INT,
    assign: /* @__PURE__ */ __name((c) => modelSlashCommandCallCounter = c, "assign"),
    attributes: {}
  },
  [EVENT_CHAT_COMPRESSION]: {
    description: "Counts chat compression events.",
    valueType: ValueType.INT,
    assign: /* @__PURE__ */ __name((c) => chatCompressionCounter = c, "assign"),
    attributes: {}
  },
  [GOAL_TRANSITION_COUNT]: {
    description: "Counts Goal state transitions, tagged by cause, resulting status, and limit kind.",
    valueType: ValueType.INT,
    assign: /* @__PURE__ */ __name((c) => goalTransitionCounter = c, "assign"),
    attributes: {}
  }
};
var HISTOGRAM_DEFINITIONS = {
  [TOOL_CALL_LATENCY]: {
    description: "Latency of tool calls in milliseconds.",
    unit: "ms",
    valueType: ValueType.INT,
    assign: /* @__PURE__ */ __name((h) => toolCallLatencyHistogram = h, "assign"),
    attributes: {}
  },
  [API_REQUEST_LATENCY]: {
    description: "Latency of API requests in milliseconds.",
    unit: "ms",
    valueType: ValueType.INT,
    assign: /* @__PURE__ */ __name((h) => apiRequestLatencyHistogram = h, "assign"),
    attributes: {}
  },
  [GOAL_TOKENS_USED]: {
    description: "Tokens a Goal had spent when it completed, was blocked, or reached a usage limit.",
    unit: "{token}",
    valueType: ValueType.INT,
    advice: {
      explicitBucketBoundaries: [
        1e3,
        1e4,
        1e5,
        5e5,
        1e6,
        5e6,
        1e7,
        3e7,
        1e8,
        3e8,
        6e8
      ]
    },
    assign: /* @__PURE__ */ __name((h) => goalTokensUsedHistogram = h, "assign"),
    attributes: {}
  },
  [GOAL_TURN_COUNT]: {
    description: "Turns a Goal had finished when it completed, was blocked, or reached a usage limit.",
    unit: "{turn}",
    valueType: ValueType.INT,
    advice: {
      explicitBucketBoundaries: [
        1,
        5,
        10,
        25,
        50,
        100,
        250,
        500,
        1e3,
        5e3,
        1e4,
        25e3,
        5e4
      ]
    },
    assign: /* @__PURE__ */ __name((h) => goalTurnCountHistogram = h, "assign"),
    attributes: {}
  }
};
var PERFORMANCE_COUNTER_DEFINITIONS = {
  [REGRESSION_DETECTION]: {
    description: "Performance regression detection events.",
    valueType: ValueType.INT,
    assign: /* @__PURE__ */ __name((c) => regressionDetectionCounter = c, "assign"),
    attributes: {}
  }
};
var PERFORMANCE_HISTOGRAM_DEFINITIONS = {
  [STARTUP_TIME]: {
    description: "CLI startup time in milliseconds, broken down by initialization phase.",
    unit: "ms",
    valueType: ValueType.DOUBLE,
    assign: /* @__PURE__ */ __name((h) => startupTimeHistogram = h, "assign"),
    attributes: {}
  },
  [MEMORY_USAGE]: {
    description: "Memory usage in bytes.",
    unit: "bytes",
    valueType: ValueType.INT,
    assign: /* @__PURE__ */ __name((h) => memoryUsageGauge = h, "assign"),
    attributes: {}
  },
  [CPU_USAGE]: {
    description: "CPU usage percentage.",
    unit: "percent",
    valueType: ValueType.DOUBLE,
    assign: /* @__PURE__ */ __name((h) => cpuUsageGauge = h, "assign"),
    attributes: {}
  },
  [TOOL_QUEUE_DEPTH]: {
    description: "Number of tools in execution queue.",
    unit: "count",
    valueType: ValueType.INT,
    assign: /* @__PURE__ */ __name((h) => toolQueueDepthGauge = h, "assign"),
    attributes: {}
  },
  [TOOL_EXECUTION_BREAKDOWN]: {
    description: "Tool execution time breakdown by phase in milliseconds.",
    unit: "ms",
    valueType: ValueType.INT,
    assign: /* @__PURE__ */ __name((h) => toolExecutionBreakdownHistogram = h, "assign"),
    attributes: {}
  },
  [TOKEN_EFFICIENCY]: {
    description: "Token efficiency metrics (tokens per operation, cache hit rate, etc.).",
    unit: "ratio",
    valueType: ValueType.DOUBLE,
    assign: /* @__PURE__ */ __name((h) => tokenEfficiencyHistogram = h, "assign"),
    attributes: {}
  },
  [API_REQUEST_BREAKDOWN]: {
    description: "API request time breakdown by phase in milliseconds.",
    unit: "ms",
    valueType: ValueType.INT,
    assign: /* @__PURE__ */ __name((h) => apiRequestBreakdownHistogram = h, "assign"),
    attributes: {}
  },
  [PERFORMANCE_SCORE]: {
    description: "Composite performance score (0-100).",
    unit: "score",
    valueType: ValueType.DOUBLE,
    assign: /* @__PURE__ */ __name((h) => performanceScoreGauge = h, "assign"),
    attributes: {}
  },
  [REGRESSION_PERCENTAGE_CHANGE]: {
    description: "Percentage change compared to baseline for detected regressions.",
    unit: "percent",
    valueType: ValueType.DOUBLE,
    assign: /* @__PURE__ */ __name((h) => regressionPercentageChangeHistogram = h, "assign"),
    attributes: {}
  },
  [BASELINE_COMPARISON]: {
    description: "Performance comparison to established baseline (percentage change).",
    unit: "percent",
    valueType: ValueType.DOUBLE,
    assign: /* @__PURE__ */ __name((h) => baselineComparisonHistogram = h, "assign"),
    attributes: {}
  }
};
var cliMeter;
var toolCallCounter;
var toolExecutionCounter;
var repeatedToolFailureGuardCounter;
var toolCallLatencyHistogram;
var apiRequestCounter;
var apiRequestLatencyHistogram;
var tokenUsageCounter;
var sessionCounter;
var fileOperationCounter;
var chatCompressionCounter;
var invalidChunkCounter;
var contentRetryCounter;
var contentRetryFailureCounter;
var apiRetryCounter;
var subagentExecutionCounter;
var goalTransitionCounter;
var goalTokensUsedHistogram;
var goalTurnCountHistogram;
var modelSlashCommandCallCounter;
var startupTimeHistogram;
var memoryUsageGauge;
var cpuUsageGauge;
var toolQueueDepthGauge;
var toolExecutionBreakdownHistogram;
var tokenEfficiencyHistogram;
var apiRequestBreakdownHistogram;
var performanceScoreGauge;
var regressionDetectionCounter;
var regressionPercentageChangeHistogram;
var baselineComparisonHistogram;
var arenaSessionCounter;
var arenaSessionDurationHistogram;
var arenaAgentCounter;
var arenaAgentDurationHistogram;
var arenaAgentTokensCounter;
var arenaResultSelectedCounter;
var memoryExtractCounter;
var memoryExtractDurationHistogram;
var memoryDreamCounter;
var memoryDreamDurationHistogram;
var memoryRecallCounter;
var memoryRecallDurationHistogram;
var channelMemoryRecallCounter;
var channelMemoryRecallDurationHistogram;
var channelMemoryRecallSelectedCountHistogram;
var memoryRecallDeliveryCounter;
var memoryRecallDeliveryLatencyHistogram;
var isMetricsInitialized = false;
var isPerformanceMonitoringEnabled = false;
function getMeter() {
  if (!cliMeter) {
    cliMeter = metrics.getMeter(SERVICE_NAME);
  }
  return cliMeter;
}
__name(getMeter, "getMeter");
function initializeMetrics(config) {
  if (isMetricsInitialized) return;
  const meter = getMeter();
  if (!meter) return;
  Object.entries(COUNTER_DEFINITIONS).forEach(
    ([name, { description, valueType, assign }]) => {
      assign(meter.createCounter(name, { description, valueType }));
    }
  );
  subagentExecutionCounter = meter.createCounter(SUBAGENT_EXECUTION_COUNT, {
    description: "Counts subagent execution events, tagged by status and subagent name.",
    valueType: ValueType.INT
  });
  arenaSessionCounter = meter.createCounter(ARENA_SESSION_COUNT, {
    description: "Counts arena sessions by status and display backend.",
    valueType: ValueType.INT
  });
  arenaSessionDurationHistogram = meter.createHistogram(
    ARENA_SESSION_DURATION,
    {
      description: "Duration of arena sessions in milliseconds.",
      unit: "ms",
      valueType: ValueType.INT
    }
  );
  arenaAgentCounter = meter.createCounter(ARENA_AGENT_COUNT, {
    description: "Counts arena agent completions by status and model.",
    valueType: ValueType.INT
  });
  arenaAgentDurationHistogram = meter.createHistogram(ARENA_AGENT_DURATION, {
    description: "Duration of arena agent execution in milliseconds.",
    unit: "ms",
    valueType: ValueType.INT
  });
  arenaAgentTokensCounter = meter.createCounter(ARENA_AGENT_TOKENS, {
    description: "Token usage by arena agents.",
    valueType: ValueType.INT
  });
  arenaResultSelectedCounter = meter.createCounter(ARENA_RESULT_SELECTED, {
    description: "Counts arena result selections by model.",
    valueType: ValueType.INT
  });
  Object.entries(HISTOGRAM_DEFINITIONS).forEach(([name, definition]) => {
    const { description, unit, valueType, assign } = definition;
    assign(
      meter.createHistogram(name, {
        description,
        unit,
        valueType,
        ..."advice" in definition ? { advice: definition.advice } : {}
      })
    );
  });
  sessionCounter?.add(1, baseMetricDefinition.getCommonAttributes(config));
  memoryExtractCounter = meter.createCounter(MEMORY_EXTRACT_COUNT, {
    description: "Counts auto-memory extraction runs, tagged by trigger and status.",
    valueType: ValueType.INT
  });
  memoryExtractDurationHistogram = meter.createHistogram(
    MEMORY_EXTRACT_DURATION,
    {
      description: "Duration of auto-memory extraction in milliseconds.",
      unit: "ms",
      valueType: ValueType.INT
    }
  );
  memoryDreamCounter = meter.createCounter(MEMORY_DREAM_COUNT, {
    description: "Counts auto-memory dream (consolidation) runs, tagged by trigger and status.",
    valueType: ValueType.INT
  });
  memoryDreamDurationHistogram = meter.createHistogram(MEMORY_DREAM_DURATION, {
    description: "Duration of auto-memory dream runs in milliseconds.",
    unit: "ms",
    valueType: ValueType.INT
  });
  memoryRecallCounter = meter.createCounter(MEMORY_RECALL_COUNT, {
    description: "Counts auto-memory recall operations, tagged by strategy.",
    valueType: ValueType.INT
  });
  memoryRecallDurationHistogram = meter.createHistogram(
    MEMORY_RECALL_DURATION,
    {
      description: "Duration of auto-memory recall operations in milliseconds.",
      unit: "ms",
      valueType: ValueType.INT
    }
  );
  channelMemoryRecallCounter = meter.createCounter(
    CHANNEL_MEMORY_RECALL_COUNT,
    {
      description: "Counts channel memory recall attempts by cache path and bounded result.",
      valueType: ValueType.INT
    }
  );
  channelMemoryRecallDurationHistogram = meter.createHistogram(
    CHANNEL_MEMORY_RECALL_DURATION,
    {
      description: "Duration of channel memory recall attempts.",
      unit: "ms",
      valueType: ValueType.DOUBLE,
      advice: {
        explicitBucketBoundaries: [0.1, 0.5, 1, 2, 5, 10, 25, 50, 100, 250]
      }
    }
  );
  channelMemoryRecallSelectedCountHistogram = meter.createHistogram(
    CHANNEL_MEMORY_RECALL_SELECTED_COUNT,
    {
      description: "Number of channel memory entries selected per attempt.",
      valueType: ValueType.INT
    }
  );
  memoryRecallDeliveryCounter = meter.createCounter(
    MEMORY_RECALL_DELIVERY_COUNT,
    {
      description: "Counts auto-memory recall delivery outcomes, tagged by phase and delivery point.",
      valueType: ValueType.INT
    }
  );
  memoryRecallDeliveryLatencyHistogram = meter.createHistogram(
    MEMORY_RECALL_DELIVERY_LATENCY,
    {
      description: "Latency from auto-memory recall prefetch start to delivery or discard.",
      unit: "ms",
      valueType: ValueType.INT
    }
  );
  initializePerformanceMonitoring(config);
  isMetricsInitialized = true;
}
__name(initializeMetrics, "initializeMetrics");
function recordGoalStateMetrics(config, event) {
  if (!goalTransitionCounter || !isMetricsInitialized) return;
  const common = baseMetricDefinition.getCommonAttributes(config);
  const limitKind = event.limit_kind ? { limit_kind: event.limit_kind } : {};
  goalTransitionCounter.add(1, {
    ...common,
    cause: event.cause,
    ...event.status ? { status: event.status } : {},
    ...limitKind
  });
  if (!isGoalOutcomeCause(event.cause)) return;
  const outcome = { ...common, cause: event.cause, ...limitKind };
  if (event.tokens_used !== void 0) {
    goalTokensUsedHistogram?.record(event.tokens_used, outcome);
  }
  if (event.turn_count !== void 0) {
    goalTurnCountHistogram?.record(event.turn_count, outcome);
  }
}
__name(recordGoalStateMetrics, "recordGoalStateMetrics");
function recordChatCompressionMetrics(config, attributes) {
  if (!chatCompressionCounter || !isMetricsInitialized) return;
  chatCompressionCounter.add(1, {
    ...baseMetricDefinition.getCommonAttributes(config),
    ...attributes
  });
}
__name(recordChatCompressionMetrics, "recordChatCompressionMetrics");
function recordToolCallMetrics(config, durationMs, attributes) {
  if (!toolCallCounter || !toolCallLatencyHistogram || !isMetricsInitialized)
    return;
  const metricAttributes = {
    ...baseMetricDefinition.getCommonAttributes(config),
    ...attributes,
    status: attributes.status ?? (attributes.success ? "success" : "error")
  };
  toolCallCounter.add(1, metricAttributes);
  toolCallLatencyHistogram.record(durationMs, {
    ...baseMetricDefinition.getCommonAttributes(config),
    function_name: attributes.function_name
  });
}
__name(recordToolCallMetrics, "recordToolCallMetrics");
function recordToolExecutionMetrics(config, attributes) {
  if (!toolExecutionCounter || !isMetricsInitialized) return;
  toolExecutionCounter.add(1, {
    ...baseMetricDefinition.getCommonAttributes(config),
    ...attributes
  });
}
__name(recordToolExecutionMetrics, "recordToolExecutionMetrics");
function recordRepeatedToolFailureGuardMetrics(attributes) {
  if (!repeatedToolFailureGuardCounter || !isMetricsInitialized) return;
  repeatedToolFailureGuardCounter.add(1, attributes);
}
__name(recordRepeatedToolFailureGuardMetrics, "recordRepeatedToolFailureGuardMetrics");
function recordTokenUsageMetrics(config, tokenCount, attributes) {
  if (!tokenUsageCounter || !isMetricsInitialized) return;
  tokenUsageCounter.add(tokenCount, {
    ...baseMetricDefinition.getCommonAttributes(config),
    ...attributes
  });
}
__name(recordTokenUsageMetrics, "recordTokenUsageMetrics");
function recordApiResponseMetrics(config, durationMs, attributes) {
  if (!apiRequestCounter || !apiRequestLatencyHistogram || !isMetricsInitialized)
    return;
  const metricAttributes = {
    ...baseMetricDefinition.getCommonAttributes(config),
    model: attributes.model,
    status_code: attributes.status_code ?? "ok"
  };
  apiRequestCounter.add(1, metricAttributes);
  apiRequestLatencyHistogram.record(durationMs, {
    ...baseMetricDefinition.getCommonAttributes(config),
    model: attributes.model
  });
}
__name(recordApiResponseMetrics, "recordApiResponseMetrics");
function recordApiErrorMetrics(config, durationMs, attributes) {
  if (!apiRequestCounter || !apiRequestLatencyHistogram || !isMetricsInitialized)
    return;
  const metricAttributes = {
    ...baseMetricDefinition.getCommonAttributes(config),
    model: attributes.model,
    status_code: attributes.status_code ?? "error",
    error_type: attributes.error_type ?? "unknown"
  };
  apiRequestCounter.add(1, metricAttributes);
  apiRequestLatencyHistogram.record(durationMs, {
    ...baseMetricDefinition.getCommonAttributes(config),
    model: attributes.model
  });
}
__name(recordApiErrorMetrics, "recordApiErrorMetrics");
function recordFileOperationMetric(config, attributes) {
  if (!fileOperationCounter || !isMetricsInitialized) return;
  fileOperationCounter.add(1, {
    ...baseMetricDefinition.getCommonAttributes(config),
    ...attributes
  });
}
__name(recordFileOperationMetric, "recordFileOperationMetric");
function recordContentRetry(config) {
  if (!contentRetryCounter || !isMetricsInitialized) return;
  contentRetryCounter.add(1, baseMetricDefinition.getCommonAttributes(config));
}
__name(recordContentRetry, "recordContentRetry");
function recordContentRetryFailure(config) {
  if (!contentRetryFailureCounter || !isMetricsInitialized) return;
  contentRetryFailureCounter.add(
    1,
    baseMetricDefinition.getCommonAttributes(config)
  );
}
__name(recordContentRetryFailure, "recordContentRetryFailure");
function recordApiRetry(config, attributes) {
  if (!apiRetryCounter || !isMetricsInitialized) return;
  apiRetryCounter.add(1, {
    ...baseMetricDefinition.getCommonAttributes(config),
    ...attributes
  });
}
__name(recordApiRetry, "recordApiRetry");
function recordModelSlashCommand(config, event) {
  if (!modelSlashCommandCallCounter || !isMetricsInitialized) return;
  modelSlashCommandCallCounter.add(1, {
    ...baseMetricDefinition.getCommonAttributes(config),
    "slash_command.model.model_name": event.model_name
  });
}
__name(recordModelSlashCommand, "recordModelSlashCommand");
function initializePerformanceMonitoring(config) {
  const meter = getMeter();
  if (!meter) return;
  isPerformanceMonitoringEnabled = config.getTelemetryEnabled();
  if (!isPerformanceMonitoringEnabled) return;
  Object.entries(PERFORMANCE_COUNTER_DEFINITIONS).forEach(
    ([name, { description, valueType, assign }]) => {
      assign(meter.createCounter(name, { description, valueType }));
    }
  );
  Object.entries(PERFORMANCE_HISTOGRAM_DEFINITIONS).forEach(
    ([name, { description, unit, valueType, assign }]) => {
      assign(meter.createHistogram(name, { description, unit, valueType }));
    }
  );
}
__name(initializePerformanceMonitoring, "initializePerformanceMonitoring");
function recordMemoryUsage(config, bytes, attributes) {
  if (!memoryUsageGauge || !isPerformanceMonitoringEnabled) return;
  const metricAttributes = {
    ...baseMetricDefinition.getCommonAttributes(config),
    ...attributes
  };
  memoryUsageGauge.record(bytes, metricAttributes);
}
__name(recordMemoryUsage, "recordMemoryUsage");
function recordCpuUsage(config, percentage, attributes) {
  if (!cpuUsageGauge || !isPerformanceMonitoringEnabled) return;
  const metricAttributes = {
    ...baseMetricDefinition.getCommonAttributes(config),
    ...attributes
  };
  cpuUsageGauge.record(percentage, metricAttributes);
}
__name(recordCpuUsage, "recordCpuUsage");
function recordApiRequestBreakdown(config, durationMs, attributes) {
  if (!apiRequestBreakdownHistogram || !isPerformanceMonitoringEnabled) return;
  const metricAttributes = {
    ...baseMetricDefinition.getCommonAttributes(config),
    ...attributes
  };
  apiRequestBreakdownHistogram.record(durationMs, metricAttributes);
}
__name(recordApiRequestBreakdown, "recordApiRequestBreakdown");
function isPerformanceMonitoringActive() {
  return isPerformanceMonitoringEnabled && isMetricsInitialized;
}
__name(isPerformanceMonitoringActive, "isPerformanceMonitoringActive");
function recordSubagentExecutionMetrics(config, subagentName, status, terminateReason) {
  if (!subagentExecutionCounter || !isMetricsInitialized) return;
  const attributes = {
    ...baseMetricDefinition.getCommonAttributes(config),
    subagent_name: subagentName,
    status
  };
  if (terminateReason) {
    attributes["terminate_reason"] = terminateReason;
  }
  subagentExecutionCounter.add(1, attributes);
}
__name(recordSubagentExecutionMetrics, "recordSubagentExecutionMetrics");
function recordArenaSessionStartedMetrics(config) {
  if (!isMetricsInitialized) return;
  arenaSessionCounter?.add(1, {
    ...baseMetricDefinition.getCommonAttributes(config),
    status: "started"
  });
}
__name(recordArenaSessionStartedMetrics, "recordArenaSessionStartedMetrics");
function recordArenaAgentCompletedMetrics(config, modelId, status, durationMs, inputTokens, outputTokens) {
  if (!isMetricsInitialized) return;
  const common = baseMetricDefinition.getCommonAttributes(config);
  arenaAgentCounter?.add(1, {
    ...common,
    status,
    model_id: modelId
  });
  arenaAgentDurationHistogram?.record(durationMs, {
    ...common,
    model_id: modelId
  });
  if (inputTokens > 0) {
    arenaAgentTokensCounter?.add(inputTokens, {
      ...common,
      model_id: modelId,
      type: "input"
    });
  }
  if (outputTokens > 0) {
    arenaAgentTokensCounter?.add(outputTokens, {
      ...common,
      model_id: modelId,
      type: "output"
    });
  }
}
__name(recordArenaAgentCompletedMetrics, "recordArenaAgentCompletedMetrics");
function recordArenaSessionEndedMetrics(config, status, displayBackend, durationMs, winnerModelId) {
  if (!isMetricsInitialized) return;
  const common = baseMetricDefinition.getCommonAttributes(config);
  arenaSessionCounter?.add(1, {
    ...common,
    status,
    ...displayBackend ? { display_backend: displayBackend } : {}
  });
  if (durationMs !== void 0 && arenaSessionDurationHistogram) {
    arenaSessionDurationHistogram.record(durationMs, {
      ...common,
      status
    });
  }
  if (winnerModelId) {
    arenaResultSelectedCounter?.add(1, {
      ...common,
      model_id: winnerModelId
    });
  }
}
__name(recordArenaSessionEndedMetrics, "recordArenaSessionEndedMetrics");
function recordMemoryExtractMetrics(config, durationMs, attrs) {
  if (!isMetricsInitialized) return;
  const common = baseMetricDefinition.getCommonAttributes(config);
  memoryExtractCounter?.add(1, {
    ...common,
    trigger: attrs.trigger,
    status: attrs.status
  });
  memoryExtractDurationHistogram?.record(durationMs, {
    ...common,
    trigger: attrs.trigger,
    status: attrs.status
  });
}
__name(recordMemoryExtractMetrics, "recordMemoryExtractMetrics");
function recordMemoryDreamMetrics(config, durationMs, attrs) {
  if (!isMetricsInitialized) return;
  const common = baseMetricDefinition.getCommonAttributes(config);
  memoryDreamCounter?.add(1, {
    ...common,
    trigger: attrs.trigger,
    status: attrs.status
  });
  memoryDreamDurationHistogram?.record(durationMs, {
    ...common,
    trigger: attrs.trigger,
    status: attrs.status
  });
}
__name(recordMemoryDreamMetrics, "recordMemoryDreamMetrics");
function recordMemoryRecallMetrics(config, durationMs, attrs) {
  if (!isMetricsInitialized) return;
  const common = baseMetricDefinition.getCommonAttributes(config);
  memoryRecallCounter?.add(1, { ...common, strategy: attrs.strategy });
  memoryRecallDurationHistogram?.record(durationMs, {
    ...common,
    strategy: attrs.strategy
  });
}
__name(recordMemoryRecallMetrics, "recordMemoryRecallMetrics");
function recordChannelMemoryRecallMetrics(observation) {
  if (!isMetricsInitialized) return;
  const attributes = {
    cache: observation.cache,
    result: observation.result
  };
  channelMemoryRecallCounter?.add(1, attributes);
  channelMemoryRecallDurationHistogram?.record(
    observation.durationMs,
    attributes
  );
  channelMemoryRecallSelectedCountHistogram?.record(
    observation.selectedCount,
    attributes
  );
}
__name(recordChannelMemoryRecallMetrics, "recordChannelMemoryRecallMetrics");
function recordMemoryRecallDeliveryMetrics(config, latencyMs, attrs) {
  if (!isMetricsInitialized) return;
  const common = baseMetricDefinition.getCommonAttributes(config);
  const metricAttributes = {
    ...common,
    phase: attrs.phase,
    delivery_point: attrs.delivery_point,
    strategy: attrs.strategy,
    ...attrs.discard_reason ? { discard_reason: attrs.discard_reason } : {}
  };
  memoryRecallDeliveryCounter?.add(1, metricAttributes);
  memoryRecallDeliveryLatencyHistogram?.record(latencyMs, metricAttributes);
}
__name(recordMemoryRecallDeliveryMetrics, "recordMemoryRecallDeliveryMetrics");

// packages/core/src/utils/textUtils.ts
init_esbuild_shims();
import { stripVTControlCharacters } from "node:util";
var CONTROL_CHARS_RE = /[\u0000-\u001f\u007f-\u009f]/g;
function stripAnsiAndControl(text) {
  return stripVTControlCharacters(text).replace(CONTROL_CHARS_RE, "");
}
__name(stripAnsiAndControl, "stripAnsiAndControl");
function safeLiteralReplace(str, oldString, newString) {
  if (oldString === "" || !str.includes(oldString)) {
    return str;
  }
  if (!newString.includes("$")) {
    return str.replaceAll(oldString, newString);
  }
  const escapedNewString = newString.replaceAll("$", "$$$$");
  return str.replaceAll(oldString, escapedNewString);
}
__name(safeLiteralReplace, "safeLiteralReplace");
function isBinary(data, sampleSize = 512) {
  if (!data) {
    return false;
  }
  const sample = data.length > sampleSize ? data.subarray(0, sampleSize) : data;
  for (const byte of sample) {
    if (byte === 0) {
      return true;
    }
  }
  return false;
}
__name(isBinary, "isBinary");
function normalizeContent(content) {
  let normalized = content.replace(/^\uFEFF/, "");
  normalized = normalized.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return normalized;
}
__name(normalizeContent, "normalizeContent");
function stripHtmlComments(content) {
  let result = content;
  let prev;
  do {
    prev = result;
    result = prev.replace(/<!--[\s\S]*?-->/g, "");
  } while (result !== prev);
  return result.replace(/<!--/g, "");
}
__name(stripHtmlComments, "stripHtmlComments");

// packages/core/src/extension/redaction.ts
init_esbuild_shims();
var REDACTED_URL_CREDENTIAL = "***REDACTED***";
var URL_CREDENTIALS_PATTERN = /\b([a-z][a-z0-9+.-]*:\/\/)(?:[^/\s]+@)+/gi;
var UPLOAD_IDENTITY_PATTERN = /\bupload:v1:[0-9a-fA-F-]+:/gu;
function redactUrlCredentials(source) {
  return source.replace(UPLOAD_IDENTITY_PATTERN, "upload:").replace(URL_CREDENTIALS_PATTERN, `$1${REDACTED_URL_CREDENTIAL}@`);
}
__name(redactUrlCredentials, "redactUrlCredentials");

// packages/core/src/telemetry/context-usage.ts
init_esbuild_shims();
var CONTEXT_USAGE_ATTRIBUTE = "qwen-code.context.usage";
var MAX_CONTEXT_USAGE_ATTRIBUTE_LENGTH = 1024;
var MAX_SERIALIZED_NON_NEGATIVE_NUMBER = 10000000000000002e-22;
var contextUsageAttributeLengthLimit = MAX_CONTEXT_USAGE_ATTRIBUTE_LENGTH;
var FIXED_CATEGORY_KEYS = [
  "system_prompt_tokens",
  "builtin_tools_tokens",
  "mcp_tools_tokens",
  "memory_files_tokens",
  "skills_tokens"
];
var CATEGORY_KEYS = [...FIXED_CATEGORY_KEYS, "messages_tokens"];
function configureContextUsageAttributeLengthLimit(otelSpanAttributeValueLengthLimit) {
  contextUsageAttributeLengthLimit = otelSpanAttributeValueLengthLimit !== void 0 && otelSpanAttributeValueLengthLimit > 0 ? Math.min(
    MAX_CONTEXT_USAGE_ATTRIBUTE_LENGTH,
    otelSpanAttributeValueLengthLimit
  ) : MAX_CONTEXT_USAGE_ATTRIBUTE_LENGTH;
}
__name(configureContextUsageAttributeLengthLimit, "configureContextUsageAttributeLengthLimit");
function isRecord(value) {
  return typeof value === "object" && value !== null;
}
__name(isRecord, "isRecord");
function isNonNegativeFinite(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
__name(isNonNegativeFinite, "isNonNegativeFinite");
function cloneContextUsage(value) {
  try {
    if (!isRecord(value)) return void 0;
    const breakdown = value["breakdown"];
    if (!isRecord(breakdown)) return void 0;
    const windowSizeTokens = value["window_size_tokens"];
    const compactionReserveTokens = value["compaction_reserve_tokens"];
    const availableBeforeCompactionTokens = value["available_before_compaction_tokens"];
    const categoryTokens = Object.fromEntries(
      CATEGORY_KEYS.map((key) => [key, breakdown[key]])
    );
    const valid = value["version"] === 1 && value["estimated"] === true && Number.isSafeInteger(windowSizeTokens) && windowSizeTokens > 0 && isNonNegativeFinite(compactionReserveTokens) && (availableBeforeCompactionTokens === void 0 || isNonNegativeFinite(availableBeforeCompactionTokens)) && CATEGORY_KEYS.every(
      (key) => Number.isSafeInteger(categoryTokens[key]) && categoryTokens[key] >= 0
    );
    if (!valid) return void 0;
    return {
      version: 1,
      window_size_tokens: windowSizeTokens,
      breakdown: {
        system_prompt_tokens: categoryTokens.system_prompt_tokens,
        builtin_tools_tokens: categoryTokens.builtin_tools_tokens,
        mcp_tools_tokens: categoryTokens.mcp_tools_tokens,
        memory_files_tokens: categoryTokens.memory_files_tokens,
        skills_tokens: categoryTokens.skills_tokens,
        messages_tokens: categoryTokens.messages_tokens
      },
      compaction_reserve_tokens: compactionReserveTokens,
      ...availableBeforeCompactionTokens === void 0 ? {} : {
        available_before_compaction_tokens: availableBeforeCompactionTokens
      },
      estimated: true
    };
  } catch {
    return void 0;
  }
}
__name(cloneContextUsage, "cloneContextUsage");
function isValidContextUsage(value) {
  return cloneContextUsage(value) !== void 0;
}
__name(isValidContextUsage, "isValidContextUsage");
function normalizeContextUsage(snapshot, providerTotal) {
  const validSnapshot = cloneContextUsage(snapshot);
  if (!validSnapshot || !Number.isSafeInteger(providerTotal) || providerTotal < 0) {
    return snapshot;
  }
  const providerTotalBigInt = BigInt(providerTotal);
  const fixedSum = FIXED_CATEGORY_KEYS.reduce(
    (sum, key) => sum + BigInt(validSnapshot.breakdown[key]),
    0n
  );
  let fixed;
  let messagesTokens;
  if (fixedSum > providerTotalBigInt) {
    const allocations = FIXED_CATEGORY_KEYS.map((key, index) => {
      const numerator = BigInt(validSnapshot.breakdown[key]) * providerTotalBigInt;
      return {
        key,
        index,
        floor: numerator / fixedSum,
        remainder: numerator % fixedSum
      };
    });
    let remaining = providerTotalBigInt - allocations.reduce((sum, item) => sum + item.floor, 0n);
    const rankedAllocations = [...allocations].sort((left, right) => {
      if (left.remainder === right.remainder) {
        return left.index - right.index;
      }
      return left.remainder > right.remainder ? -1 : 1;
    });
    for (const allocation of rankedAllocations) {
      if (remaining === 0n) break;
      allocation.floor += 1n;
      remaining -= 1n;
    }
    fixed = Object.fromEntries(
      allocations.map((allocation) => [
        allocation.key,
        Number(allocation.floor)
      ])
    );
    messagesTokens = 0;
  } else {
    fixed = Object.fromEntries(
      FIXED_CATEGORY_KEYS.map((key) => [key, validSnapshot.breakdown[key]])
    );
    messagesTokens = Number(providerTotalBigInt - fixedSum);
  }
  return {
    ...validSnapshot,
    breakdown: {
      ...fixed,
      messages_tokens: messagesTokens
    },
    available_before_compaction_tokens: Math.max(
      0,
      validSnapshot.window_size_tokens - validSnapshot.compaction_reserve_tokens - providerTotal
    )
  };
}
__name(normalizeContextUsage, "normalizeContextUsage");
function serializeContextUsage(contextUsage) {
  try {
    const canonical = cloneContextUsage(contextUsage);
    if (!canonical) return void 0;
    return serializeCanonicalContextUsage(canonical);
  } catch {
    return void 0;
  }
}
__name(serializeContextUsage, "serializeContextUsage");
function serializeContextUsageForSpanStart(contextUsage) {
  const canonical = cloneContextUsage(contextUsage);
  if (!canonical) return void 0;
  const serialized = serializeCanonicalContextUsage(canonical);
  if (!serialized) return void 0;
  const maximumFinalizedSize = serializeCanonicalContextUsage({
    ...canonical,
    breakdown: {
      ...canonical.breakdown,
      messages_tokens: Number.MAX_SAFE_INTEGER
    },
    available_before_compaction_tokens: MAX_SERIALIZED_NON_NEGATIVE_NUMBER
  });
  return maximumFinalizedSize ? serialized : void 0;
}
__name(serializeContextUsageForSpanStart, "serializeContextUsageForSpanStart");
function serializeCanonicalContextUsage(contextUsage) {
  const serialized = JSON.stringify(contextUsage);
  return serialized.length <= contextUsageAttributeLengthLimit ? serialized : void 0;
}
__name(serializeCanonicalContextUsage, "serializeCanonicalContextUsage");

// packages/core/src/telemetry/session-tracing.ts
init_esbuild_shims();
init_esm();
import { AsyncLocalStorage } from "node:async_hooks";

// packages/core/src/telemetry/sdk.ts
init_esbuild_shims();
init_esm();

// packages/core/src/telemetry/tracer.ts
init_esbuild_shims();
init_esm();

// packages/core/src/telemetry/trace-id-utils.ts
init_esbuild_shims();
import { createHash } from "node:crypto";
function deriveTraceId(sessionId) {
  return createHash("sha256").update(sessionId).digest("hex").slice(0, 32);
}
__name(deriveTraceId, "deriveTraceId");
function randomSpanId() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
__name(randomSpanId, "randomSpanId");
function randomHexString(length) {
  const bytes = new Uint8Array(Math.ceil(length / 2));
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("").slice(0, length);
}
__name(randomHexString, "randomHexString");

// packages/core/src/telemetry/tracer.ts
var tracer = trace.getTracer(SERVICE_NAME);
var debugLogger = createDebugLogger("OTEL_TRACER");
var TELEMETRY_WARNING_INTERVAL_MS = 3e4;
var API_CALL_FAILED_SPAN_STATUS_MESSAGE = "API call failed";
var API_CALL_ABORTED_SPAN_STATUS_MESSAGE = "API call aborted";
var lastTelemetryWarningMs;
var suppressedTelemetryWarnings = 0;
function warnTelemetryOperationFailed(operation, error) {
  const now = Date.now();
  if (lastTelemetryWarningMs !== void 0 && now - lastTelemetryWarningMs < TELEMETRY_WARNING_INTERVAL_MS) {
    suppressedTelemetryWarnings += 1;
    return;
  }
  const suppressedSuffix = suppressedTelemetryWarnings > 0 ? `; suppressed ${suppressedTelemetryWarnings} similar warning(s)` : "";
  suppressedTelemetryWarnings = 0;
  lastTelemetryWarningMs = now;
  try {
    debugLogger.warn(
      `OTel span ${operation} failed: ${error instanceof Error ? error.message : String(error)}${suppressedSuffix}`
    );
  } catch {
  }
}
__name(warnTelemetryOperationFailed, "warnTelemetryOperationFailed");
function safeSetStatus(span, status) {
  try {
    span.setStatus(status);
  } catch (error) {
    warnTelemetryOperationFailed("setStatus", error);
  }
}
__name(safeSetStatus, "safeSetStatus");
function shouldForceSampled() {
  const sampler = process.env["OTEL_TRACES_SAMPLER"]?.trim().toLowerCase() ?? "";
  if (!sampler || sampler.startsWith("parentbased_")) {
    if (sampler.includes("always_off")) return false;
    return true;
  }
  return sampler === "always_on";
}
__name(shouldForceSampled, "shouldForceSampled");
function createSessionRootContext(sessionId) {
  const traceId = deriveTraceId(sessionId);
  const spanId = randomSpanId();
  const rootSpan = trace.wrapSpanContext({
    traceId,
    spanId,
    traceFlags: shouldForceSampled() ? TraceFlags.SAMPLED : TraceFlags.NONE,
    isRemote: false
  });
  return trace.setSpan(ROOT_CONTEXT, rootSpan);
}
__name(createSessionRootContext, "createSessionRootContext");

// packages/core/src/telemetry/session-events.ts
init_esbuild_shims();
var import_api_logs = __toESM(require_src(), 1);
var startedSessionId;
function emitSessionStart(sessionId, previousSessionId) {
  if (startedSessionId === sessionId) return;
  startedSessionId = sessionId;
  const attributes = {
    "event.name": EVENT_SESSION_START,
    "event.timestamp": (/* @__PURE__ */ new Date()).toISOString(),
    "session.id": sessionId,
    ...previousSessionId ? { "session.previous_id": previousSessionId } : {}
  };
  import_api_logs.logs.getLogger(SERVICE_NAME).emit({
    body: "Session started.",
    attributes
  });
}
__name(emitSessionStart, "emitSessionStart");
function emitSessionEnd(sessionId) {
  if (startedSessionId === sessionId) {
    startedSessionId = void 0;
  }
  import_api_logs.logs.getLogger(SERVICE_NAME).emit({
    body: "Session ended.",
    attributes: {
      "event.name": EVENT_SESSION_END,
      "event.timestamp": (/* @__PURE__ */ new Date()).toISOString(),
      "session.id": sessionId
    }
  });
}
__name(emitSessionEnd, "emitSessionEnd");

// packages/core/src/telemetry/sdk.ts
function createTelemetryDiagLogger() {
  const debugLogger3 = createDebugLogger("OTEL");
  return {
    error: /* @__PURE__ */ __name((message, ...args) => debugLogger3.error(message, ...args), "error"),
    warn: /* @__PURE__ */ __name((message, ...args) => debugLogger3.warn(message, ...args), "warn"),
    info: /* @__PURE__ */ __name((message, ...args) => debugLogger3.info(message, ...args), "info"),
    debug: /* @__PURE__ */ __name((message, ...args) => debugLogger3.debug(message, ...args), "debug"),
    verbose: /* @__PURE__ */ __name((message, ...args) => debugLogger3.debug(message, ...args), "verbose")
  };
}
__name(createTelemetryDiagLogger, "createTelemetryDiagLogger");
diag.setLogger(createTelemetryDiagLogger(), DiagLogLevel.WARN);
var SHUTDOWN_TIMEOUT_MS = 1e4;
var sdk;
var telemetryInitialized = false;
var telemetryInitPromise;
var telemetryShutdownPromise;
var activeMetricReader;
var OTEL_EXPORTER_ENV_VARS = [
  "OTEL_TRACES_EXPORTER",
  "OTEL_LOGS_EXPORTER",
  "OTEL_METRICS_EXPORTER"
];
function startSdkWithExplicitExporters(currentSdk) {
  const previousValues = /* @__PURE__ */ new Map();
  for (const name of OTEL_EXPORTER_ENV_VARS) {
    previousValues.set(name, process.env[name]);
    delete process.env[name];
  }
  try {
    currentSdk.start();
  } finally {
    for (const name of OTEL_EXPORTER_ENV_VARS) {
      const previousValue = previousValues.get(name);
      if (previousValue === void 0) {
        delete process.env[name];
      } else {
        process.env[name] = previousValue;
      }
    }
  }
}
__name(startSdkWithExplicitExporters, "startSdkWithExplicitExporters");
function isTelemetrySdkInitialized() {
  return telemetryInitialized;
}
__name(isTelemetrySdkInitialized, "isTelemetrySdkInitialized");
function initializeTelemetry(config) {
  if (telemetryInitialized || !config.getTelemetryEnabled()) {
    return Promise.resolve();
  }
  telemetryInitPromise ??= (async () => {
    const debugLogger3 = createDebugLogger("OTEL");
    try {
      const { startTelemetrySdk } = await import("./sdk-impl-FK4JY6LX.js");
      if (telemetryInitialized) return;
      const started = await startTelemetrySdk(config);
      if (!started) return;
      sdk = started.sdk;
      startSdkWithExplicitExporters(sdk);
      debugLogger3.debug("OpenTelemetry SDK started successfully.");
      telemetryInitialized = true;
      activeMetricReader = started.metricReader;
      const sessionId = config.getSessionId();
      setSessionContext(createSessionRootContext(sessionId), sessionId);
      emitSessionStart(sessionId);
      setShellTracePropagation(
        config.getOutboundCorrelationPropagateTraceContext()
      );
      initializeMetrics(config);
    } catch (error) {
      debugLogger3.error("Error starting OpenTelemetry SDK:", error);
    }
  })().finally(() => {
    telemetryInitPromise = void 0;
  });
  return telemetryInitPromise;
}
__name(initializeTelemetry, "initializeTelemetry");
function refreshSessionContext(sessionId) {
  if (!telemetryInitialized) return;
  try {
    setSessionContext(createSessionRootContext(sessionId), sessionId);
  } catch (error) {
    createDebugLogger("OTEL").warn("Failed to refresh session context:", error);
  }
}
__name(refreshSessionContext, "refreshSessionContext");
function shutdownTelemetry() {
  if (telemetryShutdownPromise) {
    return telemetryShutdownPromise;
  }
  const pendingInit = telemetryInitPromise;
  if (!pendingInit && (!telemetryInitialized || !sdk)) {
    return Promise.resolve();
  }
  telemetryShutdownPromise = (async () => {
    if (pendingInit) {
      await pendingInit.catch(() => {
      });
    }
    if (!telemetryInitialized || !sdk) {
      telemetryShutdownPromise = void 0;
      return;
    }
    endAllInteractionSpans("cancelled");
    const currentSessionId = getCurrentSessionId();
    if (currentSessionId) {
      emitSessionEnd(currentSessionId);
    }
    const currentSdk = sdk;
    const debugLogger3 = createDebugLogger("OTEL");
    let timer;
    let timedOut = false;
    try {
      const sdkShutdown = Promise.resolve(currentSdk.shutdown());
      sdkShutdown.catch((err) => {
        if (timedOut) {
          debugLogger3.warn(
            "SDK shutdown rejected after timeout:",
            err instanceof Error ? err.message : err
          );
        }
      });
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          resolve("timeout");
        }, SHUTDOWN_TIMEOUT_MS);
        timer.unref?.();
      });
      const result = await Promise.race([sdkShutdown, timeout]);
      clearTimeout(timer);
      if (result === "timeout") {
        const msg = `Telemetry shutdown timed out after ${SHUTDOWN_TIMEOUT_MS}ms.`;
        diag.warn(msg);
        debugLogger3.warn(msg);
      } else {
        debugLogger3.debug("OpenTelemetry SDK shut down successfully.");
      }
    } catch (error) {
      clearTimeout(timer);
      diag.error("Error shutting down SDK:", error);
      debugLogger3.error("Error shutting down SDK:", error);
    } finally {
      telemetryInitialized = false;
      sdk = void 0;
      activeMetricReader = void 0;
      telemetryShutdownPromise = void 0;
      setSessionContext(void 0);
      setShellTracePropagation(false);
    }
  })();
  return telemetryShutdownPromise;
}
__name(shutdownTelemetry, "shutdownTelemetry");
var FORCE_FLUSH_TIMEOUT_MS = 2e3;
async function forceFlushMetrics() {
  if (!telemetryInitialized || !activeMetricReader) return;
  const flush = activeMetricReader.forceFlush();
  flush.catch(() => {
  });
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(
        new Error(
          `forceFlushMetrics timed out after ${FORCE_FLUSH_TIMEOUT_MS}ms`
        )
      ),
      FORCE_FLUSH_TIMEOUT_MS
    );
    timer.unref?.();
  });
  try {
    await Promise.race([flush, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
__name(forceFlushMetrics, "forceFlushMetrics");

// packages/core/src/telemetry/session-tracing.ts
var debugLogger2 = createDebugLogger("SESSION_TRACING");
function resolveParentContext(parent) {
  if (parent) {
    return trace.setSpan(context.active(), parent.span);
  }
  return context.active();
}
__name(resolveParentContext, "resolveParentContext");
var NOOP_SPAN = trace.wrapSpanContext({
  traceId: "0".repeat(32),
  spanId: "0".repeat(16),
  traceFlags: 0
});
var interactionContext = new AsyncLocalStorage();
var toolContext = new AsyncLocalStorage();
var subagentContext = new AsyncLocalStorage();
var activeInteractionsByPromptId = /* @__PURE__ */ new Map();
var interactionIdentityByPromptId = /* @__PURE__ */ new Map();
function isInNativeSubagentSpan() {
  const ctx = subagentContext.getStore();
  return ctx !== void 0 && !ctx.ended;
}
__name(isInNativeSubagentSpan, "isInNativeSubagentSpan");
function resolveSessionId(parentCtx, explicitSessionId, activeContext = context.active()) {
  const fromParent = parentCtx?.attributes?.["session.id"];
  if (typeof fromParent === "string" && fromParent) return fromParent;
  if (explicitSessionId) return explicitSessionId;
  return getSessionIdFromContext(activeContext) ?? (sessionIdContext.getStore() || getCurrentSessionId());
}
__name(resolveSessionId, "resolveSessionId");
function resolveGenAiUserId(parentCtx, promptId, explicitUserId) {
  const logicalParent = parentCtx ?? (promptId ? interactionIdentityByPromptId.get(promptId) : void 0);
  const value = logicalParent?.attributes["gen_ai.user.id"];
  return typeof value === "string" && value ? value : explicitUserId;
}
__name(resolveGenAiUserId, "resolveGenAiUserId");
var activeSpans = /* @__PURE__ */ new Map();
var strongSpans = /* @__PURE__ */ new Map();
var interactionSequence = 0;
var cleanupIntervalStarted = false;
var SPAN_TTL_MS_DEFAULT = 30 * 60 * 1e3;
var SPAN_TTL_MS_LONG = 4 * 60 * 60 * 1e3;
var LONG_TTL_SUBAGENT_KINDS = /* @__PURE__ */ new Set([
  "fork",
  "background"
]);
function ttlFor(ctx) {
  if (ctx.type === "subagent") {
    const kind = ctx.attributes["qwen-code.subagent.invocation_kind"];
    if (typeof kind === "string" && LONG_TTL_SUBAGENT_KINDS.has(kind)) {
      return SPAN_TTL_MS_LONG;
    }
  }
  return SPAN_TTL_MS_DEFAULT;
}
__name(ttlFor, "ttlFor");
function sweepStaleSpans(now) {
  for (const [promptId, ctx] of interactionIdentityByPromptId) {
    if (now - ctx.lastActivityTime >= SPAN_TTL_MS_DEFAULT) {
      interactionIdentityByPromptId.delete(promptId);
    }
  }
  for (const [spanId, weakRef] of activeSpans) {
    const ctx = weakRef.deref();
    if (ctx === void 0) {
      activeSpans.delete(spanId);
      strongSpans.delete(spanId);
      continue;
    }
    const ttlReferenceTime = ctx.type === "interaction" ? ctx.lastActivityTime ?? ctx.startTime : ctx.startTime;
    if (now - ttlReferenceTime < ttlFor(ctx)) continue;
    if (!ctx.ended) {
      ctx.ended = true;
      if (ctx.type === "interaction") {
        const promptId = ctx.attributes["qwen-code.prompt_id"];
        if (typeof promptId === "string" && activeInteractionsByPromptId.get(promptId) === ctx) {
          activeInteractionsByPromptId.delete(promptId);
        }
      }
      const ageMs = now - ctx.startTime;
      const toolName = ctx.attributes["gen_ai.tool.name"] ?? ctx.attributes["tool.name"];
      const callId = ctx.attributes["tool.call_id"];
      try {
        ctx.span.setAttributes({
          "qwen-code.span.ttl_expired": true,
          "qwen-code.span.duration_ms": ageMs,
          ...ctx.type === "tool.blocked_on_user" ? {
            decision: "aborted",
            source: "system"
          } : {},
          ...ctx.type === "subagent" ? {
            "qwen-code.subagent.status": "aborted",
            "qwen-code.subagent.terminate_reason": "ttl_swept",
            // Mirror the subagent-specific duration_ms key that
            // endSubagentSpan stamps so dashboards querying that
            // namespace see TTL-swept spans too (they currently
            // only get the generic qwen-code.span.duration_ms
            // above). wenshao @ #4410.
            "qwen-code.subagent.duration_ms": ageMs
          } : {}
        });
      } catch (error) {
        debugLogger2.warn(
          `Failed to stamp TTL attrs on stale span ${spanId}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      const ctxLabel = toolName && callId ? `${ctx.type} (tool.name=${toolName}, tool.call_id=${callId})` : ctx.type;
      debugLogger2.warn(
        `Stale ${ctxLabel} span ended by TTL safety net (age=${ageMs}ms, spanId=${spanId})`
      );
      try {
        ctx.span.end();
      } catch (error) {
        debugLogger2.warn(
          `Failed to end stale span ${spanId}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    activeSpans.delete(spanId);
    strongSpans.delete(spanId);
  }
}
__name(sweepStaleSpans, "sweepStaleSpans");
function ensureCleanupInterval() {
  if (cleanupIntervalStarted) return;
  cleanupIntervalStarted = true;
  const interval = setInterval(() => sweepStaleSpans(Date.now()), 6e4);
  if (typeof interval.unref === "function") {
    interval.unref();
  }
}
__name(ensureCleanupInterval, "ensureCleanupInterval");
function getSpanId(span) {
  return span.spanContext().spanId || "";
}
__name(getSpanId, "getSpanId");
var SPAN_TEXT_MAX_CHARS = 1024;
var TOOL_DESCRIPTION_MAX_CHARS = 4096;
function truncateSpanText(s, maxChars = SPAN_TEXT_MAX_CHARS) {
  if (s.length <= maxChars) return s;
  let end = maxChars;
  const code = s.charCodeAt(end - 1);
  if (code >= 55296 && code <= 56319) end--;
  return s.slice(0, end) + "\u2026[truncated]";
}
__name(truncateSpanText, "truncateSpanText");
function truncateSpanError(s) {
  return truncateSpanText(redactUrlCredentials(stripAnsiAndControl(s)));
}
__name(truncateSpanError, "truncateSpanError");
function getTracer() {
  return trace.getTracer(SERVICE_NAME, "1.0.0");
}
__name(getTracer, "getTracer");
function buildInteractionAttributes(config, options) {
  const sessionId = config.getSessionId();
  const userId = config.getTelemetryUserId();
  const ownsStructuredOutputContract = options.messageType === "userQuery" || options.messageType === "retry" || options.messageType === "acp_prompt";
  return {
    "session.id": sessionId,
    ...userId ? { "gen_ai.user.id": userId } : {},
    "gen_ai.operation.name": "invoke_agent",
    "gen_ai.agent.name": "qwen-code",
    "gen_ai.conversation.id": sessionId,
    ...ownsStructuredOutputContract && config.getJsonSchema?.() ? { "gen_ai.output.type": "json" } : {},
    "qwen-code.prompt_id": options.promptId,
    "qwen-code.message_type": options.messageType,
    "qwen-code.model": options.model,
    "qwen-code.approval_mode": config.getApprovalMode(),
    "interaction.sequence": interactionSequence
  };
}
__name(buildInteractionAttributes, "buildInteractionAttributes");
function finalizeInteractionContext(spanCtx, status, metadata) {
  if (spanCtx.ended) return;
  spanCtx.ended = true;
  const promptId = spanCtx.attributes["qwen-code.prompt_id"];
  if (typeof promptId === "string" && activeInteractionsByPromptId.get(promptId) === spanCtx) {
    activeInteractionsByPromptId.delete(promptId);
    const identity = interactionIdentityByPromptId.get(promptId);
    if (identity) identity.lastActivityTime = Date.now();
  }
  try {
    const duration = Date.now() - spanCtx.startTime;
    const attributes = {
      "interaction.duration_ms": duration,
      "qwen-code.turn_status": status
    };
    if (status === "error") {
      attributes["error.type"] = metadata?.errorType || "interaction_error";
    }
    spanCtx.span.setAttributes(attributes);
    if (status === "error") {
      spanCtx.span.setStatus({
        code: SpanStatusCode.ERROR,
        message: truncateSpanError(metadata?.errorMessage ?? "unknown error")
      });
    }
  } catch (error) {
    debugLogger2.warn(
      `Failed to update interaction span attributes/status: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  try {
    spanCtx.span.end();
  } catch (error) {
    debugLogger2.warn(
      `Failed to end interaction span: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const spanId = getSpanId(spanCtx.span);
  activeSpans.delete(spanId);
  strongSpans.delete(spanId);
}
__name(finalizeInteractionContext, "finalizeInteractionContext");
function registerInteractionContext(promptId, spanContextObj) {
  const existing = activeInteractionsByPromptId.get(promptId);
  if (existing && !existing.ended) {
    debugLogger2.warn(
      `Replacing unfinished interaction for promptId=${promptId}; ending the previous span as cancelled`
    );
    finalizeInteractionContext(existing, "cancelled", { promptId });
  }
  const spanId = getSpanId(spanContextObj.span);
  activeSpans.set(spanId, new WeakRef(spanContextObj));
  strongSpans.set(spanId, spanContextObj);
  activeInteractionsByPromptId.set(promptId, spanContextObj);
  const userId = spanContextObj.attributes["gen_ai.user.id"];
  if (typeof userId === "string" && userId) {
    interactionIdentityByPromptId.set(promptId, {
      lastActivityTime: spanContextObj.lastActivityTime ?? spanContextObj.startTime,
      attributes: { "gen_ai.user.id": userId }
    });
  } else {
    interactionIdentityByPromptId.delete(promptId);
  }
}
__name(registerInteractionContext, "registerInteractionContext");
function getInteractionContext(promptId) {
  if (promptId !== void 0) {
    const exact = activeInteractionsByPromptId.get(promptId);
    return exact && !exact.ended ? exact : void 0;
  }
  const current = interactionContext.getStore();
  return current && !current.ended ? current : void 0;
}
__name(getInteractionContext, "getInteractionContext");
function touchInteractionContext(spanCtx) {
  if (!spanCtx || spanCtx.type !== "interaction" || spanCtx.ended) return false;
  const promptId = spanCtx.attributes["qwen-code.prompt_id"];
  if (typeof promptId !== "string" || activeInteractionsByPromptId.get(promptId) !== spanCtx) {
    return false;
  }
  const now = Date.now();
  spanCtx.lastActivityTime = now;
  const identity = interactionIdentityByPromptId.get(promptId);
  if (identity) identity.lastActivityTime = now;
  return true;
}
__name(touchInteractionContext, "touchInteractionContext");
function resolveGenAiParentContext(parent) {
  if (!parent && interactionContext.getStore()) return ROOT_CONTEXT;
  return resolveParentContext(parent);
}
__name(resolveGenAiParentContext, "resolveGenAiParentContext");
function startInteractionSpan(config, options) {
  if (!isTelemetrySdkInitialized()) return;
  ensureCleanupInterval();
  interactionSequence++;
  const attributes = buildInteractionAttributes(config, options);
  const span = getTracer().startSpan(
    SPAN_INTERACTION,
    { kind: SpanKind.INTERNAL, attributes },
    ROOT_CONTEXT
  );
  const spanContextObj = {
    span,
    startTime: Date.now(),
    lastActivityTime: Date.now(),
    attributes,
    type: "interaction"
  };
  registerInteractionContext(options.promptId, spanContextObj);
  interactionContext.enterWith(spanContextObj);
}
__name(startInteractionSpan, "startInteractionSpan");
function endInteractionSpan(status, metadata) {
  const spanCtx = getInteractionContext(metadata?.promptId);
  if (!spanCtx) return;
  if (spanCtx.ended) {
    debugLogger2.debug(
      `endInteractionSpan: span ${getSpanId(spanCtx.span)} already ended (possible TTL sweep race)`
    );
    return;
  }
  const current = interactionContext.getStore();
  finalizeInteractionContext(spanCtx, status, metadata);
  if (current === spanCtx) interactionContext.enterWith(void 0);
}
__name(endInteractionSpan, "endInteractionSpan");
function endAllInteractionSpans(status = "cancelled") {
  for (const spanCtx of [...activeInteractionsByPromptId.values()]) {
    finalizeInteractionContext(spanCtx, status);
  }
  interactionContext.enterWith(void 0);
}
__name(endAllInteractionSpans, "endAllInteractionSpans");
async function withInteractionSpan(config, options, fn, getResultStatus) {
  if (!isTelemetrySdkInitialized()) return await fn();
  ensureCleanupInterval();
  interactionSequence++;
  const sessionId = config.getSessionId();
  const attributes = buildInteractionAttributes(config, options);
  const parentContext = options.parentContext ?? ROOT_CONTEXT;
  const span = getTracer().startSpan(
    SPAN_INTERACTION,
    {
      kind: SpanKind.INTERNAL,
      attributes
    },
    parentContext
  );
  const spanContextObj = {
    span,
    startTime: Date.now(),
    lastActivityTime: Date.now(),
    attributes,
    type: "interaction"
  };
  registerInteractionContext(options.promptId, spanContextObj);
  const activeContext = trace.setSpan(
    setSessionIdOnContext(parentContext, sessionId),
    span
  );
  return await context.with(
    activeContext,
    async () => interactionContext.run(spanContextObj, async () => {
      let terminalStatus = "ok";
      let errorMetadata;
      try {
        const result = await fn();
        terminalStatus = getResultStatus?.(result) ?? "ok";
        return result;
      } catch (error) {
        terminalStatus = "error";
        errorMetadata = {
          promptId: options.promptId,
          errorMessage: error instanceof Error ? error.message : String(error),
          errorType: getErrorType(error)
        };
        throw error;
      } finally {
        finalizeInteractionContext(spanContextObj, terminalStatus, {
          promptId: options.promptId,
          ...terminalStatus === "error" && !errorMetadata ? {
            errorMessage: "interaction error",
            errorType: "interaction_error"
          } : errorMetadata
        });
      }
    })
  );
}
__name(withInteractionSpan, "withInteractionSpan");
function startLLMRequestSpanWithContext(model, promptId, options) {
  if (!isTelemetrySdkInitialized()) {
    return {
      span: NOOP_SPAN,
      context: trace.setSpan(context.active(), NOOP_SPAN)
    };
  }
  const interactionParentCtx = getInteractionContext(promptId);
  touchInteractionContext(interactionParentCtx);
  const parentCtx = subagentContext.getStore() ?? toolContext.getStore() ?? interactionParentCtx;
  const ctx = resolveGenAiParentContext(parentCtx);
  const sessionId = resolveSessionId(parentCtx, options?.sessionId, ctx);
  const userId = resolveGenAiUserId(parentCtx, promptId, options?.userId);
  const contextUsage = cloneContextUsage(options?.contextUsage);
  const serializedContextUsage = serializeContextUsageForSpanStart(contextUsage);
  const attributes = {
    ...sessionId ? { "session.id": sessionId } : {},
    ...sessionId ? { "gen_ai.conversation.id": sessionId } : {},
    ...userId ? { "gen_ai.user.id": userId } : {},
    "qwen-code.prompt_id": promptId,
    "llm_request.context": parentCtx?.type === "subagent" ? "subagent" : interactionParentCtx ? "interaction" : "standalone",
    // Emit the version-pinned OTel GenAI semantic convention.
    "gen_ai.request.model": model,
    ...options?.operationName ? { "gen_ai.operation.name": options.operationName } : {},
    ...options?.providerName ? { "gen_ai.provider.name": options.providerName } : {},
    ...options?.outputType ? { "gen_ai.output.type": options.outputType } : {},
    ...serializedContextUsage ? { [CONTEXT_USAGE_ATTRIBUTE]: serializedContextUsage } : {}
  };
  const sessionContext = setSessionIdOnContext(ctx, sessionId);
  const span = getTracer().startSpan(
    SPAN_LLM_REQUEST,
    { kind: SpanKind.INTERNAL, attributes },
    sessionContext
  );
  const spanId = getSpanId(span);
  const spanContextObj = {
    span,
    startTime: Date.now(),
    ...interactionParentCtx ? { interactionOwner: interactionParentCtx } : {},
    ...serializedContextUsage && contextUsage ? { contextUsage } : {},
    attributes,
    type: "llm_request"
  };
  activeSpans.set(spanId, new WeakRef(spanContextObj));
  strongSpans.set(spanId, spanContextObj);
  return {
    span,
    context: trace.setSpan(sessionContext, span)
  };
}
__name(startLLMRequestSpanWithContext, "startLLMRequestSpanWithContext");
function endLLMRequestSpan(span, metadata) {
  const spanId = getSpanId(span);
  const spanCtx = activeSpans.get(spanId)?.deref();
  if (!spanCtx) return;
  if (spanCtx.ended) {
    debugLogger2.debug(
      `endLLMRequestSpan: span ${spanId} already ended (possible TTL sweep race)`
    );
    return;
  }
  spanCtx.ended = true;
  try {
    const duration = metadata?.durationMs ?? Date.now() - spanCtx.startTime;
    const endAttributes = { duration_ms: duration };
    if (metadata) {
      const inputTokens = metadata.inputTokens;
      const hasValidInputTokens = inputTokens !== void 0 && Number.isSafeInteger(inputTokens) && inputTokens >= 0;
      if (hasValidInputTokens) {
        endAttributes["gen_ai.usage.input_tokens"] = inputTokens;
        if (spanCtx.contextUsage) {
          const normalized = serializeContextUsage(
            normalizeContextUsage(spanCtx.contextUsage, inputTokens)
          );
          if (normalized) {
            endAttributes[CONTEXT_USAGE_ATTRIBUTE] = normalized;
          }
        }
      }
      if (metadata.outputTokens !== void 0 && Number.isSafeInteger(metadata.outputTokens) && metadata.outputTokens >= 0) {
        endAttributes["gen_ai.usage.output_tokens"] = metadata.outputTokens;
      }
      if (metadata.cachedInputTokensReported && metadata.cachedInputTokens !== void 0 && Number.isSafeInteger(metadata.cachedInputTokens) && metadata.cachedInputTokens >= 0) {
        endAttributes["gen_ai.usage.cache_read.input_tokens"] = metadata.cachedInputTokens;
      }
      if (metadata.cacheCreationInputTokens !== void 0 && Number.isSafeInteger(metadata.cacheCreationInputTokens) && metadata.cacheCreationInputTokens >= 0) {
        endAttributes["gen_ai.usage.cache_creation.input_tokens"] = metadata.cacheCreationInputTokens;
      }
      if (metadata.ttftMs !== void 0) {
        endAttributes["ttft_ms"] = metadata.ttftMs;
      }
      if (metadata.requestSetupMs !== void 0) {
        endAttributes["request_setup_ms"] = metadata.requestSetupMs;
      }
      if (metadata.attempt !== void 0) {
        endAttributes["attempt"] = metadata.attempt;
      }
      if (metadata.retryTotalDelayMs !== void 0) {
        endAttributes["retry_total_delay_ms"] = metadata.retryTotalDelayMs;
      }
      if (metadata.ttftMs !== void 0) {
        const samplingMs = Math.max(0, duration - metadata.ttftMs);
        endAttributes["sampling_ms"] = samplingMs;
        if (samplingMs > 0 && metadata.outputTokens !== void 0) {
          endAttributes["output_tokens_per_second"] = Math.round(metadata.outputTokens / (samplingMs / 1e3) * 100) / 100;
        }
      }
      endAttributes["success"] = metadata.success;
      if (metadata.error !== void 0)
        endAttributes["error"] = truncateSpanError(metadata.error);
      if (metadata.responseId !== void 0) {
        endAttributes["gen_ai.response.id"] = metadata.responseId;
      }
      if (metadata.responseModel !== void 0) {
        endAttributes["gen_ai.response.model"] = metadata.responseModel;
      }
      const finishReasons = metadata.finishReasons?.length ? metadata.finishReasons : metadata.finishReason !== void 0 ? [metadata.finishReason] : void 0;
      if (finishReasons) {
        endAttributes["finish_reason"] = finishReasons[0];
        endAttributes["gen_ai.response.finish_reasons"] = finishReasons;
      }
      if (metadata.thoughtsTokenCount !== void 0) {
        endAttributes["thoughts_token_count"] = metadata.thoughtsTokenCount;
      }
      if (metadata.subagentName !== void 0) {
        endAttributes["subagent_name"] = metadata.subagentName;
      }
      if (metadata.errorType && !metadata.cancelled) {
        endAttributes["error_type"] = metadata.errorType;
        endAttributes["error.type"] = metadata.errorType;
      }
      if (!metadata.success && !metadata.cancelled && endAttributes["error.type"] === void 0) {
        endAttributes["error.type"] = "llm_error";
      }
      if (metadata.errorStatusCode !== void 0) {
        endAttributes["error_status_code"] = metadata.errorStatusCode;
      }
    }
    spanCtx.span.setAttributes(endAttributes);
    try {
      if (metadata?.config && metadata.success) {
        const model = String(spanCtx.attributes["gen_ai.request.model"] ?? "");
        if (metadata.requestSetupMs !== void 0) {
          recordApiRequestBreakdown(metadata.config, metadata.requestSetupMs, {
            model,
            phase: "request_preparation" /* REQUEST_PREPARATION */
          });
        }
        if (metadata.ttftMs !== void 0) {
          recordApiRequestBreakdown(metadata.config, metadata.ttftMs, {
            model,
            phase: "network_latency" /* NETWORK_LATENCY */
          });
        }
        const breakdownSamplingMs = metadata.ttftMs !== void 0 ? Math.max(0, duration - metadata.ttftMs) : void 0;
        if (breakdownSamplingMs !== void 0 && breakdownSamplingMs > 0) {
          recordApiRequestBreakdown(metadata.config, breakdownSamplingMs, {
            model,
            phase: "response_processing" /* RESPONSE_PROCESSING */
          });
        }
      }
    } catch (error) {
      debugLogger2.warn(
        `Failed to record API request breakdown histogram: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (metadata !== void 0 && !metadata.success && !metadata.cancelled) {
      spanCtx.span.setStatus({
        code: SpanStatusCode.ERROR,
        message: metadata.error ? truncateSpanError(metadata.error) : "unknown error"
      });
    }
  } catch (error) {
    debugLogger2.warn(
      `Failed to update LLM request span attributes/status: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  try {
    spanCtx.span.end();
  } catch (error) {
    debugLogger2.warn(
      `Failed to end LLM request span: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  activeSpans.delete(spanId);
  strongSpans.delete(spanId);
  touchInteractionContext(spanCtx.interactionOwner);
}
__name(endLLMRequestSpan, "endLLMRequestSpan");
function startToolSpan(toolName, attrs, description, promptId) {
  if (!isTelemetrySdkInitialized()) {
    return NOOP_SPAN;
  }
  let span;
  try {
    const interactionParentCtx = getInteractionContext(promptId);
    touchInteractionContext(interactionParentCtx);
    const parentCtx = subagentContext.getStore() ?? toolContext.getStore() ?? interactionParentCtx;
    const ctx = resolveGenAiParentContext(parentCtx);
    const sessionId = resolveSessionId(parentCtx, void 0, ctx);
    const userId = resolveGenAiUserId(parentCtx, promptId);
    const agentName = (subagentContext.getStore() ?? interactionParentCtx)?.attributes["gen_ai.agent.name"];
    const attributes = {
      ...sessionId ? { "session.id": sessionId } : {},
      ...attrs,
      ...userId ? { "gen_ai.user.id": userId } : {},
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": toolName,
      "gen_ai.tool.type": "function",
      ...typeof agentName === "string" ? { "gen_ai.agent.name": agentName } : {},
      ...description ? {
        "gen_ai.tool.description": truncateSpanText(
          description,
          TOOL_DESCRIPTION_MAX_CHARS
        )
      } : {}
    };
    if (typeof agentName !== "string") {
      delete attributes["gen_ai.agent.name"];
    }
    span = getTracer().startSpan(
      SPAN_TOOL,
      { kind: SpanKind.INTERNAL, attributes },
      ctx
    );
    const spanId = getSpanId(span);
    const spanContextObj = {
      span,
      startTime: Date.now(),
      ...interactionParentCtx ? { interactionOwner: interactionParentCtx } : {},
      attributes,
      type: "tool"
    };
    activeSpans.set(spanId, new WeakRef(spanContextObj));
    strongSpans.set(spanId, spanContextObj);
    return span;
  } catch (error) {
    try {
      span?.end();
    } catch {
    }
    debugLogger2.warn(
      `Failed to start tool span: ${error instanceof Error ? error.message : String(error)}`
    );
    return NOOP_SPAN;
  }
}
__name(startToolSpan, "startToolSpan");
function runInToolSpanContext(span, fn) {
  const spanId = getSpanId(span);
  const spanCtx = activeSpans.get(spanId)?.deref();
  if (!spanCtx) return fn();
  const sessionId = resolveSessionId(spanCtx);
  const otelCtxWithSpan = trace.setSpan(
    setSessionIdOnContext(context.active(), sessionId),
    span
  );
  return toolContext.run(spanCtx, () => context.with(otelCtxWithSpan, fn));
}
__name(runInToolSpanContext, "runInToolSpanContext");
function endToolSpan(span, metadata) {
  const spanId = getSpanId(span);
  const spanCtx = activeSpans.get(spanId)?.deref();
  if (!spanCtx) return;
  if (spanCtx.ended) {
    debugLogger2.debug(
      `endToolSpan: span ${spanId} already ended (possible TTL sweep race)`
    );
    return;
  }
  spanCtx.ended = true;
  try {
    const duration = Date.now() - spanCtx.startTime;
    const endAttributes = { duration_ms: duration };
    if (metadata) {
      if (metadata.success !== void 0 || metadata.cancelled) {
        endAttributes["success"] = metadata.cancelled ? false : metadata.success ?? false;
      }
      if (metadata.error !== void 0)
        endAttributes["error"] = truncateSpanError(metadata.error);
      if (metadata.success === false && !metadata.cancelled) {
        endAttributes["error.type"] = "tool_error";
      }
      if (metadata.cancelled) {
        endAttributes[TOOL_FAILURE_KIND_ATTRIBUTE] = TOOL_FAILURE_KIND_CANCELLED;
      }
    }
    spanCtx.span.setAttributes(endAttributes);
    if (metadata) {
      if (!metadata.cancelled && metadata.success === false) {
        spanCtx.span.setStatus({
          code: SpanStatusCode.ERROR,
          message: metadata.error ? truncateSpanError(metadata.error) : "tool error"
        });
      }
    }
  } catch (error) {
    debugLogger2.warn(
      `Failed to update tool span attributes/status: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  try {
    spanCtx.span.end();
  } catch (error) {
    debugLogger2.warn(
      `Failed to end tool span: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  activeSpans.delete(spanId);
  strongSpans.delete(spanId);
  touchInteractionContext(spanCtx.interactionOwner);
}
__name(endToolSpan, "endToolSpan");
function startToolExecutionSpan(options) {
  if (!isTelemetrySdkInitialized()) {
    return NOOP_SPAN;
  }
  let span;
  try {
    const parentCtx = toolContext.getStore();
    if (!parentCtx) {
      debugLogger2.warn(
        "startToolExecutionSpan called outside runInToolSpanContext \u2014 span will not be parented to tool span"
      );
    }
    const ctx = resolveParentContext(parentCtx);
    const sessionId = resolveSessionId(
      parentCtx ?? interactionContext.getStore()
    );
    const attributes = {
      ...sessionId ? { "session.id": sessionId } : {},
      ...options?.toolName ? { "gen_ai.tool.name": options.toolName } : {},
      ...options?.callId ? { "tool.call_id": options.callId } : {}
    };
    span = getTracer().startSpan(
      SPAN_TOOL_EXECUTION,
      {
        kind: SpanKind.INTERNAL,
        attributes
      },
      ctx
    );
    const spanId = getSpanId(span);
    const spanContextObj = {
      span,
      startTime: Date.now(),
      attributes,
      type: "tool.execution"
    };
    activeSpans.set(spanId, new WeakRef(spanContextObj));
    strongSpans.set(spanId, spanContextObj);
    return span;
  } catch (error) {
    try {
      span?.end();
    } catch {
    }
    debugLogger2.warn(
      `Failed to start tool execution span: ${error instanceof Error ? error.message : String(error)}`
    );
    return NOOP_SPAN;
  }
}
__name(startToolExecutionSpan, "startToolExecutionSpan");
function endToolExecutionSpan(span, metadata) {
  const spanId = getSpanId(span);
  const spanCtx = activeSpans.get(spanId)?.deref();
  if (!spanCtx) return;
  if (spanCtx.ended) {
    debugLogger2.debug(
      `endToolExecutionSpan: span ${spanId} already ended (possible TTL sweep race)`
    );
    return;
  }
  spanCtx.ended = true;
  try {
    const duration = Date.now() - spanCtx.startTime;
    const executionStatus = metadata?.executionStatus;
    const cancelled = metadata?.cancelled === true || executionStatus === "cancelled";
    const endAttributes = {};
    if (metadata?.attributes) {
      Object.assign(endAttributes, metadata.attributes);
    }
    endAttributes["duration_ms"] = duration;
    if (metadata) {
      if (metadata.success !== void 0)
        endAttributes["success"] = metadata.success;
      if (metadata.error !== void 0)
        endAttributes["error"] = truncateSpanError(metadata.error);
      if (metadata.executionStatus !== void 0) {
        endAttributes["execution_status"] = metadata.executionStatus;
      }
      if (metadata.errorType) {
        endAttributes["error_type"] = metadata.errorType;
        if (!cancelled) {
          endAttributes["error.type"] = metadata.errorType;
        }
      }
      const failed = !cancelled && executionStatus !== "not_started" && (executionStatus === void 0 ? metadata.success === false : executionStatus !== "success");
      if (failed && endAttributes["error.type"] === void 0) {
        endAttributes["error.type"] = "tool_execution_error";
      }
    }
    spanCtx.span.setAttributes(endAttributes);
    if (metadata && !cancelled && executionStatus !== "not_started") {
      const succeeded = executionStatus === void 0 ? metadata.success !== false : executionStatus === "success";
      if (!succeeded) {
        spanCtx.span.setStatus({
          code: SpanStatusCode.ERROR,
          message: metadata.error ? truncateSpanError(metadata.error) : "tool execution error"
        });
      }
    }
  } catch (error) {
    debugLogger2.warn(
      `Failed to update tool execution span attributes/status: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  try {
    spanCtx.span.end();
  } catch (error) {
    debugLogger2.warn(
      `Failed to end tool execution span: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  activeSpans.delete(spanId);
  strongSpans.delete(spanId);
}
__name(endToolExecutionSpan, "endToolExecutionSpan");
function startToolBlockedOnUserSpan(toolSpan, attrs) {
  if (!isTelemetrySdkInitialized()) {
    return NOOP_SPAN;
  }
  ensureCleanupInterval();
  const parentSpanId = getSpanId(toolSpan);
  const parentSpanCtx = activeSpans.get(parentSpanId)?.deref();
  if (!parentSpanCtx) {
    debugLogger2.debug(
      "startToolBlockedOnUserSpan: tool span not in activeSpans (already ended?) \u2014 using resolveParentContext fallback"
    );
  }
  const ctx = parentSpanCtx ? trace.setSpan(context.active(), parentSpanCtx.span) : resolveParentContext(void 0);
  const sessionParentCtx = parentSpanCtx ?? subagentContext.getStore() ?? interactionContext.getStore() ?? void 0;
  const sessionId = resolveSessionId(sessionParentCtx);
  const attributes = {
    ...sessionId ? { "session.id": sessionId } : {}
  };
  if (attrs?.tool_name !== void 0) attributes["tool.name"] = attrs.tool_name;
  if (attrs?.call_id !== void 0) attributes["tool.call_id"] = attrs.call_id;
  const span = getTracer().startSpan(
    SPAN_TOOL_BLOCKED_ON_USER,
    { kind: SpanKind.INTERNAL, attributes },
    ctx
  );
  const spanId = getSpanId(span);
  const spanContextObj = {
    span,
    startTime: Date.now(),
    attributes,
    type: "tool.blocked_on_user"
  };
  activeSpans.set(spanId, new WeakRef(spanContextObj));
  strongSpans.set(spanId, spanContextObj);
  return span;
}
__name(startToolBlockedOnUserSpan, "startToolBlockedOnUserSpan");
function endToolBlockedOnUserSpan(span, metadata) {
  const spanId = getSpanId(span);
  const spanCtx = activeSpans.get(spanId)?.deref();
  if (!spanCtx) return;
  if (spanCtx.ended) {
    debugLogger2.debug(
      `endToolBlockedOnUserSpan: span ${spanId} already ended (possible TTL sweep race)`
    );
    return;
  }
  spanCtx.ended = true;
  try {
    const duration = Date.now() - spanCtx.startTime;
    const endAttributes = { duration_ms: duration };
    if (metadata?.decision !== void 0)
      endAttributes["decision"] = metadata.decision;
    if (metadata?.source !== void 0)
      endAttributes["source"] = metadata.source;
    spanCtx.span.setAttributes(endAttributes);
  } catch (error) {
    debugLogger2.warn(
      `Failed to update blocked_on_user span attributes: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  try {
    spanCtx.span.end();
  } catch (error) {
    debugLogger2.warn(
      `Failed to end blocked_on_user span: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  activeSpans.delete(spanId);
  strongSpans.delete(spanId);
}
__name(endToolBlockedOnUserSpan, "endToolBlockedOnUserSpan");
function startHookSpan(opts) {
  if (!isTelemetrySdkInitialized()) {
    return NOOP_SPAN;
  }
  ensureCleanupInterval();
  const parentCtx = toolContext.getStore() ?? subagentContext.getStore() ?? interactionContext.getStore() ?? void 0;
  touchInteractionContext(interactionContext.getStore());
  const ctx = resolveParentContext(parentCtx);
  const sessionId = resolveSessionId(parentCtx);
  const attributes = {
    ...sessionId ? { "session.id": sessionId } : {},
    hook_event: opts.hookEvent,
    "tool.name": opts.toolName
  };
  if (opts.toolUseId !== void 0) attributes["tool.use_id"] = opts.toolUseId;
  if (opts.isInterrupt !== void 0)
    attributes["is_interrupt"] = opts.isInterrupt;
  const span = getTracer().startSpan(
    SPAN_HOOK,
    { kind: SpanKind.INTERNAL, attributes },
    ctx
  );
  const spanId = getSpanId(span);
  const spanContextObj = {
    span,
    startTime: Date.now(),
    ...interactionContext.getStore() ? { interactionOwner: interactionContext.getStore() } : {},
    attributes,
    type: "hook"
  };
  activeSpans.set(spanId, new WeakRef(spanContextObj));
  strongSpans.set(spanId, spanContextObj);
  return span;
}
__name(startHookSpan, "startHookSpan");
function endHookSpan(span, metadata) {
  const spanId = getSpanId(span);
  const spanCtx = activeSpans.get(spanId)?.deref();
  if (!spanCtx) return;
  if (spanCtx.ended) {
    debugLogger2.debug(
      `endHookSpan: span ${spanId} already ended (possible TTL sweep race)`
    );
    return;
  }
  spanCtx.ended = true;
  try {
    const duration = Date.now() - spanCtx.startTime;
    const endAttributes = { duration_ms: duration };
    if (metadata) {
      if (metadata.success !== void 0)
        endAttributes["success"] = metadata.success;
      if (metadata.shouldProceed !== void 0)
        endAttributes["should_proceed"] = metadata.shouldProceed;
      if (metadata.shouldStop !== void 0)
        endAttributes["should_stop"] = metadata.shouldStop;
      if (metadata.blockType !== void 0)
        endAttributes["block_type"] = metadata.blockType;
      if (metadata.hasAdditionalContext !== void 0)
        endAttributes["has_additional_context"] = metadata.hasAdditionalContext;
      if (metadata.postBatchStop !== void 0)
        endAttributes["post_batch_stop"] = metadata.postBatchStop;
      if (metadata.postBatchStopReason !== void 0)
        endAttributes["post_batch_stop_reason"] = truncateSpanError(
          metadata.postBatchStopReason
        );
      if (metadata.error !== void 0)
        endAttributes["error"] = truncateSpanError(metadata.error);
      if (metadata.error !== void 0)
        endAttributes["error.type"] = "hook_error";
    }
    spanCtx.span.setAttributes(endAttributes);
    if (metadata?.error !== void 0) {
      spanCtx.span.setStatus({
        code: SpanStatusCode.ERROR,
        message: truncateSpanError(metadata.error)
      });
    }
  } catch (error) {
    debugLogger2.warn(
      `Failed to update hook span attributes/status: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  try {
    spanCtx.span.end();
  } catch (error) {
    debugLogger2.warn(
      `Failed to end hook span: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  activeSpans.delete(spanId);
  strongSpans.delete(spanId);
  touchInteractionContext(spanCtx.interactionOwner);
}
__name(endHookSpan, "endHookSpan");
function startSubagentSpan(opts) {
  if (!isTelemetrySdkInitialized()) return NOOP_SPAN;
  ensureCleanupInterval();
  const parentCtx = subagentContext.getStore() ?? toolContext.getStore() ?? interactionContext.getStore();
  const sessionId = resolveSessionId(parentCtx, opts.sessionId) ?? opts.sessionId;
  const userId = resolveGenAiUserId(parentCtx);
  const attributes = {
    // Spec-aligned (OTel GenAI Agent Spans, Development status).
    "gen_ai.operation.name": "invoke_agent",
    "gen_ai.agent.name": opts.subagentName,
    "gen_ai.conversation.id": sessionId,
    "session.id": sessionId,
    ...userId ? { "gen_ai.user.id": userId } : {},
    // Vendor identity and lifecycle. The per-invocation ID stays private;
    // gen_ai.agent.id is reserved for a stable agent definition identity.
    "qwen-code.subagent.id": opts.agentId,
    "qwen-code.subagent.name": opts.subagentName,
    "qwen-code.subagent.invocation_kind": opts.invocationKind,
    "qwen-code.subagent.is_built_in": opts.isBuiltIn,
    "qwen-code.subagent.depth": opts.depth
  };
  if (opts.agentDescription !== void 0) {
    attributes["gen_ai.agent.description"] = truncateSpanText(
      opts.agentDescription
    );
  }
  if (opts.modelOverride !== void 0) {
    attributes["gen_ai.request.model"] = opts.modelOverride;
  }
  if (opts.parentAgentId !== void 0) {
    attributes["qwen-code.subagent.parent_agent_id"] = opts.parentAgentId;
  }
  if (opts.invokingRequestId !== void 0) {
    attributes["qwen-code.subagent.invoking_request_id"] = opts.invokingRequestId;
  }
  const tracer2 = getTracer();
  let span;
  if (opts.invocationKind === "foreground") {
    span = tracer2.startSpan(SPAN_SUBAGENT, {
      kind: SpanKind.INTERNAL,
      attributes
    });
  } else {
    span = tracer2.startSpan(SPAN_SUBAGENT, {
      kind: SpanKind.INTERNAL,
      attributes,
      root: true,
      links: opts.invokerSpanContext ? [
        {
          context: opts.invokerSpanContext,
          attributes: { "qwen-code.link.kind": "invoker" }
        }
      ] : void 0
    });
  }
  const spanId = getSpanId(span);
  const spanContextObj = {
    span,
    startTime: Date.now(),
    attributes,
    type: "subagent"
  };
  activeSpans.set(spanId, new WeakRef(spanContextObj));
  strongSpans.set(spanId, spanContextObj);
  return span;
}
__name(startSubagentSpan, "startSubagentSpan");
function runInSubagentSpanContext(span, fn) {
  const spanId = getSpanId(span);
  const spanCtx = activeSpans.get(spanId)?.deref();
  if (!spanCtx) return fn();
  const sessionId = resolveSessionId(spanCtx);
  const otelCtxWithSpan = trace.setSpan(
    setSessionIdOnContext(context.active(), sessionId),
    span
  );
  return subagentContext.run(
    spanCtx,
    () => toolContext.run(void 0, () => context.with(otelCtxWithSpan, fn))
  );
}
__name(runInSubagentSpanContext, "runInSubagentSpanContext");
function endSubagentSpan(span, metadata) {
  const spanId = getSpanId(span);
  const spanCtx = activeSpans.get(spanId)?.deref();
  if (!spanCtx) {
    if (isTelemetrySdkInitialized()) {
      debugLogger2.warn(
        `endSubagentSpan: span ${spanId} not found in activeSpans (already swept?) \u2014 intended status=${metadata.status}, reason=${metadata.terminateReason ?? "none"}`
      );
    }
    return;
  }
  if (spanCtx.ended) {
    debugLogger2.warn(
      `endSubagentSpan: span ${spanId} already ended \u2014 intended status=${metadata.status}, reason=${metadata.terminateReason ?? "none"} (possible TTL sweep race)`
    );
    return;
  }
  spanCtx.ended = true;
  try {
    const duration = Date.now() - spanCtx.startTime;
    const endAttributes = {
      duration_ms: duration,
      "qwen-code.subagent.duration_ms": duration,
      "qwen-code.subagent.status": metadata.status
    };
    if (metadata.terminateReason !== void 0) {
      endAttributes["qwen-code.subagent.terminate_reason"] = metadata.terminateReason;
    }
    if (metadata.resultSummaryPresent !== void 0) {
      endAttributes["qwen-code.subagent.result_summary_present"] = metadata.resultSummaryPresent;
    }
    if (metadata.status === "failed" && metadata.error !== void 0) {
      const truncated = truncateSpanError(metadata.error);
      endAttributes["exception.message"] = truncated;
    }
    if (metadata.status === "failed") {
      endAttributes["error.type"] = metadata.errorType || "subagent_error";
    }
    spanCtx.span.setAttributes(endAttributes);
    if (metadata.status === "failed") {
      spanCtx.span.setStatus({
        code: SpanStatusCode.ERROR,
        message: metadata.error ? truncateSpanError(metadata.error) : "subagent failed"
      });
    }
  } catch (error) {
    debugLogger2.warn(
      `Failed to update subagent span attributes/status: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  try {
    spanCtx.span.end();
  } catch (error) {
    debugLogger2.warn(
      `Failed to end subagent span: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  activeSpans.delete(spanId);
  strongSpans.delete(spanId);
}
__name(endSubagentSpan, "endSubagentSpan");
function getActiveInteractionSpan(promptId) {
  return getInteractionContext(promptId)?.span;
}
__name(getActiveInteractionSpan, "getActiveInteractionSpan");
function recordInteractionActivity(promptId, expectedOwner) {
  const spanCtx = getInteractionContext(promptId);
  if (!spanCtx || spanCtx.span !== expectedOwner) return false;
  return touchInteractionContext(spanCtx);
}
__name(recordInteractionActivity, "recordInteractionActivity");

export {
  SERVICE_NAME,
  EVENT_USER_PROMPT,
  EVENT_USER_RETRY,
  EVENT_TOOL_CALL,
  EVENT_REPEATED_TOOL_FAILURE_GUARD,
  EVENT_API_REQUEST,
  EVENT_API_ERROR,
  EVENT_API_CANCEL,
  EVENT_API_RESPONSE,
  EVENT_CLI_CONFIG,
  EVENT_EXTENSION_DISABLE,
  EVENT_EXTENSION_ENABLE,
  EVENT_EXTENSION_INSTALL,
  EVENT_EXTENSION_UNINSTALL,
  EVENT_EXTENSION_UPDATE,
  EVENT_RIPGREP_FALLBACK,
  EVENT_RIPGREP_RUNTIME_RECOVERY,
  EVENT_NEXT_SPEAKER_CHECK,
  EVENT_SLASH_COMMAND,
  EVENT_IDE_CONNECTION,
  EVENT_CHAT_COMPRESSION,
  EVENT_CONTENT_RETRY,
  EVENT_CONTENT_RETRY_FAILURE,
  EVENT_PROTOCOL_TAG_SANITIZED,
  EVENT_API_RETRY,
  EVENT_CONVERSATION_FINISHED,
  EVENT_FILE_OPERATION,
  EVENT_MODEL_SLASH_COMMAND,
  EVENT_SUBAGENT_EXECUTION,
  EVENT_GOAL_STATE,
  EVENT_SKILL_LAUNCH,
  EVENT_AUTH,
  EVENT_USER_FEEDBACK,
  EVENT_TOOL_OUTPUT_TRUNCATED,
  DEFAULT_SENSITIVE_SPAN_ATTRIBUTE_MAX_LENGTH,
  SENSITIVE_SPAN_ATTRIBUTE_MAX_LENGTH_LIMIT,
  isValidSensitiveSpanAttributeMaxLength,
  EVENT_PROMPT_SUGGESTION,
  EVENT_SPECULATION,
  EVENT_WORKFLOW_KEYWORD,
  EVENT_WORKFLOW_RUN,
  EVENT_WORKFLOW_SIZE_WARNING,
  EVENT_ARENA_SESSION_STARTED,
  EVENT_ARENA_AGENT_COMPLETED,
  EVENT_ARENA_SESSION_ENDED,
  EVENT_MEMORY_EXTRACT,
  EVENT_MEMORY_DREAM,
  EVENT_MEMORY_RECALL,
  EVENT_MEMORY_RECALL_DELIVERY,
  TOOL_FAILURE_KIND_ATTRIBUTE,
  TOOL_FAILURE_KIND_CANCELLED,
  TOOL_FAILURE_KIND_PRE_HOOK_BLOCKED,
  TOOL_FAILURE_KIND_INVOCATION_GUARD_DENIED,
  TOOL_FAILURE_KIND_POST_HOOK_STOPPED,
  TOOL_FAILURE_KIND_TOOL_ERROR,
  TOOL_FAILURE_KIND_TOOL_EXCEPTION,
  TOOL_FAILURE_KIND_PERMISSION_DENIED,
  TOOL_FAILURE_KIND_PERMISSION_HOOK_DENIED,
  TOOL_FAILURE_KIND_PLAN_MODE_BLOCKED,
  TOOL_FAILURE_KIND_NON_INTERACTIVE_DENIED,
  TOOL_FAILURE_KIND_BACKGROUND_AGENT_DENIED,
  TOOL_FAILURE_KIND_TIMEOUT,
  getMeter,
  recordGoalStateMetrics,
  recordChatCompressionMetrics,
  recordToolCallMetrics,
  recordToolExecutionMetrics,
  recordRepeatedToolFailureGuardMetrics,
  recordTokenUsageMetrics,
  recordApiResponseMetrics,
  recordApiErrorMetrics,
  recordFileOperationMetric,
  recordContentRetry,
  recordContentRetryFailure,
  recordApiRetry,
  recordModelSlashCommand,
  recordMemoryUsage,
  recordCpuUsage,
  isPerformanceMonitoringActive,
  recordSubagentExecutionMetrics,
  recordArenaSessionStartedMetrics,
  recordArenaAgentCompletedMetrics,
  recordArenaSessionEndedMetrics,
  recordMemoryExtractMetrics,
  recordMemoryDreamMetrics,
  recordMemoryRecallMetrics,
  recordChannelMemoryRecallMetrics,
  recordMemoryRecallDeliveryMetrics,
  deriveTraceId,
  randomSpanId,
  randomHexString,
  API_CALL_FAILED_SPAN_STATUS_MESSAGE,
  API_CALL_ABORTED_SPAN_STATUS_MESSAGE,
  safeSetStatus,
  shouldForceSampled,
  stripAnsiAndControl,
  safeLiteralReplace,
  isBinary,
  normalizeContent,
  stripHtmlComments,
  redactUrlCredentials,
  configureContextUsageAttributeLengthLimit,
  isValidContextUsage,
  isInNativeSubagentSpan,
  truncateSpanError,
  startInteractionSpan,
  endInteractionSpan,
  withInteractionSpan,
  startLLMRequestSpanWithContext,
  endLLMRequestSpan,
  startToolSpan,
  runInToolSpanContext,
  endToolSpan,
  startToolExecutionSpan,
  endToolExecutionSpan,
  startToolBlockedOnUserSpan,
  endToolBlockedOnUserSpan,
  startHookSpan,
  endHookSpan,
  startSubagentSpan,
  runInSubagentSpanContext,
  endSubagentSpan,
  getActiveInteractionSpan,
  recordInteractionActivity,
  emitSessionStart,
  emitSessionEnd,
  isTelemetrySdkInitialized,
  initializeTelemetry,
  refreshSessionContext,
  shutdownTelemetry,
  forceFlushMetrics
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
