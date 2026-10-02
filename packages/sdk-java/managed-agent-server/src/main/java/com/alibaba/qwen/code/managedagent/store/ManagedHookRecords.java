package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.managedagent.store.ManagedExtensionRecords.InvalidRecordException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.List;
import java.util.Set;
import java.util.function.BooleanSupplier;

/** Closed Hook domain bodies; TypeScript replays the same fixtures. */
public final class ManagedHookRecords {
    private static final Set<String> REGISTRATION_KEYS = Set.of("registrationId",
            "catalogId", "catalogRevision", "catalogRef", "run");
    private static final Set<String> EXECUTION_KEYS = Set.of("hookExecutionId",
            "occurrenceId", "runtimeSessionId", "registrationId", "eventName", "ordinal", "hookId",
            "planRef", "inputRef", "resultRef", "onceKey", "cancelRequested", "run");

    private ManagedHookRecords() {
    }

    /**
     * The identities Hook admission keeps unique, projected into indexed
     * columns. They never change across a record's revisions, so the first
     * revision's projection holds for every later one. Fields that do not
     * apply to the record's domain are null.
     */
    public record AdmissionKeys(String onceKeyHash, String occurrenceHash,
            Long ordinal, String definitionHash) {
    }

    /** The admission keys of a body that its domain's validator accepted. */
    public static AdmissionKeys admissionKeys(String domain, JsonNode record) {
        return switch (domain) {
            case "hook_registration" -> new AdmissionKeys(null, null, null,
                    definitionHash(record.get("run").get("definition")));
            case "hook_execution" -> new AdmissionKeys(
                    record.get("onceKey").isNull() ? null
                            : sha256(record.get("onceKey").textValue()),
                    sha256(record.get("occurrenceId").textValue()),
                    record.get("ordinal").longValue(), null);
            default -> new AdmissionKeys(null, null, null, null);
        };
    }

    /**
     * Two pins share this key exactly when their definition ID and revision
     * are the same, which is when their digests must agree. Identifiers
     * carry no control character, so the separator is unambiguous, and a
     * validated revision is an exact integer.
     */
    private static String definitionHash(JsonNode definition) {
        return sha256(definition.get("definitionId").textValue() + "\u0000"
                + definition.get("definitionRevision").longValue());
    }

    private static String sha256(String value) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(value.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException error) {
            throw new IllegalStateException("SHA-256 is unavailable", error);
        }
    }

    public static void requireRegistration(JsonNode record) {
        ManagedExtensionRecords.closed(record, REGISTRATION_KEYS, "hookRegistration");
        pinnedRun(record, "registrationId");
        String catalogId = ManagedExtensionRecords.id(record.get("catalogId"), "catalogId");
        long catalogRevision = ManagedExtensionRecords.count(record.get("catalogRevision"),
                1, Long.MAX_VALUE, "catalogRevision");
        ManagedExtensionRecords.durableRef(record.get("catalogRef"), "catalogRef");
        JsonNode run = record.get("run");
        JsonNode definition = run.get("definition");
        require(catalogId.equals(definition.get("definitionId").textValue())
                && catalogRevision == definition.get("definitionRevision").longValue()
                && run.get("execution").isNull(),
                "Hook registration must pin its catalog resource and have no execution");
    }

    public static void requireExecution(JsonNode record) {
        ManagedExtensionRecords.closed(record, EXECUTION_KEYS, "hookExecution");
        pinnedRun(record, "hookExecutionId");
        for (String key : List.of("occurrenceId", "runtimeSessionId", "registrationId", "eventName", "hookId")) {
            ManagedExtensionRecords.id(record.get(key), key);
        }
        ManagedExtensionRecords.count(record.get("ordinal"), 0, Long.MAX_VALUE, "ordinal");
        for (String key : List.of("planRef", "inputRef")) {
            ManagedExtensionRecords.durableRef(record.get(key), key);
        }
        if (!record.get("onceKey").isNull()) {
            ManagedExtensionRecords.id(record.get("onceKey"), "onceKey");
        }
        require(record.get("cancelRequested").isBoolean(), "Hook cancelRequested must be boolean");
        JsonNode run = record.get("run");
        require(!run.get("execution").isNull(), "Hook execution must have an execution state");
        JsonNode result = record.get("resultRef");
        if (!result.isNull()) {
            ManagedExtensionRecords.durableRef(result, "resultRef");
        }
        require((!"settled".equals(run.get("state").textValue()) || !result.isNull())
                && (result.isNull() || "settled".equals(run.get("execution").textValue())),
                "Hook result requires a settled execution; successful executions need a result");
    }

    public static boolean isRegistrationStart(JsonNode record) {
        return accepts(() -> {
            requireRegistration(record);
            return ManagedExtensionRecords.isRunStart(record.get("run"));
        });
    }

    public static boolean isExecutionStart(JsonNode record) {
        return accepts(() -> {
            requireExecution(record);
            return ManagedExtensionRecords.isRunStart(record.get("run"))
                    && record.get("resultRef").isNull() && !record.get("cancelRequested").booleanValue();
        });
    }

    public static boolean isRegistrationSuccessor(JsonNode previous, JsonNode next) {
        return accepts(() -> {
            requireRegistration(previous);
            requireRegistration(next);
            return !List.of("settled", "failed", "cancelled").contains(previous.get("run").get("state").textValue())
                    && ManagedMcpRecords.same(without(previous, "run"), without(next, "run"))
                    && ManagedExtensionRecords.isRunSuccessor(previous.get("run"), next.get("run"));
        });
    }

    public static boolean isExecutionSuccessor(JsonNode previous, JsonNode next) {
        return accepts(() -> {
            requireExecution(previous);
            requireExecution(next);
            return ManagedMcpRecords.same(without(previous, "run", "resultRef", "cancelRequested"),
                            without(next, "run", "resultRef", "cancelRequested"))
                    && ManagedExtensionRecords.isRunSuccessor(previous.get("run"), next.get("run"))
                    && (!previous.get("cancelRequested").booleanValue() || next.get("cancelRequested").booleanValue())
                    && (previous.get("resultRef").isNull() || ManagedMcpRecords.same(previous.get("resultRef"), next.get("resultRef")))
                    && (!List.of("settled", "failed", "cancelled").contains(previous.get("run").get("state").textValue())
                            || ManagedMcpRecords.same(previous, next));
        });
    }

    private static void pinnedRun(JsonNode record, String idField) {
        String id = ManagedExtensionRecords.id(record.get(idField), idField);
        JsonNode run = record.get("run");
        ManagedExtensionRecords.requireRun(run);
        require(!run.get("definition").isNull() && id.equals(run.get("effectId").textValue())
                && run.get("executionCallId").isNull() && run.get("dispatchId").isNull()
                && run.get("deliveryId").isNull() && run.get("delivery").isNull(),
                "Hook run must pin its catalog, identify its effect and have no delivery");
    }

    private static JsonNode without(JsonNode record, String... keys) {
        ObjectNode copy = record.deepCopy();
        copy.remove(List.of(keys));
        return copy;
    }

    private static boolean accepts(BooleanSupplier check) {
        try {
            return check.getAsBoolean();
        } catch (InvalidRecordException error) {
            return false;
        }
    }

    private static void require(boolean condition, String message) {
        if (!condition) {
            throw new InvalidRecordException(message);
        }
    }
}
