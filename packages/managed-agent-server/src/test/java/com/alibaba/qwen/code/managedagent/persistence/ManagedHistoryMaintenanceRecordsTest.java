package com.alibaba.qwen.code.managedagent.persistence;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class ManagedHistoryMaintenanceRecordsTest {
    private final ObjectMapper json = new ObjectMapper();

    @Test
    void requiresDurableCandidateBeforeACompressedTerminalOutcome() {
        ObjectNode admitted = record("admitted", "admitted", 0);
        ObjectNode generating = record("generating", "running", 1);
        ObjectNode candidate = record("candidate", "running", 1);
        candidate.set("candidateRef", ref("candidate"));
        ObjectNode settled = candidate.deepCopy().put("phase", "settled")
                .put("outcome", "compressed").put("compactionRevision", 8);
        settled.withObject("/run").put("state", "settled");
        assertThat(ManagedHistoryMaintenanceRecords.isStart(admitted)).isTrue();
        assertThat(ManagedHistoryMaintenanceRecords.isSuccessor(admitted, generating)).isTrue();
        assertThat(ManagedHistoryMaintenanceRecords.isSuccessor(generating, candidate)).isTrue();
        assertThat(ManagedHistoryMaintenanceRecords.isSuccessor(candidate, settled)).isTrue();
        assertThat(ManagedHistoryMaintenanceRecords.isSuccessor(generating, settled)).isFalse();
        assertThat(ManagedHistoryMaintenanceRecords.isSuccessor(settled, settled)).isFalse();
    }

    @Test
    void regenerationKeepsItsHistoryAndRequestPin() {
        ObjectNode generating = record("generating", "running", 1);
        ObjectNode retry = generating.deepCopy().put("attempt", 2);
        assertThat(ManagedHistoryMaintenanceRecords.isSuccessor(generating, retry)).isTrue();
        retry.put("historyCutSequence", 7);
        assertThat(ManagedHistoryMaintenanceRecords.isSuccessor(generating, retry)).isFalse();
    }

    @Test
    void noopAndKnownFailureCannotCarryACompactionRevision() {
        for (String outcome : List.of("noop", "failed")) {
            ObjectNode settled = record("settled", outcome.equals("failed") ? "failed" : "settled", 1);
            settled.put("outcome", outcome);
            if ("failed".equals(outcome)) {
                settled.put("failureCode", "model_failed");
            }
            ManagedHistoryMaintenanceRecords.requireRecord(settled);
            settled.put("compactionRevision", 8);
            assertThatThrownBy(() -> ManagedHistoryMaintenanceRecords.requireRecord(settled))
                    .isInstanceOf(ManagedExtensionRecords.InvalidRecordException.class);
        }
    }

    private ObjectNode record(String phase, String state, int attempt) {
        ObjectNode body = json.createObjectNode().put("schemaVersion", 1)
                .put("kind", "context_compression").put("operationId", "operation")
                .put("expectedCompactionRevision", 0).put("historyCutSequence", 5)
                .put("phase", phase).put("attempt", attempt);
        body.set("requestRef", ref("request"));
        for (String key : List.of("candidateRef", "outcome", "failureCode", "compactionRevision")) {
            body.putNull(key);
        }
        ObjectNode run = body.putObject("run").put("state", state);
        for (String key : List.of("reason", "definition", "executionCallId", "effectId", "dispatchId",
                "deliveryId", "execution", "runtime", "delivery")) {
            run.putNull(key);
        }
        return body;
    }

    private ObjectNode ref(String id) {
        return json.createObjectNode().put("resourceId", id).put("kind", "managed-message")
                .put("schemaVersion", 1).put("byteLength", 2).put("digest", "a".repeat(64));
    }
}
