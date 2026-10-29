package com.alibaba.qwen.code.runtimebroker.transport;

import com.alibaba.qwen.code.runtimebroker.BrokerValues;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.RuntimeSession;
import com.alibaba.qwen.code.runtimebroker.ManagedExtensionExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.provisioning.ManagedContextProtocol;

import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Narrow Hosted controls; executable settings are added only by the Java preparation gateway. */
public final class ManagedExtensionProtocol {
    static final String PATH = "/internal/managed-runtime/v3/extensions";
    static final int REQUEST_LIMIT = 512 * 1024;
    static final int RESPONSE_LIMIT = 8 * 1024 * 1024;
    private static final Set<String> KINDS = Set.of("extension-prepare", "extension-activate", "extension-status", "extension-reconcile",
            "extension-asset-read", "extension-asset-glob");

    private ManagedExtensionProtocol() { }

    public static boolean isOperation(Map<String, Object> operation) {
        return operation.get("kind") instanceof String kind && KINDS.contains(kind);
    }

    public static boolean isRecovery(Map<String, Object> operation) {
        return "extension-status".equals(operation.get("kind")) || "extension-reconcile".equals(operation.get("kind"));
    }

    public static void requireBoundInput(RuntimeSession session, Object input) {
        if (!(input instanceof Map<?, ?> fields) || !fields.containsKey("managedExtension")) {
            return;
        }
        if (!ManagedExtensionExecutionProfile.admits(session.getScope().getCapabilityDigest())
                || !(fields.get("managedExtension") instanceof Map<?, ?> extension)
                || !extension.keySet().equals(Set.of("harnessSessionId", "configRevision", "pin"))
                || !session.getHarnessSessionId().equals(extension.get("harnessSessionId"))
                || !counter(extension.get("configRevision"), 1)
                || !(extension.get("pin") instanceof Map<?, ?> pin)
                || !pin.keySet().containsAll(Set.of("extensionId", "packageRevision", "packageDigest"))
                || !Set.of("extensionId", "packageRevision", "packageDigest", "settingsRevision").containsAll(pin.keySet())
                || !(pin.get("extensionId") instanceof String id) || !id.matches("ext_[a-f0-9-]{36}")
                || !counter(pin.get("packageRevision"), 1) || !digest(pin.get("packageDigest"))
                || pin.containsKey("settingsRevision") && !counter(pin.get("settingsRevision"), 1)) {
            throw invalid();
        }
    }

