package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedConfigInstall;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedExtensionRecords;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.*;

class ManagedConfigInstallContractTest {
    private static final ObjectMapper JSON = new ObjectMapper();

    @Test
    void consumesEverySharedValidAndInvalidContentWithoutBroadeningTheClosedRecord() throws IOException {
        JsonNode fixtures = fixtures();
        assertEquals(1, fixtures.required("schemaVersion").intValue());
        for (JsonNode fixture : fixtures.required("valid")) {
            assertDoesNotThrow(() -> ManagedConfigInstall.require(record(fixture.required("content"), 1)), fixture.path("name").asText());
        }
        for (JsonNode fixture : fixtures.required("invalid")) {
            assertThrows(ManagedExtensionRecords.InvalidRecordException.class,
                    () -> ManagedConfigInstall.require(record(fixture.required("content"), 1)), fixture.path("name").asText());
        }
        for (JsonNode fixture : fixtures.required("legacy")) {
            assertFalse(ManagedConfigInstall.isPackageConfig(fixture.required("content")), fixture.path("name").asText());
        }
    }

    @Test
    void permitsStagedCommitAndEnableButRejectsSkippingOrRewritingAcknowledgedContent() throws IOException {
        ObjectNode preparing = record(content("nullable_preparing"), 1);
        ObjectNode prepared = record(content("prepared"), 2);
        ObjectNode committed = record(content("prepared"), 3).put("phase", "committed");
        ObjectNode active = record(content("active"), 4);
        assertDoesNotThrow(() -> ManagedConfigInstall.successor(null, preparing));
        assertDoesNotThrow(() -> ManagedConfigInstall.successor(preparing, prepared));
        assertDoesNotThrow(() -> ManagedConfigInstall.successor(prepared, committed));
        assertDoesNotThrow(() -> ManagedConfigInstall.successor(committed, active));
        assertThrows(ManagedExtensionRecords.InvalidRecordException.class, () -> ManagedConfigInstall.successor(prepared, active));
        ObjectNode changed = committed.deepCopy();
        ((ObjectNode) changed.path("bundleRef")).put("digest", "c".repeat(64));
        assertThrows(ManagedExtensionRecords.InvalidRecordException.class, () -> ManagedConfigInstall.successor(prepared, changed));
        assertTrue(ManagedConfigInstall.barrier(committed));
        assertFalse(ManagedConfigInstall.barrier(active));
    }

    @Test
    void consumesSharedSuccessorsAndDerivedPhaseIdentities() throws IOException {
        for (JsonNode fixture : fixtures().required("successors")) {
            ObjectNode previous = fixture.path("previous").isNull() ? null : record(content(fixture.path("previous").asText()), 1);
            ObjectNode next = record(content(fixture.path("next").asText()), 1);
            if (fixture.path("valid").asBoolean()) {
                assertDoesNotThrow(() -> ManagedConfigInstall.successor(previous, next), fixture.path("name").asText());
            } else {
                assertThrows(ManagedExtensionRecords.InvalidRecordException.class, () -> ManagedConfigInstall.successor(previous, next), fixture.path("name").asText());
            }
        }
        for (JsonNode fixture : fixtures().required("phaseOperationIds")) {
            assertEquals(fixture.path("expected").asText(), ManagedConfigInstall.derivedOperationId(
                    "managed-extension-recoverPrevious:", fixture.path("operationId").asText()));
        }
    }

    static ObjectNode content(String name) throws IOException {
        for (JsonNode fixture : fixtures().required("valid")) {
            if (name.equals(fixture.path("name").asText())) {
                return fixture.required("content").deepCopy();
            }
        }
        throw new AssertionError("Missing configuration fixture: " + name);
    }

    static ObjectNode record(JsonNode content, long revision) {
        ObjectNode record = content.deepCopy();
        record.put("operationId", content.path("command").path("operationId").asText()).put("revision", revision);
        if (revision == 1) {
            record.putNull("previousRecordRef");
        } else {
            record.putObject("previousRecordRef").put("resourceId", "previous").put("kind", "managed-config_install")
                    .put("schemaVersion", 1).put("byteLength", 2).put("digest", "a".repeat(64));
        }
        return record;
    }

    private static JsonNode fixtures() throws IOException {
        Path current = Path.of(System.getProperty("user.dir")).toAbsolutePath();
        for (int depth = 0; depth < 6 && current != null; depth++, current = current.getParent()) {
            Path file = current.resolve("packages/core/src/managed-runtime/contracts/managed-config-install-v1.fixtures.json");
            if (Files.isRegularFile(file)) {
                return JSON.readTree(file.toFile());
            }
        }
        throw new AssertionError("Missing shared managed configuration fixtures");
    }
}
