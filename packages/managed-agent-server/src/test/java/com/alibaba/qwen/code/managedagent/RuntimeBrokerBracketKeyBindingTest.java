package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.runtimebroker.AesGcmSecretProtector;
import org.junit.jupiter.api.Test;
import org.springframework.boot.context.properties.bind.Binder;
import org.springframework.boot.env.YamlPropertySourceLoader;
import org.springframework.core.env.StandardEnvironment;
import org.springframework.core.io.ByteArrayResource;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

// The rotation runbook instructs operators to write previous-credential-keys
// entries in Spring's bracket form. An existing key ID containing '/', ':'
// or a space is silently normalised by the relaxed binder when written as a
// plain (or merely quoted) map key — legacy/v1 binds as legacyv1 — and the
// ring then matches no persisted row. This pins the documented bracket
// shape from the YAML loader through property binding to the protector.
class RuntimeBrokerBracketKeyBindingTest {
    @Test
    void bindsBracketWrappedPreviousKeysByTheirExactId() throws Exception {
        String yaml = """
                qwen:
                  managed-agent:
                    runtime-broker:
                      previous-credential-keys:
                        '[legacy/v1]': AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=
                        '[legacy:v1]': AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=
                        '[legacy v1]': AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=
                """;
        var source = new YamlPropertySourceLoader()
                .load("test", new ByteArrayResource(
                        yaml.getBytes(StandardCharsets.UTF_8)))
                .get(0);
        StandardEnvironment environment = new StandardEnvironment();
        environment.getPropertySources().addFirst(source);

        ManagedAgentProperties properties = Binder.get(environment)
                .bind("qwen.managed-agent", ManagedAgentProperties.class)
                .orElseThrow(() -> new IllegalStateException(
                        "qwen.managed-agent properties not bound"));

        var previousKeys = properties.getRuntimeBroker()
                .getPreviousCredentialKeys();
        assertEquals(3, previousKeys.size());
        assertTrue(previousKeys.containsKey("legacy/v1"));
        assertTrue(previousKeys.containsKey("legacy:v1"));
        assertTrue(previousKeys.containsKey("legacy v1"));

        // A ring bound this way reads rows written under the original ID
        // and keeps writing under the active one.
        AesGcmSecretProtector protector = AesGcmSecretProtector.fromBase64(
                "reference-v2",
                "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
                previousKeys);
        byte[] plaintext = "pre-rotation-credentials"
                .getBytes(StandardCharsets.UTF_8);
        var writtenBeforeRotation = new AesGcmSecretProtector("legacy/v1",
                key(2)).protect("binding-1", plaintext);

        assertArrayEquals(plaintext,
                protector.unprotect("binding-1", writtenBeforeRotation));
        assertEquals("reference-v2",
                protector.protect("binding-2", plaintext).getKeyId());
    }

    private static byte[] key(int value) {
        byte[] key = new byte[32];
        Arrays.fill(key, (byte) value);
        return key;
    }
}
