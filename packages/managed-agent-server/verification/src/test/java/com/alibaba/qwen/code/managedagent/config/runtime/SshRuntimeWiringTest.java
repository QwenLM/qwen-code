package com.alibaba.qwen.code.managedagent.config.runtime;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentConfiguration;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.config.SshRuntimeSettings;
import com.alibaba.qwen.code.managedagent.contracts.session.AgentStateStore;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionRecord;
import com.alibaba.qwen.code.managedagent.persistence.JdbcWorkspaceExecutionStore;
import com.alibaba.qwen.code.managedagent.repository.SshWorkspaceStore;
import com.alibaba.qwen.code.managedagent.workspace.SshWorkspaceService;
import com.alibaba.qwen.code.managedagent.workspace.runtime.WorkspaceRuntimeProvisioner;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisioner;
import com.alibaba.qwen.code.runtimebroker.adapter.security.AesGcmSecretProtector;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcRuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.provisioning.ssh.SshConnectionManager;
import com.alibaba.qwen.code.runtimebroker.provisioning.ssh.SshRuntimeProvisioner;
import com.alibaba.qwen.code.runtimebroker.spi.RuntimeProviderFactory;
import com.alibaba.qwen.code.runtimebroker.spi.SshConnections;
import com.alibaba.qwen.code.runtimebroker.spi.SshRuntimeStorage;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.DisabledOnOs;
import org.junit.jupiter.api.condition.OS;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.support.AbstractBeanDefinition;
import org.springframework.beans.factory.support.RootBeanDefinition;
import org.springframework.context.annotation.Bean;
import org.springframework.context.support.GenericApplicationContext;
import org.springframework.test.util.ReflectionTestUtils;

import java.io.IOException;
import java.net.URI;
import java.net.URL;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.util.Collections;
import java.util.Enumeration;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Consumer;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

class SshRuntimeWiringTest {
    @TempDir
    Path temporary;

    @Test
    void missingFactoriesAreRequiredOnlyWhenSshIsSelected() {
        var settings = settings();
        settings.getToolPublication().setServiceBaseUrl("not a URI");
        Thread thread = Thread.currentThread();
        ClassLoader previous = thread.getContextClassLoader();
        thread.setContextClassLoader(new ClassLoader(previous) {
            @Override
            public Enumeration<URL> getResources(String name) throws IOException {
                return name.equals("META-INF/services/" + RuntimeProviderFactory.class.getName())
                        ? Collections.emptyEnumeration() : super.getResources(name);
            }
        });
        try {
            settings.getRuntimeBroker().setEnabled(false);
            var configuration = new ManagedAgentConfiguration(settings);
            assertThat(configuration.managedSshConnections(settings)).isNull();
            settings.getRuntimeBroker().setEnabled(true);
            assertThatThrownBy(() -> new ManagedAgentConfiguration(settings))
                    .isInstanceOf(IllegalStateException.class).hasMessageContaining("not installed: ssh-process");
            assertThatThrownBy(() -> configuration.managedSshConnections(settings))
                    .isInstanceOf(IllegalStateException.class).hasMessageContaining("not installed: ssh-process");
            settings.getRuntimeBroker().setProvisioner("local-process");
            settings.getRuntimeBroker().getSsh().setNodes(List.of());
            assertThat(configuration.managedSshConnections(settings)).isNull();
        } finally {
            thread.setContextClassLoader(previous);
        }
    }

    @Test
    void mixedBrokerValidatesLocalSettingsBeforeCreatingSshConnections() {
        Map<String, Consumer<ManagedAgentProperties.RuntimeBroker>> invalid = Map.of(
                "Runtime Broker state directory is required", broker -> broker.setStateDirectory(""),
                "Node.js executable is required", broker -> broker.setNodeExecutable(""),
                "Runtime worker entry is required", broker -> broker.setWorkerEntry(""),
                "Merged local Runtime provisioner does not accept extra environment",
                broker -> broker.setEnvironment(Map.of("EXTRA", "value")));
        for (var entry : invalid.entrySet()) {
            var settings = settings();
            var broker = settings.getRuntimeBroker();
            broker.setEnabled(false);
            broker.setProvisioner("local-process");
            Path absent = temporary.resolve("unused-local");
            broker.setStateDirectory(absent.resolve("state").toString());
            broker.setNodeExecutable(absent.resolve("node").toString());
            broker.setWorkerEntry(absent.resolve("cli.js").toString());
            settings.getToolPublication().setServiceBaseUrl("not a URI");
            var configuration = new ManagedAgentConfiguration(settings);
            broker.setEnabled(true);
            entry.getValue().accept(broker);
            assertThatThrownBy(() -> new ManagedAgentConfiguration(settings))
                    .isInstanceOf(IllegalStateException.class).hasMessage(entry.getKey());
            assertThatThrownBy(() -> configuration.managedSshConnections(settings))
                    .isInstanceOf(IllegalStateException.class).hasMessage(entry.getKey());
            assertThat(absent).doesNotExist();
        }
    }

