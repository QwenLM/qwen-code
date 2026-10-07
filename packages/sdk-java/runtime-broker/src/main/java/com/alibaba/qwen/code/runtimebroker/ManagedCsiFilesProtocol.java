package com.alibaba.qwen.code.runtimebroker;

import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.core.JsonToken;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;

/** Closed private file identity; construction grants no native file admission. */
public final class ManagedCsiFilesProtocol {
    public static final String PROTOCOL = "managed-csi/2";
    public static final String PREFIX = "/internal/managed-runtime/csi/v2";
    public static final String ATTEST_PATH = PREFIX + "/attest";
    public static final String CONTEXT_ATTEST_PATH = PREFIX + "/context-attest";
    public static final String CONTEXT_PATH = PREFIX + "/context";
    private static final Set<String> BOOT_KEYS = Set.of("type", "version", "managedCsi", "identity", "context", "storage");
    private static final ObjectMapper JSON = new ObjectMapper()
            .enable(JsonParser.Feature.STRICT_DUPLICATE_DETECTION)
            .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS);

    private ManagedCsiFilesProtocol() {
    }

    public static boolean selects(RuntimeProvisionRequest request) {
        if (request == null || !CsiFilesRetirementProfile.CAPABILITY_DIGEST.equals(request.getScope().getCapabilityDigest())) {
            return false;
        }
        identity(request);
        return true;
    }

    public static Map<String, Object> identity(RuntimeProvisionRequest request) {
        require(request != null && request.isManagedContext()
                && CsiFilesRetirementProfile.PROVISIONER_KIND.equals(request.getProvisionerKind())
                && CsiFilesRetirementProfile.CAPABILITY_DIGEST.equals(request.getScope().getCapabilityDigest())
                && "session".equals(request.getScope().getIsolationClass())
                && request.getIsolationKey() != null && request.getIsolationKey().matches(
                        "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"));
        return Map.of("profile", CsiFilesRetirementProfile.PROFILE, "sessionId", request.getIsolationKey(),
                "capabilityDigest", CsiFilesRetirementProfile.CAPABILITY_DIGEST);
    }

    public static Map<String, Object> boot(RuntimeProvisionRequest request, RuntimeProvisionSeed seed,
            Map<String, Object> storage) {
        var value = Map.<String, Object>of("type", "boot", "version", 4, "managedCsi", PROTOCOL,
                "identity", identity(request), "context", ManagedContextProtocol.boot(request, seed),
                "storage", BrokerValues.immutableMap(storage));
        validateBoot(value);
        return value;
    }

    public static void validateBoot(Map<String, Object> boot) {
        require(boot != null && boot.keySet().equals(BOOT_KEYS) && "boot".equals(boot.get("type"))
                && Long.valueOf(4).equals(BrokerValues.exactLong(boot.get("version"))) && PROTOCOL.equals(boot.get("managedCsi")));
        ManagedCsiProtocol.validateBoot(dataBoot(boot));
        var identity = map(boot.get("identity"));
        var context = map(boot.get("context"));
        require(identity.keySet().equals(Set.of("profile", "sessionId", "capabilityDigest"))
                && CsiFilesRetirementProfile.PROFILE.equals(identity.get("profile"))
                && CsiFilesRetirementProfile.CAPABILITY_DIGEST.equals(identity.get("capabilityDigest"))
                && identity.get("sessionId") instanceof String sessionId && sessionId.matches(
                        "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")
                && "session".equals(context.get("isolationClass"))
                && identity.get("capabilityDigest").equals(context.get("capabilityDigest")));
    }

    public static Map<String, Object> wrapContext(RuntimeProvisionRequest request, Map<String, Object> context) {
        return Map.of("protocolVersion", 2, "managedCsi", PROTOCOL, "identity", identity(request),
                "context", BrokerValues.immutableMap(context));
    }

    public static Map<String, Object> unwrapContext(RuntimeProvisionRequest request, Map<String, Object> actual) {
        require(actual.keySet().equals(Set.of("protocolVersion", "managedCsi", "identity", "context")));
        verifyIdentity(actual, identity(request));
        return BrokerValues.immutableMap(map(actual.get("context")));
    }

    public static Map<String, Object> attestationRequest(Map<String, Object> boot) {
        validateBoot(boot);
        var value = new LinkedHashMap<>(ManagedCsiProtocol.attestationRequest(dataBoot(boot)));
        value.put("protocolVersion", 2);
        value.put("managedCsi", PROTOCOL);
        value.put("identity", boot.get("identity"));
        return BrokerValues.immutableMap(value);
    }

    public static Map<String, Object> verifyAttestation(Map<String, Object> actual, Map<String, Object> boot,
            Map<String, Object> pod) {
        validateBoot(boot);
        require(actual.keySet().equals(Set.of("protocolVersion", "managedCsi", "identity", "context", "storage", "pod", "mount")));
        verifyIdentity(actual, map(boot.get("identity")));
        var data = new LinkedHashMap<>(actual);
        data.remove("identity");
        data.put("protocolVersion", 1);
        data.put("managedCsi", ManagedCsiProtocol.PROTOCOL);
        ManagedCsiProtocol.verifyAttestation(data, dataBoot(boot), pod);
        return BrokerValues.immutableMap(actual);
    }

    public static Map<String, Object> parse(byte[] bytes) {
        try {
            require(bytes != null && bytes.length <= 32 * 1024);
            String text = StandardCharsets.UTF_8.newDecoder().decode(ByteBuffer.wrap(bytes)).toString();
            try (var parser = JSON.createParser(text)) {
                for (JsonToken token = parser.nextToken(); token != null; token = parser.nextToken()) {
                    if (token.isNumeric()) {
                        require(token == JsonToken.VALUE_NUMBER_INT && parser.getText().matches("0|[1-9][0-9]*")
                                && parser.getBigIntegerValue().bitLength() <= 53);
                    }
                }
            }
            return BrokerValues.immutableMap(JSON.readValue(text, new TypeReference<Map<String, Object>>() { }));
        } catch (IOException | RuntimeException error) {
            throw new IllegalArgumentException("Invalid private CSI file JSON.");
        }
    }

    private static void verifyIdentity(Map<String, Object> body, Map<String, Object> identity) {
        require(Long.valueOf(2).equals(BrokerValues.exactLong(body.get("protocolVersion")))
                && PROTOCOL.equals(body.get("managedCsi")) && BrokerValues.sameJsonMap(map(body.get("identity")), identity));
    }

    private static Map<String, Object> dataBoot(Map<String, Object> boot) {
        return Map.of("type", "boot", "version", 3, "managedCsi", ManagedCsiProtocol.PROTOCOL,
                "context", map(boot.get("context")), "storage", map(boot.get("storage")));
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> map(Object value) {
        require(value instanceof Map<?, ?>);
        return (Map<String, Object>) value;
    }

    private static void require(boolean valid) {
        if (!valid) {
            throw new IllegalArgumentException("Invalid private CSI file identity.");
        }
    }
}
