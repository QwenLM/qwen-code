package com.alibaba.qwen.code.daemon;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;

import java.util.Map;
import org.junit.jupiter.api.Test;

class HostedAgentDefinitionRequestTest {
    private static final String SESSION = "22222222-2222-4222-8222-222222222222";

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
        assertEquals(full, CreateHarnessSession.builder().harnessSessionId(SESSION)
                .agentDefinition(full).build().toJson().get("agentDefinition"));
        Map<String, Object> load = new LoadHarnessSession(SESSION)
                .withAgentDefinition(identity).forLifecycle("close-1", 2).toJson();
        assertEquals(identity, load.get("agentDefinition"));
        assertFalse(((Map<?, ?>) load.get("agentDefinition")).containsKey("model"));
        assertEquals(Map.of("operationId", "close-1", "claimGeneration", 2L),
                load.get("lifecycleAuthority"));
    }
}
