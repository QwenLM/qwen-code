package com.alibaba.qwen.code.managedagent.service;

import com.alibaba.qwen.code.runtimebroker.ManagedCsiProtocol;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeLease;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionSeed;
import com.alibaba.qwen.code.runtimebroker.RuntimeResourceHandle;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import java.net.URI;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/** Reads the original API-observed CSI identity; never accepts a worker as its own authority. */
public final class WorkspaceCsiRuntimeIdentity {
    static final String KIND = "kubernetes-workspace";
    static final int VERSION = 1;
    private static final ObjectMapper JSON = new ObjectMapper().enable(SerializationFeature.ORDER_MAP_ENTRIES_BY_KEYS);
    private static final Set<String> KEYS = Set.of("bindingId", "runtimeGeneration", "context", "storage",
            "placement", "protection", "artifacts", "bootDigest", "podSpecDigest", "mount", "identity");
    private static final Set<String> PLACEMENT_KEYS = Set.of("clusterDomain", "namespace", "namespaceUid",
            "podName", "podUid", "nodeName", "nodeUid", "containerName", "containerId", "image", "imageId",
            "podIp", "secretName", "secretUid");

    private WorkspaceCsiRuntimeIdentity() {
    }

    public static void verify(RuntimeBindingRecord binding) {
        require(binding != null && binding.getLease() != null && binding.getProvisionSeed() != null
                && binding.getAttestationGeneration() > 0);
        validate(binding.getRequest(), binding.getProvisionSeed(), binding.getResourceHandle());
        var value = binding.getResourceHandle().getValue();
        require(binding.getBindingId().equals(value.get("bindingId"))
                && Long.toString(binding.getGeneration()).equals(value.get("runtimeGeneration"))
                && binding.hasSameLease(lease(binding.getProvisionSeed(), map(value.get("placement")))));
    }

    public static Map<String, Object> boot(RuntimeBindingRecord binding) {
        verify(binding);
        return ManagedCsiProtocol.boot(binding.getRequest(), binding.getProvisionSeed(),
                map(binding.getResourceHandle().getValue().get("storage")));
    }

    public static Map<String, Object> expectedPod(RuntimeBindingRecord binding) {
        verify(binding);
        return pod(map(binding.getResourceHandle().getValue().get("placement")));
    }

    static void validate(RuntimeProvisionRequest request, RuntimeProvisionSeed seed, RuntimeResourceHandle handle) {
        try {
            require(request != null && seed != null && request.isManagedContext() && KIND.equals(request.getProvisionerKind())
                    && "workspace".equals(request.getScope().getIsolationClass()) && request.getIsolationKey() == null
                    && handle != null && KIND.equals(handle.getKind()) && handle.getVersion() == VERSION);
            var value = handle.getValue();
            require(value.keySet().equals(KEYS));
            text(value, "bindingId", 512);
            decimal(value, "runtimeGeneration");
            var originalBoot = ManagedCsiProtocol.boot(request, seed, map(value.get("storage")));
            require(digest(originalBoot).equals(value.get("bootDigest"))
                    && same(context(originalBoot), value.get("context")));
            var placement = map(value.get("placement"));
            require(placement.keySet().equals(PLACEMENT_KEYS));
            var storage = map(value.get("storage"));
            require(storage.get("clusterDomain").equals(placement.get("clusterDomain"))
                    && storage.get("namespace").equals(placement.get("namespace"))
                    && "runtime".equals(placement.get("containerName"))
                    && text(placement, "image", 512).matches("[^\\s]+@sha256:[0-9a-f]{64}")
                    && text(placement, "imageId", 512).matches("[^\\s]*sha256:[0-9a-f]{64}")
                    && text(placement, "containerId", 128).matches("containerd://[0-9a-f]{64}")
                    && name(seed).equals(placement.get("podName")) && name(seed).equals(placement.get("secretName")));
            for (String field : List.of("podUid", "nodeUid", "namespaceUid", "secretUid")) {
                uuid(text(placement, field, 36));
            }
            ManagedCsiProtocol.validatePodIdentity(pod(placement), (String) storage.get("namespace"));
            endpoint(text(placement, "podIp", 64));
            var protection = map(value.get("protection"));
            require(protection.keySet().equals(Set.of("namespaceUid", "policyName", "policyUid", "policyGeneration",
                    "bindingName", "bindingUid", "bindingGeneration"))
                    && placement.get("namespaceUid").equals(protection.get("namespaceUid")));
            for (String field : List.of("policyUid", "bindingUid")) {
                uuid(text(protection, field, 36));
            }
            for (String field : List.of("policyName", "bindingName")) {
                dns(text(protection, field, 253));
            }
            decimal(protection, "policyGeneration");
            decimal(protection, "bindingGeneration");
            require(value.get("artifacts") instanceof List<?>);
            var artifacts = (List<?>) value.get("artifacts");
            require(artifacts.size() <= 48);
            var names = new java.util.HashSet<String>();
            for (Object item : artifacts) {
                var artifact = map(item);
                require(artifact.keySet().equals(Set.of("configMapName", "uid", "sha256")));
                String name = text(artifact, "configMapName", 253);
                dns(name);
                require(names.add(name));
                uuid(text(artifact, "uid", 36));
                require(text(artifact, "sha256", 64).matches("[0-9a-f]{64}"));
            }
            require(text(value, "podSpecDigest", 64).matches("[0-9a-f]{64}"));
            ManagedCsiProtocol.verifyAttestation(Map.of("protocolVersion", 1, "managedCsi", ManagedCsiProtocol.PROTOCOL,
                    "context", value.get("context"), "storage", storage, "pod", pod(placement), "mount", value.get("mount")),
                    originalBoot, pod(placement));
            var unsigned = new LinkedHashMap<>(value);
            unsigned.remove("identity");
            require(digest(unsigned).equals(value.get("identity")));
        } catch (RuntimeException error) {
            throw unavailable();
        }
    }

