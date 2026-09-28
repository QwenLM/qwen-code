package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Base64;
import org.junit.jupiter.api.Test;

class AesGcmSecretProtectorTest {
    @Test
    void roundTripsWithoutEmbeddingThePlaintext() {
        AesGcmSecretProtector protector = new AesGcmSecretProtector("key-1",
                key(1));
        byte[] plaintext = "runtime-secret-value"
                .getBytes(StandardCharsets.UTF_8);

        ProtectedSecret protectedSecret = protector.protect("binding-1",
                plaintext);

        assertFalse(containsSubsequence(Base64.getDecoder().decode(
                protectedSecret.getCiphertext()), plaintext));
        assertArrayEquals(plaintext, protector.unprotect("binding-1",
                protectedSecret));
    }

    @Test
    void usesAFreshIvForEveryEncryption() {
        AesGcmSecretProtector protector = new AesGcmSecretProtector("key-1",
                key(1));
        byte[] plaintext = "runtime-secret-value"
                .getBytes(StandardCharsets.UTF_8);

        ProtectedSecret first = protector.protect("binding-1", plaintext);
        ProtectedSecret second = protector.protect("binding-1", plaintext);

        assertNotEquals(first.getCiphertext(), second.getCiphertext());
        assertArrayEquals(plaintext, protector.unprotect("binding-1",
                first));
        assertArrayEquals(plaintext, protector.unprotect("binding-1",
                second));
    }

    @Test
    void rejectsWrongContextKeyAndTampering() {
        AesGcmSecretProtector protector = new AesGcmSecretProtector("key-1",
                key(1));
        ProtectedSecret protectedSecret = protector.protect("binding-1",
                "secret".getBytes(StandardCharsets.UTF_8));

        assertThrows(IllegalStateException.class,
                () -> protector.unprotect("binding-2", protectedSecret));
        assertThrows(IllegalStateException.class,
                () -> new AesGcmSecretProtector("key-2", key(2))
                        .unprotect("binding-1", protectedSecret));
        // Same key id, different key bytes: only the GCM tag can reject it.
        assertThrows(IllegalStateException.class,
                () -> new AesGcmSecretProtector("key-1", key(2))
                        .unprotect("binding-1", protectedSecret));

        byte[] ciphertext = Base64.getDecoder().decode(
                protectedSecret.getCiphertext());
        ciphertext[ciphertext.length - 1] ^= 1;
        ProtectedSecret tampered = new ProtectedSecret("key-1",
                Base64.getEncoder().encodeToString(ciphertext));
        assertThrows(IllegalStateException.class,
                () -> protector.unprotect("binding-1", tampered));
    }

    @Test
    void acceptsCiphertextForTheMaximumRuntimeTokenLength() {
        AesGcmSecretProtector protector = new AesGcmSecretProtector("key-1",
                key(1));
        byte[] plaintext = "x".repeat(512)
                .getBytes(StandardCharsets.UTF_8);

        ProtectedSecret protectedSecret = protector.protect("binding-1",
                plaintext);

        assertArrayEquals(plaintext, protector.unprotect("binding-1",
                protectedSecret));
    }

    private static boolean containsSubsequence(byte[] envelope,
            byte[] plaintext) {
        for (int start = 0; start + plaintext.length <= envelope.length;
                start++) {
            if (Arrays.mismatch(envelope, start, start + plaintext.length,
                    plaintext, 0, plaintext.length) < 0) {
                return true;
            }
        }
        return false;
    }

    private static byte[] key(int value) {
        byte[] key = new byte[32];
        Arrays.fill(key, (byte) value);
        return key;
    }
}
