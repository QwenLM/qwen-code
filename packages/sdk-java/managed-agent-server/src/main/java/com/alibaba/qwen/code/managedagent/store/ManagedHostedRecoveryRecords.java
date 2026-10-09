package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.StoredResource;
import com.fasterxml.jackson.databind.JsonNode;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Function;
import org.springframework.http.HttpStatus;

/** The private Hosted continuation formats and their reference closure. */
public final class ManagedHostedRecoveryRecords {
    public static final Set<String> KINDS = Set.of("hosted-approval-continuation",
            "hosted-model-request", "hosted-turn-cleanup");

    private ManagedHostedRecoveryRecords() {}

    public static boolean requiresVersionTwo(byte[] records,
            List<ManagedSessionStoreModels.CommitResource> resources) {
        for (var resource : resources == null ? List.<ManagedSessionStoreModels.CommitResource>of() : resources) {
            if (KINDS.contains(resource.kind())) {
                return true;
            }
        }
        for (String line : new String(records, StandardCharsets.UTF_8).split("\n")) {
            JsonNode record = ManagedExtensionRecordStore.parse(line);
            if (record == null) {
                continue;
            }
            JsonNode event = record.path("managedSession");
            String kind = event.path("kind").asText();
            if (List.of("hosted.batch.planned", "hosted.cleanup").contains(kind)
                    || "model.attempt".equals(kind) && event.path("payload").has("recoveryRef")
                    || "message.retracted".equals(kind) && event.path("payload").has("throughSequence")) {
                return true;
            }
        }
        return false;
    }

    public static void validateResource(StoredResource stored, String tenant,
            String workspace, String session, Function<String, StoredResource> resources) {
        if (!KINDS.contains(stored.kind()) && !"managed-action-options".equals(stored.kind())) {
            return;
        }
        JsonNode body = ManagedExtensionRecordStore.parse(new String(stored.bytes(), StandardCharsets.UTF_8));
        require(body != null && stored.schemaVersion() == 1, "Invalid Hosted recovery resource.");
        if ("managed-action-options".equals(stored.kind()) && body.path("v").asInt() != 3) {
            return;
        }
        if (KINDS.contains(stored.kind())) {
            validateBody(stored.kind(), body, tenant, workspace, session);
        }
        var seen = new HashMap<String, JsonNode>();
        for (JsonNode ref : references(body)) {
            ManagedExtensionRecords.durableRef(ref, "Hosted nested reference");
            closure(ref, tenant, workspace, session, resources, seen);
        }
    }

    public static void validateEvent(String kind, JsonNode payload,
            String tenant, String workspace, String session,
            Function<String, StoredResource> resources) {
        try {
            if ("hosted.batch.planned".equals(kind)) {
                ManagedExtensionRecords.closed(payload, Set.of("batchId", "planRevision", "planRef"), "batch plan");
                ManagedExtensionRecords.id(payload.get("batchId"), "batchId");
                ManagedExtensionRecords.count(payload.get("planRevision"), 1,
                        ManagedSessionStoreModels.MAX_SAFE_COUNTER, "planRevision");
                reference(payload.get("planRef"), "hosted-approval-continuation", tenant, workspace, session, resources);
            } else if ("hosted.cleanup".equals(kind)) {
                ManagedExtensionRecords.closed(payload, Set.of("cleanupId", "descriptorRef", "state"), "cleanup");
                ManagedExtensionRecords.id(payload.get("cleanupId"), "cleanupId");
                ManagedExtensionRecords.oneOf(payload.get("state"), List.of("owed", "confirmed"), "cleanup state");
                reference(payload.get("descriptorRef"), "hosted-turn-cleanup", tenant, workspace, session, resources);
            } else if ("model.attempt".equals(kind) && payload.has("recoveryRef")) {
                reference(payload.get("recoveryRef"), "hosted-model-request", tenant, workspace, session, resources);
            } else if ("message.retracted".equals(kind)) {
                int fields = 0;
                for (String field : List.of("sourceBootId", "sourceEventEpoch", "throughSequence")) {
                    fields += payload.has(field) ? 1 : 0;
                }
                require(fields == 0 || fields == 3, "Retraction source fields must be present together.");
                if (fields == 3) {
                    ManagedExtensionRecords.closed(payload, Set.of("messageId", "turnId", "fromSequence",
                            "sourceBootId", "sourceEventEpoch", "throughSequence"), "retraction");
                    for (String field : List.of("messageId", "turnId", "sourceBootId", "sourceEventEpoch")) {
                        ManagedExtensionRecords.id(payload.get(field), field);
                    }
                    long from = ManagedExtensionRecords.count(payload.get("fromSequence"), 1,
                            ManagedSessionStoreModels.MAX_SAFE_COUNTER, "fromSequence");
                    ManagedExtensionRecords.count(payload.get("throughSequence"), from,
                            ManagedSessionStoreModels.MAX_SAFE_COUNTER, "throughSequence");
                }
            }
        } catch (IllegalArgumentException error) {
            throw rejected(error.getMessage());
        }
    }

