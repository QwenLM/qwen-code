package com.alibaba.qwen.code.managedagent.persistence;

import com.fasterxml.jackson.databind.JsonNode;

import java.util.List;
import java.util.Set;

/** A private control receipt, not a task, run, or business Session boundary. */
public final class ManagedHarnessReleaseRecords {
    private ManagedHarnessReleaseRecords() {
    }

    public static void require(JsonNode record) {
        ManagedExtensionRecords.closed(record, Set.of("format", "tenantId", "workspaceId", "sessionId",
                "operationId", "instanceId", "bootId", "placementEpoch", "writerGeneration", "journalRevision",
                "committedSequence", "commitProof", "state"), "Harness release");
        ManagedExtensionRecords.oneOf(record.get("format"), List.of("qwen-hosted-harness-release/1"), "format");
        ManagedExtensionRecords.oneOf(record.get("state"), List.of("RELEASED"), "state");
        for (String field : List.of("tenantId", "workspaceId", "sessionId", "operationId", "instanceId", "bootId")) {
            ManagedExtensionRecords.id(record.get(field), "Harness release " + field);
        }
        for (String field : List.of("placementEpoch", "writerGeneration", "journalRevision")) {
            ManagedExtensionRecords.count(record.get(field), 1, ManagedSessionStoreModels.MAX_SAFE_COUNTER, field);
        }
        ManagedExtensionRecords.count(record.get("committedSequence"), 0, ManagedSessionStoreModels.MAX_SAFE_COUNTER,
                "committedSequence");
        JsonNode proof = record.get("commitProof");
        ManagedExtensionRecords.closed(proof, Set.of("lastCommitSequence", "committedPrefixHash"), "commitProof");
        ManagedExtensionRecords.count(proof.get("lastCommitSequence"), 0, ManagedSessionStoreModels.MAX_SAFE_COUNTER,
                "lastCommitSequence");
        ManagedExtensionRecords.digest(proof.get("committedPrefixHash"), "committedPrefixHash");
        if (proof.path("lastCommitSequence").asLong() != record.path("committedSequence").asLong()) {
            throw new ManagedExtensionRecords.InvalidRecordException("Harness release prefix is invalid.");
        }
    }
}
