package com.alibaba.qwen.code.runtimebroker.security;

import com.alibaba.fastjson2.JSON;
import com.alibaba.fastjson2.JSONWriter;
import com.alibaba.qwen.code.runtimebroker.BrokerValues;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import javax.crypto.Cipher;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.Map;

/** AES-256-GCM protector for Runtime seed credentials. */
public final class AesGcmSecretProtector implements SecretProtector {
    private static final Logger LOGGER = LoggerFactory.getLogger(AesGcmSecretProtector.class);
    private static final byte FORMAT_VERSION = 1;
    private static final int IV_BYTES = 12;
    private static final int TAG_BITS = 128;
    private final String activeKeyId;
    private final Map<String, SecretKey> keys;
    private final SecureRandom random;

    public AesGcmSecretProtector(String keyId, byte[] keyBytes) {
        this(keyId, keyBytes, new SecureRandom());
    }

    AesGcmSecretProtector(String keyId, byte[] keyBytes,
            SecureRandom random) {
        this(keyId, singleKey(keyId, keyBytes), random);
    }

    private AesGcmSecretProtector(String activeKeyId,
            Map<String, byte[]> keyBytes, SecureRandom random) {
        this.activeKeyId = BrokerValues.requireId(activeKeyId, "keyId");
        if (random == null) {
            throw new IllegalArgumentException("random is required");
        }
        Map<String, SecretKey> configured = new LinkedHashMap<>();
        keyBytes.forEach((id, bytes) -> {
            String configuredId = BrokerValues.requireId(id, "keyId");
            if (bytes == null || bytes.length != 32) {
                throw new IllegalArgumentException("AES-GCM key "
                        + JSON.toJSONString(configuredId, JSONWriter.Feature.EscapeNoneAscii)
                        + " must contain 32 bytes");
            }
            configured.put(configuredId,
                    new SecretKeySpec(bytes.clone(), "AES"));
        });
        this.keys = Map.copyOf(configured);
        this.random = random;
        LOGGER.info("Runtime credential key ring: {}", keyRingDescription());
    }

    public static AesGcmSecretProtector fromBase64(String keyId,
            String encodedKey) {
        return fromBase64(keyId, encodedKey, Map.of());
    }

    public static AesGcmSecretProtector fromBase64(String keyId,
            String encodedKey, Map<String, String> previousKeys) {
        Map<String, byte[]> decoded = new LinkedHashMap<>();
        decoded.put(keyId, decodeKey(keyId, encodedKey));
        if (previousKeys != null) {
            previousKeys.forEach((previousKeyId, previousKey) -> {
                String configuredId = BrokerValues.requireId(previousKeyId,
                        "keyId");
                if (decoded.containsKey(configuredId)) {
                    throw new IllegalArgumentException(
                            "AES-GCM key IDs must be unique");
                }
                decoded.put(configuredId, decodeKey(configuredId, previousKey));
            });
        }
        return new AesGcmSecretProtector(keyId, decoded,
                new SecureRandom());
    }

    private static byte[] decodeKey(String keyId, String encodedKey) {
        if (encodedKey == null || encodedKey.isBlank()) {
            throw new IllegalArgumentException(
                    "encodedKey for key "
                            + JSON.toJSONString(keyId, JSONWriter.Feature.EscapeNoneAscii)
                            + " is required");
        }
        try {
            return Base64.getDecoder().decode(encodedKey);
        } catch (IllegalArgumentException exception) {
            throw new IllegalArgumentException("encodedKey for key "
                    + JSON.toJSONString(keyId, JSONWriter.Feature.EscapeNoneAscii)
                    + " must be valid base64", exception);
        }
    }

    @Override
    public ProtectedSecret protect(String context, byte[] plaintext) {
        byte[] input = requirePlaintext(plaintext);
        byte[] iv = new byte[IV_BYTES];
        random.nextBytes(iv);
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, keys.get(activeKeyId),
                    new GCMParameterSpec(TAG_BITS, iv));
            cipher.updateAAD(aad(context));
            byte[] encrypted = cipher.doFinal(input);
            ByteBuffer output = ByteBuffer.allocate(1 + iv.length
                    + encrypted.length);
            output.put(FORMAT_VERSION).put(iv).put(encrypted);
            return new ProtectedSecret(activeKeyId, Base64.getEncoder()
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
        SecretKey key = keys.get(protectedSecret.getKeyId());
        if (key == null) {
            throw new IllegalStateException(
                    "Runtime credential key is unavailable: requested="
                            + JSON.toJSONString(protectedSecret.getKeyId(), JSONWriter.Feature.EscapeNoneAscii)
                            + ", " + keyRingDescription());
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

    private String keyRingDescription() {
        return "active=" + JSON.toJSONString(activeKeyId, JSONWriter.Feature.EscapeNoneAscii)
                + ", configured=" + JSON.toJSONString(keys.keySet().stream().sorted().toList(),
                        JSONWriter.Feature.EscapeNoneAscii);
    }

    private static Map<String, byte[]> singleKey(String keyId,
            byte[] keyBytes) {
        Map<String, byte[]> key = new LinkedHashMap<>();
        key.put(keyId, keyBytes);
        return key;
    }

    private static byte[] aad(String context) {
        return BrokerValues.requireId(context, "context")
                .getBytes(StandardCharsets.UTF_8);
    }
}
