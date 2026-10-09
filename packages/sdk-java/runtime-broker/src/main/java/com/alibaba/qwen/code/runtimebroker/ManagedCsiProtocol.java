package com.alibaba.qwen.code.runtimebroker;

import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.core.JsonToken;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.text.Normalizer;
import java.util.HexFormat;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/** ACK Disk control envelope, separate from the closed managed-context/1 boot. */
public final class ManagedCsiProtocol {
    public static final String PROTOCOL = "managed-csi/1";
    public static final String ATTEST_PATH = "/internal/managed-runtime/csi/v1/attest";
    public static final String ACKNOWLEDGE_PATH = "/internal/managed-runtime/csi/v1/acknowledge";
    public static final String WORKER_ACK = "managed-csi-original-worker-ack/1";
    private static final ObjectMapper ACK_JSON = new ObjectMapper()
            .enable(JsonParser.Feature.STRICT_DUPLICATE_DETECTION)
            .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS);
    private static final Set<String> ACK_KEYS = Set.of("protocolVersion", "managedCsi", "workerAck",
            "retirementId", "context", "storage", "pod", "reference", "acknowledgement");
    private static final Set<String> ACK_RESPONSE_KEYS = Set.of("protocolVersion", "managedCsi", "workerAck",
            "retirementId", "context", "storage", "pod", "reference", "acknowledgement", "state", "captureIdentity");
    private static final Set<String> BOOT_KEYS = Set.of("type", "version", "managedCsi", "context", "storage");
    private static final Set<String> STORAGE_KEYS = Set.of("backendDomain", "clusterDomain", "diskSerial", "driver",
            "namespace", "physicalKey", "pvUid", "pvcUid", "registrationRevision", "reservationId",
            "reservationRevision", "volumeHandle");

    private ManagedCsiProtocol() {
    }

    public static Map<String, Object> boot(RuntimeProvisionRequest request, RuntimeProvisionSeed seed,
            Map<String, Object> storage) {
        var boot = Map.<String, Object>of("type", "boot", "version", 3, "managedCsi", PROTOCOL,
                "context", ManagedContextProtocol.boot(request, seed), "storage", BrokerValues.immutableMap(storage));
        validateBoot(boot);
        return boot;
    }

    public static void validateBoot(Map<String, Object> boot) {
        try {
            require(boot.keySet().equals(BOOT_KEYS) && "boot".equals(boot.get("type"))
                    && Long.valueOf(3).equals(BrokerValues.exactLong(boot.get("version")))
                    && PROTOCOL.equals(boot.get("managedCsi")));
            var context = map(boot.get("context"));
            ManagedContextProtocol.validateBoot(context);
            var storage = map(boot.get("storage"));
            require(storage.keySet().equals(STORAGE_KEYS));
            for (String key : Set.of("clusterDomain", "backendDomain", "volumeHandle", "pvcUid", "pvUid")) {
                int maximum = key.equals("volumeHandle") ? 512 : key.endsWith("Uid") ? 128 : 256;
                String text = string(storage, key);
                require(!text.isBlank() && text.length() <= maximum);
                text.codePoints().forEach(point -> require(point > 31 && (point < 127 || point > 159)
                        && (point < 0xd800 || point > 0xdfff)));
            }
            KubernetesHttpRuntimeClient.dnsLabel(string(storage, "namespace"));
            require("diskplugin.csi.alibabacloud.com".equals(storage.get("driver")));
            require(string(storage, "diskSerial").matches("[A-Za-z0-9._:-]{1,128}"));
            for (String field : Set.of("registrationRevision", "reservationRevision")) {
                String decimal = string(storage, field);
                require(decimal.matches("[1-9][0-9]{0,18}") && Long.parseLong(decimal) > 0);
            }
            String reservationId = string(storage, "reservationId");
            require(UUID.fromString(reservationId).toString().equals(reservationId));
            String root = string(context, "mountRoot");
            require(root.startsWith("/") && root.length() <= 2048 && !root.contains("\\"));
            for (String component : root.substring(1).split("/", -1)) {
                require(!component.isEmpty() && !component.equals(".") && !component.equals(".."));
            }
            require(physicalKey(string(storage, "backendDomain"), string(storage, "driver"),
                    string(storage, "volumeHandle")).equals(string(storage, "physicalKey")));
        } catch (RuntimeException failure) {
            throw new IllegalArgumentException("Managed CSI boot document is invalid.");
        }
    }

    public static Map<String, Object> attestationRequest(Map<String, Object> boot) {
        validateBoot(boot);
        var context = map(boot.get("context"));
        var storage = map(boot.get("storage"));
        return Map.of("protocolVersion", 1, "managedCsi", PROTOCOL,
                "provisionRequestId", context.get("provisionRequestId"),
                "physicalKey", storage.get("physicalKey"),
                "registrationRevision", storage.get("registrationRevision"),
                "reservationId", storage.get("reservationId"),
                "reservationRevision", storage.get("reservationRevision"));
    }

    public static void validateAttestationRequest(Map<String, Object> actual, Map<String, Object> boot) {
        try {
            require(BrokerValues.sameJsonMap(actual, attestationRequest(boot)));
        } catch (RuntimeException failure) {
            throw new IllegalArgumentException("Managed CSI attestation request is invalid.");
        }
    }

    public static Map<String, Object> verifyAttestation(Map<String, Object> actual, Map<String, Object> boot,
            Map<String, Object> expectedPod) {
        try {
            validateBoot(boot);
            var context = map(boot.get("context"));
            var storage = map(boot.get("storage"));
            validatePodIdentity(expectedPod, string(storage, "namespace"));
            require(actual.keySet().equals(Set.of("protocolVersion", "managedCsi", "context", "storage", "pod", "mount"))
                    && Long.valueOf(1).equals(BrokerValues.exactLong(actual.get("protocolVersion")))
                    && PROTOCOL.equals(actual.get("managedCsi"))
                    && BrokerValues.sameJsonMap(map(actual.get("context")), ManagedContextProtocol.attestationResponse(context))
                    && BrokerValues.sameJsonMap(map(actual.get("storage")), storage)
                    && BrokerValues.sameJsonMap(map(actual.get("pod")), expectedPod));
            var mount = map(actual.get("mount"));
            require(mount.keySet().equals(Set.of("mountId", "device", "source", "diskSerial", "rootDevice", "rootInode")));
            unsignedDecimal(string(mount, "mountId"), 32, true);
            unsignedDecimal(string(mount, "rootInode"), 64, true);
            unsignedDecimal(string(mount, "rootDevice"), 64, false);
            require(storage.get("diskSerial").equals(mount.get("diskSerial"))
                    && string(mount, "source").length() <= 128
                    && string(mount, "source").matches("/dev/nvme(?:0|[1-9][0-9]*)n[1-9][0-9]*")
                    && linuxDeviceNumber(string(mount, "device")).equals(mount.get("rootDevice")));
            return BrokerValues.immutableMap(actual);
        } catch (RuntimeException failure) {
            throw new IllegalArgumentException("Managed CSI attestation response is invalid.");
        }
    }

    public static void validatePodIdentity(Map<String, Object> pod, String namespace) {
        try {
            require(pod.keySet().equals(Set.of("uid", "namespace", "nodeName"))
                    && string(pod, "uid").matches("[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}")
                    && namespace.equals(pod.get("namespace")));
            KubernetesHttpRuntimeClient.dnsSubdomain(string(pod, "nodeName"));
        } catch (RuntimeException failure) {
            throw new IllegalArgumentException("Managed CSI Pod identity is unavailable.");
        }
    }

    public static Map<String, Object> parseAcknowledgement(byte[] bytes) {
        try {
            require(bytes != null && bytes.length <= 16 * 1024);
            String json = StandardCharsets.UTF_8.newDecoder().decode(ByteBuffer.wrap(bytes)).toString();
            try (var parser = ACK_JSON.createParser(json)) {
                for (JsonToken token = parser.nextToken(); token != null; token = parser.nextToken()) {
                    if (token.isNumeric()) {
                        require(token == JsonToken.VALUE_NUMBER_INT && parser.getText().matches("[1-9][0-9]*"));
                    }
                }
            }
            return BrokerValues.immutableMap(ACK_JSON.readValue(json, new TypeReference<Map<String, Object>>() { }));
        } catch (IOException | RuntimeException failure) {
            throw new IllegalArgumentException("Managed CSI acknowledgement JSON is invalid.");
        }
    }

    public static void validateAcknowledgementRequest(Map<String, Object> actual, Map<String, Object> boot,
            Map<String, Object> expectedPod) {
        try {
            validateBoot(boot);
            var context = map(boot.get("context"));
            var storage = map(boot.get("storage"));
            validatePodIdentity(expectedPod, string(storage, "namespace"));
            require("workspace".equals(context.get("isolationClass")) && actual.keySet().equals(ACK_KEYS)
                    && Long.valueOf(1).equals(BrokerValues.exactLong(actual.get("protocolVersion")))
                    && PROTOCOL.equals(actual.get("managedCsi")) && WORKER_ACK.equals(actual.get("workerAck"))
                    && UUID.fromString(string(actual, "retirementId")).toString().equals(actual.get("retirementId"))
                    && BrokerValues.sameJsonMap(map(actual.get("context")), ManagedContextProtocol.attestationResponse(context))
                    && BrokerValues.sameJsonMap(map(actual.get("storage")), storage)
                    && BrokerValues.sameJsonMap(map(actual.get("pod")), expectedPod));
            var reference = map(actual.get("reference"));
            require(reference.keySet().equals(Set.of("sessionId", "promptId", "callId", "argsDigest")));
            for (String field : Set.of("sessionId", "promptId", "callId")) {
                stableId(string(reference, field));
            }
            require(string(reference, "argsDigest").matches("(?:sha256:)?[0-9a-f]{64}"));
            var receipt = map(actual.get("acknowledgement"));
            require(receipt.keySet().equals(Set.of("executionCallId", "manifest", "deliveryStatus", "historyRevision"))
                    && "committed".equals(receipt.get("deliveryStatus")));
            stableId(string(receipt, "executionCallId"));
            safeInteger(receipt.get("historyRevision"), 1, 9_007_199_254_740_991L);
            var manifest = map(receipt.get("manifest"));
            require(manifest.keySet().equals(Set.of("resourceId", "kind", "schemaVersion", "byteLength", "digest"))
                    && "managed-tool-result-manifest".equals(manifest.get("kind"))
                    && Long.valueOf(1).equals(BrokerValues.exactLong(manifest.get("schemaVersion")))
                    && string(manifest, "digest").matches("[0-9a-f]{64}"));
            stableId(string(manifest, "resourceId"));
            safeInteger(manifest.get("byteLength"), 1, 65536);
        } catch (RuntimeException failure) {
            throw new IllegalArgumentException("Managed CSI acknowledgement request is invalid.");
        }
    }

    public static void validateAcknowledgementIdentity(RuntimeLease lease, RuntimeSession session,
            Map<String, Object> boot, Map<String, Object> request, Map<String, Object> capture) {
        try {
            validateBoot(boot);
            var context = map(boot.get("context"));
            var reference = map(request.get("reference"));
            RuntimeScope scope = session.getScope();
            require(lease.getRuntimeInstanceId().equals(context.get("runtimeInstanceId"))
                    && lease.getToken().equals(context.get("token")) && lease.getLeaseId().equals(context.get("leaseId"))
                    && Long.valueOf(lease.getEpoch()).equals(BrokerValues.exactLong(context.get("epoch")))
                    && scope.getTenantId().equals(context.get("tenantId"))
                    && scope.getWorkspaceId().equals(context.get("workspaceId"))
                    && scope.getWorkspaceGeneration().equals(context.get("workspaceGeneration"))
                    && scope.getCanonicalCwd().equals(context.get("mountRoot"))
                    && scope.getCapabilityDigest().equals(context.get("capabilityDigest"))
                    && "workspace".equals(scope.getIsolationClass())
                    && session.getRuntimeSessionId().equals(reference.get("sessionId")));
            validateCapture(request, boot, capture);
            require(session.getHarnessSessionId().equals(capture.get("sessionId")));
        } catch (RuntimeException failure) {
            throw new IllegalArgumentException("Managed CSI acknowledgement identity is invalid.");
        }
    }

    public static Map<String, Object> verifyAcknowledgement(Map<String, Object> actual, Map<String, Object> request,
            Map<String, Object> boot, Map<String, Object> expectedPod, Map<String, Object> expectedCapture) {
        try {
            validateAcknowledgementRequest(request, boot, expectedPod);
            validateCapture(request, boot, expectedCapture);
            require(actual.keySet().equals(ACK_RESPONSE_KEYS) && "ACKNOWLEDGED".equals(actual.get("state"))
                    && BrokerValues.sameJsonMap(map(actual.get("captureIdentity")), expectedCapture));
            var echoed = new java.util.LinkedHashMap<>(actual);
            echoed.remove("state");
            echoed.remove("captureIdentity");
            require(BrokerValues.sameJsonMap(echoed, request));
            return BrokerValues.immutableMap(actual);
        } catch (RuntimeException failure) {
            throw new IllegalArgumentException("Managed CSI acknowledgement response is invalid.");
        }
    }

    private static void validateCapture(Map<String, Object> request, Map<String, Object> boot, Map<String, Object> capture) {
        var reference = map(request.get("reference"));
        var receipt = map(request.get("acknowledgement"));
        require(capture.keySet().equals(Set.of("tenantId", "sessionId", "turnId", "executionCallId",
                "callId", "invocationDigest", "bindingGeneration", "captureId", "revision"))
                && Long.valueOf(1).equals(BrokerValues.exactLong(capture.get("revision")))
                && map(boot.get("context")).get("tenantId").equals(capture.get("tenantId"))
                && reference.get("callId").equals(capture.get("callId"))
                && reference.get("argsDigest").equals(capture.get("invocationDigest"))
                && receipt.get("executionCallId").equals(capture.get("executionCallId"))
                && string(capture, "captureId").matches("[a-z0-9_-]{1,128}"));
        for (String field : Set.of("tenantId", "sessionId", "turnId", "executionCallId", "callId", "invocationDigest")) {
            stableId(string(capture, field));
        }
        String generation = string(capture, "bindingGeneration");
        require(generation.matches("[1-9][0-9]{0,18}") && Long.parseLong(generation) > 0);
    }

    private static void stableId(String value) {
        BrokerValues.requireWellFormed(value, "CSI acknowledgement ID");
        require(!value.isEmpty() && value.getBytes(StandardCharsets.UTF_8).length <= 512
                && Normalizer.isNormalized(value, Normalizer.Form.NFC));
        value.codePoints().forEach(point -> require(point > 31 && (point < 127 || point > 159)));
    }

    private static void safeInteger(Object value, long minimum, long maximum) {
        Long number = BrokerValues.exactLong(value);
        require(number != null && number >= minimum && number <= maximum);
    }

    private static String linuxDeviceNumber(String value) {
        var parts = value.split(":", -1);
        require(parts.length == 2);
        var major = unsignedDecimal(parts[0], 32, false);
        var minor = unsignedDecimal(parts[1], 32, false);
        return major.and(BigInteger.valueOf(0xfff)).shiftLeft(8)
                .or(major.and(new BigInteger("fffff000", 16)).shiftLeft(32))
                .or(minor.and(BigInteger.valueOf(0xff)))
                .or(minor.and(new BigInteger("ffffff00", 16)).shiftLeft(12)).toString();
    }

    private static BigInteger unsignedDecimal(String value, int bits, boolean positive) {
        require(value.matches("(?:0|[1-9][0-9]{0,19})") && (!positive || !value.equals("0")));
        var number = new BigInteger(value);
        require(number.bitLength() <= bits);
        return number;
    }

    public static String physicalKey(String backend, String driver, String handle) {
        try {
            var digest = MessageDigest.getInstance("SHA-256");
            for (String field : new String[] {"qwen-csi-physical/1", backend, driver, handle}) {
                byte[] bytes = field.getBytes(StandardCharsets.UTF_8);
                digest.update(ByteBuffer.allocate(4).putInt(bytes.length).array());
                digest.update(bytes);
            }
            return HexFormat.of().formatHex(digest.digest());
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 is unavailable", impossible);
        }
    }

    private static Map<String, Object> map(Object value) {
        require(value instanceof Map<?, ?>);
        var result = new java.util.LinkedHashMap<String, Object>();
        ((Map<?, ?>) value).forEach((key, field) -> {
            require(key instanceof String);
            result.put((String) key, field);
        });
        return result;
    }

    private static String string(Map<String, Object> value, String field) {
        require(value.get(field) instanceof String);
        return (String) value.get(field);
    }

    private static void require(boolean condition) {
        if (!condition) {
            throw new IllegalArgumentException();
        }
    }
}