    static Map<String, Object> context(Map<String, Object> boot) {
        var context = new LinkedHashMap<>(map(boot.get("context")));
        context.remove("type");
        context.remove("version");
        context.remove("token");
        context.put("protocolVersion", 3);
        return Map.copyOf(context);
    }

    static Map<String, Object> pod(Map<String, Object> placement) {
        return Map.of("uid", placement.get("podUid"), "namespace", placement.get("namespace"), "nodeName", placement.get("nodeName"));
    }

    static RuntimeLease lease(RuntimeProvisionSeed seed, Map<String, Object> placement) {
        return new RuntimeLease(seed.getProvisionalRuntimeId(), endpoint(text(placement, "podIp", 64)),
                seed.getToken(), seed.getLeaseId(), seed.getEpoch());
    }

    static URI endpoint(String ip) {
        String[] parts = ip.split("\\.", -1);
        require(parts.length == 4);
        for (String part : parts) {
            require(part.matches("0|[1-9][0-9]{0,2}") && Integer.parseInt(part) <= 255);
        }
        int first = Integer.parseInt(parts[0]);
        require(first > 0 && first != 127 && first < 224 && !(first == 169 && "254".equals(parts[1])));
        return URI.create("http://" + ip + ":43190/");
    }

    static String name(RuntimeProvisionSeed seed) {
        return "qwen-csi-" + digest(seed.getProvisionRequestId()).substring(0, 48);
    }

    static byte[] bytes(Object value) {
        try {
            return JSON.writeValueAsBytes(value);
        } catch (JsonProcessingException failure) {
            throw unavailable();
        }
    }

    static String digest(Object value) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes(value)));
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    static boolean same(Object first, Object second) {
        return java.util.Arrays.equals(bytes(first), bytes(second));
    }

    @SuppressWarnings("unchecked")
    static Map<String, Object> map(Object value) {
        require(value instanceof Map<?, ?>);
        return (Map<String, Object>) value;
    }

    static String text(Map<String, Object> value, String key, int maximum) {
        require(value.get(key) instanceof String);
        String text = (String) value.get(key);
        require(!text.isBlank() && text.length() <= maximum && text.codePoints().noneMatch(point ->
                point < 32 || point >= 127 && point <= 159 || point >= 0xd800 && point <= 0xdfff));
        return text;
    }

    static void dns(String name) {
        require(name.length() <= 253);
        for (String part : name.split("\\.", -1)) {
            require(part.matches("[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"));
        }
    }

    static void uuid(String value) {
        require(UUID.fromString(value).toString().equals(value));
    }

    private static void decimal(Map<String, Object> value, String field) {
        String text = text(value, field, 19);
        require(text.matches("[1-9][0-9]{0,18}") && Long.parseLong(text) > 0);
    }

    static void require(boolean valid) {
        if (!valid) {
            throw unavailable();
        }
    }

    static RuntimeBrokerException unavailable() {
        return new RuntimeBrokerException(409, "workspace_csi_identity_conflict", "Original workspace CSI identity is unavailable.", false);
    }
}
