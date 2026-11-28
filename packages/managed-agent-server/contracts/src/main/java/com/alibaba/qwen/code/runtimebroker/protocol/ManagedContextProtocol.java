package com.alibaba.qwen.code.runtimebroker.protocol;

import com.alibaba.fastjson2.JSON;
import com.alibaba.fastjson2.JSONReader;
import com.alibaba.qwen.code.runtimebroker.BrokerValues;
import com.alibaba.qwen.code.runtimebroker.ManagedExtensionExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionSeed;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import com.fasterxml.jackson.core.JsonFactory;
import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.core.JsonToken;
import com.fasterxml.jackson.core.StreamReadConstraints;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.net.URI;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Closed managed-context/1 records shared with the TypeScript Worker. */
public final class ManagedContextProtocol {
    public static final String PROTOCOL = "managed-context/1";
    public static final String ATTEST_PATH = "/internal/managed-runtime/v3/attest";
    public static final String CONTEXT_PATH = "/internal/managed-runtime/v3/context";
    public static final String PUBLISHER_DETACH_PATH = "/internal/managed-runtime/v3/publisher/detach";
    public static final String OBSERVATION_PULL_PATH = "/internal/managed-runtime/v3/observations/pull";
    private static final long MAX_EPOCH = 9_007_199_254_740_991L;
    private static final Pattern IDENTIFIER = Pattern.compile(
            "[A-Za-z0-9._:-]{1,128}");
    private static final Pattern ORIGIN = Pattern.compile(
            "http://127\\.0\\.0\\.1:([1-9][0-9]{0,4})");
    private static final Set<String> BOOT_KEYS = Set.of("type", "version",
            "managedContext", "runtimeInstanceId", "runtimeIncarnation",
            "leaseId", "provisionRequestId", "token", "epoch",
            "capabilityDigest", "isolationClass", "tenantId", "workspaceId",
            "workspaceGeneration", "storageId", "mountRoot");
    private static final Set<String> READY_KEYS = Set.of("type", "version",
            "managedContext", "runtimeInstanceId", "runtimeIncarnation",
            "leaseId", "epoch", "url");

    public record Boot(String runtimeInstanceId, String runtimeIncarnation,
            String leaseId, String provisionRequestId, String token, long epoch,
            String tenantId, String workspaceId, String workspaceGeneration,
            String storageId, String mountRoot, String capabilityDigest,
            String isolationClass, Map<String, Object> managedExtensions) {
        public Boot {
            managedExtensions = managedExtensions == null ? null
                    : BrokerValues.immutableMap(managedExtensions);
        }

        public Map<String, Object> toWire() {
            Map<String, Object> wire = new LinkedHashMap<>();
            wire.put("type", "boot");
            wire.put("version", 2);
            wire.put("managedContext", PROTOCOL);
            wire.put("runtimeInstanceId", runtimeInstanceId);
            wire.put("runtimeIncarnation", runtimeIncarnation);
            wire.put("leaseId", leaseId);
            wire.put("provisionRequestId", provisionRequestId);
            wire.put("epoch", epoch);
            wire.put("token", token);
            wire.put("tenantId", tenantId);
            wire.put("workspaceId", workspaceId);
            wire.put("workspaceGeneration", workspaceGeneration);
            wire.put("storageId", storageId);
            wire.put("mountRoot", mountRoot);
            wire.put("capabilityDigest", capabilityDigest);
            wire.put("isolationClass", isolationClass);
            if (managedExtensions != null) {
                wire.put("managedExtensions", managedExtensions);
            }
            return Map.copyOf(wire);
        }

        @Override
        public String toString() {
            return "Boot[runtimeInstanceId=" + runtimeInstanceId
                    + ", leaseId=" + leaseId + ", epoch=" + epoch + "]";
        }
    }

    public record Ready(String runtimeInstanceId, String runtimeIncarnation,
            String leaseId, long epoch, URI url) {
    }

    private ManagedContextProtocol() {
    }

    public static String storageId(String value) {
        require(value != null && value.matches("[\\x21-\\x7e]{1,256}"));
        return value;
    }

