package com.alibaba.qwen.code.runtimebroker.transport;

import com.alibaba.qwen.code.runtimebroker.JsonCodec;
import com.alibaba.qwen.code.runtimebroker.ManagedExtensionExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeLease;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.RuntimeSession;
import org.junit.jupiter.api.Test;

import java.net.URI;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ManagedExtensionProtocolTest {
    private static final String OPERATION = "550e8400-e29b-41d4-a716-446655440000";
    private static final RuntimeScope SCOPE = new RuntimeScope("tenant", "workspace", "1", "/workspace",
            ManagedExtensionExecutionProfile.DEVELOPER_CAPABILITY_DIGEST, "session");
    private static final Map<String, Object> PIN = Map.of("extensionId", "ext_550e8400-e29b-41d4-a716-446655440001",
            "packageRevision", 1, "packageDigest", "a".repeat(64));

    @Test
    @SuppressWarnings("unchecked")
    void acceptsOnlyClosedPreparationAndOriginalReconciliationCommands() {
        var prepare = prepare();
        ManagedExtensionProtocol.validateOperation(prepare);
        for (String privateField : List.of("settings", "packageManifests", "toolProfile", "archiveBase64")) {
            var forged = new LinkedHashMap<>(prepare);
            forged.put(privateField, Map.of());
            assertEquals(400, assertThrows(RuntimeBrokerException.class,
                    () -> ManagedExtensionProtocol.validateOperation(forged)).getStatusCode());
        }
        var command = new LinkedHashMap<>((Map<String, Object>) prepare.get("command"));
        command.put("mcpChange", Map.of("action", "enable", "serverId", "docs", "expectedRevision", 0,
                "servers", List.of(Map.of("serverId", "docs", "serverRevision", 1, "definitionDigest", "b".repeat(64), "state", "enabled"))));
        prepare.put("command", command);
        ManagedExtensionProtocol.validateOperation(prepare);
        var reconcile = Map.<String, Object>of("kind", "extension-reconcile", "operationId", OPERATION,
                "expectedRevision", 3, "revision", 4);
        ManagedExtensionProtocol.validateOperation(reconcile);
        assertTrue(ManagedExtensionProtocol.isRecovery(reconcile));
        var substituted = new LinkedHashMap<>(reconcile);
        substituted.put("revision", 5);
        assertThrows(RuntimeBrokerException.class, () -> ManagedExtensionProtocol.validateOperation(substituted));
    }

    @Test
    void validatesStopReceiptsAgainstTheOriginalSessionRevisionAndExecutionMode() {
        var request = Map.<String, Object>of("kind", "extension-reconcile", "operationId", OPERATION,
                "expectedRevision", 3, "revision", 4);
        var receipt = new LinkedHashMap<String, Object>(Map.of("ownerId", "owner-1", "sessionId", "harness",
                "configRevision", 4, "mode", "developer-process-group", "scope", "process_group", "state", "stopped"));
        receipt.put("coverage", "registered-owners");
        receipt.put("journalId", "journal-1");
        var result = new LinkedHashMap<String, Object>(Map.of("operationId", OPERATION, "state", "stopped", "revision", 4,
                "executionMode", "developer-process-group", "receipts", List.of(receipt)));
        assertEquals("stopped", ManagedExtensionProtocol.response(response(result), SCOPE, "harness", request).get("state"));
        for (String invalidField : List.of("sessionId", "scope", "mode", "state")) {
            Object saved = receipt.put(invalidField, "different-owner");
            assertEquals(502, assertThrows(RuntimeBrokerException.class,
                    () -> ManagedExtensionProtocol.response(response(result), SCOPE, "harness", request)).getStatusCode());
            receipt.put(invalidField, saved);
        }
        result.put("receipts", List.of());
        assertThrows(RuntimeBrokerException.class, () -> ManagedExtensionProtocol.response(response(result), SCOPE, "harness", request));
    }

    @Test
    void everyInvokePathRejectsAnotherHarnessExtensionContextBeforeSending() {
        RuntimeSession session = new RuntimeSession("harness", "runtime", "bootstrap", SCOPE);
        RuntimeLease lease = new RuntimeLease("worker", URI.create("http://127.0.0.1:9"), "token", "lease", 1);
        var input = Map.<String, Object>of("managedExtension", Map.of("harnessSessionId", "another-harness", "configRevision", 1, "pin", PIN));
        var reference = Map.<String, Object>of("sessionId", "runtime", "promptId", "prompt", "callId", "call",
                "argsDigest", "sha256:" + "b".repeat(64), "toolName", "read_file", "input", input);
        var capture = Map.<String, Object>of("tenantId", "tenant", "sessionId", "harness", "turnId", "turn",
                "executionCallId", "execution", "bindingGeneration", "1", "capturePolicy", "complete_required");
        var transport = new HttpRuntimeTransport();
        assertThrows(RuntimeBrokerException.class, () -> transport.execute(lease, session, reference));
        assertThrows(RuntimeBrokerException.class, () -> transport.executeV3(lease, session, reference, capture));
        assertThrows(RuntimeBrokerException.class, () -> transport.executeV3(lease, session, reference,
                Map.of("toolName", "read_file", "input", input), capture));
        ManagedExtensionProtocol.requireBoundInput(session, Map.of("path", "README.md"));
        ManagedExtensionProtocol.requireBoundInput(session, Map.of("managedExtension",
                Map.of("harnessSessionId", "harness", "configRevision", 1, "pin", PIN)));
    }

    private static Map<String, Object> prepare() {
        var operation = new LinkedHashMap<String, Object>();
        operation.put("kind", "extension-prepare");
        operation.put("operationId", OPERATION);
        operation.put("command", Map.of("operationId", OPERATION, "actorKey", "a".repeat(64), "expectedRevision", 0, "extensions", List.of(PIN)));
        operation.put("expectedRevision", 0);
        operation.put("extensions", List.of(PIN));
        operation.put("baseMcpServers", List.of());
        operation.put("baseHookCatalog", null);
        return operation;
    }

    private static byte[] response(Map<String, Object> result) {
        return JsonCodec.encode(Map.of("protocolVersion", 1,
                "sessionKey", Map.of("tenantId", "tenant", "workspaceId", "workspace", "sessionId", "harness"), "result", result));
    }
}
