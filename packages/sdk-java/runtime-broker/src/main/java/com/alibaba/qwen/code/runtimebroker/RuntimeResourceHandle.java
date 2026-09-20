package com.alibaba.qwen.code.runtimebroker;

import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.Objects;

/** Versioned scheduler-owned identity without credential material. */
public final class RuntimeResourceHandle {
    private static final int MAXIMUM_BYTES = 64 * 1024;
    private final String kind;
    private final int version;
    private final Map<String, Object> value;

    public RuntimeResourceHandle(String kind, int version,
            Map<String, Object> value) {
        this.kind = BrokerValues.requireId(kind, "kind");
        if (version <= 0) {
            throw new IllegalArgumentException("version must be positive");
        }
        if (value == null) {
            throw new IllegalArgumentException("value is required");
        }
        this.value = BrokerValues.immutableMap(value);
        byte[] encoded = JsonCodec.encode(this.value);
        if (encoded.length == 0 || encoded.length > MAXIMUM_BYTES) {
            throw new IllegalArgumentException(
                    "resource handle exceeds its size limit");
        }
        this.version = version;
    }

    public String getKind() {
        return kind;
    }

    public int getVersion() {
        return version;
    }

    public Map<String, Object> getValue() {
        return value;
    }

    String toJson() {
        return new String(JsonCodec.encode(value), StandardCharsets.UTF_8);
    }

    static RuntimeResourceHandle fromJson(String kind, int version,
            String json) {
        if (json == null || json.isBlank()) {
            throw new IllegalArgumentException("resource handle is required");
        }
        return new RuntimeResourceHandle(kind, version,
                JsonCodec.parseObject(json.getBytes(StandardCharsets.UTF_8),
                        "Runtime resource handle"));
    }

    @Override
    public boolean equals(Object candidate) {
        if (this == candidate) {
            return true;
        }
        if (!(candidate instanceof RuntimeResourceHandle)) {
            return false;
        }
        RuntimeResourceHandle other = (RuntimeResourceHandle) candidate;
        return version == other.version && kind.equals(other.kind)
                && value.equals(other.value);
    }

    @Override
    public int hashCode() {
        return Objects.hash(kind, version, value);
    }
}
