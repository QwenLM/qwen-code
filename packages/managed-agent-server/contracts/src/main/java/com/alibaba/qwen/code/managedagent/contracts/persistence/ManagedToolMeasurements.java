package com.alibaba.qwen.code.managedagent.contracts.persistence;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.apache.commons.codec.digest.DigestUtils;

import java.math.BigDecimal;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Set;

import static com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedExtensionRecords.closed;
import static com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedExtensionRecords.count;
import static com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedExtensionRecords.oneOf;

/** Bounded executor evidence; observation v1 and legacy receipts stay unchanged. */
public final class ManagedToolMeasurements {
    public static final String KIND = "managed-tool-measurements";
    public static final int MAX_BYTES = 4096;
    private static final long MAX_COUNT = 9_007_199_254_740_991L;
    private static final List<String> LINES = List.of("modelLinesAdded", "modelLinesRemoved", "appliedLinesAdded", "appliedLinesRemoved");
    private static final List<String> COUNTERS = List.of("recorded", "unsupported", "partial", "executionDurationMs", "executionDurationSamples",
            "fileSamples", "modelDiffSamples", "appliedDiffSamples", "modelLinesAdded", "modelLinesRemoved", "appliedLinesAdded", "appliedLinesRemoved");

    private ManagedToolMeasurements() { }

    public static void requireMeasurements(JsonNode body) {
        closed(body, Set.of("protocol", "executionDurationMs", "executionOutcome", "file"), "tool measurements");
        require("managed-tool-measurements/1".equals(body.path("protocol").asText()), "Invalid measurement protocol.");
        nullableCount(body.get("executionDurationMs"));
        oneOf(body.get("executionOutcome"), List.of("not_started", "success", "error", "cancelled", "unknown"), "executionOutcome");
        JsonNode file = body.get("file");
        require(file != null, "Missing file measurement.");
        if (file.isNull()) {
            return;
        }
        require("success".equals(body.path("executionOutcome").asText()), "File measurement requires execution success.");
        closed(file, Set.of("operation", "status", "modelLinesAdded", "modelLinesRemoved", "appliedLinesAdded", "appliedLinesRemoved"), "file measurement");
        oneOf(file.get("operation"), List.of("read", "write", "edit"), "operation");
        oneOf(file.get("status"), List.of("measured", "unchanged", "unmeasured"), "status");
        LINES.forEach(field -> nullableCount(file.get(field)));
        require(file.path("modelLinesAdded").isNull() == file.path("modelLinesRemoved").isNull()
                && file.path("appliedLinesAdded").isNull() == file.path("appliedLinesRemoved").isNull(), "Incomplete line measurement.");
        if ("read".equals(file.path("operation").asText())) {
            require("measured".equals(file.path("status").asText()) && LINES.stream().allMatch(field -> file.path(field).isNull()), "Invalid read measurement.");
        } else if ("unmeasured".equals(file.path("status").asText())) {
            require(file.path("appliedLinesAdded").isNull(), "Unmeasured changes have no applied diff.");
        } else {
            require(LINES.stream().noneMatch(field -> file.path(field).isNull())
                    && "unchanged".equals(file.path("status").asText()) == (file.path("appliedLinesAdded").longValue() == 0
                    && file.path("appliedLinesRemoved").longValue() == 0), "Invalid measured changes.");
        }
    }

    public static void requireEvidence(JsonNode body) {
        closed(body, Set.of("schemaVersion", "invocationId", "executionCallId", "resultDigest", "modelProposal", "measurements"), "tool measurement evidence");
        count(body.get("schemaVersion"), 1, 1, "schemaVersion");
        oneOf(body.get("modelProposal"), List.of("original", "modified", "unknown"), "modelProposal");
        for (String field : List.of("invocationId", "resultDigest")) {
            require(body.path(field).isTextual() && body.path(field).asText().matches("[0-9a-f]{64}"), "Invalid measurement digest.");
        }
        JsonNode execution = body.path("executionCallId");
        require(execution.isTextual() && !execution.asText().isEmpty() && execution.asText().getBytes(StandardCharsets.UTF_8).length <= 512
                && execution.asText().codePoints().noneMatch(code -> code >= 0xd800 && code <= 0xdfff), "Invalid measurement execution identity.");
        require(body.has("measurements") && body.toString().getBytes(StandardCharsets.UTF_8).length <= MAX_BYTES, "Measurement evidence exceeds its limit.");
        if (!body.path("measurements").isNull()) {
            requireMeasurements(body.get("measurements"));
        }
    }

