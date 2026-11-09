package com.alibaba.qwen.code.managedagent.config.runtime;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.contracts.session.AgentStateStore;
import com.alibaba.qwen.code.runtimebroker.persistence.InMemoryRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.persistence.InMemoryRuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.persistence.InMemoryToolExecutionRepository;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.context.properties.bind.Bindable;
import org.springframework.boot.context.properties.bind.Binder;
import org.springframework.boot.context.properties.source.MapConfigurationPropertySource;

import javax.tools.ToolProvider;

import java.io.File;
import java.lang.reflect.InvocationTargetException;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.jar.JarEntry;
import java.util.jar.JarOutputStream;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;

class RuntimeProviderPluginsTest {
    private static final String FACTORY = "com.alibaba.qwen.code.runtimebroker.spi.RuntimeProviderFactory";
    private static final String REGISTRY = RuntimeProviderRegistry.class.getName();
    private static final String PROPERTIES = ManagedAgentProperties.class.getName();
    @TempDir
    static Path directory;
    private static Path plugin;

    @BeforeAll
    static void buildIndependentPlugin() throws Exception {
        Path classes = Files.createDirectory(directory.resolve("classes"));
        var arguments = new ArrayList<>(List.of("--release", "21", "-classpath",
                Path.of("../contracts/target/classes").toAbsolutePath().toString(), "-d", classes.toString()));
        try (var sources = Files.walk(Path.of("src/test/runtime-provider"))) {
            sources.filter(path -> path.toString().endsWith(".java")).forEach(path -> arguments.add(path.toString()));
        }
        assertThat(ToolProvider.getSystemJavaCompiler().run(null, null, null, arguments.toArray(String[]::new)))
                .as("independent provider compiles against contracts only").isZero();
        plugin = directory.resolve("fixture-provider.jar");
        try (var jar = new JarOutputStream(Files.newOutputStream(plugin)); var files = Files.walk(classes)) {
            for (Path file : files.filter(Files::isRegularFile).toList()) {
                jar.putNextEntry(new JarEntry(classes.relativize(file).toString().replace(File.separatorChar, '/')));
                Files.copy(file, jar);
                jar.closeEntry();
            }
            jar.putNextEntry(new JarEntry("META-INF/services/" + FACTORY));
            jar.write("example.FixtureProvider\nexample.UnselectedProvider\n".getBytes(StandardCharsets.UTF_8));
            jar.closeEntry();
        }
    }

