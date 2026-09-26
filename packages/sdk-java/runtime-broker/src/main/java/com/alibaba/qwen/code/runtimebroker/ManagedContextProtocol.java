package com.alibaba.qwen.code.runtimebroker;

import com.alibaba.fastjson2.JSON;
import com.alibaba.fastjson2.JSONReader;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import java.math.BigDecimal;
import java.net.URI;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Closed managed-context/1 records shared with the TypeScript Worker. */
final class ManagedContextProtocol {
    static final String PROTOCOL = "managed-context/1";
    static final String ATTEST_PATH = "/internal/managed-runtime/v3/attest";
    static final String CONTEXT_PATH = "/internal/managed-runtime/v3/context";
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

    private ManagedContextProtocol() {
    }

    static String storageId(String value) {
        require(value != null && value.matches("[\\x21-\\x7e]{1,256}"));
        return value;
    }

    static void validateScope(RuntimeProvisionRequest request) {
        RuntimeScope scope = request.getScope();
        identifier(scope.getTenantId());
        identifier(scope.getWorkspaceId());
        decimal(scope.getWorkspaceGeneration());
        mountRoot(scope.getCanonicalCwd());
        require(scope.getCapabilityDigest().matches("sha256:[0-9a-f]{64}"));
    }

    static Map<String, Object> boot(RuntimeProvisionRequest request,
            RuntimeProvisionSeed seed) {
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
        validateBoot(boot);
        return Map.copyOf(boot);
    }

    static void validateBoot(Map<String, Object> boot) {
        require(boot.keySet().equals(BOOT_KEYS)
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
    }

    static URI ready(Map<String, Object> ready, Map<String, Object> boot) {
        require(ready.keySet().equals(READY_KEYS)
                && "ready".equals(ready.get("type"))
                && exactNumber(ready.get("version"), 2)
                && PROTOCOL.equals(ready.get("managedContext")));
        for (String key : Set.of("runtimeInstanceId", "runtimeIncarnation",
                "leaseId")) {
            require(boot.get(key).equals(ready.get(key)));
        }
        require(exactNumber(ready.get("epoch"), integer(boot.get("epoch"))));
        String url = string(ready, "url");
        Matcher origin = ORIGIN.matcher(url);
        require(origin.matches() && Integer.parseInt(origin.group(1)) <= 65535);
        return URI.create(url);
    }

    static Map<String, Object> attestationRequest(Map<String, Object> boot) {
        Map<String, Object> body = new LinkedHashMap<>(boot);
        Set.of("type", "version", "token", "runtimeInstanceId",
                "runtimeIncarnation", "leaseId", "epoch").forEach(body::remove);
        body.put("protocolVersion", 3);
        return Map.copyOf(body);
    }

    static Map<String, Object> attestationResponse(Map<String, Object> boot) {
        Map<String, Object> response = new LinkedHashMap<>(boot);
        Set.of("type", "version", "token").forEach(response::remove);
        response.put("protocolVersion", 3);
        return Map.copyOf(response);
    }

    static Map<String, Object> installation(RuntimeProvisionRequest request,
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

    static Map<String, Object> receipt(RuntimeProvisionSeed seed,
            String operationId, String sessionId, ContextBinding binding) {
        return Map.of("protocolVersion", 3, "managedContext", PROTOCOL,
                "operationId", operationId, "sessionId", sessionId,
                "runtimeInstanceId", seed.getProvisionalRuntimeId(),
                "runtimeIncarnation", seed.getGatewayIncarnation(),
                "epoch", seed.getEpoch(), "contextDigest", binding.getContextDigest(),
                "contextRevision", Long.toString(binding.getContextRevision()),
                "workspaceGeneration", Long.toString(binding.getWorkspaceGeneration()));
    }

    static Map<String, Object> parse(byte[] bytes) {
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

    static void verify(Map<String, Object> actual, Map<String, Object> expected) {
        if (!BrokerValues.sameJsonMap(actual, expected)) {
            throw new RuntimeBrokerException(409,
                    "managed_runtime_identity_conflict",
                    "Managed context response does not match the request.", false);
        }
    }

    static RuntimeBrokerException invalidResponse() {
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
        require(value instanceof Number);
        try {
            return new BigDecimal(value.toString()).longValueExact();
        } catch (ArithmeticException | NumberFormatException failure) {
            throw new IllegalArgumentException("Managed context number is invalid.");
        }
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
