package com.alibaba.qwen.code.managedagent.config;

import com.alibaba.qwen.code.managedagent.workspace.runtime.EmbeddedRuntimeBroker;
import org.apache.commons.codec.digest.DigestUtils;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.boot.env.YamlPropertySourceLoader;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.io.ClassPathResource;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class SessionStoreDefaultsTest {
    private static final String STORE_ENABLED =
            "qwen.managed-agent.session-store.enabled";

    private final ApplicationContextRunner context = new ApplicationContextRunner()
            .withUserConfiguration(StoreConfiguration.class);

    @Test
    void theShippedStoreSwitchFollowsTheHarnessUnlessSetExplicitly() throws IOException {
        Object shipped = new YamlPropertySourceLoader()
                .load("application.yml", new ClassPathResource("application.yml"))
                .get(0).getProperty(STORE_ENABLED);
        assertThat(shipped).isEqualTo(
                "${QWEN_MANAGED_AGENT_SESSION_STORE_ENABLED:${qwen.managed-agent.harness.enabled:false}}");
        ApplicationContextRunner shippedDefault = context
                .withPropertyValues(STORE_ENABLED + "=" + shipped);
        shippedDefault.run(started -> {
            assertThat(started).hasNotFailed().doesNotHaveBean("storeRoutes");
            assertThat(store(started).isEnabled()).isFalse();
        });
        // The conditional beans read the Environment, not the bound value.
        shippedDefault.withPropertyValues("qwen.managed-agent.harness.enabled=true")
                .run(started -> {
                    assertThat(started).hasNotFailed().hasBean("storeRoutes");
                    assertThat(store(started).isEnabled()).isTrue();
                });
        shippedDefault.withPropertyValues("qwen.managed-agent.harness.enabled=true",
                        "QWEN_MANAGED_AGENT_SESSION_STORE_ENABLED=false")
                .run(started -> assertThat(started).hasFailed().getFailure()
                        .hasRootCauseMessage("Hosted Harness requires the Managed Session Store"));
    }

    @Test
    void derivesTheBaseUrlFromALoopbackOrWildcardListener() {
        assertBaseUrl("http://127.0.0.1:8080");
        assertBaseUrl("http://127.0.0.1:9090", "server.port=9090");
        assertBaseUrl("http://127.0.0.1:8080", "server.address=127.0.0.1");
        assertBaseUrl("http://127.0.0.1:8080", "server.address=0.0.0.0");
        assertBaseUrl("http://127.0.0.1:8080", "server.address=::");
        assertBaseUrl("http://[::1]:8080", "server.address=::1");
        // The store routes move to the dedicated listener when it exists.
        assertBaseUrl("http://127.0.0.1:4190", "server.port=9090",
                "qwen.managed-agent.internal-server.port=4190");
        assertBaseUrl("http://[::1]:4190", "qwen.managed-agent.internal-server.port=4190",
                "qwen.managed-agent.internal-server.address=::1");
        // The internal listener stays plaintext behind a TLS public one.
        assertBaseUrl("http://127.0.0.1:4190", "server.ssl.bundle=web",
                "qwen.managed-agent.internal-server.port=4190");
        assertBaseUrl("http://127.0.0.1:8080", "server.ssl.key-store=classpath:server.p12",
                "server.ssl.enabled=false");
    }

    @Test
    void leavesTheBaseUrlBlankWhenNoLoopbackUrlReachesTheListener() {
        assertBaseUrl("", "server.address=10.0.0.5");
        assertBaseUrl("", "server.port=0");
        // A TLS public listener refuses plaintext; its URL must name a host
        // the certificate covers.
        assertBaseUrl("", "server.ssl.key-store=classpath:server.p12");
        assertBaseUrl("", "server.ssl.bundle=web");
        assertBaseUrl("", "qwen.managed-agent.internal-server.port=4190",
                "qwen.managed-agent.internal-server.address=10.0.0.5");
        ManagedAgentProperties plain = enabledStore();
        plain.validateWorkspaceFiles();
        assertThat(plain.getSessionStore().getBaseUrl()).isEmpty();
    }

    @Test
    void neverReplacesConfiguredValues(@TempDir Path workspace) {
        assertBaseUrl("https://store.example", "server.port=9090",
                "qwen.managed-agent.session-store.base-url=https://store.example");
        ManagedAgentProperties properties = enabledStore();
        properties.getSessionStore().setWorkspaceId("configured");
        properties.getRuntimeBroker().setWorkspaceId("broker");
        properties.getRuntimeBroker().setWorkspaceCwd(workspace.toString());
        properties.validateWorkspaceFiles();
        assertThat(properties.getSessionStore().getWorkspaceId()).isEqualTo("configured");
    }

    @Test
    void sharesTheBrokerWorkspaceIdentity(@TempDir Path workspace) throws IOException {
        ManagedAgentProperties explicit = enabledStore();
        explicit.getRuntimeBroker().setWorkspaceId("broker");
        explicit.getRuntimeBroker().setWorkspaceCwd(workspace.toString());
        explicit.validateWorkspaceFiles();
        assertThat(explicit.getSessionStore().getWorkspaceId()).isEqualTo("broker");

        Path link = Files.createSymbolicLink(workspace.resolve("link"), Files.createDirectory(workspace.resolve("real")));
        String expected = DigestUtils.sha256Hex(link.toRealPath().toString().getBytes(StandardCharsets.UTF_8))
                .substring(0, 16);
        for (String provisioner : new String[] {"local-process", "kubernetes"}) {
            ManagedAgentProperties derived = enabledStore();
            derived.getRuntimeBroker().setProvisioner(provisioner);
            derived.getRuntimeBroker().setWorkspaceCwd(
                    "kubernetes".equals(provisioner) ? "/workspace" : link.toString());
            derived.validateWorkspaceFiles();
            assertThat(derived.getSessionStore().getWorkspaceId()).as(provisioner)
                    .isEqualTo(EmbeddedRuntimeBroker.workspaceId(derived.getRuntimeBroker()));
            if ("local-process".equals(provisioner)) {
                assertThat(derived.getSessionStore().getWorkspaceId()).isEqualTo(expected);
            }
        }
    }

    @Test
    void leavesTheWorkspaceIdBlankWithoutABrokerIdentity(@TempDir Path workspace) {
        ManagedAgentProperties none = enabledStore();
        none.validateWorkspaceFiles();
        assertThat(none.getSessionStore().getWorkspaceId()).isEmpty();

        ManagedAgentProperties staticRuntime = enabledStore();
        staticRuntime.getRuntimeBroker().setProvisioner("static");
        staticRuntime.getRuntimeBroker().setWorkspaceCwd(workspace.toString());
        staticRuntime.validateWorkspaceFiles();
        assertThat(staticRuntime.getSessionStore().getWorkspaceId()).isEmpty();

        ManagedAgentProperties disabled = new ManagedAgentProperties();
        disabled.getRuntimeBroker().setWorkspaceCwd(workspace.toString());
        disabled.validateWorkspaceFiles();
        assertThat(disabled.getSessionStore().getWorkspaceId()).isEmpty();
    }

    @Test
    void refusesAWorkspaceDirectoryThatCannotBeResolved(@TempDir Path workspace) {
        ManagedAgentProperties properties = enabledStore();
        properties.getRuntimeBroker().setWorkspaceCwd(workspace.resolve("missing").toString());
        assertThatThrownBy(properties::validateWorkspaceFiles)
                .isInstanceOf(IllegalStateException.class)
                .hasMessage("Runtime Broker workspace cwd could not be resolved");
    }

    private void assertBaseUrl(String expected, String... values) {
        context.withPropertyValues(STORE_ENABLED + "=true").withPropertyValues(values)
                .run(started -> {
                    assertThat(started).hasNotFailed();
                    assertThat(store(started).getBaseUrl()).as(String.join(", ", values))
                            .isEqualTo(expected);
                });
    }

    private static ManagedAgentProperties.SessionStore store(
            org.springframework.context.ApplicationContext started) {
        return started.getBean(ManagedAgentProperties.class).getSessionStore();
    }

    private static ManagedAgentProperties enabledStore() {
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getSessionStore().setEnabled(true);
        return properties;
    }

    @Configuration(proxyBeanMethods = false)
    @EnableConfigurationProperties(ManagedAgentProperties.class)
    static class StoreConfiguration {
        @Bean
        @ConditionalOnProperty(prefix = "qwen.managed-agent.session-store", name = "enabled", havingValue = "true")
        Object storeRoutes() {
            return new Object();
        }
    }
}