    public static void validateOperation(Map<String, Object> operation) {
        if (!BrokerValues.isWellFormedJson(operation) || !isOperation(operation)
                || !(operation.get("operationId") instanceof String operationId)
                || !operationId.matches("(?i)[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}")) {
            throw invalid();
        }
        String kind = (String) operation.get("kind");
        if ("extension-prepare".equals(kind)) {
            if (!operation.keySet().equals(Set.of("kind", "operationId", "command", "expectedRevision", "extensions",
                    "baseMcpServers", "baseHookCatalog"))
                    || !(operation.get("command") instanceof Map<?, ?> command)
                    || !command.keySet().containsAll(Set.of("operationId", "actorKey", "expectedRevision", "extensions"))
                    || !Set.of("operationId", "actorKey", "expectedRevision", "extensions", "mcpChange").containsAll(command.keySet())
                    || !operationId.equals(command.get("operationId"))
                    || !(command.get("actorKey") instanceof String actor) || !actor.matches("[a-f0-9]{64}")
                    || !counter(operation.get("expectedRevision"), 0)
                    || BrokerValues.exactLong(operation.get("expectedRevision")) == 9_007_199_254_740_991L
                    || !java.util.Objects.equals(operation.get("expectedRevision"), command.get("expectedRevision"))
                    || !java.util.Objects.equals(operation.get("extensions"), command.get("extensions"))
                    || !(operation.get("extensions") instanceof List<?> pins) || pins.size() > 32
                    || !(operation.get("baseMcpServers") instanceof List<?> servers) || servers.size() > 32
                    || operation.get("baseHookCatalog") != null && !(operation.get("baseHookCatalog") instanceof Map)) {
                throw invalid();
            }
            Set<String> identities = new HashSet<>();
            for (Object item : pins) {
                if (!(item instanceof Map<?, ?> pin)
                        || !Set.of("extensionId", "packageRevision", "packageDigest", "settingsRevision").containsAll(pin.keySet())
                        || !(pin.get("extensionId") instanceof String id) || !id.matches("ext_[a-f0-9-]{36}")
                        || !identities.add(id) || !counter(pin.get("packageRevision"), 1)
                        || !(pin.get("packageDigest") instanceof String digest) || !digest.matches("[a-f0-9]{64}")
                        || pin.containsKey("settingsRevision") && !counter(pin.get("settingsRevision"), 1)) {
                    throw invalid();
                }
            }
            mcpPins(servers, false);
            if (operation.get("baseHookCatalog") instanceof Map<?, ?> hook
                    && (!hook.keySet().equals(Set.of("catalogId", "catalogRevision", "definitionDigest"))
                    || !identity(hook.get("catalogId")) || !counter(hook.get("catalogRevision"), 1)
                    || !digest(hook.get("definitionDigest")))) {
                throw invalid();
            }
            if (command.containsKey("mcpChange")) {
                mcpChange(command.get("mcpChange"));
            }
        } else if ("extension-activate".equals(kind) || "extension-reconcile".equals(kind)) {
            if (!operation.keySet().equals(Set.of("kind", "operationId", "expectedRevision", "revision"))
                    || !counter(operation.get("expectedRevision"), 0) || !counter(operation.get("revision"), 1)
                    || ((Number) operation.get("revision")).longValue() != ((Number) operation.get("expectedRevision")).longValue() + 1) {
                throw invalid();
            }
        } else if ("extension-status".equals(kind)) {
            if (!operation.keySet().equals(Set.of("kind", "operationId"))) {
                throw invalid();
            }
        } else {
            String field = "extension-asset-read".equals(kind) ? "path" : "pattern";
            if (!operation.keySet().equals(Set.of("kind", "operationId", "revision", "extensionId", field))
                    || !counter(operation.get("revision"), 1)
                    || !(operation.get("extensionId") instanceof String id) || !id.matches("ext_[a-f0-9-]{36}")
                    || !(operation.get(field) instanceof String path) || path.isEmpty() || path.length() > 4096
                    || path.indexOf('\0') >= 0 || path.startsWith("/") || path.contains("\\")
                    || java.util.Arrays.stream(path.split("/", -1)).anyMatch(segment -> segment.equals(".."))) {
                throw invalid();
            }
        }
    }

