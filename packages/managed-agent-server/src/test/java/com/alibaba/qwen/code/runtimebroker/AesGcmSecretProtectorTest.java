package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Base64;
import java.util.Locale;
import java.util.Map;
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

    @Test
    void encryptsWithTheActiveKeyAndDecryptsPreviousKeys() {
        AesGcmSecretProtector previous = new AesGcmSecretProtector("key-1",
                key(1));
        ProtectedSecret existing = previous.protect("binding-1",
                "existing-secret".getBytes(StandardCharsets.UTF_8));
        AesGcmSecretProtector rotated = AesGcmSecretProtector.fromBase64(
                "key-2", encodedKey(2), Map.of("key-1", encodedKey(1)));

        ProtectedSecret current = rotated.protect("binding-2",
                "current-secret".getBytes(StandardCharsets.UTF_8));

        assertEquals("key-2", current.getKeyId());
        assertArrayEquals("existing-secret".getBytes(StandardCharsets.UTF_8),
                rotated.unprotect("binding-1", existing));
        assertArrayEquals("current-secret".getBytes(StandardCharsets.UTF_8),
                rotated.unprotect("binding-2", current));
        IllegalStateException unavailable = assertThrows(
                IllegalStateException.class,
                () -> previous.unprotect("binding-2", current));

        assertTrue(unavailable.getMessage()
                .contains("Runtime credential key is unavailable"));
    }

    @Test
    void rejectsDuplicateActiveAndPreviousKeyIds() {
        assertThrows(IllegalArgumentException.class,
                () -> AesGcmSecretProtector.fromBase64("key-1",
                        encodedKey(1), Map.of("key-1", encodedKey(2))));
    }

    @Test
    void diagnosesResolvedIdsWithoutLoggingSecretsOrControlCharacters() {
        ch.qos.logback.classic.Logger logger =
                (ch.qos.logback.classic.Logger) org.slf4j.LoggerFactory
                        .getLogger(AesGcmSecretProtector.class);
        ch.qos.logback.core.read.ListAppender<ch.qos.logback.classic.spi.ILoggingEvent> appender =
                new ch.qos.logback.core.read.ListAppender<>();
        appender.start();
        logger.addAppender(appender);
        try {
            String previousId = "legacy/v1 \n\u2028\u001b[31m";
            String requestedId = "legacy/v1 \n\u2029\u001b[32m";
            AesGcmSecretProtector protector = AesGcmSecretProtector.fromBase64(
                    "key-2", encodedKey(2), Map.of(previousId, encodedKey(1)));
            IllegalStateException unavailable = assertThrows(IllegalStateException.class,
                    () -> protector.unprotect("binding-1",
                            new ProtectedSecret(requestedId, "ciphertext-must-not-be-logged")));

            assertEquals(1, appender.list.size());
            String summary = appender.list.getFirst().getFormattedMessage();
            String error = unavailable.getMessage();
            assertTrue(summary.startsWith("Runtime credential key ring: active=\"key-2\""));
            assertTrue(summary.contains("configured=[\"key-2\",\"legacy/v1 "));
            assertTrue(error.contains("requested=\"legacy/v1 "));
            assertTrue(error.contains("active=\"key-2\""));
            for (String diagnostic : new String[] {summary, error}) {
                assertFalse(diagnostic.contains("\n"));
                assertFalse(diagnostic.contains("\u2028"));
                assertFalse(diagnostic.contains("\u2029"));
                assertFalse(diagnostic.contains("\u001b"));
                assertTrue(diagnostic.contains("\\n"));
                assertTrue(diagnostic.toLowerCase(Locale.ROOT).contains("\\u001b"));
                assertFalse(diagnostic.contains(encodedKey(1)));
                assertFalse(diagnostic.contains(encodedKey(2)));
                assertFalse(diagnostic.contains("ciphertext-must-not-be-logged"));
            }
        } finally {
            logger.detachAppender(appender);
            appender.stop();
        }
    }

    @Test
    void rejectsInvalidPreviousKeyMaterial() {
        IllegalArgumentException malformed = assertThrows(
                IllegalArgumentException.class,
                () -> AesGcmSecretProtector.fromBase64("key-2",
                        encodedKey(2), Map.of("key-1", "not-base64")));
        IllegalArgumentException shortKey = assertThrows(
                IllegalArgumentException.class,
                () -> AesGcmSecretProtector.fromBase64("key-2",
                        encodedKey(2), Map.of("key-1",
                                Base64.getEncoder().encodeToString(
                                        new byte[31]))));

        assertTrue(malformed.getMessage().contains("key-1"));
        assertTrue(shortKey.getMessage().contains("key-1"));
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

    private static String encodedKey(int value) {
        return Base64.getEncoder().encodeToString(key(value));
    }
}
