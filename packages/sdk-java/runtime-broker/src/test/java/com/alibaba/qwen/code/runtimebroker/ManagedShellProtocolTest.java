package com.alibaba.qwen.code.runtimebroker;

import java.nio.charset.StandardCharsets;
import java.util.Map;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

class ManagedShellProtocolTest {

    private static RuntimeSession session() {
        return new RuntimeSession("harness", "runtime", "bootstrap",
                new RuntimeScope("tenant", "workspace", "gen", "/workspace",
                        "capability", "workspace"));
    }

    private static Map<String, Object> operation() {
        return Map.of("kind", "shell-status", "sessionKey",
                Map.of("tenantId", "tenant", "workspaceId", "workspace",
                        "sessionId", "harness"),
                "operationId", "proc",
                "targetOperationId", "call");
    }

    private static byte[] envelope(Object operation) {
        String json = "{\"protocolVersion\":1,\"runtimeSessionId\":\"runtime\",\"operation\":"
                + com.alibaba.fastjson2.JSON.toJSONString(operation)
                + "}";
        return json.getBytes(StandardCharsets.UTF_8);
    }

    @Test
    void answersTheViewForTheAskedOperation() {
        Map<String, Object> view = Map.of("operationId", "call", "state",
                "running", "unitName", "qwen-bg-call");
        Map<String, Object> answered = ManagedShellProtocol.response(
                envelope(view), session(), operation());
        assertEquals("call", answered.get("operationId"));
        assertEquals("running", answered.get("state"));
    }

    @Test
    void refusesAViewAnsweringAnotherOperation() {
        Map<String, Object> view = Map.of("operationId", "stranger", "state",
                "running", "unitName", "qwen-bg-stranger");
        RuntimeBrokerException error = assertThrows(RuntimeBrokerException.class,
                () -> ManagedShellProtocol.response(envelope(view), session(),
                        operation()));
        assertEquals(502, error.getStatusCode());
        assertEquals("managed_shell_response_invalid", error.getCode());
    }

    @Test
    void acceptsAMismatchedIdNoLonger() {
        // The coercion the validator once silently allowed: the answer
        // names a stranger operation and still parses everywhere else.
        Map<String, Object> evidence = new java.util.LinkedHashMap<>();
        evidence.put("exitCode", 0);
        evidence.put("exitSignal", null);
        Map<String, Object> view = Map.of("operationId", "call2", "state",
                "exited", "evidence", evidence);
        RuntimeBrokerException error = assertThrows(RuntimeBrokerException.class,
                () -> ManagedShellProtocol.response(envelope(view), session(),
                        operation()));
        assertEquals("managed_shell_response_invalid", error.getCode());
    }
}