    public static void reference(JsonNode ref, String expectedKind,
            String tenant, String workspace, String session,
            Function<String, StoredResource> resources) {
        ManagedExtensionRecords.durableRef(ref, "Hosted recovery reference");
        require(ref.path("schemaVersion").asInt() == 1, "Unsupported Hosted recovery reference version.");
        require(expectedKind.equals(ref.path("kind").asText()), "Hosted recovery reference kind conflicts.");
        closure(ref, tenant, workspace, session, resources, new HashMap<>());
    }

    private static void closure(JsonNode node, String tenant, String workspace,
            String session, Function<String, StoredResource> resources, Map<String, JsonNode> seen) {
        if (node == null || node.isNull()) {
            return;
        }
        if (node.isObject() && node.has("resourceId") && node.has("kind")
                && node.has("schemaVersion") && node.has("byteLength") && node.has("digest")) {
            ManagedExtensionRecords.durableRef(node, "Hosted nested reference");
            String id = node.get("resourceId").asText();
            JsonNode previous = seen.putIfAbsent(id, node);
            require(previous == null || previous.equals(node), "Conflicting Hosted nested reference.");
            if (previous != null) {
                return;
            }
            require(seen.size() <= ManagedSessionStoreModels.MAX_RESOURCES_PER_TRANSACTION, "Hosted reference closure is too large.");
            StoredResource stored = resources.apply(id);
            require(stored.kind().equals(node.get("kind").asText())
                    && stored.schemaVersion() == node.get("schemaVersion").asInt()
                    && stored.byteLength() == node.get("byteLength").asLong()
                    && stored.digest().equals(node.get("digest").asText()), "Hosted nested resource conflicts.");
            if (KINDS.contains(stored.kind()) || List.of("managed-action-options", "managed-checkpoint",
                    "managed-hook-plan", "managed-hook-message-chunks", "managed-message-chunks").contains(stored.kind())
                    || ManagedExtensionRecords.DOMAINS.stream().anyMatch(domain -> ("managed-" + domain).equals(stored.kind()))) {
                JsonNode body = ManagedExtensionRecordStore.parse(new String(stored.bytes(), StandardCharsets.UTF_8));
                require(body != null && stored.schemaVersion() == 1, "Invalid Hosted recovery resource.");
                if (KINDS.contains(stored.kind())) {
                    validateBody(stored.kind(), body, tenant, workspace, session);
                }
                if (KINDS.contains(stored.kind())) {
                    for (JsonNode ref : references(body)) {
                        ManagedExtensionRecords.durableRef(ref, "Hosted nested reference");
                        closure(ref, tenant, workspace, session, resources, seen);
                    }
                } else {
                    closure(body, tenant, workspace, session, resources, seen);
                }
            }
            return;
        }
        for (JsonNode child : node) {
            closure(child, tenant, workspace, session, resources, seen);
        }
    }

    private static List<JsonNode> references(JsonNode body) {
        var refs = new java.util.ArrayList<JsonNode>();
        for (String field : List.of("definitionRef", "rootSnapshotRef", "assistantRef", "inputRef", "continuationRef")) {
            if (body.hasNonNull(field)) {
                refs.add(body.get(field));
            }
        }
        if (body.path("calls").isArray()) {
            for (JsonNode call : body.get("calls")) {
                refs.add(call.path("inputRef"));
                refs.add(call.path("definitionRef"));
            }
        }
        return refs;
    }

