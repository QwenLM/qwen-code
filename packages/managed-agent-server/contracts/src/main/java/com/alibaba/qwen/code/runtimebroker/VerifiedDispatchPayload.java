package com.alibaba.qwen.code.runtimebroker;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.Map;
import java.util.Set;

/** 只由原始载荷和持久化摘要校验生成的内部工具类别。 */
public final class VerifiedDispatchPayload {
    private final String digest;
    private final boolean readOnly;

    private VerifiedDispatchPayload(String digest, boolean readOnly) {
        this.digest = digest;
        this.readOnly = readOnly;
    }

    public static VerifiedDispatchPayload verify(String payloadJson, String expectedDigest) {
        byte[] bytes = payloadJson.getBytes(StandardCharsets.UTF_8);
        String actual;
        try {
            actual = "sha256:" + HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (NoSuchAlgorithmException exception) {
            throw new IllegalStateException(exception);
        }
        if (!actual.equals(expectedDigest)) {
            throw new IllegalArgumentException("Tool payload digest differs from the execution receipt");
        }
        Map<String, Object> payload = JsonCodec.parseObject(bytes, "tool payload");
        Object name = payload.get("toolName");
        if (!payload.keySet().equals(Set.of("toolName", "input"))
                || !(name instanceof String) || !(payload.get("input") instanceof Map)) {
            throw new IllegalArgumentException("Invalid tool payload");
        }
        return new VerifiedDispatchPayload(actual, Set.of("read_file", "glob").contains(name));
    }

    public String digest() {
        return digest;
    }

    public boolean readOnly() {
        return readOnly;
    }
}
