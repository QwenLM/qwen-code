package com.alibaba.qwen.code.runtimebroker;

import java.util.Map;
import java.util.List;
import java.util.Set;
import java.util.regex.Pattern;

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
    // Mirrors SESSION_ID_PATTERN / DIGEST_PATTERN in core's
    // managed-tool-protocol.ts; the case-insensitive flag is load-bearing.
    private static final Pattern SESSION_ID = Pattern.compile(
            "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}",
            Pattern.CASE_INSENSITIVE);
    private static final Pattern DIGEST = Pattern.compile("[a-f0-9]{64}");
    private static final Set<String> CONFIRM_OUTCOMES = Set.of("proceed_once",
            "proceed_once_and_switch_to_default", "proceed_always", "proceed_always_tool",
            "proceed_always_server", "proceed_always_project", "proceed_always_user",
            "cancel", "modify_with_editor");
    private static final Set<String> BINDING_FIELDS = Set.of("ownerSessionId",
            "ownerRuntimeSessionId", "executionCwd", "executionContext", "snapshots");
    private static final Set<String> PAYLOAD_FIELDS = Set.of("newContent", "cancelMessage",
            "permissionRules", "answers", "updatedInput");
    private static final Set<String> PAYLOAD_TEXT_FIELDS = Set.of("newContent", "cancelMessage");
    private static final Set<String> HISTORY_KINDS = Set.of("bind-history", "checkpoint",
            "history");

    private ProviderRuntimeProtocol() {
    }

    static boolean isReference(Map<String, Object> reference) {
        return reference != null && reference.keySet().equals(REFERENCE_FIELDS);
    }

    static void reference(Map<String, Object> reference, String sessionId) {
        identity(reference, REFERENCE_FIELDS, sessionId);
    }

    static void control(Map<String, Object> operation, String harnessSessionId, String sessionId) {
        // The JSON writer would send an unpaired surrogate as '?', so a key or
        // string of the input could reach the Worker, and run, as another.
        if (!BrokerValues.isWellFormedJson(operation)) {
            throw invalid();
        }
        String kind = string(operation, "kind");
        Set<String> required;
        Set<String> optional = Set.of();
        switch (kind) {
            case "raw-file-history" -> {
                String action = string(operation, "action");
                switch (action) {
                    case "bind" -> {
                        required = Set.of("kind", "action", "state");
                        if (operation.get("state") != null
                                && !harnessSessionId.equals(object(operation.get("state")).get("ownerSessionId"))) {
                            throw invalid();
                        }
                    }
                    case "prepare" -> {
                        required = Set.of("kind", "action", "promptId", "paths");
                        if (string(operation, "promptId").length() > 128
                                || !(operation.get("paths") instanceof List<?> paths)
                                || paths.isEmpty() || paths.stream().anyMatch(value -> !(value instanceof String))) {
                            throw invalid();
                        }
                    }
                    case "rewind" -> {
                        required = Set.of("kind", "action", "promptId");
                        string(operation, "promptId");
                    }
                    case "snapshot" -> required = Set.of("kind", "action");
                    default -> throw invalid();
                }
            }
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
                if (!CONFIRM_OUTCOMES.contains(string(operation, "outcome"))) {
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
                        || !BINDING_FIELDS.containsAll(binding.keySet())
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
            if (!PAYLOAD_FIELDS.containsAll(payload.keySet())) {
                throw invalid();
            }
            for (String field : PAYLOAD_TEXT_FIELDS) {
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
        return HISTORY_KINDS.contains(kind)
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
        String identitySession = string(identity, "sessionId");
        String promptId = string(identity, "promptId");
        String policyRevision = string(identity, "policyRevision");
        String capabilityDigest = string(identity, "capabilityDigest");
        if (!sessionId.equals(identitySession)
                || !SESSION_ID.matcher(identitySession).matches()
                || promptId.length() > 128
                || policyRevision.length() > 256
                || !DIGEST.matcher(capabilityDigest).matches()) {
            throw invalid();
        }
        if (fields.contains("invocationId")) {
            String invocationId = string(identity, "invocationId");
            String argsDigest = string(identity, "argsDigest");
            if (invocationId.length() > 128 || !DIGEST.matcher(argsDigest).matches()) {
                throw invalid();
            }
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
