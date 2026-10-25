package com.alibaba.qwen.code.runtimebroker.transport;

import com.alibaba.qwen.code.runtimebroker.BrokerValues;
import com.alibaba.qwen.code.runtimebroker.JsonCodec;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.WorkspaceCsiRuntimeIdentity;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import com.alibaba.qwen.code.runtimebroker.provisioning.ManagedContextProtocol;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;

/** Original boot6 application cleanup, carrying no live execution permission. */
public final class CsiFileFinalizeProtocol {
    public static final String PATH = ManagedCsiFilesProtocol.PREFIX + "/finalize";
    public static final int REQUEST_LIMIT = 16 * 1024;
    public static final int RESPONSE_LIMIT = 32 * 1024 * 1024;
    private static final Set<String> OPERATION = Set.of("operation", "retirementId", "preparedCommitSha256",
            "frozenRequestSha256", "cutSha256");

    private CsiFileFinalizeProtocol() {
    }

    public static Map<String, Object> request(RuntimeBindingRecord runtime, ContextBinding binding,
            Map<String, Object> operation) {
        var boot = WorkspaceCsiRuntimeIdentity.boot(runtime);
        require(runtime.getResourceHandle().getVersion() == WorkspaceCsiRuntimeIdentity.FILES_FINALIZATION_VERSION);
        var handle = runtime.getResourceHandle().getValue();
        return request(boot, runtime.getRequest(), binding, WorkspaceCsiRuntimeIdentity.expectedPod(runtime),
                WorkspaceCsiRuntimeIdentity.map(handle.get("mount")), operation);
    }

    static Map<String, Object> request(Map<String, Object> boot, RuntimeProvisionRequest original, ContextBinding binding,
            Map<String, Object> pod, Map<String, Object> mount, Map<String, Object> operation) {
        ManagedCsiFilesProtocol.validateBoot(boot);
        require(Long.valueOf(6).equals(BrokerValues.exactLong(boot.get("version")))
                && ManagedCsiFilesProtocol.FINALIZATION_FORMAT.equals(boot.get("finalization"))
                && operation != null && operation.keySet().equals(OPERATION));
        String action = text(operation, "operation");
        require(Set.of("observe", "finalize").contains(action));
        String retirementId = text(operation, "retirementId");
        require(retirementId.matches("[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"));
        digest(operation.get("preparedCommitSha256"));
        if ("observe".equals(action)) {
            require(operation.get("frozenRequestSha256") == null && operation.get("cutSha256") == null);
        } else {
            digest(operation.get("frozenRequestSha256"));
            digest(operation.get("cutSha256"));
        }
        var attestation = Map.<String, Object>of("protocolVersion", 2, "managedCsi", ManagedCsiFilesProtocol.PROTOCOL,
                "identity", boot.get("identity"), "context", ManagedContextProtocol.attestationResponse(map(boot.get("context"))),
                "storage", boot.get("storage"), "pod", pod, "mount", mount);
        ManagedCsiFilesProtocol.verifyAttestation(attestation, boot, pod);
        var nativeRequest = CsiNativeReadbackProtocol.bindRequest(boot, original, binding,
                "00000000-0000-4000-8000-000000000000");
        var result = new LinkedHashMap<String, Object>();
        result.put("format", ManagedCsiFilesProtocol.FINALIZATION_FORMAT);
        result.put("bootSha256", WorkspaceCsiRuntimeIdentity.digest(boot));
        for (String field : new String[] {"identity", "context", "installedContext"}) {
            result.put(field, nativeRequest.get(field));
        }
        result.put("storage", boot.get("storage"));
        result.put("pod", pod);
        result.put("mount", mount);
        result.putAll(operation);
        require(JsonCodec.encode(result).length <= REQUEST_LIMIT);
        return BrokerValues.immutableMap(result);
    }

    public static Map<String, Object> response(byte[] bytes, Map<String, Object> request) {
        var value = ManagedCsiFilesProtocol.parse(bytes, RESPONSE_LIMIT);
        boolean observe = "observe".equals(request.get("operation"));
        var fields = new HashSet<>(request.keySet());
        fields.add("state");
        fields.addAll(observe ? Set.of("execution", "preparations", "files")
                : Set.of("preCutObservationSha256", "cleanup"));
        require(value.keySet().equals(fields));
        for (String field : request.keySet()) {
            require(WorkspaceCsiRuntimeIdentity.same(request.get(field), value.get(field)));
        }
        require((observe ? "FROZEN_CANDIDATE" : "DRAINED").equals(value.get("state")));
        if (observe) {
            require(value.get("execution") instanceof Map<?, ?> && value.get("files") instanceof Map<?, ?>
                    && value.get("preparations") instanceof java.util.List<?>);
        } else {
            digest(value.get("preCutObservationSha256"));
            var cleanup = map(value.get("cleanup"));
            require(cleanup.keySet().equals(Set.of("compositionClosed", "backend", "mount"))
                    && Boolean.TRUE.equals(cleanup.get("compositionClosed")));
            var backend = map(cleanup.get("backend"));
            require(backend.keySet().equals(Set.of("closed", "blocked", "pendingOperations", "openDescriptors"))
                    && Boolean.TRUE.equals(backend.get("closed")) && Boolean.FALSE.equals(backend.get("blocked"))
                    && zero(backend.get("pendingOperations")) && java.util.List.of().equals(backend.get("openDescriptors")));
            var mount = map(cleanup.get("mount"));
            require(mount.keySet().equals(Set.of("admissionClosed", "pendingOperations", "closeFailed", "root"))
                    && Boolean.TRUE.equals(mount.get("admissionClosed")) && Boolean.FALSE.equals(mount.get("closeFailed"))
                    && zero(mount.get("pendingOperations")));
            var root = map(mount.get("root"));
            require(root.keySet().equals(Set.of("admissionClosed", "pendingOperations", "fd", "device", "inode"))
                    && Boolean.TRUE.equals(root.get("admissionClosed")) && zero(root.get("pendingOperations"))
                    && root.get("fd") == null);
            var originalMount = map(request.get("mount"));
            require(originalMount.get("rootDevice").equals(root.get("device"))
                    && originalMount.get("rootInode").equals(root.get("inode")));
        }
        return BrokerValues.immutableMap(value);
    }

    private static boolean zero(Object value) {
        return Long.valueOf(0).equals(BrokerValues.exactLong(value));
    }

    private static String text(Map<String, Object> value, String key) {
        require(value.get(key) instanceof String);
        return (String) value.get(key);
    }

    private static Map<String, Object> map(Object value) {
        return WorkspaceCsiRuntimeIdentity.map(value);
    }

    private static void digest(Object value) {
        require(value instanceof String && ((String) value).matches("[0-9a-f]{64}"));
    }

    private static void require(boolean valid) {
        if (!valid) {
            throw new IllegalArgumentException("Invalid original CSI file finalization.");
        }
    }
}
