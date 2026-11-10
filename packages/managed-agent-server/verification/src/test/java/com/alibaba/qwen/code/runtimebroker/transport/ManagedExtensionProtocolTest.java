package com.alibaba.qwen.code.runtimebroker.transport;

import com.alibaba.qwen.code.runtimebroker.JsonCodec;
import com.alibaba.qwen.code.runtimebroker.ManagedExtensionExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeLease;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.RuntimeSession;
import com.alibaba.qwen.code.runtimebroker.adapter.HttpRuntimeTransport;
import org.junit.jupiter.api.Test;

import java.net.URI;
import java.util.ArrayList;
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
    @SuppressWarnings("unchecked")
    void countsOnlyLiveSelectionsAgainstTheMcpChangeCapacity() {
        var prepare = prepare();
        var command = new LinkedHashMap<>((Map<String, Object>) prepare.get("command"));
        command.put("mcpChange", Map.of("action", "disable", "serverId", "server-0", "expectedRevision", 0,
                "servers", selections(32, 1)));
        prepare.put("command", command);
        ManagedExtensionProtocol.validateOperation(prepare);
        command.put("mcpChange", Map.of("action", "disable", "serverId", "server-0", "expectedRevision", 0,
                "servers", selections(33, 0)));
        assertEquals(400, assertThrows(RuntimeBrokerException.class,
                () -> ManagedExtensionProtocol.validateOperation(prepare)).getStatusCode());
    }

    @Test
    @SuppressWarnings("unchecked")
    void boundsRetainedTombstonesInTheMcpChangeSnapshot() {
        var prepare = prepare();
        var command = new LinkedHashMap<>((Map<String, Object>) prepare.get("command"));
        command.put("mcpChange", Map.of("action", "disable", "serverId", "server-0", "expectedRevision", 0,
                "servers", selections(32, 192)));
        prepare.put("command", command);
        ManagedExtensionProtocol.validateOperation(prepare);
        command.put("mcpChange", Map.of("action", "disable", "serverId", "server-0", "expectedRevision", 0,
                "servers", selections(32, 193)));
        assertEquals(400, assertThrows(RuntimeBrokerException.class,
                () -> ManagedExtensionProtocol.validateOperation(prepare)).getStatusCode());
    }

    private static List<Map<String, Object>> selections(int live, int removed) {
        var servers = new ArrayList<Map<String, Object>>();
        for (int index = 0; index < live + removed; index++) {
            servers.add(Map.of("serverId", "server-" + index, "serverRevision", 1,
                    "definitionDigest", "b".repeat(64), "state", index < live ? "disabled" : "removed"));
        }
        return servers;
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
    void skillSnapshotsKeepPathsDigestsAndChunkBoundsClosed() {
        var scan = Map.<String, Object>of("kind", "extension-skill-candidates", "operationId", OPERATION);
        ManagedExtensionProtocol.validateOperation(scan);
        var candidate = Map.<String, Object>of("name", "check", "description", "Check a project", "path", ".qwen/skills/check",
                "digest", "a".repeat(64), "shadowed", false, "compatible", true);
        assertEquals(List.of(candidate), ManagedExtensionProtocol.response(
                response(Map.of("operationId", OPERATION, "candidates", List.of(candidate))), SCOPE, "harness", scan).get("candidates"));
        var snapshot = Map.<String, Object>of("kind", "extension-skill-snapshot", "operationId", OPERATION,
                "path", ".qwen/skills/check", "digest", "a".repeat(64));
        ManagedExtensionProtocol.validateOperation(snapshot);
        var outside = new LinkedHashMap<>(snapshot);
        outside.put("path", ".qwen/skills/../../outside");
        assertThrows(RuntimeBrokerException.class, () -> ManagedExtensionProtocol.validateOperation(outside));
        var chunk = Map.<String, Object>of("kind", "extension-skill-archive", "operationId", OPERATION,
                "preparationId", OPERATION, "offset", 0);
        ManagedExtensionProtocol.validateOperation(chunk);
        var result = new LinkedHashMap<String, Object>(Map.of("operationId", OPERATION, "preparationId", OPERATION,
                "offset", 0, "totalBytes", 3, "base64", "YWJj"));
        ManagedExtensionProtocol.response(response(result), SCOPE, "harness", chunk);
        result.put("offset", 1);
        assertEquals(502, assertThrows(RuntimeBrokerException.class,
                () -> ManagedExtensionProtocol.response(response(result), SCOPE, "harness", chunk)).getStatusCode());
        result.put("offset", 0);
        result.put("totalBytes", 2);
        assertThrows(RuntimeBrokerException.class, () -> ManagedExtensionProtocol.response(response(result), SCOPE, "harness", chunk));
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
