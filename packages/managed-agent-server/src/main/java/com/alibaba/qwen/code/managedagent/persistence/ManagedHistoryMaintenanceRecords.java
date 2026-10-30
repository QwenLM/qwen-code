package com.alibaba.qwen.code.managedagent.persistence;

import com.fasterxml.jackson.databind.JsonNode;

import java.util.List;
import java.util.Set;

import static com.alibaba.qwen.code.managedagent.persistence.ManagedExtensionRecords.closed;
import static com.alibaba.qwen.code.managedagent.persistence.ManagedExtensionRecords.count;
import static com.alibaba.qwen.code.managedagent.persistence.ManagedExtensionRecords.durableRef;
import static com.alibaba.qwen.code.managedagent.persistence.ManagedExtensionRecords.id;
import static com.alibaba.qwen.code.managedagent.persistence.ManagedExtensionRecords.oneOf;

/** The context-compression slice of the reserved history_maintenance domain. */
public final class ManagedHistoryMaintenanceRecords {
    private static final long MAX_SAFE = 9_007_199_254_740_991L;
    private static final List<String> PHASES = List.of("admitted", "generating", "candidate", "settled");
    private static final List<String> OUTCOMES = List.of("compressed", "noop", "failed");
    private static final List<String> FIXED = List.of("schemaVersion", "kind", "operationId",
            "expectedCompactionRevision", "historyCutSequence", "requestRef");

    private ManagedHistoryMaintenanceRecords() {}

    public static void requireRecord(JsonNode body) {
        closed(body, Set.of("schemaVersion", "kind", "operationId", "expectedCompactionRevision",
                "historyCutSequence", "requestRef", "phase", "attempt", "candidateRef", "outcome",
                "failureCode", "compactionRevision", "run"), "historyMaintenance");
        count(body.get("schemaVersion"), 1, 1, "schemaVersion");
        oneOf(body.get("kind"), List.of("context_compression"), "kind");
        id(body.get("operationId"), "operationId");
        count(body.get("expectedCompactionRevision"), 0, MAX_SAFE, "expectedCompactionRevision");
        count(body.get("historyCutSequence"), body.get("expectedCompactionRevision").longValue(),
                MAX_SAFE, "historyCutSequence");
        count(body.get("attempt"), 0, MAX_SAFE, "attempt");
        durableRef(body.get("requestRef"), "requestRef");
        if (!body.get("candidateRef").isNull()) {
            durableRef(body.get("candidateRef"), "candidateRef");
        }
        if (!body.get("failureCode").isNull()) {
            id(body.get("failureCode"), "failureCode");
        }
        if (!body.get("compactionRevision").isNull()) {
            count(body.get("compactionRevision"), 0, MAX_SAFE, "compactionRevision");
        }
        String phase = oneOf(body.get("phase"), PHASES, "phase");
        String outcome = body.get("outcome").isNull() ? null : oneOf(body.get("outcome"), OUTCOMES, "outcome");
        JsonNode run = body.get("run");
        ManagedExtensionRecords.requireRun(run);
        for (String key : List.of("definition", "executionCallId", "effectId", "dispatchId",
                "deliveryId", "execution", "runtime", "delivery")) {
            require(run.get(key).isNull(), "History maintenance must be purely logical.");
        }
        long attempt = body.get("attempt").longValue();
        String state = run.get("state").textValue();
        boolean candidate = !body.get("candidateRef").isNull();
        require(!"admitted".equals(phase) || attempt == 0 && !candidate && "admitted".equals(state),
                "History maintenance admission must have no attempt or candidate.");
        require(!List.of("generating", "candidate").contains(phase)
                || attempt >= 1 && List.of("running", "recovery_blocked").contains(state),
                "An active phase needs a running or blocked attempt.");
        require(!"generating".equals(phase) || !candidate, "Generation has no candidate.");
        require(!"candidate".equals(phase) || candidate, "Candidate phase requires its durable candidate.");
        if (!"settled".equals(phase)) {
            require(outcome == null && body.get("failureCode").isNull() && body.get("compactionRevision").isNull(),
                    "An active operation has no outcome.");
        } else {
            require(outcome != null && ("failed".equals(outcome) ? "failed" : "settled").equals(state),
                    "A settled phase requires its terminal outcome.");
            require("failed".equals(outcome) != body.get("failureCode").isNull(),
                    "Only a failed outcome carries a failure code.");
            require("compressed".equals(outcome) ? candidate && !body.get("compactionRevision").isNull()
                    && body.get("compactionRevision").longValue() > body.get("expectedCompactionRevision").longValue()
                    : body.get("compactionRevision").isNull(),
                    "Only a compressed outcome carries its new compaction revision.");
        }
    }

    public static boolean isStart(JsonNode body) {
        return accepts(() -> requireRecord(body)) && "admitted".equals(body.path("phase").asText());
    }

    public static boolean isSuccessor(JsonNode previous, JsonNode next) {
        if (!accepts(() -> requireRecord(previous)) || !accepts(() -> requireRecord(next))
                || "settled".equals(previous.path("phase").asText())
                || !ManagedExtensionRecords.isRunSuccessor(previous.get("run"), next.get("run"))
                || FIXED.stream().anyMatch(key -> !ManagedMcpRecords.same(previous.get(key), next.get(key)))
                || !previous.get("candidateRef").isNull()
                && !ManagedMcpRecords.same(previous.get("candidateRef"), next.get("candidateRef"))) {
            return false;
        }
        long before = previous.get("attempt").longValue();
        long after = next.get("attempt").longValue();
        String phase = next.get("phase").textValue();
        if ("settled".equals(phase)) {
            return before == after && (!"compressed".equals(next.path("outcome").asText())
                    || "candidate".equals(previous.path("phase").asText()));
        }
        return switch (previous.get("phase").textValue()) {
            case "admitted" -> "generating".equals(phase) && after == 1;
            case "candidate" -> "candidate".equals(phase) && before == after;
            default -> "candidate".equals(phase) ? before == after
                    : "generating".equals(phase) && (after == before || after == before + 1);
        };
    }
    private static boolean accepts(Runnable check) {
        try {
            check.run();
            return true;
        } catch (ManagedExtensionRecords.InvalidRecordException error) {
            return false;
        }
    }

    private static void require(boolean condition, String message) {
        if (!condition) {
            throw new ManagedExtensionRecords.InvalidRecordException(message);
        }
    }
}
