package com.alibaba.qwen.code.managedagent.extensions;

import com.alibaba.qwen.code.managedagent.adapters.extensions.ManagedExtensionArchiveStore;
import com.alibaba.qwen.code.managedagent.config.ExtensionArchiveStorageAutoConfiguration;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.contracts.extensions.ExtensionArchiveStorage;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import org.apache.commons.codec.digest.DigestUtils;
import org.junit.jupiter.api.Test;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class ExtensionArchiveStorageTest {
    @Test
    void unknownWriteCanBeReplayedWithoutLeakingAStagingPermit() throws Exception {
        var storage = new MemoryStorage();
        var archives = new ManagedExtensionArchiveStore(storage);
        byte[] bytes = new byte[] {1, 2, 3};
        String digest = DigestUtils.sha256Hex(bytes);
        storage.failAfterPut = true;
        assertThatThrownBy(() -> archives.put("tenant", "workspace", digest, new ByteArrayInputStream(bytes)))
                .isInstanceOfSatisfying(ManagedAgentException.class, error -> {
                    assertThat(error.getStatus()).isEqualTo(503);
                    assertThat(error.getCode()).isEqualTo("extension_package_unavailable");
                });
        storage.failAfterPut = false;
        assertThat(archives.put("tenant", "workspace", digest, new ByteArrayInputStream(bytes))).isEqualTo(bytes.length);
        var leases = new java.util.ArrayList<com.alibaba.qwen.code.managedagent.contracts.extensions.ExtensionArchives.Archive>();
        try {
            for (int i = 0; i < 4; i++) {
                leases.add(archives.verify("tenant", "workspace", digest, bytes.length));
            }
            assertThat(storage.objects).hasSize(1);
        } finally {
            leases.forEach(com.alibaba.qwen.code.managedagent.contracts.extensions.ExtensionArchives.Archive::close);
        }
    }

    @Test
    void customBeanBacksOffDirectoryAndNeedsNoPersistentLocalPath() {
        var storage = new MemoryStorage();
        new ApplicationContextRunner().withConfiguration(AutoConfigurations.of(ExtensionArchiveStorageAutoConfiguration.class))
                .withBean(ManagedAgentProperties.class, ManagedAgentProperties::new)
                .withBean(ExtensionArchiveStorage.class, () -> storage)
                .run(context -> {
                    assertThat(context).hasSingleBean(ExtensionArchiveStorage.class);
                    assertThat(context.getBean(ExtensionArchiveStorage.class)).isSameAs(storage);
                    assertThat(new ManagedExtensionArchiveStore(context.getBean(ExtensionArchiveStorage.class)).configured()).isTrue();
                });
    }

    @Test
    void leasesBoundTemporaryFilesAndDeleteOnlyAfterTheConsumerCloses() throws Exception {
        var storage = new MemoryStorage();
        var archives = new ManagedExtensionArchiveStore(storage);
        byte[] bytes = new byte[] {1, 2, 3};
        String digest = DigestUtils.sha256Hex(bytes);
        archives.put("tenant", "workspace", digest, new ByteArrayInputStream(bytes));
        var leases = new java.util.ArrayList<com.alibaba.qwen.code.managedagent.contracts.extensions.ExtensionArchives.Archive>();
        try {
            for (int i = 0; i < 4; i++) {
                leases.add(archives.verify("tenant", "workspace", digest, bytes.length));
            }
            assertThatThrownBy(() -> archives.verify("tenant", "workspace", digest, bytes.length)).isInstanceOf(ManagedAgentException.class);
            var path = leases.getFirst().path();
            assertThat(Files.readAllBytes(path)).isEqualTo(bytes);
            leases.getFirst().close();
            leases.getFirst().close();
            assertThat(Files.exists(path)).isFalse();
            try (var extra = archives.verify("tenant", "workspace", digest, bytes.length)) {
                assertThat(Files.readAllBytes(extra.path())).isEqualTo(bytes);
            }
        } finally {
            leases.forEach(com.alibaba.qwen.code.managedagent.contracts.extensions.ExtensionArchives.Archive::close);
        }
        storage.objects.put(new ExtensionArchiveStorage.Key("tenant", "workspace", digest), new byte[] {1, 2, 4});
        assertThatThrownBy(() -> archives.verify("tenant", "workspace", digest, bytes.length))
                .isInstanceOfSatisfying(ManagedAgentException.class, error -> assertThat(error.getCode()).isEqualTo("extension_package_unavailable"));
        storage.objects.put(new ExtensionArchiveStorage.Key("tenant", "workspace", digest), bytes);
        try (var recovered = archives.verify("tenant", "workspace", digest, bytes.length)) {
            assertThat(Files.exists(recovered.path())).isTrue();
        }
        assertThatThrownBy(() -> archives.verify("other", "workspace", digest, bytes.length))
                .isInstanceOfSatisfying(ManagedAgentException.class, error -> {
                    assertThat(error.getStatus()).isEqualTo(503);
                    assertThat(error.getCode()).isEqualTo("extension_package_unavailable");
                });
    }

    private static final class MemoryStorage implements ExtensionArchiveStorage {
        private final Map<Key, byte[]> objects = new ConcurrentHashMap<>();
        private boolean failAfterPut;
        public void validateConfiguration() { }
        public void putIfAbsent(Key key, long length, InputStream content) throws IOException {
            objects.putIfAbsent(key, content.readAllBytes());
            if (failAfterPut) {
                throw new IOException("Write response lost after the immutable object was stored");
            }
        }
        public InputStream open(Key key) throws IOException {
            byte[] bytes = objects.get(key);
            if (bytes == null) {
                throw new IOException("Missing archive");
            }
            return new ByteArrayInputStream(bytes);
        }
    }
}
