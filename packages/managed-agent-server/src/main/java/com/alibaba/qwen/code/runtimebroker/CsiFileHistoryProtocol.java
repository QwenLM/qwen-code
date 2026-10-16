package com.alibaba.qwen.code.runtimebroker;

import static com.alibaba.qwen.code.runtimebroker.CsiNativeActivationProof.closed;
import static com.alibaba.qwen.code.runtimebroker.CsiNativeActivationProof.id;
import static com.alibaba.qwen.code.runtimebroker.CsiNativeActivationProof.number;
import static com.alibaba.qwen.code.runtimebroker.CsiNativeActivationProof.text;

import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.WorkspaceRelativePath;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.math.BigInteger;
import java.time.Instant;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;

/** Original owner history control, separate from generic provider controls. */
public final class CsiFileHistoryProtocol {
    public static final String PATH = ManagedCsiFilesProtocol.PREFIX + "/file-history";
    private static final ObjectMapper JSON = new ObjectMapper();

    private CsiFileHistoryProtocol() {
    }

    public static boolean isOperation(Map<String, Object> operation) {
        return operation != null && "csi-file-history".equals(operation.get("kind"));
    }

    public static void operation(Map<String, Object> operation) {
        JsonNode value = JSON.valueToTree(operation);
        String action = text(value, "action");
        closed(value, "prepare".equals(action) ? Set.of("kind", "version", "action", "preparationRef")
                : Set.of("kind", "version", "action"));
        require("csi-file-history".equals(text(value, "kind")) && number(value.get("version")) == 1
                && Set.of("bind", "snapshot", "prepare").contains(action));
        if ("prepare".equals(action)) {
            var ref = value.path("preparationRef");
            closed(ref, Set.of("resourceId", "kind", "schemaVersion", "byteLength", "digest"));
            id(ref, "resourceId");
            require("managed-file_history".equals(text(ref, "kind")) && number(ref.get("schemaVersion")) == 1
                    && number(ref.get("byteLength")) > 0 && number(ref.get("byteLength")) <= 64 * 1024
                    && text(ref, "digest").matches("[0-9a-f]{64}"));
        }
    }

    public static Map<String, Object> request(Map<String, Object> boot, RuntimeProvisionRequest original,
            ContextBinding binding, Map<String, Object> operation) {
        operation(operation);
        var result = new LinkedHashMap<>(CsiNativeReadbackProtocol.bindRequest(boot, original, binding,
                "00000000-0000-4000-8000-000000000000"));
        result.remove("requestId");
        result.remove("action");
        result.remove("subject");
        result.put("protocolVersion", 2);
        result.put("managedCsi", ManagedCsiFilesProtocol.PROTOCOL);
        result.put("operation", operation);
        require(JsonCodec.encode(result).length <= CsiNativeReadbackProtocol.REQUEST_LIMIT);
        return BrokerValues.immutableMap(result);
    }

    public static Map<String, Object> response(byte[] bytes, Map<String, Object> request) {
        var value = ManagedCsiFilesProtocol.parse(bytes, 64 * 1024);
        closed(JSON.valueToTree(value), Set.of("protocolVersion", "managedCsi", "identity", "context",
                "installedContext", "operation", "observation"));
        for (String field : request.keySet()) {
            require(CsiNativeActivationProof.canonical(JSON.valueToTree(request.get(field)))
                    .equals(CsiNativeActivationProof.canonical(JSON.valueToTree(value.get(field)))));
        }
        JsonNode observation = JSON.valueToTree(value.get("observation"));
        String owner = (String) ((Map<?, ?>) request.get("identity")).get("sessionId");
        observation(observation, owner);
        if ("bind".equals(((Map<?, ?>) request.get("operation")).get("action"))) {
            require(observation.path("state").path("snapshots").isEmpty()
                    && observation.path("state").path("files").isEmpty() && observation.path("retainedBackups").isEmpty());
        }
        return BrokerValues.immutableMap(value);
    }