    @Test
    @DisabledOnOs(OS.WINDOWS)
    void failedSpringStartupReleasesTheActualConnectionsBeanControllerLock() throws Exception {
        var settings = settings();
        URI endpoint = URI.create("http://127.0.0.1:41270/" + UUID.randomUUID());
        settings.getToolPublication().setServiceBaseUrl(endpoint.toString());
        var created = new AtomicReference<SshConnections>();
        var directory = new AtomicReference<Path>();
        try (var context = connectionsContext(settings)) {
            context.registerBean("failingConsumer", Object.class, () -> {
                var connections = context.getBean("managedSshConnections", SshConnections.class);
                created.set(connections);
                assertThat(connections).isInstanceOf(SshConnectionManager.class);
                directory.set((Path) ReflectionTestUtils.getField(connections, "socketDirectory"));
                assertThatThrownBy(() -> new SshConnectionManager(endpoint))
                        .isInstanceOf(RuntimeBrokerException.class).hasMessageContaining("owned by another Broker");
                throw new IllegalStateException("downstream fixture failed");
            });
            assertThatThrownBy(context::refresh).rootCause().hasMessage("downstream fixture failed");
            assertThat(created.get()).isNotNull();
            try (var replacement = new SshConnectionManager(endpoint)) {
                assertThat(replacement).isNotSameAs(created.get());
            }
        } finally {
            if (created.get() != null) {
                created.get().close();
            }
            if (directory.get() != null) {
                Files.deleteIfExists(directory.get().resolve("controller.lock"));
                Files.deleteIfExists(directory.get());
            }
        }
    }

