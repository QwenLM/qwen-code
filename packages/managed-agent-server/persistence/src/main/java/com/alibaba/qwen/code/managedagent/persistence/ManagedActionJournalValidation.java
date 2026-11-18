package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.StoredResource;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedUserQuestions;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.repository.ManagedExtensionRecordStore;
import com.fasterxml.jackson.databind.JsonNode;

import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Set;
import java.util.function.Function;

final class ManagedActionJournalValidation {
    private ManagedActionJournalValidation() { }

    static void validateQuestionResources(String sessionId, JsonNode options, Function<String, StoredResource> resources) {
        require("ask_user_question".equals(options.path("toolName").asText())
                && options.path("requiresHumanDecision").isBoolean() && options.path("requiresHumanDecision").booleanValue());
        JsonNode input = read(new String(resource(options.path("inputRef"), "managed-tool-input", resources).bytes(), StandardCharsets.UTF_8));
        closed(input, "harnessSessionId", "runtimeSessionId", "payloadJson");
        require(sessionId.equals(input.path("harnessSessionId").asText()) && text(input.path("payloadJson")));
        JsonNode payload = read(input.path("payloadJson").textValue());
        closed(payload, "toolName", "input");
        require("ask_user_question".equals(payload.path("toolName").asText()));
        try {
            require(ManagedUserQuestions.questionsFromInput(payload.get("input")).equals(options.path("questions")));
        } catch (IllegalArgumentException error) {
            require(false);
        }
        JsonNode continuation = read(new String(resource(options.path("continuationRef"), "hosted-approval-continuation", resources).bytes(), StandardCharsets.UTF_8));
        JsonNode call = continuation.path("calls").path(0);
        require(continuation.path("calls").size() == 1 && continuation.path("approvalOrdinal").asInt(-1) == 0
                && "approval".equals(continuation.path("stage").asText())
                && continuation.path("actionId").equals(options.path("requestId"))
                && continuation.path("promptId").equals(options.path("turnId"))
                && input.path("runtimeSessionId").equals(continuation.path("runtime").path("runtimeSessionId"))
                && call.path("inputRef").equals(options.path("inputRef"))
                && call.path("actionId").equals(options.path("requestId"))
                && call.path("call").path("callId").equals(options.path("functionCallId"))
                && "ask_user_question".equals(call.path("call").path("name").asText()));
    }

    static boolean validAnswers(JsonNode options, JsonNode answers) {
        try {
            return ManagedUserQuestions.canonicalAnswers(options.path("questions"), answers, false).equals(answers);
        } catch (IllegalArgumentException error) {
            return false;
        }
    }

    static StoredResource resource(
            JsonNode ref, String kind, Function<String, StoredResource> resources) {
        closed(ref, "resourceId", "kind", "schemaVersion", "byteLength", "digest");
        require(
                text(ref.path("resourceId"))
                        && kind.equals(ref.path("kind").asText())
                        && safeNumber(ref.path("schemaVersion"))
                        && ref.path("schemaVersion").asLong() == 1
                        && safeNumber(ref.path("byteLength"))
                        && ref.path("digest").asText().matches("[0-9a-f]{64}"));
        StoredResource resource = resources.apply(ref.path("resourceId").asText());
        require(
                resource != null
                        && kind.equals(resource.kind())
                        && resource.schemaVersion() == 1
                        && resource.byteLength() == ref.path("byteLength").asLong()
                        && resource.digest().equals(ref.path("digest").asText()));
        return resource;
    }

    static void closed(JsonNode value, String... fields) {
        require(value.isObject());
        Set<String> actual = new HashSet<>();
        value.fieldNames().forEachRemaining(actual::add);
        require(actual.equals(Set.of(fields)));
    }

    static boolean safeNumber(JsonNode value) {
        return value.isIntegralNumber()
                && value.canConvertToLong()
                && value.asLong() >= 0
                && value.asLong() <= 9007199254740991L;
    }

    static boolean text(JsonNode value) {
        return value.isTextual() && !value.asText().isBlank();
    }

    static JsonNode read(String value) {
        JsonNode result = ManagedExtensionRecordStore.parse(value);
        require(result != null);
        return result;
    }

    static void require(boolean valid) {
        if (!valid) {
            throw new ManagedAgentException(
                    400,
                    "managed_session_action_rejected",
                    "The Action journal record is invalid.");
        }
    }
}
