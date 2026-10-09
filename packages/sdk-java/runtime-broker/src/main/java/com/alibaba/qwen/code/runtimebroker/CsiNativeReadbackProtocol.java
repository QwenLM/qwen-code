package com.alibaba.qwen.code.runtimebroker;

import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/** Current original evidence, never a reusable execution capability. */
public final class CsiNativeReadbackProtocol {
    public static final String PATH = "/internal/runtime-broker/csi/v1/native:read";
    public static final int REQUEST_LIMIT = 16 * 1024;
    public static final int RESPONSE_LIMIT = 8 * 1024 * 1024;
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Set<String> REQUEST = Set.of("protocolVersion", "requestId", "action", "identity",
            "context", "installedContext", "subject");
    private static final Set<String> RESPONSE = Set.of("protocolVersion", "requestId", "action", "identity",
            "context", "installedContext", "head", "evidence");
    private static final Set<String> EXECUTION = Set.of("sessionId", "promptId", "callId", "argsDigest", "batchId",
            "functionCallId", "partIndex", "ordinal", "inputRef", "toolDefinitionRef", "dispatchMode");
    private static final String CONFIG = "sha256:" + CsiNativeActivationProof.sha256(
            "csi-files-retirement-tools/1\u0000csi-files-retirement-policy/1".getBytes(StandardCharsets.UTF_8));

    private CsiNativeReadbackProtocol() {
    }

    public static Map<String, Object> request(byte[] bytes) {
        return request(ManagedCsiFilesProtocol.parse(bytes, REQUEST_LIMIT));
    }

    public static Map<String, Object> request(Map<String, Object> value) {
        closed(value, REQUEST);
        common(value);
        String action = string(value.get("action"));
        switch (action) {
            case "bind" -> require(value.get("subject") == null);
            case "prepare" -> ref(value.get("subject"), "managed-file_history");
            case "execute" -> id(value.get("subject"));
            default -> throw invalid();
        }
        require(JsonCodec.encode(value).length <= REQUEST_LIMIT);
        return BrokerValues.immutableMap(value);
    }

    public static Map<String, Object> bindRequest(Map<String, Object> boot, RuntimeProvisionRequest original,
            ContextBinding binding, String requestId) {
        ManagedCsiFilesProtocol.validateBoot(boot);
        require(Long.valueOf(5).equals(BrokerValues.exactLong(boot.get("version"))));
        String owner = original.getIsolationKey();
        var value = new LinkedHashMap<String, Object>();
        value.put("protocolVersion", 1);
        value.put("requestId", requestId);
        value.put("action", "bind");
        value.put("identity", ManagedCsiFilesProtocol.identity(original));
        value.put("context", ManagedContextProtocol.attestationResponse(map(boot.get("context"))));
        value.put("installedContext", ManagedContextProtocol.installation(original,
                UUID.nameUUIDFromBytes(owner.getBytes(StandardCharsets.UTF_8)).toString(), owner, binding));
        value.put("subject", null);
        return request(value);
    }

    public static Map<String, Object> response(byte[] bytes, Map<String, Object> request) {
        return response(ManagedCsiFilesProtocol.parse(bytes, RESPONSE_LIMIT), request);
    }

