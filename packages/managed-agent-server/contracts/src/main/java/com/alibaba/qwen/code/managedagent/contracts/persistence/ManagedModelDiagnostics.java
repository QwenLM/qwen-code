package com.alibaba.qwen.code.managedagent.contracts.persistence;

import com.fasterxml.jackson.databind.JsonNode;

import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;

import static com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedExtensionRecords.closed;
import static com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedExtensionRecords.count;
import static com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedExtensionRecords.id;
import static com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedExtensionRecords.oneOf;

/** Bounded observations carried by existing native model and turn transitions. */
public final class ManagedModelDiagnostics {
    public static final String MAIN_KIND = "managed-hosted-model-usage-v2";
    public static final String HOOK_KIND = "managed-hook-model-usage-v2";
    public static final String STATS_KIND = "managed-session-model-stats";
    public static final String CONTEXT_DOMAIN = "hosted_context_usage";
    public static final String STATS_DOMAIN = "hosted_session_statistics";
    public static final Set<String> KINDS = Set.of(MAIN_KIND, HOOK_KIND, STATS_KIND);
    public static final List<String> SOURCES = List.of("main", "hook", "compression");
    public static final List<String> GAPS = List.of("legacy_history", "unclosed_turn", "unclosed_model_attempt",
            "unclosed_maintenance", "observation_error", "missing_usage", "interrupted_observation", "counter_overflow");
    public static final List<String> CATEGORIES = List.of("systemPrompt", "builtinTools", "mcpTools", "instructionFiles",
            "memoryFiles", "skills", "startupContext", "messages");
    private static final long MAX_SAFE = 9_007_199_254_740_991L;
    private static final Set<String> TOKENS = Set.of("prompt", "candidates", "total", "cached", "thoughts");
    private static final List<String> OUTCOMES = List.of("success", "error", "cancelled", "interrupted");
    private static final List<String> FAILURES = List.of("http", "transport", "timeout", "other");

    private ManagedModelDiagnostics() { }

    public static void requireBody(String kind, JsonNode body) {
        require(KINDS.contains(kind), "Unknown model diagnostics resource kind.");
        Set<String> fields = new HashSet<>(Set.of("version", "budget", "statistics", "context"));
        if (MAIN_KIND.equals(kind)) {
            fields.addAll(Set.of("turnId", "model"));
        } else if (HOOK_KIND.equals(kind)) {
            fields.addAll(Set.of("operationId", "occurrenceId", "originTurnId", "eventName", "model"));
        }
        closed(body, fields, "model diagnostics");
        int version = STATS_KIND.equals(kind) ? 1 : 2;
        count(body.get("version"), version, version, "version");
        require(encodedSize(body) <= 65_536, "Model diagnostics exceed 64 KiB.");
        if (!STATS_KIND.equals(kind)) {
            text(body.get("model"), 512, false, "model");
        }
        if (MAIN_KIND.equals(kind)) {
            id(body.get("turnId"), "turnId");
        } else if (HOOK_KIND.equals(kind)) {
            for (String field : List.of("operationId", "occurrenceId", "eventName")) {
                id(body.get(field), field);
            }
            if (!body.get("originTurnId").isNull()) {
                id(body.get("originTurnId"), "originTurnId");
            }
        }
        JsonNode budget = body.get("budget");
        if (!budget.isNull()) {
            closed(budget, Set.of("sessionId", "promptId", "budget", "outputTokensAtTurnStart"), "budget");
            id(budget.get("sessionId"), "budget.sessionId");
            id(budget.get("promptId"), "budget.promptId");
            nullableCount(budget.get("budget"), "budget.budget");
            counter(budget.get("outputTokensAtTurnStart"), "budget.outputTokensAtTurnStart");
        }
        requireStatistics(body.get("statistics"));
        JsonNode context = body.get("context");
        if (!context.isNull()) {
            require(MAIN_KIND.equals(kind), "Only main model usage carries context.");
            requireContext(context);
            require(body.get("turnId").equals(context.get("turnId")) && body.get("model").equals(context.get("model")),
                    "Context does not match its model invocation.");
        }
    }

