package com.alibaba.qwen.code.daemon;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.Map;
import org.junit.jupiter.api.Test;

class HostedAgentDefinitionRequestTest {
    private static final String SESSION = "22222222-2222-4222-8222-222222222222";

    @Test
    void shellLoadsRetainTheDefinitionAndSuppressionThroughEveryCopy() {
        Map<String, Object> identity = Map.of("agentId", "agent_" + "a".repeat(32),
                "revision", "1", "digest", "b".repeat(64));
        LoadHarnessSession original = new LoadHarnessSession(SESSION, null,
                true, "hosted-workspace-shell/1", true, true, true)
                .withAgentDefinition(identity);
        for (LoadHarnessSession load : java.util.List.of(
                original.withChildWorkspaces(true),
                original.forLifecycle("close-1", 2),
                original.withStoppedMessages(),
                original.withChildWorkspaces(true).forLifecycle("close-1", 2)
                        .withStoppedMessages())) {
            Map<String, Object> wire = load.toJson();
            assertEquals(identity, wire.get("agentDefinition"));
            assertEquals("hosted-workspace-shell/1", wire.get("toolProfile"));
            assertTrue((Boolean) wire.get("suppressChildAgents"));
            assertTrue((Boolean) wire.get("passiveManagedRuntimeRecovery"));
            assertTrue((Boolean) wire.get("driveRuntimeRecovery"));
            assertTrue((Boolean) wire.get("cancellationTakeover"));
        }
    }

    @Test
    void createDeliversTheFullPinAndLifecycleLoadRetainsOnlyTheIdentity() {
        Map<String, Object> identity = Map.of("agentId", "agent_" + "a".repeat(32),
                "revision", "1", "digest", "b".repeat(64));
        Map<String, Object> full = Map.of("agentId", identity.get("agentId"),
                "revision", "1", "digest", identity.get("digest"),
                "model", Map.of("id", "configured"),
                "instructionsRef", Map.of("resourceId", "instructions",
                        "kind", "managed-agent-instructions", "schemaVersion", 1,
                        "byteLength", 4, "digest", "c".repeat(64)));
        Map<String, Object> create = CreateHarnessSession.builder().harnessSessionId(SESSION)
                .agentDefinition(full).lineage(SESSION, SESSION, "child-run-1", 1)
                .build().toJson();
        assertEquals(full, create.get("agentDefinition"));
        assertEquals(Map.of("parentSessionId", SESSION, "rootSessionId", SESSION,
                "parentChildRunId", "child-run-1", "depth", 1), create.get("lineage"));
        Map<String, Object> load = new LoadHarnessSession(SESSION)
                .withAgentDefinition(identity).forLifecycle("close-1", 2).toJson();
        assertEquals(identity, load.get("agentDefinition"));
        assertFalse(((Map<?, ?>) load.get("agentDefinition")).containsKey("model"));
        assertEquals(Map.of("operationId", "close-1", "claimGeneration", 2L),
                load.get("lifecycleAuthority"));
    }
}
