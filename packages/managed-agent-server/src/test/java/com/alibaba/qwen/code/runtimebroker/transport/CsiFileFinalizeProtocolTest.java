package com.alibaba.qwen.code.runtimebroker.transport;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.alibaba.qwen.code.runtimebroker.BrokerValues;
import com.alibaba.qwen.code.runtimebroker.JsonCodec;
import com.alibaba.qwen.code.runtimebroker.WorkspaceCsiRuntimeIdentity;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class CsiFileFinalizeProtocolTest {
    private static Map<String, Object> fixture() throws Exception {
        return ManagedCsiFilesProtocol.parse(Files.readAllBytes(
                Path.of("../cli/src/serve/contracts/managed-csi-file-finalize-v1.fixtures.json")));
    }

    @Test
    void sharesTheOriginalTypeScriptRequestsAndCanonicalHashes() throws Exception {
        var base = ManagedCsiFilesProtocolTest.fixtures();
        var expected = fixture();
        var installed = WorkspaceCsiRuntimeIdentity.map(WorkspaceCsiRuntimeIdentity.map(expected.get("observe")).get("installedContext"));
        var fields = WorkspaceCsiRuntimeIdentity.map(installed.get("binding"));
        var context = new ContextBinding((String) fields.get("tenantId"), (String) fields.get("workspaceId"),
                Long.parseLong((String) fields.get("workspaceGeneration")), (String) fields.get("storageId"),
                (String) fields.get("cwdRelative"), (String) fields.get("contextConfigRef"),
                Long.parseLong((String) fields.get("contextRevision")));
        var pod = WorkspaceCsiRuntimeIdentity.map(base.get("expectedPod"));
        var mount = WorkspaceCsiRuntimeIdentity.map(WorkspaceCsiRuntimeIdentity.map(base.get("attestationResponse")).get("mount"));
        for (String action : List.of("observe", "finalize")) {
            var request = WorkspaceCsiRuntimeIdentity.map(expected.get(action));
            var operation = new LinkedHashMap<String, Object>();
            for (String field : List.of("operation", "retirementId", "preparedCommitSha256", "frozenRequestSha256", "cutSha256")) {
                operation.put(field, request.get(field));
            }
            var actual = CsiFileFinalizeProtocol.request(WorkspaceCsiRuntimeIdentity.map(base.get("finalizationBoot6")),
                    ManagedCsiFilesProtocolTest.request(base), context, pod, mount, operation);
            assertTrue(BrokerValues.sameJsonMap(request, actual));
            assertEquals(expected.get(action + "CanonicalSha256"), WorkspaceCsiRuntimeIdentity.digest(actual));
            for (String old : List.of("boot", "executionBoot5")) {
                assertThrows(IllegalArgumentException.class, () -> CsiFileFinalizeProtocol.request(
                        WorkspaceCsiRuntimeIdentity.map(base.get(old)), ManagedCsiFilesProtocolTest.request(base), context, pod, mount, operation));
            }
            var extra = new LinkedHashMap<>(operation);
            extra.put("extra", true);
            assertThrows(IllegalArgumentException.class, () -> CsiFileFinalizeProtocol.request(
                    WorkspaceCsiRuntimeIdentity.map(base.get("finalizationBoot6")), ManagedCsiFilesProtocolTest.request(base), context, pod, mount, extra));
        }
    }

    @Test
    void acceptsOnlyTheExactCleanupReceiptAndClosedOriginalPins() throws Exception {
        var fixture = fixture();
        var request = WorkspaceCsiRuntimeIdentity.map(fixture.get("finalize"));
        var receipt = WorkspaceCsiRuntimeIdentity.map(fixture.get("receipt"));
        assertTrue(BrokerValues.sameJsonMap(receipt, CsiFileFinalizeProtocol.response(JsonCodec.encode(receipt), request)));
        for (String field : request.keySet()) {
            var crossed = new LinkedHashMap<>(receipt);
            crossed.put(field, "foreign");
            assertThrows(IllegalArgumentException.class, () -> CsiFileFinalizeProtocol.response(JsonCodec.encode(crossed), request), field);
        }
        var cleanup = WorkspaceCsiRuntimeIdentity.map(receipt.get("cleanup"));
        for (String field : cleanup.keySet()) {
            var missing = new LinkedHashMap<>(cleanup);
            missing.remove(field);
            var crossed = new LinkedHashMap<>(receipt);
            crossed.put("cleanup", missing);
            assertThrows(IllegalArgumentException.class, () -> CsiFileFinalizeProtocol.response(JsonCodec.encode(crossed), request));
        }
        var backend = WorkspaceCsiRuntimeIdentity.map(cleanup.get("backend"));
        for (var changed : List.of(Map.of("closed", false), Map.of("blocked", true), Map.of("pendingOperations", 1),
                Map.of("openDescriptors", List.of(19)))) {
            var failed = new LinkedHashMap<>(backend);
            failed.putAll(changed);
            var actualCleanup = new LinkedHashMap<>(cleanup);
            actualCleanup.put("backend", failed);
            var crossed = new LinkedHashMap<>(receipt);
            crossed.put("cleanup", actualCleanup);
            assertThrows(IllegalArgumentException.class, () -> CsiFileFinalizeProtocol.response(JsonCodec.encode(crossed), request));
        }
        var crossed = new LinkedHashMap<>(receipt);
        crossed.put("extra", true);
        assertThrows(IllegalArgumentException.class, () -> CsiFileFinalizeProtocol.response(JsonCodec.encode(crossed), request));
        assertThrows(IllegalArgumentException.class, () -> CsiFileFinalizeProtocol.response(new byte[CsiFileFinalizeProtocol.RESPONSE_LIMIT + 1], request));
    }
}