    public static Map<String, Object> response(Map<String, Object> value, Map<String, Object> request) {
        request(request);
        closed(value, RESPONSE);
        common(value);
        for (String key : List.of("protocolVersion", "requestId", "action", "identity", "context", "installedContext")) {
            require(same(value.get(key), request.get(key)));
        }
        var head = map(value.get("head"));
        closed(head, Set.of("revision", "sequence", "digest"));
        require(counter(head.get("revision")) > 0 && counter(head.get("sequence")) > 0);
        digest(head.get("digest"), false);
        var evidence = map(value.get("evidence"));
        String owner = string(map(value.get("identity")).get("sessionId"));
        switch (string(value.get("action"))) {
            case "bind" -> {
                closed(evidence, Set.of("kind"));
                require("ready".equals(evidence.get("kind")));
            }
            case "prepare" -> {
                closed(evidence, Set.of("kind", "intentRef", "resources", "members"));
                require("intent".equals(evidence.get("kind")) && same(evidence.get("intentRef"), request.get("subject")));
                var required = new LinkedHashMap<String, Map<String, Object>>();
                add(required, ref(evidence.get("intentRef"), "managed-file_history"));
                var members = list(evidence.get("members"));
                require(!members.isEmpty() && members.size() <= 4096);
                long previous = -1;
                var calls = new HashSet<String>();
                var functions = new HashSet<String>();
                String prompt = null;
                String batch = null;
                for (Object candidate : members) {
                    var member = execution(candidate, owner);
                    long ordinal = counter(member.get("ordinal"));
                    require(ordinal > previous && calls.add(string(member.get("callId")))
                            && functions.add(string(member.get("functionCallId"))));
                    if (prompt != null) {
                        require(prompt.equals(member.get("promptId")) && batch.equals(member.get("batchId")));
                    }
                    prompt = string(member.get("promptId"));
                    batch = string(member.get("batchId"));
                    previous = ordinal;
                    add(required, ref(member.get("inputRef"), "managed-tool-input"));
                    add(required, ref(member.get("toolDefinitionRef"), "managed-tool-definition"));
                }
                resources(evidence.get("resources"), required);
            }
            case "execute" -> {
                closed(evidence, Set.of("kind", "executionReference", "preparedRef", "authorizationRevision",
                        "authorizationSequence", "grant", "resources"));
                require("authorization".equals(evidence.get("kind")));
                var reference = execution(evidence.get("executionReference"), owner);
                var required = new LinkedHashMap<String, Map<String, Object>>();
                add(required, ref(reference.get("inputRef"), "managed-tool-input"));
                add(required, ref(reference.get("toolDefinitionRef"), "managed-tool-definition"));
                Object prepared = evidence.get("preparedRef");
                if (prepared != null) {
                    add(required, ref(prepared, "managed-file_history"));
                }
                var grant = map(evidence.get("grant"));
                closed(grant, Set.of("protocolVersion", "runtimeBindingId", "bindingGeneration", "authorizedBindingVersion",
                        "executionCallId", "dispatchGeneration", "authorizationRevision", "authorizationSequence",
                        "executionReference", "intentRef", "checkpointRef", "preparedRef", "identity", "context", "installedContext"));
                require(counter(grant.get("protocolVersion")) == 1 && same(grant.get("executionCallId"), request.get("subject"))
                        && same(grant.get("executionReference"), reference) && same(grant.get("preparedRef"), prepared));
                id(grant.get("runtimeBindingId"));
                for (String field : List.of("bindingGeneration", "authorizedBindingVersion", "dispatchGeneration")) {
                    decimal(grant.get(field));
                }
                for (String field : List.of("authorizationRevision", "authorizationSequence")) {
                    long count = counter(evidence.get(field));
                    require(count > 0 && count == counter(grant.get(field))
                            && count <= counter(head.get(field.equals("authorizationRevision") ? "revision" : "sequence")));
                }
                for (String field : List.of("identity", "context", "installedContext")) {
                    require(same(grant.get(field), value.get(field)));
                }
                ref(grant.get("intentRef"), "managed-tool-intent");
                ref(grant.get("checkpointRef"), "managed-checkpoint");
                Map<String, byte[]> bytes = resources(evidence.get("resources"), required);
                if (prepared == null) {
                    var input = CsiNativeActivationProof.readObject(bytes.get(string(map(reference.get("inputRef")).get("resourceId"))));
                    var payload = CsiNativeActivationProof.readObject(CsiNativeActivationProof.utf8(
                            CsiNativeActivationProof.text(input, "payloadJson")));
                    require("read_file".equals(payload.path("toolName").textValue()));
                }
            }
            default -> throw invalid();
        }
        require(JsonCodec.encode(value).length <= RESPONSE_LIMIT);
        return BrokerValues.immutableMap(value);
    }

    private static void common(Map<String, Object> value) {
        require(counter(value.get("protocolVersion")) == 1);
        uuid(value.get("requestId"));
        var identity = map(value.get("identity"));
        closed(identity, Set.of("profile", "sessionId", "capabilityDigest"));
        require(CsiFilesRetirementProfile.PROFILE.equals(identity.get("profile"))
                && CsiFilesRetirementProfile.CAPABILITY_DIGEST.equals(identity.get("capabilityDigest")));
        uuid(identity.get("sessionId"));
        var context = map(value.get("context"));
        closed(context, Set.of("protocolVersion", "managedContext", "runtimeInstanceId", "runtimeIncarnation", "leaseId",
                "epoch", "provisionRequestId", "tenantId", "workspaceId", "workspaceGeneration", "storageId", "mountRoot",
                "capabilityDigest", "isolationClass"));
        require(counter(context.get("protocolVersion")) == 3 && "session".equals(context.get("isolationClass"))
                && identity.get("capabilityDigest").equals(context.get("capabilityDigest")));
        var boot = new LinkedHashMap<>(context);
        boot.remove("protocolVersion");
        boot.putAll(Map.of("type", "boot", "version", 2, "token", "validation-token"));
        ManagedContextProtocol.validateBoot(boot);
        var installed = map(value.get("installedContext"));
        closed(installed, Set.of("protocolVersion", "managedContext", "operationId", "sessionId", "contextDigest", "binding"));
        String owner = string(identity.get("sessionId"));
        require(counter(installed.get("protocolVersion")) == 3 && ManagedContextProtocol.PROTOCOL.equals(installed.get("managedContext"))
                && owner.equals(installed.get("sessionId")) && UUID.nameUUIDFromBytes(owner.getBytes(StandardCharsets.UTF_8))
                        .toString().equals(installed.get("operationId")));
        var binding = map(installed.get("binding"));
        closed(binding, Set.of("tenantId", "workspaceId", "workspaceGeneration", "storageId", "cwdRelative", "contextConfigRef", "contextRevision"));
        for (String field : List.of("tenantId", "workspaceId", "workspaceGeneration", "storageId")) {
            require(same(binding.get(field), context.get(field)));
        }
        require(".".equals(binding.get("cwdRelative")) && "1".equals(binding.get("contextRevision"))
                && CONFIG.equals(binding.get("contextConfigRef")));
        var expected = new ContextBinding(string(binding.get("tenantId")), string(binding.get("workspaceId")),
                decimal(binding.get("workspaceGeneration")), string(binding.get("storageId")), ".", CONFIG, 1);
        require(expected.getContextDigest().equals(installed.get("contextDigest")));
    }

