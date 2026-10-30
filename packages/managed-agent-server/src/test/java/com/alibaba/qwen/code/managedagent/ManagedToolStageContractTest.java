package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.persistence.ManagedExtensionProjection;
import com.alibaba.qwen.code.managedagent.persistence.ManagedExtensionRecords.InvalidRecordException;
import com.alibaba.qwen.code.managedagent.persistence.ManagedToolStageRecords;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ManagedToolStageContractTest {
    @Test
    void replaysTheSharedOrdinaryToolPinAndRevisionCases() throws IOException {
        JsonNode fixtures = fixtures();
        var body = ManagedExtensionProjection.RECORD_BODIES.get("tool_stage");
        for (JsonNode fixture : fixtures.required("valid")) {
            JsonNode record = fixture.required("record");
            body.require().accept(record);
            assertNull(body.taskKindOf().apply(record));
            assertEquals(record.required("toolStageId").textValue(), body.recordId().apply(record));
        }
        for (JsonNode fixture : fixtures.required("invalid")) {
            assertThrows(InvalidRecordException.class,
                    () -> body.require().accept(fixture.required("record")), fixture.required("name").textValue());
        }
        for (JsonNode fixture : fixtures.required("successors")) {
            assertEquals(fixture.required("valid").booleanValue(),
                    body.isSuccessor().test(fixture.required("previous"), fixture.required("next")),
                    fixture.required("name").textValue());
        }
        JsonNode admitted = fixtures.required("valid").get(0).required("record");
        assertTrue(ManagedToolStageRecords.isStart(admitted));
        JsonNode settled = fixtures.required("valid").get(2).required("record");
        assertFalse(ManagedToolStageRecords.isStart(settled));
        var substituted = settled.deepCopy();
        ((com.fasterxml.jackson.databind.node.ObjectNode) substituted.get("resultRef")).put("resourceId", "other-result");
        assertFalse(ManagedToolStageRecords.isSuccessor(settled, substituted));
        assertTrue(ManagedToolStageRecords.isSuccessor(settled, settled));
    }

    private static JsonNode fixtures() throws IOException {
        Path current = Path.of(System.getProperty("user.dir")).toAbsolutePath();
        for (int depth = 0; depth < 6 && current != null; depth++, current = current.getParent()) {
            Path candidate = current.resolve("packages/core/src/managed-runtime/contracts/managed-tool-stage-v1.fixtures.json");
            if (Files.isRegularFile(candidate)) {
                return new ObjectMapper().readTree(candidate.toFile());
            }
        }
        throw new AssertionError("Shared Managed tool stage fixtures are unavailable");
    }
}
