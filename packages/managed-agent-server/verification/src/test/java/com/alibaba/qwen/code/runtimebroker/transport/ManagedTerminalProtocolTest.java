package com.alibaba.qwen.code.runtimebroker.transport;

import com.alibaba.qwen.code.managedagent.VerificationFixtures;
import com.alibaba.qwen.code.runtimebroker.JsonCodec;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.RuntimeSession;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

/**
 * The terminal hold settles only if the worker's maintenance answers pass
 * this wire validation. The shapes the worker actually returns must be
 * accepted; the bare shapes it once returned (a running answer without a
 * unitName, an exited answer with all-null evidence) are rejected here and
 * would wedge the hold — and therefore Session close/delete — forever.
 */
class ManagedTerminalProtocolTest {
    private static RuntimeSession session() {
        return new RuntimeSession("harness", "runtime", "bootstrap",
                new RuntimeScope("tenant", "workspace", "gen", "/workspace",
                        "capability", "workspace"));
    }

    private static Map<String, Object> operation() {
        return Map.of("kind", "terminal-status", "sessionKey",
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

    private static Map<String, Object> evidence(Integer exitCode) {
        Map<String, Object> evidence = new LinkedHashMap<>();
        evidence.put("exitCode", exitCode);
        evidence.put("exitSignal", null);
        return evidence;
    }

    @Test
    void acceptsTheWorkersRunningAnswer() {
        Map<String, Object> view = Map.of("operationId", "call", "state",
                "running", "unitName", "call");
        Map<String, Object> answered = ManagedTerminalProtocol.response(
                envelope(view), session(), operation());
        assertEquals("running", answered.get("state"));
    }

    @Test
    void acceptsTheWorkersReleasedExitAnswer() {
        Map<String, Object> view = Map.of("operationId", "call", "state",
                "exited", "evidence", evidence(143));
        Map<String, Object> answered = ManagedTerminalProtocol.response(
                envelope(view), session(), operation());
        assertEquals("exited", answered.get("state"));
    }

    @Test
    void acceptsTheWorkersNativeExitAnswer() {
        Map<String, Object> view = Map.of("operationId", "call", "state",
                "exited", "evidence", evidence(0));
        Map<String, Object> answered = ManagedTerminalProtocol.response(
                envelope(view), session(), operation());
        assertEquals("exited", answered.get("state"));
    }

    @Test
    void acceptsTheWorkersUnknownAnswer() {
        Map<String, Object> view = Map.of("operationId", "call", "state",
                "unknown");
        Map<String, Object> answered = ManagedTerminalProtocol.response(
                envelope(view), session(), operation());
        assertEquals("unknown", answered.get("state"));
    }

    @Test
    void rejectsRunningWithoutAUnitName() {
        Map<String, Object> view = Map.of("operationId", "call", "state",
                "running");
        RuntimeBrokerException error = assertThrows(RuntimeBrokerException.class,
                () -> ManagedTerminalProtocol.response(envelope(view), session(),
                        operation()));
        assertEquals(502, error.getStatusCode());
        assertEquals("managed_terminal_response_invalid", error.getCode());
    }

    @Test
    void rejectsExitedWithAllNullEvidence() {
        Map<String, Object> view = Map.of("operationId", "call", "state",
                "exited", "evidence", evidence(null));
        RuntimeBrokerException error = assertThrows(RuntimeBrokerException.class,
                () -> ManagedTerminalProtocol.response(envelope(view), session(),
                        operation()));
        assertEquals("managed_terminal_response_invalid", error.getCode());
    }

    /**
     * The worker route test (managed-terminal-routes.test.ts) drives the real
     * producer into each of these states and asserts its answer deep-equals
     * this same fixture; here the validator must accept every one of those
     * serialized answers. A key rename on either side reds its own suite
     * instead of drifting into a runtime managed_terminal_response_invalid
     * that wedges the hold.
     */
    @Test
    void consumesTheSharedWorkerEnvelopeFixture() throws Exception {
        Map<String, Object> fixture = JsonCodec.parseObject(Files.readAllBytes(
                VerificationFixtures.moduleRoot().resolve(
                        "../cli/src/serve/contracts/managed-terminal-control-v1.fixtures.json")),
                "shared terminal control fixture");
        assertEquals(ManagedTerminalProtocol.PATH, fixture.get("path"));
        RuntimeSession sharedSession = new RuntimeSession("harness",
                (String) fixture.get("runtimeSessionId"), "bootstrap",
                new RuntimeScope("tenant", "workspace", "gen", "/workspace",
                        "capability", "workspace"));
        for (Object item : (List<?>) fixture.get("cases")) {
            @SuppressWarnings("unchecked")
            Map<String, Object> testCase = (Map<String, Object>) item;
            String name = (String) testCase.get("name");
            @SuppressWarnings("unchecked")
            Map<String, Object> request = (Map<String, Object>) testCase
                    .get("request");
            @SuppressWarnings("unchecked")
            Map<String, Object> operation = (Map<String, Object>) request
                    .get("operation");
            @SuppressWarnings("unchecked")
            Map<String, Object> response = (Map<String, Object>) testCase
                    .get("response");
            Map<String, Object> answered = ManagedTerminalProtocol.response(
                    JsonCodec.encode(response), sharedSession, operation);
            assertEquals(response.get("operation"), answered, name);
        }
    }
}
