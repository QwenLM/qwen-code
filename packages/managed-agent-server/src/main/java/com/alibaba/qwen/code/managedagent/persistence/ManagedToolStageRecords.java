package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.persistence.ManagedExtensionRecords.InvalidRecordException;
import com.fasterxml.jackson.databind.JsonNode;

import java.util.List;
import java.util.Set;
import java.util.function.BooleanSupplier;

/** One ordinary tool invocation produced by an extension command expansion. */
public final class ManagedToolStageRecords {
    private static final Set<String> KEYS = Set.of("kind", "toolStageId", "expansionId", "stepIndex", "toolName",
            "inputRef", "permissionRef", "resultRef", "run");
    private static final List<String> FIXED = List.of("kind", "toolStageId", "expansionId", "stepIndex", "toolName", "inputRef");

    private ManagedToolStageRecords() { }

    public static void requireStage(JsonNode record) {
        ManagedExtensionRecords.closed(record, KEYS, "Tool stage");
        require("tool_stage".equals(record.get("kind").textValue()), "Tool stage kind must be tool_stage");
        ManagedExtensionRecords.id(record.get("toolStageId"), "toolStageId");
        ManagedExtensionRecords.id(record.get("expansionId"), "expansionId");
        ManagedExtensionRecords.count(record.get("stepIndex"), 0, 9_007_199_254_740_991L, "stepIndex");
        String tool = ManagedExtensionRecords.oneOf(record.get("toolName"), List.of("read_file", "shell"), "toolName");
        ManagedExtensionRecords.durableRef(record.get("inputRef"), "inputRef");
        for (String field : List.of("permissionRef", "resultRef")) {
            if (!record.get(field).isNull()) {
                ManagedExtensionRecords.durableRef(record.get(field), field);
            }
        }
        JsonNode run = record.get("run");
        ManagedExtensionRecords.requireRun(run);
        require(!run.get("definition").isNull()
                && tool.equals(run.get("definition").get("definitionId").textValue()),
                "Tool stage must pin its ordinary tool definition");
        require(ManagedExtensionRecords.same(record.get("toolStageId"), run.get("executionCallId")),
                "Tool stage run must name its invocation");
    }

    public static boolean isStart(JsonNode record) {
        return accepts(() -> {
            requireStage(record);
            return record.get("resultRef").isNull() && ManagedExtensionRecords.isRunStart(record.get("run"));
        });
    }

    public static boolean isSuccessor(JsonNode before, JsonNode after) {
        return accepts(() -> {
            requireStage(before);
            requireStage(after);
            if (ManagedExtensionRecords.isTerminalRunState(before.get("run").get("state").textValue())) {
                return ManagedExtensionRecords.same(before, after);
            }
            for (String field : FIXED) {
                if (!ManagedExtensionRecords.same(before.get(field), after.get(field))) {
                    return false;
                }
            }
            for (String field : List.of("permissionRef", "resultRef")) {
                if (!before.get(field).isNull() && !ManagedExtensionRecords.same(before.get(field), after.get(field))) {
                    return false;
                }
            }
            return ManagedExtensionRecords.isRunSuccessor(before.get("run"), after.get("run"));
        });
    }

    private static boolean accepts(BooleanSupplier check) {
        try {
            return check.getAsBoolean();
        } catch (InvalidRecordException | NullPointerException | ClassCastException refused) {
            return false;
        }
    }

    private static void require(boolean condition, String message) {
        if (!condition) {
            throw new InvalidRecordException(message);
        }
    }
}