    public static void requireStatistics(JsonNode statistics) {
        closed(statistics, Set.of("version", "snapshotRevision", "observedAt", "rawOutputTokensTotal", "coverage",
                "totals", "sources", "models", "overflow", "recent", "modelBreakdownOmitted", "samplesTruncated"), "statistics");
        require(encodedSize(statistics) <= 40_960, "Statistics exceed 40 KiB.");
        count(statistics.get("version"), 1, 1, "statistics.version");
        count(statistics.get("snapshotRevision"), 1, MAX_SAFE, "snapshotRevision");
        counter(statistics.get("observedAt"), "observedAt");
        counter(statistics.get("rawOutputTokensTotal"), "rawOutputTokensTotal");
        bool(statistics.get("modelBreakdownOmitted"), "modelBreakdownOmitted");
        bool(statistics.get("samplesTruncated"), "samplesTruncated");
        closed(statistics.get("coverage"), Set.of("gaps"), "coverage");
        JsonNode gaps = statistics.get("coverage").get("gaps");
        require(gaps.isArray() && gaps.size() <= GAPS.size(), "Invalid coverage gaps.");
        int previous = -1;
        for (JsonNode gap : gaps) {
            int index = GAPS.indexOf(oneOf(gap, GAPS, "coverage gap"));
            require(index > previous, "Coverage gaps must be unique and ordered.");
            previous = index;
        }
        bucket(statistics.get("totals"));
        closed(statistics.get("sources"), Set.copyOf(SOURCES), "sources");
        SOURCES.forEach(source -> bucket(statistics.get("sources").get(source)));
        bucket(statistics.get("overflow"));
        JsonNode models = statistics.get("models");
        require(models.isArray() && models.size() <= 16, "Statistics have too many models.");
        require(!statistics.get("modelBreakdownOmitted").booleanValue() || models.isEmpty(),
                "An omitted model breakdown must remain empty.");
        Set<String> keys = new HashSet<>();
        for (JsonNode model : models) {
            closed(model, Set.of("key", "name", "nameTruncated", "metrics"), "model");
            hash(model.get("key"), "model.key");
            require(keys.add(model.get("key").textValue()), "Model keys must be unique.");
            text(model.get("name"), 128, true, "model.name");
            bool(model.get("nameTruncated"), "nameTruncated");
            bucket(model.get("metrics"));
        }
        JsonNode recent = statistics.get("recent");
        require(recent.isArray() && recent.size() <= 20, "Statistics have too many samples.");
        Set<String> executions = new HashSet<>();
        for (JsonNode sample : recent) {
            sample(sample);
            require(executions.add(sample.get("executionId").textValue()), "Duplicate model observation sample.");
        }
    }

    public static void requireContext(JsonNode context) {
        closed(context, Set.of("version", "attemptId", "turnId", "model", "providerPin", "observedAt", "inputTokens",
                "cachedTokens", "contextWindowSize", "breakdown", "thresholds", "details", "attributionComplete", "detailsTruncated"), "context");
        require(encodedSize(context) <= 8192, "Context exceeds 8 KiB.");
        count(context.get("version"), 1, 1, "context.version");
        id(context.get("attemptId"), "context.attemptId");
        id(context.get("turnId"), "context.turnId");
        text(context.get("model"), 512, false, "context.model");
        hash(context.get("providerPin"), "context.providerPin");
        counter(context.get("observedAt"), "context.observedAt");
        for (String field : List.of("inputTokens", "cachedTokens", "contextWindowSize")) {
            nullableCount(context.get(field), field);
        }
        counters(context.get("breakdown"), Set.copyOf(CATEGORIES), "breakdown");
        if (!context.get("thresholds").isNull()) {
            JsonNode thresholds = context.get("thresholds");
            closed(thresholds, Set.of("warn", "auto", "hard"), "thresholds");
            double prior = 0;
            for (String field : List.of("warn", "auto", "hard")) {
                JsonNode value = thresholds.get(field);
                require(value.isNumber() && Double.isFinite(value.doubleValue())
                        && value.doubleValue() >= prior && value.doubleValue() <= 1, "Invalid context thresholds.");
                prior = value.doubleValue();
            }
        }
        bool(context.get("attributionComplete"), "attributionComplete");
        bool(context.get("detailsTruncated"), "detailsTruncated");
        JsonNode details = context.get("details");
        require(details.isArray() && details.size() <= 32, "Too many context details.");
        for (JsonNode detail : details) {
            closed(detail, Set.of("category", "name", "tokens"), "detail");
            oneOf(detail.get("category"), CATEGORIES, "detail.category");
            text(detail.get("name"), 128, false, "detail.name");
            counter(detail.get("tokens"), "detail.tokens");
        }
    }

