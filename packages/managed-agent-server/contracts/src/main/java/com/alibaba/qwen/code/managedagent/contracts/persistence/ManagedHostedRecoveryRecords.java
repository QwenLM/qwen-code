package com.alibaba.qwen.code.managedagent.contracts.persistence;

import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.StoredResource;
import com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceToolProfiles;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.repository.ManagedExtensionRecordStore;
import com.alibaba.qwen.code.runtimebroker.ManagedCheckpointHistory;
import com.fasterxml.jackson.databind.JsonNode;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Function;

/** The private Hosted continuation formats and their reference closure. */
public final class ManagedHostedRecoveryRecords {
    public static final Set<String> KINDS = Set.of("hosted-approval-continuation",
            "hosted-model-request", "hosted-turn-cleanup");

    public interface HistoricalResources extends Function<String, StoredResource> {
        public void checkpointHistory(JsonNode ref);
    }

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
        validateResource(stored, tenant, workspace, session, resources, new HashMap<>());
    }

    public static void validateResource(StoredResource stored, String tenant,
            String workspace, String session, Function<String, StoredResource> resources,
            Map<String, JsonNode> seen) {
        if (!KINDS.contains(stored.kind()) && !"managed-action-options".equals(stored.kind())) {
            return;
        }
        JsonNode body = ManagedExtensionRecordStore.parse(new String(stored.bytes(), StandardCharsets.UTF_8));
        require(body != null && stored.schemaVersion() == 1, "Invalid Hosted recovery resource.");
        if ("managed-action-options".equals(stored.kind()) && !body.has("continuationRef")) {
            return;
        }
        if (KINDS.contains(stored.kind())) {
            validateBody(stored.kind(), body, tenant, workspace, session, resources);
        }
        for (JsonNode ref : references(body)) {
            ManagedExtensionRecords.durableRef(ref, "Hosted nested reference");
            closure(ref, tenant, workspace, session, resources, seen);
        }
    }

    public static void validateEvent(String kind, JsonNode payload,
            String tenant, String workspace, String session,
            Function<String, StoredResource> resources) {
        validateEvent(kind, payload, tenant, workspace, session, resources, new HashMap<>());
    }

    public static void validateEvent(String kind, JsonNode payload,
            String tenant, String workspace, String session,
            Function<String, StoredResource> resources, Map<String, JsonNode> seen) {
        try {
            if ("hosted.batch.planned".equals(kind)) {
                ManagedExtensionRecords.closed(payload, Set.of("batchId", "planRevision", "planRef"), "batch plan");
                ManagedExtensionRecords.id(payload.get("batchId"), "batchId");
                ManagedExtensionRecords.count(payload.get("planRevision"), 1,
                        ManagedSessionStoreModels.MAX_SAFE_COUNTER, "planRevision");
                reference(payload.get("planRef"), "hosted-approval-continuation", tenant, workspace, session, resources, seen);
            } else if ("hosted.cleanup".equals(kind)) {
                ManagedExtensionRecords.closed(payload, Set.of("cleanupId", "descriptorRef", "state"), "cleanup");
                ManagedExtensionRecords.id(payload.get("cleanupId"), "cleanupId");
                ManagedExtensionRecords.oneOf(payload.get("state"), List.of("owed", "confirmed"), "cleanup state");
                reference(payload.get("descriptorRef"), "hosted-turn-cleanup", tenant, workspace, session, resources, seen);
            } else if ("model.attempt".equals(kind) && payload.has("recoveryRef")) {
                reference(payload.get("recoveryRef"), "hosted-model-request", tenant, workspace, session, resources, seen);
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
        reference(ref, expectedKind, tenant, workspace, session, resources, new HashMap<>());
    }

    public static void reference(JsonNode ref, String expectedKind,
            String tenant, String workspace, String session,
            Function<String, StoredResource> resources, Map<String, JsonNode> seen) {
        ManagedExtensionRecords.durableRef(ref, "Hosted recovery reference");
        require(ref.path("schemaVersion").asInt() == 1, "Unsupported Hosted recovery reference version.");
        require(expectedKind.equals(ref.path("kind").asText()), "Hosted recovery reference kind conflicts.");
        closure(ref, tenant, workspace, session, resources, seen);
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
            StoredResource stored = resolveResource(node, resources);
            if (ManagedCheckpointHistory.KIND.equals(stored.kind()) && resources instanceof HistoricalResources historical) {
                historical.checkpointHistory(node);
                return;
            }
            if (KINDS.contains(stored.kind()) || List.of("managed-action-options", "managed-checkpoint", ManagedCheckpointHistory.KIND, "managed-definition",
                    "managed-hook-plan", "managed-hook-message-chunks", "managed-message-chunks").contains(stored.kind())
                    || ManagedExtensionRecords.DOMAINS.stream().anyMatch(domain -> ("managed-" + domain).equals(stored.kind()))) {
                JsonNode body = ManagedExtensionRecordStore.parse(new String(stored.bytes(), StandardCharsets.UTF_8));
                require(body != null && stored.schemaVersion() == 1, "Invalid Hosted recovery resource.");
                if (KINDS.contains(stored.kind())) {
                    validateBody(stored.kind(), body, tenant, workspace, session, resources);
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

    private static StoredResource resolveResource(JsonNode ref, Function<String, StoredResource> resources) {
        StoredResource stored = resources.apply(ref.path("resourceId").asText());
        require(stored != null && stored.kind().equals(ref.path("kind").asText())
                && stored.schemaVersion() == ref.path("schemaVersion").asInt()
                && stored.byteLength() == ref.path("byteLength").asLong()
                && stored.digest().equals(ref.path("digest").asText()), "Hosted nested resource conflicts.");
        return stored;
    }

    private enum ShellContinuationLane {
        CONFINED_FOREGROUND,
        PUBLIC_FOREGROUND,
        PUBLIC_CAPTURE
    }

    private static ShellContinuationLane shellContinuationLane(JsonNode ref, Function<String, StoredResource> resources) {
        ManagedExtensionRecords.durableRef(ref, "Hosted Shell definition");
        require("managed-definition".equals(ref.path("kind").asText()) && ref.path("schemaVersion").asInt() == 1,
                "Invalid Hosted Shell definition reference.");
        StoredResource stored = resolveResource(ref, resources);
        JsonNode definition = ManagedExtensionRecordStore.parse(new String(stored.bytes(), StandardCharsets.UTF_8));
        require(definition != null, "Invalid Hosted Shell definition.");
        String profile = definition.path("toolProfile").asText();
        if (WorkspaceToolProfiles.CONFINED_SHELL.equals(profile)) {
            JsonNode foregroundOnly = definition.path("foregroundOnly");
            require(foregroundOnly.isBoolean() && foregroundOnly.booleanValue() && !definition.has("captureBytes"),
                    "Invalid confined Shell definition.");
            return ShellContinuationLane.CONFINED_FOREGROUND;
        }
        require(WorkspaceToolProfiles.isPublicShell(profile),
                "Native Shell continuation requires a public Shell profile.");
        if (definition.has("captureBytes")) {
            ManagedExtensionRecords.count(definition.get("captureBytes"), 1, ToolPublicationContract.MAX_CAPTURE_BYTES,
                    "Shell publication captureBytes");
            return ShellContinuationLane.PUBLIC_CAPTURE;
        }
        return ShellContinuationLane.PUBLIC_FOREGROUND;
    }

    private static String runtimeSessionId(String promptId) {
        return promptId.matches("[A-Za-z0-9._-]{1,512}") && !".".equals(promptId) && !promptId.contains("..")
                ? promptId : "wake-" + ToolPublicationContract.sha256(promptId.getBytes(StandardCharsets.UTF_8));
    }

    public static List<JsonNode> references(JsonNode body) {
        var refs = new ArrayList<JsonNode>();
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
        if (body.has("commandStep")) {
            refs.add(body.path("commandStep").path("inputRef"));
        }
        return refs;
    }

    private static void validateBody(String kind, JsonNode body, String tenant, String workspace, String session,
            Function<String, StoredResource> resources) {
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
            require(runtimeSessionId(body.get("promptId").asText()).equals(body.path("runtimeSessionId").asText())
                    && body.get("promptId").equals(body.get("fileHistoryTurnId")), "Cleanup owner conflicts.");
            generation(body.get("generation"));
            generation(body.get("workspaceGeneration"));
            return;
        }
        boolean model = "hosted-model-request".equals(kind);
        Set<String> fields = new HashSet<>(model
                ? Set.of("v", "sessionKey", "promptId", "definitionRef", "rootSnapshotRef", "sourceActivation",
                        "sourceBootId", "sourceEventEpoch", "messageId", "round", "throughSequence",
                        "pendingToolResults", "workspaceContext", "prepared", "requestDigest")
                : Set.of("v", "sessionKey", "promptId", "definitionRef", "rootSnapshotRef", "sourceActivation",
                        "runtime", "batchId", "assistantRef", "model", "round", "stage", "approvalOrdinal", "actionId", "calls"));
        if (!model && body.has("publicChildModel")) {
            fields.add("publicChildModel");
            JsonNode child = body.get("publicChildModel");
            ManagedExtensionRecords.closed(child, Set.of("modelId", "route"), "public child model");
            ManagedExtensionRecords.id(child.get("modelId"), "modelId");
            JsonNode route = child.get("route");
            Set<String> routeFields = new HashSet<>(Set.of("authType", "endpointDigest", "providerPin"));
            if (route.has("origin")) {
                routeFields.add("origin");
                JsonNode origin = route.get("origin");
                ManagedExtensionRecords.closed(origin, Set.of("modelId", "authType", "endpointDigest", "providerPin"), "public child model origin");
                ManagedExtensionRecords.id(origin.get("modelId"), "modelId");
                require(origin.path("authType").isTextual() && origin.path("authType").asText().matches("[a-z][a-z0-9_-]{0,63}"), "Invalid public child origin auth type.");
                for (String hash : List.of("endpointDigest", "providerPin")) {
                    require(origin.path(hash).isTextual() && origin.path(hash).asText().matches("[a-f0-9]{64}"), "Invalid public child origin digest.");
                }
            }
            ManagedExtensionRecords.closed(route, routeFields, "public child route");
            require(route.path("authType").isTextual() && route.path("authType").asText().matches("[a-z][a-z0-9_-]{0,63}"), "Invalid public child auth type.");
            for (String hash : List.of("endpointDigest", "providerPin")) {
                require(route.path(hash).isTextual() && route.path(hash).asText().matches("[a-f0-9]{64}"), "Invalid public child route digest.");
            }
        }
        if (!model && body.has("commandStep")) {
            fields.add("commandStep");
            JsonNode step = body.get("commandStep");
            ManagedExtensionRecords.closed(step, Set.of("toolStageId", "toolName", "inputRef", "configRevision"), "command step");
            ManagedExtensionRecords.id(step.get("toolStageId"), "toolStageId");
            ManagedExtensionRecords.oneOf(step.get("toolName"), List.of("read_file", "shell"), "command tool");
            ManagedExtensionRecords.count(step.get("configRevision"), 1, ManagedSessionStoreModels.MAX_SAFE_COUNTER, "command configuration revision");
            ManagedExtensionRecords.durableRef(step.get("inputRef"), "command input");
            require("managed-extension-command-input".equals(step.path("inputRef").path("kind").asText())
                    && step.path("inputRef").path("schemaVersion").asInt() == 1
                    && "approval".equals(body.path("stage").asText()), "Command continuation conflicts.");
        }
        ManagedExtensionRecords.closed(body, fields, "Hosted recovery descriptor");
        JsonNode source = body.get("sourceActivation");
        ManagedExtensionRecords.closed(source, Set.of("activationId", "epoch"), "source activation");
        ManagedExtensionRecords.id(source.get("activationId"), "activationId");
        ManagedExtensionRecords.count(source.get("epoch"), 1, ManagedSessionStoreModels.MAX_SAFE_COUNTER, "source epoch");
        ManagedExtensionRecords.count(body.get("round"), 0, ManagedSessionStoreModels.MAX_SAFE_COUNTER, "round");
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
            Set<String> preparedKeys = new HashSet<>(Set.of("request", "history", "completedToolCallIds",
                    "routeSelector", "providerPin", "promptTokensForClamp"));
            if (prepared.has("allowPersistentRetry")) {
                preparedKeys.add("allowPersistentRetry");
                require(prepared.get("allowPersistentRetry").isBoolean(), "Invalid model retry policy.");
            }
            if (prepared.has("contextPrefixLength")) {
                preparedKeys.add("contextPrefixLength");
                ManagedExtensionRecords.count(prepared.get("contextPrefixLength"), 0,
                        Math.min(5, prepared.path("history").size()), "contextPrefixLength");
            }
            ManagedExtensionRecords.closed(prepared, preparedKeys, "prepared model request");
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
            JsonNode calls = body.path("calls");
            require(calls.isArray() && !calls.isEmpty(), "Native batch is empty.");
            boolean hooksPlan = false;
            for (JsonNode call : calls) {
                hooksPlan |= call.has("hookResults");
            }
            JsonNode runtime = body.get("runtime");
            boolean memoryOnly = runtime != null && runtime.isNull();
            boolean durableOwner = false;
            String owner = null;
            if (memoryOnly) {
                require(!body.has("commandStep") && !body.has("publicChildModel") && !hooksPlan,
                        "Memory continuation cannot name Runtime work.");
            } else {
                Set<String> runtimeFields = new HashSet<>(Set.of("runtimeSessionId", "bindingId", "generation", "workspaceGeneration"));
                boolean providerPinned = runtime != null && runtime.has("provisionerKind");
                if (providerPinned) {
                    runtimeFields.add("provisionerKind");
                    ManagedExtensionRecords.oneOf(runtime.get("provisionerKind"), List.of("local-process"), "native Runtime provider");
                    require(!body.has("commandStep") && calls.size() == 1
                            && "ask_user_question".equals(calls.get(0).path("call").path("name").asText()),
                            "Native Runtime provider pin requires a single question.");
                }
                ManagedExtensionRecords.closed(runtime, runtimeFields, "native Runtime");
                owner = ManagedExtensionRecords.id(runtime.get("runtimeSessionId"), "native Runtime owner");
                if (body.has("commandStep")) {
                    require(!hooksPlan, "Command continuation cannot carry native Hook results.");
                } else {
                    boolean turnOwner = !hooksPlan && runtimeSessionId(body.get("promptId").asText()).equals(owner);
                    // The Harness verifies the exact reattached owner before replay.
                    durableOwner = !turnOwner && !providerPinned && owner.matches("(?:mcp|extensions-components)-[a-f0-9]{64}");
                    require(turnOwner || durableOwner, "Native Runtime owner conflicts.");
                }
                ManagedExtensionRecords.id(runtime.get("bindingId"), "bindingId");
                generation(runtime.get("generation"));
                generation(runtime.get("workspaceGeneration"));
            }
            ManagedExtensionRecords.count(body.get("approvalOrdinal"), 0, calls.size() - 1, "approvalOrdinal");
            ShellContinuationLane shellLane = null;
            for (JsonNode call : calls) {
                if (memoryOnly) {
                    require(Set.of("context_search", "context_remember", "context_get", "context_forget")
                            .contains(call.path("call").path("name").asText()), "Memory continuation contains another tool.");
                    String correlation = runtimeSessionId(body.get("promptId").asText());
                    require(correlation.equals(call.path("prepareReference").path("sessionId").asText())
                            && (correlation + ":" + call.path("runtimeCallId").asText()).equals(call.path("prepareKey").asText()),
                            "Memory continuation correlation conflicts.");
                }
                require(!body.has("commandStep") || "skill".equals(call.path("call").path("name").asText()), "Command continuation must resume its Skill call.");
                Set<String> callFields = new HashSet<>(Set.of("call", "runtimeCallId", "inputRef", "definitionRef",
                        "requestDigest", "argsDigest", "prepareKey", "prepareReference", "partIndex", "refusal", "actionId"));
                if (hooksPlan) {
                    callFields.add("hookResults");
                    validateHookResults(call.get("hookResults"));
                }
                if (durableOwner) {
                    JsonNode reference = call.path("prepareReference");
                    String callId = ManagedExtensionRecords.id(call.get("runtimeCallId"), "runtimeCallId");
                    require(owner.equals(reference.path("sessionId").asText())
                            && body.get("promptId").equals(reference.get("promptId"))
                            && callId.equals(reference.path("callId").asText())
                            && call.path("requestDigest").equals(reference.get("argsDigest"))
                            && (owner + ":" + callId).equals(call.path("prepareKey").asText()),
                            "Native Runtime correlation conflicts.");
                }
                boolean shell = "run_shell_command".equals(call.path("call").path("name").asText());
                if (shell && shellLane == null) {
                    shellLane = shellContinuationLane(body.get("definitionRef"), resources);
                }
                boolean hasPublicationIdentity = shell && shellLane != ShellContinuationLane.CONFINED_FOREGROUND;
                require(hasPublicationIdentity == call.has("publicationId"), "Invalid public Shell publication identity.");
                if (hasPublicationIdentity) {
                    callFields.add("publicationId");
                    JsonNode publication = call.get("publicationId");
                    require(shellLane == ShellContinuationLane.PUBLIC_CAPTURE
                            ? publication.isTextual() && publication.asText().matches("[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}")
                            : publication.isNull(), "Invalid public Shell publication identity.");
                }
                ManagedExtensionRecords.closed(call, callFields, "native batch member");
                ManagedExtensionRecords.durableRef(call.get("inputRef"), "inputRef");
                ManagedExtensionRecords.durableRef(call.get("definitionRef"), "definitionRef");
            }
        }
    }

    private static void validateHookResults(JsonNode results) {
        require(results != null && results.isArray(), "Invalid native Hook results.");
        List<String> events = List.of("PreToolUse", "PermissionRequest");
        int previous = -1;
        for (JsonNode result : results) {
            ManagedExtensionRecords.closed(result, Set.of("event", "resultDigest"), "native Hook result");
            int event = events.indexOf(result.path("event").asText());
            require(event > previous, "Invalid native Hook result order.");
            ManagedExtensionRecords.digest(result.get("resultDigest"), "native Hook result digest");
            previous = event;
        }
    }

    private static void generation(JsonNode node) {
        require(node != null && node.isTextual() && node.asText().matches("[1-9][0-9]{0,18}")
                && new BigInteger(node.asText()).compareTo(BigInteger.valueOf(Long.MAX_VALUE)) <= 0,
                "Invalid Runtime generation.");
    }

    private static void require(boolean value, String message) {
        if (!value) {
            throw rejected(message);
        }
    }

    private static ManagedAgentException rejected(String message) {
        return new ManagedAgentException(409, "managed_hosted_recovery_record_rejected", message);
    }
}
