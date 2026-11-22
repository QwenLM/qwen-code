package com.alibaba.qwen.code.managedagent.harness;

import com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings;

import javax.net.ssl.KeyManagerFactory;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManagerFactory;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.GeneralSecurityException;
import java.security.KeyStore;
import java.util.Arrays;

public final class HarnessTls {
    private HarnessTls() {
    }

    public static SSLContext poolContext(ManagedAgentSettings.HarnessPool properties) {
        if (properties.getKeyStoreFile().isBlank() && properties.getTrustStoreFile().isBlank()) {
            return null;
        }
        if (properties.getKeyStoreFile().isBlank() || properties.getTrustStoreFile().isBlank()) {
            throw new IllegalArgumentException("Harness mTLS requires both PKCS12 key and trust stores");
        }
        char[] keyPassword = password(properties.getKeyStorePasswordFile());
        char[] trustPassword = password(properties.getTrustStorePasswordFile());
        try {
            KeyStore keys = load(properties.getKeyStoreFile(), keyPassword);
            KeyStore trust = load(properties.getTrustStoreFile(), trustPassword);
            var keyManagers = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm());
            keyManagers.init(keys, keyPassword);
            var trustManagers = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
            trustManagers.init(trust);
            SSLContext context = SSLContext.getInstance("TLS");
            context.init(keyManagers.getKeyManagers(), trustManagers.getTrustManagers(), null);
            return context;
        } catch (IOException | GeneralSecurityException error) {
            throw new IllegalArgumentException("Harness mTLS material could not be loaded");
        } finally {
            Arrays.fill(keyPassword, '\0');
            Arrays.fill(trustPassword, '\0');
        }
    }

    private static KeyStore load(String file, char[] password) throws IOException, GeneralSecurityException {
        KeyStore store = KeyStore.getInstance("PKCS12");
        try (var input = Files.newInputStream(Path.of(file))) {
            store.load(input, password);
        }
        return store;
    }

    private static char[] password(String file) {
        if (file.isBlank()) {
            return new char[0];
        }
        try {
            if (Files.size(Path.of(file)) > 4096) {
                throw new IOException("Oversized password file");
            }
            return Files.readString(Path.of(file)).stripTrailing().toCharArray();
        } catch (IOException error) {
            throw new IllegalArgumentException("Harness TLS password file could not be loaded");
        }
    }
}
