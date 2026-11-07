package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.CommitResource;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.CommitTransactionRequest;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedUserQuestions;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStore;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.UUID;

final class ActionJournal {
    private static final ObjectMapper JSON = new ObjectMapper();
    final String id = "tool_approval_" + UUID.randomUUID().toString().replace("-", "");
    final ObjectNode options;
    private final ExtensionRecordJournal journal;
    private final String tenant;
    private final String session;
    private final List<CommitResource> questionResources = new ArrayList<>();
    private byte[] input;
    private int changes;

    ActionJournal(
            ManagedSessionStore store, String tenant, String session, long created, long expiry) {
        this(
                new ExtensionRecordJournal(store, tenant, "workspace-actions", session).open(),
                created,
                expiry, tenant, session);
    }

    ActionJournal(ActionJournal previous, long created, long expiry) {
        this(previous.journal, created, expiry, previous.tenant, previous.session);
    }

    private ActionJournal(ExtensionRecordJournal journal, long created, long expiry, String tenant, String session) {
        this.journal = journal;
        this.tenant = tenant;
        this.session = session;
        options =
                JSON.createObjectNode()
                        .put("v", 1)
                        .put("requestId", id)
                        .put("turnId", "turn-actions")
                        .put("functionCallId", "call-actions")
                        .put("toolName", "write_file")
                        .put("policyRevision", "hosted-tool-approval/1")
                        .put("inputRevision", 1)
                        .put("createdAt", created)
                        .put("expiresAt", expiry);
        options.putArray("options").addObject().put("id", "allow").put("label", "Allow");
        options.withArray("options").addObject().put("id", "deny").put("label", "Deny");
    }

    ActionJournal withInput(byte[] bytes) {
        input = bytes;
        options.put("v", 2);
        options.set("inputRef", reference(bytes, "managed-tool-input"));
        return this;
    }

    ActionJournal withQuestions(JsonNode questions) {
        ObjectNode payload = JSON.createObjectNode().put("toolName", "ask_user_question");
        payload.set("input", questions);
        withInput(ExtensionRecordJournal.bytes(JSON.createObjectNode().put("harnessSessionId", session)
                .put("runtimeSessionId", "turn-actions").put("payloadJson", payload.toString())));
        ObjectNode definition = questionResource("managed-definition", JSON.createObjectNode().put("fixture", "definition"));
        ObjectNode continuation = JSON.createObjectNode().put("v", 1).put("promptId", "turn-actions")
                .put("batchId", "batch-question").put("model", "model").put("round", 0)
                .put("stage", "approval").put("approvalOrdinal", 0).put("actionId", id);
        continuation.putObject("sessionKey").put("tenantId", tenant).put("workspaceId", "workspace-actions").put("sessionId", session);
        continuation.putObject("sourceActivation").put("activationId", "activation-actions").put("epoch", 1);
        continuation.putObject("runtime").put("runtimeSessionId", "turn-actions").put("bindingId", "binding")
                .put("generation", "1").put("workspaceGeneration", "1");
        continuation.set("definitionRef", definition);
        continuation.set("rootSnapshotRef", questionResource("managed-checkpoint", JSON.createObjectNode().put("fixture", "snapshot")));
        continuation.set("assistantRef", questionResource("managed-message", JSON.createObjectNode().put("fixture", "assistant")));
        ObjectNode call = continuation.putArray("calls").addObject().put("runtimeCallId", "runtime-call")
                .put("requestDigest", "digest").put("argsDigest", "digest").put("prepareKey", "prepare")
                .put("prepareReference", "reference").put("partIndex", 0).put("actionId", id);
        call.putNull("refusal");
        call.putObject("call").put("name", "ask_user_question").put("callId", "call-actions");
        call.set("inputRef", options.get("inputRef"));
        call.set("definitionRef", definition);
        options.put("v", 4).put("toolName", "ask_user_question").put("policyRevision", ManagedUserQuestions.POLICY)
                .put("requiresHumanDecision", true);
        options.remove("options");
        options.set("questions", ManagedUserQuestions.questionsFromInput(questions));
        options.set("continuationRef", questionResource("hosted-approval-continuation", continuation));
        return this;
    }