    public static void validateScope(RuntimeProvisionRequest request) {
        RuntimeScope scope = request.getScope();
        identifier(scope.getTenantId());
        identifier(scope.getWorkspaceId());
        decimal(scope.getWorkspaceGeneration());
        mountRoot(scope.getCanonicalCwd());
        require(scope.getCapabilityDigest().matches("sha256:[0-9a-f]{64}"));
    }

    public static Boot boot(RuntimeProvisionRequest request,
            RuntimeProvisionSeed seed) {
        return boot(request, seed, null);
    }

    public static Boot boot(RuntimeProvisionRequest request, RuntimeProvisionSeed seed, Map<String, Object> extensions) {
        require(request != null && request.isManagedContext() && seed != null);
        RuntimeScope scope = request.getScope();
        Map<String, Object> boot = new LinkedHashMap<>();
        boot.put("type", "boot");
        boot.put("version", 2);
        boot.put("managedContext", PROTOCOL);
        boot.put("runtimeInstanceId", seed.getProvisionalRuntimeId());
        boot.put("runtimeIncarnation", seed.getGatewayIncarnation());
        boot.put("leaseId", seed.getLeaseId());
        boot.put("provisionRequestId", seed.getProvisionRequestId());
        boot.put("epoch", seed.getEpoch());
        boot.put("token", seed.getToken());
        boot.put("tenantId", scope.getTenantId());
        boot.put("workspaceId", scope.getWorkspaceId());
        boot.put("workspaceGeneration", scope.getWorkspaceGeneration());
        boot.put("storageId", request.getStorageId());
        boot.put("mountRoot", scope.getCanonicalCwd());
        boot.put("capabilityDigest", scope.getCapabilityDigest());
        boot.put("isolationClass", scope.getIsolationClass());
        if (extensions != null) {
            boot.put("managedExtensions", extensions);
        }
        return parseBoot(boot);
    }

    @SuppressWarnings("unchecked")
    public static Boot parseBoot(Map<String, Object> boot) {
        Map<String, Object> snapshot = BrokerValues.immutableMap(boot);
        validateBoot(snapshot);
        return new Boot(string(snapshot, "runtimeInstanceId"),
                string(snapshot, "runtimeIncarnation"), string(snapshot, "leaseId"),
                string(snapshot, "provisionRequestId"), string(snapshot, "token"),
                integer(snapshot.get("epoch")), string(snapshot, "tenantId"),
                string(snapshot, "workspaceId"), string(snapshot, "workspaceGeneration"),
                string(snapshot, "storageId"), string(snapshot, "mountRoot"),
                string(snapshot, "capabilityDigest"), string(snapshot, "isolationClass"),
                (Map<String, Object>) snapshot.get("managedExtensions"));
    }

    public static void validateBoot(Map<String, Object> boot) {
        Set<String> expectedKeys = new HashSet<>(BOOT_KEYS);
        if (boot.containsKey("managedExtensions")) {
            expectedKeys.add("managedExtensions");
        }
        require(boot.keySet().equals(expectedKeys)
                && "boot".equals(boot.get("type"))
                && exactNumber(boot.get("version"), 2)
                && PROTOCOL.equals(boot.get("managedContext")));
        for (String key : Set.of("runtimeInstanceId", "runtimeIncarnation",
                "leaseId", "provisionRequestId", "tenantId", "workspaceId")) {
            identifier(string(boot, key));
        }
        long epoch = integer(boot.get("epoch"));
        require(epoch > 0 && epoch <= MAX_EPOCH);
        String token = string(boot, "token");
        require(token.length() <= 512
                && token.matches("[A-Za-z0-9._~+/-]+=*"));
        storageId(string(boot, "storageId"));
        decimal(string(boot, "workspaceGeneration"));
        mountRoot(string(boot, "mountRoot"));
        require(string(boot, "capabilityDigest")
                .matches("sha256:[0-9a-f]{64}"));
        require(Set.of("session", "workspace")
                .contains(string(boot, "isolationClass")));
        boolean extended = ManagedExtensionExecutionProfile.admits(string(boot, "capabilityDigest"));
        require(extended == boot.containsKey("managedExtensions"));
        if (extended) {
            require(boot.get("managedExtensions") instanceof Map<?, ?>);
            Map<?, ?> config = (Map<?, ?>) boot.get("managedExtensions");
            if (ManagedExtensionExecutionProfile.LINUX_CAPABILITY_DIGEST.equals(string(boot, "capabilityDigest"))) {
                require(config.get("cgroupRoot") instanceof String cgroup && Path.of(cgroup).isAbsolute());
            }
            require((config.keySet().equals(Set.of("enabled", "mode", "cacheDirectory")) || config.keySet().equals(Set.of("enabled", "mode", "cacheDirectory", "cgroupRoot"))) && Boolean.TRUE.equals(config.get("enabled"))
                    && ManagedExtensionExecutionProfile.mode(string(boot, "capabilityDigest")).equals(config.get("mode"))
                    && config.get("cacheDirectory") instanceof String directory && Path.of(directory).isAbsolute());
        }
    }

