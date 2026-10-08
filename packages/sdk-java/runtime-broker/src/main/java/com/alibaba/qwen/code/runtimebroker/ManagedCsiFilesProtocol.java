package com.alibaba.qwen.code.runtimebroker;

import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.core.JsonToken;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.net.InetAddress;
import java.net.URI;
import java.net.UnknownHostException;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Locale;
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
    private static final Set<String> AUTHORITY_BOOT_KEYS = Set.of("type", "version", "managedCsi", "identity", "context", "storage", "authority");
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
        return boot(request, seed, storage, null);
    }

    public static Map<String, Object> boot(RuntimeProvisionRequest request, RuntimeProvisionSeed seed,
            Map<String, Object> storage, Map<String, Object> authority) {
        var value = new LinkedHashMap<String, Object>(Map.of("type", "boot", "version", authority == null ? 4 : 5,
                "managedCsi", PROTOCOL, "identity", identity(request), "context", ManagedContextProtocol.boot(request, seed),
                "storage", BrokerValues.immutableMap(storage)));
        if (authority != null) {
            validateAuthority(authority);
            value.put("authority", BrokerValues.immutableMap(authority));
        }
        validateBoot(value);
        return BrokerValues.immutableMap(value);
    }

    public static Map<String, Object> authority(String origin) {
        try {
            require(origin != null && !origin.isEmpty() && origin.length() <= 2048);
            URI uri = URI.create(origin);
            String scheme = uri.getScheme();
            String host = canonicalHost(uri.getHost());
            int port = uri.getPort();
            require(("https".equals(scheme) || "http".equals(scheme))
                    && uri.getRawUserInfo() == null && uri.getRawQuery() == null && uri.getRawFragment() == null
                    && (uri.getRawPath() == null || uri.getRawPath().isEmpty())
                    && (port == -1 || port > 0 && port <= 65535)
                    && !("https".equals(scheme) && port == 443 || "http".equals(scheme) && port == 80)
                    && origin.equals(scheme + "://" + host + (port == -1 ? "" : ":" + port))
                    && ("https".equals(scheme) || "localhost".equals(host) || "[::1]".equals(host)
                            || host.matches("127(?:\\.(?:0|[1-9][0-9]{0,2})){3}")));
            return Map.of("protocolVersion", 1, "origin", origin);
        } catch (RuntimeException | UnknownHostException failure) {
            throw new IllegalArgumentException("Invalid private CSI authority origin.");
        }
    }

    private static String canonicalHost(String host) throws UnknownHostException {
        require(host != null && host.equals(host.toLowerCase(Locale.ROOT)) && !host.endsWith(".")
                && !host.startsWith("xn--") && !host.contains(".xn--"));
        if (host.startsWith("[")) {
            require(host.endsWith("]") && host.indexOf('%') < 0);
            byte[] address = InetAddress.getByName(host).getAddress();
            if (address.length == 4) {
                byte[] mapped = new byte[16];
                mapped[10] = (byte) 0xff;
                mapped[11] = (byte) 0xff;
                System.arraycopy(address, 0, mapped, 12, 4);
                address = mapped;
            }
            int[] parts = new int[8];
            int bestStart = -1;
            int bestLength = 1;
            for (int i = 0; i < parts.length; i++) {
                parts[i] = (Byte.toUnsignedInt(address[i * 2]) << 8) | Byte.toUnsignedInt(address[i * 2 + 1]);
            }
            for (int start = 0; start < parts.length; start++) {
                int end = start;
                while (end < parts.length && parts[end] == 0) {
                    end++;
                }
                if (end - start > bestLength) {
                    bestStart = start;
                    bestLength = end - start;
                }
            }
            var result = new StringBuilder("[");
            for (int i = 0; i < parts.length; i++) {
                if (i == bestStart) {
                    result.append("::");
                    i += bestLength - 1;
                } else {
                    if (i > 0 && i != bestStart + bestLength) {
                        result.append(':');
                    }
                    result.append(Integer.toHexString(parts[i]));
                }
            }
            return result.append(']').toString();
        }
        String tail = host.substring(host.lastIndexOf('.') + 1);
        if (tail.matches("[0-9]+|0x[0-9a-f]*")) {
            String[] parts = host.split("\\.", -1);
            require(parts.length == 4);
            for (String part : parts) {
                require(part.matches("0|[1-9][0-9]{0,2}") && Integer.parseInt(part) <= 255);
            }
        }
        return host;
    }

    private static void validateAuthority(Map<String, Object> value) {
        require(value.keySet().equals(Set.of("protocolVersion", "origin"))
                && Long.valueOf(1).equals(BrokerValues.exactLong(value.get("protocolVersion")))
                && value.get("origin") instanceof String);
        require(BrokerValues.sameJsonMap(value, authority((String) value.get("origin"))));
    }

    public static void validateBoot(Map<String, Object> boot) {
        require(boot != null);
        Long version = BrokerValues.exactLong(boot.get("version"));
        boolean authorityBoot = Long.valueOf(5).equals(version);
        require(boot.keySet().equals(authorityBoot ? AUTHORITY_BOOT_KEYS : BOOT_KEYS) && "boot".equals(boot.get("type"))
                && (authorityBoot || Long.valueOf(4).equals(version)) && PROTOCOL.equals(boot.get("managedCsi")));
        if (authorityBoot) {
            validateAuthority(map(boot.get("authority")));
        }
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