    @Test
    void builtinProvidersAreTrulyOptionalOnTheApplicationClasspath() throws Exception {
        for (String selected : List.of("none", "local", "external", "kubernetes", "ssh", "static", "local,ssh", "full", "fixture")) {
            try (var loader = isolated(selected)) {
                withContextLoader(loader, () -> {
                    var registry = loader.loadClass(REGISTRY).getConstructor().newInstance();
                    var require = registry.getClass().getMethod("require", String.class);
                    var implementations = Map.of(
                            "local", List.of("local-process", "local.LocalProcessRuntimeProvisioner"),
                            "external", List.of("external-scratch", "external.ExternalRuntimeProvisioner"),
                            "kubernetes", List.of("kubernetes-workspace", "kubernetes.ResidentWorkspaceProvisioner"),
                            "ssh", List.of("ssh-process", "ssh.SshRuntimeProvisioner"),
                            "static", List.of("static", "staticruntime.StaticRuntimeProvisioner"));
                    for (var entry : implementations.entrySet()) {
                        String kind = entry.getValue().getFirst();
                        boolean present = selected.equals("full") || Arrays.asList(selected.split(",")).contains(entry.getKey());
                        String implementation = entry.getValue().get(1);
                        if (!present) {
                            assertThatThrownBy(() -> loader.loadClass("com.alibaba.qwen.code.runtimebroker.provisioning." + implementation))
                                    .isInstanceOf(ClassNotFoundException.class);
                            assertThatThrownBy(() -> require.invoke(registry, kind))
                                    .isInstanceOf(InvocationTargetException.class)
                                    .rootCause().hasMessageContaining("Runtime provider is not installed: " + kind);
                        } else {
                            assertThat(require.invoke(registry, kind)).isNotNull();
                        }
                    }
                    Object settings = loader.loadClass(PROPERTIES).getConstructor().newInstance();
                    // A disabled broker must not require a provider, even when the selected JAR is absent.
                    settings.getClass().getMethod("validateRuntimeProvider").invoke(settings);
                    var workspaceCheck = loader.loadClass("com.alibaba.qwen.code.managedagent.preflight.ManagedAgentPreflight")
                            .getDeclaredMethod("workspaceCheck", settings.getClass());
                    workspaceCheck.setAccessible(true);
                    Object disabled = settings.getClass().getMethod("getRuntimeBroker").invoke(settings);
                    set(disabled, "WorkspaceCwd", directory.resolve("absent-workspace").toString());
                    assertThat(workspaceCheck.invoke(null, settings).toString()).contains("Runtime Broker disabled");
                    if (List.of("local", "external", "fixture").contains(selected)) {
                        Object broker = settings.getClass().getMethod("getRuntimeBroker").invoke(settings);
                        String selectedKind = switch (selected) {
                            case "local" -> "local-process";
                            case "external" -> "external-scratch";
                            default -> "fixture-http";
                        };
                        set(broker, "Provisioner", selectedKind);
                        broker.getClass().getMethod("setProviderOptions", Map.class)
                                .invoke(broker, Map.of("endpoint", "http://127.0.0.1:9"));
                        set(broker, "TrustedLocalRebootRecovery", false);
                        set(broker, "DurableLocalProcess", false);
                        set(broker, "StateDirectory", directory.resolve("uncreated-state").toString());
                        set(broker, "NodeExecutable", "/unused-node");
                        set(broker, "WorkerEntry", "/unused-worker");
                        set(broker, "ExternalProviderUrl", "http://127.0.0.1:9");
                        set(broker, "ExternalProviderToken", "provider-token-for-fixture");
                        set(broker, "ExternalProviderId", "fixture");
                        set(broker, "WorkspaceId", "workspace");
                        set(broker, "WorkspaceCwd", "/worker/workspace");
                        Object factory = require.invoke(registry, selectedKind);
                        Object transport = loader.loadClass("com.alibaba.qwen.code.runtimebroker.adapter.HttpRuntimeTransport")
                                .getConstructor().newInstance();
                        Object provider = loader.loadClass(FACTORY).getMethod("create",
                                loader.loadClass("com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings"),
                                loader.loadClass("com.alibaba.qwen.code.runtimebroker.RuntimeTransport"),
                                loader.loadClass("com.alibaba.qwen.code.runtimebroker.spi.RuntimeProviderDependencies"))
                                .invoke(factory, settings, transport, loader.loadClass("com.alibaba.qwen.code.runtimebroker.spi.RuntimeProviderDependencies").getField("NONE").get(null));
                        ((AutoCloseable) provider).close();
                        assertThat(directory.resolve("uncreated-state")).doesNotExist();
                    }
                });
            }
        }
    }

