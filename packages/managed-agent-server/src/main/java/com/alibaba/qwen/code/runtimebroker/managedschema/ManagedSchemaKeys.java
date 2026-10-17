package com.alibaba.qwen.code.runtimebroker.managedschema;

import java.nio.ByteBuffer;
import java.nio.CharBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.Objects;

/** SHA-256 index keys over unambiguous tuples; callers also compare raw identities. */
public final class ManagedSchemaKeys {
    private ManagedSchemaKeys() {}

    public static String key(String... components) {
        Objects.requireNonNull(components, "components");
        if (components.length == 0) {
            throw new IllegalArgumentException("A key requires an identity tuple");
        }
        MessageDigest digest;
        try {
            digest = MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException exception) {
            throw new IllegalStateException("SHA-256 is unavailable", exception);
        }
        for (String component : components) {
            byte[] bytes = identity(component);
            digest.update(ByteBuffer.allocate(Integer.BYTES).putInt(bytes.length).array());
            digest.update(bytes);
        }
        return HexFormat.of().formatHex(digest.digest());
    }

    public static byte[] identity(String value) {
        Objects.requireNonNull(value, "identity");
        try {
            ByteBuffer buffer =
                    StandardCharsets.UTF_8
                            .newEncoder()
                            .onMalformedInput(CodingErrorAction.REPORT)
                            .onUnmappableCharacter(CodingErrorAction.REPORT)
                            .encode(CharBuffer.wrap(value));
            byte[] bytes = new byte[buffer.remaining()];
            buffer.get(bytes);
            return bytes;
        } catch (CharacterCodingException exception) {
            throw new IllegalArgumentException("Identity is not valid Unicode", exception);
        }
    }

    public static String operationKey(
            ManagedSchemaContract.OperationKind kind,
            String scopeKey,
            String targetKey,
            String operationId) {
        return key("operation", kind.name(), scopeKey, targetKey, operationId);
    }

    public static String receiptKey(
            ManagedSchemaContract.ReceiptNamespace namespace,
            String tenantId,
            ManagedSchemaContract.ReceiptScope scope,
            String scopeId,
            String idempotencyKey) {
        return key("receipt", namespace.name(), tenantId, scope.name(), scopeId, idempotencyKey);
    }
}