    private static void bucket(JsonNode bucket) {
        closed(bucket, Set.of("requests", "tokens", "usageKnown", "latencyMs", "timing", "failures", "backoffRetries"), "metrics");
        counters(bucket.get("requests"), Set.of("total", "success", "error", "cancelled", "interrupted"), "requests");
        counters(bucket.get("tokens"), TOKENS, "tokens");
        counters(bucket.get("usageKnown"), TOKENS, "usageKnown");
        counter(bucket.get("latencyMs"), "latencyMs");
        counters(bucket.get("timing"), Set.of("ttftCount", "totalTtftMs", "generationCount", "totalGenerationMs", "throughputOutputTokens"), "timing");
        counters(bucket.get("failures"), Set.copyOf(FAILURES), "failures");
        counter(bucket.get("backoffRetries"), "backoffRetries");
        long total = bucket.get("requests").get("total").longValue();
        for (JsonNode known : bucket.get("usageKnown")) {
            require(known.longValue() <= total, "Known usage cannot exceed requests.");
        }
    }

    private static void sample(JsonNode sample) {
        closed(sample, Set.of("executionId", "source", "modelKey", "at", "outcome", "durationMs", "ttftMs", "generationMs",
                "outputTokens", "failureKind", "statusCode", "backoffRetryOrdinal"), "sample");
        String execution = id(sample.get("executionId"), "executionId");
        try {
            require(UUID.fromString(execution).toString().equals(execution), "Invalid execution id.");
        } catch (IllegalArgumentException error) {
            throw new ManagedExtensionRecords.InvalidRecordException("Invalid execution id.");
        }
        oneOf(sample.get("source"), SOURCES, "source");
        hash(sample.get("modelKey"), "modelKey");
        for (String field : List.of("at", "durationMs", "backoffRetryOrdinal")) {
            counter(sample.get(field), field);
        }
        oneOf(sample.get("outcome"), OUTCOMES, "outcome");
        for (String field : List.of("ttftMs", "generationMs", "outputTokens")) {
            nullableCount(sample.get(field), field);
        }
        if (!sample.get("failureKind").isNull()) {
            oneOf(sample.get("failureKind"), FAILURES, "failureKind");
        }
        if (!sample.get("statusCode").isNull()) {
            count(sample.get("statusCode"), 100, 599, "statusCode");
        }
    }

    private static void counters(JsonNode object, Set<String> fields, String name) {
        closed(object, fields, name);
        fields.forEach(field -> counter(object.get(field), name + "." + field));
    }

    private static void counter(JsonNode node, String field) {
        count(node, 0, MAX_SAFE, field);
    }

    private static void nullableCount(JsonNode node, String field) {
        require(node != null, "Missing " + field);
        if (!node.isNull()) {
            counter(node, field);
        }
    }

    private static void text(JsonNode node, int max, boolean nullable, String field) {
        require(node != null && (nullable && node.isNull() || node.isTextual() && !node.textValue().isBlank()
                && node.textValue().getBytes(StandardCharsets.UTF_8).length <= max
                && node.textValue().chars().noneMatch(Character::isISOControl)), "Invalid " + field);
    }

    private static void hash(JsonNode node, String field) {
        require(node != null && node.isTextual() && node.textValue().matches("[0-9a-f]{64}"), "Invalid " + field);
    }

    private static void bool(JsonNode node, String field) {
        require(node != null && node.isBoolean(), "Invalid " + field);
    }

    private static int encodedSize(JsonNode node) {
        return node.toString().getBytes(StandardCharsets.UTF_8).length;
    }

    private static void require(boolean condition, String message) {
        if (!condition) {
            throw new ManagedExtensionRecords.InvalidRecordException(message);
        }
    }
}
