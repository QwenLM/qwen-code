package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.managedagent.store.ManagedExtensionRecords.InvalidRecordException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.util.List;
import java.util.Set;
import java.util.function.BooleanSupplier;

/** Closed MCP domain bodies; the shared fixtures also run in TypeScript. */
public final class ManagedMcpRecords {
    private static final Set<String> CONFIG_KEYS = Set.of("configurationId",
            "runtimeSessionId", "serverId", "serverRevision", "configRevision", "catalogRevision",
            "connectionGeneration", "catalogRef", "releaseState", "run");
    private static final Set<String> OPERATION_KEYS = Set.of("operationId",
            "configurationId", "serverId", "serverRevision", "configRevision",
            "catalogRevision", "connectionGeneration", "operationKind",
            "argsRef", "resultRef", "cancelRequested", "run");
    private static final List<String> CONFIG_FIXED = List.of("configurationId",
            "runtimeSessionId", "serverId", "serverRevision", "configRevision");

    private ManagedMcpRecords() {
    }

    public static void requireConfiguration(JsonNode record) {
        ManagedExtensionRecords.closed(record, CONFIG_KEYS, "mcpConfiguration");
        pinnedRun(record);
        ManagedExtensionRecords.id(record.get("configurationId"), "configurationId");
        ManagedExtensionRecords.id(record.get("runtimeSessionId"), "runtimeSessionId");
        revision(record.get("configRevision"), "configRevision");
        JsonNode catalog = record.get("catalogRef");
        boolean published = !catalog.isNull();
        if (published) {
            ManagedExtensionRecords.durableRef(catalog, "catalogRef");
        }
        if (!record.get("catalogRevision").isNull()) {
            revision(record.get("catalogRevision"), "catalogRevision");
        }
        if (!record.get("connectionGeneration").isNull()) {
            revision(record.get("connectionGeneration"), "connectionGeneration");
        }
        JsonNode run = record.get("run");
        require(record.get("configurationId").equals(run.get("effectId"))
                && run.get("executionCallId").isNull(),
                "MCP configuration must identify its physical request through effectId");
        String release = record.get("releaseState").textValue();
        require(release != null && List.of("active", "releasing", "drained", "released")
                .contains(release), "Invalid MCP releaseState");
        require("active".equals(release) || canRelease(run),
                "Only a conclusively completed MCP configuration can be released");
        require(published == !record.get("catalogRevision").isNull()
                && published == !record.get("connectionGeneration").isNull()
                && published == "settled".equals(text(run, "state"))
                && (!published || "settled".equals(text(run, "execution"))
                        && !run.get("runtime").isNull()),
                "MCP configuration publishes its catalog and connection exactly on settlement");
    }

    public static void requireOperation(JsonNode record) {
        ManagedExtensionRecords.closed(record, OPERATION_KEYS, "mcpOperation");
        pinnedRun(record);
        String operationId = ManagedExtensionRecords.id(record.get("operationId"), "operationId");
        ManagedExtensionRecords.id(record.get("configurationId"), "configurationId");
        revision(record.get("configRevision"), "configRevision");
        revision(record.get("catalogRevision"), "catalogRevision");
        revision(record.get("connectionGeneration"), "connectionGeneration");
        String kind = text(record, "operationKind");
        require("resource_read".equals(kind) || "prompt_get".equals(kind),
                "MCP operationKind must be resource_read or prompt_get");
        JsonNode run = record.get("run");
        require(operationId.equals(text(run, "effectId"))
                && run.get("executionCallId").isNull(),
                "MCP operation must identify its physical request through effectId");
        ManagedExtensionRecords.durableRef(record.get("argsRef"), "argsRef");
        require(record.get("cancelRequested").isBoolean(), "MCP cancelRequested must be boolean");
        JsonNode result = record.get("resultRef");
        if (!result.isNull()) {
            ManagedExtensionRecords.durableRef(result, "resultRef");
        }
        require((!"settled".equals(text(run, "state")) || !result.isNull())
                && (result.isNull() || "settled".equals(text(run, "execution"))
                        && !run.get("runtime").isNull()),
                "MCP result requires a settled physical response; successful operations need a result");
    }

