package com.alibaba.qwen.code.managedagent.config.runtime;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.config.SshRuntimeSettings;
import com.alibaba.qwen.code.runtimebroker.spi.RuntimeBackendSelection;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class RuntimeBackendSelectionTest {
    @Test
    void selectsEachPrimaryWithoutAddingOtherBackends() {
        var settings = new ManagedAgentProperties();
        settings.getRuntimeBroker().setEnabled(true);
        for (String primary : List.of("local-process", "static", "kubernetes-workspace", "external-scratch", "external-workspace")) {
            settings.getRuntimeBroker().setProvisioner(primary);
            assertThat(RuntimeBackendSelection.from(settings).kinds()).containsExactly(primary);
        }
    }

    @Test
    void selectsSshOnlyOrTheAdmittedLocalAndSshCombinationIndependentlyOfRegistration() {
        var settings = settingsWithNodes();
        for (boolean registration : List.of(true, false)) {
            settings.getRuntimeBroker().getSsh().setEnabled(registration);
            settings.getRuntimeBroker().setProvisioner("ssh-process");
            var ssh = RuntimeBackendSelection.from(settings);
            assertThat(ssh.kinds()).containsExactly("ssh-process");
            assertThat(ssh.includes("local-process")).isFalse();
            settings.getRuntimeBroker().setProvisioner("local-process");
            assertThat(RuntimeBackendSelection.from(settings).kinds()).containsExactlyInAnyOrder("local-process", "ssh-process");
        }
    }

    @Test
    void rejectsSshWithoutNodesAndCombinationsWithOtherPrimaryBackends() {
        var settings = settingsWithNodes();
        for (String primary : List.of("static", "kubernetes-workspace", "external-scratch", "external-workspace")) {
            settings.getRuntimeBroker().setProvisioner(primary);
            assertThatThrownBy(() -> RuntimeBackendSelection.from(settings))
                    .isInstanceOf(IllegalStateException.class).hasMessageContaining("local-process or ssh-process");
        }
        settings.getRuntimeBroker().setProvisioner("ssh-process");
        settings.getRuntimeBroker().getSsh().setNodes(List.of());
        assertThatThrownBy(() -> RuntimeBackendSelection.from(settings))
                .isInstanceOf(IllegalStateException.class).hasMessageContaining("configured nodes");
    }

    @Test
    void disablingTheBrokerSelectsNothingBeforeInterpretingInactiveBackendConfiguration() {
        var settings = settingsWithNodes();
        settings.getRuntimeBroker().setEnabled(false);
        settings.getRuntimeBroker().setProvisioner("external-workspace");
        assertThat(RuntimeBackendSelection.from(settings).kinds()).isEmpty();
        settings.getRuntimeBroker().setProvisioner("ssh-process");
        settings.getRuntimeBroker().getSsh().setNodes(List.of());
        assertThat(RuntimeBackendSelection.from(settings).kinds()).isEmpty();
    }

    private static ManagedAgentProperties settingsWithNodes() {
        var settings = new ManagedAgentProperties();
        settings.getRuntimeBroker().setEnabled(true);
        settings.getRuntimeBroker().getSsh().setNodes(List.of(new SshRuntimeSettings.Node("worker", "Worker", "remote-host",
                "/remote/node", "/remote/cli.js", "/remote/state", List.of("/remote/workspace"),
                41270, "0.26.4", List.of(new SshRuntimeSettings.Access("tenant", "actor")))));
        return settings;
    }
}
