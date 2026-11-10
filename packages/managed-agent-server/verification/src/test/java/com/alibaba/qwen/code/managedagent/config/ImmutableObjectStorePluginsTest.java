package com.alibaba.qwen.code.managedagent.config;

import com.alibaba.qwen.code.managedagent.contracts.storage.ImmutableObjectStore;
import com.alibaba.qwen.code.managedagent.contracts.storage.ImmutableObjectStoreFactory;
import com.alibaba.qwen.code.managedagent.contracts.storage.ImmutableObjectStores;
import com.alibaba.qwen.code.managedagent.contracts.storage.ObjectStorageException;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import javax.tools.ToolProvider;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.ServiceLoader;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.jar.JarEntry;
import java.util.jar.JarOutputStream;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class ImmutableObjectStorePluginsTest {
    private static final String SPI = ImmutableObjectStoreFactory.class.getName();
    @TempDir
    static Path directory;
    private static Path plugin;

    @BeforeAll
    static void packageContractsOnlyPlugin() throws Exception {
        Path classes = Files.createDirectory(directory.resolve("classes"));
        Path example = Path.of("../examples/object-store/src/main");
        assertThat(ToolProvider.getSystemJavaCompiler().run(null, null, null, "--release", "21", "-classpath",
                Path.of("../contracts/target/classes").toAbsolutePath().toString(), "-d", classes.toString(),
                example.resolve("java/example/LocalObjectStoreFactory.java").toString(),
                example.resolve("java/example/ObjectStoreContractCheck.java").toString())).isZero();
        plugin = directory.resolve("plugin.jar");
        try (var output = new JarOutputStream(Files.newOutputStream(plugin)); var entries = Files.walk(classes)) {
            for (Path file : entries.filter(Files::isRegularFile).toList()) {
                output.putNextEntry(new JarEntry(classes.relativize(file).toString()));
                Files.copy(file, output);
                output.closeEntry();
            }
            output.putNextEntry(new JarEntry("META-INF/services/" + SPI));
            Files.copy(example.resolve("resources/META-INF/services/" + SPI), output);
            output.closeEntry();
        }
    }

    @Test
    void packagedPluginLoadsWithoutSpringOrOssAndReopensTheSameNamespace() throws Exception {
        try (var isolated = new URLClassLoader(new URL[]{plugin.toUri().toURL(), Path.of("../contracts/target/classes").toUri().toURL()},
                ClassLoader.getPlatformClassLoader())) {
            assertThatThrownBy(() -> isolated.loadClass("org.springframework.context.ApplicationContext")).isInstanceOf(ClassNotFoundException.class);
            assertThatThrownBy(() -> isolated.loadClass("com.aliyun.oss.OSS")).isInstanceOf(ClassNotFoundException.class);
            ClassLoader previous = Thread.currentThread().getContextClassLoader();
            Thread.currentThread().setContextClassLoader(isolated);
            try {
                var registry = isolated.loadClass(ImmutableObjectStores.class.getName()).getConstructor().newInstance();
                var create = registry.getClass().getMethod("create", String.class, Map.class);
                var contract = isolated.loadClass(ImmutableObjectStore.class.getName());
                Map<String, String> options = Map.of("directory", directory.resolve("isolated-data").toString());
                Object first = create.invoke(registry, "example-local", options);
                String identity = (String) contract.getMethod("identity").invoke(first);
                contract.getMethod("putIfAbsent", String.class, InputStream.class, long.class, Runnable.class)
                        .invoke(first, "key", new ByteArrayInputStream(new byte[]{1, 2, 3}), 3L, (Runnable) () -> {});
                ((AutoCloseable) first).close();
                Object second = create.invoke(registry, "example-local", options);
                assertThat(contract.getMethod("identity").invoke(second)).isEqualTo(identity);
                try (var stream = (InputStream) contract.getMethod("open", String.class, Runnable.class)
                        .invoke(second, "key", (Runnable) () -> {})) {
                    assertThat(stream.readAllBytes()).containsExactly(1, 2, 3);
                }
                contract.getMethod("deleteIfPresent", String.class, Runnable.class).invoke(second, "key", (Runnable) () -> {});
                ((AutoCloseable) second).close();
                String option = "object-store.option.directory";
                String previousOption = System.getProperty(option);
                System.setProperty(option, directory.resolve("contract-suite").toString());
                try {
                    isolated.loadClass("example.ObjectStoreContractCheck").getMethod("main", String[].class)
                            .invoke(null, (Object) new String[]{"example-local"});
                } finally {
                    if (previousOption == null) {
                        System.clearProperty(option);
                    } else {
                        System.setProperty(option, previousOption);
                    }
                }
            } finally {
                Thread.currentThread().setContextClassLoader(previous);
            }
        }
    }

    @Test
    void concurrentCreationNeverOverwritesOrExposesPartialBytes() throws Exception {
        try (var loader = new URLClassLoader(new URL[]{plugin.toUri().toURL()}, getClass().getClassLoader());
                var store = registry(loader).create("example-local", Map.of("directory", directory.resolve("concurrent").toString()));
                var pool = Executors.newFixedThreadPool(2)) {
            byte[] first = new byte[65537];
            java.util.Arrays.fill(first, (byte) 7);
            AtomicInteger successes = new AtomicInteger();
            var calls = List.of(0, 1).stream().map(ignored -> pool.submit(() -> {
                try {
                    store.putIfAbsent("key", new ByteArrayInputStream(first), first.length, () -> {});
                    successes.incrementAndGet();
                } catch (ObjectStorageException failure) {
                    assertThat(failure.reason()).isEqualTo(ObjectStorageException.Reason.ALREADY_EXISTS);
                }
            })).toList();
            for (var call : calls) {
                call.get();
            }
            assertThat(successes).hasValue(1);
            try (var stream = store.open("key", first.length, () -> {})) {
                assertThat(stream.readAllBytes()).isEqualTo(first);
            }
            assertThatThrownBy(() -> store.putIfAbsent("partial", new ByteArrayInputStream(new byte[]{1}), 2, () -> {}))
                    .isInstanceOf(ObjectStorageException.class);
            assertThatThrownBy(() -> store.open("partial", () -> {})).isInstanceOfSatisfying(ObjectStorageException.class,
                    failure -> assertThat(failure.reason()).isEqualTo(ObjectStorageException.Reason.NOT_FOUND));
            store.deleteIfPresent("key", () -> {});
            store.deleteIfPresent("key", () -> {});
        }
    }

    @Test
    void guardRevocationBoundsReadsAndDuplicateProvidersFailClosed() throws Exception {
        try (var loader = new URLClassLoader(new URL[]{plugin.toUri().toURL()}, getClass().getClassLoader());
                var store = registry(loader).create("example-local", Map.of("directory", directory.resolve("guarded").toString()))) {
            var factory = ServiceLoader.load(ImmutableObjectStoreFactory.class, loader).stream()
                    .map(ServiceLoader.Provider::get).filter(value -> value.kind().equals("example-local")).findFirst().orElseThrow();
            assertThatThrownBy(() -> new ImmutableObjectStores(List.of(factory, factory))).hasMessageContaining("duplicate");
            assertThatThrownBy(() -> registry(loader).create("uninstalled", Map.of())).hasMessageContaining("not installed");
            store.putIfAbsent("key", new ByteArrayInputStream(new byte[]{1, 2, 3}), 3, () -> {});
            AtomicInteger calls = new AtomicInteger();
            try (var input = store.open("key", 3, () -> {
                if (calls.incrementAndGet() >= 3) {
                    throw new IllegalStateException("lease expired");
                }
            })) {
                assertThatThrownBy(input::read).hasMessageContaining("lease expired");
            }
            try (var input = store.open("key", 2, () -> {})) {
                assertThatThrownBy(input::readAllBytes).hasMessageContaining("read limit");
            }
        }
    }

    private static ImmutableObjectStores registry(ClassLoader loader) {
        return new ImmutableObjectStores(ServiceLoader.load(ImmutableObjectStoreFactory.class, loader));
    }
}
