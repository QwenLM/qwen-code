package com.alibaba.qwen.code.managedagent;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;

import com.alibaba.qwen.code.managedagent.store.ManagedExtensionProjection;
import com.alibaba.qwen.code.managedagent.store.ManagedExtensionRecords.InvalidRecordException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;

class ManagedMcpRecordContractTest {
    private static final ObjectMapper JSON = new ObjectMapper();

    @Test
    void validatesTheSharedRecordsAndStarts() throws IOException {
        JsonNode fixtures = fixtures();
        for (JsonNode fixture : fixtures.get("cases")) {
            String domain = fixture.get("domain").textValue();
            String id = fixture.get("id").textValue();
            var body = ManagedExtensionProjection.RECORD_BODIES.get(domain);
            JsonNode record = merge(fixtures.get("templates").get(domain), fixture.get("patch"));
            // Probe with the record, not an empty node: a mapping that
            // read the record could answer null for the empty one.
            assertNull(body.taskKindOf().apply(record), id);
            if (fixture.get("valid").booleanValue()) {
                body.require().accept(record);
            } else {
                assertThrows(InvalidRecordException.class, () -> body.require().accept(record), id);
            }
            assertEquals(fixture.get("start").booleanValue(), body.isStart().test(record), id);
        }
    }

    @Test
    void validatesTheSharedSuccessors() throws IOException {
        JsonNode fixtures = fixtures();
        for (JsonNode fixture : fixtures.get("successors")) {
            String domain = fixture.get("domain").textValue();
            JsonNode template = fixtures.get("templates").get(domain);
            assertEquals(fixture.get("valid").booleanValue(),
                    ManagedExtensionProjection.RECORD_BODIES.get(domain).isSuccessor().test(
                            merge(template, fixture.get("before")), merge(template, fixture.get("after"))),
                    fixture.get("id").textValue());
        }
    }

    static JsonNode fixtures() throws IOException {
        Path directory = Path.of("").toAbsolutePath();
        while (directory != null) {
            Path path = directory.resolve("packages/core/src/managed-runtime/contracts/managed-mcp-record-v1.fixtures.json");
            if (Files.exists(path)) {
                return JSON.readTree(Files.readString(path));
            }
            directory = directory.getParent();
        }
        throw new IOException("MCP contract fixtures not found");
    }

    static JsonNode merge(JsonNode base, JsonNode patch) {
        ObjectNode value = base == null || !base.isObject() ? JSON.createObjectNode() : base.deepCopy();
        patch.fields().forEachRemaining(entry -> value.set(entry.getKey(), entry.getValue().isObject()
                ? merge(value.get(entry.getKey()), entry.getValue()) : entry.getValue().deepCopy()));
        return value;
    }
}