    public static boolean isConfigurationStart(JsonNode record) {
        return accepts(() -> {
            requireConfiguration(record);
            return ManagedExtensionRecords.isRunStart(record.get("run"));
        });
    }

    public static boolean isOperationStart(JsonNode record) {
        return accepts(() -> {
            requireOperation(record);
            return ManagedExtensionRecords.isRunStart(record.get("run"))
                    && record.get("resultRef").isNull()
                    && !record.get("cancelRequested").booleanValue();
        });
    }

    public static boolean isConfigurationSuccessor(JsonNode previous, JsonNode next) {
        return accepts(() -> {
            requireConfiguration(previous);
            requireConfiguration(next);
            String before = text(previous, "releaseState");
            String after = text(next, "releaseState");
            return CONFIG_FIXED.stream().allMatch(key -> same(previous.get(key), next.get(key)))
                    && ManagedExtensionRecords.isRunSuccessor(previous.get("run"), next.get("run"))
                    && (before.equals(after)
                            || canRelease(previous.get("run"))
                                    && "active".equals(before) && "releasing".equals(after)
                            || "releasing".equals(before) && "drained".equals(after)
                            || "drained".equals(before) && "released".equals(after)
                            || "releasing".equals(before) && "released".equals(after))
                    && (previous.get("catalogRef").isNull()
                            || same(without(previous, "releaseState"), without(next, "releaseState")));
        });
    }

    public static boolean isOperationSuccessor(JsonNode previous, JsonNode next) {
        return accepts(() -> {
            requireOperation(previous);
            requireOperation(next);
            return same(without(previous, "run", "resultRef", "cancelRequested"), without(next, "run", "resultRef", "cancelRequested"))
                    && ManagedExtensionRecords.isRunSuccessor(previous.get("run"), next.get("run"))
                    && (!previous.get("cancelRequested").booleanValue() || next.get("cancelRequested").booleanValue())
                    && (previous.get("resultRef").isNull() || same(previous.get("resultRef"), next.get("resultRef")))
                    && (!List.of("settled", "failed", "cancelled").contains(text(previous.get("run"), "state"))
                            || same(previous, next));
        });
    }

    private static void pinnedRun(JsonNode record) {
        String serverId = ManagedExtensionRecords.id(record.get("serverId"), "serverId");
        long serverRevision = revision(record.get("serverRevision"), "serverRevision");
        JsonNode run = record.get("run");
        ManagedExtensionRecords.requireRun(run);
        JsonNode definition = run.get("definition");
        require(!definition.isNull() && serverId.equals(text(definition, "definitionId"))
                && definition.get("definitionRevision").longValue() == serverRevision
                && run.get("delivery").isNull() && run.get("deliveryId").isNull()
                && run.get("dispatchId").isNull(),
                "MCP run must pin its server definition and have no delivery");
    }

    private static long revision(JsonNode value, String label) {
        return ManagedExtensionRecords.count(value, 1, Long.MAX_VALUE, label);
    }

    private static boolean canRelease(JsonNode run) {
        return "settled".equals(text(run, "execution"))
                && ("settled".equals(text(run, "state")) || "failed".equals(text(run, "state")))
                || "not_started_proven".equals(text(run, "execution"))
                        && "cancelled".equals(text(run, "state"));
    }

    private static String text(JsonNode record, String key) {
        return record.get(key).textValue();
    }

    private static boolean accepts(BooleanSupplier check) {
        try {
            return check.getAsBoolean();
        } catch (InvalidRecordException error) {
            return false;
        }
    }

    static boolean same(JsonNode left, JsonNode right) {
        return left.equals((a, b) -> a.isNumber() && b.isNumber()
                ? Double.compare(a.doubleValue(), b.doubleValue())
                : a.equals(b) ? 0 : 1, right);
    }

    private static JsonNode without(JsonNode record, String... keys) {
        ObjectNode copy = record.deepCopy();
        copy.remove(List.of(keys));
        return copy;
    }

    private static void require(boolean condition, String message) {
        if (!condition) {
            throw new InvalidRecordException(message);
        }
    }
}
