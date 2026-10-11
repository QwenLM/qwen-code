package com.alibaba.qwen.code.managedagent;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.alibaba.qwen.code.managedagent.store.ManagedExtensionProjection;
import com.alibaba.qwen.code.managedagent.store.ManagedExtensionRecords.InvalidRecordException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * Replays the language-neutral managed-child-acceptance-record/1 fixtures
 * (H4a of #12827) that the TypeScript module replays too.
 */
class ManagedChildAcceptanceRecordContractTest {
    private static final ObjectMapper JSON = new ObjectMapper();

    @Test
    void pinsTheClosedAndFixedKeys() throws IOException {
        JsonNode fixtures = fixtures();
        assertEquals("managed-child-acceptance-record/1",
                fixtures.required("contract").textValue());
        assertEquals(List.of("childRunId", "contentDigest", "contentRef",
                "parentExecutionCallId", "parentScopeId", "resultVersion",
                "run", "terminalReceiptRef"),
                jsonList(fixtures.required("keys")));
        assertEquals(List.of("childRunId", "contentDigest", "contentRef",
                "parentExecutionCallId", "parentScopeId", "resultVersion",
                "terminalReceiptRef"),
                jsonList(fixtures.required("fixedKeys")));
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
            String id = fixture.get("id").textValue();
            var body = ManagedExtensionProjection.RECORD_BODIES
                    .get("child_acceptance");
            JsonNode record = merge(java.util.Objects.requireNonNull(
                    fixtures.get("templates").get("child_acceptance"),
                    () -> "case " + id + " names an unknown template"),
                    fixture.get("patch"));
            assertNull(body.taskKindOf().apply(record), id);
            if (fixture.get("valid").booleanValue()) {
                body.require().accept(record);
            } else {
                InvalidRecordException refused = assertThrows(
                        InvalidRecordException.class,
                        () -> body.require().accept(record), id);
                // Every invalid case names the clause that must refuse it,
                // so a masked guard can never slip a fixture green.
                assertTrue(refused.getMessage()
                        .contains(fixture.get("error").textValue()),
                        id + ": " + refused.getMessage());
            }
            assertEquals(fixture.get("start").booleanValue(),
                    body.isStart().test(record), id);
        }
    }

    @Test
    void validatesTheSharedSuccessors() throws IOException {
        JsonNode fixtures = fixtures();
        for (JsonNode fixture : fixtures.get("successors")) {
            JsonNode base = java.util.Objects.requireNonNull(
                    fixtures.get("templates").get("child_acceptance"),
                    () -> "successor " + fixture.get("id").textValue()
                            + " names an unknown template");
            assertEquals(fixture.get("valid").booleanValue(),
                    ManagedExtensionProjection.RECORD_BODIES
                            .get("child_acceptance").isSuccessor().test(
                                    merge(base, fixture.get("before")),
                                    merge(base, fixture.get("after"))),
                    fixture.get("id").textValue());
        }
    }

    static JsonNode fixtures() throws IOException {
        Path directory = Path.of("").toAbsolutePath();
        while (directory != null) {
            Path path = directory.resolve(
                    "packages/core/src/managed-runtime/contracts/managed-child-acceptance-record-v1.fixtures.json");
            if (Files.exists(path)) {
                return JSON.readTree(Files.readString(path));
            }
            directory = directory.getParent();
        }
        throw new IOException("Child acceptance contract fixtures not found");
    }

    static JsonNode merge(JsonNode base, JsonNode patch) {
        ObjectNode value = base == null || !base.isObject()
                ? JSON.createObjectNode() : base.deepCopy();
        patch.fields().forEachRemaining(entry -> value.set(entry.getKey(),
                entry.getValue().isObject()
                        ? merge(value.get(entry.getKey()), entry.getValue())
                        : entry.getValue().deepCopy()));
        return value;
    }
}