    public static Ready ready(Map<String, Object> ready, Boot boot) {
        require(ready.keySet().equals(READY_KEYS)
                && "ready".equals(ready.get("type"))
                && exactNumber(ready.get("version"), 2)
                && PROTOCOL.equals(ready.get("managedContext")));
        require(boot.runtimeInstanceId().equals(ready.get("runtimeInstanceId"))
                && boot.runtimeIncarnation().equals(ready.get("runtimeIncarnation"))
                && boot.leaseId().equals(ready.get("leaseId")));
        require(exactNumber(ready.get("epoch"), boot.epoch()));
        String url = string(ready, "url");
        Matcher origin = ORIGIN.matcher(url);
        require(origin.matches() && Integer.parseInt(origin.group(1)) <= 65535);
        return new Ready(boot.runtimeInstanceId(), boot.runtimeIncarnation(),
                boot.leaseId(), boot.epoch(), URI.create(url));
    }

    public static Map<String, Object> attestationRequest(Map<String, Object> boot) {
        Map<String, Object> body = new LinkedHashMap<>(boot);
        Set.of("type", "version", "token", "runtimeInstanceId",
                "runtimeIncarnation", "leaseId", "epoch").forEach(body::remove);
        body.put("protocolVersion", 3);
        return Map.copyOf(body);
    }

    public static Map<String, Object> attestationResponse(Map<String, Object> boot) {
        Map<String, Object> response = new LinkedHashMap<>(boot);
        Set.of("type", "version", "token").forEach(response::remove);
        response.put("protocolVersion", 3);
        return Map.copyOf(response);
    }

    public static Map<String, Object> installation(RuntimeProvisionRequest request,
            String operationId, String sessionId, ContextBinding binding) {
        require(request != null && request.isManagedContext() && binding != null);
        identifier(operationId);
        BrokerValues.requireId(sessionId, "sessionId");
        wellFormed(sessionId);
        RuntimeScope scope = request.getScope();
        require(scope.getTenantId().equals(binding.getTenantId())
                && scope.getWorkspaceId().equals(binding.getWorkspaceId())
                && scope.getWorkspaceGeneration().equals(
                        Long.toString(binding.getWorkspaceGeneration()))
                && request.getStorageId().equals(binding.getStorageId()));
        Map<String, Object> fields = Map.of(
                "tenantId", binding.getTenantId(),
                "workspaceId", binding.getWorkspaceId(),
                "workspaceGeneration", Long.toString(binding.getWorkspaceGeneration()),
                "storageId", binding.getStorageId(),
                "cwdRelative", binding.getCwdRelative(),
                "contextConfigRef", binding.getContextConfigRef(),
                "contextRevision", Long.toString(binding.getContextRevision()));
        return Map.of("protocolVersion", 3, "managedContext", PROTOCOL,
                "operationId", operationId, "sessionId", sessionId,
                "binding", fields, "contextDigest", binding.getContextDigest());
    }

    public static Map<String, Object> receipt(RuntimeProvisionSeed seed,
            String operationId, String sessionId, ContextBinding binding) {
        return Map.of("protocolVersion", 3, "managedContext", PROTOCOL,
                "operationId", operationId, "sessionId", sessionId,
                "runtimeInstanceId", seed.getProvisionalRuntimeId(),
                "runtimeIncarnation", seed.getGatewayIncarnation(),
                "epoch", seed.getEpoch(), "contextDigest", binding.getContextDigest(),
                "contextRevision", Long.toString(binding.getContextRevision()),
                "workspaceGeneration", Long.toString(binding.getWorkspaceGeneration()));
    }