    @Test
    void independentJarSuppliesOptionsPreflightAndBrokerLifecycle() throws Exception {
        try (var loader = new URLClassLoader(new URL[]{plugin.toUri().toURL()}, getClass().getClassLoader())) {
            withContextLoader(loader, () -> {
                var source = new MapConfigurationPropertySource(Map.of(
                        "qwen.managed-agent.runtime-broker.provider-options.endpoint", "http://127.0.0.1:9"));
                var settings = new Binder(source).bind("qwen.managed-agent", Bindable.of(ManagedAgentProperties.class)).get();
                var broker = settings.getRuntimeBroker();
                broker.setEnabled(true);
                broker.setProvisioner("fixture-http");
                broker.setTrustedLocalRebootRecovery(false);
                broker.setToken("fixture-broker-token");
                broker.setWorkspaceCwd("/remote/workspace");
                broker.setWorkspaceId("fixture-workspace");
                broker.setPort(0);
                settings.getHarness().setCapabilityDigest("sha256:" + "a".repeat(64));
                settings.validateRuntimeProvider();
                Class<?> preflight = Class.forName("com.alibaba.qwen.code.managedagent.preflight.ManagedAgentPreflight");
                var check = preflight.getDeclaredMethod("workspaceCheck", ManagedAgentProperties.class);
                check.setAccessible(true);
                assertThat(check.invoke(null, settings).toString()).contains("no local directory required");
                var providerChecks = preflight.getDeclaredMethod("brokerChecks", ManagedAgentProperties.class);
                providerChecks.setAccessible(true);
                assertThat(providerChecks.invoke(null, settings).toString())
                        .contains("fixture-diagnostic", "status=WARN", "fixture check was executed", "fixture remedy")
                        .doesNotContain("not installed", "unknown provisioner");
                Class<?> fixture = loader.loadClass("example.FixtureProvider");
                try (var runtime = broker(settings)) {
                    assertThat(runtime.getBaseUri()).isNotNull();
                    assertThat(fixture.getField("created").getInt(null)).isEqualTo(1);
                    assertThat(fixture.getField("closed").getInt(null)).isZero();
                    assertThat(fixture.getField("endpoint").get(null)).isEqualTo("http://127.0.0.1:9");
                }
                assertThat(fixture.getField("closed").getInt(null)).isEqualTo(1);
                broker.setPort(-1);
                assertThatThrownBy(() -> broker(settings)).hasMessageContaining("listener could not start");
                assertThat(fixture.getField("created").getInt(null)).isEqualTo(2);
                assertThat(fixture.getField("closed").getInt(null)).isEqualTo(2);
            });
        }
    }

    private static EmbeddedRuntimeBroker broker(ManagedAgentProperties settings) {
        return new EmbeddedRuntimeBroker(mock(AgentStateStore.class), settings,
                new InMemoryRuntimeBindingRepository(), new InMemoryRuntimeSessionRepository(),
                new InMemoryToolExecutionRepository());
    }

    private static URLClassLoader isolated(String selected) throws Exception {
        var urls = new ArrayList<URL>();
        for (String entry : System.getProperty("surefire.test.class.path", System.getProperty("java.class.path"))
                .split(java.util.regex.Pattern.quote(File.pathSeparator))) {
            Path path = Path.of(entry).toAbsolutePath().normalize();
            if (path.endsWith("test-classes") || Arrays.stream(new String[]{"local", "external", "kubernetes", "ssh", "static"})
                    .anyMatch(kind -> !selected.equals("full") && !Arrays.asList(selected.split(",")).contains(kind) && (path.endsWith("runtime-" + kind + "/target/classes")
                            || path.getFileName().toString().matches("qwen-managed-agent-runtime-" + kind + "-.+\\.jar")))) {
                continue;
            }
            urls.add(path.toUri().toURL());
        }
        if (selected.equals("fixture")) {
            urls.add(plugin.toUri().toURL());
        }
        return new URLClassLoader(urls.toArray(URL[]::new), ClassLoader.getPlatformClassLoader());
    }

    private static void set(Object target, String name, Object value) throws Exception {
        target.getClass().getMethod("set" + name, value instanceof Boolean ? boolean.class : String.class).invoke(target, value);
    }

    private static void withContextLoader(ClassLoader loader, CheckedAction action) throws Exception {
        Thread thread = Thread.currentThread();
        ClassLoader previous = thread.getContextClassLoader();
        thread.setContextClassLoader(loader);
        try {
            action.run();
        } finally {
            thread.setContextClassLoader(previous);
        }
    }

    private interface CheckedAction {
        void run() throws Exception;
    }
}