    private ObjectNode questionResource(String kind, JsonNode body) {
        byte[] bytes = ExtensionRecordJournal.bytes(body);
        questionResources.add(resource(bytes, kind));
        return reference(bytes, kind);
    }

    CommitTransactionRequest request(String state, JsonNode response) throws Exception {
        byte[] bytes = ExtensionRecordJournal.bytes(options);
        byte[] decision =
                response == null
                        ? null
                        : ManagedUserQuestions.isQuestion(options)
                                ? ManagedUserQuestions.decisionJson(response).getBytes(StandardCharsets.UTF_8)
                                : ExtensionRecordJournal.bytes(
                                JSON.createObjectNode()
                                        .put("v", 1)
                                        .put("optionId", response.path("optionId").asText())
                                        .put(
                                                "inputRevision",
                                                response.path("inputRevision").asLong())
                                        .put(
                                                "policyRevision",
                                                response.path("policyRevision").asText()));
        CommitTransactionRequest original =
                journal.request(
                        "changeAction",
                        id + ":change-" + changes,
                        bytes,
                        options.path("createdAt").asLong(),
                        event -> {
                            event.put("kind", "action.changed");
                            // The authority assigns action.changed event ids
                            // as action:<requestId>:<state>; the extension
                            // journal's <domain>:<n> shape is reserved.
                            event.put("eventId", "action:" + id + ":" + state);
                            if ("requested".equals(state)) {
                                event.putObject("subject")
                                        .put("type", "activation")
                                        .put("scopeId", "activation-actions")
                                        .put("activationId", "activation-actions")
                                        .put("epoch", 1);
                            }
                            ObjectNode ref = (ObjectNode) event.path("payload").path("recordRef");
                            ref.put("kind", "managed-action-options");
                            ObjectNode payload =
                                    event.putObject("payload")
                                            .put("requestId", id)
                                            .put("kind", ManagedUserQuestions.isQuestion(options) ? "question" : "permission")
                                            .put("source", "tool_call")
                                            .put("inputRevision", 1)
                                            .put("state", state);
                            payload.set("optionsRef", ref);
                            if (decision == null) {
                                payload.putNull("decisionRef");
                            } else {
                                payload.set(
                                        "decisionRef",
                                        reference(decision, "managed-action-decision"));
                            }
                        },
                        records -> records);
        List<CommitResource> resources = new ArrayList<>();
        resources.addAll(questionResources);
        resources.add(resource(bytes, "managed-action-options"));
        if (input != null) {
            resources.add(resource(input, "managed-tool-input"));
        }
        if (decision != null) {
            resources.add(resource(decision, "managed-action-decision"));
        }
        ObjectNode request = JSON.valueToTree(original);
        request.set("resources", JSON.valueToTree(resources));
        return JSON.treeToValue(request, CommitTransactionRequest.class);
    }

    void change(String state, JsonNode response) throws Exception {
        CommitTransactionRequest request = request(state, response);
        journal.commit(request);
        journal.committed(request);
        changes++;
    }

    private static ObjectNode reference(byte[] bytes, String kind) {
        return JSON.createObjectNode()
                .put("resourceId", ExtensionRecordJournal.resourceId(bytes))
                .put("kind", kind)
                .put("schemaVersion", 1)
                .put("byteLength", bytes.length)
                .put("digest", ExtensionRecordJournal.sha256(bytes));
    }

    private static CommitResource resource(byte[] bytes, String kind) {
        return new CommitResource(
                ExtensionRecordJournal.resourceId(bytes),
                kind,
                1,
                bytes.length,
                ExtensionRecordJournal.sha256(bytes),
                Base64.getEncoder().encodeToString(bytes));
    }
}
