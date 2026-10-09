package com.alibaba.qwen.code.managedagent;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.alibaba.qwen.code.managedagent.store.ManagedExtensionProjection;
import com.alibaba.qwen.code.managedagent.store.ManagedExtensionRecords;
import com.alibaba.qwen.code.managedagent.store.ManagedExtensionRecords.InvalidRecordException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import org.junit.jupiter.api.Test;

class ManagedChildRunRecordContractTest {
    private static final ObjectMapper JSON = new ObjectMapper();

    @Test
    void pinsTheKeysAndStopReasonVocabulary() throws IOException {
        JsonNode fixtures = fixtures();
        assertEquals(List.of("commandRef", "exitCode", "exitSignal", "kind",
                "outputRef", "ownerScopeId", "run", "shellId",
                "startReceiptRef", "stopReason", "stopRequested"),
                jsonList(fixtures.required("keys")));
        assertEquals(List.of("commandRef", "kind", "ownerScopeId", "shellId"),
                jsonList(fixtures.required("fixedKeys")));
        JsonNode reasons = fixtures.required("stopReasons");
        for (String state : List.of("settled", "failed", "cancelled")) {
            assertEquals(ManagedExtensionRecords.CHILD_STOP_REASONS.get(state),
                    jsonList(reasons.required(state)), state);
        }
        assertEquals(List.of("childRunId", "childSessionId", "completion",
                "depth", "inputRef", "kind", "ownerScopeId",
                "predecessorChildRunId", "resultRef", "resultVersion",
                "rootSessionId", "run", "stopReason", "stopRequested",
                "terminalReceiptRef", "workingDirectory", "workspaceMode"),
                jsonList(fixtures.required("childAgentKeys")));
        assertEquals(List.of("childRunId", "completion", "depth", "inputRef",
                "kind", "ownerScopeId", "predecessorChildRunId",
                "rootSessionId", "workingDirectory", "workspaceMode"),
                jsonList(fixtures.required("childAgentFixedKeys")));
        JsonNode agentReasons = fixtures.required("childAgentStopReasons");
        for (String state : List.of("settled", "failed", "cancelled")) {
            assertEquals(ManagedExtensionRecords.CHILD_AGENT_STOP_REASONS
                    .get(state), jsonList(agentReasons.required(state)), state);
        }
    }

    private static List<String> jsonList(JsonNode node) {
        List<String> values = new java.util.ArrayList<>();
        node.forEach(each -> values.add(each.textValue()));
        return values;
    }

    @Test
    void validatesTheSharedRecordsAndStarts() throws IOException {
        JsonNode fixtures = fixtures();
        for (JsonNode fixture : fixtures.get("cases")) {
            String domain = fixture.get("domain").textValue();
            String template = fixture.hasNonNull("template")
                    ? fixture.get("template").textValue() : domain;
            String id = fixture.get("id").textValue();
            var body = ManagedExtensionProjection.RECORD_BODIES.get(domain);
            JsonNode base = java.util.Objects.requireNonNull(
                    fixtures.get("templates").get(template),
                    () -> "case " + id + " names an unknown template");
            JsonNode record = merge(base, fixture.get("patch"));
            // The kind the merged record carries decides the task kind, so
            // each valid case pins its own mapping.
            if (fixture.get("valid").booleanValue()) {
                assertEquals("shell".equals(record.get("kind").textValue())
                        ? "background_shell" : "child_agent",
                        body.taskKindOf().apply(record), id);
            }
            if (fixture.get("valid").booleanValue()) {
                body.require().accept(record);
            } else {
                InvalidRecordException refused = assertThrows(InvalidRecordException.class,
                        () -> body.require().accept(record), id);
                // Every invalid case names the clause that must refuse it,
                // so a masked guard can never slip a fixture green.
                assertTrue(refused.getMessage().contains(fixture.get("error").textValue()),
                        id + ": " + refused.getMessage());
            }
            assertEquals(fixture.get("start").booleanValue(), body.isStart().test(record), id);
        }
    }

    @Test
    void validatesTheSharedSuccessors() throws IOException {
        JsonNode fixtures = fixtures();
        for (JsonNode fixture : fixtures.get("successors")) {
            String domain = fixture.get("domain").textValue();
            String template = fixture.hasNonNull("template")
                    ? fixture.get("template").textValue() : domain;
            JsonNode base = java.util.Objects.requireNonNull(
                    fixtures.get("templates").get(template),
                    () -> "successor " + fixture.get("id").textValue()
                            + " names an unknown template");
            assertEquals(fixture.get("valid").booleanValue(),
                    ManagedExtensionProjection.RECORD_BODIES.get(domain).isSuccessor().test(
                            merge(base, fixture.get("before")), merge(base, fixture.get("after"))),
                    fixture.get("id").textValue());
        }
    }

    static JsonNode fixtures() throws IOException {
        Path directory = Path.of("").toAbsolutePath();
        while (directory != null) {
            Path path = directory.resolve("packages/core/src/managed-runtime/contracts/managed-child-run-record-v1.fixtures.json");
            if (Files.exists(path)) {
                return JSON.readTree(Files.readString(path));
            }
            directory = directory.getParent();
        }
        throw new IOException("Child run contract fixtures not found");
    }

    static JsonNode merge(JsonNode base, JsonNode patch) {
        ObjectNode value = base == null || !base.isObject() ? JSON.createObjectNode() : base.deepCopy();
        patch.fields().forEachRemaining(entry -> value.set(entry.getKey(), entry.getValue().isObject()
                ? merge(value.get(entry.getKey()), entry.getValue()) : entry.getValue().deepCopy()));
        return value;
    }
}