    static Map<String, Object> response(byte[] bytes, RuntimeScope scope, String harnessSessionId, Map<String, Object> request) {
        Map<String, Object> envelope = ManagedContextProtocol.parse(bytes);
        Map<String, Object> sessionKey = Map.of("tenantId", scope.getTenantId(), "workspaceId", scope.getWorkspaceId(),
                "sessionId", harnessSessionId);
        if (!envelope.keySet().equals(Set.of("protocolVersion", "sessionKey", "result"))
                || !Integer.valueOf(1).equals(envelope.get("protocolVersion"))
                || !sessionKey.equals(envelope.get("sessionKey"))
                || !(envelope.get("result") instanceof Map<?, ?> result)
                || !request.get("operationId").equals(result.get("operationId"))) {
            throw invalidResponse();
        }
        if (!String.valueOf(request.get("kind")).startsWith("extension-asset-")) {
            if (!(result.get("state") instanceof String state)
                    || !("extension-reconcile".equals(request.get("kind"))
                            ? Set.of("stopped", "outcome_unknown") : Set.of("prepared", "active", "failed", "outcome_unknown")).contains(state)
                    || !counter(result.get("revision"), 0)
                    || !(result.get("executionMode") instanceof String mode)
                    || !ManagedExtensionExecutionProfile.mode(scope.getCapabilityDigest()).equals(mode)) {
                throw invalidResponse();
            }
            if (("extension-activate".equals(request.get("kind")) || "extension-reconcile".equals(request.get("kind")))
                    && !java.util.Objects.equals(BrokerValues.exactLong(request.get("revision")), BrokerValues.exactLong(result.get("revision")))) {
                throw invalidResponse();
            }
            if ("extension-reconcile".equals(request.get("kind")) && "stopped".equals(result.get("state"))) {
                if (!(result.get("receipts") instanceof List<?> receipts) || receipts.isEmpty() || receipts.size() > 100_000) {
                    throw invalidResponse();
                }
                Set<String> owners = new HashSet<>();
                boolean coverage = false;
                for (Object receipt : receipts) {
                    if (!(receipt instanceof Map<?, ?> proof)
                            || !proof.keySet().containsAll(Set.of("ownerId", "sessionId", "configRevision", "mode", "scope", "state"))
                            || !Set.of("ownerId", "sessionId", "configRevision", "mode", "scope", "state", "coverage", "journalId").containsAll(proof.keySet())
                            || !(proof.get("ownerId") instanceof String id) || id.isBlank() || !owners.add(id)
                            || !harnessSessionId.equals(proof.get("sessionId")) || !counter(proof.get("configRevision"), 1)
                            || BrokerValues.exactLong(proof.get("configRevision")) > BrokerValues.exactLong(result.get("revision"))
                            || !result.get("executionMode").equals(proof.get("mode"))
                            || !("linux-cgroup".equals(proof.get("mode")) ? "process_tree" : "process_group").equals(proof.get("scope"))
                            || !"stopped".equals(proof.get("state"))) {
                        throw invalidResponse();
                    }
                    if (proof.containsKey("coverage") || proof.containsKey("journalId")) {
                        if (coverage || !"registered-owners".equals(proof.get("coverage"))
                                || !(proof.get("journalId") instanceof String journalId) || journalId.isBlank()) {
                            throw invalidResponse();
                        }
                        coverage = true;
                    }
                }
                if (!coverage) {
                    throw invalidResponse();
                }
            }
        }
        @SuppressWarnings("unchecked")
        Map<String, Object> value = (Map<String, Object>) result;
        return BrokerValues.immutableMap(value);
    }

    private static boolean counter(Object value, long minimum) {
        Long number = BrokerValues.exactLong(value);
        return number != null && number >= minimum && number <= 9_007_199_254_740_991L;
    }

    private static void mcpChange(Object value) {
        if (!(value instanceof Map<?, ?> change)
                || !change.keySet().equals(Set.of("action", "serverId", "expectedRevision", "servers"))
                || !Set.of("add", "edit", "remove", "enable", "disable", "reload", "restart").contains(String.valueOf(change.get("action")))
                || !identity(change.get("serverId")) || !counter(change.get("expectedRevision"), 0)
                || !(change.get("servers") instanceof List<?> servers) || servers.size() > 32) {
            throw invalid();
        }
        mcpPins(servers, true);
        if (servers.stream().noneMatch(item -> change.get("serverId").equals(((Map<?, ?>) item).get("serverId")))) {
            throw invalid();
        }
    }

    private static void mcpPins(List<?> servers, boolean selection) {
        Set<String> ids = new HashSet<>();
        int enabled = 0;
        for (Object item : servers) {
            if (!(item instanceof Map<?, ?> pin)
                    || !pin.keySet().equals(selection ? Set.of("serverId", "serverRevision", "definitionDigest", "state")
                            : Set.of("serverId", "serverRevision", "definitionDigest"))
                    || !identity(pin.get("serverId")) || !ids.add((String) pin.get("serverId"))
                    || !counter(pin.get("serverRevision"), 1) || !digest(pin.get("definitionDigest"))
                    || selection && !Set.of("enabled", "disabled", "removed").contains(String.valueOf(pin.get("state")))) {
                throw invalid();
            }
            if ("enabled".equals(pin.get("state")) && ++enabled > 16) {
                throw invalid();
            }
        }
    }

    private static boolean identity(Object value) {
        return value instanceof String text && text.matches("[A-Za-z0-9._:-]{1,128}");
    }

    private static boolean digest(Object value) {
        return value instanceof String text && text.matches("[a-f0-9]{64}");
    }

    private static RuntimeBrokerException invalidResponse() {
        return new RuntimeBrokerException(502, "managed_extension_response_invalid", "Invalid Managed extension Runtime response.", false);
    }

    private static RuntimeBrokerException invalid() {
        return new RuntimeBrokerException(400, "runtime_control_operation_invalid", "Invalid Managed extension control.", false);
    }
}