    static void observation(JsonNode value, String owner) {
        closed(value, Set.of("state", "backupDirectory", "retainedBackups"));
        JsonNode directory = value.path("backupDirectory");
        closed(directory, Set.of("volumeDevice", "volumeInode", "directoryDevice", "directoryInode"));
        directory.forEach(CsiFileHistoryProtocol::decimal);
        require(directory.path("volumeDevice").equals(directory.path("directoryDevice")));
        var pins = new HashSet<String>();
        require(value.path("retainedBackups").isArray());
        String previous = "";
        for (JsonNode pin : value.path("retainedBackups")) {
            closed(pin, Set.of("name", "device", "inode", "byteLength", "digest", "mode"));
            String name = text(pin, "name");
            leaf(name);
            require(name.compareTo(previous) > 0 && pins.add(name));
            decimal(pin.get("device"));
            decimal(pin.get("inode"));
            require(directory.path("volumeDevice").equals(pin.path("device"))
                    && text(pin, "digest").matches("[0-9a-f]{64}") && number(pin.get("mode")) <= 07777);
            number(pin.get("byteLength"));
            previous = name;
        }
        JsonNode state = value.path("state");
        closed(state, Set.of("ownerSessionId", "snapshots", "files"));
        require(owner.equals(id(state, "ownerSessionId")) && state.path("snapshots").isArray()
                && state.path("snapshots").size() <= 100 && state.path("files").isObject());
        var paths = new HashSet<String>();
        var names = new HashSet<String>();
        var prompts = new HashSet<String>();
        for (JsonNode snapshot : state.path("snapshots")) {
            closed(snapshot, Set.of("promptId", "timestamp", "trackedFileBackups"));
            String prompt = id(snapshot, "promptId");
            require(prompt.length() <= 128 && prompts.add(prompt) && snapshot.path("trackedFileBackups").isObject());
            timestamp(text(snapshot, "timestamp"));
            snapshot.path("trackedFileBackups").fields().forEachRemaining(entry -> {
                path(entry.getKey());
                paths.add(entry.getKey());
                JsonNode backup = entry.getValue();
                closed(backup, backup.has("failed") ? Set.of("backupFileName", "version", "backupTime", "failed")
                        : Set.of("backupFileName", "version", "backupTime"));
                number(backup.get("version"));
                timestamp(text(backup, "backupTime"));
                require(!backup.has("failed") || backup.path("failed").isBoolean() && !backup.path("failed").booleanValue());
                if (!backup.path("backupFileName").isNull()) {
                    String name = text(backup, "backupFileName");
                    require(pins.contains(name));
                    names.add(name);
                }
            });
        }
        require(names.equals(pins) && state.path("files").size() == paths.size());
        state.path("files").fields().forEachRemaining(entry -> {
            require(paths.contains(entry.getKey()));
            JsonNode fingerprint = entry.getValue();
            if (!fingerprint.isNull()) {
                closed(fingerprint, Set.of("digest", "mode"));
                require(text(fingerprint, "digest").matches("sha256:[0-9a-f]{64}") && number(fingerprint.get("mode")) <= 07777);
            }
        });
    }

    private static void path(String path) {
        require(!".".equals(path) && WorkspaceRelativePath.normalize(path).equals(path));
    }

    private static void leaf(String value) {
        require(value.length() <= 256 && !Set.of(".", "..").contains(value)
                && value.codePoints().noneMatch(c -> c < 32 || c == 127 || c == '/' || c == '\\'));
    }

    private static void decimal(JsonNode value) {
        require(value != null && value.isTextual() && value.textValue().matches("0|[1-9][0-9]{0,19}")
                && new BigInteger(value.textValue()).bitLength() <= 64);
    }

    private static void timestamp(String value) {
        require(value.matches("(?:[0-9]{4}|[+-][0-9]{6})-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z"));
        Instant instant = Instant.parse(value);
        require(Math.abs(instant.toEpochMilli()) <= 8_640_000_000_000_000L);
        var date = instant.atOffset(java.time.ZoneOffset.UTC);
        int year = date.getYear();
        String prefix = year >= 0 && year <= 9999 ? String.format(java.util.Locale.ROOT, "%04d", year)
                : (year < 0 ? "-" : "+") + String.format(java.util.Locale.ROOT, "%06d", Math.abs(year));
        require(value.equals(prefix + date.format(java.time.format.DateTimeFormatter.ofPattern("-MM-dd'T'HH:mm:ss.SSS'Z'"))));
    }

    private static void require(boolean valid) {
        if (!valid) {
            throw new IllegalArgumentException("Invalid private CSI file history.");
        }
    }
}
