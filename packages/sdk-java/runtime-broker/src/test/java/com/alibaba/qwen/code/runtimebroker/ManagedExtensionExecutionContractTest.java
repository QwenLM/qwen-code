package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.assertEquals;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.EnumSet;
import java.util.Set;
import org.junit.jupiter.api.Test;

/**
 * Pins what the Broker's HTTP API reports for each execution state to the
 * wire status the H0c fixtures give the Harness. The Session store maps the
 * Broker state and the Harness maps this report, so both replay the same
 * Runtime.
 */
class ManagedExtensionExecutionContractTest {
    private static final ObjectMapper JSON = new ObjectMapper();

    @Test
    void reportsTheWireStatusTheSharedCasesGiveTheHarness() throws IOException {
        assertEquals(1, read().required("contractVersion").intValue());
        Set<ToolExecutionRecord.State> covered = EnumSet.noneOf(
                ToolExecutionRecord.State.class);
        for (JsonNode each : read().required("brokerExecutionCases")) {
            String id = each.required("id").textValue();
            ToolExecutionRecord.State state = ToolExecutionRecord.State
                    .valueOf(each.required("state").textValue());
            covered.add(state);
            JsonNode inspection = each.required("inspection");
            if (state == ToolExecutionRecord.State.UNKNOWN
                    || state == ToolExecutionRecord.State.ABANDONED) {
                // The Broker answers runtime_broker_execution_unknown
                // instead of a status; RuntimeBrokerHttpServerTest pins it.
                assertEquals("unknown",
                        inspection.required("outcome").textValue(), id);
                continue;
            }
            assertEquals("known", inspection.required("outcome").textValue(),
                    id);
            JsonNode status = inspection.required("status");
            assertEquals(status.required("state").textValue(),
                    RuntimeBrokerHttpServer.wireState(state), id);
            // A settled record's result carries its execution status.
            JsonNode executionStatus = each.required("executionStatus");
            assertEquals(executionStatus.isNull() ? null
                    : executionStatus.textValue(),
                    status.path("result").path("executionStatus")
                            .textValue(), id);
        }
        assertEquals(EnumSet.allOf(ToolExecutionRecord.State.class),
                covered);
    }

    private static JsonNode read() throws IOException {
        Path current = Path.of(System.getProperty("user.dir")).toAbsolutePath();
        for (int depth = 0; depth < 6 && current != null; depth++) {
            Path candidate = current.resolve(Path.of("packages", "core", "src",
                    "managed-runtime", "contracts",
                    "managed-extension-projection-v1.fixtures.json"));
            if (Files.isRegularFile(candidate)) {
                return JSON.readTree(candidate.toFile());
            }
            current = current.getParent();
        }
        throw new AssertionError("cannot locate the shared H0c fixtures");
    }
}
