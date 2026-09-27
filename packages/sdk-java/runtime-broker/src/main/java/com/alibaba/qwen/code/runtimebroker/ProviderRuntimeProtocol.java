package com.alibaba.qwen.code.runtimebroker;

import java.util.Map;
import java.util.List;
import java.util.Set;

/** The prepared-invocation contract, separate from raw Tool v2 references. */
final class ProviderRuntimeProtocol {
    static final String NAME = "managed-runtime-provider/1";
    static final String PATH = "/internal/managed-runtime/provider/v1/control";
    static final int CONTROL_LIMIT_BYTES = 1024 * 1024;
    static final int HISTORY_LIMIT_BYTES = 8 * 1024 * 1024;
    private static final Set<String> IDENTITY_FIELDS = Set.of("sessionId",
            "promptId", "callId", "capabilityDigest", "policyRevision");
    private static final Set<String> REFERENCE_FIELDS = Set.of("sessionId",
            "promptId", "callId", "capabilityDigest", "policyRevision",
            "invocationId", "argsDigest");

    private ProviderRuntimeProtocol() {
    }

    static boolean isReference(Map<String, Object> reference) {
        return reference != null && reference.keySet().equals(REFERENCE_FIELDS);
    }

    static void reference(Map<String, Object> reference, String sessionId) {
        identity(reference, REFERENCE_FIELDS, sessionId);
    }

    static void control(Map<String, Object> operation, String harnessSessionId, String sessionId) {
        String kind = string(operation, "kind");
        Set<String> required;
        Set<String> optional = Set.of();
        switch (kind) {
            case "manifest", "history" -> required = Set.of("kind");
            case "begin-turn" -> required = Set.of("kind", "identity");
            case "prepare" -> {
                required = Set.of("kind", "identity", "toolName", "input");
                optional = Set.of("modification", "mediaContext");
                string(operation, "toolName");
                object(operation.get("input"));
            }
            case "confirmation", "preflight" ->
                required = Set.of("kind", "reference");
            case "confirm" -> {
                required = Set.of("kind", "reference", "outcome");
                optional = Set.of("payload", "phase");
                if (!Set.of("proceed_once", "proceed_once_and_switch_to_default",
                        "proceed_always", "proceed_always_tool", "proceed_always_server",
                        "proceed_always_project", "proceed_always_user", "cancel", "modify_with_editor")
                        .contains(string(operation, "outcome"))) {
                    throw invalid();
                }
                if (operation.containsKey("phase")
                        && !"permission".equals(operation.get("phase"))
                        && !"preflight".equals(operation.get("phase"))) {
                    throw invalid();
                }
            }
            case "bind-history" -> {
                required = Set.of("kind", "binding");
                Map<String, Object> binding = object(operation.get("binding"));
                if (!sessionId.equals(string(binding, "ownerRuntimeSessionId"))
                        || !harnessSessionId.equals(string(binding, "ownerSessionId"))
                        || !Set.of("ownerSessionId", "ownerRuntimeSessionId", "executionCwd",
                                "executionContext", "snapshots").containsAll(binding.keySet())
                        || !(binding.get("executionCwd") instanceof String)
                        || !(binding.get("snapshots") instanceof List)) {
                    throw invalid();
                }
            }
            case "checkpoint" -> {
                required = Set.of("kind", "promptId");
                string(operation, "promptId");
            }
            default -> throw invalid();
        }
        if (!operation.keySet().containsAll(required)) {
            throw invalid();
        }
        for (String key : operation.keySet()) {
            if (!required.contains(key) && !optional.contains(key)) {
                throw invalid();
            }
        }
        if (operation.containsKey("identity")) {
            identity(object(operation.get("identity")), IDENTITY_FIELDS, sessionId);
        }
        if (operation.containsKey("reference")) {
            reference(object(operation.get("reference")), sessionId);
        }
        if (operation.containsKey("modification")) {
            Map<String, Object> modification = object(operation.get("modification"));
            if (!modification.keySet().equals(Set.of("source", "newContent"))
                    || !(modification.get("newContent") instanceof String)) {
                throw invalid();
            }
            reference(object(modification.get("source")), sessionId);
        }
        if (operation.containsKey("mediaContext")) {
            Map<String, Object> media = object(operation.get("mediaContext"));
            Map<String, Object> modalities = object(media.get("inputModalities"));
            if (!media.keySet().equals(Set.of("inputModalities"))
                    || !Set.of("image", "pdf", "audio", "video").containsAll(modalities.keySet())
                    || modalities.values().stream().anyMatch(value -> !(value instanceof Boolean))) {
                throw invalid();
            }
        }
        if (operation.containsKey("payload")) {
            Map<String, Object> payload = object(operation.get("payload"));
            if (!Set.of("newContent", "cancelMessage", "permissionRules", "answers", "updatedInput")
                    .containsAll(payload.keySet())) {
                throw invalid();
            }
            for (String field : Set.of("newContent", "cancelMessage")) {
                if (payload.containsKey(field) && !(payload.get(field) instanceof String)) {
                    throw invalid();
                }
            }
            if (payload.containsKey("permissionRules")) {
                if (!(payload.get("permissionRules") instanceof List<?> rules)
                        || rules.stream().anyMatch(value -> !(value instanceof String))) {
                    throw invalid();
                }
            }
            if (payload.containsKey("updatedInput")) {
                object(payload.get("updatedInput"));
            }
            if (payload.containsKey("answers")
                    && object(payload.get("answers")).values().stream()
                            .anyMatch(value -> !(value instanceof String))) {
                throw invalid();
            }
        }
    }

    static int limit(String kind) {
        return Set.of("bind-history", "checkpoint", "history").contains(kind)
                ? HISTORY_LIMIT_BYTES : CONTROL_LIMIT_BYTES;
    }

    private static void identity(Map<String, Object> identity,
            Set<String> fields, String sessionId) {
        if (identity == null || !identity.keySet().equals(fields)) {
            throw invalid();
        }
        for (String field : fields) {
            string(identity, field);
        }
        if (!sessionId.equals(identity.get("sessionId"))
                || !string(identity, "sessionId").matches(
                        "(?i)[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")
                || string(identity, "promptId").length() > 128
                || string(identity, "policyRevision").length() > 256
                || !string(identity, "capabilityDigest").matches("[a-f0-9]{64}")
                || fields.contains("invocationId") && (string(identity, "invocationId").length() > 128
                        || !string(identity, "argsDigest").matches("[a-f0-9]{64}"))) {
            throw invalid();
        }
    }

    private static String string(Map<String, Object> object, String field) {
        Object value = object == null ? null : object.get(field);
        if (!(value instanceof String text) || text.isEmpty()
                || text.length() > 512 || text.indexOf('\0') >= 0) {
            throw invalid();
        }
        try {
            return BrokerValues.requireWellFormed(text, field);
        } catch (IllegalArgumentException malformed) {
            throw invalid();
        }
    }

    static Map<String, Object> object(Object value) {
        if (!(value instanceof Map<?, ?>)) {
            throw invalid();
        }
        @SuppressWarnings("unchecked")
        Map<String, Object> result = (Map<String, Object>) value;
        return result;
    }

    private static RuntimeBrokerException invalid() {
        return new RuntimeBrokerException(400, "runtime_control_operation_invalid",
                "Runtime provider operation or identity is invalid.", false);
    }
}