    private static void validateBody(String kind, JsonNode body, String tenant, String workspace, String session) {
        ManagedExtensionRecords.count(body.get("v"), 1, 1, "Hosted recovery version");
        JsonNode key = body.get("sessionKey");
        ManagedExtensionRecords.closed(key, Set.of("tenantId", "workspaceId", "sessionId"), "Hosted recovery Session key");
        for (String field : List.of("tenantId", "workspaceId", "sessionId")) {
            ManagedExtensionRecords.id(key.get(field), field);
        }
        require(tenant.equals(key.get("tenantId").asText()) && workspace.equals(key.get("workspaceId").asText())
                && session.equals(key.get("sessionId").asText()), "Hosted recovery resource names another Session.");
        ManagedExtensionRecords.id(body.get("promptId"), "promptId");
        if ("hosted-turn-cleanup".equals(kind)) {
            ManagedExtensionRecords.closed(body, Set.of("v", "sessionKey", "promptId", "runtimeSessionId",
                    "bindingId", "generation", "workspaceGeneration", "fileHistoryTurnId"), "cleanup descriptor");
            ManagedExtensionRecords.id(body.get("bindingId"), "bindingId");
            for (String field : List.of("runtimeSessionId", "fileHistoryTurnId")) {
                require(body.get("promptId").equals(body.get(field)), "Cleanup owner conflicts.");
            }
            generation(body.get("generation"));
            generation(body.get("workspaceGeneration"));
            return;
        }
        boolean model = "hosted-model-request".equals(kind);
        ManagedExtensionRecords.closed(body, model
                ? Set.of("v", "sessionKey", "promptId", "definitionRef", "rootSnapshotRef", "sourceActivation",
                        "sourceBootId", "sourceEventEpoch", "messageId", "round", "throughSequence",
                        "pendingToolResults", "workspaceContext", "prepared", "requestDigest")
                : Set.of("v", "sessionKey", "promptId", "definitionRef", "rootSnapshotRef", "sourceActivation",
                        "runtime", "batchId", "assistantRef", "model", "round", "stage", "approvalOrdinal", "actionId", "calls"),
                "Hosted recovery descriptor");
        JsonNode source = body.get("sourceActivation");
        ManagedExtensionRecords.closed(source, Set.of("activationId", "epoch"), "source activation");
        ManagedExtensionRecords.id(source.get("activationId"), "activationId");
        ManagedExtensionRecords.count(source.get("epoch"), 1, ManagedSessionStoreModels.MAX_SAFE_COUNTER, "source epoch");
        ManagedExtensionRecords.count(body.get("round"), 0, 15, "round");
        for (String field : List.of("definitionRef", "rootSnapshotRef")) {
            ManagedExtensionRecords.durableRef(body.get(field), field);
        }
        if (model) {
            for (String field : List.of("sourceBootId", "sourceEventEpoch", "messageId")) {
                ManagedExtensionRecords.id(body.get(field), field);
            }
            ManagedExtensionRecords.count(body.get("throughSequence"), 1, ManagedSessionStoreModels.MAX_SAFE_COUNTER, "throughSequence");
            require(body.get("pendingToolResults").isBoolean()
                    && (body.get("workspaceContext").isNull() || body.get("workspaceContext").isTextual()), "Invalid model context.");
            require(body.get("requestDigest").isTextual() && body.get("requestDigest").asText().matches("[a-f0-9]{64}"), "Invalid model digest.");
            JsonNode prepared = body.get("prepared");
            ManagedExtensionRecords.closed(prepared, Set.of("request", "history", "completedToolCallIds",
                    "routeSelector", "providerPin", "promptTokensForClamp"), "prepared model request");
            ManagedExtensionRecords.closed(prepared.get("request"), Set.of("model", "contents", "config"), "model request");
            ManagedExtensionRecords.id(prepared.get("routeSelector"), "routeSelector");
            ManagedExtensionRecords.id(prepared.path("request").get("model"), "model");
            require(prepared.path("history").isArray() && prepared.path("completedToolCallIds").isArray()
                    && prepared.path("request").path("contents").isArray() && prepared.path("request").path("config").isObject()
                    && prepared.path("providerPin").isTextual() && prepared.path("providerPin").asText().matches("[a-f0-9]{64}"), "Invalid prepared request.");
            ManagedExtensionRecords.count(prepared.get("promptTokensForClamp"), 0, ManagedSessionStoreModels.MAX_SAFE_COUNTER, "promptTokensForClamp");
            for (String field : List.of("abortSignal", "httpOptions", "apiKey", "headers", "authorization")) {
                require(!prepared.path("request").path("config").has(field), "Prepared request contains authentication or transport state.");
            }
        } else {
            ManagedExtensionRecords.durableRef(body.get("assistantRef"), "assistantRef");
            for (String field : List.of("batchId", "model")) {
                ManagedExtensionRecords.id(body.get(field), field);
            }
            ManagedExtensionRecords.oneOf(body.get("stage"), List.of("approval", "final"), "stage");
            JsonNode runtime = body.get("runtime");
            ManagedExtensionRecords.closed(runtime, Set.of("runtimeSessionId", "bindingId", "generation", "workspaceGeneration"), "native Runtime");
            require(body.get("promptId").equals(runtime.get("runtimeSessionId")), "Native Runtime owner conflicts.");
            ManagedExtensionRecords.id(runtime.get("bindingId"), "bindingId");
            generation(runtime.get("generation"));
            generation(runtime.get("workspaceGeneration"));
            require(body.path("calls").isArray() && !body.path("calls").isEmpty(), "Native batch is empty.");
            ManagedExtensionRecords.count(body.get("approvalOrdinal"), 0, body.path("calls").size() - 1, "approvalOrdinal");
            for (JsonNode call : body.get("calls")) {
                ManagedExtensionRecords.closed(call, Set.of("call", "runtimeCallId", "inputRef", "definitionRef",
                        "requestDigest", "argsDigest", "prepareKey", "prepareReference", "partIndex", "refusal", "actionId"), "native batch member");
                ManagedExtensionRecords.durableRef(call.get("inputRef"), "inputRef");
                ManagedExtensionRecords.durableRef(call.get("definitionRef"), "definitionRef");
            }
        }
    }

    private static void generation(JsonNode node) {
        require(node != null && node.isTextual() && node.asText().matches("[1-9][0-9]{0,18}")
                && new java.math.BigInteger(node.asText()).compareTo(java.math.BigInteger.valueOf(Long.MAX_VALUE)) <= 0,
                "Invalid Runtime generation.");
    }

    private static void require(boolean value, String message) {
        if (!value) {
            throw rejected(message);
        }
    }

    private static ApiException rejected(String message) {
        return new ApiException(HttpStatus.CONFLICT, "managed_hosted_recovery_record_rejected", message);
    }
}
