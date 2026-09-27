package com.alibaba.qwen.code.runtimebroker;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.SecureRandom;
import java.util.Base64;
import javax.crypto.Cipher;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/** AES-256-GCM protector for Runtime seed credentials. */
public final class AesGcmSecretProtector implements SecretProtector {
    private static final byte FORMAT_VERSION = 1;
    private static final int IV_BYTES = 12;
    private static final int TAG_BITS = 128;
    private final String keyId;
    private final SecretKey key;
    private final SecureRandom random;

    public AesGcmSecretProtector(String keyId, byte[] keyBytes) {
        this(keyId, keyBytes, new SecureRandom());
    }

    AesGcmSecretProtector(String keyId, byte[] keyBytes,
            SecureRandom random) {
        this.keyId = BrokerValues.requireId(keyId, "keyId");
        if (keyBytes == null || keyBytes.length != 32) {
            throw new IllegalArgumentException(
                    "AES-GCM key must contain 32 bytes");
        }
        if (random == null) {
            throw new IllegalArgumentException("random is required");
        }
        this.key = new SecretKeySpec(keyBytes.clone(), "AES");
        this.random = random;
    }

    public static AesGcmSecretProtector fromBase64(String keyId,
            String encodedKey) {
        if (encodedKey == null || encodedKey.isBlank()) {
            throw new IllegalArgumentException("encodedKey is required");
        }
        byte[] decoded;
        try {
            decoded = Base64.getDecoder().decode(encodedKey);
        } catch (IllegalArgumentException exception) {
            throw new IllegalArgumentException(
                    "encodedKey must be valid base64", exception);
        }
        return new AesGcmSecretProtector(keyId, decoded);
    }

    @Override
    public ProtectedSecret protect(String context, byte[] plaintext) {
        byte[] input = requirePlaintext(plaintext);
        byte[] iv = new byte[IV_BYTES];
        random.nextBytes(iv);
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key,
                    new GCMParameterSpec(TAG_BITS, iv));
            cipher.updateAAD(aad(context));
            byte[] encrypted = cipher.doFinal(input);
            ByteBuffer output = ByteBuffer.allocate(1 + iv.length
                    + encrypted.length);
            output.put(FORMAT_VERSION).put(iv).put(encrypted);
            return new ProtectedSecret(keyId, Base64.getEncoder()
                    .encodeToString(output.array()));
        } catch (GeneralSecurityException exception) {
            throw new IllegalStateException(
                    "Runtime credential encryption failed", exception);
        }
    }

    @Override
    public byte[] unprotect(String context, ProtectedSecret protectedSecret) {
        if (protectedSecret == null) {
            throw new IllegalArgumentException("protectedSecret is required");
        }
        if (!keyId.equals(protectedSecret.getKeyId())) {
            throw new IllegalStateException(
                    "Runtime credential key is unavailable");
        }
        byte[] encoded;
        try {
            encoded = Base64.getDecoder().decode(
                    protectedSecret.getCiphertext());
        } catch (IllegalArgumentException exception) {
            throw new IllegalStateException(
                    "Runtime credential ciphertext is invalid", exception);
        }
        if (encoded.length <= 1 + IV_BYTES
                || encoded[0] != FORMAT_VERSION) {
            throw new IllegalStateException(
                    "Runtime credential ciphertext is invalid");
        }
        byte[] iv = new byte[IV_BYTES];
        System.arraycopy(encoded, 1, iv, 0, IV_BYTES);
        byte[] ciphertext = new byte[encoded.length - 1 - IV_BYTES];
        System.arraycopy(encoded, 1 + IV_BYTES, ciphertext, 0,
                ciphertext.length);
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key,
                    new GCMParameterSpec(TAG_BITS, iv));
            cipher.updateAAD(aad(context));
            return cipher.doFinal(ciphertext);
        } catch (GeneralSecurityException exception) {
            throw new IllegalStateException(
                    "Runtime credential decryption failed", exception);
        }
    }

    private static byte[] requirePlaintext(byte[] plaintext) {
        if (plaintext == null || plaintext.length == 0) {
            throw new IllegalArgumentException("plaintext is required");
        }
        return plaintext.clone();
    }

    private static byte[] aad(String context) {
        return BrokerValues.requireId(context, "context")
                .getBytes(StandardCharsets.UTF_8);
    }
}