    private static Map<String, Object> execution(Object value, String owner) {
        var reference = map(value);
        closed(reference, EXECUTION);
        require(owner.equals(reference.get("sessionId")) && "deferred".equals(reference.get("dispatchMode")));
        for (String field : List.of("promptId", "callId", "batchId")) {
            uuid(reference.get(field));
        }
        id(reference.get("functionCallId"));
        digest(reference.get("argsDigest"), true);
        counter(reference.get("partIndex"));
        counter(reference.get("ordinal"));
        var input = ref(reference.get("inputRef"), "managed-tool-input");
        var definition = ref(reference.get("toolDefinitionRef"), "managed-tool-definition");
        require(!input.get("resourceId").equals(definition.get("resourceId")));
        return reference;
    }

    private static Map<String, byte[]> resources(Object value, Map<String, Map<String, Object>> required) {
        var result = new LinkedHashMap<String, byte[]>();
        for (Object item : list(value)) {
            var entry = map(item);
            closed(entry, Set.of("reference", "bytesBase64"));
            var reference = map(entry.get("reference"));
            String resourceId = id(reference.get("resourceId"));
            require(required.containsKey(resourceId) && same(required.get(resourceId), reference));
            String encoded = string(entry.get("bytesBase64"));
            byte[] bytes = Base64.getDecoder().decode(encoded);
            require(encoded.equals(Base64.getEncoder().encodeToString(bytes)) && bytes.length <= 64 * 1024
                    && bytes.length == counter(reference.get("byteLength"))
                    && CsiNativeActivationProof.sha256(bytes).equals(reference.get("digest"))
                    && result.put(resourceId, bytes) == null);
        }
        require(result.keySet().equals(required.keySet()));
        return result;
    }

    private static void add(Map<String, Map<String, Object>> required, Map<String, Object> reference) {
        var previous = required.putIfAbsent(string(reference.get("resourceId")), reference);
        require(previous == null || same(previous, reference));
    }

    private static Map<String, Object> ref(Object value, String kind) {
        var reference = map(value);
        closed(reference, Set.of("resourceId", "kind", "schemaVersion", "byteLength", "digest"));
        id(reference.get("resourceId"));
        require(kind.equals(reference.get("kind")) && counter(reference.get("schemaVersion")) == 1
                && counter(reference.get("byteLength")) > 0 && counter(reference.get("byteLength")) <= 64 * 1024);
        digest(reference.get("digest"), false);
        return reference;
    }

    private static long counter(Object value) {
        Long number = BrokerValues.exactLong(value);
        require(number != null && number >= 0 && number <= 9_007_199_254_740_991L);
        return number;
    }

    private static long decimal(Object value) {
        String text = string(value);
        require(text.matches("[1-9][0-9]{0,18}"));
        return Long.parseLong(text);
    }

    private static void digest(Object value, boolean prefix) {
        require(string(value).matches(prefix ? "sha256:[0-9a-f]{64}" : "[0-9a-f]{64}"));
    }

    private static void uuid(Object value) {
        String text = string(value);
        require(text.matches("[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"));
    }

    private static String id(Object value) {
        return CsiNativeActivationProof.id(JSON.valueToTree(Map.of("id", string(value))), "id");
    }

    private static String string(Object value) {
        require(value instanceof String && !((String) value).isEmpty());
        return (String) value;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> map(Object value) {
        require(value instanceof Map<?, ?>);
        return (Map<String, Object>) value;
    }

    private static List<?> list(Object value) {
        require(value instanceof List<?>);
        return (List<?>) value;
    }

    private static void closed(Map<String, Object> value, Set<String> keys) {
        require(value.keySet().equals(keys));
    }

    private static boolean same(Object left, Object right) {
        return CsiNativeActivationProof.canonical(JSON.valueToTree(left))
                .equals(CsiNativeActivationProof.canonical(JSON.valueToTree(right)));
    }

    private static void require(boolean condition) {
        if (!condition) {
            throw invalid();
        }
    }

    private static IllegalArgumentException invalid() {
        return new IllegalArgumentException("Invalid private CSI native readback.");
    }
}