    public static String commitDigest(JsonNode payload) {
        return DigestUtils.sha256Hex(JsonNodeFactory.instance.arrayNode().add("managed-tool-measured/1")
                .add(payload.path("executionCallId").asText()).add(payload.path("toolOutcomeRef").path("digest").asText())
                .add(payload.path("measurementsRef").path("digest").asText()).toString().getBytes(StandardCharsets.UTF_8));
    }

    public static ObjectNode publicMeasurements(JsonNode body, long sequence) {
        JsonNode packet = body.path("measurements");
        ObjectNode result = JsonNodeFactory.instance.objectNode().put("sourceSequence", Long.toString(sequence));
        result.put("availability", packet.isNull() ? "unsupported"
                : packet.path("executionDurationMs").isNull() || "unmeasured".equals(packet.path("file").path("status").asText()) ? "partial" : "available");
        if (packet.isNull() || packet.path("executionDurationMs").isNull()) {
            result.putNull("executionDurationMs");
        } else {
            result.put("executionDurationMs", Long.toString(packet.path("executionDurationMs").longValue()));
        }
        result.set("file", packet.path("file").isMissingNode() ? JsonNodeFactory.instance.nullNode() : packet.path("file").deepCopy());
        if (result.path("file").isObject()) {
            ObjectNode file = (ObjectNode) result.path("file");
            LINES.forEach(field -> {
                if (!file.path(field).isNull()) {
                    file.put(field, Long.toString(file.path(field).longValue()));
                }
            });
            if (!"read".equals(file.path("operation").asText()) && !"original".equals(body.path("modelProposal").asText())) {
                file.putNull("modelLinesAdded").putNull("modelLinesRemoved");
                result.put("availability", "partial");
            }
        }
        return result;
    }

    public static void contribute(ObjectNode metrics, JsonNode fact, int sign) {
        if (fact == null || !fact.has("measurements")) {
            return;
        }
        ObjectNode totals;
        if (metrics.path("measurements").isObject()) {
            totals = (ObjectNode) metrics.path("measurements");
        } else {
            totals = metrics.putObject("measurements");
            COUNTERS.forEach(field -> totals.put(field, "0"));
        }
        JsonNode measured = fact.path("measurements");
        add(totals, "recorded", "1", sign);
        if ("unsupported".equals(measured.path("availability").asText())) {
            add(totals, "unsupported", "1", sign);
        }
        if ("partial".equals(measured.path("availability").asText())) {
            add(totals, "partial", "1", sign);
        }
        if (!measured.path("executionDurationMs").isNull()) {
            add(totals, "executionDurationMs", measured.path("executionDurationMs").asText(), sign);
            add(totals, "executionDurationSamples", "1", sign);
        }
        JsonNode file = measured.path("file");
        if (!file.isNull()) {
            add(totals, "fileSamples", "1", sign);
            for (String pair : List.of("model", "applied")) {
                if (!file.path(pair + "LinesAdded").isNull()) {
                    add(totals, pair + "DiffSamples", "1", sign);
                    for (String direction : List.of("Added", "Removed")) {
                        add(totals, pair + "Lines" + direction, file.path(pair + "Lines" + direction).asText(), sign);
                    }
                }
            }
        }
    }

    public static void availability(ObjectNode metrics) {
        if (metrics.path("measurements").isObject()) {
            ObjectNode totals = (ObjectNode) metrics.path("measurements");
            String recorded = totals.path("recorded").asText();
            totals.put("availability", "0".equals(recorded) ? "not_recorded"
                    : recorded.equals(totals.path("unsupported").asText()) ? "unsupported"
                    : recorded.equals(metrics.path("requested").asText()) && "0".equals(totals.path("unsupported").asText()) && "0".equals(totals.path("partial").asText()) ? "available" : "partial");
        }
    }

    private static void add(ObjectNode totals, String field, String value, int sign) {
        BigInteger next = new BigInteger(totals.path(field).asText()).add(new BigInteger(value).multiply(BigInteger.valueOf(sign)));
        require(next.signum() >= 0, "Negative measurement contribution.");
        totals.put(field, next.toString());
    }

    private static void nullableCount(JsonNode value) {
        require(value != null, "Missing measurement count.");
        if (!value.isNull()) {
            BigDecimal number = value.isNumber() && Double.isFinite(value.doubleValue()) ? value.decimalValue() : null;
            require(number != null && number.stripTrailingZeros().scale() <= 0 && number.signum() >= 0
                    && number.compareTo(BigDecimal.valueOf(MAX_COUNT)) <= 0, "Invalid measurement count.");
        }
    }

    private static void require(boolean condition, String message) {
        if (!condition) {
            throw new ManagedExtensionRecords.InvalidRecordException(message);
        }
    }
}
