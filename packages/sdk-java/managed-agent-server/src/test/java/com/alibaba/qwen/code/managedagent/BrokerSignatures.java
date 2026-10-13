package com.alibaba.qwen.code.managedagent;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HexFormat;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/**
 * Produces broker signatures for the integration tests. SignatureAuthFilterTest
 * deliberately keeps its own independent copy so the canonical layout is
 * pinned from two directions.
 */
public final class BrokerSignatures {
    private BrokerSignatures() {
    }

    public static String sign(String key, String method, String uri,
            String query, String tenant, String actor, String timestamp,
            byte[] body, String idempotencyKey) {
        String canonical = "qwen-broker-auth-v1\n" + method + "\n" + uri
                + "\n" + (query == null ? "" : query) + "\n" + tenant + "\n"
                + actor + "\n" + timestamp + "\n" + sha256Hex(body) + "\n"
                + (idempotencyKey == null ? "" : idempotencyKey);
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(key.getBytes(StandardCharsets.UTF_8),
                    "HmacSHA256"));
            return "v1=" + HexFormat.of().formatHex(
                    mac.doFinal(canonical.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception error) {
            throw new IllegalStateException("HmacSHA256 is unavailable",
                    error);
        }
    }

    public static String sign(String key, String method, String uri,
            String tenant, String actor, String timestamp) {
        return sign(key, method, uri, null, tenant, actor, timestamp,
                new byte[0], null);
    }

    private static String sha256Hex(byte[] body) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance(
                    "SHA-256").digest(body));
        } catch (Exception error) {
            throw new IllegalStateException("SHA-256 is unavailable", error);
        }
    }
}
