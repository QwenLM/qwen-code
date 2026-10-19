package com.alibaba.qwen.code.runtimebroker.transport;

import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.RuntimeSession;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

class ManagedMonitorProtocolTest {

    private static RuntimeSession session() {
        return new RuntimeSession("harness", "runtime", "bootstrap",
                new RuntimeScope("tenant", "workspace", "gen", "/workspace",
                        "capability", "workspace"));
    }

    private static Map<String, Object> operation() {
        return Map.of("kind", "monitor-status", "sessionKey",
                Map.of("tenantId", "tenant", "workspaceId", "workspace",
                        "sessionId", "harness"),
                "operationId", "watch",
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
                "running", "unitName", "qwen-mon-call");
        Map<String, Object> answered = ManagedMonitorProtocol.response(
                envelope(view), session(), operation());
        assertEquals("call", answered.get("operationId"));
        assertEquals("running", answered.get("state"));
    }

    @Test
    void refusesAViewAnsweringAnotherOperation() {
        Map<String, Object> view = Map.of("operationId", "stranger", "state",
                "running", "unitName", "qwen-mon-stranger");
        RuntimeBrokerException error = assertThrows(RuntimeBrokerException.class,
                () -> ManagedMonitorProtocol.response(envelope(view), session(),
                        operation()));
        assertEquals(502, error.getStatusCode());
        assertEquals("managed_monitor_response_invalid", error.getCode());
    }

    @Test
    void refusesAnExitWithoutEvidence() {
        Map<String, Object> view = Map.of("operationId", "call", "state",
                "exited", "unitName", "qwen-mon-call");
        RuntimeBrokerException error = assertThrows(RuntimeBrokerException.class,
                () -> ManagedMonitorProtocol.response(envelope(view), session(),
                        operation()));
        assertEquals("managed_monitor_response_invalid", error.getCode());
    }

    @Test
    void validateSessionPinsTheSessionScope() {
        Map<String, Object> stranger = Map.of("kind", "monitor-stop",
                "sessionKey", Map.of("tenantId", "tenant", "workspaceId",
                        "workspace", "sessionId", "other"),
                "operationId", "watch",
                "targetOperationId", "call");
        RuntimeBrokerException error = assertThrows(RuntimeBrokerException.class,
                () -> ManagedMonitorProtocol.validateSession(session(), stranger));
        assertEquals(400, error.getStatusCode());
        assertEquals("runtime_control_operation_invalid", error.getCode());
    }
}