    public static Map<String, Object> parse(byte[] bytes) {
        try {
            String json = StandardCharsets.UTF_8.newDecoder()
                    .decode(ByteBuffer.wrap(bytes)).toString();
            return BrokerValues.immutableMap(JSON.parseObject(json,
                    JSONReader.Feature.DisableReferenceDetect,
                    JSONReader.Feature.UseBigDecimalForDoubles,
                    JSONReader.Feature.UseBigDecimalForFloats));
        } catch (CharacterCodingException | RuntimeException failure) {
            throw invalidResponse();
        }
    }

    private static final ObjectMapper CANONICAL_JSON = new ObjectMapper(JsonFactory.builder()
            .streamReadConstraints(StreamReadConstraints.builder()
                    .maxNestingDepth(64).maxStringLength(32 * 1024 * 1024).build()).build())
            .enable(JsonParser.Feature.STRICT_DUPLICATE_DETECTION)
            .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS);

    /**
     * Strict reader for external drain proofs: every JSON number must be a
     * canonical safe integer, and duplicate keys or trailing content are
     * rejected. {@link #parse(byte[])} is intentionally lenient about number
     * representation; drain proofs are not.
     */
    public static Map<String, Object> parseCanonical(byte[] bytes, int limit) {
        try {
            if (bytes == null || bytes.length > limit) {
                throw invalidResponse();
            }
            String text = StandardCharsets.UTF_8.newDecoder().decode(ByteBuffer.wrap(bytes)).toString();
            try (JsonParser parser = CANONICAL_JSON.createParser(text)) {
                for (JsonToken token = parser.nextToken(); token != null; token = parser.nextToken()) {
                    if (token.isNumeric() && (token != JsonToken.VALUE_NUMBER_INT
                            || !parser.getText().matches("0|[1-9][0-9]*")
                            || parser.getBigIntegerValue().bitLength() > 53)) {
                        throw invalidResponse();
                    }
                }
            }
            return BrokerValues.immutableMap(CANONICAL_JSON.readValue(text,
                    new TypeReference<Map<String, Object>>() { }));
        } catch (IOException | RuntimeException failure) {
            throw invalidResponse();
        }
    }

    public static void verify(Map<String, Object> actual, Map<String, Object> expected) {
        if (!BrokerValues.sameJsonMap(actual, expected)) {
            throw new RuntimeBrokerException(409,
                    "managed_runtime_identity_conflict",
                    "Managed context response does not match the request.", false);
        }
    }

    public static RuntimeBrokerException invalidResponse() {
        return new RuntimeBrokerException(502, "managed_runtime_attestation_invalid",
                "Managed context response is invalid.", false);
    }

    private static void identifier(String value) {
        require(value != null && IDENTIFIER.matcher(value).matches());
    }

    private static void decimal(String value) {
        require(value.matches("[1-9][0-9]{0,18}"));
        try {
            require(Long.parseLong(value) > 0);
        } catch (NumberFormatException failure) {
            throw new IllegalArgumentException("Managed context decimal is invalid.");
        }
    }

    private static void mountRoot(String value) {
        wellFormed(value);
        require(value.matches("(?s)(?:/|[A-Za-z]:[\\\\/]|\\\\\\\\).*"));
        require(value.getBytes(StandardCharsets.UTF_8).length <= 4096);
        value.codePoints().forEach(point -> require(
                point > 0x1f && (point < 0x7f || point > 0x9f)));
    }

    private static void wellFormed(String value) {
        value.codePoints().forEach(point -> require(point < 0xd800 || point > 0xdfff));
    }

    private static String string(Map<String, Object> fields, String key) {
        require(fields.get(key) instanceof String);
        return (String) fields.get(key);
    }

    private static long integer(Object value) {
        Long exact = BrokerValues.exactLong(value);
        if (exact == null) {
            throw new IllegalArgumentException("Managed context number is invalid.");
        }
        return exact;
    }

    private static boolean exactNumber(Object value, long expected) {
        return integer(value) == expected;
    }

    private static void require(boolean condition) {
        if (!condition) {
            throw new IllegalArgumentException("Managed context record is invalid.");
        }
    }
}
