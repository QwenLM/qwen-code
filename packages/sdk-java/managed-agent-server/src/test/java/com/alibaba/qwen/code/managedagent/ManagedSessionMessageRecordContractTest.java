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
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import org.junit.jupiter.api.Test;

/**
 * Replays the language-neutral managed-session-message-record/1 fixtures
 * (H4d of #12827) that the TypeScript module replays too.
 */
class ManagedSessionMessageRecordContractTest {
    private static final ObjectMapper JSON = new ObjectMapper();

    @Test
    void pinsTheClosedAndFixedKeys() throws IOException {
        JsonNode fixtures = fixtures();
        assertEquals("managed-session-message-record/1",
                fixtures.required("contract").textValue());
        assertEquals(List.of("childRunId", "contentDigest", "contentRef",
                "direction", "inputId", "messageId", "route", "run",
                "senderSessionId", "targetSessionId"),
                jsonList(fixtures.required("keys")));
        assertEquals(List.of("childRunId", "contentDigest", "contentRef",
                "direction", "messageId", "route", "senderSessionId"),
                jsonList(fixtures.required("fixedKeys")));
    }

    @Test
    void validatesTheSharedRecordsAndStarts() throws IOException {
        JsonNode fixtures = fixtures();
        var body = ManagedExtensionProjection.RECORD_BODIES
                .get("session_message");
        for (JsonNode fixture : fixtures.get("cases")) {
            String id = fixture.get("id").textValue();
            JsonNode record = merge(template(fixtures, fixture),
                    fixture.get("patch"));
            if (fixture.get("valid").booleanValue()) {
                body.require().accept(record);
                assertNull(body.taskKindOf().apply(record), id);
                assertEquals(record.get("messageId").textValue(),
                        body.recordId().apply(record), id);
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
            JsonNode base = template(fixtures, fixture);
            assertEquals(fixture.get("valid").booleanValue(),
                    ManagedExtensionProjection.RECORD_BODIES
                            .get("session_message").isSuccessor().test(
                                    merge(base, fixture.get("before")),
                                    merge(base, fixture.get("after"))),
                    fixture.get("id").textValue());
        }
    }

    private static JsonNode template(JsonNode fixtures, JsonNode fixture) {
        return Objects.requireNonNull(fixtures.get("templates")
                .get(fixture.get("template").textValue()),
                () -> fixture.get("id").textValue()
                        + " names an unknown template");
    }

    private static List<String> jsonList(JsonNode node) {
        List<String> values = new ArrayList<>();
        node.forEach(each -> values.add(each.textValue()));
        return values;
    }

    static JsonNode fixtures() throws IOException {
        Path directory = Path.of("").toAbsolutePath();
        while (directory != null) {
            Path path = directory.resolve(
                    "packages/core/src/managed-runtime/contracts/managed-session-message-record-v1.fixtures.json");
            if (Files.exists(path)) {
                return JSON.readTree(Files.readString(path));
            }
            directory = directory.getParent();
        }
        throw new IOException("Session message contract fixtures not found");
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
