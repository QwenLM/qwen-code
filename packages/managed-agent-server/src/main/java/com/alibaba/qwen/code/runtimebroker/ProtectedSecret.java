package com.alibaba.qwen.code.runtimebroker;

/** Encrypted secret material and the key reference required to open it. */
public final class ProtectedSecret {
    private static final int MAXIMUM_CIPHERTEXT_LENGTH = 16 * 1024;
    private final String keyId;
    private final String ciphertext;

    public ProtectedSecret(String keyId, String ciphertext) {
        this.keyId = BrokerValues.requireId(keyId, "keyId");
        if (ciphertext == null || ciphertext.isEmpty()
                || ciphertext.length() > MAXIMUM_CIPHERTEXT_LENGTH
                || ciphertext.indexOf('\0') >= 0) {
            throw new IllegalArgumentException(
                    "ciphertext must be a bounded non-empty string");
        }
        this.ciphertext = ciphertext;
    }

    public String getKeyId() {
        return keyId;
    }

    public String getCiphertext() {
        return ciphertext;
    }
}