    @Test
    void sshOnlyBrokerUsesNoLocalProviderOrFilesAndRejectsUnboundAndLocalScopes() {
        var settings = settings();
        Path unusedLocal = temporary.resolve("unused-local");
        var options = settings.getRuntimeBroker();
        options.setStateDirectory(unusedLocal.resolve("state").toString());
        options.setNodeExecutable(unusedLocal.resolve("node").toString());
        options.setWorkerEntry(unusedLocal.resolve("cli.js").toString());
        var connections = mock(SshConnections.class);
        var storage = mock(SshWorkspaceStore.class);
        var sessions = mock(AgentStateStore.class);
        var unbound = mock(SessionRecord.class);
        when(unbound.tenantId()).thenReturn("tenant");
        when(sessions.findSessionById("unbound")).thenReturn(Optional.of(unbound));
        var local = new ContextBinding("tenant", "local-workspace", 1, "local-storage", ".", "context", 1);
        var remote = new ContextBinding("tenant", "remote-workspace", 1, "ssh-storage", ".", "context", 1);
        var localSession = mock(SessionRecord.class);
        when(localSession.tenantId()).thenReturn("tenant");
        when(localSession.workspace()).thenReturn(local);
        when(sessions.findSessionById("old-local")).thenReturn(Optional.of(localSession));
        var remoteSession = mock(SessionRecord.class);
        when(remoteSession.tenantId()).thenReturn("tenant");
        when(remoteSession.workspace()).thenReturn(remote);
        when(sessions.findSessionById("ssh-session")).thenReturn(Optional.of(remoteSession));
        var authority = mock(JdbcWorkspaceExecutionStore.class);
        when(authority.createdStorageRoot("tenant", "local-storage")).thenReturn(temporary);
        when(storage.verify(remote)).thenReturn(true);
        when(storage.runtimeStorage("tenant", "ssh-storage")).thenReturn(new SshRuntimeStorage("worker", "ssh-storage",
                "/remote/workspace", Map.of("identity", Map.of("root", "/remote/workspace"),
                        "marker", Map.of("root", "/remote/workspace", "storageId", "ssh-storage"), "qwenVersion", "0.26.4")));
        var source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:ssh-wiring-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");
        com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema.initialize(source);
        try (var ssh = new SshWorkspaceService(settings, storage, connections, Clock.systemUTC());
                var broker = new EmbeddedRuntimeBroker(sessions, settings,
                        new JdbcRuntimeBindingRepository(source, new AesGcmSecretProtector("test", new byte[32])),
                        new JdbcRuntimeSessionRepository(source), new JdbcToolExecutionRepository(source),
                        authority, null, null, ssh)) {
            var primary = (RuntimeProvisioner) ReflectionTestUtils.getField(broker, "primaryProvisioner");
            assertThat(primary).isInstanceOf(SshRuntimeProvisioner.class);
            var assembled = (RuntimeProvisioner) ReflectionTestUtils.getField(broker.service(), "provisioner");
            assertThat(assembled).isInstanceOf(WorkspaceRuntimeProvisioner.class);
            assertThat(ReflectionTestUtils.getField(assembled, "delegate")).isSameAs(primary);
            assertThat(assembled.supportsKind("ssh-process")).isTrue();
            assertThat(assembled.supportsKind("local-process")).isFalse();
            assertThat(broker.supportsWorkspaceClose((ContextBinding) null)).isFalse();
            assertThat(broker.supportsWorkspaceClose(local)).isFalse();
            assertThat(broker.supportsWorkspaceClose(remote)).isTrue();
            assertThat(broker.supportsWorkspaceContextChange(local)).isFalse();
            assertThat(broker.supportsWorkspaceContextChange(remote)).isTrue();
            var scope = broker.service().capabilities("ssh-session", null).toCompletableFuture().join();
            assertThat(scope.getCanonicalCwd()).isEqualTo("/remote/workspace");
            assertThat(scope.getWorkspaceId()).isEqualTo("remote-workspace");
            assertThat(scope.getIsolationClass()).isEqualTo("session");
            assertThatThrownBy(() -> broker.warm("unbound").toCompletableFuture().join())
                    .hasRootCauseInstanceOf(RuntimeBrokerException.class).hasMessageContaining("Workspace execution authority");
            assertThatThrownBy(() -> broker.service().capabilities("old-local", null).toCompletableFuture().join())
                    .hasRootCauseInstanceOf(RuntimeBrokerException.class).hasMessageContaining("Workspace execution authority");
            assertThatThrownBy(() -> broker.verifyWorkspaceCwdTarget(local, "."))
                    .isInstanceOf(RuntimeBrokerException.class).hasMessageContaining("Workspace execution authority");
            verify(authority, never()).createdStorageRoot("tenant", "local-storage");
            broker.recoverSavedRuntimes();
            assertThat(unusedLocal).doesNotExist();
        }
        assertThat(unusedLocal).doesNotExist();
        verifyNoInteractions(connections);
    }

    private static GenericApplicationContext connectionsContext(ManagedAgentProperties settings) throws Exception {
        var context = new GenericApplicationContext();
        context.registerBean("settings", ManagedAgentProperties.class, () -> settings);
        context.registerBean("configuration", ManagedAgentConfiguration.class, () -> new ManagedAgentConfiguration(settings));
        var method = ManagedAgentConfiguration.class.getMethod("managedSshConnections", ManagedAgentProperties.class);
        var bean = method.getAnnotation(Bean.class);
        assertThat(bean).isNotNull();
        assertThat(bean.destroyMethod()).isEqualTo("close");
        var definition = new RootBeanDefinition();
        definition.setFactoryBeanName("configuration");
        definition.setFactoryMethodName(method.getName());
        definition.setAutowireMode(AbstractBeanDefinition.AUTOWIRE_CONSTRUCTOR);
        definition.setDestroyMethodName(bean.destroyMethod());
        context.registerBeanDefinition("managedSshConnections", definition);
        return context;
    }

    private static ManagedAgentProperties settings() {
        var settings = new ManagedAgentProperties();
        settings.getHarness().setWorkspaceFilesEnabled(true);
        settings.getHarness().setCapabilityDigest("sha256:" + "a".repeat(64));
        var broker = settings.getRuntimeBroker();
        broker.setEnabled(true);
        broker.setProvisioner("ssh-process");
        broker.setTrustedLocalRebootRecovery(false);
        broker.setPort(0);
        broker.setToken("fixture-broker-token");
        broker.setWorkspaceId("fixture-workspace");
        broker.setWorkspaceCwd("/remote/workspace");
        broker.getSsh().setEnabled(true);
        broker.getSsh().setNodes(List.of(new SshRuntimeSettings.Node("worker", "Worker", "remote-host",
                "/remote/node", "/remote/cli.js", "/remote/state", List.of("/remote/workspace"),
                41270, "0.26.4", List.of(new SshRuntimeSettings.Access("tenant", "actor")))));
        return settings;
    }
}
