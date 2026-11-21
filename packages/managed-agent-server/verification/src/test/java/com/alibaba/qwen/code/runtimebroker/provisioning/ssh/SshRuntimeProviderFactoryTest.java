package com.alibaba.qwen.code.runtimebroker.provisioning.ssh;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.config.SshRuntimeSettings;
import com.alibaba.qwen.code.runtimebroker.adapter.HttpRuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.spi.RuntimeProviderDependencies;
import com.alibaba.qwen.code.runtimebroker.spi.SshConnections;
import com.alibaba.qwen.code.runtimebroker.spi.SshRuntimeAccess;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.verifyNoMoreInteractions;
import static org.mockito.Mockito.when;

class SshRuntimeProviderFactoryTest {
    @TempDir
    Path temporary;

    @Test
    void validatesRemoteSettingsWithoutRequiringLocalFilesOrCreatingConnections() {
        var settings = settings();
        Path absent = temporary.resolve("not-created");
        settings.getRuntimeBroker().setStateDirectory(absent.toString());
        settings.getRuntimeBroker().setNodeExecutable(absent.resolve("node").toString());
        settings.getRuntimeBroker().setWorkerEntry(absent.resolve("cli.js").toString());
        var factory = new SshRuntimeProviderFactory();
        assertThat(factory.kinds()).containsExactly("ssh-process");
        assertThat(factory.usesLocalWorkspace()).isFalse();
        factory.validate(settings);
        assertThat(factory.preflight(settings)).allMatch(check -> check.status()
                == com.alibaba.qwen.code.runtimebroker.spi.RuntimeProviderFactory.Status.PASS);
        assertThat(absent).doesNotExist();
    }

    @Test
    void createsOnlySshAndBorrowsTheSharedConnectionsWhenRegistrationIsDisabled() {
        var settings = settings();
        settings.getRuntimeBroker().getSsh().setEnabled(false);
        var connections = mock(SshConnections.class);
        var access = mock(SshRuntimeAccess.class);
        when(access.connections()).thenReturn(connections);
        var dependencies = new RuntimeProviderDependencies() {
            @Override
            public SshRuntimeAccess ssh() {
                return access;
            }
        };
        try (var provider = new SshRuntimeProviderFactory().create(settings, new HttpRuntimeTransport(), dependencies)) {
            assertThat(provider.kind()).isEqualTo("ssh-process");
            assertThat(provider.supportsDrainedStop()).isTrue();
        }
        verify(access).connections();
        verifyNoMoreInteractions(access);
        verifyNoInteractions(connections);
    }

    @Test
    void rejectsMissingPortsAndDuplicateNodesBeforeCreatingAProvider() {
        var settings = settings();
        var factory = new SshRuntimeProviderFactory();
        assertThatThrownBy(() -> factory.create(settings, new HttpRuntimeTransport(), RuntimeProviderDependencies.NONE))
                .isInstanceOf(IllegalStateException.class).hasMessageContaining("SSH Workspace access");
        var node = settings.getRuntimeBroker().getSsh().getNodes().getFirst();
        settings.getRuntimeBroker().getSsh().setNodes(List.of(node, node));
        assertThatThrownBy(() -> factory.validate(settings))
                .isInstanceOf(IllegalStateException.class).hasMessageContaining("unique");
    }

    @Test
    void preservesLocalBoundSessionSettingsOnlyInTheAdmittedMixedMode() {
        var settings = settings();
        var broker = settings.getRuntimeBroker();
        var factory = new SshRuntimeProviderFactory();
        broker.setBoundSessionIsolationClass("workspace");
        assertThatThrownBy(() -> factory.validate(settings)).isInstanceOf(IllegalStateException.class);
        broker.setProvisioner("local-process");
        broker.setTrustedLocalRebootRecovery(true);
        factory.validate(settings);
        broker.setProvisioner("static");
        assertThatThrownBy(() -> factory.validate(settings))
                .isInstanceOf(IllegalStateException.class).hasMessageContaining("local-process or ssh-process");
    }

    @Test
    void rejectsSshOnlyLocalRecoveryAndSessionCreateWarm() {
        var settings = settings();
        var factory = new SshRuntimeProviderFactory();
        settings.getRuntimeBroker().setTrustedLocalRebootRecovery(true);
        assertThatThrownBy(() -> factory.validate(settings)).isInstanceOf(IllegalStateException.class);
        settings.getRuntimeBroker().setTrustedLocalRebootRecovery(false);
        settings.getRuntimeBroker().setSessionCreateWarm(true);
        assertThatThrownBy(() -> factory.validate(settings))
                .isInstanceOf(IllegalStateException.class).hasMessageContaining("Session-create warm");
    }

    private static ManagedAgentProperties settings() {
        var settings = new ManagedAgentProperties();
        settings.getHarness().setWorkspaceFilesEnabled(true);
        var broker = settings.getRuntimeBroker();
        broker.setEnabled(true);
        broker.setProvisioner("ssh-process");
        broker.setTrustedLocalRebootRecovery(false);
        broker.getSsh().setEnabled(true);
        broker.getSsh().setNodes(List.of(new SshRuntimeSettings.Node("worker", "Worker", "remote-host",
                "/remote/node", "/remote/cli.js", "/remote/state", List.of("/remote/workspace"),
                41270, "0.26.4", List.of(new SshRuntimeSettings.Access("tenant", "actor")))));
        return settings;
    }
}
